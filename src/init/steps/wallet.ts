import fs from 'node:fs'
import path from 'node:path'
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { resetWalletForTests } from '@/wallet'
import type { StepResult, WizardContext } from '../context'
import type { Prompter } from '../prompt'

export type WalletDeps = {
  prompter: Prompter
  /** Inject the mnemonic generator (tests). */
  generate?: () => string
  /** Where to print mnemonic + address. Default stdout. */
  log?: (line: string) => void
}

/**
 * Generate a fresh wallet with a 12-word mnemonic, persist it to
 * `paths.burnerWalletPath` (0600), and display the mnemonic + address ONCE
 * so the user can write it down. Confirms before continuing.
 *
 * Idempotency: if a burner already exists and the user chose `keep` or
 * `partial-oauth-only`, preserve the existing privateKey. In interactive
 * mode we still display the address and offer to regenerate.
 *
 * Storage shape (`burner.json`):
 *   { privateKey: '0x...', mnemonic?: '...' (only when generated this run) }
 */
export async function runWalletStep(ctx: WizardContext, deps: WalletDeps): Promise<StepResult> {
  const log = deps.log ?? ((l: string) => process.stdout.write(`${l}\n`))
  const burnerPath = ctx.paths.burnerWalletPath

  if (ctx.idempotency === 'partial-oauth-only' && ctx.existing.burnerWallet) {
    const addr = readBurnerAddress(burnerPath)
    return {
      status: 'kept',
      summary: `Wallet kept (${addr})`,
      data: { address: addr, regenerated: false },
    }
  }

  if (ctx.idempotency === 'keep' && ctx.existing.burnerWallet) {
    const addr = readBurnerAddress(burnerPath)
    return {
      status: 'kept',
      summary: `Wallet kept (${addr})`,
      data: { address: addr, regenerated: false },
    }
  }

  if (ctx.mode === 'interactive' && ctx.existing.burnerWallet) {
    const existingAddr = readBurnerAddress(burnerPath)
    const regen = await deps.prompter.confirm({
      message: `An existing burner wallet (${existingAddr}) is on disk. Regenerate?`,
      default: false,
    })
    if (!regen) {
      return {
        status: 'kept',
        summary: `Wallet kept (${existingAddr})`,
        data: { address: existingAddr, regenerated: false },
      }
    }
  }

  // Generate fresh.
  const mnemonic = (deps.generate ?? (() => generateMnemonic(english)))()
  const account = mnemonicToAccount(mnemonic)
  const privateKey = exportPrivateKey(account)

  fs.mkdirSync(path.dirname(burnerPath), { recursive: true })
  fs.writeFileSync(burnerPath, JSON.stringify({ privateKey, mnemonic }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(burnerPath, 0o600)

  // Reset the in-memory wallet cache so any later code in the same process
  // (e.g. migration step holding a viem client) reads the new keypair.
  resetWalletForTests()

  if (ctx.mode === 'interactive') {
    log('')
    log('  Fresh wallet generated. Write down the mnemonic NOW — it will not be shown again.')
    log('')
    log(`  Address:  ${account.address}`)
    log(`  Mnemonic: ${mnemonic}`)
    log('')
    let confirmed = false
    while (!confirmed) {
      confirmed = await deps.prompter.confirm({
        message: 'Saved the mnemonic somewhere safe?',
        default: false,
      })
      if (!confirmed) {
        log('  Take your time — write it down before continuing.')
      }
    }
  }

  return {
    status: 'done',
    summary: `Wallet generated (${account.address})`,
    data: { address: account.address, regenerated: true },
  }
}

/**
 * Pull the privateKey from a viem mnemonic-derived HDAccount. The high-level
 * API hides it; we go through `getHdKey()` and serialize. This is the same
 * key viem uses for signing.
 */
function exportPrivateKey(account: ReturnType<typeof mnemonicToAccount>): `0x${string}` {
  const hd = account.getHdKey()
  if (!hd.privateKey) {
    throw new Error('mnemonic-derived account is missing privateKey')
  }
  const hex = Buffer.from(hd.privateKey).toString('hex')
  return `0x${hex}` as `0x${string}`
}

function readBurnerAddress(burnerPath: string): string {
  try {
    const raw = fs.readFileSync(burnerPath, 'utf8')
    const parsed = JSON.parse(raw) as { privateKey: `0x${string}` }
    return privateKeyToAccount(parsed.privateKey).address
  } catch {
    return '<unreadable>'
  }
}
