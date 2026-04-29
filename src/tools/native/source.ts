import type { Tool } from 'ai'
import type { ToolAnnotations } from '@/mcp-host'
import type { ToolSource } from '@/runtime/types'

/**
 * Tool source for in-process tools that Talos owns end-to-end (e.g. Li.Fi
 * wrappers, custom Aave/Uniswap tools). Sits alongside `McpToolSource` in the
 * runtime's tool sources list.
 *
 * Unlike third-party MCP servers, native tools declare their annotations
 * directly — no parsing, no overrides. Callers expose `annotations(name)` so
 * the KeeperHub middleware can consult both this source and the MCP host
 * when deciding audit routing.
 *
 * Tool names are pre-namespaced by the source itself (e.g. `lifi_get_quote`)
 * so callers don't need a separate prefix configuration. Keep names matching
 * `[a-zA-Z0-9_]{1,64}` per the host convention.
 */
export class NativeToolSource implements ToolSource {
  private readonly tools: Record<string, Tool>
  private readonly annotationsByName: Record<string, ToolAnnotations>
  readonly name: string

  constructor(opts: {
    /** Source identifier — used in logs only. */
    name: string
    /** Pre-namespaced tools (e.g. `lifi_get_quote`). */
    tools: Record<string, Tool>
    /** Per-tool annotations, keyed by namespaced name. */
    annotations: Record<string, ToolAnnotations>
  }) {
    this.name = opts.name
    this.tools = opts.tools
    this.annotationsByName = opts.annotations
  }

  async getTools(): Promise<Record<string, Tool>> {
    return this.tools
  }

  /** Returns annotations for a namespaced tool name, or undefined if unknown. */
  annotations(name: string): ToolAnnotations | undefined {
    return this.annotationsByName[name]
  }

  /** All namespaced names this source contributes. */
  toolNames(): string[] {
    return Object.keys(this.tools)
  }
}
