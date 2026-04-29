import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonClient } from '@/channels/ws-client'
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
  doneAfterMs?: number
}

function createFakeRuntime(
  opts: { spec?: FakeRunSpec | ((opts: RunOptions) => FakeRunSpec) } = {},
) {
  const calls: Array<{ opts: RunOptions; aborted: () => boolean; runId: string }> = []
  let runCounter = 0

  const runtime: AgentRuntime = {
    async run(runOpts: RunOptions): Promise<RunHandle> {
      const spec = typeof opts.spec === 'function' ? opts.spec(runOpts) : (opts.spec ?? {})
      const runId = spec.runId ?? `run-${++runCounter}`
      const aborted = () => runOpts.abortSignal?.aborted ?? false
      calls.push({ opts: runOpts, aborted, runId })

      const events = spec.events ?? [
        { type: 'text-start', id: 'm1' },
        { type: 'text-delta', id: 'm1', text: 'hi' },
        { type: 'text-end', id: 'm1' },
        {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 5, outputTokens: 1 },
        },
      ]

      const fullStream = (async function* () {
        for (const ev of events) {
          await new Promise((r) => setImmediate(r))
          if (aborted()) {
            yield { type: 'abort', reason: 'aborted' } as never
            return
          }
          yield ev as never
        }
      })()

      const done = spec.doneAfterMs
        ? new Promise<void>((res) => setTimeout(res, spec.doneAfterMs))
        : Promise.resolve()

      return { runId, fullStream, done }
    },
  }

  return { runtime, calls }
}

async function startPlane(
  runtime: AgentRuntime,
  token: string = TOKEN,
): Promise<{ plane: ControlPlane; url: string }> {
  const plane = createControlPlane({ runtime, token, port: 0 })
  const { port, host } = await plane.start()
  return { plane, url: `ws://${host}:${port}` }
}

let plane: ControlPlane | null = null
afterEach(async () => {
  if (plane) {
    await plane.stop({ drainTimeoutMs: 100 })
    plane = null
  }
})

describe('createDaemonClient — handshake', () => {
  it('completes hello-ack + auth on start', async () => {
    const { runtime } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN, client: 'test' })
    await client.start()
    await client.close()
  })

  it('rejects start() if hello-ack times out', async () => {
    // Connect to a port nothing's listening on — open() rejects.
    const client = createDaemonClient({
      url: 'ws://127.0.0.1:1', // unreachable
      token: TOKEN,
      helloTimeoutMs: 100,
    })
    await expect(client.start()).rejects.toThrow()
  })
})

describe('createDaemonClient — runStart', () => {
  it('streams events and resolves done with finish info', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        runId: 'run-x',
        events: [
          { type: 'text-delta', id: 'm1', text: 'foo' },
          { type: 'text-delta', id: 'm1', text: 'bar' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ],
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()

    const stream = client.runStart({ threadId: 't1', prompt: 'hello' })
    const collected: unknown[] = []
    for await (const ev of stream.events) collected.push(ev)
    const doneFrame = await stream.done

    expect(doneFrame.runId).toBe('run-x')
    expect(doneFrame.finishReason).toBe('stop')
    expect(doneFrame.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(collected.map((e) => (e as { type: string }).type)).toEqual([
      'text-delta',
      'text-delta',
      'finish',
    ])

    const runId = await stream.ready
    expect(runId).toBe('run-x')

    await client.close()
  })

  it('exposes ready promise resolving to runId on first event', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        runId: 'run-ready',
        events: [
          { type: 'text-delta', id: 'm1', text: 'a' },
          { type: 'finish', finishReason: 'stop' },
        ],
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const stream = client.runStart({ threadId: 't1', prompt: 'p' })
    const id = await stream.ready
    expect(id).toBe('run-ready')

    // Drain so done resolves cleanly.
    for await (const _ of stream.events) {
      // no-op
    }
    await stream.done
    await client.close()
  })

  it('rejects double runStart while inflight', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: [
          { type: 'text-delta', id: 'm1', text: 'a' },
          { type: 'finish', finishReason: 'stop' },
        ],
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const _stream = client.runStart({ threadId: 't1', prompt: 'p' })
    expect(() => client.runStart({ threadId: 't1', prompt: 'p2' })).toThrow(/in flight/i)

    for await (const _ of _stream.events) {
      // drain
    }
    await _stream.done
    await client.close()
  })
})

describe('createDaemonClient — cancel', () => {
  it('sends run-cancel after runId is known', async () => {
    const { runtime, calls } = createFakeRuntime({
      spec: {
        runId: 'run-cancel-test',
        events: Array.from({ length: 30 }, (_, i) => ({
          type: 'text-delta' as const,
          id: 'm1',
          text: `${i}`,
        })),
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const stream = client.runStart({ threadId: 't1', prompt: 'p' })
    await stream.ready

    stream.cancel()

    const collected: unknown[] = []
    try {
      for await (const ev of stream.events) collected.push(ev)
    } catch {
      // swallow
    }
    try {
      await stream.done
    } catch {
      // swallow
    }

    expect(calls[0]?.aborted()).toBe(true)
    await client.close()
  })

  it('buffers cancel until runId is known', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        runId: 'run-buffered-cancel',
        events: Array.from({ length: 30 }, (_, i) => ({
          type: 'text-delta' as const,
          id: 'm1',
          text: `${i}`,
        })),
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const stream = client.runStart({ threadId: 't1', prompt: 'p' })

    // Cancel BEFORE first event arrives.
    stream.cancel()

    try {
      for await (const _ of stream.events) {
        // drain
      }
    } catch {
      // swallow
    }
    try {
      await stream.done
    } catch {
      // swallow
    }

    await client.close()
  })
})

describe('createDaemonClient — error frames', () => {
  it('rejects done when runtime.run() throws', async () => {
    const runtime: AgentRuntime = {
      async run(): Promise<RunHandle> {
        throw new Error('runtime boom')
      },
    }
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const stream = client.runStart({ threadId: 't1', prompt: 'p' })

    await expect(stream.done).rejects.toThrow(/RUN_START_FAILED/)
    await client.close()
  })
})

describe('createDaemonClient — close', () => {
  it('rejects pending run on close()', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: [
          { type: 'text-delta', id: 'm1', text: 'a' },
          { type: 'text-delta', id: 'm1', text: 'b' },
          { type: 'finish', finishReason: 'stop' },
        ],
        doneAfterMs: 200,
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const client = createDaemonClient({ url: started.url, token: TOKEN })
    await client.start()
    const stream = client.runStart({ threadId: 't1', prompt: 'p' })
    await stream.ready

    // Pre-arm the rejection handler so the synchronous reject in close()
    // doesn't surface as an unhandled rejection across the await boundary.
    const doneAssertion = expect(stream.done).rejects.toThrow(/closing|closed/)
    await client.close()
    await doneAssertion
  })
})
