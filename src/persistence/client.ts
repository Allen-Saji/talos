import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { drizzle } from 'drizzle-orm/pglite'
import { TalosDbError } from '@/shared/errors'

export type DbHandle = {
  pg: PGlite
  db: ReturnType<typeof drizzle>
  close: () => Promise<void>
}

export type CreateDbOptions =
  | { ephemeral: true; path?: never }
  | { ephemeral?: false; path: string }

export async function createDb(opts: CreateDbOptions): Promise<DbHandle> {
  const dataDir = opts.ephemeral ? 'memory://' : opts.path
  if (!dataDir) {
    throw new TalosDbError('createDb: path required when ephemeral=false', 'DB_BAD_OPTIONS')
  }
  const pg = await PGlite.create({ dataDir, extensions: { vector } })
  const db = drizzle({ client: pg })
  return {
    pg,
    db,
    close: async () => {
      await pg.close()
    },
  }
}
