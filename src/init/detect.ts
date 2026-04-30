import fs from 'node:fs'
import path from 'node:path'
import { paths } from '@/config/paths'

/** What already exists on disk that init might overwrite. */
export type ExistingState = {
  envFile: boolean
  envHasOpenAiKey: boolean
  burnerWallet: boolean
  keeperhubToken: boolean
  daemonToken: boolean
  channelsConfig: boolean
  /** True when none of the above exist (a true fresh install). */
  empty: boolean
}

/**
 * Snapshot the config dir before mutating anything. Pure read — used by the
 * wizard's idempotency prompt and by step modules to decide preserve-vs-regen.
 */
export function detectExisting(p: typeof paths = paths): ExistingState {
  const envPath = path.join(p.configDir, '.env')
  const envFile = fs.existsSync(envPath)
  const envHasOpenAiKey = envFile && readEnvHasKey(envPath, 'OPENAI_API_KEY')
  const burnerWallet = fs.existsSync(p.burnerWalletPath)
  const keeperhubToken = fs.existsSync(p.keeperhubTokenPath)
  const daemonToken = fs.existsSync(p.tokenPath)
  const channelsConfig = fs.existsSync(p.channelsConfigPath)

  const empty = !envFile && !burnerWallet && !keeperhubToken && !daemonToken && !channelsConfig

  return {
    envFile,
    envHasOpenAiKey,
    burnerWallet,
    keeperhubToken,
    daemonToken,
    channelsConfig,
    empty,
  }
}

/**
 * Returns true when the named key has a non-empty value in the env file.
 * Tolerates blank lines, comments, quoted values. Doesn't validate format.
 */
function readEnvHasKey(envPath: string, key: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(envPath, 'utf8')
  } catch {
    return false
  }
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm')
  const m = raw.match(re)
  if (!m) return false
  const value = (m[1] ?? '').trim().replace(/^["']|["']$/g, '')
  return value.length > 0
}
