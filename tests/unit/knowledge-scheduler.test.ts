import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from '@/knowledge/scheduler'

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not run on boot by default; first tick fires after intervalMs', async () => {
    const run = vi.fn(async () => {})
    const handle = startScheduler({ run, intervalMs: 1000 })
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await handle.stop()
  })

  it('runs immediately when runOnBoot=true', async () => {
    const run = vi.fn(async () => {})
    const handle = startScheduler({ run, intervalMs: 1000, runOnBoot: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await handle.stop()
  })

  it('runs repeatedly at intervalMs', async () => {
    const run = vi.fn(async () => {})
    const handle = startScheduler({ run, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(3)
    await handle.stop()
  })

  it('continues despite a thrown tick', async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
    })
    const handle = startScheduler({ run, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
    await handle.stop()
  })

  it('stop() cancels future ticks', async () => {
    const run = vi.fn(async () => {})
    const handle = startScheduler({ run, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    await handle.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('disabled=true is a no-op', async () => {
    const run = vi.fn(async () => {})
    const handle = startScheduler({ run, intervalMs: 100, disabled: true, runOnBoot: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    expect(handle.isRunning()).toBe(false)
    await handle.stop()
  })

  it('rejects intervalMs <= 0', () => {
    expect(() => startScheduler({ run: async () => {}, intervalMs: 0 })).toThrow()
    expect(() => startScheduler({ run: async () => {}, intervalMs: -1 })).toThrow()
  })

  it('next tick is scheduled after the previous tick completes (no overlap)', async () => {
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      // Simulate a tick that runs longer than the interval.
      await new Promise((r) => setTimeout(r, 200))
      active--
    })
    const handle = startScheduler({ run, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100) // first tick starts
    await vi.advanceTimersByTimeAsync(200) // first tick finishes
    await vi.advanceTimersByTimeAsync(100) // second tick starts
    expect(maxActive).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    await handle.stop()
  })
})
