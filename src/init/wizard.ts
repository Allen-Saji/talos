import { paths as defaultPaths } from '@/config/paths'
import { logger } from '@/shared/logger'
import type { IdempotencyChoice, StepName, StepResult, WizardContext, WizardMode } from './context'
import { detectExisting, type ExistingState } from './detect'
import { interactivePrompter, noPrompter, type Prompter } from './prompt'
import { runChannelsStep } from './steps/channels'
import { runDaemonTokenStep } from './steps/daemon-token'
import { runKeeperhubOauthStep } from './steps/keeperhub-oauth'
import { runMigrationsStep } from './steps/migrations'
import { runOpenAiKeyStep } from './steps/openai-key'
import { runServiceStep } from './steps/service'
import { runSummaryStep } from './steps/summary'
import { runWalletStep } from './steps/wallet'
import { runWelcomeStep } from './steps/welcome'

const log = logger.child({ module: 'init' })

export type WizardOpts = {
  mode?: WizardMode
  /** Skip the KeeperHub OAuth step entirely (e.g. KH not provisioned yet). */
  skipKeeperhub?: boolean
  /** Skip the service-install step (auto-true in non-interactive). */
  skipService?: boolean
  /** Override paths (tests). */
  paths?: typeof defaultPaths
  /** Override prompter (tests). */
  prompter?: Prompter
  /** Force the idempotency choice — bypasses the existing-config prompt. */
  forceIdempotency?: IdempotencyChoice
  /** Print sink (default stdout). */
  print?: (line: string) => void
}

export type WizardResult = {
  context: WizardContext
  succeeded: boolean
}

/**
 * Top-level orchestrator. Detects existing config → prompts on overlap →
 * runs each step in spec order → prints summary. Step failures throw and
 * abort; OAuth has graceful skip baked in. Output is line-oriented prints
 * (not the structured logger) so the user sees a coherent terminal flow.
 */
export async function runWizard(opts: WizardOpts = {}): Promise<WizardResult> {
  const mode: WizardMode = opts.mode ?? 'interactive'
  const paths = opts.paths ?? defaultPaths
  const prompter = opts.prompter ?? (mode === 'interactive' ? interactivePrompter : noPrompter)
  const print = opts.print ?? ((l: string) => process.stdout.write(`${l}\n`))

  const existing = detectExisting(paths)
  const idempotency = await chooseIdempotency({
    mode,
    existing,
    prompter,
    forced: opts.forceIdempotency,
    print,
  })

  const ctx: WizardContext = {
    mode,
    paths,
    skipKeeperhub: opts.skipKeeperhub ?? false,
    skipService: opts.skipService ?? mode === 'non-interactive',
    existing,
    idempotency,
    results: {},
  }

  try {
    runWelcomeStep(ctx, { log: print })
    await runStep(ctx, 'openai-key', () => runOpenAiKeyStep(ctx, { prompter }))
    await runStep(ctx, 'wallet', () => runWalletStep(ctx, { prompter, log: print }))
    await runStep(ctx, 'keeperhub-oauth', () => runKeeperhubOauthStep(ctx, { prompter, print }))
    await runStep(ctx, 'channels', () => runChannelsStep(ctx, { prompter }))
    await runStep(ctx, 'daemon-token', () => runDaemonTokenStep(ctx))
    await runStep(ctx, 'migrations', () => runMigrationsStep(ctx))
    await runStep(ctx, 'service', () => runServiceStep(ctx, { prompter, print }))
    runSummaryStep(ctx, { print })
    return { context: ctx, succeeded: true }
  } catch (err) {
    log.error({ err }, 'init wizard failed')
    print('')
    print(`  init failed: ${err instanceof Error ? err.message : String(err)}`)
    print('  Re-run `talos init` once you fix the issue. Already-completed steps will be detected.')
    return { context: ctx, succeeded: false }
  }
}

async function runStep(
  ctx: WizardContext,
  name: StepName,
  fn: () => Promise<StepResult> | StepResult,
): Promise<void> {
  const result = await fn()
  ctx.results[name] = result
  log.info(
    { step: name, status: result.status },
    `step ${name}: ${result.status}${result.summary ? ` — ${result.summary}` : ''}`,
  )
}

async function chooseIdempotency(opts: {
  mode: WizardMode
  existing: ExistingState
  prompter: Prompter
  forced?: IdempotencyChoice
  print: (line: string) => void
}): Promise<IdempotencyChoice> {
  if (opts.forced) return opts.forced
  if (opts.existing.empty) return 'reset' // Fresh install — no overlap, all steps generate.
  if (opts.mode === 'non-interactive') return 'keep'

  const summary = describeExisting(opts.existing)
  opts.print('')
  opts.print('  Existing Talos config detected:')
  for (const line of summary) opts.print(`    - ${line}`)
  opts.print('')

  return opts.prompter.select<IdempotencyChoice>({
    message: 'How should we handle the existing config?',
    choices: [
      {
        name: 'keep',
        value: 'keep',
        description: 'preserve existing files; only generate what is missing',
      },
      {
        name: 'reset',
        value: 'reset',
        description: 'overwrite everything (loses keys, mnemonic, KH session)',
      },
      {
        name: 'partial-oauth-only',
        value: 'partial-oauth-only',
        description: 'preserve everything except KeeperHub session (re-do OAuth)',
      },
    ],
    default: 'keep',
  })
}

function describeExisting(s: ExistingState): string[] {
  const out: string[] = []
  if (s.envFile) out.push(`.env (${s.envHasOpenAiKey ? 'has' : 'no'} OPENAI_API_KEY)`)
  if (s.burnerWallet) out.push('burner.json (wallet)')
  if (s.keeperhubToken) out.push('keeperhub.token (OAuth session)')
  if (s.daemonToken) out.push('daemon.token')
  if (s.channelsConfig) out.push('channels.yaml')
  return out
}
