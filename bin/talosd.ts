#!/usr/bin/env node
import { loadEnv } from '@/config/env'
import { paths } from '@/config/paths'
import { logger } from '@/shared/logger'

async function main(): Promise<void> {
  const env = loadEnv()
  logger.info(
    {
      port: env.TALOS_DAEMON_PORT,
      configDir: paths.configDir,
      dataDir: paths.dataDir,
    },
    'talosd booting',
  )
  logger.warn('talosd: control plane not yet implemented')
  process.exit(0)
}

main().catch((err) => {
  logger.error({ err }, 'talosd failed')
  process.exit(1)
})
