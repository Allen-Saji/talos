import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  type ControlPlane,
  createControlPlane,
  formatDiagnostics,
  renderServiceArtifact,
  streamRunToWs,
  writeServiceArtifact,
} from '@/daemon'
import { type ClientFrame, PROTOCOL_VERSION, type ServerFrame } from '@/protocol/frames'
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = 'test-token-1234'

type FakeRunSpec = {
  runId?: string
  events?: Array<Record<string, unknown>>
  /** Resolves the `done` promise — keeps tests deterministic. */
  doneAfterMs?: number
  /** If set, throws this error after streaming events, instead of resolving. */
  throwAfterEvents?: Error
}

/**
 * Build a tiny AgentRuntime test double whose `run` returns a hand-rolled
 * RunHandle. The latest call's AbortController-tracking signal is exposed on
 * the returned object so tests can assert abort behaviour.
 */
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
        { type: 'text-delta', id: 'm1', text: 'hello' },
        { type: 'text-end', id: 'm1' },
        {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 5, outputTokens: 1 },
        },
      ]

      const fullStream = (async function* () {
        for (const ev of events) {
          // Yield to the event loop so abort can be observed mid-stream.
          await new Promise((r) => setImmediate(r))
          if (aborted()) {
            yield { type: 'abort', reason: 'aborted' } as never
            return
          }
          yield ev as never
        }
        if (spec.throwAfterEvents) throw spec.throwAfterEvents
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
): Promise<{
  plane: ControlPlane
  url: string
}> {
  const plane = createControlPlane({ runtime, token, port: 0 })
  const { port, host } = await plane.start()
  return { plane, url: `ws://${host}:${port}` }
}

type FrameReader = {
  next(timeoutMs?: number): Promise<ServerFrame>
  collectUntil(predicate: (f: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame[]>
}

/**
 * Persistent frame reader — buffers frames as they arrive so callers never
 * miss messages between listener attach/detach windows.
 */
function makeReader(ws: WebSocket): FrameReader {
  const queue: ServerFrame[] = []
  const waiters: Array<{ resolve: (f: ServerFrame) => void; timer: NodeJS.Timeout }> = []

  ws.on('message', (raw: WebSocket.RawData) => {
    const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8')
    let frame: ServerFrame
    try {
      frame = JSON.parse(text) as ServerFrame
    } catch {
      return
    }
    const waiter = waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    } else {
      queue.push(frame)
    }
  })

  return {
    next(timeoutMs = 1500): Promise<ServerFrame> {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<ServerFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error(`no frame received within ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({ resolve, timer })
      })
    },
    async collectUntil(predicate, timeoutMs = 3000): Promise<ServerFrame[]> {
      const out: ServerFrame[] = []
      while (true) {
        const f = await this.next(timeoutMs)
        out.push(f)
        if (predicate(f)) return out
      }
    },
  }
}

function connectClient(url: string): Promise<{ ws: WebSocket; reader: FrameReader }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve({ ws, reader: makeReader(ws) }))
    ws.once('error', reject)
  })
}

function send(ws: WebSocket, frame: ClientFrame): void {
  ws.send(JSON.stringify(frame))
}

async function helloAndAuth(
  ws: WebSocket,
  reader: FrameReader,
  token: string = TOKEN,
): Promise<void> {
  send(ws, { type: 'hello', version: PROTOCOL_VERSION, client: 'test' })
  const ack = await reader.next()
  expect(ack.type).toBe('hello-ack')
  send(ws, { type: 'auth', token })
}

// ---------------------------------------------------------------------------
// Control plane lifecycle
// ---------------------------------------------------------------------------

describe('createControlPlane — lifecycle', () => {
  it('binds an ephemeral port and reports it', async () => {
    const { runtime } = createFakeRuntime()
    const plane = createControlPlane({ runtime, token: TOKEN, port: 0 })
    const { port, host } = await plane.start()
    expect(port).toBeGreaterThan(0)
    expect(host).toBe('127.0.0.1')
    await plane.stop()
  })

  it('connectionCount reflects open clients', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    expect(plane.connectionCount()).toBe(0)
    const { ws } = await connectClient(url)
    await new Promise((r) => setTimeout(r, 30))
    expect(plane.connectionCount()).toBe(1)
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(plane.connectionCount()).toBe(0)
    await plane.stop()
  })
})

// ---------------------------------------------------------------------------
// Frame protocol — hello / auth state machine
// ---------------------------------------------------------------------------

describe('frame protocol — hello + auth', () => {
  it('hello -> hello-ack with version + serverTime', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    send(ws, { type: 'hello', version: '0.1.0' })
    const ack = await reader.next()
    expect(ack.type).toBe('hello-ack')
    if (ack.type === 'hello-ack') {
      expect(ack.version).toBe(PROTOCOL_VERSION)
      expect(typeof ack.serverTime).toBe('string')
    }
    ws.close()
    await plane.stop()
  })

  it('rejects malformed JSON with INVALID_FRAME', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    ws.send('not json{')
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('INVALID_FRAME')
    ws.close()
    await plane.stop()
  })

  it('rejects unknown frame shapes with INVALID_FRAME', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    ws.send(JSON.stringify({ type: 'nope' }))
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('INVALID_FRAME')
    ws.close()
    await plane.stop()
  })

  it('hello twice -> HELLO_REPEAT', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    send(ws, { type: 'hello', version: '0.1.0' })
    await reader.next() // ack
    send(ws, { type: 'hello', version: '0.1.0' })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('HELLO_REPEAT')
    ws.close()
    await plane.stop()
  })

  it('auth before hello -> AUTH_BEFORE_HELLO', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    send(ws, { type: 'auth', token: TOKEN })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('AUTH_BEFORE_HELLO')
    ws.close()
    await plane.stop()
  })

  it('auth with wrong token -> AUTH_FAILED + connection closed', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    send(ws, { type: 'hello', version: '0.1.0' })
    await reader.next()
    send(ws, { type: 'auth', token: 'WRONG' })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('AUTH_FAILED')
    await new Promise((r) => setTimeout(r, 50))
    expect([WebSocket.CLOSED, WebSocket.CLOSING]).toContain(ws.readyState)
    await plane.stop()
  })

  it('auth twice -> AUTH_REPEAT', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'auth', token: TOKEN })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('AUTH_REPEAT')
    ws.close()
    await plane.stop()
  })

  it('run-start before auth -> NOT_AUTHENTICATED + closed', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    send(ws, { type: 'hello', version: '0.1.0' })
    await reader.next() // ack — auth not sent
    send(ws, { type: 'run-start', threadId: 't', prompt: 'hi' })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('NOT_AUTHENTICATED')
    await new Promise((r) => setTimeout(r, 50))
    expect([WebSocket.CLOSED, WebSocket.CLOSING]).toContain(ws.readyState)
    await plane.stop()
  })
})

// ---------------------------------------------------------------------------
// Run lifecycle: run-start -> run-event -> run-done
// ---------------------------------------------------------------------------

describe('run lifecycle', () => {
  it('streams run-event frames followed by run-done', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't1', prompt: 'hi' })

    const frames = await reader.collectUntil((f) => f.type === 'run-done')
    const eventFrames = frames.filter((f) => f.type === 'run-event')
    const done = frames.find((f) => f.type === 'run-done')
    expect(eventFrames.length).toBeGreaterThan(0)
    expect(done).toBeDefined()
    if (done?.type === 'run-done') {
      expect(done.runId).toBe('run-1')
      expect(done.finishReason).toBe('stop')
      expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 1 })
    }

    ws.close()
    await plane.stop()
  })

  it('reports inflight count during a run, then drops to zero', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: Array.from({ length: 8 }, (_, i) => ({
          type: 'text-delta',
          id: 'm',
          text: `${i}`,
        })),
        doneAfterMs: 50,
      },
    })
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't1', prompt: 'hi' })
    // Wait for at least one run-event then sample
    await reader.next() // first run-event
    expect(plane.inflightRunCount()).toBe(1)

    await reader.collectUntil((f) => f.type === 'run-done')
    expect(plane.inflightRunCount()).toBe(0)

    ws.close()
    await plane.stop()
  })

  it('run-cancel for unknown runId -> UNKNOWN_RUN', async () => {
    const { runtime } = createFakeRuntime()
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-cancel', runId: 'nonexistent' })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') {
      expect(err.code).toBe('UNKNOWN_RUN')
      expect(err.runId).toBe('nonexistent')
    }
    ws.close()
    await plane.stop()
  })

  it('run-cancel triggers AbortController.abort on inflight run', async () => {
    const longEvents = Array.from({ length: 100 }, (_, i) => ({
      type: 'text-delta',
      id: 'm',
      text: `${i}`,
    }))
    const { runtime, calls } = createFakeRuntime({
      spec: { events: longEvents, doneAfterMs: 10 },
    })
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't1', prompt: 'hi' })
    // Receive a couple of frames then cancel
    await reader.next()
    send(ws, { type: 'run-cancel', runId: 'run-1' })
    await reader.collectUntil((f) => f.type === 'run-done', 2000)
    expect(calls[0]?.aborted()).toBe(true)
    ws.close()
    await plane.stop()
  })

  it('two concurrent runs on one connection both stream', async () => {
    const { runtime } = createFakeRuntime({
      spec: (opts) => ({
        runId: `run-${opts.threadId}`,
        events: [
          { type: 'text-start', id: opts.threadId },
          { type: 'text-delta', id: opts.threadId, text: opts.intent },
          { type: 'text-end', id: opts.threadId },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ],
      }),
    })
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 'A', prompt: 'first' })
    send(ws, { type: 'run-start', threadId: 'B', prompt: 'second' })

    const seenDones = new Set<string>()
    while (seenDones.size < 2) {
      const f = await reader.next(3000)
      if (f.type === 'run-done') seenDones.add(f.runId)
    }
    expect(seenDones).toEqual(new Set(['run-A', 'run-B']))
    ws.close()
    await plane.stop()
  })

  it('disconnect aborts all inflight runs', async () => {
    const longEvents = Array.from({ length: 100 }, (_, i) => ({
      type: 'text-delta',
      id: 'm',
      text: `${i}`,
    }))
    const { runtime, calls } = createFakeRuntime({
      spec: { events: longEvents, doneAfterMs: 100 },
    })
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't1', prompt: 'hi' })
    await reader.next()
    ws.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(calls[0]?.aborted()).toBe(true)
    await plane.stop()
  })

  it('runtime.run failure -> RUN_START_FAILED frame', async () => {
    const failingRuntime: AgentRuntime = {
      async run() {
        throw new Error('runtime exploded')
      },
    }
    const { plane, url } = await startPlane(failingRuntime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't', prompt: 'hi' })
    const err = await reader.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') {
      expect(err.code).toBe('RUN_START_FAILED')
      expect(err.message).toContain('runtime exploded')
    }
    ws.close()
    await plane.stop()
  })
})

// ---------------------------------------------------------------------------
// Drain shutdown
// ---------------------------------------------------------------------------

describe('graceful shutdown', () => {
  it('stop() aborts inflight runs and closes the server', async () => {
    const longEvents = Array.from({ length: 100 }, (_, i) => ({
      type: 'text-delta',
      id: 'm',
      text: `${i}`,
    }))
    const { runtime, calls } = createFakeRuntime({
      spec: { events: longEvents, doneAfterMs: 100 },
    })
    const { plane, url } = await startPlane(runtime)
    const { ws, reader } = await connectClient(url)
    await helloAndAuth(ws, reader)
    send(ws, { type: 'run-start', threadId: 't1', prompt: 'hi' })
    await reader.next()
    await plane.stop({ drainTimeoutMs: 500 })
    expect(calls[0]?.aborted()).toBe(true)
    expect(plane.connectionCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// streamRunToWs (unit-ish — bypasses WS)
// ---------------------------------------------------------------------------

describe('streamRunToWs', () => {
  it('forwards events and emits run-done with finishReason + usage', async () => {
    const events = [
      { type: 'text-delta', id: 'm', text: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 3, outputTokens: 2 },
      },
    ]
    const handle: RunHandle = {
      runId: 'r-1',
      fullStream: (async function* () {
        for (const e of events) yield e as never
      })(),
      done: Promise.resolve(),
    }
    const sent: ServerFrame[] = []
    await streamRunToWs({ handle, send: (f) => sent.push(f) })
    expect(sent.filter((f) => f.type === 'run-event')).toHaveLength(2)
    const done = sent[sent.length - 1]
    expect(done?.type).toBe('run-done')
    if (done?.type === 'run-done') {
      expect(done.finishReason).toBe('stop')
      expect(done.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    }
  })

  it('still emits run-done if handle.done rejects (runtime swallows)', async () => {
    const handle: RunHandle = {
      runId: 'r-2',
      fullStream: (async function* () {})(),
      done: Promise.reject(new Error('post-run hook failed')),
    }
    const sent: ServerFrame[] = []
    await streamRunToWs({ handle, send: (f) => sent.push(f) })
    expect(sent[sent.length - 1]?.type).toBe('run-done')
  })
})

// ---------------------------------------------------------------------------
// install-service (pure functions)
// ---------------------------------------------------------------------------

describe('renderServiceArtifact', () => {
  it('renders a launchd plist on darwin', () => {
    const a = renderServiceArtifact({
      binPath: '/opt/talos/talosd',
      home: '/Users/alice',
      platform: 'darwin',
      logDir: '/Users/alice/.local/share/talos',
    })
    expect(a.platform).toBe('darwin')
    expect(a.servicePath).toBe('/Users/alice/Library/LaunchAgents/com.talos.daemon.plist')
    expect(a.body).toContain('<key>Label</key>')
    expect(a.body).toContain('<string>com.talos.daemon</string>')
    expect(a.body).toContain('<string>/opt/talos/talosd</string>')
    expect(a.followups[0]).toContain('launchctl load')
  })

  it('renders a systemd user unit on linux', () => {
    const a = renderServiceArtifact({
      binPath: '/opt/talos/talosd',
      home: '/home/alice',
      platform: 'linux',
      logDir: '/home/alice/.local/share/talos',
    })
    expect(a.platform).toBe('linux')
    expect(a.servicePath).toBe('/home/alice/.config/systemd/user/talosd.service')
    expect(a.body).toContain('[Service]')
    expect(a.body).toContain('ExecStart=/opt/talos/talosd')
    expect(a.followups.some((c) => c.includes('systemctl --user enable'))).toBe(true)
  })

  it('throws on unsupported platforms', () => {
    expect(() =>
      renderServiceArtifact({ binPath: '/opt/x', platform: 'win32' as NodeJS.Platform }),
    ).toThrow(/unsupported platform/)
  })

  it('writeServiceArtifact writes the file 0644 and creates parents', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'talos-svc-'))
    const artifact = renderServiceArtifact({
      binPath: '/opt/talos/talosd',
      home: tmp,
      platform: 'linux',
      logDir: '/var/log/talos',
    })
    writeServiceArtifact(artifact)
    expect(fs.existsSync(artifact.servicePath)).toBe(true)
    const stat = fs.statSync(artifact.servicePath)
    expect(stat.mode & 0o777).toBe(0o644)
    await fsp.rm(tmp, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// formatDiagnostics
// ---------------------------------------------------------------------------

describe('formatDiagnostics', () => {
  it('aligns name column and prefixes pass/fail', () => {
    const out = formatDiagnostics([
      { name: 'db', pass: true, detail: 'ok' },
      { name: 'keeperhub', pass: false, detail: 'no session' },
    ])
    const lines = out.split('\n')
    expect(lines[0]?.startsWith('PASS')).toBe(true)
    expect(lines[1]?.startsWith('FAIL')).toBe(true)
    // name column padded to longest name (9 chars: 'keeperhub')
    expect(lines[0]).toContain('db       ')
  })
})

// ---------------------------------------------------------------------------
// PID file lifecycle (covered indirectly elsewhere; smoke test here)
// ---------------------------------------------------------------------------

describe('pidfile helpers', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'talos-pid-'))
  })
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('writePidFile + removePidFile round-trip', async () => {
    const { writePidFile, removePidFile } = await import('@/persistence/ownership')
    const pidPath = path.join(tmpDir, 'sub', 'daemon.pid')
    writePidFile({ paths: { pidPath }, pid: 12345 })
    expect(fs.readFileSync(pidPath, 'utf8').trim()).toBe('12345')
    removePidFile({ paths: { pidPath } })
    expect(fs.existsSync(pidPath)).toBe(false)
    // idempotent
    removePidFile({ paths: { pidPath } })
  })
})
