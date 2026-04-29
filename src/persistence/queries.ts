import { sql } from 'drizzle-orm'
import { TalosDbError } from '@/shared/errors'
import type { DbHandle } from './client'
import {
  messageEmbeddings,
  type NewMessageEmbedding,
  type NewRun,
  type NewStep,
  type NewThread,
  type NewThreadSummary,
  type NewToolCall,
  runs,
  steps,
  threadSummaries,
  threads,
  toolCalls,
} from './schema'

const EMBEDDING_DIMS = 1536

type Db = DbHandle['db']

export async function upsertThread(db: Db, input: NewThread) {
  const [row] = await db
    .insert(threads)
    .values(input)
    .onConflictDoUpdate({
      target: threads.id,
      set: { updatedAt: sql`now()`, title: input.title ?? sql`${threads.title}` },
    })
    .returning()
  if (!row) throw new TalosDbError('upsertThread returned no row', 'DB_NO_ROW')
  return row
}

export async function openRun(db: Db, input: NewRun) {
  const [row] = await db.insert(runs).values(input).returning()
  if (!row) throw new TalosDbError('openRun returned no row', 'DB_NO_ROW')
  return row
}

export async function closeRun(
  db: Db,
  runId: string,
  patch: { status: 'completed' | 'failed' | 'cancelled'; summary?: string | null },
) {
  await db
    .update(runs)
    .set({
      status: patch.status,
      summary: patch.summary ?? null,
      finishedAt: sql`now()`,
    })
    .where(sql`${runs.id} = ${runId}`)
}

export async function appendStep(db: Db, input: NewStep) {
  const [row] = await db.insert(steps).values(input).returning()
  if (!row) throw new TalosDbError('appendStep returned no row', 'DB_NO_ROW')
  return row
}

export async function recordToolCall(db: Db, input: NewToolCall) {
  const [row] = await db.insert(toolCalls).values(input).returning()
  if (!row) throw new TalosDbError('recordToolCall returned no row', 'DB_NO_ROW')
  return row
}

export async function insertMessageEmbedding(
  db: Db,
  input: Omit<NewMessageEmbedding, 'embedding'> & { embedding: number[] },
) {
  if (input.embedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `embedding must be ${EMBEDDING_DIMS}-d (got ${input.embedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
  const [row] = await db.insert(messageEmbeddings).values(input).returning()
  if (!row) throw new TalosDbError('insertMessageEmbedding returned no row', 'DB_NO_ROW')
  return row
}

export type SearchHit = {
  id: string
  threadId: string
  runId: string | null
  role: string
  content: string
  vsim: number
  krank: number
  score: number
}

export type SearchOptions = {
  topK?: number
  vectorPoolSize?: number
  weights?: { vector: number; keyword: number }
}

/**
 * Hybrid retrieval over message_embeddings, scoped to a thread.
 *
 * Score: `vsim * w.vector + krank * w.keyword` (default 0.7 / 0.3).
 *  - vsim   = 1 - cosine_distance, in [-1, 1] (typically [0, 1] for normalized embeddings)
 *  - krank  = ts_rank against plainto_tsquery, ≥ 0 (small, naturally bounded)
 * Pulls top `vectorPoolSize` (default 20) by vector distance, left-joins keyword ranks,
 * orders by combined score. Mirrors spike-2-pglite which proved 4ms vector queries.
 *
 * NOTE: tsv is computed inline via `to_tsvector('english', content)` because the
 * STORED generated column is tracked separately in issue #15. When that column
 * lands the WHERE/ORDER expressions swap to `tsv @@ ...` and `ts_rank(tsv, ...)`.
 */
export async function searchMessages(
  db: Db,
  threadId: string,
  queryEmbedding: number[],
  queryText: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  if (queryEmbedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `queryEmbedding must be ${EMBEDDING_DIMS}-d (got ${queryEmbedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
  const topK = options.topK ?? 5
  const pool = options.vectorPoolSize ?? 20
  const wv = options.weights?.vector ?? 0.7
  const wk = options.weights?.keyword ?? 0.3

  const embeddingLiteral = `[${queryEmbedding.join(',')}]`

  const result = await db.execute(sql`
    WITH v AS (
      SELECT id, thread_id, run_id, role, content,
             1 - (embedding <=> ${embeddingLiteral}::vector) AS vsim
      FROM message_embeddings
      WHERE thread_id = ${threadId}
      ORDER BY embedding <=> ${embeddingLiteral}::vector
      LIMIT ${pool}
    ),
    k AS (
      SELECT id,
             ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${queryText})) AS krank
      FROM message_embeddings
      WHERE thread_id = ${threadId}
        AND to_tsvector('english', content) @@ plainto_tsquery('english', ${queryText})
    )
    SELECT v.id, v.thread_id, v.run_id, v.role, v.content,
           v.vsim,
           COALESCE(k.krank, 0) AS krank,
           v.vsim * ${wv} + COALESCE(k.krank, 0) * ${wk} AS score
    FROM v LEFT JOIN k USING (id)
    ORDER BY score DESC
    LIMIT ${topK}
  `)

  return (result.rows as Array<Record<string, unknown>>).map(rowToHit)
}

// ---------- thread summaries (Warm tier) ----------

export async function writeThreadSummary(
  db: Db,
  input: Omit<NewThreadSummary, 'embedding'> & { embedding: number[] },
) {
  if (input.embedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `summary embedding must be ${EMBEDDING_DIMS}-d (got ${input.embedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
  const [row] = await db.insert(threadSummaries).values(input).returning()
  if (!row) throw new TalosDbError('writeThreadSummary returned no row', 'DB_NO_ROW')
  return row
}

export async function latestThreadSummary(db: Db, threadId: string) {
  const result = await db.execute(sql`
    SELECT * FROM thread_summaries
    WHERE thread_id = ${threadId}
    ORDER BY created_at DESC
    LIMIT 1
  `)
  const row = result.rows[0]
  return row ? (row as unknown as ThreadSummaryRow) : null
}

export type ThreadSummaryHit = {
  id: string
  threadId: string
  summary: string
  vsim: number
  createdAt: string
}

export type ThreadSummarySearchOptions = {
  topK?: number
  excludeThreadId?: string
  threshold?: number
}

/**
 * Cross-thread cold recall over thread_summaries. Vector-only (no keyword fusion)
 * because summaries are already condensed text — the vector is the high-signal channel.
 * Threshold-gated: returns only rows with vsim >= threshold (default 0.78 from
 * architecture's adaptive cold recall rule).
 */
export async function searchThreadSummaries(
  db: Db,
  queryEmbedding: number[],
  options: ThreadSummarySearchOptions = {},
): Promise<ThreadSummaryHit[]> {
  if (queryEmbedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `queryEmbedding must be ${EMBEDDING_DIMS}-d (got ${queryEmbedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
  const topK = options.topK ?? 3
  const threshold = options.threshold ?? 0.78
  const excludeThreadId = options.excludeThreadId ?? null

  const embeddingLiteral = `[${queryEmbedding.join(',')}]`

  const result = await db.execute(sql`
    SELECT id, thread_id, summary, created_at,
           1 - (embedding <=> ${embeddingLiteral}::vector) AS vsim
    FROM thread_summaries
    WHERE (${excludeThreadId}::text IS NULL OR thread_id <> ${excludeThreadId})
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${topK}
  `)

  return (result.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      summary: String(row.summary),
      vsim: Number(row.vsim),
      createdAt: String(row.created_at),
    }))
    .filter((h) => h.vsim >= threshold)
}

type ThreadSummaryRow = {
  id: string
  thread_id: string
  run_range_start: string | null
  run_range_end: string | null
  summary: string
  embedding: unknown
  token_count: number | null
  created_at: string
}

function rowToHit(row: Record<string, unknown>): SearchHit {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: row.run_id == null ? null : String(row.run_id),
    role: String(row.role),
    content: String(row.content),
    vsim: Number(row.vsim),
    krank: Number(row.krank),
    score: Number(row.score),
  }
}
