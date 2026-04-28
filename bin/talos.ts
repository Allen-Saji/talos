#!/usr/bin/env node
import { Command } from 'commander'
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
  .description('Install talosd as launchd or systemd user service')
  .action(() => {
    logger.info('install-service: not implemented')
    throw new TalosNotImplementedError('talos install-service')
  })

program
  .command('doctor')
  .description('Diagnose the current Talos installation')
  .action(() => {
    logger.info('doctor: not implemented')
    throw new TalosNotImplementedError('talos doctor')
  })

program
  .command('repl')
  .description('Open an interactive REPL connected to talosd')
  .action(() => {
    logger.info('repl: not implemented')
    throw new TalosNotImplementedError('talos repl')
  })

program
  .command('migrate')
  .description('Run database migrations against the local PGLite store')
  .action(() => {
    logger.info('migrate: not implemented')
    throw new TalosNotImplementedError('talos migrate')
  })

program.parseAsync().catch((err) => {
  if (err instanceof TalosNotImplementedError) {
    logger.warn({ err: err.message }, 'feature stub')
    process.exit(2)
  }
  logger.error({ err }, 'command failed')
  process.exit(1)
})
