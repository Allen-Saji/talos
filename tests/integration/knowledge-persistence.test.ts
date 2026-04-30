import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDb,
  type DbHandle,
  replaceKnowledgeChunks,
  runMigrations,
  searchKnowledgeChunks,
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

describe('knowledge_chunks — replace + search', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  async function countChunks(): Promise<number> {
    const r = (await handle.db.execute(sql`SELECT count(*)::int AS n FROM knowledge_chunks`)) as {
      rows: Array<{ n: number }>
    }
    return r.rows[0]?.n ?? 0
  }

  it('replaceKnowledgeChunks inserts rows for a fresh (source, source_id)', async () => {
    await replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [
      { chunkIndex: 0, content: 'aave tvl 12.4b', embedding: fakeEmbedding(1) },
      { chunkIndex: 1, content: 'usdc supply apy 4.2%', embedding: fakeEmbedding(2) },
    ])
    expect(await countChunks()).toBe(2)
  })

  it('re-running with the same (source, source_id) replaces, not appends', async () => {
    await replaceKnowledgeChunks(handle.db, 'l2beat', 'arbitrum', [
      { chunkIndex: 0, content: 'old tvl', embedding: fakeEmbedding(1) },
      { chunkIndex: 1, content: 'old risk', embedding: fakeEmbedding(2) },
    ])
    expect(await countChunks()).toBe(2)

    await replaceKnowledgeChunks(handle.db, 'l2beat', 'arbitrum', [
      { chunkIndex: 0, content: 'new tvl', embedding: fakeEmbedding(3) },
    ])
    expect(await countChunks()).toBe(1)

    const r = (await handle.db.execute(
      sql`SELECT content FROM knowledge_chunks WHERE source = 'l2beat' AND source_id = 'arbitrum'`,
    )) as { rows: Array<{ content: string }> }
    expect(r.rows[0]?.content).toBe('new tvl')
  })

  it('replace scopes by (source, source_id) — sibling pairs untouched', async () => {
    await replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [
      { chunkIndex: 0, content: 'aave row', embedding: fakeEmbedding(1) },
    ])
    await replaceKnowledgeChunks(handle.db, 'defillama', 'uniswap', [
      { chunkIndex: 0, content: 'uniswap row', embedding: fakeEmbedding(2) },
    ])
    await replaceKnowledgeChunks(handle.db, 'l2beat', 'aave', [
      { chunkIndex: 0, content: 'l2beat aave', embedding: fakeEmbedding(3) },
    ])

    await replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [
      { chunkIndex: 0, content: 'aave fresh', embedding: fakeEmbedding(4) },
    ])

    expect(await countChunks()).toBe(3)
    const r = (await handle.db.execute(
      sql`SELECT source, source_id, content FROM knowledge_chunks ORDER BY source, source_id`,
    )) as { rows: Array<{ source: string; source_id: string; content: string }> }
    expect(r.rows).toEqual([
      { source: 'defillama', source_id: 'aave', content: 'aave fresh' },
      { source: 'defillama', source_id: 'uniswap', content: 'uniswap row' },
      { source: 'l2beat', source_id: 'aave', content: 'l2beat aave' },
    ])
  })

  it('replace with empty rows clears the (source, source_id) pair', async () => {
    await replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [
      { chunkIndex: 0, content: 'a', embedding: fakeEmbedding(1) },
      { chunkIndex: 1, content: 'b', embedding: fakeEmbedding(2) },
    ])
    expect(await countChunks()).toBe(2)
    await replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [])
    expect(await countChunks()).toBe(0)
  })

  it('rejects embeddings with the wrong dimension', async () => {
    await expect(
      replaceKnowledgeChunks(handle.db, 'defillama', 'aave', [
        { chunkIndex: 0, content: 'x', embedding: [0.1, 0.2, 0.3] },
      ]),
    ).rejects.toThrow(/1536-d/)
  })

  it('persists metadata as jsonb', async () => {
    await replaceKnowledgeChunks(handle.db, 'l2beat', 'arbitrum', [
      {
        chunkIndex: 0,
        content: 'arb summary',
        embedding: fakeEmbedding(1),
        metadata: { tvlUsd: 12_400_000_000, stage: 'Stage 1' },
      },
    ])
    const r = (await handle.db.execute(
      sql`SELECT metadata FROM knowledge_chunks WHERE source = 'l2beat' AND source_id = 'arbitrum'`,
    )) as { rows: Array<{ metadata: Record<string, unknown> }> }
    expect(r.rows[0]?.metadata).toEqual({ tvlUsd: 12_400_000_000, stage: 'Stage 1' })
  })

  it('searchKnowledgeChunks ranks the closest embedding first', async () => {
    const eA = fakeEmbedding(11)
    const eB = fakeEmbedding(22)
    const eC = fakeEmbedding(33)

    await replaceKnowledgeChunks(handle.db, 'defillama', 'a', [
      { chunkIndex: 0, content: 'A', embedding: eA },
    ])
    await replaceKnowledgeChunks(handle.db, 'defillama', 'b', [
      { chunkIndex: 0, content: 'B', embedding: eB },
    ])
    await replaceKnowledgeChunks(handle.db, 'defillama', 'c', [
      { chunkIndex: 0, content: 'C', embedding: eC },
    ])

    const hits = await searchKnowledgeChunks(handle.db, eB, 3)
    expect(hits[0]?.content).toBe('B')
    expect(hits[0]?.score).toBeGreaterThan(0.999)
    expect(hits.length).toBe(3)
  })

  it('searchKnowledgeChunks honours topK', async () => {
    for (let i = 0; i < 5; i++) {
      await replaceKnowledgeChunks(handle.db, 'defillama', `s${i}`, [
        { chunkIndex: 0, content: `c${i}`, embedding: fakeEmbedding(i + 1) },
      ])
    }
    const hits = await searchKnowledgeChunks(handle.db, fakeEmbedding(1), 2)
    expect(hits.length).toBe(2)
  })

  it('searchKnowledgeChunks rejects wrong-dim query', async () => {
    await expect(searchKnowledgeChunks(handle.db, [0.1, 0.2], 5)).rejects.toThrow(/1536-d/)
  })
})
