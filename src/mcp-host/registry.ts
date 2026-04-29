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
 * Flatten MCP tool result to a single string or parsed JSON.
 *
 * MCP returns: { content: [{ type: 'text', text: '{"foo":1}' }] }
 * This function flattens to:
 *   - single text item → string
 *   - single text item that's valid JSON → parsed object
 *   - multiple text items → joined with \n\n
 *   - error → wrapped in <error> tag
 */
export function flattenToolResult(result: unknown): string | Record<string, unknown> {
  if (result == null) return ''

  // If it's already a string, return as-is
  if (typeof result === 'string') return result

  // If it's not an object, stringify
  if (typeof result !== 'object') return String(result)

  const obj = result as Record<string, unknown>

  // Handle MCP content array
  if (Array.isArray(obj.content)) {
    const items = obj.content as Array<{ type: string; text?: string; isError?: boolean }>

    if (items.length === 0) return ''

    // Check for error
    if (items.some((i) => i.isError)) {
      const errorTexts = items
        .filter((i) => i.type === 'text')
        .map((i) => i.text ?? '')
        .join('\n')
      return `<error>${errorTexts}</error>`
    }

    // Single text item — try JSON parse
    const first = items[0]
    if (items.length === 1 && first?.type === 'text' && first.text) {
      const text = first.text
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return text
      }
    }

    // Multiple text items — join
    const texts = items
      .filter((i) => i.type === 'text')
      .map((i) => i.text ?? '')
      .join('\n\n')

    // Try JSON parse on joined text
    try {
      return JSON.parse(texts) as Record<string, unknown>
    } catch {
      return texts
    }
  }

  // Not MCP format — return as-is (might already be flat)
  return obj as unknown as Record<string, unknown>
}
