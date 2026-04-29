import type { Writable } from 'node:stream'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

export type PrinterOpts = {
  out?: Writable
  /** Force-disable ANSI escapes (default: auto-detect from stream). */
  noColor?: boolean
}

export type Printer = {
  /** Render a single Vercel AI SDK `TextStreamPart`-shaped event. */
  print(event: unknown): void
  /** Newline if the last write didn't end on one. Used between turns. */
  endLine(): void
}

type AnyEvent = Record<string, unknown> & { type?: string }

export function createPrinter(opts: PrinterOpts = {}): Printer {
  const out = opts.out ?? process.stdout
  const useColor = !opts.noColor && (out as { isTTY?: boolean }).isTTY === true
  const c = (code: string): string => (useColor ? code : '')

  let lineDirty = false

  function write(s: string): void {
    out.write(s)
    if (s.length > 0) lineDirty = !s.endsWith('\n')
  }

  function ensureNewline(): void {
    if (lineDirty) {
      out.write('\n')
      lineDirty = false
    }
  }

  return {
    print(event: unknown): void {
      if (!event || typeof event !== 'object') return
      const ev = event as AnyEvent
      switch (ev.type) {
        case 'text-delta': {
          const text = typeof ev.text === 'string' ? ev.text : ''
          write(text)
          return
        }
        case 'tool-call': {
          ensureNewline()
          const name = typeof ev.toolName === 'string' ? ev.toolName : '<tool>'
          write(`${c(ANSI.dim)}${c(ANSI.cyan)}> ${name}${c(ANSI.reset)}\n`)
          return
        }
        case 'tool-result': {
          ensureNewline()
          write(`${c(ANSI.dim)}  done${c(ANSI.reset)}\n`)
          return
        }
        case 'tool-error': {
          ensureNewline()
          const msg =
            typeof ev.error === 'string'
              ? ev.error
              : ev.error && typeof ev.error === 'object' && 'message' in ev.error
                ? String((ev.error as { message: unknown }).message)
                : 'tool failed'
          write(`${c(ANSI.red)}  error: ${msg}${c(ANSI.reset)}\n`)
          return
        }
        case 'abort': {
          ensureNewline()
          write(`${c(ANSI.dim)}[aborted]${c(ANSI.reset)}\n`)
          return
        }
        case 'error': {
          ensureNewline()
          const msg =
            typeof ev.error === 'string'
              ? ev.error
              : ev.error && typeof ev.error === 'object' && 'message' in ev.error
                ? String((ev.error as { message: unknown }).message)
                : 'error'
          write(`${c(ANSI.red)}error: ${msg}${c(ANSI.reset)}\n`)
          return
        }
        case 'finish': {
          ensureNewline()
          const usage = ev.totalUsage ?? ev.usage
          if (usage && typeof usage === 'object') {
            const u = usage as { inputTokens?: number; outputTokens?: number }
            const parts: string[] = []
            if (typeof u.inputTokens === 'number') parts.push(`in=${u.inputTokens}`)
            if (typeof u.outputTokens === 'number') parts.push(`out=${u.outputTokens}`)
            if (parts.length) {
              write(`${c(ANSI.gray)}[${parts.join(' ')}]${c(ANSI.reset)}\n`)
            }
          }
          return
        }
        // Ignored event types: start, start-step, text-start, text-end,
        // reasoning-*, tool-input-*, source, file, finish-step, raw.
        default:
          return
      }
    },
    endLine(): void {
      ensureNewline()
    },
  }
}
