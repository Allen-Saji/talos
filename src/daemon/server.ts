import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  type ClientFrame,
  ClientFrame as ClientFrameSchema,
  PROTOCOL_VERSION,
  type ServerFrame,
} from '@/protocol/frames'
import type { AgentRuntime } from '@/runtime/types'
import { child } from '@/shared/logger'
import { streamRunToWs } from './runs'

const log = child({ module: 'daemon-server' })

const DEFAULT_HOST = '127.0.0.1'

/**
 * Optional knowledge controller: when present, the control plane handles
 * `knowledge-refresh` frames by invoking `refresh()` and replying with a
 * `knowledge-refresh-done` frame. When absent, refresh requests get an
 * `error` frame with code `KNOWLEDGE_DISABLED`.
 */
export type KnowledgeController = {
  refresh(): Promise<{
    startedAt: string
    finishedAt: string
    totalDurationMs: number
    sources: Array<{
      source: string
      fetched: number
      chunks: number
      durationMs: number
      error?: string
    }>
  }>
}

export type ControlPlaneOpts = {
  runtime: AgentRuntime
  /** Bearer token clients must present in the auth frame. */
  token: string
  /** TCP port; pass 0 for an ephemeral port (tests). */
  port: number
  /** Host to bind to. Default 127.0.0.1 — refuse to listen elsewhere by default. */
  host?: string
  /** Default channel id reported to the runtime when a client doesn't supply one. */
  defaultChannel?: string
  /** Optional knowledge controller; required to handle `knowledge-refresh` frames. */
  knowledge?: KnowledgeController
}

export type ControlPlane = {
  /** Bind the WS server. Resolves to the actual port (useful when port=0). */
  start(): Promise<{ port: number; host: string }>
  /** Stop accepting connections, abort inflight runs, close server. */
  stop(opts?: { drainTimeoutMs?: number }): Promise<void>
  /** Number of currently-open connections. Useful for tests. */
  connectionCount(): number
  /** Total inflight runs across all connections. Useful for tests. */
  inflightRunCount(): number
}

type Connection = {
  ws: WebSocket
  helloed: boolean
  authenticated: boolean
  inflight: Map<string, AbortController>
  pending: Set<Promise<void>>
}

const DEFAULT_DRAIN_MS = 30_000

export function createControlPlane(opts: ControlPlaneOpts): ControlPlane {
  const host = opts.host ?? DEFAULT_HOST
  const defaultChannel = opts.defaultChannel ?? 'ws'
  const wss = new WebSocketServer({ port: opts.port, host })
  const conns = new Set<Connection>()

  wss.on('connection', (ws) => {
    const conn: Connection = {
      ws,
      helloed: false,
      authenticated: false,
      inflight: new Map(),
      pending: new Set(),
    }
    conns.add(conn)

    ws.on('message', (raw) => {
      void handleMessage(conn, raw)
    })
    ws.on('close', () => {
      // Abort any runs still in flight for this connection.
      for (const ac of conn.inflight.values()) ac.abort()
      conn.inflight.clear()
      conns.delete(conn)
    })
    ws.on('error', (err) => {
      log.warn({ err }, 'connection error')
    })
  })

  async function handleMessage(conn: Connection, raw: WebSocket.RawData): Promise<void> {
    const parsed = parseClientFrame(raw)
    if (!parsed.ok) {
      sendError(conn, 'INVALID_FRAME', parsed.error)
      return
    }
    const frame = parsed.frame

    if (frame.type === 'hello') {
      if (conn.helloed) {
        sendError(conn, 'HELLO_REPEAT', 'hello already received')
        return
      }
      conn.helloed = true
      send(conn, {
        type: 'hello-ack',
        version: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
      })
      return
    }

    if (frame.type === 'auth') {
      if (!conn.helloed) {
        sendError(conn, 'AUTH_BEFORE_HELLO', 'send hello first')
        return
      }
      if (conn.authenticated) {
        sendError(conn, 'AUTH_REPEAT', 'already authenticated')
        return
      }
      if (!constantTimeEqual(frame.token, opts.token)) {
        sendError(conn, 'AUTH_FAILED', 'invalid token')
        conn.ws.close(4401, 'auth failed')
        return
      }
      conn.authenticated = true
      return
    }

    if (!conn.authenticated) {
      sendError(conn, 'NOT_AUTHENTICATED', 'auth before issuing runs')
      conn.ws.close(4401, 'unauthenticated')
      return
    }

    if (frame.type === 'run-start') {
      await startRun(conn, frame)
      return
    }

    if (frame.type === 'run-cancel') {
      const ac = conn.inflight.get(frame.runId)
      if (!ac) {
        sendError(conn, 'UNKNOWN_RUN', `no inflight run ${frame.runId}`, frame.runId)
        return
      }
      ac.abort()
      return
    }

    if (frame.type === 'knowledge-refresh') {
      await handleKnowledgeRefresh(conn, frame.requestId)
      return
    }
  }

  async function handleKnowledgeRefresh(conn: Connection, requestId: string): Promise<void> {
    if (!opts.knowledge) {
      sendRequestError(conn, 'KNOWLEDGE_DISABLED', 'knowledge controller not wired', requestId)
      return
    }
    const task = (async () => {
      try {
        const report = await opts.knowledge!.refresh()
        send(conn, {
          type: 'knowledge-refresh-done',
          requestId,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          totalDurationMs: report.totalDurationMs,
          sources: report.sources.map((s) => ({
            source: s.source,
            fetched: s.fetched,
            chunks: s.chunks,
            durationMs: s.durationMs,
            ...(s.error ? { error: s.error } : {}),
          })),
        })
      } catch (err) {
        sendRequestError(
          conn,
          'KNOWLEDGE_REFRESH_FAILED',
          err instanceof Error ? err.message : String(err),
          requestId,
        )
      }
    })()
    conn.pending.add(task)
    task.finally(() => conn.pending.delete(task))
  }

  async function startRun(
    conn: Connection,
    frame: Extract<ClientFrame, { type: 'run-start' }>,
  ): Promise<void> {
    const ac = new AbortController()
    let handle: Awaited<ReturnType<AgentRuntime['run']>>
    try {
      handle = await opts.runtime.run({
        threadId: frame.threadId,
        channel: defaultChannel,
        intent: frame.prompt,
        abortSignal: ac.signal,
      })
    } catch (err) {
      sendError(conn, 'RUN_START_FAILED', err instanceof Error ? err.message : String(err))
      return
    }

    conn.inflight.set(handle.runId, ac)
    const task = streamRunToWs({
      handle,
      send: (f) => send(conn, f),
    })
      .catch((err) => {
        log.warn({ err, runId: handle.runId }, 'run streamer failed')
        sendError(
          conn,
          'RUN_FAILED',
          err instanceof Error ? err.message : String(err),
          handle.runId,
        )
      })
      .finally(() => {
        conn.inflight.delete(handle.runId)
      })
    conn.pending.add(task)
    task.finally(() => conn.pending.delete(task))
  }

  function send(conn: Connection, frame: ServerFrame): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    try {
      conn.ws.send(JSON.stringify(frame))
    } catch (err) {
      log.warn({ err }, 'failed to send frame')
    }
  }

  function sendError(conn: Connection, code: string, message: string, runId?: string): void {
    send(conn, runId ? { type: 'error', code, message, runId } : { type: 'error', code, message })
  }

  function sendRequestError(
    conn: Connection,
    code: string,
    message: string,
    requestId: string,
  ): void {
    send(conn, { type: 'error', code, message, requestId })
  }

  return {
    async start(): Promise<{ port: number; host: string }> {
      if (wss.address()) {
        const addr = wss.address() as AddressInfo
        return { port: addr.port, host: addr.address }
      }
      return new Promise((resolve, reject) => {
        const onError = (err: unknown) => {
          wss.off('listening', onListening)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        const onListening = () => {
          wss.off('error', onError)
          const addr = wss.address() as AddressInfo
          log.info({ port: addr.port, host: addr.address }, 'control plane listening')
          resolve({ port: addr.port, host: addr.address })
        }
        wss.once('error', onError)
        wss.once('listening', onListening)
      })
    },

    async stop(stopOpts: { drainTimeoutMs?: number } = {}): Promise<void> {
      const timeoutMs = stopOpts.drainTimeoutMs ?? DEFAULT_DRAIN_MS
      // Stop accepting new connections immediately.
      wss.close()

      // Abort all inflight runs across all connections.
      for (const conn of conns) {
        for (const ac of conn.inflight.values()) ac.abort()
      }

      // Drain pending streamer tasks with a hard deadline.
      const allPending = Array.from(conns).flatMap((c) => Array.from(c.pending))
      await Promise.race([
        Promise.allSettled(allPending),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ])

      // Close any still-open sockets.
      for (const conn of conns) {
        try {
          conn.ws.close(1001, 'shutdown')
        } catch {
          /* ignore */
        }
      }
      conns.clear()
    },

    connectionCount(): number {
      return conns.size
    },

    inflightRunCount(): number {
      let total = 0
      for (const conn of conns) total += conn.inflight.size
      return total
    },
  }
}

type ParseResult = { ok: true; frame: ClientFrame } | { ok: false; error: string }

function parseClientFrame(raw: WebSocket.RawData): ParseResult {
  let text: string
  try {
    text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  } catch {
    return { ok: false, error: 'frame decode failed' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'frame is not JSON' }
  }
  const result = ClientFrameSchema.safeParse(json)
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') }
  }
  return { ok: true, frame: result.data }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
