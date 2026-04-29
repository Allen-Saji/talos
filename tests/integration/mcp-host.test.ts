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

  it('parses JSON from single text content item', () => {
    const result = { content: [{ type: 'text', text: '{"balance":"100"}' }] }
    expect(flattenToolResult(result)).toEqual({ balance: '100' })
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

const { mockCreateMCPClient, MockStdioTransport } = vi.hoisted(() => {
  const mockClose = vi.fn().mockResolvedValue(undefined)
  const mockTools = vi.fn().mockResolvedValue({
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
  })
  const mockCreateMCPClient = vi.fn().mockResolvedValue({
    tools: mockTools,
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    close: mockClose,
    serverInfo: { name: 'test-server', version: '1.0.0' },
  })
  const MockStdioTransport = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  }))
  return { mockClose, mockTools, mockCreateMCPClient, MockStdioTransport }
})

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

  it('calls tool with namespaced name', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    const result = await host.callTool('aave_supply', { amount: '100' })
    expect(result).toEqual({ tx: '0xabc' })

    await host.stop()
  })

  it('throws on unknown server', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await expect(host.callTool('unknown_supply', {})).rejects.toThrow(
      'unknown MCP server "unknown"',
    )

    await host.stop()
  })

  it('throws on missing server prefix', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    await expect(host.callTool('supply', {})).rejects.toThrow('missing server prefix')

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

  it('reports server health', async () => {
    const host = new McpHost()
    await host.start([{ name: 'aave', transport: 'http', url: 'https://mcp.aave.com' }])

    expect(host.getServerHealth()).toEqual({ aave: true })
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
