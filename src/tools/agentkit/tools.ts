import { jsonSchema, type Tool, tool } from 'ai'
import { zodToJsonSchema as zodToJsonSchemaLib } from 'zod-to-json-schema'
import { namespaceToolName, type ToolAnnotations } from '@/mcp-host'
import { getAgentKit } from './client'

/**
 * Convert AgentKit's action surface into Talos-shaped (`agentkit_*`) tools with
 * audit-routing annotations.
 *
 * We bypass `@coinbase/agentkit-vercel-ai-sdk` (it produces schemas missing
 * `type: "object"` under ai-sdk v6, which OpenAI rejects). Instead we walk
 * `agentKit.getActions()` directly and build tools using ai-v6's
 * `tool({ inputSchema, execute })` shape.
 *
 * Action names from AgentKit are class-prefixed (`PythActionProvider_fetch_price`,
 * `CompoundActionProvider_supply`). We normalize to a friendlier form by
 * stripping `ActionProvider_` and lowercasing the provider segment, then
 * namespace with the `agentkit_` prefix:
 *   PythActionProvider_fetch_price → agentkit_pyth_fetch_price
 *
 * Annotation classification: AgentKit doesn't expose a write/read flag, so we
 * pattern-match the normalized name with `READ_PATTERNS`. Misses default to
 * `mutates: true` (audit-by-default — consistent with KeeperHub middleware).
 */

/**
 * Tool-name regexes that mark an AgentKit tool as a pure read.
 * Match against the post-normalization name (e.g. `pyth_fetch_price`).
 */
export const READ_PATTERNS: readonly RegExp[] = [
  /^pyth_/, // entire pyth surface is reads
  /^zerion_/, // wallet portfolio queries — reads
  /_get_/, // pattern matches across providers
  /_search/,
  /_quote/,
  /_resolve/, // basename_resolve_basename (read)
  /_lookup/,
  /_balance/,
  /_position/,
  /_status/,
  /_list/, // opensea_list_nfts (depends — list queries are reads)
  /_estimate/,
  /_check_/,
  /_fetch_/,
] as const

export function classifyAnnotations(originalName: string): ToolAnnotations {
  const isRead = READ_PATTERNS.some((rx) => rx.test(originalName))
  return {
    mutates: !isRead,
    readOnly: isRead,
    destructive: false,
  }
}

/**
 * `PythActionProvider_fetch_price` → `pyth_fetch_price`.
 *
 * AgentKit registers actions with PascalCase class-name prefixes; we strip
 * them so READ_PATTERNS (and the test fixtures) work against simple
 * snake_case names.
 */
function normalizeActionName(rawName: string): string {
  // Match `<PascalCase>ActionProvider_<rest>` and lowercase the prefix.
  const m = rawName.match(/^([A-Za-z]+)ActionProvider_(.+)$/)
  if (m?.[1] && m[2]) {
    return `${m[1].toLowerCase()}_${m[2]}`
  }
  return rawName
}

/**
 * Load actions from AgentKit, normalize + namespace under `agentkit_*`, and
 * pair each with annotations. Returns the shape NativeToolSource expects.
 */
export async function agentKitTools(): Promise<{
  tools: Record<string, Tool>
  annotations: Record<string, ToolAnnotations>
}> {
  const agentKit = await getAgentKit()
  const actions = agentKit.getActions()

  const tools: Record<string, Tool> = {}
  const annotations: Record<string, ToolAnnotations> = {}

  for (const action of actions) {
    const friendly = normalizeActionName(action.name)
    const namespaced = namespaceToolName('agentkit', friendly)

    tools[namespaced] = tool({
      description: action.description,
      inputSchema: jsonSchema(toJsonSchema(action.schema)),
      execute: async (args: unknown) => {
        return action.invoke(args)
      },
    })
    annotations[namespaced] = classifyAnnotations(friendly)
  }

  return { tools, annotations }
}

/**
 * Convert AgentKit's Zod-3 schema to a plain JSON Schema, ensuring the root
 * carries `type: "object"`. OpenAI's tool-schema validator rejects schemas
 * without an explicit object type — the upstream Vercel AI SDK adapter drops
 * it for empty schemas (e.g. Pyth's `fetch_price_feed`), so we patch it here.
 *
 * `schema: unknown` because AgentKit ships Zod 3 while the project resolves
 * Zod 4; the structural shape that `zod-to-json-schema` walks works for both.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: cross-zod-version structural compat
  const raw = zodToJsonSchemaLib(schema as any, { target: 'openApi3' }) as Record<string, unknown>
  if (!raw.type) raw.type = 'object'
  if (!raw.properties) raw.properties = {}
  return raw
}
