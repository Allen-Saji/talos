import fs from 'node:fs'
import { assertNoLiveDaemon, createDb, runMigrations } from '@/persistence'
import type { StepResult, WizardContext } from '../context'

export type MigrationsStepDeps = {
  /** Test seam — skip the actual DB work. */
  skipForTest?: boolean
}

/**
 * Apply DB migrations against the local PGLite store. Per architecture
 * decision #23, init opens PGLite directly only when the daemon is stopped
 * — `assertNoLiveDaemon` enforces this, throwing if a daemon is up.
 *
 * Idempotent — `runMigrations` is a no-op when schema is current.
 */
export async function runMigrationsStep(
  ctx: WizardContext,
  deps: MigrationsStepDeps = {},
): Promise<StepResult> {
  if (deps.skipForTest) {
    return { status: 'skipped', summary: 'Migrations skipped (test)' }
  }

  assertNoLiveDaemon()
  fs.mkdirSync(ctx.paths.dataDir, { recursive: true })
  const handle = await createDb({ path: ctx.paths.dbPath })
  try {
    await runMigrations(handle)
    return {
      status: 'done',
      summary: `Migrations applied (${ctx.paths.dbPath})`,
      data: { dbPath: ctx.paths.dbPath },
    }
  } finally {
    await handle.close()
  }
}
