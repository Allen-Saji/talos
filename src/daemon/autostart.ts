import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { paths as defaultPaths, type Paths } from '@/config/paths'
import { child } from '@/shared/logger'

const log = child({ module: 'autostart' })

const DEFAULT_PROBE_TIMEOUT_MS = 1_000
const DEFAULT_BOOT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 200

export type EnsureDaemonOpts = {
  /** WS URL we'd connect to. */
  url: string
  /** Override paths (testing). */
  paths?: Pick<Paths, 'pidPath' | 'logPath'>
  /** Override the talosd binary path. Default: best-effort search. */
  binPath?: string
  /** Override Node argv to spawn talosd via tsx (dev-mode). */
  tsxScriptPath?: string
  /** Total wait window after spawn. */
  bootTimeoutMs?: number
  /** Per-probe timeout. */
  probeTimeoutMs?: number
  /** Override spawner — used by tests. */
  spawner?: (cmd: string, args: string[], options: Record<string, unknown>) => ChildProcess
}

export type EnsureDaemonResult =
  | { state: 'already-running' }
  | { state: 'started'; pid: number; binPath: string }

/**
 * Ensure a talosd daemon is reachable on `url`. If the daemon is already
 * running (PID file present + process alive + WS responds), no-ops.
 * Otherwise spawns talosd detached and polls the WS until ready, up to
 * `bootTimeoutMs`. Throws if the daemon can't be brought up.
 */
export async function ensureDaemonRunning(opts: EnsureDaemonOpts): Promise<EnsureDaemonResult> {
  const paths = opts.paths ?? defaultPaths
  const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  if (await probeDaemon(opts.url, probeTimeoutMs)) {
    return { state: 'already-running' }
  }

  const pidFromFile = readPidFile(paths.pidPath)
  if (pidFromFile && isAlive(pidFromFile)) {
    // Daemon is running but WS didn't respond yet — likely still booting.
    // Poll-only — don't spawn another instance.
    const ok = await pollUntilReady(opts.url, bootTimeoutMs, probeTimeoutMs)
    if (!ok) {
      throw new Error(
        `talosd (pid ${pidFromFile}) running but unreachable at ${opts.url} after ${bootTimeoutMs}ms`,
      )
    }
    return { state: 'already-running' }
  }

  const binPath = opts.binPath ?? resolveTalosdBin()
  const spawner = opts.spawner ?? spawn

  const stdoutLog = fs.openSync(paths.logPath, 'a')
  const stderrLog = fs.openSync(paths.logPath, 'a')

  const child = spawner(binPath, [], {
    detached: true,
    stdio: ['ignore', stdoutLog, stderrLog],
    env: process.env,
  })
  child.unref()
  const pid = child.pid ?? 0
  log.info({ pid, binPath }, 'spawned talosd; waiting for WS to come up')

  const ok = await pollUntilReady(opts.url, bootTimeoutMs, probeTimeoutMs)
  if (!ok) {
    throw new Error(`talosd (pid ${pid}) failed to come up at ${opts.url} in ${bootTimeoutMs}ms`)
  }

  return { state: 'started', pid, binPath }
}

async function probeDaemon(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      try {
        ws.removeAllListeners()
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    ws.once('open', () => {
      cleanup()
      resolve(true)
    })
    ws.once('error', () => {
      cleanup()
      resolve(false)
    })
  })
}

async function pollUntilReady(
  url: string,
  bootTimeoutMs: number,
  probeTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + bootTimeoutMs
  while (Date.now() < deadline) {
    if (await probeDaemon(url, probeTimeoutMs)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, remaining)))
  }
  return false
}

function readPidFile(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return false
  }
}

function resolveTalosdBin(): string {
  // Resolve relative to the running script. After build the binaries end up
  // at dist/bin/talos.js + dist/bin/talosd.js. In dev (tsx) we resolve via
  // the bin dir of the current process.
  const argv1 = process.argv[1] ?? ''
  const here = path.dirname(argv1)
  const candidates = [
    path.join(here, 'talosd.js'),
    path.join(here, 'talosd'),
    path.resolve(here, '..', 'bin', 'talosd.js'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Last resort: assume on PATH.
  return 'talosd'
}
