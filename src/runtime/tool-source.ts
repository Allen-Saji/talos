import type { Tool } from 'ai'
import type { ToolSource } from './types'

/** No-op tool source. Default when no MCP servers are configured. Use McpToolSource from @/mcp-host for real tools. */
export const EmptyToolSource: ToolSource = {
  getTools: async () => ({}),
}

/**
 * Merge tools from multiple sources. Later sources win on name collision —
 * keep the merge order deterministic so the audit log can reason about
 * which source provided a given tool.
 */
export async function mergeToolSources(
  sources: readonly ToolSource[],
): Promise<Record<string, Tool>> {
  const out: Record<string, Tool> = {}
  for (const src of sources) {
    const tools = await src.getTools()
    for (const [name, tool] of Object.entries(tools)) {
      out[name] = tool
    }
  }
  return out
}
