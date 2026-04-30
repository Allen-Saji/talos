import path from 'node:path'
import { renderServiceArtifact, writeServiceArtifact } from '@/daemon/install-service'
import type { StepResult, WizardContext } from '../context'
import type { Prompter } from '../prompt'

export type ServiceStepDeps = {
  prompter: Prompter
  /** Override the talosd binary path (tests + dev). */
  binPath?: string
  /** Print sink (default stdout). */
  print?: (line: string) => void
}

/**
 * Offer to install talosd as a launchd / systemd user service. Optional —
 * the wizard prompts; user can skip and run `talos install-service` later.
 *
 * Skipped automatically in non-interactive mode and when `ctx.skipService`.
 */
export async function runServiceStep(
  ctx: WizardContext,
  deps: ServiceStepDeps,
): Promise<StepResult> {
  const print = deps.print ?? ((l: string) => process.stdout.write(`${l}\n`))

  if (ctx.skipService || ctx.mode === 'non-interactive') {
    return {
      status: 'skipped',
      summary: 'Service install skipped (run `talos install-service` to install later)',
    }
  }

  const install = await deps.prompter.confirm({
    message: 'Install talosd as a launchd / systemd user service now?',
    default: false,
  })
  if (!install) {
    return {
      status: 'skipped',
      summary: 'Service install skipped (run `talos install-service` to install later)',
    }
  }

  // Resolve the talosd binary path. In dev, this resolves to the built
  // dist/bin/talosd.js next to talos.js. Tests can override via deps.
  const binPath = deps.binPath ?? path.resolve(path.dirname(process.argv[1] ?? ''), 'talosd.js')

  const artifact = renderServiceArtifact({ binPath })
  writeServiceArtifact(artifact)
  print(`  Service file written: ${artifact.servicePath}`)
  print('  Next steps:')
  for (const line of artifact.followups) print(`    ${line}`)
  return {
    status: 'done',
    summary: `Service file written (${artifact.servicePath})`,
    data: { servicePath: artifact.servicePath },
  }
}
