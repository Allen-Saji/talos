import fs from 'node:fs'
import path from 'node:path'
import { paths as defaultPaths, type Paths } from '@/config/paths'
import { TalosDbError } from '@/shared/errors'

export type OwnershipCheckOptions = {
  paths?: Pick<Paths, 'pidPath' | 'dbPath'>
  selfPid?: number
}

/**
 * Refuse to open the file-backed DB if `paths.pidPath` exists with a live process
 * that is not us. PGLite is single-writer; the daemon owns at runtime, one-shots
 * (migrate, doctor, init) only run when the daemon is stopped.
 */
export function assertNoLiveDaemon(opts: OwnershipCheckOptions = {}): void {
  const paths = opts.paths ?? defaultPaths
  const selfPid = opts.selfPid ?? process.pid

  let raw: string
  try {
    raw = fs.readFileSync(paths.pidPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new TalosDbError(
      `failed to read pidfile at ${paths.pidPath}`,
      'DB_PIDFILE_READ_FAILED',
      err,
    )
  }

  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) {
    fs.rmSync(paths.pidPath, { force: true })
    return
  }

  if (pid === selfPid) return

  if (isAlive(pid)) {
    throw new TalosDbError(
      `daemon (pid ${pid}) holds ${paths.dbPath}; stop it first: \`talos stop\``,
      'DB_DAEMON_OWNS',
    )
  }

  fs.rmSync(paths.pidPath, { force: true })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw err
  }
}

/**
 * Write the current process pid to `paths.pidPath`. Creates the parent
 * directory if missing. Atomic-ish via fs.writeFileSync (PGLite ownership
 * model only ever has one writer; race is not a real concern).
 */
export function writePidFile(opts: { paths?: Pick<Paths, 'pidPath'>; pid?: number } = {}): void {
  const target = (opts.paths ?? defaultPaths).pidPath
  const pid = opts.pid ?? process.pid
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${pid}\n`, { mode: 0o644 })
}

/** Remove the pidfile if present. Idempotent — safe to call from cleanup paths. */
export function removePidFile(opts: { paths?: Pick<Paths, 'pidPath'> } = {}): void {
  const target = (opts.paths ?? defaultPaths).pidPath
  fs.rmSync(target, { force: true })
}
