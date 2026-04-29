import type { ServerFrame } from '@/protocol/frames'
import type { RunHandle } from '@/runtime/types'

export type StreamRunOpts = {
  handle: RunHandle
  send: (frame: ServerFrame) => void
}

/**
 * Pipe a runtime `RunHandle.fullStream` into `run-event` frames, then send
 * a final `run-done` frame after `handle.done` resolves. The runtime swallows
 * post-run persistence errors itself, so `handle.done` always resolves; we
 * only need to handle errors thrown inside the stream iteration.
 */
export async function streamRunToWs(opts: StreamRunOpts): Promise<void> {
  let finishReason: string | undefined
  let usage: { inputTokens?: number; outputTokens?: number } | undefined

  try {
    for await (const event of opts.handle.fullStream) {
      // AI SDK v6 emits a `finish` step at the end of every run carrying
      // both finishReason and usage. Snapshot for the run-done frame.
      if (event.type === 'finish') {
        const e = event as { finishReason?: string; totalUsage?: unknown; usage?: unknown }
        if (typeof e.finishReason === 'string') finishReason = e.finishReason
        const usageSrc = (e.totalUsage ?? e.usage) as
          | { inputTokens?: number; outputTokens?: number }
          | undefined
        if (usageSrc) {
          const next: { inputTokens?: number; outputTokens?: number } = {}
          if (typeof usageSrc.inputTokens === 'number') next.inputTokens = usageSrc.inputTokens
          if (typeof usageSrc.outputTokens === 'number') next.outputTokens = usageSrc.outputTokens
          usage = next
        }
      }
      opts.send({ type: 'run-event', runId: opts.handle.runId, event })
    }
  } finally {
    // `done` resolves regardless of stream success — the runtime catches
    // post-run hook failures internally.
    await opts.handle.done.catch(() => undefined)
    const done: ServerFrame =
      usage !== undefined && finishReason !== undefined
        ? { type: 'run-done', runId: opts.handle.runId, finishReason, usage }
        : finishReason !== undefined
          ? { type: 'run-done', runId: opts.handle.runId, finishReason }
          : usage !== undefined
            ? { type: 'run-done', runId: opts.handle.runId, usage }
            : { type: 'run-done', runId: opts.handle.runId }
    opts.send(done)
  }
}
