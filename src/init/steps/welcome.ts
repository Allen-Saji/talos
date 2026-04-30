import type { WizardContext } from '../context'

const MIN_NODE_MAJOR = 22

const BANNER = [
  '',
  '  Talos init — vertical Ethereum agent',
  '  ----------------------------------------',
  '  This wizard will set up:',
  '    - OpenAI API key',
  '    - Wallet (fresh burner with mnemonic)',
  '    - KeeperHub OAuth session',
  '    - Channels (CLI / Telegram / MCP-server)',
  '    - Daemon token + database',
  '    - Optional: launchd / systemd service install',
  '',
  '  Estimated time: under 60 seconds.',
  '',
].join('\n')

export type WelcomeDeps = {
  log?: (line: string) => void
  nodeVersion?: string
}

export function runWelcomeStep(_ctx: WizardContext, deps: WelcomeDeps = {}): void {
  const log = deps.log ?? ((l: string) => process.stdout.write(`${l}\n`))
  const version = deps.nodeVersion ?? process.versions.node
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10)

  log(BANNER)

  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `node ${version} is below the minimum (>= ${MIN_NODE_MAJOR}). Switch via nvm and rerun.`,
    )
  }
  log(`  Node ${version} OK`)
  log('')
}
