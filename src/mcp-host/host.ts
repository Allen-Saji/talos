import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp'
import type { Tool } from 'ai'
import { child } from '@/shared/logger'
import type { McpServerConfig } from './index'
import {
  flattenToolResult,
  type NamespacedToolEntry,
  namespaceToolName,
  parseToolAnnotations,
} from './registry'
import { buildTransport } from './transports'

const log = child({ module: 'mcp-host' })

/** Transport config shape for HTTP/SSE connections (matches @ai-sdk/mcp internal type) */
type HttpTransportConfig = {
  type: 'sse' | 'http'
  url: string
  headers?: Record<string, string>
}

/** Per-server connection state */
type ServerEntry = {
  config: McpServerConfig
  client: MCPClient | null
  tools: Map<string, NamespacedToolEntry>
  healthy: boolean
  retries: number
}

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

/**
 * McpHost — manages connections to N MCP servers and exposes their tools
 * under a single namespaced registry.
 */
export class McpHost {
  private servers = new Map<string, ServerEntry>()
  private started = false

  /**
   * Connect to all configured servers. Retries with exponential backoff
   * on failure. Does not throw on individual server failures — logs and
   * marks unhealthy.
   */
  async start(configs: McpServerConfig[]): Promise<void> {
    if (this.started) {
      throw new Error('McpHost already started — call stop() first')
    }

    for (const config of configs) {
      this.servers.set(config.name, {
        config,
        client: null,
        tools: new Map(),
        healthy: false,
        retries: 0,
      })
    }

    const results = await Promise.allSettled(configs.map((c) => this.connectServer(c.name)))

    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length === configs.length) {
      throw new Error('McpHost: all servers failed to connect')
    }

    if (failed.length > 0) {
      log.warn(
        { failed: failed.length, total: configs.length },
        'some MCP servers failed to connect',
      )
    }

    this.started = true
    log.info({ servers: configs.length }, 'McpHost started')
  }

  /**
   * Disconnect all servers and clean up.
   */
  async stop(): Promise<void> {
    const closers: Promise<void>[] = []
    for (const [name, entry] of this.servers) {
      if (entry.client) {
        closers.push(
          entry.client.close().catch((err) => {
            log.warn({ err, server: name }, 'error closing MCP client')
          }),
        )
      }
    }
    await Promise.allSettled(closers)
    this.servers.clear()
    this.started = false
    log.info('McpHost stopped')
  }

  /**
   * List all tools across all healthy servers, namespaced.
   */
  listTools(): NamespacedToolEntry[] {
    const tools: NamespacedToolEntry[] = []
    for (const entry of this.servers.values()) {
      if (!entry.healthy) continue
      for (const toolEntry of entry.tools.values()) {
        tools.push(toolEntry)
      }
    }
    return tools
  }

  /**
   * Get tools as a Record<string, Tool> for ToolSource compatibility.
   */
  getToolRecord(): Record<string, Tool> {
    const out: Record<string, Tool> = {}
    for (const entry of this.listTools()) {
      out[entry.namespacedName] = entry.tool
    }
    return out
  }

  /**
   * Call a namespaced tool on the appropriate server.
   * Tool name format: `${serverName}_${toolName}`
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | Record<string, unknown>> {
    const underscoreIdx = name.indexOf('_')
    if (underscoreIdx === -1) {
      throw new Error(`tool name "${name}" missing server prefix (expected "server_tool")`)
    }

    const serverName = name.slice(0, underscoreIdx)
    const toolName = name.slice(underscoreIdx + 1)

    const entry = this.servers.get(serverName)
    if (!entry) {
      throw new Error(`unknown MCP server "${serverName}"`)
    }
    if (!entry.healthy || !entry.client) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }

    const namespacedName = namespaceToolName(serverName, toolName)
    const toolEntry = entry.tools.get(namespacedName)
    if (!toolEntry) {
      throw new Error(`tool "${namespacedName}" not found on server "${serverName}"`)
    }

    // AI SDK tool execution — call the tool's execute function
    if (toolEntry.tool.execute) {
      const result = await toolEntry.tool.execute(args, {
        toolCallId: `${serverName}-${toolName}-${Date.now()}`,
        messages: [],
      })
      return flattenToolResult(result)
    }

    throw new Error(`tool "${namespacedName}" has no execute function`)
  }

  /**
   * Check if a specific server is healthy.
   */
  isServerHealthy(name: string): boolean {
    return this.servers.get(name)?.healthy ?? false
  }

  /**
   * Get health status of all servers.
   */
  getServerHealth(): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const [name, entry] of this.servers) {
      out[name] = entry.healthy
    }
    return out
  }

  // --- internal ---

  private async connectServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    const { config } = entry
    log.info({ server: name, transport: config.transport }, 'connecting to MCP server')

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const transport = buildTransport(config)
        const client = await createMCPClient({
          transport: transport as MCPTransport | HttpTransportConfig,
          name: `talos-${config.name}`,
          onUncaughtError: (err) => {
            log.error({ err, server: name }, 'uncaught MCP error')
          },
        })

        // Fetch tools and namespace them
        const mcpTools = await client.tools()
        const toolMap = new Map<string, NamespacedToolEntry>()

        for (const [originalName, tool] of Object.entries(mcpTools)) {
          const namespaced = namespaceToolName(config.name, originalName)
          const annotations = parseToolAnnotations(tool as Record<string, unknown>)

          toolMap.set(namespaced, {
            namespacedName: namespaced,
            originalName,
            serverName: config.name,
            annotations,
            tool: tool as Tool,
          })
        }

        entry.client = client
        entry.tools = toolMap
        entry.healthy = true
        entry.retries = 0

        log.info({ server: name, tools: toolMap.size }, 'MCP server connected')
        return
      } catch (err) {
        entry.retries = attempt + 1

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * 2 ** attempt
          log.warn(
            { err, server: name, attempt: attempt + 1, retryInMs: delay },
            'MCP server connection failed, retrying',
          )
          await new Promise((r) => setTimeout(r, delay))
        } else {
          entry.healthy = false
          log.error(
            { err, server: name, retries: MAX_RETRIES },
            'MCP server connection failed after retries',
          )
          throw err
        }
      }
    }
  }
}
