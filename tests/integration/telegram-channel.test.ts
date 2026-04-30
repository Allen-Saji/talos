import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime, RunHandle, RunOptions } from '@/runtime/types'

vi.mock('@/config/env', () => ({
  loadEnv: () => ({
    OPENAI_API_KEY: 'test-key',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TALOS_DAEMON_PORT: 0,
    TALOS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
  resetEnvCache: () => {},
}))

// biome-ignore lint/suspicious/noExplicitAny: mock handler map
const handlers = new Map<string, (...args: any[]) => any>()
const editMessageTextMock = vi.fn().mockResolvedValue(true)
const replyMock = vi.fn().mockResolvedValue({ message_id: 42 })

vi.mock('grammy', () => {
  return {
    Bot: class MockBot {
      // biome-ignore lint/suspicious/noExplicitAny: mock signature
      command(cmd: string, handler: (...args: any[]) => any) {
        handlers.set(`command:${cmd}`, handler)
      }
      // biome-ignore lint/suspicious/noExplicitAny: mock signature
      on(event: string, handler: (...args: any[]) => any) {
        handlers.set(`on:${event}`, handler)
      }
      start = vi.fn().mockResolvedValue(undefined)
      stop = vi.fn()
      api = { editMessageText: editMessageTextMock }
    },
  }
})

type FakeRunSpec = {
  runId?: string
  events?: Array<Record<string, unknown>>
  eventDelayMs?: number
  throwOnRun?: Error
}

function createFakeRuntime(opts: { spec?: FakeRunSpec } = {}) {
  const calls: Array<{ opts: RunOptions; aborted: () => boolean }> = []
  let runCounter = 0

  const runtime: AgentRuntime = {
    async run(runOpts: RunOptions): Promise<RunHandle> {
      const spec = opts.spec ?? {}
      if (spec.throwOnRun) throw spec.throwOnRun
      const runId = spec.runId ?? `run-${++runCounter}`
      const aborted = () => runOpts.abortSignal?.aborted ?? false
      calls.push({ opts: runOpts, aborted })

      const events = spec.events ?? [
        { type: 'text-delta', id: 'm1', text: 'hello from agent' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]
      const delayMs = spec.eventDelayMs

      const fullStream = (async function* () {
        for (const ev of events) {
          if (delayMs !== undefined) {
            await new Promise((r) => setTimeout(r, delayMs))
          } else {
            await new Promise((r) => setImmediate(r))
          }
          if (aborted()) {
            yield { type: 'abort', reason: 'aborted' } as never
            return
          }
          yield ev as never
        }
      })()

      return { runId, fullStream, done: Promise.resolve() }
    },
  }

  return { runtime, calls }
}

function makeTgCtx(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 12345 },
    from: { username: 'allensaji', id: 99999 },
    message: { text: 'hello', message_id: 1 },
    reply: replyMock,
    ...overrides,
  }
}

function getHandler(key: string) {
  const h = handlers.get(key)
  expect(h).toBeDefined()
  // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
  return h!
}

function lastEditArgs() {
  const calls = editMessageTextMock.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
  return calls[calls.length - 1]!
}

import { createTelegramBot } from '@/channels/telegram/bot'

describe('telegram channel', () => {
  afterEach(() => {
    handlers.clear()
    editMessageTextMock.mockClear()
    replyMock.mockClear()
    vi.restoreAllMocks()
  })

  function createBot(runtime: AgentRuntime, allowedUsers: string[] = ['@allensaji']) {
    return createTelegramBot({
      token: 'test-token',
      config: {
        enabled: true,
        allowed_users: allowedUsers,
      },
      runtime,
    })
  }

  it('registers message:text handler', () => {
    const { runtime } = createFakeRuntime()
    createBot(runtime)
    expect(handlers.has('on:message:text')).toBe(true)
  })

  it('registers /start, /help, /reset commands', () => {
    const { runtime } = createFakeRuntime()
    createBot(runtime)
    expect(handlers.has('command:start')).toBe(true)
    expect(handlers.has('command:help')).toBe(true)
    expect(handlers.has('command:reset')).toBe(true)
  })

  it('processes message from allowed user', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts.threadId).toBe('tg:12345')
    expect(calls[0]?.opts.channel).toBe('telegram')
    expect(calls[0]?.opts.intent).toBe('hello')
  })

  it('ignores message from non-allowed user', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx({ from: { username: 'stranger', id: 111 } }))

    expect(calls).toHaveLength(0)
    expect(replyMock).not.toHaveBeenCalled()
  })

  it('denies all users when whitelist is empty', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime, [])

    await getHandler('on:message:text')(makeTgCtx({ from: { username: 'anyone', id: 222 } }))

    expect(calls).toHaveLength(0)
  })

  it('supports numeric userId when username is absent', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime, ['99999'])

    await getHandler('on:message:text')(makeTgCtx({ from: { id: 99999 } }))

    expect(calls).toHaveLength(1)
  })

  it('matches numeric userId even when username is present', async () => {
    const { runtime, calls } = createFakeRuntime()
    // Whitelist has numeric ID, not @username.
    createBot(runtime, ['99999'])

    await getHandler('on:message:text')(makeTgCtx({ from: { username: 'allensaji', id: 99999 } }))

    expect(calls).toHaveLength(1)
  })

  it('sends thinking message then edits with final answer', async () => {
    const { runtime } = createFakeRuntime()
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx())

    expect(replyMock).toHaveBeenCalledWith('↻ thinking…')
    const lastCall = lastEditArgs()
    expect(lastCall[0]).toBe(12345) // chatId
    expect(lastCall[1]).toBe(42) // messageId
    expect(lastCall[2]).toBe('hello from agent')
  })

  it('shows tool-call trace during streaming', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: [
          { type: 'tool-call', toolName: 'aave_supply' },
          { type: 'tool-result', result: 'ok' },
          { type: 'text-delta', id: 'm1', text: 'supplied' },
          { type: 'finish', finishReason: 'stop' },
        ],
      },
    })
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx())

    const lastCall = lastEditArgs()
    expect(lastCall[2]).toBe('supplied')
  })

  it('handles runtime errors gracefully', async () => {
    const { runtime } = createFakeRuntime({ spec: { throwOnRun: new Error('boom') } })
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx())

    const lastCall = lastEditArgs()
    expect(lastCall[2]).toContain('error: boom')
  })

  it('uses thread id tg:{chatId}', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx({ chat: { id: 99999 } }))

    expect(calls[0]?.opts.threadId).toBe('tg:99999')
  })

  it('/start replies with welcome', async () => {
    const { runtime } = createFakeRuntime()
    createBot(runtime)

    const replyFn = vi.fn().mockResolvedValue(undefined)
    await getHandler('command:start')({
      reply: replyFn,
      from: { username: 'allensaji', id: 99999 },
    })

    expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('Welcome'))
  })

  it('/help replies with commands', async () => {
    const { runtime } = createFakeRuntime()
    createBot(runtime)

    const replyFn = vi.fn().mockResolvedValue(undefined)
    await getHandler('command:help')({ reply: replyFn, from: { username: 'allensaji', id: 99999 } })

    expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('/reset'))
  })

  it('/reset rotates thread id', async () => {
    const { runtime, calls } = createFakeRuntime()
    createBot(runtime)

    // First message uses default thread id.
    await getHandler('on:message:text')(makeTgCtx())
    expect(calls[0]?.opts.threadId).toBe('tg:12345')

    // Reset rotates the thread.
    const replyFn = vi.fn().mockResolvedValue(undefined)
    await getHandler('command:reset')({
      chat: { id: 12345 },
      reply: replyFn,
      from: { username: 'allensaji', id: 99999 },
    })
    expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('Thread reset'))

    // Next message uses a new thread id (has UUID suffix).
    await getHandler('on:message:text')(makeTgCtx())
    expect(calls[1]?.opts.threadId).toMatch(/^tg:12345:/)
    expect(calls[1]?.opts.threadId).not.toBe(calls[0]?.opts.threadId)
  })

  it('aborts previous run when new message arrives', async () => {
    let resolveFirst!: () => void
    const firstRunBlocked = new Promise<void>((r) => {
      resolveFirst = r
    })

    const calls: Array<{ opts: RunOptions; aborted: () => boolean }> = []
    let runCounter = 0

    const runtime: AgentRuntime = {
      async run(runOpts: RunOptions): Promise<RunHandle> {
        const runId = `run-${++runCounter}`
        const aborted = () => runOpts.abortSignal?.aborted ?? false
        calls.push({ opts: runOpts, aborted })

        const isFirst = runCounter === 1
        const fullStream = (async function* () {
          if (isFirst) {
            // First run blocks until we resolve it.
            await firstRunBlocked
            yield { type: 'text-delta', id: 'm1', text: 'first' } as never
          } else {
            yield { type: 'text-delta', id: 'm2', text: 'second' } as never
          }
          yield { type: 'finish', finishReason: 'stop' } as never
        })()

        return { runId, fullStream, done: Promise.resolve() }
      },
    }

    createBot(runtime)

    // Start first message (will block).
    const handler = getHandler('on:message:text')
    const p1 = handler(makeTgCtx())

    // Give first run time to start.
    await new Promise((r) => setImmediate(r))
    expect(calls).toHaveLength(1)

    // Send second message — should abort first run.
    const p2 = handler(makeTgCtx())

    // First run should be aborted.
    expect(calls[0]?.aborted()).toBe(true)

    // Unblock first run.
    resolveFirst()

    await Promise.all([p1, p2])
    expect(calls).toHaveLength(2)
  })

  it('throttles edits — fast events produce fewer edits than events', async () => {
    // Generate many events quickly. Throttle should suppress most edits.
    const events = []
    for (let i = 0; i < 20; i++) {
      events.push({ type: 'text-delta', id: `m${i}`, text: `word${i} ` })
    }
    events.push({ type: 'finish', finishReason: 'stop' })

    const { runtime } = createFakeRuntime({ spec: { events } })
    createBot(runtime)

    await getHandler('on:message:text')(makeTgCtx())

    // With 20 events arriving instantly, throttle should produce far fewer edits.
    // We get: one "thinking" reply + a few throttled edits + final edit.
    // The key property: edit count < event count (21 events, ~2-3 edits).
    const editCount = editMessageTextMock.mock.calls.length
    expect(editCount).toBeLessThan(events.length)
    expect(editCount).toBeGreaterThanOrEqual(1) // at least the final edit
  })
})
