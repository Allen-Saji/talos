import fs from 'node:fs'
import { WebSocket } from 'ws'
import { paths } from '@/config/paths'
import { ensureToken } from '@/config/token'
import { isExpired, loadSession } from '@/keeperhub/token'
import { createDb, runMigrations } from '@/persistence'
import {
  type ClientFrame,
  type ServerFrame,
  ServerFrame as ServerFrameSchema,
} from '@/protocol/frames'

export type DiagnosticResult = {
  name: string
  pass: boolean
  detail: string
}

export type RunDiagnosticsOpts = {
  /** Override the daemon address — defaults to `ws://127.0.0.1:${port}`. */
  daemonUrl?: string
  /** Daemon port; defaults to env or 7711. */
  port?: number
  /** Bound timeout for the daemon-responding probe. */
  daemonTimeoutMs?: number
}

const DEFAULT_DAEMON_TIMEOUT_MS = 3_000

export async function runDiagnostics(opts: RunDiagnosticsOpts = {}): Promise<DiagnosticResult[]> {
  const port = opts.port ?? Number(process.env.TALOS_DAEMON_PORT ?? 7711)
  const daemonUrl = opts.daemonUrl ?? `ws://127.0.0.1:${port}`
  const daemonTimeoutMs = opts.daemonTimeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS

  const results: DiagnosticResult[] = []
  results.push(await checkDb())
  results.push(await checkDaemon(daemonUrl, daemonTimeoutMs))
  results.push(await checkKeeperHub())
  return results
}

async function checkDb(): Promise<DiagnosticResult> {
  const dbPath = paths.dbPath
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'db',
      pass: false,
      detail: `db not initialized at ${dbPath}; run \`talos migrate\``,
    }
  }
  try {
    // Daemon owns the file-backed DB at runtime — touching it would fight that.
    // Probe with a brief ephemeral connection running the (idempotent) migrator.
    const handle = await createDb({ ephemeral: true })
    try {
      await runMigrations(handle)
      return {
        name: 'db',
        pass: true,
        detail: `migrations replay clean (probed via ephemeral PGLite)`,
      }
    } finally {
      await handle.close()
    }
  } catch (err) {
    return {
      name: 'db',
      pass: false,
      detail: `db probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkDaemon(url: string, timeoutMs: number): Promise<DiagnosticResult> {
  let token: string
  try {
    token = await ensureToken()
  } catch (err) {
    return {
      name: 'daemon',
      pass: false,
      detail: `token unreadable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return new Promise<DiagnosticResult>((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve({ name: 'daemon', pass: false, detail: `no response from ${url} in ${timeoutMs}ms` })
    }, timeoutMs)

    ws.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        name: 'daemon',
        pass: false,
        detail: `${url} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      })
    })

    ws.on('open', () => {
      const hello: ClientFrame = { type: 'hello', version: '0.1.0', client: 'talos-doctor' }
      ws.send(JSON.stringify(hello))
      const auth: ClientFrame = { type: 'auth', token }
      ws.send(JSON.stringify(auth))
    })

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8')
      let parsed: ServerFrame | null = null
      try {
        const json = JSON.parse(text)
        const result = ServerFrameSchema.safeParse(json)
        parsed = result.success ? result.data : null
      } catch {
        parsed = null
      }
      if (parsed && parsed.type === 'hello-ack') {
        clearTimeout(timer)
        ws.close()
        resolve({
          name: 'daemon',
          pass: true,
          detail: `hello-ack from ${url} (server ${parsed.version})`,
        })
      }
    })
  })
}

async function checkKeeperHub(): Promise<DiagnosticResult> {
  const tokenPath = paths.keeperhubTokenPath
  if (!fs.existsSync(tokenPath)) {
    return {
      name: 'keeperhub',
      pass: false,
      detail: `no session at ${tokenPath}; run \`talos init\` to authorize`,
    }
  }
  try {
    const session = await loadSession(tokenPath)
    if (!session) {
      return {
        name: 'keeperhub',
        pass: false,
        detail: 'session file present but empty',
      }
    }
    if (isExpired(session) && !session.refreshToken) {
      return {
        name: 'keeperhub',
        pass: false,
        detail: 'access token expired and no refresh_token — re-run `talos init`',
      }
    }
    return {
      name: 'keeperhub',
      pass: true,
      detail: `session for client ${session.client.client_id} (expires ${new Date(session.expiresAt).toISOString()})`,
    }
  } catch (err) {
    return {
      name: 'keeperhub',
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Pretty-print diagnostic results as a fixed-width table for console output. */
export function formatDiagnostics(results: DiagnosticResult[]): string {
  const nameW = Math.max(4, ...results.map((r) => r.name.length))
  const lines = results.map((r) => {
    const mark = r.pass ? 'PASS' : 'FAIL'
    return `${mark}  ${r.name.padEnd(nameW)}  ${r.detail}`
  })
  return lines.join('\n')
}
