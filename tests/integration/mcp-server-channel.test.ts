import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpProxy } from '@/channels/mcp-server/server'
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
  throwOnRun?: Error
}

function createFakeRuntime(
  opts: { spec?: FakeRunSpec | ((opts: RunOptions) => FakeRunSpec) } = {},
) {
  const calls: Array<{ opts: RunOptions; aborted: () => boolean }> = []
  let runCounter = 0

  const runtime: AgentRuntime = {
    async run(runOpts: RunOptions): Promise<RunHandle> {
      const spec = typeof opts.spec === 'function' ? opts.spec(runOpts) : (opts.spec ?? {})
      if (spec.throwOnRun) throw spec.throwOnRun
      const runId = spec.runId ?? `run-${++runCounter}`
      const aborted = () => runOpts.abortSignal?.aborted ?? false
      calls.push({ opts: runOpts, aborted })

      const events = spec.events ?? [
        { type: 'text-delta', id: 'm1', text: 'hi' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
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

let plane: ControlPlane | null = null
let proxy: Awaited<ReturnType<typeof createMcpProxy>> | null = null
let mcpClient: Client | null = null

afterEach(async () => {
  if (mcpClient) {
    await mcpClient.close().catch(() => undefined)
    mcpClient = null
  }
  if (proxy) {
    await proxy.close().catch(() => undefined)
    proxy = null
  }
  if (plane) {
    await plane.stop({ drainTimeoutMs: 100 })
    plane = null
  }
})

async function bootstrapMcpProxy(
  daemonUrl: string,
  threadId?: string,
): Promise<{
  client: Client
  proxyHandle: Awaited<ReturnType<typeof createMcpProxy>>
}> {
  const proxyHandle = await createMcpProxy({
    daemonUrl,
    token: TOKEN,
    ...(threadId ? { threadId } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await proxyHandle.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} })
  await client.connect(clientTransport)

  return { client, proxyHandle }
}

describe('mcp-server-channel — talos_run tool', () => {
  it('lists talos_run', async () => {
    const { runtime } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const { client, proxyHandle } = await bootstrapMcpProxy(started.url)
    mcpClient = client
    proxy = proxyHandle

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('talos_run')
  })

  it('returns assembled assistant text from a tool call', async () => {
    const { runtime } = createFakeRuntime({
      spec: {
        events: [
          { type: 'text-delta', id: 'm1', text: 'four' },
          { type: 'text-delta', id: 'm1', text: '-twenty' },
          { type: 'finish', finishReason: 'stop' },
        ],
      },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const { client, proxyHandle } = await bootstrapMcpProxy(started.url)
    mcpClient = client
    proxy = proxyHandle

    const result = await client.callTool({
      name: 'talos_run',
      arguments: { prompt: 'what is the answer?' },
    })
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('four-twenty')
  })

  it('uses a per-process thread id (mcp:<pid>:<startedAt>)', async () => {
    const { runtime, calls } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const { client, proxyHandle } = await bootstrapMcpProxy(started.url)
    mcpClient = client
    proxy = proxyHandle

    await client.callTool({ name: 'talos_run', arguments: { prompt: 'hi' } })
    expect(calls[0]?.opts.threadId).toMatch(/^mcp:\d+:\d+$/)
  })

  it('honours an injected threadId', async () => {
    const { runtime, calls } = createFakeRuntime()
    const started = await startPlane(runtime)
    plane = started.plane

    const { client, proxyHandle } = await bootstrapMcpProxy(started.url, 'mcp:my-host:abc')
    mcpClient = client
    proxy = proxyHandle

    await client.callTool({ name: 'talos_run', arguments: { prompt: 'hi' } })
    expect(calls[0]?.opts.threadId).toBe('mcp:my-host:abc')
  })

  it('returns an error result if the run fails', async () => {
    const { runtime } = createFakeRuntime({
      spec: { throwOnRun: new Error('runtime down') },
    })
    const started = await startPlane(runtime)
    plane = started.plane

    const { client, proxyHandle } = await bootstrapMcpProxy(started.url)
    mcpClient = client
    proxy = proxyHandle

    const result = await client.callTool({
      name: 'talos_run',
      arguments: { prompt: 'hi' },
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.text).toContain('talos_run failed')
  })
})
