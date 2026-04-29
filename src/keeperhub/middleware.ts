import type { Tool } from 'ai'
import type { ToolAnnotations } from '@/mcp-host/registry'
import { appendToolCallAudit, type Db, type ToolAuditMeta } from '@/persistence/queries'
import { child } from '@/shared/logger'

const log = child({ module: 'keeperhub-middleware' })

/**
 * Regex allowlist for tools that bypass KeeperHub workflow routing.
 * Sourced from `docs/spec.md` F5.11 + extended for known read-only patterns
 * surfaced by Blockscout / quote / balance / position queries.
 */
export const KNOWN_READONLY: readonly RegExp[] = [
  /_get_/,
  /_quote$/,
  /_status$/,
  /_balance$/,
  /_position$/,
  /_search/,
  /^blockscout_/,
] as const

export type ShouldAuditDecision = {
  shouldAudit: boolean
  reason: 'KNOWN_READONLY' | 'annotation_readOnly' | 'annotation_mutates' | 'audit_default'
}

/**
 * Audit-by-default policy.
 * 1. Tool name matches `KNOWN_READONLY` regex → bypass.
 * 2. Tool's MCP annotation `readOnly === true` → bypass.
 * 3. Tool's MCP annotation `mutates === true` → audit (explicit).
 * 4. Otherwise → audit (default; the audit-by-default decision).
 */
export function shouldAudit(toolName: string, annotations?: ToolAnnotations): ShouldAuditDecision {
  if (KNOWN_READONLY.some((re) => re.test(toolName))) {
    return { shouldAudit: false, reason: 'KNOWN_READONLY' }
  }
  if (annotations?.readOnly === true) {
    return { shouldAudit: false, reason: 'annotation_readOnly' }
  }
  if (annotations?.mutates === true) {
    return { shouldAudit: true, reason: 'annotation_mutates' }
  }
  return { shouldAudit: true, reason: 'audit_default' }
}

/** Per-call run context that the runtime threads in (one per agent run). */
export type RunContext = {
  runId: string
  stepId?: string | null
}

export type RunContextProvider = () => RunContext | null

export type AnnotationLookup = (toolName: string) => ToolAnnotations | undefined

export type KeeperHubMiddlewareDeps = {
  db: Db
  /**
   * Returns the current run context, or `null` if no run is active.
   * The runtime (#7 / #10 follow-up) sets and clears this around `streamText`.
   * Without a run context, the middleware logs decisions to pino and skips
   * the DB write — useful for ad-hoc tool calls outside the agent loop.
   */
  runContext: RunContextProvider
  /**
   * Optional lookup for MCP-side tool annotations. The runtime gets only
   * `Record<string, Tool>` from the AI SDK, which has no annotations field —
   * this getter lets the middleware consult `McpHost.listTools()` per tool name.
   * Returns `undefined` for tools that have no annotations (defaults apply).
   */
  annotations?: AnnotationLookup
}

export type ToolMiddleware = (tools: Record<string, Tool>) => Record<string, Tool>

/**
 * Build an audit-by-default middleware that wraps each tool's `execute`,
 * applies `shouldAudit`, runs the original tool, and persists a tool-call
 * row with structured audit metadata.
 *
 * For #8 the middleware always passes through to the original tool (no
 * workflow envelope). #10 will plug in `KeeperHubClient.executeContractCall`
 * for tools whose decision is `shouldAudit=true`.
 */
export function createKeeperHubMiddleware(deps: KeeperHubMiddlewareDeps): ToolMiddleware {
  return (tools) => {
    const wrapped: Record<string, Tool> = {}
    for (const [name, tool] of Object.entries(tools)) {
      wrapped[name] = wrapTool(name, tool, deps)
    }
    return wrapped
  }
}

function wrapTool(name: string, original: Tool, deps: KeeperHubMiddlewareDeps): Tool {
  const annotations = deps.annotations?.(name)
  const decision = shouldAudit(name, annotations)

  const originalExecute = original.execute
  if (!originalExecute) return original

  const wrappedTool: Tool = {
    ...original,
    execute: async (args, ctx) => {
      const startedAt = new Date()
      const runCtx = deps.runContext()
      let result: unknown
      let error: string | undefined
      try {
        result = await originalExecute(args, ctx)
        return result
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        const finishedAt = new Date()
        const auditMeta: ToolAuditMeta = {
          shouldAudit: decision.shouldAudit,
          reason: decision.reason,
          details: {
            elapsedMs: finishedAt.getTime() - startedAt.getTime(),
          },
        }
        if (runCtx) {
          try {
            await appendToolCallAudit(deps.db, {
              runId: runCtx.runId,
              stepId: runCtx.stepId ?? null,
              toolCallId: ctx.toolCallId,
              toolName: name,
              args: args as unknown,
              ...(result !== undefined ? { result } : {}),
              ...(error !== undefined ? { error } : {}),
              audit: auditMeta,
              startedAt,
              finishedAt,
            })
          } catch (writeErr) {
            log.warn({ err: writeErr, toolName: name }, 'failed to write tool-call audit row')
          }
        } else {
          log.info(
            { toolName: name, decision, toolCallId: ctx.toolCallId, error },
            'tool audit (no run context)',
          )
        }
      }
    },
  }
  return wrappedTool
}
