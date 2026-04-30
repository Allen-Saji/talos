import type { Logger } from 'pino'
import { logger as defaultLogger } from '@/shared/logger'

/**
 * Drift-tolerant scheduler. Schedules with `setTimeout` recursively rather
 * than `setInterval`, so the next tick is computed from the moment the
 * previous run *finished* — long-running cron ticks don't pile up.
 *
 * Stop is synchronous: it clears the pending timer and flips a flag the
 * in-flight tick checks before re-scheduling. An ongoing run completes;
 * the scheduler simply doesn't queue a new one.
 */
export type SchedulerHandle = {
  /** Stop the scheduler. Idempotent. Returns once any in-flight tick resolves. */
  stop(): Promise<void>
  /** True between `start()` and `stop()`. */
  isRunning(): boolean
}

export type StartSchedulerOpts = {
  /** Async function executed each tick. Errors are logged, never propagated. */
  run: () => Promise<unknown>
  /** Interval between tick *completion* and the next tick start, in ms. */
  intervalMs: number
  /** When true, run once immediately on start. Default false. */
  runOnBoot?: boolean
  /** When true, do nothing — scheduler stays inert. Useful for tests. */
  disabled?: boolean
  /** Pino logger; defaults to the shared talos logger. */
  logger?: Logger
  /** Identifier for log lines. */
  name?: string
}

export function startScheduler(opts: StartSchedulerOpts): SchedulerHandle {
  const log = (opts.logger ?? defaultLogger).child({ scheduler: opts.name ?? 'knowledge' })
  if (opts.disabled) {
    log.info('scheduler disabled — no ticks will run')
    return { stop: async () => {}, isRunning: () => false }
  }
  if (opts.intervalMs <= 0) throw new Error('intervalMs must be > 0')

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let activeTick: Promise<void> | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    const startedAt = Date.now()
    try {
      await opts.run()
    } catch (err) {
      log.warn({ err }, 'scheduler tick failed')
    }
    const elapsed = Date.now() - startedAt
    log.debug({ elapsedMs: elapsed }, 'scheduler tick complete')
    if (stopped) return
    timer = setTimeout(scheduleNext, opts.intervalMs)
  }

  const scheduleNext = () => {
    if (stopped) return
    activeTick = tick()
  }

  if (opts.runOnBoot) {
    scheduleNext()
  } else {
    timer = setTimeout(scheduleNext, opts.intervalMs)
  }

  return {
    isRunning: () => !stopped,
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (activeTick) {
        try {
          await activeTick
        } catch {
          // Errors already logged inside tick().
        }
      }
    },
  }
}
