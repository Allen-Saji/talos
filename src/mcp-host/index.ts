import type { Tool } from 'ai'
import type { ToolSource } from '@/runtime/types'
import type { McpHost } from './host'
import type { ToolAnnotations } from './registry'

export { defaultMcpServers } from './defaults'
export { McpHost } from './host'
export type { NamespacedToolEntry, ToolAnnotations } from './registry'
export { flattenToolResult, namespaceToolName, parseToolAnnotations } from './registry'
export { buildTransport } from './transports'

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** Extra headers for HTTP transport (e.g. `Authorization: Bearer ...`). */
  headers?: Record<string, string>
  /**
   * Per-tool annotation overrides applied at registration time. Lets us correct
   * audit-routing for third-party servers that don't ship MCP-level annotations
   * (e.g. mark `resolve_ens_name` as `readOnly: true` so the KeeperHub
   * middleware bypasses workflow audit). Keyed by the tool's *original* name
   * (pre-namespacing). Merged shallow over the parsed annotations.
   */
  staticAnnotations?: Record<string, Partial<ToolAnnotations>>
}

/**
 * ToolSource backed by an McpHost. Drops into RuntimeDeps.toolSources.
 */
export class McpToolSource implements ToolSource {
  constructor(private readonly host: McpHost) {}

  async getTools(): Promise<Record<string, Tool>> {
    return this.host.getToolRecord()
  }
}
