import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { TalosDbError } from '@/shared/errors'
import type { DbHandle } from './client'

const here = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_FOLDER = path.resolve(here, '..', '..', 'drizzle')

export type RunMigrationsOptions = {
  migrationsFolder?: string
}

export async function runMigrations(
  handle: Pick<DbHandle, 'db'>,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  const folder = opts.migrationsFolder ?? DEFAULT_FOLDER
  try {
    await migrate(handle.db, { migrationsFolder: folder })
  } catch (err) {
    throw new TalosDbError(
      `migrations failed (folder=${folder}): ${(err as Error).message}`,
      'DB_MIGRATE_FAILED',
      err,
    )
  }
}
