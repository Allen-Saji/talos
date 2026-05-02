import type { StepResult, WizardContext } from '../context'

export type SummaryStepDeps = {
  print?: (line: string) => void
}

/**
 * Final printout: addresses, paths, next-step commands. No emojis (per Allen's
 * preference); no jargon. Lifts pre-computed `summary` strings off each
 * step's result so we don't reach back into raw config.
 */
export function runSummaryStep(ctx: WizardContext, deps: SummaryStepDeps = {}): StepResult {
  const print = deps.print ?? ((l: string) => process.stdout.write(`${l}\n`))

  print('')
  print('  Talos init complete')
  print('  ----------------------------------------')
  for (const step of [
    'openai-key',
    'wallet',
    'keeperhub-oauth',
    'channels',
    'daemon-token',
    'migrations',
    'service',
  ] as const) {
    const r = ctx.results[step]
    if (!r) continue
    const tag = r.status === 'done' ? 'OK' : r.status === 'kept' ? 'kept' : 'skipped'
    print(`  [${tag.padEnd(7)}] ${r.summary ?? step}`)
  }
  print('')
  print('  Next steps:')
  print('    talos repl                 # interactive chat with the agent')
  print('    talos knowledge:refresh    # force the knowledge cron now')
  print('    talos doctor               # diagnose any misconfig')
  if (!ctx.results.service || ctx.results.service.status !== 'done') {
    print('    talos install-service      # run as a background service')
  }
  print('')
  print('  Try this in the REPL:')
  print('    > what is my balance on sepolia?')
  print('    > supply 0.0001 USDC to aave on sepolia')
  print('    > what changed in the eth ecosystem since yesterday?')
  print('')
  print('  Embed Talos in another agent host:')
  print('    Claude Desktop / Cursor / OpenClaw — see docs/channels/mcp')
  print('    Direct stdio:                       talos serve --mcp')
  print('')

  return { status: 'done', summary: 'Summary printed' }
}
