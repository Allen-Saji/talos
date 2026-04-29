import fs from 'node:fs'
import path from 'node:path'
import { createWalletClient, type Hex, http, type WalletClient } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, sepolia } from 'viem/chains'
import { loadEnv } from '@/config/env'
import { paths } from '@/config/paths'
import { logger } from '@/shared/logger'

/**
 * Wallet module — single source of truth for the EVM signer Talos uses
 * across tool integrations (AgentKit, Aave, Uniswap V3 in coming PRs).
 *
 * Two modes:
 * 1. **User-supplied** — set `EVM_PRIVATE_KEY` in env or `~/.config/talos/.env`.
 *    The daemon never persists or echoes the key.
 * 2. **Burner fallback** — if no env key is set, the daemon generates a fresh
 *    private key, persists it to `paths.burnerWalletPath` (mode 0600) for
 *    stability across restarts, and uses it for the session.
 *
 * Burner mode lets read-only tool surfaces (Pyth prices, Zerion lookups,
 * Li.Fi quotes) work out-of-the-box without forcing users to provision a key
 * before the first run. Write paths against the burner fail at chain level
 * (no funds) — by design, never a footgun.
 *
 * v1 supports two chains: Sepolia + Base Sepolia. Mainnet support follows
 * once the demo flow is locked in.
 */

const log = logger.child({ module: 'wallet' })

export type WalletSource = 'env' | 'burner-disk' | 'burner-fresh'

type WalletState = {
  account: PrivateKeyAccount
  source: WalletSource
}

let cached: WalletState | undefined

/** Reset for tests so each test exercises a fresh load path. */
export function resetWalletForTests(): void {
  cached = undefined
}

/**
 * Load (or initialize) the wallet account. Idempotent — repeat calls return
 * the cached account.
 */
export function getWalletAccount(): PrivateKeyAccount {
  if (cached) return cached.account
  cached = loadAccount()
  log.info({ source: cached.source, address: cached.account.address }, 'wallet ready')
  return cached.account
}

/** Returns the wallet's checksummed address. Initializes the account if needed. */
export function getWalletAddress(): `0x${string}` {
  return getWalletAccount().address
}

/** Reports how the current wallet was loaded — env / disk-burner / fresh-burner. */
export function getWalletSource(): WalletSource {
  if (!cached) getWalletAccount()
  // biome-ignore lint/style/noNonNullAssertion: getWalletAccount populates cached
  return cached!.source
}

/**
 * Build a viem WalletClient bound to the loaded account on the given chain.
 * Pulls RPC URL from `RPC_URL_<NETWORK>` env vars when set; otherwise falls
 * back to the chain's default public RPC.
 */
export function getViemWalletClient(chain: 'sepolia' | 'baseSepolia'): WalletClient {
  const env = loadEnv()
  const account = getWalletAccount()
  const chainObj = chain === 'sepolia' ? sepolia : baseSepolia
  const rpcUrl = chain === 'sepolia' ? env.RPC_URL_SEPOLIA : env.RPC_URL_BASE_SEPOLIA

  return createWalletClient({
    account,
    chain: chainObj,
    transport: http(rpcUrl),
  })
}

function loadAccount(): WalletState {
  const env = loadEnv()
  if (env.EVM_PRIVATE_KEY) {
    return {
      account: privateKeyToAccount(normalizeHex(env.EVM_PRIVATE_KEY)),
      source: 'env',
    }
  }

  if (fs.existsSync(paths.burnerWalletPath)) {
    try {
      const raw = fs.readFileSync(paths.burnerWalletPath, 'utf8')
      const parsed = JSON.parse(raw) as { privateKey?: string }
      if (parsed?.privateKey) {
        return {
          account: privateKeyToAccount(normalizeHex(parsed.privateKey)),
          source: 'burner-disk',
        }
      }
      log.warn({ path: paths.burnerWalletPath }, 'burner file missing privateKey, regenerating')
    } catch (err) {
      log.warn({ err, path: paths.burnerWalletPath }, 'failed to read burner file, regenerating')
    }
  }

  const privateKey = generatePrivateKey()
  fs.mkdirSync(path.dirname(paths.burnerWalletPath), { recursive: true })
  fs.writeFileSync(
    paths.burnerWalletPath,
    JSON.stringify({ privateKey, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  )
  log.info(
    { path: paths.burnerWalletPath },
    'generated burner wallet (no funds — for read-only tool surfaces only)',
  )
  return {
    account: privateKeyToAccount(privateKey),
    source: 'burner-fresh',
  }
}

function normalizeHex(key: string): Hex {
  const trimmed = key.trim()
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
}
