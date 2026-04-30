import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { StepResult, WizardContext } from '../context'

export type DaemonTokenDeps = {
  /** Test seam — overrides the random source. */
  randomBytes?: (n: number) => Buffer
}

/**
 * Generate (or preserve) the daemon control-plane bearer token used by CLI /
 * Telegram / MCP-server clients to authenticate to the WS server. 32 random
 * bytes hex-encoded (256 bits).
 */
export function runDaemonTokenStep(ctx: WizardContext, deps: DaemonTokenDeps = {}): StepResult {
  const tokenPath = ctx.paths.tokenPath

  if (
    ctx.idempotency === 'partial-oauth-only' ||
    (ctx.idempotency === 'keep' && ctx.existing.daemonToken)
  ) {
    return { status: 'kept', summary: `Daemon token kept (${tokenPath})` }
  }

  const bytes = (deps.randomBytes ?? crypto.randomBytes)(32)
  const token = bytes.toString('hex')

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(tokenPath, 0o600)

  return {
    status: 'done',
    summary: `Daemon token written (${tokenPath})`,
    data: { tokenPath },
  }
}
