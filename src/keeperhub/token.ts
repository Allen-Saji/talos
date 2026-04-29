import fs from 'node:fs/promises'
import path from 'node:path'
import { TalosAuthError } from '@/shared/errors'
import type { RegisteredClient, TokenResponse } from './oauth'

/** Persisted KeeperHub session — token + the client we registered to obtain it. */
export type StoredSession = {
  client: RegisteredClient
  accessToken: string
  refreshToken?: string
  /** Wall-clock millis when access_token becomes invalid. */
  expiresAt: number
  scope?: string
  tokenType: string
}

/** Refresh proactively if expiry is within this many ms. */
export const EXPIRY_BUFFER_MS = 60_000

export async function saveSession(filePath: string, session: StoredSession): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const payload = JSON.stringify(session, null, 2)
  await fs.writeFile(filePath, payload, { encoding: 'utf8', mode: 0o600 })
  // mkdir + writeFile may race on umask; explicitly chmod to be sure.
  await fs.chmod(filePath, 0o600).catch(() => undefined)
}

export async function loadSession(filePath: string): Promise<StoredSession | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as StoredSession
    if (!parsed.accessToken || !parsed.client?.client_id || typeof parsed.expiresAt !== 'number') {
      throw new TalosAuthError('KeeperHub token file is malformed')
    }
    return parsed
  } catch (err) {
    if (err instanceof TalosAuthError) throw err
    throw new TalosAuthError('KeeperHub token file is not valid JSON', err)
  }
}

export async function clearSession(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}

/** True if the access token is expired or within the refresh buffer. */
export function isExpired(session: StoredSession, now: number = Date.now()): boolean {
  return session.expiresAt - now <= EXPIRY_BUFFER_MS
}

/** Build a session from a fresh token response + the client that obtained it. */
export function sessionFromResponse(
  client: RegisteredClient,
  res: TokenResponse,
  now: number = Date.now(),
): StoredSession {
  return {
    client,
    accessToken: res.access_token,
    ...(res.refresh_token !== undefined ? { refreshToken: res.refresh_token } : {}),
    expiresAt: now + res.expires_in * 1000,
    ...(res.scope !== undefined ? { scope: res.scope } : {}),
    tokenType: res.token_type,
  }
}
