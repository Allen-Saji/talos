#!/usr/bin/env node
import { startDaemon } from '@/daemon'
import { logger } from '@/shared/logger'

async function main(): Promise<void> {
  const handle = await startDaemon()
  await handle.done
  process.exit(0)
}

main().catch((err) => {
  logger.error({ err }, 'talosd failed')
  process.exit(1)
})
