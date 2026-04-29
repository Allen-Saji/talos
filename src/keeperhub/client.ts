import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp'
import type { Tool } from 'ai'
import { flattenToolResult } from '@/mcp-host/registry'
import { TalosAuthError } from '@/shared/errors'
import { child } from '@/shared/logger'
import {
  type AuthServerMetadata,
  discoverAuthServer,
  refreshToken as refreshTokenRpc,
} from './oauth'
import { EXPIRY_BUFFER_MS, isExpired, loadSession, saveSession, sessionFromResponse } from './token'

const log = child({ module: 'keeperhub' })
const DEFAULT_KEEPERHUB_MCP_URL = 'https://app.keeperhub.com/mcp'

export type KeeperHubClientOpts = {
  /** Path to the persisted session file. */
  tokenPath: string
  /** Override for tests / self-hosted deployments. Default `https://app.keeperhub.com/mcp`. */
  mcpUrl?: string
  /** Override for tests. Default global `fetch`. */
  fetch?: typeof fetch
  /** Override for tests; if set, used instead of fetching `.well-known/oauth-authorization-server`. */
  authServerMetadata?: AuthServerMetadata
}

/** Direct on-chain action — used by #10's protocol-tool wiring. */
export type ContractCallInput = {
  network: string
  contract_address: string
  function_name: string
  function_args?: unknown[]
  abi?: unknown
}

export type TransferInput = {
  network: string
  recipient_address: string
  amount: string
  token_address?: string
}

export type WorkflowExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

export type ExecutionResult = {
  executionId: string
  status: WorkflowExecutionStatus
  txHash?: string
  output?: unknown
  error?: string
}

export interface KeeperHubClient {
  /** Resolve a valid bearer token; refreshes if expired. */
  ensureToken(): Promise<string>
  /** List available KeeperHub tools (proxied through `@ai-sdk/mcp`). */
  listTools(): Promise<Record<string, Tool>>
  /** Call a KeeperHub MCP tool by name. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Execute a contract call directly (no workflow envelope). */
  executeContractCall(input: ContractCallInput): Promise<ExecutionResult>
  /** Execute a token / native transfer directly. */
  executeTransfer(input: TransferInput): Promise<ExecutionResult>
  /** Poll execution status; returns the latest snapshot. */
  getExecutionStatus(executionId: string): Promise<ExecutionResult>
  /** Disconnect the underlying MCP client. */
  close(): Promise<void>
}

/**
 * Build a KeeperHub MCP client that auto-refreshes the access token and
 * exposes typed methods for the few MCP tools the audit middleware needs.
 *
 * NOTE: this DOES NOT perform first-time browser auth — that flow lives
 * in the `talos init` wizard (#14). If no session is on disk, every method
 * throws `TalosAuthError`. Callers must run init first.
 */
export async function createKeeperHubClient(opts: KeeperHubClientOpts): Promise<KeeperHubClient> {
  const fetchImpl = opts.fetch ?? fetch
  const mcpUrl = opts.mcpUrl ?? DEFAULT_KEEPERHUB_MCP_URL

  let session = await loadSession(opts.tokenPath)
  if (!session) {
    throw new TalosAuthError(`no KeeperHub session at ${opts.tokenPath} — run \`talos init\` first`)
  }

  let metadata: AuthServerMetadata | null = opts.authServerMetadata ?? null
  let mcp: MCPClient | null = null
  let mcpToken: string | null = null

  async function authMetadata(): Promise<AuthServerMetadata> {
    if (metadata) return metadata
    metadata = await discoverAuthServer({ fetch: fetchImpl })
    return metadata
  }

  async function ensureToken(): Promise<string> {
    if (!session) throw new TalosAuthError('KeeperHub session missing')
    if (!isExpired(session)) return session.accessToken
    if (!session.refreshToken) {
      throw new TalosAuthError(
        'KeeperHub access token expired and no refresh_token present — re-run `talos init`',
      )
    }
    const meta = await authMetadata()
    log.info({ msUntilExpiry: session.expiresAt - Date.now() }, 'refreshing KeeperHub token')
    const tokenRes = await refreshTokenRpc({
      fetch: fetchImpl,
      meta,
      clientId: session.client.client_id,
      ...(session.client.client_secret !== undefined
        ? { clientSecret: session.client.client_secret }
        : {}),
      refreshToken: session.refreshToken,
    })
    session = sessionFromResponse(session.client, tokenRes)
    await saveSession(opts.tokenPath, session)
    return session.accessToken
  }

  async function ensureMcp(): Promise<MCPClient> {
    const token = await ensureToken()
    if (mcp && mcpToken === token) return mcp
    if (mcp) await mcp.close().catch(() => undefined)
    mcpToken = token
    mcp = await createMCPClient({
      transport: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as MCPTransport,
      name: 'talos-keeperhub',
      onUncaughtError: (err) => log.error({ err }, 'KeeperHub MCP uncaught error'),
    })
    return mcp
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await ensureMcp()
    const tools = await client.tools()
    const tool = tools[name]
    if (!tool?.execute) {
      throw new Error(`KeeperHub tool "${name}" unavailable or has no execute`)
    }
    const raw = await tool.execute(args, {
      toolCallId: `keeperhub-${name}-${Date.now()}`,
      messages: [],
    })
    return flattenToolResult(raw)
  }

  function asExecutionResult(raw: unknown): ExecutionResult {
    if (typeof raw !== 'object' || raw === null) {
      return { executionId: '', status: 'pending', output: raw }
    }
    const r = raw as Record<string, unknown>
    const executionId =
      typeof r.execution_id === 'string'
        ? r.execution_id
        : typeof r.executionId === 'string'
          ? r.executionId
          : ''
    const statusRaw = (r.status ?? r.state) as string | undefined
    const status = (
      ['pending', 'running', 'success', 'failed', 'cancelled'].includes(statusRaw ?? '')
        ? statusRaw
        : 'pending'
    ) as WorkflowExecutionStatus
    const txHash =
      typeof r.tx_hash === 'string'
        ? r.tx_hash
        : typeof r.txHash === 'string'
          ? r.txHash
          : undefined
    const error = typeof r.error === 'string' ? r.error : undefined
    return {
      executionId,
      status,
      ...(txHash !== undefined ? { txHash } : {}),
      ...(error !== undefined ? { error } : {}),
      output: r,
    }
  }

  return {
    ensureToken,
    async listTools(): Promise<Record<string, Tool>> {
      const client = await ensureMcp()
      return (await client.tools()) as Record<string, Tool>
    },
    callTool,
    async executeContractCall(input) {
      return asExecutionResult(await callTool('execute_contract_call', input))
    },
    async executeTransfer(input) {
      return asExecutionResult(await callTool('execute_transfer', input))
    },
    async getExecutionStatus(executionId) {
      return asExecutionResult(
        await callTool('get_direct_execution_status', { execution_id: executionId }),
      )
    },
    async close() {
      if (mcp) {
        await mcp.close().catch(() => undefined)
        mcp = null
        mcpToken = null
      }
    },
  }
}

/** Re-exported for tests + future callers. */
export { EXPIRY_BUFFER_MS }
