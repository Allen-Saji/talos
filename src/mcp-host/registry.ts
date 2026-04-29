import type { Tool } from 'ai'

/**
 * Tool annotations as surfaced by MCP servers.
 * Used by KeeperHub middleware (#8) to decide audit routing.
 */
export type ToolAnnotations = {
  mutates?: boolean
  readOnly?: boolean
  destructive?: boolean
}

/**
 * Metadata for a namespaced MCP tool. Wraps the original AI SDK Tool
 * with server provenance and annotations.
 */
export type NamespacedToolEntry = {
  /** Namespaced tool name: `${serverName}_${toolName}` */
  namespacedName: string
  /** Original tool name from MCP server */
  originalName: string
  /** Server that provides this tool */
  serverName: string
  /** Tool annotations from MCP server */
  annotations: ToolAnnotations
  /** The AI SDK Tool object */
  tool: Tool
}

/**
 * Namespace a tool name: `${serverName}_${toolName}`.
 * Underscores only, regex [a-zA-Z0-9_]{1,64} per spec.
 */
export function namespaceToolName(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`
}

/**
 * Parse tool annotations from MCP tool metadata.
 * MCP returns annotations as extra fields on the tool definition.
 */
export function parseToolAnnotations(tool: Record<string, unknown>): ToolAnnotations {
  const annotations = (tool.annotations ?? {}) as Record<string, unknown>
  return {
    mutates: Boolean(annotations.mutates ?? annotations.openWorldHint),
    readOnly: Boolean(annotations.readOnlyHint ?? annotations.readOnly),
    destructive: Boolean(annotations.destructiveHint ?? annotations.destructive),
  }
}

/**
 * Flatten MCP tool result to a single string or parsed JSON object.
 *
 * MCP returns: { content: [{ type: 'text', text: '{"foo":1}' }] }
 * This function flattens to:
 *   - single text item that looks like a JSON object (`{...}`) → parsed object
 *   - single text item otherwise → string
 *   - multiple text items → joined with \n\n (object-parse on the join only if it starts with `{`)
 *   - error → wrapped in <error> tag
 *
 * JSON parsing is gated on `text.trim().startsWith('{')` so the return type
 * stays honest: `string | Record<string, unknown>`. Scalars like `"42"` /
 * `"true"` and arrays like `"[1,2]"` pass through as text — callers that need
 * those should JSON.parse themselves.
 */
export function flattenToolResult(result: unknown): string | Record<string, unknown> {
  if (result == null) return ''

  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)

  const obj = result as Record<string, unknown>

  if (Array.isArray(obj.content)) {
    const items = obj.content as Array<{ type: string; text?: string; isError?: boolean }>

    if (items.length === 0) return ''

    if (items.some((i) => i.isError)) {
      const errorTexts = items
        .filter((i) => i.type === 'text')
        .map((i) => i.text ?? '')
        .join('\n')
      return `<error>${errorTexts}</error>`
    }

    const texts = items.filter((i) => i.type === 'text').map((i) => i.text ?? '')

    if (texts.length === 1) {
      const text = texts[0] ?? ''
      return tryParseJsonObject(text) ?? text
    }

    const joined = texts.join('\n\n')
    return tryParseJsonObject(joined) ?? joined
  }

  return obj as unknown as Record<string, unknown>
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
