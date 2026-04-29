import { describe, expect, it, vi } from 'vitest'
import {
  flattenToolResult,
  McpHost,
  McpToolSource,
  namespaceToolName,
  parseToolAnnotations,
} from '@/mcp-host'

// ---------------------------------------------------------------------------
// Pure function tests: registry.ts
// ---------------------------------------------------------------------------

describe('namespaceToolName', () => {
  it('joins server and tool with underscore', () => {
    expect(namespaceToolName('aave', 'supply')).toBe('aave_supply')
  })

  it('handles nested names', () => {
    expect(namespaceToolName('blockscout', 'get_token_balance')).toBe(
      'blockscout_get_token_balance',
    )
  })

  it('handles server names containing underscores', () => {
    expect(namespaceToolName('aave_v3', 'supply')).toBe('aave_v3_supply')
  })
})

describe('parseToolAnnotations', () => {
  it('returns defaults when no annotations', () => {
    expect(parseToolAnnotations({})).toEqual({
      mutates: false,
      readOnly: false,
      destructive: false,
    })
  })

  it('parses mutates annotation', () => {
    expect(parseToolAnnotations({ annotations: { mutates: true } })).toEqual({
      mutates: true,
      readOnly: false,
      destructive: false,
    })
  })

  it('parses readOnlyHint', () => {
    expect(parseToolAnnotations({ annotations: { readOnlyHint: true } })).toEqual({
      mutates: false,
      readOnly: true,
      destructive: false,
    })
  })

  it('parses destructiveHint', () => {
    expect(parseToolAnnotations({ annotations: { destructiveHint: true } })).toEqual({
      mutates: false,
      readOnly: false,
      destructive: true,
    })
  })

  it('parses openWorldHint as mutates', () => {
    expect(parseToolAnnotations({ annotations: { openWorldHint: true } })).toEqual({
      mutates: true,
      readOnly: false,
      destructive: false,
    })
  })
})

describe('flattenToolResult', () => {
  it('returns empty string for null/undefined', () => {
    expect(flattenToolResult(null)).toBe('')
    expect(flattenToolResult(undefined)).toBe('')
  })

  it('passes through strings', () => {
    expect(flattenToolResult('hello')).toBe('hello')
  })

  it('stringifies non-object primitives', () => {
    expect(flattenToolResult(42)).toBe('42')
    expect(flattenToolResult(true)).toBe('true')
  })

  it('flattens single text content item to string', () => {
    const result = { content: [{ type: 'text', text: 'hello world' }] }
    expect(flattenToolResult(result)).toBe('hello world')
  })

  it('parses JSON object from single text content item', () => {
    const result = { content: [{ type: 'text', text: '{"balance":"100"}' }] }
    expect(flattenToolResult(result)).toEqual({ balance: '100' })
  })

  it('does not parse scalar JSON values (returns as text)', () => {
    expect(flattenToolResult({ content: [{ type: 'text', text: '42' }] })).toBe('42')
    expect(flattenToolResult({ content: [{ type: 'text', text: 'true' }] })).toBe('true')
    expect(flattenToolResult({ content: [{ type: 'text', text: 'null' }] })).toBe('null')
  })

  it('does not parse JSON arrays (returns as text)', () => {
    expect(flattenToolResult({ content: [{ type: 'text', text: '[1,2,3]' }] })).toBe('[1,2,3]')
  })

  it('returns text when JSON parse fails on object-shaped string', () => {
    const result = { content: [{ type: 'text', text: '{not valid json' }] }
    expect(flattenToolResult(result)).toBe('{not valid json')
  })

  it('joins multiple text items with newline', () => {
    const result = {
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    }
    expect(flattenToolResult(result)).toBe('line 1\n\nline 2')
  })

  it('wraps errors in <error> tag', () => {
    const result = {
      content: [{ type: 'text', text: 'something broke', isError: true }],
    }
    expect(flattenToolResult(result)).toBe('<error>something broke</error>')
  })

  it('returns non-MCP objects as-is', () => {
    const obj = { foo: 'bar' }
    expect(flattenToolResult(obj)).toEqual(obj)
  })
})

// ---------------------------------------------------------------------------
// McpHost integration tests (mocked MCP client)
// ---------------------------------------------------------------------------

type CreateMcpClientOpts = { onUncaughtError?: (err: unknown) => void }

const { mockCreateMCPClient, MockStdioTransport } = vi.hoisted(() => {
  const defaultClient = {
    tools: vi.fn().mockResolvedValue({
      supply: {
        description: 'Supply tokens to Aave',
        inputSchema: { type: 'object', properties: { amount: { type: 'string' } } },
        execute: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"tx":"0xabc"}' }] }),
      },
      borrow: {
        description: 'Borrow from Aave',
        inputSchema: { type: 'object', properties: { amount: { type: 'string' } } },
        execute: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'borrowed' }] }),
      },
    }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    serverInfo: { name: 'test-server', version: '1.0.0' },
  }
  const mockCreateMCPClient = vi.fn().mockResolvedValue(defaultClient)
  const MockStdioTransport = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  }))
  return { mockCreateMCPClient, MockStdioTransport }
})

/** Pull the onUncaughtError handler the host registered on its most recent createMCPClient call. */
function lastOnUncaughtError(): ((err: unknown) => void) | undefined {
  const calls = mockCreateMCPClient.mock.calls as Array<[CreateMcpClientOpts]>
  return calls[calls.length - 1]?.[0]?.onUncaughtError
}

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient,
}))

// Mock env to avoid KEEPERHUB_URL empty-string validation failure
vi.mock('@/config/env', () => ({
  loadEnv: () => ({
    OPENAI_API_KEY: 'test-key',
    TALOS_DAEMON_PORT: 7711,
    TALOS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
  resetEnvCache: () => {},
}))

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: MockStdioTransport,
}))

describe('McpHost', () => {
  it('starts and connects to servers', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    expect(host.isServerHealthy('aave')).toBe(true)
    const tools = host.listTools()
    expect(tools).toHaveLength(2)
    expect(tools[0]?.namespacedName).toBe('aave_supply')
    expect(tools[1]?.namespacedName).toBe('aave_borrow')

    await host.stop()
  })

  it('namespaces tools correctly', async () => {
    const host = new McpHost()
    await host.start([{ name: 'uniswap', transport: 'http', url: 'https://mcp.uniswap.org' }])

    const record = host.getToolRecord()
    expect(record).toHaveProperty('uniswap_supply')
    expect(record).toHaveProperty('uniswap_borrow')

    await host.stop()
  })

  it('routes calls correctly when server name contains an underscore', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave_v3', transport: 'http', url: 'https://mcp.aave.com' }])

    const record = host.getToolRecord()
    expect(record).toHaveProperty('aave_v3_supply')
    expect(record).toHaveProperty('aave_v3_borrow')

    const result = await host.callTool('aave_v3_supply', { amount: '100' })
    expect(result).toEqual({ tx: '0xabc' })

    await host.stop()
  })

  it('calls tool with namespaced name', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    const result = await host.callTool('aave_supply', { amount: '100' })
    expect(result).toEqual({ tx: '0xabc' })

    await host.stop()
  })

  it('throws when calling an unknown tool', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await expect(host.callTool('unknown_supply', {})).rejects.toThrow(
      'tool "unknown_supply" not found in any connected server',
    )
    await expect(host.callTool('supply', {})).rejects.toThrow(
      'tool "supply" not found in any connected server',
    )

    await host.stop()
  })

  it('throws if started twice', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await expect(
      host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }]),
    ).rejects.toThrow('already started')

    await host.stop()
  })

  it('reports server health with retries and last error', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    expect(host.getServerHealth()).toEqual({ aave: { healthy: true, retries: 0 } })
    expect(host.isServerHealthy('aave')).toBe(true)
    expect(host.isServerHealthy('nonexistent')).toBe(false)

    await host.stop()
  })

  it('cleans up on stop', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await host.stop()
    expect(host.listTools()).toHaveLength(0)
    expect(host.getServerHealth()).toEqual({})
  })

  it('flips healthy=false when onUncaughtError fires after connect', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])
    expect(host.isServerHealthy('aave')).toBe(true)

    const handler = lastOnUncaughtError()
    expect(handler).toBeDefined()
    handler?.(new Error('connection dropped'))

    expect(host.isServerHealthy('aave')).toBe(false)
    const health = host.getServerHealth()
    expect(health.aave?.healthy).toBe(false)
    expect(health.aave?.lastError).toBe('connection dropped')

    await host.stop()
  })

  it('applies staticAnnotations overrides during registration', async () => {
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({
        // No MCP-side annotations on this tool — relies on the static override.
        resolve_ens_name: {
          description: 'Resolve ENS name to address',
          execute: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '0xabc' }] }),
        },
        // Tool that ships an annotation; override should win for the field it sets.
        write_contract: {
          description: 'Write to a contract',
          annotations: { mutates: true },
          execute: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        },
        // Tool with no override: base annotations apply unchanged.
        get_balance: {
          description: 'Get balance',
          execute: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '1' }] }),
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const host = new McpHost({ maxAttempts: 1 })
    await host.start([
      {
        name: 'evmmcp',
        transport: 'http',
        url: 'http://localhost:0/evmmcp',
        staticAnnotations: {
          resolve_ens_name: { readOnly: true },
          write_contract: { readOnly: true }, // intentional override of an upstream-set field
        },
      },
    ])

    const tools = host.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.namespacedName, t]))

    // Override applied to a tool with no upstream annotations.
    expect(byName.evmmcp_resolve_ens_name?.annotations.readOnly).toBe(true)
    expect(byName.evmmcp_resolve_ens_name?.annotations.mutates).toBe(false)

    // Override wins over MCP-supplied annotation; non-overridden fields preserved.
    expect(byName.evmmcp_write_contract?.annotations.readOnly).toBe(true)
    expect(byName.evmmcp_write_contract?.annotations.mutates).toBe(true)

    // No override → base annotations untouched.
    expect(byName.evmmcp_get_balance?.annotations.readOnly).toBe(false)
    expect(byName.evmmcp_get_balance?.annotations.mutates).toBe(false)

    await host.stop()
  })

  it('aborts a tool call that exceeds the timeout', async () => {
    mockCreateMCPClient.mockResolvedValueOnce({
      tools: vi.fn().mockResolvedValue({
        slow: {
          description: 'slow tool',
          execute: vi.fn(() => new Promise(() => {})),
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const host = new McpHost({ toolCallTimeoutMs: 50 })
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await expect(host.callTool('aave_slow', {})).rejects.toThrow(
      'tool "aave_slow" timed out after 50ms',
    )

    await host.stop()
  })

  it('records retries and lastError when a server fails to connect', async () => {
    mockCreateMCPClient.mockRejectedValueOnce(new Error('connect refused'))
    mockCreateMCPClient.mockRejectedValueOnce(new Error('connect refused'))
    mockCreateMCPClient.mockRejectedValueOnce(new Error('connect refused'))

    const host = new McpHost({ maxAttempts: 3, baseDelayMs: 1 })
    await expect(
      host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }]),
    ).rejects.toThrow('all servers failed to connect')

    const health = host.getServerHealth()
    expect(health.aave?.healthy).toBe(false)
    expect(health.aave?.retries).toBe(3)
    expect(health.aave?.lastError).toBe('connect refused')
  })
})

// ---------------------------------------------------------------------------
// McpToolSource tests
// ---------------------------------------------------------------------------

describe('McpToolSource', () => {
  it('wraps McpHost.getToolRecord()', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    const source = new McpToolSource(host)
    const tools = await source.getTools()

    expect(tools).toHaveProperty('aave_supply')
    expect(tools).toHaveProperty('aave_borrow')
    expect(typeof tools.aave_supply?.execute).toBe('function')

    await host.stop()
  })
})
