import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKnowledgeRetriever } from '@/knowledge/retrieve'
import { createDb, type DbHandle, replaceKnowledgeChunks, runMigrations } from '@/persistence'
import type { EmbeddingsService } from '@/runtime/types'

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

function pinnedEmbeddings(map: Record<string, number[]>): EmbeddingsService {
  return {
    embed: async (text: string) => {
      const v = map[text]
      if (!v) throw new Error(`no fake embedding for ${JSON.stringify(text)}`)
      return v
    },
    embedMany: async (texts: string[]) => texts.map((t) => map[t] ?? fakeEmbedding(t.length)),
  }
}

describe('createKnowledgeRetriever', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('returns top-K nearest chunks ranked by cosine score', async () => {
    const aaveVec = fakeEmbedding(1)
    const uniVec = fakeEmbedding(2)
    const lidoVec = fakeEmbedding(3)

    await replaceKnowledgeChunks(handle.db, 'defillama:protocols', 'aave', [
      { chunkIndex: 0, content: 'Aave TVL 12.4B', embedding: aaveVec },
    ])
    await replaceKnowledgeChunks(handle.db, 'defillama:protocols', 'uniswap', [
      { chunkIndex: 0, content: 'Uniswap TVL 6.8B', embedding: uniVec },
    ])
    await replaceKnowledgeChunks(handle.db, 'defillama:protocols', 'lido', [
      { chunkIndex: 0, content: 'Lido TVL 32.1B', embedding: lidoVec },
    ])

    const retriever = createKnowledgeRetriever({
      db: handle.db,
      embeddings: pinnedEmbeddings({ 'aave tvl?': aaveVec }),
    })

    const hits = await retriever.retrieve('aave tvl?', { topK: 2 })
    expect(hits.length).toBe(2)
    expect(hits[0]?.content).toBe('Aave TVL 12.4B')
    expect(hits[0]?.source).toBe('defillama:protocols')
    expect(hits[0]?.score ?? 0).toBeGreaterThan(0.999)
  })

  it('defaults to topK = 5', async () => {
    for (let i = 0; i < 8; i++) {
      await replaceKnowledgeChunks(handle.db, 's', `id-${i}`, [
        { chunkIndex: 0, content: `c${i}`, embedding: fakeEmbedding(i + 1) },
      ])
    }
    const retriever = createKnowledgeRetriever({
      db: handle.db,
      embeddings: pinnedEmbeddings({ q: fakeEmbedding(1) }),
    })
    const hits = await retriever.retrieve('q')
    expect(hits.length).toBe(5)
  })

  it('returns empty array on empty query without embedding the call', async () => {
    let embedCalled = 0
    const retriever = createKnowledgeRetriever({
      db: handle.db,
      embeddings: {
        embed: async () => {
          embedCalled++
          return fakeEmbedding(1)
        },
        embedMany: async (xs) => xs.map(() => fakeEmbedding(1)),
      },
    })
    expect(await retriever.retrieve('')).toEqual([])
    expect(await retriever.retrieve('   ')).toEqual([])
    expect(embedCalled).toBe(0)
  })

  it('returns empty when the table is empty', async () => {
    const retriever = createKnowledgeRetriever({
      db: handle.db,
      embeddings: pinnedEmbeddings({ q: fakeEmbedding(1) }),
    })
    expect(await retriever.retrieve('q')).toEqual([])
  })
})
