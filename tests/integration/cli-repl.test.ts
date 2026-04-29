import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRepl } from '@/channels/cli/repl'
import { type ControlPlane, createControlPlane } from '@/daemon'
import type { AgentRuntime, RunHandle, RunOptions } from '@/runtime/types'

vi.mock('@/config/env', () => ({
  loadEnv: () => ({
    OPENAI_API_KEY: 'test-key',
    TALOS_DAEMON_PORT: 0,
    TALOS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
  resetEnvCache: () => {},
}))

const TOKEN = 'test-token-1234'

type FakeRunSpec = {
  runId?: string
  events?: Array<Record<string, unknown>>
  /** Delay between events. Default: setImmediate. */
  eventDelayMs?: number
}

function createFakeRuntime(
  opts: { spec?: FakeRunSpec | ((opts: RunOptions) => FakeRunSpec) } = {},
) {
  const calls: Array<{ opts: RunOptions; aborted: () => boolean }> = []
  let runCounter = 0

  const runtime: AgentRuntime = {
    async run(runOpts: RunOptions): Promise<RunHandle> {
      const spec = typeof opts.spec === 'function' ? opts.spec(runOpts) : (opts.spec ?? {})
      const runId = spec.runId ?? `run-${++runCounter}`
      const aborted = () => runOpts.abortSignal?.aborted ?? false
      calls.push({ opts: runOpts, aborted })

      const events = spec.events ?? [
        { type: 'text-delta', id: 'm1', text: 'hi' },
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

async function startPlane(runtime: AgentRuntime): Promise<{ plane: ControlPlane; url: string }> {
  const plane = createControlPlane({ runtime, token: TOKEN, port: 0 })
  const { port, host } = await plane.start()
  return { plane, url: `ws://${host}:${port}` }
}

function memSink(): { sink: Writable; output: () => string } {
  let buf = ''
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      cb()
    },
  })
  return { sink, output: () => buf }
}

let plane: ControlPlane | null = null
afterEach(async () => {
  if (plane) {
    await plane.stop({ drainTimeoutMs: 100 })
    plane = null
  }
})

describe('runRepl — basic flow', () => {
  it('streams a single prompt + answer + exits on /quit', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: [
          { type: 'text-delta', id: 'm1', text: 'four' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 2, outputTokens: 1 } },
        ],
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()

    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    // Drive input.
    input.write('what is 2 + 2?\n')
    await new Promise((r) => setTimeout(r, 200))
    input.write('/quit\n')

    const result = await replPromise
    expect(result.exitCode).toBe(0)

    const out = output()
    expect(out).toContain('thread cli:allen:default')
    expect(out).toContain('four')
    expect(out).toContain('[in=2 out=1]')
    expect(out).toContain('goodbye')
  })

  it('exits on stdin close (Ctrl-D)', async () => {
    const { runtime } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink } = memSink()

    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    input.end()
    const result = await replPromise
    expect(result.exitCode).toBe(0)
  })
})

describe('runRepl — slash commands', () => {
  it('/help prints help text', async () => {
    const { runtime } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()
    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    input.write('/help\n')
    input.write('/quit\n')
    await replPromise

    expect(output()).toContain('Commands:')
    expect(output()).toContain('/new')
  })

  it('/new rotates thread id', async () => {
    const { runtime, calls } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()
    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    input.write('hello\n')
    await new Promise((r) => setTimeout(r, 200))
    input.write('/new\n')
    input.write('hello again\n')
    await new Promise((r) => setTimeout(r, 200))
    input.write('/quit\n')
    await replPromise

    expect(calls.length).toBe(2)
    expect(calls[0]?.opts.threadId).toBe('cli:allen:default')
    expect(calls[1]?.opts.threadId).toMatch(/^cli:allen:[0-9a-f-]+$/)
    expect(output()).toContain('→ new thread')
  })

  it('/thread <id> switches thread explicitly', async () => {
    const { runtime, calls } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()
    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    input.write('/thread cli:allen:custom\n')
    input.write('hi\n')
    await new Promise((r) => setTimeout(r, 200))
    input.write('/quit\n')
    await replPromise

    expect(calls[0]?.opts.threadId).toBe('cli:allen:custom')
    expect(output()).toContain('switched to cli:allen:custom')
  })

  it('unknown command shows hint', async () => {
    const { runtime } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()
    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint: () => () => {},
    })

    input.write('/foo\n')
    input.write('/quit\n')
    await replPromise

    expect(output()).toContain('unknown command')
  })
})

describe('runRepl — Ctrl-C handling', () => {
  it('first SIGINT cancels inflight; second exits', async () => {
    const { runtime, calls } = createFakeRuntime({
      spec: {
        events: Array.from({ length: 50 }, (_, i) => ({
          type: 'text-delta',
          id: 'm1',
          text: `${i} `,
        })),
        eventDelayMs: 20,
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const input = new PassThrough()
    const { sink, output } = memSink()

    const sigintRef: { current: (() => void) | null } = { current: null }
    const onSigint = (h: () => void): (() => void) => {
      sigintRef.current = h
      return () => {
        sigintRef.current = null
      }
    }

    const replPromise = runRepl({
      daemonUrl: started.url,
      token: TOKEN,
      user: 'allen',
      input,
      output: sink,
      noColor: true,
      onSigint,
    })

    input.write('long task\n')
    // Wait for run to start streaming
    await new Promise((r) => setTimeout(r, 100))
    expect(sigintRef.current).not.toBeNull()
    sigintRef.current?.()
    // wait for cancel to propagate
    await new Promise((r) => setTimeout(r, 200))
    sigintRef.current?.()

    const result = await replPromise
    expect(result.exitCode).toBe(130)
    expect(calls[0]?.aborted()).toBe(true)
    expect(output()).toContain('cancelling')
  })
})
