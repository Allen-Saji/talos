import {
  buildAuthorizeUrl,
  discoverAuthServer,
  exchangeCode,
  generatePkce,
  generateState,
  registerClient,
} from '@/keeperhub/oauth'
import { saveSession, sessionFromResponse } from '@/keeperhub/token'
import { TalosAuthError } from '@/shared/errors'
import { child } from '@/shared/logger'
import { openInBrowser } from '../browser'
import type { StepResult, WizardContext } from '../context'
import { startLoopback } from '../loopback'
import type { Prompter } from '../prompt'

const log = child({ module: 'init-keeperhub' })

export type KeeperhubStepDeps = {
  prompter: Prompter
  /** Test seam — overrides the OAuth lib calls. */
  oauth?: {
    discover?: typeof discoverAuthServer
    register?: typeof registerClient
    exchange?: typeof exchangeCode
  }
  /** Test seam — overrides the loopback server factory. */
  startLoopback?: typeof startLoopback
  /** Test seam — overrides the browser opener. */
  openBrowser?: typeof openInBrowser
  /** Print sink (default stdout). */
  print?: (line: string) => void
}

const STEP_TIMEOUT_MS = 120_000

/**
 * KeeperHub OAuth flow — discover → DCR → loopback server → open browser →
 * exchange code → persist session.
 *
 * Skipped entirely when `ctx.skipKeeperhub` is set, when discovery fails (KH
 * unreachable / not running), or when the user declines on the prompt.
 * Skipping is non-fatal — daemon boots without `kh` deps; mutate routing
 * inert until `talos init --kh-only` is rerun.
 */
export async function runKeeperhubOauthStep(
  ctx: WizardContext,
  deps: KeeperhubStepDeps,
): Promise<StepResult> {
  const print = deps.print ?? ((l: string) => process.stdout.write(`${l}\n`))

  if (ctx.skipKeeperhub) {
    return { status: 'skipped', summary: 'KeeperHub OAuth skipped (--skip-keeperhub)' }
  }

  if (
    ctx.idempotency === 'keep' &&
    ctx.existing.keeperhubToken &&
    // partial-oauth-only never short-circuits — that's the whole point of it
    true
  ) {
    return {
      status: 'kept',
      summary: `KeeperHub session kept (${ctx.paths.keeperhubTokenPath})`,
    }
  }

  if (ctx.mode === 'non-interactive') {
    // No browser, no interactive consent. Skip — user can rerun later.
    return {
      status: 'skipped',
      summary: 'KeeperHub OAuth skipped (non-interactive mode)',
    }
  }

  const proceed = await deps.prompter.confirm({
    message: 'Run KeeperHub OAuth flow now? (Opens browser; required for write operations.)',
    default: true,
  })
  if (!proceed) {
    return { status: 'skipped', summary: 'KeeperHub OAuth skipped (user declined)' }
  }

  // Discover. KH unreachable → graceful skip.
  const discover = deps.oauth?.discover ?? discoverAuthServer
  let meta: Awaited<ReturnType<typeof discoverAuthServer>>
  try {
    meta = await discover()
  } catch (err) {
    log.warn({ err }, 'KH discovery failed — skipping OAuth step')
    print('  KeeperHub unreachable — skipping. Rerun `talos init` after KH is up.')
    return {
      status: 'skipped',
      summary: 'KeeperHub OAuth skipped (discovery failed)',
    }
  }

  // Spin up the loopback server first so we know the redirect_uri before DCR.
  const startLb = deps.startLoopback ?? startLoopback
  const expectedState = generateState()
  const lb = await startLb({ expectedState, timeoutMs: STEP_TIMEOUT_MS })

  try {
    const register = deps.oauth?.register ?? registerClient
    const client = await register({
      meta,
      redirectUri: lb.redirectUri,
      clientName: 'talos',
    })

    const pkce = generatePkce()
    const authorizeUrl = buildAuthorizeUrl({
      meta,
      clientId: client.client_id,
      redirectUri: lb.redirectUri,
      pkce,
      state: expectedState,
    })

    const opener = deps.openBrowser ?? openInBrowser
    const { opened } = await opener(authorizeUrl)
    if (!opened) {
      print('')
      print('  Could not open browser automatically. Open this URL manually:')
      print(`  ${authorizeUrl}`)
      print('')
    } else {
      print('')
      print('  Browser opened. Complete the consent flow there...')
      print('')
    }

    const { code } = await lb.result

    const exchange = deps.oauth?.exchange ?? exchangeCode
    const tokenRes = await exchange({
      meta,
      clientId: client.client_id,
      ...(client.client_secret !== undefined ? { clientSecret: client.client_secret } : {}),
      redirectUri: lb.redirectUri,
      code,
      pkceVerifier: pkce.verifier,
    })

    const session = sessionFromResponse(client, tokenRes)
    await saveSession(ctx.paths.keeperhubTokenPath, session)

    return {
      status: 'done',
      summary: `KeeperHub session saved (${ctx.paths.keeperhubTokenPath})`,
      data: { clientId: client.client_id, scope: tokenRes.scope ?? '' },
    }
  } catch (err) {
    if (err instanceof TalosAuthError) {
      print(`  KeeperHub OAuth failed: ${err.message}`)
    } else {
      print(`  KeeperHub OAuth failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { status: 'skipped', summary: 'KeeperHub OAuth skipped (failed)' }
  } finally {
    await lb.close()
  }
}
