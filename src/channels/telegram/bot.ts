import { randomUUID } from 'node:crypto'
import type { TextStreamPart, ToolSet } from 'ai'
import { Bot, type Context } from 'grammy'
import type { AgentRuntime } from '@/runtime/types'
import { child } from '@/shared/logger'
import type { TelegramChannelConfig } from './config'

const log = child({ module: 'telegram-bot' })

const EDIT_THROTTLE_MS = 1_100
const THINKING_TEXT = '↻ thinking…'

export type TelegramBotOpts = {
  token: string
  config: TelegramChannelConfig
  runtime: AgentRuntime
}

export type TelegramBotHandle = {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createTelegramBot(opts: TelegramBotOpts): TelegramBotHandle {
  const bot = new Bot(opts.token)
  const allowedUsers = new Set(opts.config.allowed_users.map((u) => u.toLowerCase()))
  // Per-chat reset counter. Appended to threadId so /reset creates a fresh thread.
  const chatResetSuffix = new Map<number, string>()
  // In-flight run per chat — abort on new message or /reset.
  const inflightAbort = new Map<number, AbortController>()
  let running = false

  function threadIdFor(chatId: number): string {
    const suffix = chatResetSuffix.get(chatId)
    return suffix ? `tg:${chatId}:${suffix}` : `tg:${chatId}`
  }

  function isAllowed(username: string | undefined, numericId: string | undefined): boolean {
    // Empty whitelist = deny all (fail-closed for single-user model).
    if (allowedUsers.size === 0) return false
    // Match either @username or numeric userId.
    if (username && allowedUsers.has(username.toLowerCase())) return true
    if (numericId && allowedUsers.has(numericId)) return true
    return false
  }

  function resolveUser(ctx: Context): { username?: string; numericId?: string } {
    return {
      username: ctx.from?.username ? `@${ctx.from.username}` : undefined,
      numericId: ctx.from?.id ? String(ctx.from.id) : undefined,
    }
  }

  // --- slash commands ---

  bot.command('start', (ctx) =>
    ctx.reply('Welcome to Talos. Send a message to chat with your ETH agent.'),
  )

  bot.command('help', (ctx) =>
    ctx.reply(
      'Commands:\n' +
        '/start — welcome message\n' +
        '/reset — start a fresh thread\n' +
        '/help — this help\n\n' +
        'Send any text to chat with the Talos agent.',
    ),
  )

  bot.command('reset', async (ctx) => {
    const { username, numericId } = resolveUser(ctx)
    if (!isAllowed(username, numericId)) return
    // Abort any in-flight run for this chat.
    const ac = inflightAbort.get(ctx.chat.id)
    if (ac) {
      ac.abort()
      inflightAbort.delete(ctx.chat.id)
    }
    // Rotate thread suffix so next message starts a fresh thread.
    chatResetSuffix.set(ctx.chat.id, randomUUID())
    await ctx.reply('Thread reset. Next message starts a new conversation.')
  })

  // --- message handler ---

  bot.on('message:text', async (ctx) => {
    const { username, numericId } = resolveUser(ctx)
    if (!isAllowed(username, numericId)) return

    const chatId = ctx.chat.id
    const threadId = threadIdFor(chatId)
    const prompt = ctx.message.text

    // Abort any previous run for this chat before starting a new one.
    const prevAc = inflightAbort.get(chatId)
    if (prevAc) prevAc.abort()

    const ac = new AbortController()
    inflightAbort.set(chatId, ac)

    const thinkingMsg = await ctx.reply(THINKING_TEXT)

    let assembled = ''
    const trace: string[] = [THINKING_TEXT]
    let lastEditAt = Date.now()
    let finalReached = false

    try {
      const handle = await opts.runtime.run({
        threadId,
        channel: 'telegram',
        intent: prompt,
        abortSignal: ac.signal,
      })

      // Capture done-promise errors like CLI/MCP pattern.
      const settledDone: Promise<unknown> = handle.done.catch((err: unknown) => err)

      for await (const event of handle.fullStream) {
        const ev = event as TextStreamPart<ToolSet> & { type: string }

        if (ev.type === 'text-delta') {
          assembled += ev.text ?? ''
        } else if (ev.type === 'tool-call') {
          const name = ev.toolName ?? '<tool>'
          trace.push(`↻ ${name}`)
        } else if (ev.type === 'tool-result') {
          if (trace.length > 0 && trace[trace.length - 1]?.startsWith('↻ ')) {
            trace[trace.length - 1] += '  ✓'
          }
        } else if (ev.type === 'tool-error') {
          if (trace.length > 0 && trace[trace.length - 1]?.startsWith('↻ ')) {
            trace[trace.length - 1] += '  ✗'
          }
        } else if (ev.type === 'finish') {
          finalReached = true
        }

        // Build display text: during streaming show trace, on finish show answer.
        const displayText = finalReached
          ? assembled.trim() || '(no response)'
          : buildStreamingDisplay(trace, assembled)

        const now = Date.now()
        // Throttle measured from edit start (not completion) — keeps cadence
        // steady even when Telegram API latency varies.
        if (now - lastEditAt >= EDIT_THROTTLE_MS) {
          lastEditAt = now
          await safeEdit(bot, chatId, thinkingMsg.message_id, displayText)
        }
      }

      // Final edit — always write the completed answer.
      const finalText = assembled.trim() || '(no response)'
      await safeEdit(bot, chatId, thinkingMsg.message_id, finalText)

      // Surface done-promise errors (matches CLI/MCP settledDone pattern).
      const doneResult = await settledDone
      if (doneResult instanceof Error) throw doneResult
    } catch (err) {
      log.warn({ err, chatId }, 'run failed')
      const errMsg = `error: ${err instanceof Error ? err.message : String(err)}`
      await safeEdit(bot, chatId, thinkingMsg.message_id, errMsg)
    } finally {
      inflightAbort.delete(chatId)
    }
  })

  return {
    async start(): Promise<void> {
      if (running) return
      running = true
      log.info('telegram bot starting (long-poll)')
      // grammY's bot.start() returns a long-running promise that only resolves
      // when polling stops (via bot.stop()). Resolving our start() on that
      // would mean "start completes when the bot ends" — wrong shape. Instead
      // we resolve once polling is actually up (via the onStart callback) and
      // let the long-running promise continue in the background, surfacing
      // mid-flight failures via logs. Pre-onStart errors (bad token, network
      // unreachable) propagate to the caller normally.
      await new Promise<void>((resolve, reject) => {
        let started = false
        bot
          .start({
            onStart: () => {
              started = true
              log.info('telegram bot connected')
              resolve()
            },
          })
          .catch((err) => {
            if (started) {
              log.warn({ err }, 'telegram bot polling errored after start')
            } else {
              reject(err)
            }
          })
      })
    },
    async stop(): Promise<void> {
      if (!running) return
      running = false
      // Abort all in-flight runs on shutdown.
      for (const ac of inflightAbort.values()) ac.abort()
      inflightAbort.clear()
      bot.stop()
      log.info('telegram bot stopped')
    },
  }
}

function buildStreamingDisplay(trace: string[], assembled: string): string {
  const lines = [...trace]
  if (assembled.length > 0) {
    lines.push('', assembled.trim())
  }
  return lines.join('\n')
}

async function safeEdit(bot: Bot, chatId: number, messageId: number, text: string): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text)
  } catch (err) {
    // Telegram throws "message is not modified" if text is identical.
    // Silently ignore that specific error.
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('message is not modified')) {
      log.warn({ err, chatId }, 'editMessageText failed')
    }
  }
}
