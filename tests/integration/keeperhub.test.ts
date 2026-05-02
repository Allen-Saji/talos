import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuthServerMetadata,
  buildAuthorizeUrl,
  type ContractCallInput,
  clearSession,
  createKeeperHubClient,
  createKeeperHubMiddleware,
  discoverAuthServer,
  type ExecutionResult,
  exchangeCode,
  generatePkce,
  generateState,
  isExpired,
  type KeeperHubClient,
  KNOWN_READONLY,
  loadSession,
  type MutateRoute,
  type RegisteredClient,
  refreshToken,
  registerClient,
  type StoredSession,
  saveSession,
  sessionFromResponse,
  shouldAudit,
  type TokenResponse,
} from '@/keeperhub'
import { createDb, type DbHandle, openRun, runMigrations, upsertThread } from '@/persistence'

// ---------------------------------------------------------------------------
// Mocks for @ai-sdk/mcp (only exercised by client.ts tests)
// ---------------------------------------------------------------------------

const { mockCreateMCPClient } = vi.hoisted(() => {
  const mockCreateMCPClient = vi.fn()
  return { mockCreateMCPClient }
})

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient,
}))

vi.mock('@/config/env', () => ({
  loadEnv: () => ({
    OPENAI_API_KEY: 'test-key',
    TALOS_DAEMON_PORT: 7711,
    TALOS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
  resetEnvCache: () => {},
}))

// ---------------------------------------------------------------------------
// OAuth pure-function tests (fetch mocked)
// ---------------------------------------------------------------------------

const FAKE_META: AuthServerMetadata = {
  issuer: 'https://app.keeperhub.com',
  authorization_endpoint: 'https://app.keeperhub.com/oauth/authorize',
  token_endpoint: 'https://app.keeperhub.com/api/oauth/token',
  registration_endpoint: 'https://app.keeperhub.com/api/oauth/register',
  scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('discoverAuthServer', () => {
  it('parses metadata from .well-known endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FAKE_META))
    const meta = await discoverAuthServer({ fetch: fetchMock })
    expect(meta.token_endpoint).toBe(FAKE_META.token_endpoint)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.keeperhub.com/.well-known/oauth-authorization-server',
    )
  })

  it('throws TalosAuthError on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    await expect(discoverAuthServer({ fetch: fetchMock })).rejects.toThrow(/discovery failed/)
  })

  it('throws when required endpoints missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issuer: 'https://x' }))
    await expect(discoverAuthServer({ fetch: fetchMock })).rejects.toThrow(/missing required/)
  })
})

describe('generatePkce', () => {
  it('produces a 43+ char unreserved verifier', () => {
    const { verifier } = generatePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true)
  })

  it('challenge is BASE64URL(SHA256(verifier))', () => {
    const { verifier, challenge, method } = generatePkce()
    const expected = require('node:crypto')
      .createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
    expect(method).toBe('S256')
  })

  it('two calls produce distinct verifiers', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('generateState', () => {
  it('returns 32-char hex string', () => {
    const s = generateState()
    expect(s.length).toBe(32)
    expect(/^[0-9a-f]+$/.test(s)).toBe(true)
  })
})

describe('registerClient (DCR)', () => {
  it('posts the expected body and returns the issued client', async () => {
    const fakeClient: RegisteredClient = { client_id: 'client-abc' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fakeClient))
    const out = await registerClient({
      fetch: fetchMock,
      meta: FAKE_META,
      redirectUri: 'http://127.0.0.1:43210/callback',
    })
    expect(out.client_id).toBe('client-abc')
    expect(fetchMock).toHaveBeenCalledWith(
      FAKE_META.registration_endpoint,
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(body.scope).toBe('mcp:read mcp:write')
  })

  it('throws when meta has no registration_endpoint', async () => {
    await expect(
      registerClient({
        meta: { ...FAKE_META, registration_endpoint: undefined as unknown as string },
        redirectUri: 'http://127.0.0.1:43210/callback',
      }),
    ).rejects.toThrow(/DCR unsupported/)
  })

  it('surfaces server error body in the thrown message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('client_name required', { status: 400 }))
    await expect(
      registerClient({
        fetch: fetchMock,
        meta: FAKE_META,
        redirectUri: 'http://127.0.0.1:43210/callback',
      }),
    ).rejects.toThrow(/DCR failed: 400/)
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes every required PKCE/OAuth param', () => {
    const url = buildAuthorizeUrl({
      meta: FAKE_META,
      clientId: 'client-abc',
      redirectUri: 'http://127.0.0.1:43210/callback',
      pkce: { verifier: 'v', challenge: 'c', method: 'S256' },
      state: 'st',
    })
    const u = new URL(url)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe('client-abc')
    expect(u.searchParams.get('code_challenge')).toBe('c')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('st')
    expect(u.searchParams.get('scope')).toBe('mcp:read mcp:write')
  })
})

describe('exchangeCode + refreshToken', () => {
  const tokenRes: TokenResponse = {
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt-1',
    scope: 'mcp:read mcp:write',
  }

  it('exchangeCode posts form body and parses response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tokenRes))
    const out = await exchangeCode({
      fetch: fetchMock,
      meta: FAKE_META,
      clientId: 'client-abc',
      redirectUri: 'http://127.0.0.1:43210/callback',
      code: 'AUTH_CODE',
      pkceVerifier: 'verif',
    })
    expect(out.access_token).toBe('at-1')
    const [, init] = fetchMock.mock.calls[0]!
    const body = (init as RequestInit).body as string
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=AUTH_CODE')
    expect(body).toContain('code_verifier=verif')
  })

  it('refreshToken posts grant_type=refresh_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tokenRes))
    await refreshToken({
      fetch: fetchMock,
      meta: FAKE_META,
      clientId: 'client-abc',
      refreshToken: 'rt-1',
    })
    const [, init] = fetchMock.mock.calls[0]!
    const body = (init as RequestInit).body as string
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=rt-1')
  })

  it('throws on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad code', { status: 400 }))
    await expect(
      exchangeCode({
        fetch: fetchMock,
        meta: FAKE_META,
        clientId: 'client-abc',
        redirectUri: 'http://127.0.0.1:43210/callback',
        code: 'AUTH_CODE',
        pkceVerifier: 'verif',
      }),
    ).rejects.toThrow(/token request failed: 400/)
  })

  it('throws when access_token missing in response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token_type: 'Bearer', expires_in: 3600 }))
    await expect(
      exchangeCode({
        fetch: fetchMock,
        meta: FAKE_META,
        clientId: 'client-abc',
        redirectUri: 'http://127.0.0.1:43210/callback',
        code: 'AUTH_CODE',
        pkceVerifier: 'verif',
      }),
    ).rejects.toThrow(/missing access_token/)
  })
})

// ---------------------------------------------------------------------------
// Token persistence tests
// ---------------------------------------------------------------------------

describe('token persistence', () => {
  let tmpDir: string
  let tokenPath: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'talos-keeperhub-'))
    tokenPath = path.join(tmpDir, 'keeperhub.token')
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  const sample: StoredSession = {
    client: { client_id: 'client-abc' },
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scope: 'mcp:read mcp:write',
    tokenType: 'Bearer',
  }

  it('round-trips save + load', async () => {
    await saveSession(tokenPath, sample)
    const loaded = await loadSession(tokenPath)
    expect(loaded).toEqual(sample)
  })

  it('writes file with 0600 perms', async () => {
    await saveSession(tokenPath, sample)
    const stat = fs.statSync(tokenPath)
    // mask off file-type bits, compare permissions
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when file is missing', async () => {
    const loaded = await loadSession(path.join(tmpDir, 'nope'))
    expect(loaded).toBeNull()
  })

  it('throws on malformed JSON', async () => {
    await fsp.writeFile(tokenPath, '{not json', 'utf8')
    await expect(loadSession(tokenPath)).rejects.toThrow(/not valid JSON/)
  })

  it('throws on missing required fields', async () => {
    await fsp.writeFile(tokenPath, JSON.stringify({ accessToken: 'x' }), 'utf8')
    await expect(loadSession(tokenPath)).rejects.toThrow(/malformed/)
  })

  it('clearSession removes file (idempotent)', async () => {
    await saveSession(tokenPath, sample)
    await clearSession(tokenPath)
    expect(fs.existsSync(tokenPath)).toBe(false)
    await clearSession(tokenPath) // second call shouldn't throw
  })

  it('isExpired returns true when within buffer (60s)', () => {
    const fresh = { ...sample, expiresAt: Date.now() + 30_000 }
    const future = { ...sample, expiresAt: Date.now() + 600_000 }
    expect(isExpired(fresh)).toBe(true)
    expect(isExpired(future)).toBe(false)
  })

  it('sessionFromResponse derives expiresAt = now + expires_in*1000', () => {
    const now = 1_700_000_000_000
    const session = sessionFromResponse(
      { client_id: 'client-abc' },
      {
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt',
      },
      now,
    )
    expect(session.expiresAt).toBe(now + 3_600_000)
    expect(session.refreshToken).toBe('rt')
  })
})

// ---------------------------------------------------------------------------
// shouldAudit decision tree
// ---------------------------------------------------------------------------

describe('shouldAudit', () => {
  it('bypasses tools matching KNOWN_READONLY', () => {
    expect(shouldAudit('blockscout_get_balance').shouldAudit).toBe(false)
    expect(shouldAudit('aave_get_position').reason).toBe('KNOWN_READONLY')
    expect(shouldAudit('uniswap_quote').reason).toBe('KNOWN_READONLY')
  })

  it('bypasses tools annotated readOnly', () => {
    const d = shouldAudit('aave_supply', { readOnly: true })
    expect(d.shouldAudit).toBe(false)
    expect(d.reason).toBe('annotation_readOnly')
  })

  it('audits tools annotated mutates', () => {
    const d = shouldAudit('aave_supply', { mutates: true })
    expect(d.shouldAudit).toBe(true)
    expect(d.reason).toBe('annotation_mutates')
  })

  it('audits tools without annotations (audit-by-default)', () => {
    const d = shouldAudit('uniswap_swap')
    expect(d.shouldAudit).toBe(true)
    expect(d.reason).toBe('audit_default')
  })

  it('KNOWN_READONLY allowlist exposed for inspection', () => {
    expect(KNOWN_READONLY.length).toBeGreaterThan(0)
    expect(KNOWN_READONLY.every((r) => r instanceof RegExp)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createKeeperHubMiddleware
// ---------------------------------------------------------------------------

describe('createKeeperHubMiddleware', () => {
  let handle: DbHandle
  let runId: string

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
    await upsertThread(handle.db, { id: 't-1', channel: 'cli', agentId: 'talos-eth' })
    const run = await openRun(handle.db, { threadId: 't-1', prompt: 'test' })
    runId = run.id
  })

  afterEach(async () => {
    await handle.close()
  })

  function makeTool(execute: (args: unknown) => Promise<unknown>) {
    return {
      description: 'test tool',
      inputSchema: { type: 'object' as const, properties: {} },
      execute: async (args: unknown, _ctx: unknown) => execute(args),
    } as never
  }

  async function readToolCall(toolCallId: string) {
    return handle.pg.query<{
      tool_name: string
      audit: { shouldAudit: boolean; reason: string }
      result: unknown
      error: string | null
    }>(`SELECT tool_name, audit, result, error FROM tool_calls WHERE tool_call_id = $1`, [
      toolCallId,
    ])
  }

  it('wraps tools and writes audit row on success', async () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
    })
    const wrapped = middleware({
      uniswap_swap: makeTool(async () => ({ ok: true })),
    })

    const result = await wrapped.uniswap_swap!.execute!(
      { amount: 100 },
      { toolCallId: 'tc-1', messages: [] },
    )
    expect(result).toEqual({ ok: true })

    const rows = await readToolCall('tc-1')
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    expect(row.tool_name).toBe('uniswap_swap')
    expect(row.audit.shouldAudit).toBe(true)
    expect(row.audit.reason).toBe('audit_default')
    expect(row.result).toEqual({ ok: true })
  })

  it('marks audit row with KNOWN_READONLY reason for read-only tool', async () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
    })
    const wrapped = middleware({
      blockscout_get_balance: makeTool(async () => '0xff'),
    })

    await wrapped.blockscout_get_balance!.execute!(
      { addr: '0x0' },
      { toolCallId: 'tc-2', messages: [] },
    )

    const rows = await readToolCall('tc-2')
    const row = rows.rows[0]!
    expect(row.audit.shouldAudit).toBe(false)
    expect(row.audit.reason).toBe('KNOWN_READONLY')
  })

  it('uses annotation lookup when provided', async () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
      annotations: (name) => (name === 'aave_supply' ? { mutates: true } : undefined),
    })
    const wrapped = middleware({ aave_supply: makeTool(async () => 'ok') })
    await wrapped.aave_supply!.execute!({}, { toolCallId: 'tc-3', messages: [] })
    const rows = await readToolCall('tc-3')
    expect(rows.rows[0]!.audit.reason).toBe('annotation_mutates')
  })

  it('records error and rethrows when tool throws', async () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
    })
    const wrapped = middleware({
      uniswap_swap: makeTool(async () => {
        throw new Error('insufficient liquidity')
      }),
    })

    await expect(
      wrapped.uniswap_swap!.execute!({}, { toolCallId: 'tc-4', messages: [] }),
    ).rejects.toThrow(/insufficient liquidity/)

    const rows = await readToolCall('tc-4')
    expect(rows.rows[0]!.error).toContain('insufficient liquidity')
    expect(rows.rows[0]!.audit.shouldAudit).toBe(true)
  })

  it('skips DB write when no run context is available', async () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => null,
    })
    const wrapped = middleware({ uniswap_swap: makeTool(async () => 'ok') })
    await wrapped.uniswap_swap!.execute!({}, { toolCallId: 'tc-5', messages: [] })
    const rows = await readToolCall('tc-5')
    expect(rows.rows).toHaveLength(0)
  })

  it('passes through tools without an execute fn unchanged', () => {
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => null,
    })
    const noExec = { description: 'meta', inputSchema: { type: 'object' as const } } as never
    const wrapped = middleware({ meta: noExec })
    expect(wrapped.meta).toBe(noExec)
  })

  // ---------------------------------------------------------------------------
  // Mutate-tool routing through KeeperHub workflow client (#10)
  // ---------------------------------------------------------------------------

  describe('mutate routing', () => {
    function fakeKhClient(impl: {
      executeContractCall: (input: ContractCallInput) => Promise<ExecutionResult>
    }): KeeperHubClient {
      return {
        ensureToken: async () => 'token',
        listTools: async () => ({}),
        callTool: async () => undefined,
        executeContractCall: impl.executeContractCall,
        executeTransfer: async () => ({ executionId: 'noop', status: 'success' }),
        getExecutionStatus: async () => ({ executionId: 'noop', status: 'success' }),
        close: async () => {},
      }
    }

    it('routes mutate tool through KH client when route is configured', async () => {
      const calls: ContractCallInput[] = []
      const client = fakeKhClient({
        executeContractCall: async (input) => {
          calls.push(input)
          return { executionId: 'exec-1', status: 'success', txHash: '0xdead' }
        },
      })

      const aaveRoute: MutateRoute = (args) => {
        const a = args as { amount: string }
        return {
          network: 'sepolia',
          contract_address: '0xAAVEPOOL',
          function_name: 'supply',
          function_args: [a.amount],
        }
      }

      const originalCalled = vi.fn()
      const middleware = createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ({ runId }),
        annotations: () => ({ mutates: true }),
        kh: { client, routes: new Map([['aave_supply', aaveRoute]]) },
      })
      const wrapped = middleware({
        aave_supply: makeTool(async (args) => {
          originalCalled(args)
          return 'should not be called'
        }),
      })

      const result = await wrapped.aave_supply!.execute!(
        { amount: '100' },
        { toolCallId: 'tc-mut-1', messages: [] },
      )

      expect(originalCalled).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        network: 'sepolia',
        contract_address: '0xAAVEPOOL',
        function_name: 'supply',
        function_args: ['100'],
      })
      expect(result).toMatchObject({ executionId: 'exec-1', txHash: '0xdead' })

      const rows = await handle.pg.query<{
        audit: {
          shouldAudit: boolean
          reason: string
          executionId?: string
          txHash?: string
          details: { elapsedMs: number; routedThrough?: string }
        }
        result: { executionId: string }
      }>(`SELECT audit, result FROM tool_calls WHERE tool_call_id = $1`, ['tc-mut-1'])
      expect(rows.rows[0]?.audit.shouldAudit).toBe(true)
      expect(rows.rows[0]?.audit.reason).toBe('annotation_mutates')
      expect(rows.rows[0]?.audit.executionId).toBe('exec-1')
      expect(rows.rows[0]?.audit.txHash).toBe('0xdead')
      expect(rows.rows[0]?.audit.details.routedThrough).toBe('keeperhub')
      expect(rows.rows[0]?.result.executionId).toBe('exec-1')
    })

    it('falls through to original execute when mutate tool has no route registered', async () => {
      const client = fakeKhClient({
        executeContractCall: vi.fn(
          async (): Promise<ExecutionResult> => ({ executionId: 'noop', status: 'success' }),
        ),
      })

      const middleware = createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ({ runId }),
        annotations: () => ({ mutates: true }),
        kh: { client, routes: new Map() },
      })
      const wrapped = middleware({
        unknown_swap: makeTool(async () => ({ ok: true })),
      })

      const result = await wrapped.unknown_swap!.execute!(
        {},
        { toolCallId: 'tc-mut-2', messages: [] },
      )

      expect(result).toEqual({ ok: true })
      expect(client.executeContractCall).not.toHaveBeenCalled()

      const rows = await handle.pg.query<{
        audit: { reason: string; executionId?: string; details: { routedThrough?: string } }
      }>(`SELECT audit FROM tool_calls WHERE tool_call_id = $1`, ['tc-mut-2'])
      expect(rows.rows[0]?.audit.reason).toBe('annotation_mutates')
      expect(rows.rows[0]?.audit.executionId).toBeUndefined()
      expect(rows.rows[0]?.audit.details.routedThrough).toBeUndefined()
    })

    it('records error when KH execution returns failed status', async () => {
      const client = fakeKhClient({
        executeContractCall: async () => ({
          executionId: 'exec-err',
          status: 'failed',
          error: 'revert: insufficient collateral',
        }),
      })

      const middleware = createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ({ runId }),
        annotations: () => ({ mutates: true }),
        kh: {
          client,
          routes: new Map([
            [
              'aave_supply',
              () => ({ network: 'sepolia', contract_address: '0xX', function_name: 'supply' }),
            ],
          ]),
        },
      })
      const wrapped = middleware({ aave_supply: makeTool(async () => 'never') })

      await expect(
        wrapped.aave_supply!.execute!({}, { toolCallId: 'tc-mut-3', messages: [] }),
      ).rejects.toThrow(/insufficient collateral/)

      const rows = await handle.pg.query<{
        error: string
        audit: { executionId?: string }
      }>(`SELECT error, audit FROM tool_calls WHERE tool_call_id = $1`, ['tc-mut-3'])
      expect(rows.rows[0]?.error).toContain('insufficient collateral')
      expect(rows.rows[0]?.audit.executionId).toBe('exec-err')
    })

    it('does not route read tools even when KH client + route are present', async () => {
      const client = fakeKhClient({
        executeContractCall: vi.fn(
          async (): Promise<ExecutionResult> => ({ executionId: 'wrong', status: 'success' }),
        ),
      })

      const middleware = createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ({ runId }),
        annotations: () => ({ readOnly: true }),
        kh: {
          client,
          routes: new Map([
            [
              'aave_get_position',
              () => ({ network: 'sepolia', contract_address: '0xX', function_name: 'pos' }),
            ],
          ]),
        },
      })
      const wrapped = middleware({
        aave_get_position: makeTool(async () => ({ debt: '0', collateral: '5' })),
      })
      const result = await wrapped.aave_get_position!.execute!(
        {},
        { toolCallId: 'tc-mut-4', messages: [] },
      )
      expect(result).toEqual({ debt: '0', collateral: '5' })
      expect(client.executeContractCall).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// createKeeperHubClient (auth + MCP integration, mocked)
// ---------------------------------------------------------------------------

describe('createKeeperHubClient', () => {
  let tmpDir: string
  let tokenPath: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'talos-keeperhub-client-'))
    tokenPath = path.join(tmpDir, 'keeperhub.token')
    mockCreateMCPClient.mockReset()
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('throws TalosAuthError when no session on disk', async () => {
    await expect(createKeeperHubClient({ tokenPath })).rejects.toThrow(/no KeeperHub session/)
  })

  it('returns the existing access token when not expired', async () => {
    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-fresh',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    expect(await client.ensureToken()).toBe('at-fresh')
    await client.close()
  })

  it('refreshes an expired token via fetch and re-persists the session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: 'at-new',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-new',
      } satisfies TokenResponse),
    )
    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 1000, // expired
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(await client.ensureToken()).toBe('at-new')
    expect(fetchMock).toHaveBeenCalledOnce()
    const reloaded = await loadSession(tokenPath)
    expect(reloaded?.accessToken).toBe('at-new')
    expect(reloaded?.refreshToken).toBe('rt-new')
    await client.close()
  })

  it('throws when expired and no refresh_token present', async () => {
    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-old',
      expiresAt: Date.now() - 1000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    await expect(client.ensureToken()).rejects.toThrow(/no refresh_token/)
    await client.close()
  })

  it('passes Bearer token in Authorization header to MCP transport', async () => {
    const mockMcp = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockCreateMCPClient.mockResolvedValue(mockMcp)

    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-fresh',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    await client.listTools()
    const [opts] = mockCreateMCPClient.mock.calls[0]!
    expect(opts.transport).toEqual(
      expect.objectContaining({
        type: 'http',
        url: 'https://app.keeperhub.com/mcp',
        headers: { Authorization: 'Bearer at-fresh' },
      }),
    )
    await client.close()
  })

  it('executeContractCall maps response to ExecutionResult shape', async () => {
    const mockMcp = {
      tools: vi.fn().mockResolvedValue({
        execute_contract_call: {
          description: 'EVM call',
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  execution_id: 'exec-1',
                  status: 'success',
                  tx_hash: '0xdead',
                }),
              },
            ],
          }),
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockCreateMCPClient.mockResolvedValue(mockMcp)

    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-fresh',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    const out = await client.executeContractCall({
      network: 'base-sepolia',
      contract_address: '0xaaa',
      function_name: 'supply',
    })
    expect(out.executionId).toBe('exec-1')
    expect(out.status).toBe('success')
    expect(out.txHash).toBe('0xdead')
    await client.close()
  })

  it('parses live KH direct-execution response (completed, transactionHash, transactionLink)', async () => {
    const mockMcp = {
      tools: vi.fn().mockResolvedValue({
        get_direct_execution_status: {
          description: 'status',
          execute: vi.fn().mockResolvedValue({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  executionId: 'spgrp6oi4d5ea2fdugdny',
                  status: 'completed',
                  type: 'transfer',
                  transactionHash:
                    '0xb6e8ad92f820436900a447dcb3490dfea65851de0c4f1276fc5d067e31ffcdd9',
                  transactionLink:
                    'https://sepolia.etherscan.io/tx/0xb6e8ad92f820436900a447dcb3490dfea65851de0c4f1276fc5d067e31ffcdd9',
                  error: null,
                  network: 'sepolia',
                }),
              },
            ],
          }),
        },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockCreateMCPClient.mockResolvedValue(mockMcp)

    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-fresh',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    const out = await client.getExecutionStatus('spgrp6oi4d5ea2fdugdny')
    expect(out.executionId).toBe('spgrp6oi4d5ea2fdugdny')
    expect(out.status).toBe('success')
    expect(out.txHash).toBe('0xb6e8ad92f820436900a447dcb3490dfea65851de0c4f1276fc5d067e31ffcdd9')
    expect(out.transactionLink).toBe(
      'https://sepolia.etherscan.io/tx/0xb6e8ad92f820436900a447dcb3490dfea65851de0c4f1276fc5d067e31ffcdd9',
    )
    expect(out.error).toBeUndefined()
    await client.close()
  })

  it('callTool throws when target tool is missing on the server', async () => {
    const mockMcp = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockCreateMCPClient.mockResolvedValue(mockMcp)

    await saveSession(tokenPath, {
      client: { client_id: 'client-abc' },
      accessToken: 'at-fresh',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
      tokenType: 'Bearer',
    })
    const client = await createKeeperHubClient({
      tokenPath,
      authServerMetadata: FAKE_META,
    })
    await expect(client.callTool('execute_contract_call', { foo: 1 })).rejects.toThrow(
      /unavailable/,
    )
    await client.close()
  })
})
