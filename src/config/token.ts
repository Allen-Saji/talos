import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { paths } from './paths'

const TOKEN_BYTES = 32

export async function readToken(): Promise<string | null> {
  try {
    const buf = await fs.readFile(paths.tokenPath, 'utf8')
    const trimmed = buf.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeToken(token: string): Promise<void> {
  await fs.mkdir(path.dirname(paths.tokenPath), { recursive: true })
  await fs.writeFile(paths.tokenPath, token, { mode: 0o600 })
}

export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex')
}

export async function ensureToken(): Promise<string> {
  const existing = await readToken()
  if (existing) return existing
  const fresh = generateToken()
  await writeToken(fresh)
  return fresh
}
