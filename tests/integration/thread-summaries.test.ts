import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDb,
  type DbHandle,
  latestThreadSummary,
  openRun,
  runMigrations,
  searchThreadSummaries,
  upsertThread,
  writeThreadSummary,
} from '@/persistence'

const EMBEDDING_DIMS = 1536

function fakeEmbedding(seed: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMS)
  let x = seed || 1
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    x = (x * 9301 + 49297) % 233280
    v[i] = x / 233280 - 0.5
  }
  let norm = 0
  for (const n of v) norm += n * n
  norm = Math.sqrt(norm)
  return v.map((n) => n / norm)
}

describe('thread_summaries — warm-tier persistence', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('writes + reads the latest summary for a thread', async () => {
    await upsertThread(handle.db, { id: 't-warm', channel: 'cli' })
    const r1 = await openRun(handle.db, { threadId: 't-warm', prompt: 'first batch' })
    const r2 = await openRun(handle.db, { threadId: 't-warm', prompt: 'second batch' })

    await writeThreadSummary(handle.db, {
      threadId: 't-warm',
      runRangeStart: r1.id,
      runRangeEnd: r1.id,
      summary: 'discussed Aave supply',
      embedding: fakeEmbedding(1),
      tokenCount: 42,
    })

    await writeThreadSummary(handle.db, {
      threadId: 't-warm',
      runRangeStart: r2.id,
      runRangeEnd: r2.id,
      summary: 'discussed Uniswap swap',
      embedding: fakeEmbedding(2),
      tokenCount: 50,
    })

    const latest = await latestThreadSummary(handle.db, 't-warm')
    expect(latest).not.toBeNull()
    expect(latest?.summary).toBe('discussed Uniswap swap')
    expect(latest?.token_count).toBe(50)
  })

  it('returns null for a thread with no summary', async () => {
    await upsertThread(handle.db, { id: 't-empty', channel: 'cli' })
    const latest = await latestThreadSummary(handle.db, 't-empty')
    expect(latest).toBeNull()
  })

  it('cross-thread recall ranks by vector similarity, threshold-gated', async () => {
    await upsertThread(handle.db, { id: 't-a', channel: 'cli' })
    await upsertThread(handle.db, { id: 't-b', channel: 'cli' })
    await upsertThread(handle.db, { id: 't-c', channel: 'cli' })

    await writeThreadSummary(handle.db, {
      threadId: 't-a',
      summary: 'thread A: aave supply on arbitrum',
      embedding: fakeEmbedding(1),
    })
    await writeThreadSummary(handle.db, {
      threadId: 't-b',
      summary: 'thread B: uniswap swap on mainnet',
      embedding: fakeEmbedding(50),
    })
    await writeThreadSummary(handle.db, {
      threadId: 't-c',
      summary: 'thread C: similar to A',
      embedding: fakeEmbedding(1),
    })

    const hits = await searchThreadSummaries(handle.db, fakeEmbedding(1), {
      topK: 3,
      threshold: 0.5,
    })
    expect(hits.length).toBeGreaterThan(0)
    const top = hits[0]
    expect(top).toBeDefined()
    if (top) {
      expect(top.vsim).toBeGreaterThan(0.5)
    }
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]
      const curr = hits[i]
      if (prev && curr) expect(prev.vsim).toBeGreaterThanOrEqual(curr.vsim)
    }
  })

  it('excludes a given thread when excludeThreadId is set', async () => {
    await upsertThread(handle.db, { id: 't-self', channel: 'cli' })
    await upsertThread(handle.db, { id: 't-other', channel: 'cli' })

    await writeThreadSummary(handle.db, {
      threadId: 't-self',
      summary: 'self thread',
      embedding: fakeEmbedding(1),
    })
    await writeThreadSummary(handle.db, {
      threadId: 't-other',
      summary: 'other thread',
      embedding: fakeEmbedding(1),
    })

    const hits = await searchThreadSummaries(handle.db, fakeEmbedding(1), {
      topK: 5,
      threshold: 0,
      excludeThreadId: 't-self',
    })
    expect(hits.every((h) => h.threadId !== 't-self')).toBe(true)
    expect(hits.some((h) => h.threadId === 't-other')).toBe(true)
  })

  it('threshold filters out low-similarity matches', async () => {
    await upsertThread(handle.db, { id: 't-q1', channel: 'cli' })
    await writeThreadSummary(handle.db, {
      threadId: 't-q1',
      summary: 'totally unrelated',
      embedding: fakeEmbedding(999),
    })

    const hits = await searchThreadSummaries(handle.db, fakeEmbedding(1), {
      topK: 5,
      threshold: 0.9,
    })
    expect(hits.length).toBe(0)
  })

  it('rejects wrong-dimension embeddings on write and search', async () => {
    await upsertThread(handle.db, { id: 't-bad', channel: 'cli' })
    await expect(
      writeThreadSummary(handle.db, {
        threadId: 't-bad',
        summary: 'bad',
        embedding: [1, 2, 3],
      }),
    ).rejects.toThrow(/embedding must be 1536/)

    await expect(searchThreadSummaries(handle.db, [1, 2, 3])).rejects.toThrow(
      /queryEmbedding must be 1536/,
    )
  })
})
