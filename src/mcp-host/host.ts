import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp'
import type { ModelMessage, Tool } from 'ai'
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
  lastError?: string
}

/** Health snapshot exposed via getServerHealth() */
export type ServerHealth = {
  healthy: boolean
  retries: number
  lastError?: string
}

/** Options for `callTool` ad-hoc invocations. */
export type CallToolOptions = {
  /** Conversation context for tools that need it. Defaults to []. */
  messages?: ModelMessage[]
  /** Override the host-level default timeout. */
  timeoutMs?: number
}

export type McpHostOptions = {
  /** Per tool-call timeout in ms. Default 30000. */
  toolCallTimeoutMs?: number
  /** Total connect attempts (1 initial + N-1 retries). Default 3. */
  maxAttempts?: number
  /** Base backoff between attempts; doubles each retry. Default 1000. */
  baseDelayMs?: number
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1000

/**
 * McpHost — manages connections to N MCP servers and exposes their tools
 * under a single namespaced registry.
 */
export class McpHost {
  private servers = new Map<string, ServerEntry>()
  /** Reverse lookup: namespaced tool name → owning server entry. */
  private toolIndex = new Map<string, ServerEntry>()
  private started = false
  private readonly toolCallTimeoutMs: number
  private readonly maxAttempts: number
  private readonly baseDelayMs: number

  constructor(opts: McpHostOptions = {}) {
    this.toolCallTimeoutMs = opts.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  }

  /**
   * Connect to all configured servers. Retries with exponential backoff
   * on failure. Throws only if every server fails; otherwise unhealthy
   * servers are reported via `getServerHealth()`.
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
    this.toolIndex.clear()
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
   * Ad-hoc tool invocation by namespaced name. Looks up via the host's
   * tool index, so server names containing underscores work correctly.
   *
   * NOTE: the runtime should obtain tools via `getToolRecord()` and let
   * `streamText` invoke them with full conversation context. Use this
   * method only for ad-hoc / admin invocations. Tools that depend on
   * conversation context will receive whatever is passed via
   * `opts.messages` (default `[]`).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: CallToolOptions = {},
  ): Promise<string | Record<string, unknown>> {
    const owner = this.toolIndex.get(name)
    if (!owner) {
      throw new Error(`tool "${name}" not found in any connected server`)
    }
    if (!owner.healthy || !owner.client) {
      throw new Error(`MCP server "${owner.config.name}" is not connected`)
    }

    const toolEntry = owner.tools.get(name)
    if (!toolEntry) {
      throw new Error(`tool "${name}" missing from server "${owner.config.name}" registry`)
    }
    if (!toolEntry.tool.execute) {
      throw new Error(`tool "${name}" has no execute function`)
    }

    const timeoutMs = opts.timeoutMs ?? this.toolCallTimeoutMs
    const messages = opts.messages ?? []

    const result = await this.withTimeout(
      toolEntry.tool.execute(args, {
        toolCallId: `${owner.config.name}-${toolEntry.originalName}-${Date.now()}`,
        messages,
      }),
      timeoutMs,
      `tool "${name}"`,
    )
    return flattenToolResult(result)
  }

  /**
   * Check if a specific server is healthy.
   */
  isServerHealthy(name: string): boolean {
    return this.servers.get(name)?.healthy ?? false
  }

  /**
   * Get health status of all servers, including retry counts and last error.
   */
  getServerHealth(): Record<string, ServerHealth> {
    const out: Record<string, ServerHealth> = {}
    for (const [name, entry] of this.servers) {
      out[name] = {
        healthy: entry.healthy,
        retries: entry.retries,
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      }
    }
    return out
  }

  // --- internal ---

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private markUnhealthy(name: string, reason: string): void {
    const entry = this.servers.get(name)
    if (!entry) return
    entry.healthy = false
    entry.lastError = reason
  }

  private async connectServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    const { config } = entry
    log.info({ server: name, transport: config.transport }, 'connecting to MCP server')

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const transport = buildTransport(config)
        const client = await createMCPClient({
          transport: transport as MCPTransport | HttpTransportConfig,
          name: `talos-${config.name}`,
          onUncaughtError: (err) => {
            // Some stdio MCP servers (e.g. mcpdotdirect/evm-mcp-server) print
            // a startup banner to stdout before their first JSON-RPC frame.
            // The transport JSON.parses every line and throws SyntaxError on
            // the banner. The actual connection completes a beat later, so
            // these are benign — log at debug, don't mark unhealthy.
            if (err instanceof SyntaxError && /Unexpected token/.test(err.message)) {
              log.debug(
                { err, server: name },
                'MCP stdio non-JSON line ignored (likely a startup banner)',
              )
              return
            }
            log.error({ err, server: name }, 'uncaught MCP error — marking unhealthy')
            this.markUnhealthy(name, err instanceof Error ? err.message : String(err))
          },
        })

        const mcpTools = await client.tools()
        const toolMap = new Map<string, NamespacedToolEntry>()

        for (const [originalName, tool] of Object.entries(mcpTools)) {
          const namespaced = namespaceToolName(config.name, originalName)
          const baseAnnotations = parseToolAnnotations(tool as Record<string, unknown>)
          const overrides = config.staticAnnotations?.[originalName]
          const annotations = overrides ? { ...baseAnnotations, ...overrides } : baseAnnotations

          const namespacedEntry: NamespacedToolEntry = {
            namespacedName: namespaced,
            originalName,
            serverName: config.name,
            annotations,
            tool: tool as Tool,
          }
          toolMap.set(namespaced, namespacedEntry)
          this.toolIndex.set(namespaced, entry)
        }

        entry.client = client
        entry.tools = toolMap
        entry.healthy = true
        entry.retries = 0
        entry.lastError = undefined

        log.info({ server: name, tools: toolMap.size }, 'MCP server connected')
        return
      } catch (err) {
        entry.retries = attempt
        entry.lastError = err instanceof Error ? err.message : String(err)

        if (attempt < this.maxAttempts) {
          const delay = this.baseDelayMs * 2 ** (attempt - 1)
          log.warn(
            { err, server: name, attempt, retryInMs: delay },
            'MCP server connection failed, retrying',
          )
          await new Promise((r) => setTimeout(r, delay))
        } else {
          entry.healthy = false
          log.error(
            { err, server: name, attempts: this.maxAttempts },
            'MCP server connection failed after all attempts',
          )
          throw err
        }
      }
    }
  }
}
