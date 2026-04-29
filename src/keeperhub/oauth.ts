import crypto from 'node:crypto'
import { TalosAuthError } from '@/shared/errors'

const KEEPERHUB_BASE = 'https://app.keeperhub.com'
const DEFAULT_SCOPES = ['mcp:read', 'mcp:write']
const DEFAULT_CLIENT_NAME = 'talos'

/** OAuth Authorization Server metadata (RFC 8414) — only fields we actually use. */
export type AuthServerMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
}

export type RegisteredClient = {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  registration_access_token?: string
  registration_client_uri?: string
}

export type PkcePair = {
  verifier: string
  challenge: string
  method: 'S256'
}

export type TokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

export type DiscoveryOpts = { fetch?: typeof fetch; baseUrl?: string }

/**
 * Discover the KeeperHub authorization server metadata.
 * Hits `${baseUrl}/.well-known/oauth-authorization-server`.
 */
export async function discoverAuthServer(opts: DiscoveryOpts = {}): Promise<AuthServerMetadata> {
  const fetchImpl = opts.fetch ?? fetch
  const url = `${opts.baseUrl ?? KEEPERHUB_BASE}/.well-known/oauth-authorization-server`
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new TalosAuthError(
      `KeeperHub auth-server discovery failed: ${res.status} ${res.statusText}`,
    )
  }
  const meta = (await res.json()) as AuthServerMetadata
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new TalosAuthError('KeeperHub auth-server metadata missing required endpoints')
  }
  return meta
}

/**
 * Generate a PKCE verifier + S256 challenge.
 * Verifier: 43-128 unreserved chars; challenge: BASE64URL(SHA256(verifier)).
 */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(crypto.randomBytes(32))
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** Random hex state for CSRF defense on the auth-code redirect. */
export function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

export type RegisterClientOpts = {
  fetch?: typeof fetch
  meta: AuthServerMetadata
  clientName?: string
  redirectUri: string
  scopes?: string[]
}

/**
 * Dynamic Client Registration (RFC 7591). Registers a public PKCE client
 * with KeeperHub and returns the issued client_id.
 */
export async function registerClient(opts: RegisterClientOpts): Promise<RegisteredClient> {
  const fetchImpl = opts.fetch ?? fetch
  if (!opts.meta.registration_endpoint) {
    throw new TalosAuthError(
      'KeeperHub auth-server does not advertise registration_endpoint (DCR unsupported)',
    )
  }

  const body = {
    client_name: opts.clientName ?? DEFAULT_CLIENT_NAME,
    redirect_uris: [opts.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: (opts.scopes ?? DEFAULT_SCOPES).join(' '),
  }

  const res = await fetchImpl(opts.meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TalosAuthError(`KeeperHub DCR failed: ${res.status} ${res.statusText} ${text}`.trim())
  }

  return (await res.json()) as RegisteredClient
}

export type BuildAuthUrlOpts = {
  meta: AuthServerMetadata
  clientId: string
  redirectUri: string
  scopes?: string[]
  pkce: PkcePair
  state: string
}

/** Build the redirect URL the user opens in their browser to grant access. */
export function buildAuthorizeUrl(opts: BuildAuthUrlOpts): string {
  const u = new URL(opts.meta.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', opts.clientId)
  u.searchParams.set('redirect_uri', opts.redirectUri)
  u.searchParams.set('scope', (opts.scopes ?? DEFAULT_SCOPES).join(' '))
  u.searchParams.set('state', opts.state)
  u.searchParams.set('code_challenge', opts.pkce.challenge)
  u.searchParams.set('code_challenge_method', opts.pkce.method)
  return u.toString()
}

export type ExchangeCodeOpts = {
  fetch?: typeof fetch
  meta: AuthServerMetadata
  clientId: string
  clientSecret?: string
  redirectUri: string
  code: string
  pkceVerifier: string
}

/** Exchange the authorization code for an access + refresh token. */
export async function exchangeCode(opts: ExchangeCodeOpts): Promise<TokenResponse> {
  const fetchImpl = opts.fetch ?? fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.pkceVerifier,
  })
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret)

  return postTokenRequest(fetchImpl, opts.meta.token_endpoint, body)
}

export type RefreshTokenOpts = {
  fetch?: typeof fetch
  meta: AuthServerMetadata
  clientId: string
  clientSecret?: string
  refreshToken: string
}

/** Use the refresh_token grant to mint a new access token. */
export async function refreshToken(opts: RefreshTokenOpts): Promise<TokenResponse> {
  const fetchImpl = opts.fetch ?? fetch
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  })
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret)

  return postTokenRequest(fetchImpl, opts.meta.token_endpoint, body)
}

async function postTokenRequest(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TalosAuthError(
      `KeeperHub token request failed: ${res.status} ${res.statusText} ${text}`.trim(),
    )
  }
  const json = (await res.json()) as TokenResponse
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new TalosAuthError('KeeperHub token response missing access_token or expires_in')
  }
  return json
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
