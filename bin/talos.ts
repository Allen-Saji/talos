#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { runRepl, runStdioMcpProxy } from '@/channels'
import { paths } from '@/config/paths'
import { ensureToken } from '@/config/token'
import {
  ensureDaemonRunning,
  formatDiagnostics,
  renderServiceArtifact,
  runDiagnostics,
  writeServiceArtifact,
} from '@/daemon'
import { assertNoLiveDaemon, createDb, runMigrations } from '@/persistence'
import { TalosNotImplementedError } from '@/shared/errors'
import { logger } from '@/shared/logger'

const program = new Command()

program.name('talos').description('Vertical ETH agent — daemon + thin clients').version('0.1.0')

program
  .command('init')
  .description('Bootstrap a new Talos installation')
  .action(() => {
    logger.info('init: not implemented')
    throw new TalosNotImplementedError('talos init')
  })

program
  .command('install-service')
  .description('Install talosd as launchd (macOS) or systemd user service (Linux)')
  .option('--print', 'render the service file to stdout without writing')
  .option('--bin <path>', 'override talosd binary path (default: resolve from this script)')
  .action((opts: { print?: boolean; bin?: string }) => {
    const binPath = opts.bin ?? path.resolve(path.dirname(process.argv[1] ?? ''), 'talosd.js')
    const artifact = renderServiceArtifact({ binPath })
    if (opts.print) {
      process.stdout.write(artifact.body)
      return
    }
    writeServiceArtifact(artifact)
    logger.info({ servicePath: artifact.servicePath }, 'service file written')
    process.stdout.write(`\nNext steps:\n${artifact.followups.map((c) => `  ${c}`).join('\n')}\n`)
  })

program
  .command('doctor')
  .description('Diagnose the current Talos installation')
  .action(async () => {
    const results = await runDiagnostics()
    process.stdout.write(`${formatDiagnostics(results)}\n`)
    const allPass = results.every((r) => r.pass)
    process.exit(allPass ? 0 : 1)
  })

program
  .command('repl')
  .description('Open an interactive REPL connected to talosd')
  .option('--port <number>', 'daemon port', (v) => Number.parseInt(v, 10))
  .option('--no-autostart', 'do not auto-spawn talosd if not running')
  .action(async (opts: { port?: number; autostart?: boolean }) => {
    const port = opts.port ?? Number(process.env.TALOS_DAEMON_PORT ?? 7711)
    const url = `ws://127.0.0.1:${port}`
    if (opts.autostart !== false) {
      await ensureDaemonRunning({ url })
    }
    const token = await ensureToken()
    const result = await runRepl({ daemonUrl: url, token })
    process.exit(result.exitCode)
  })

program
  .command('serve')
  .description('Run a Talos channel adapter on stdin/stdout')
  .option('--mcp', 'serve as a stdio MCP server (proxies into talosd)')
  .option('--port <number>', 'daemon port', (v) => Number.parseInt(v, 10))
  .option('--no-autostart', 'do not auto-spawn talosd if not running')
  .action(async (opts: { mcp?: boolean; port?: number; autostart?: boolean }) => {
    if (!opts.mcp) {
      throw new TalosNotImplementedError('talos serve (no adapter selected — pass --mcp)')
    }
    const port = opts.port ?? Number(process.env.TALOS_DAEMON_PORT ?? 7711)
    const url = `ws://127.0.0.1:${port}`
    if (opts.autostart !== false) {
      await ensureDaemonRunning({ url })
    }
    const token = await ensureToken()
    await runStdioMcpProxy({ daemonUrl: url, token })
  })

program
  .command('migrate')
  .description('Run database migrations against the local PGLite store')
  .action(async () => {
    assertNoLiveDaemon()
    fs.mkdirSync(paths.dataDir, { recursive: true })
    const handle = await createDb({ path: paths.dbPath })
    try {
      await runMigrations(handle)
      logger.info({ dbPath: paths.dbPath }, 'migrations applied')
    } finally {
      await handle.close()
    }
  })

program.parseAsync().catch((err) => {
  if (err instanceof TalosNotImplementedError) {
    logger.warn({ err: err.message }, 'feature stub')
    process.exit(2)
  }
  logger.error({ err }, 'command failed')
  process.exit(1)
})
