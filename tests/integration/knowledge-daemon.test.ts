import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { type ControlPlane, createControlPlane, type KnowledgeController } from '@/daemon'
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

const TOKEN = 'knowledge-test-token'

function inertRuntime(): AgentRuntime {
  return {
    async run(_opts: RunOptions): Promise<RunHandle> {
      throw new Error('runtime not used in this test file')
    },
  }
}

async function startPlane(opts: {
  knowledge?: KnowledgeController
}): Promise<{ plane: ControlPlane; url: string }> {
  const plane = createControlPlane({
    runtime: inertRuntime(),
    token: TOKEN,
    port: 0,
    ...(opts.knowledge ? { knowledge: opts.knowledge } : {}),
  })
  const { port, host } = await plane.start()
  return { plane, url: `ws://${host}:${port}` }
}

function send(ws: WebSocket, frame: ClientFrame): void {
  ws.send(JSON.stringify(frame))
}

async function readNext(ws: WebSocket, timeoutMs = 2000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8')
      resolve(JSON.parse(text) as ServerFrame)
    })
  })
}

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function helloAndAuth(ws: WebSocket): Promise<void> {
  send(ws, { type: 'hello', version: PROTOCOL_VERSION, client: 'kn-test' })
  const ack = await readNext(ws)
  expect(ack.type).toBe('hello-ack')
  send(ws, { type: 'auth', token: TOKEN })
}

describe('knowledge-refresh frame', () => {
  let plane: ControlPlane | null = null
  let ws: WebSocket | null = null

  beforeEach(() => {
    plane = null
    ws = null
  })

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    if (plane) await plane.stop()
  })

  it('routes through KnowledgeController and returns done frame', async () => {
    const refresh = vi.fn(async () => ({
      startedAt: '2026-04-30T12:00:00.000Z',
      finishedAt: '2026-04-30T12:00:01.500Z',
      totalDurationMs: 1500,
      sources: [
        { source: 'defillama:protocols', fetched: 50, chunks: 50, durationMs: 800 },
        { source: 'l2beat:summary', fetched: 12, chunks: 12, durationMs: 700 },
      ],
    }))
    const started = await startPlane({ knowledge: { refresh } })
    plane = started.plane
    ws = await connect(started.url)
    await helloAndAuth(ws)

    send(ws, { type: 'knowledge-refresh', requestId: 'req-1' })
    const frame = await readNext(ws)
    expect(frame.type).toBe('knowledge-refresh-done')
    if (frame.type !== 'knowledge-refresh-done') return
    expect(frame.requestId).toBe('req-1')
    expect(frame.sources.length).toBe(2)
    expect(frame.sources[0]?.source).toBe('defillama:protocols')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('returns KNOWLEDGE_DISABLED when no controller is wired', async () => {
    const started = await startPlane({})
    plane = started.plane
    ws = await connect(started.url)
    await helloAndAuth(ws)

    send(ws, { type: 'knowledge-refresh', requestId: 'req-2' })
    const frame = await readNext(ws)
    expect(frame.type).toBe('error')
    if (frame.type !== 'error') return
    expect(frame.code).toBe('KNOWLEDGE_DISABLED')
    expect(frame.requestId).toBe('req-2')
  })

  it('surfaces controller failures as KNOWLEDGE_REFRESH_FAILED', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('upstream timeout')
    })
    const started = await startPlane({ knowledge: { refresh } })
    plane = started.plane
    ws = await connect(started.url)
    await helloAndAuth(ws)

    send(ws, { type: 'knowledge-refresh', requestId: 'req-3' })
    const frame = await readNext(ws)
    expect(frame.type).toBe('error')
    if (frame.type !== 'error') return
    expect(frame.code).toBe('KNOWLEDGE_REFRESH_FAILED')
    expect(frame.message).toContain('upstream timeout')
    expect(frame.requestId).toBe('req-3')
  })

  it('rejects refresh before auth', async () => {
    const refresh = vi.fn(async () => ({
      startedAt: '0',
      finishedAt: '0',
      totalDurationMs: 0,
      sources: [],
    }))
    const started = await startPlane({ knowledge: { refresh } })
    plane = started.plane
    ws = await connect(started.url)

    // No hello/auth; first frame should error.
    send(ws, { type: 'knowledge-refresh', requestId: 'req-4' })
    const frame = await readNext(ws)
    expect(frame.type).toBe('error')
    expect(refresh).not.toHaveBeenCalled()
  })
})
