import type { Db } from '@/persistence/queries'
import { searchKnowledgeChunks } from '@/persistence/queries'
import type { EmbeddingsService, KnowledgeChunkHit, KnowledgeRetriever } from '@/runtime/types'

export type RetrieverDeps = {
  db: Db
  embeddings: EmbeddingsService
}

/**
 * KnowledgeRetriever backed by the cron-fed `knowledge_chunks` table.
 * Embeds the query, runs cosine top-K via the HNSW index, returns
 * `KnowledgeChunkHit` records the runtime injects into the system prompt.
 *
 * `score = 1 - distance` so callers can treat higher as better; the runtime
 * just passes the hits through without thresholding (knowledge is best-
 * effort context, not gated).
 */
export function createKnowledgeRetriever(deps: RetrieverDeps): KnowledgeRetriever {
  return {
    async retrieve(query: string, opts?: { topK?: number }): Promise<KnowledgeChunkHit[]> {
      if (!query || query.trim().length === 0) return []
      const topK = opts?.topK ?? 5
      const queryEmbedding = await deps.embeddings.embed(query)
      const rows = await searchKnowledgeChunks(deps.db, queryEmbedding, topK)
      return rows.map((r) => ({
        source: r.source,
        content: r.content,
        score: r.score,
      }))
    },
  }
}
