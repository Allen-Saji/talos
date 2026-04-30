import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  type ClientFrame,
  type KnowledgeRefreshDoneFrame,
  PROTOCOL_VERSION,
  type RunDoneFrame,
  ServerFrame as ServerFrameSchema,
} from '@/protocol/frames'
import { child } from '@/shared/logger'

const log = child({ module: 'ws-client' })

export type DaemonClientOpts = {
  /** Daemon WS URL, e.g. `ws://127.0.0.1:7711`. */
  url: string
  /** Bearer token (read from `~/.config/talos/daemon.token`). */
  token: string
  /** Client name reported in the hello frame. */
  client?: string
  /** Hello-ack timeout. */
  helloTimeoutMs?: number
}

export type RunStartOpts = {
  threadId: string
  prompt: string
  metadata?: Record<string, unknown>
}

export type RunStream = {
  /** Stream of `run-event` payloads (Vercel AI SDK `TextStreamPart`s). */
  events: AsyncIterable<unknown>
  /** Resolves with `runId` once the first event for this run arrives. */
  ready: Promise<string>
  /** Resolves with the final `run-done` frame; rejects on error frame. */
  done: Promise<RunDoneFrame>
  /** Send `run-cancel` to the daemon. Buffered if `runId` not yet known. */
  cancel(): void
}

export type DaemonClient = {
  /** Open WS, complete hello-ack + auth handshake. */
  start(): Promise<void>
  /** Issue a run-start. Only one inflight run is allowed per client in v1. */
  runStart(opts: RunStartOpts): RunStream
  /** Send a knowledge-refresh frame and await the done report. */
  knowledgeRefresh(opts?: { timeoutMs?: number }): Promise<KnowledgeRefreshDoneFrame>
  /** Close the WS. Pending run is rejected. */
  close(): Promise<void>
}

const DEFAULT_KNOWLEDGE_REFRESH_TIMEOUT_MS = 5 * 60 * 1000

const DEFAULT_HELLO_TIMEOUT_MS = 5_000

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T> | { error: Error }) => void> = []
  private ended = false
  private err?: Error

  push(item: T): void {
    if (this.err || this.ended) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  error(err: Error): void {
    if (this.err || this.ended) return
    this.err = err
    for (const w of this.waiters.splice(0)) w({ error: err })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.err) return Promise.reject(this.err)
        const it = this.items.shift()
        if (it !== undefined) return Promise.resolve({ value: it, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push((r) => {
            if ('error' in r) reject(r.error)
            else resolve(r)
          })
        })
      },
    }
  }
}

type Pending = {
  queue: AsyncQueue<unknown>
  ready: Promise<string>
  resolveReady: (runId: string) => void
  done: Promise<RunDoneFrame>
  resolveDone: (frame: RunDoneFrame) => void
  rejectDone: (err: Error) => void
  runId?: string
  cancelRequested: boolean
}

type KnowledgeRequest = {
  resolve: (frame: KnowledgeRefreshDoneFrame) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export function createDaemonClient(opts: DaemonClientOpts): DaemonClient {
  const helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  let ws: WebSocket | null = null
  let pending: Pending | null = null
  const knowledgeRequests = new Map<string, KnowledgeRequest>()
  let closed = false

  function sendFrame(frame: ClientFrame): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('daemon client not connected')
    }
    ws.send(JSON.stringify(frame))
  }

  function failPending(err: Error): void {
    if (!pending) return
    pending.queue.error(err)
    pending.rejectDone(err)
    pending = null
  }

  function onMessage(raw: WebSocket.RawData): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch {
      log.warn('failed to JSON.parse server frame')
      return
    }
    const result = ServerFrameSchema.safeParse(parsed)
    if (!result.success) {
      log.warn({ issues: result.error.issues }, 'invalid server frame')
      return
    }
    const frame = result.data

    if (frame.type === 'run-event') {
      if (!pending) return
      if (!pending.runId) {
        pending.runId = frame.runId
        pending.resolveReady(frame.runId)
        if (pending.cancelRequested) {
          try {
            sendFrame({ type: 'run-cancel', runId: frame.runId })
          } catch (err) {
            log.warn({ err }, 'failed to send buffered run-cancel')
          }
        }
      }
      pending.queue.push(frame.event)
      return
    }

    if (frame.type === 'run-done') {
      if (!pending) return
      const settled = pending
      pending = null
      settled.queue.end()
      settled.resolveDone(frame)
      return
    }

    if (frame.type === 'knowledge-refresh-done') {
      const req = knowledgeRequests.get(frame.requestId)
      if (req) {
        clearTimeout(req.timer)
        knowledgeRequests.delete(frame.requestId)
        req.resolve(frame)
      } else {
        log.warn({ requestId: frame.requestId }, 'knowledge-refresh-done for unknown request')
      }
      return
    }

    if (frame.type === 'error') {
      const err = new Error(`${frame.code}: ${frame.message}`)
      if (frame.requestId) {
        const req = knowledgeRequests.get(frame.requestId)
        if (req) {
          clearTimeout(req.timer)
          knowledgeRequests.delete(frame.requestId)
          req.reject(err)
          return
        }
      }
      if (
        pending &&
        (frame.runId === pending.runId ||
          (frame.runId === undefined && pending.runId === undefined))
      ) {
        failPending(err)
      } else {
        log.warn({ code: frame.code, message: frame.message, runId: frame.runId }, 'unbound error')
      }
      return
    }

    // hello-ack — handled inline by start()
  }

  function failKnowledgeRequests(err: Error): void {
    for (const [id, req] of knowledgeRequests) {
      clearTimeout(req.timer)
      knowledgeRequests.delete(id)
      req.reject(err)
    }
  }

  return {
    async start(): Promise<void> {
      if (ws) throw new Error('already started')
      ws = new WebSocket(opts.url)

      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          ws?.off('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          ws?.off('open', onOpen)
          reject(err)
        }
        ws?.once('open', onOpen)
        ws?.once('error', onError)
      })

      const helloAck = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws?.off('message', onceMessage)
          reject(new Error(`hello-ack not received in ${helloTimeoutMs}ms`))
        }, helloTimeoutMs)
        const onceMessage = (raw: WebSocket.RawData): void => {
          let parsed: unknown
          try {
            parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
          } catch {
            return
          }
          const result = ServerFrameSchema.safeParse(parsed)
          if (!result.success) return
          if (result.data.type === 'hello-ack') {
            clearTimeout(timer)
            ws?.off('message', onceMessage)
            resolve()
          }
        }
        ws?.on('message', onceMessage)
      })

      sendFrame({ type: 'hello', version: PROTOCOL_VERSION, client: opts.client ?? 'talos-cli' })
      await helloAck
      sendFrame({ type: 'auth', token: opts.token })

      ws.on('message', onMessage)
      ws.on('close', () => {
        closed = true
        if (pending) failPending(new Error('daemon connection closed'))
        failKnowledgeRequests(new Error('daemon connection closed'))
      })
      ws.on('error', (err) => {
        log.warn({ err }, 'ws error')
      })
    },

    runStart(req: RunStartOpts): RunStream {
      if (closed || !ws) throw new Error('daemon client not connected')
      if (pending) throw new Error('another run is already in flight')

      let resolveReady!: (id: string) => void
      const ready = new Promise<string>((r) => {
        resolveReady = r
      })
      let resolveDone!: (f: RunDoneFrame) => void
      let rejectDone!: (err: Error) => void
      const done = new Promise<RunDoneFrame>((res, rej) => {
        resolveDone = res
        rejectDone = rej
      })

      const queue = new AsyncQueue<unknown>()
      pending = {
        queue,
        ready,
        resolveReady,
        done,
        resolveDone,
        rejectDone,
        cancelRequested: false,
      }

      sendFrame({
        type: 'run-start',
        threadId: req.threadId,
        prompt: req.prompt,
        ...(req.metadata ? { metadata: req.metadata } : {}),
      })

      return {
        events: queue,
        ready,
        done,
        cancel: () => {
          if (!pending) return
          if (pending.runId) {
            try {
              sendFrame({ type: 'run-cancel', runId: pending.runId })
            } catch (err) {
              log.warn({ err }, 'failed to send run-cancel')
            }
          } else {
            pending.cancelRequested = true
          }
        },
      }
    },

    knowledgeRefresh(reqOpts?: { timeoutMs?: number }): Promise<KnowledgeRefreshDoneFrame> {
      if (closed || !ws) return Promise.reject(new Error('daemon client not connected'))
      const requestId = randomUUID()
      const timeoutMs = reqOpts?.timeoutMs ?? DEFAULT_KNOWLEDGE_REFRESH_TIMEOUT_MS
      return new Promise<KnowledgeRefreshDoneFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          knowledgeRequests.delete(requestId)
          reject(new Error(`knowledge-refresh timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        knowledgeRequests.set(requestId, { resolve, reject, timer })
        try {
          sendFrame({ type: 'knowledge-refresh', requestId })
        } catch (err) {
          clearTimeout(timer)
          knowledgeRequests.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },

    async close(): Promise<void> {
      closed = true
      if (pending) failPending(new Error('daemon client closing'))
      failKnowledgeRequests(new Error('daemon client closing'))
      if (!ws) return
      const target = ws
      ws = null
      await new Promise<void>((resolve) => {
        target.once('close', () => resolve())
        try {
          target.close()
        } catch {
          resolve()
        }
      })
    },
  }
}
