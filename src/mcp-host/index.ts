import type { Tool } from 'ai'
import type { ToolSource } from '@/runtime/types'
import type { McpHost } from './host'

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
