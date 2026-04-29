import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { createDaemonClient, type DaemonClient } from '@/channels/ws-client'
import { createPrinter, type Printer } from './printer'

export type ReplOpts = {
  daemonUrl: string
  token: string
  /** Override the user identifier in the default thread id (defaults to $USER). */
  user?: string
  /** Override the starting thread id; otherwise `cli:${user}:default`. */
  threadId?: string
  /** Source for prompts. Defaults to process.stdin. */
  input?: Readable
  /** Sink for prompts/output. Defaults to process.stdout. */
  output?: Writable
  /** Override printer (testing). */
  printer?: Printer
  /** Override daemon client (testing). */
  client?: DaemonClient
  /** Disable colour output. */
  noColor?: boolean
  /** Override how SIGINT is wired (testing). */
  onSigint?: (handler: () => void) => () => void
}

const HELP_TEXT = `Commands:
  /help               show this help
  /quit               exit (Ctrl-D also exits)
  /new                start a fresh thread (rotates id)
  /thread <id>        switch to a specific thread id
  /status             show current thread

Press Ctrl-C to cancel an inflight run. Press Ctrl-C twice quickly to exit.
`

const DOUBLE_SIGINT_WINDOW_MS = 1_000

export type ReplResult = {
  exitCode: number
}

export async function runRepl(opts: ReplOpts): Promise<ReplResult> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const printer = opts.printer ?? createPrinter({ out: output, noColor: opts.noColor })

  const user = opts.user ?? process.env.USER ?? 'default'
  let threadId = opts.threadId ?? `cli:${user}:default`

  const client =
    opts.client ??
    createDaemonClient({ url: opts.daemonUrl, token: opts.token, client: 'talos-repl' })

  if (!opts.client) await client.start()

  const rl = readline.createInterface({
    input,
    output,
    prompt: '> ',
    terminal: (input as { isTTY?: boolean }).isTTY === true,
  })

  let inflightCancel: (() => void) | null = null
  let lastSigintAt = 0
  let exiting = false
  let exitCode = 0

  const detachSigint = (opts.onSigint ?? attachProcessSigint)(() => {
    const now = Date.now()
    if (inflightCancel) {
      inflightCancel()
      inflightCancel = null
      output.write('\n^C — cancelling. Press Ctrl-C again to exit.\n')
      lastSigintAt = now
      return
    }
    if (now - lastSigintAt < DOUBLE_SIGINT_WINDOW_MS) {
      exitCode = 130
      exiting = true
      rl.close()
      return
    }
    output.write('\n(^C again to exit)\n')
    rl.prompt()
    lastSigintAt = now
  })

  output.write(`talos repl — thread ${threadId}\n`)
  rl.prompt()

  await new Promise<void>((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        rl.prompt()
        return
      }

      if (trimmed.startsWith('/')) {
        const cmd = handleSlashCommand(trimmed, {
          getThread: () => threadId,
          setThread: (next) => {
            threadId = next
          },
          user,
        })
        if (cmd.message) output.write(cmd.message)
        if (cmd.exit) {
          exiting = true
          rl.close()
          return
        }
        rl.prompt()
        return
      }

      try {
        const stream = client.runStart({ threadId, prompt: trimmed })
        inflightCancel = stream.cancel
        const settledDone: Promise<unknown> = stream.done.catch((err: unknown) => err)
        try {
          for await (const ev of stream.events) printer.print(ev)
          const r = await settledDone
          if (r instanceof Error) throw r
        } catch (err) {
          output.write(`\nrun failed: ${err instanceof Error ? err.message : String(err)}\n`)
          exitCode = 1
        } finally {
          inflightCancel = null
          printer.endLine()
        }
      } catch (err) {
        output.write(`\nrun-start failed: ${err instanceof Error ? err.message : String(err)}\n`)
        exitCode = 1
      }
      if (!exiting) rl.prompt()
    })

    rl.on('close', () => {
      resolve()
    })
  })

  detachSigint()
  if (!opts.client) await client.close()
  return { exitCode }
}

type SlashCtx = {
  getThread: () => string
  setThread: (next: string) => void
  user: string
}

type SlashResult = { message?: string; exit?: boolean }

function handleSlashCommand(line: string, ctx: SlashCtx): SlashResult {
  const [cmdRaw, ...rest] = line.slice(1).split(/\s+/)
  const cmd = cmdRaw?.toLowerCase()
  switch (cmd) {
    case 'help':
      return { message: HELP_TEXT }
    case 'quit':
    case 'exit':
      return { message: 'goodbye\n', exit: true }
    case 'new': {
      const id = `cli:${ctx.user}:${randomUUID()}`
      ctx.setThread(id)
      return { message: `→ new thread ${id}\n` }
    }
    case 'thread': {
      const target = rest.join(' ').trim()
      if (!target) return { message: `current thread: ${ctx.getThread()}\n` }
      ctx.setThread(target)
      return { message: `→ switched to ${target}\n` }
    }
    case 'status':
      return { message: `thread: ${ctx.getThread()}\n` }
    default:
      return { message: `unknown command: /${cmd ?? ''}\nTry /help.\n` }
  }
}

function attachProcessSigint(handler: () => void): () => void {
  process.on('SIGINT', handler)
  return () => {
    process.off('SIGINT', handler)
  }
}
