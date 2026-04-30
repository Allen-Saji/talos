import type { Tool } from 'ai'
import type { ToolAnnotations } from '@/mcp-host/registry'
import { appendToolCallAudit, type Db, type ToolAuditMeta } from '@/persistence/queries'
import type { RunContext, ToolMiddleware } from '@/runtime/types'
import { child } from '@/shared/logger'
import type { ContractCallInput, KeeperHubClient } from './client'

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

export type RunContextProvider = () => RunContext | null

export type AnnotationLookup = (toolName: string) => ToolAnnotations | undefined

/**
 * Maps a mutate tool's incoming args to a KeeperHub contract-call payload.
 * Implementations live with each protocol tool (e.g. `aave_supply` provides
 * its own route that builds the `Pool.supply` call). Returning the payload
 * is the only contract — when no route is registered for a mutate tool, the
 * middleware falls through to the original `execute`.
 */
export type MutateRoute = (args: unknown) => ContractCallInput

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
  /**
   * KeeperHub workflow routing for mutate tools. When provided AND the tool's
   * audit decision is `annotation_mutates` AND a route is registered for the
   * tool's name, the wrapper calls `kh.client.executeContractCall(route(args))`
   * INSTEAD of the original `execute`. The tool's return becomes the
   * `ExecutionResult` shape; audit row gains `executionId` and `txHash`.
   *
   * Mutate tools without a registered route fall through to the original
   * `execute` (audit row still records `shouldAudit: true, reason:
   * 'annotation_mutates'`). Routes are added per protocol as their tools land
   * (custom Aave PR-5, Uniswap V3 PR-6, etc.).
   */
  kh?: {
    client: KeeperHubClient
    routes: ReadonlyMap<string, MutateRoute>
  }
}

/**
 * Build an audit-by-default middleware that wraps each tool's `execute`,
 * applies `shouldAudit`, runs the original tool (or routes through KeeperHub
 * when a mutate route is configured), and persists a tool-call row with
 * structured audit metadata.
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
  // Route this tool through KeeperHub only when (a) it's annotated mutates AND
  // (b) a route is registered. Mutate tools without a route still audit but
  // call the original execute.
  const route =
    deps.kh && decision.reason === 'annotation_mutates' ? deps.kh.routes.get(name) : undefined
  const khClient = route ? deps.kh?.client : undefined

  const originalExecute = original.execute
  if (!originalExecute) return original

  const wrappedTool: Tool = {
    ...original,
    execute: async (args, ctx) => {
      const startedAt = new Date()
      const runCtx = deps.runContext()
      let result: unknown
      let error: string | undefined
      let executionId: string | undefined
      let txHash: string | undefined
      try {
        if (route && khClient) {
          const callInput = route(args)
          const exec = await khClient.executeContractCall(callInput)
          executionId = exec.executionId
          if (exec.txHash) txHash = exec.txHash
          if (exec.status === 'failed' || exec.error) {
            const msg = exec.error ?? 'KeeperHub execution failed'
            throw new Error(msg)
          }
          result = exec
          return result
        }
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
          ...(executionId ? { executionId } : {}),
          ...(txHash ? { txHash } : {}),
          details: {
            elapsedMs: finishedAt.getTime() - startedAt.getTime(),
            ...(route ? { routedThrough: 'keeperhub' as const } : {}),
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
