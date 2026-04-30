import type { Logger } from 'pino'
import type { Db } from '@/persistence/queries'
import { replaceKnowledgeChunks } from '@/persistence/queries'
import type { EmbeddingsService } from '@/runtime/types'
import { logger as defaultLogger } from '@/shared/logger'
import { type ChunkOptions, chunk as chunkText } from './chunker'
import { embedBatch } from './embed'
import type { KnowledgeSource, KnowledgeSourceItem } from './sources/types'

export type SourceSyncReport = {
  source: string
  /** Items returned by the source's `fetch()`. */
  fetched: number
  /** Total chunks persisted across all items. */
  chunks: number
  /** Wall time for the whole source: fetch + chunk + embed + persist. */
  durationMs: number
  /** Truthy when this source threw — others continue independently. */
  error?: string
}

export type KnowledgeSyncReport = {
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  sources: SourceSyncReport[]
}

export type RunCronDeps = {
  db: Db
  embeddings: EmbeddingsService
  sources: readonly KnowledgeSource[]
  logger?: Logger
  /** Override chunker config (target/overlap tokens). */
  chunk?: ChunkOptions
  /** Override embedder batch size. */
  embedBatchSize?: number
}

/**
 * Run one cron tick: for each source, fetch -> chunk -> embed -> replace.
 * Per-source try/catch isolates failures so one upstream incident doesn't
 * block the others. Each (source, sourceId) pair is replaced atomically in
 * a transaction.
 */
export async function runKnowledgeCron(deps: RunCronDeps): Promise<KnowledgeSyncReport> {
  const log = deps.logger ?? defaultLogger
  const startedAt = new Date()
  const reports: SourceSyncReport[] = []

  for (const source of deps.sources) {
    const sourceStart = Date.now()
    let fetched = 0
    let chunks = 0
    try {
      const items = await source.fetch()
      fetched = items.length
      const childLog = log.child({ source: source.name, fetched })
      childLog.info('source fetched')

      // Chunk every item up front so we can batch embeddings across the
      // whole source in one or two embedMany calls.
      const flat: Array<{ item: KnowledgeSourceItem; chunkIndex: number; content: string }> = []
      for (const item of items) {
        const pieces = chunkText(item.content, deps.chunk)
        pieces.forEach((content, chunkIndex) => {
          flat.push({ item, chunkIndex, content })
        })
      }

      const vectors =
        flat.length === 0
          ? []
          : await embedBatch(
              deps.embeddings,
              flat.map((f) => f.content),
              ...(deps.embedBatchSize != null ? [{ batchSize: deps.embedBatchSize }] : []),
            )

      // Group flat list back by sourceId so each replace call is atomic per
      // document. Items returning zero chunks still get their pair cleared
      // so a content drop wipes the prior set.
      const grouped = new Map<
        string,
        {
          item: KnowledgeSourceItem
          rows: Array<{ chunkIndex: number; content: string; embedding: number[] }>
        }
      >()
      for (const item of items) {
        grouped.set(item.sourceId, { item, rows: [] })
      }
      flat.forEach((f, i) => {
        const v = vectors[i]
        if (!v) return
        const bucket = grouped.get(f.item.sourceId)
        if (!bucket) return
        bucket.rows.push({ chunkIndex: f.chunkIndex, content: f.content, embedding: v })
      })

      for (const [sourceId, { item, rows }] of grouped) {
        await replaceKnowledgeChunks(
          deps.db,
          source.name,
          sourceId,
          rows.map((r) => ({
            chunkIndex: r.chunkIndex,
            content: r.content,
            embedding: r.embedding,
            metadata: item.metadata ?? null,
          })),
        )
        chunks += rows.length
      }

      childLog.info({ chunks }, 'source persisted')
      reports.push({
        source: source.name,
        fetched,
        chunks,
        durationMs: Date.now() - sourceStart,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ source: source.name, err: message }, 'source failed — continuing')
      reports.push({
        source: source.name,
        fetched,
        chunks,
        durationMs: Date.now() - sourceStart,
        error: message,
      })
    }
  }

  const finishedAt = new Date()
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
    sources: reports,
  }
}
