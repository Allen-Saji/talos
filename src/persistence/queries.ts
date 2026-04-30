import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { TalosDbError } from '@/shared/errors'
import {
  knowledgeChunks,
  messageEmbeddings,
  type NewKnowledgeChunk,
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

// biome-ignore lint/suspicious/noExplicitAny: drizzle internal type parameters
export type Db = PgDatabase<PgQueryResultHKT, any, any>

type ExecuteResult = { rows: Array<Record<string, unknown>> }

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

/**
 * Backfill `step_id` on audit rows already inserted by the KeeperHub
 * middleware. The middleware fires at tool execute time — before the step row
 * exists — so it writes `step_id = null` and the runtime UPDATEs after
 * `appendStep` returns. Scoped by `run_id + tool_call_id` so concurrent runs
 * never cross-contaminate.
 */
export async function updateToolCallStepIds(
  db: Db,
  runId: string,
  toolCallIds: readonly string[],
  stepId: string,
): Promise<void> {
  if (toolCallIds.length === 0) return
  await db
    .update(toolCalls)
    .set({ stepId })
    .where(
      sql`${toolCalls.runId} = ${runId} AND ${toolCalls.toolCallId} IN (${sql.join(
        toolCallIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
}

export type ToolAuditMeta = {
  /** True if KeeperHub middleware would route this through workflow audit. */
  shouldAudit: boolean
  /** Why the decision was made (e.g. KNOWN_READONLY, annotation_readOnly, audit_default). */
  reason: string
  /** KeeperHub workflow / execution / tx wiring (populated by #10's protocol-tool routing). */
  workflowId?: string
  executionId?: string
  txHash?: string
  /** Free-form details passed by the middleware (e.g. timing, route taken). */
  details?: Record<string, unknown>
}

export type ToolCallAuditInput = {
  runId: string
  stepId?: string | null
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  error?: string | null
  audit: ToolAuditMeta
  startedAt?: Date
  finishedAt?: Date
}

/**
 * Append a tool-call row with structured audit metadata. Used by the
 * KeeperHub middleware on every tool invocation; never throws on
 * malformed audit metadata — failures are surfaced to the caller.
 */
export async function appendToolCallAudit(db: Db, input: ToolCallAuditInput) {
  return recordToolCall(db, {
    runId: input.runId,
    stepId: input.stepId ?? null,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args ?? null,
    result: input.result ?? null,
    error: input.error ?? null,
    audit: input.audit,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
  })
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

  const result = (await db.execute(sql`
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
  `)) as ExecuteResult

  return result.rows.map(rowToHit)
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
  const result = (await db.execute(sql`
    SELECT * FROM thread_summaries
    WHERE thread_id = ${threadId}
    ORDER BY created_at DESC
    LIMIT 1
  `)) as ExecuteResult
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

  const result = (await db.execute(sql`
    SELECT id, thread_id, summary, created_at,
           1 - (embedding <=> ${embeddingLiteral}::vector) AS vsim
    FROM thread_summaries
    WHERE (${excludeThreadId}::text IS NULL OR thread_id <> ${excludeThreadId})
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${topK}
  `)) as ExecuteResult

  return result.rows
    .map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      summary: String(row.summary),
      vsim: Number(row.vsim),
      createdAt: String(row.created_at),
    }))
    .filter((h) => h.vsim >= threshold)
}

// ---------- knowledge chunks (cron-fed ETH ecosystem context) ----------

export type KnowledgeChunkInput = {
  chunkIndex: number
  content: string
  embedding: number[]
  metadata?: Record<string, unknown> | null
}

/**
 * Replace all chunks for a `(source, sourceId)` pair atomically. Cron-time
 * idempotency: re-running a fetch wipes the prior set and inserts the new one
 * in a single transaction, so partial failures never leave orphan chunks and
 * content drift produces no stale rows.
 *
 * `sourceId` is required by this contract (callers pass a stable doc key like
 * a slug); the schema column is nullable for forward compatibility.
 */
export async function replaceKnowledgeChunks(
  db: Db,
  source: string,
  sourceId: string,
  rows: readonly KnowledgeChunkInput[],
): Promise<void> {
  for (const r of rows) {
    if (r.embedding.length !== EMBEDDING_DIMS) {
      throw new TalosDbError(
        `chunk embedding must be ${EMBEDDING_DIMS}-d (got ${r.embedding.length})`,
        'DB_BAD_EMBEDDING',
      )
    }
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM knowledge_chunks WHERE source = ${source} AND source_id = ${sourceId}`,
    )
    if (rows.length === 0) return
    const values: NewKnowledgeChunk[] = rows.map((r) => ({
      source,
      sourceId,
      chunkIndex: r.chunkIndex,
      content: r.content,
      embedding: r.embedding,
      metadata: r.metadata ?? null,
    }))
    await tx.insert(knowledgeChunks).values(values)
  })
}

export type KnowledgeChunkHitRow = {
  id: string
  source: string
  sourceId: string | null
  chunkIndex: number
  content: string
  metadata: Record<string, unknown> | null
  score: number
}

/**
 * Cosine top-K over `knowledge_chunks` using the HNSW `vector_cosine_ops`
 * index (`<=>`). Score is `1 - distance` so callers can treat higher as
 * better, matching the message-search convention.
 */
export async function searchKnowledgeChunks(
  db: Db,
  queryEmbedding: number[],
  topK = 5,
): Promise<KnowledgeChunkHitRow[]> {
  if (queryEmbedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `queryEmbedding must be ${EMBEDDING_DIMS}-d (got ${queryEmbedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
  const embeddingLiteral = `[${queryEmbedding.join(',')}]`
  const result = (await db.execute(sql`
    SELECT id, source, source_id, chunk_index, content, metadata,
           1 - (embedding <=> ${embeddingLiteral}::vector) AS score
    FROM knowledge_chunks
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${topK}
  `)) as ExecuteResult

  return result.rows.map((row) => ({
    id: String(row.id),
    source: String(row.source),
    sourceId: row.source_id == null ? null : String(row.source_id),
    chunkIndex: Number(row.chunk_index),
    content: String(row.content),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    score: Number(row.score),
  }))
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
