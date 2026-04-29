/**
 * Mem0-style distilled facts memory.
 *
 * Why a separate store: embedding raw chat is the wrong primitive for "what does the
 * user prefer". Facts are extracted, deduped, and reconciled in a single LLM call per
 * turn (ADD / UPDATE / DELETE / NONE), then written with append-only history.
 *
 * Pipeline (mirrors mem0/memory/main.py:662-895):
 *   1. extract candidate facts from new messages         <- FactExtractor
 *   2. vector-search top-K existing facts in same scope  <- recallFacts
 *   3. one LLM call returns ops per candidate            <- FactReconciler
 *   4. apply ops in a transaction with history rows      <- applyFactOps
 *
 * The LLM-side extractor + reconciler live in the runtime (#7); this module ships
 * the data plane and accepts them as injected dependencies so tests can mock them.
 */

import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { TalosDbError } from '@/shared/errors'
import type { DbHandle } from './client'
import { factHistory, facts } from './schema'

const EMBEDDING_DIMS = 1536

type Db = DbHandle['db']

// ---------- types ----------

export type FactScope = {
  agentId: string
  channel: string
  /** null = applies to all threads in (agentId, channel) */
  threadId?: string | null
}

export type ExtractedFact = {
  text: string
  embedding: number[]
}

export type ExistingFact = {
  id: string
  text: string
  /** vector similarity to the candidate that surfaced this fact */
  vsim: number
}

export type FactOp =
  | {
      kind: 'ADD'
      text: string
      embedding: number[]
      runId?: string | null
    }
  | {
      kind: 'UPDATE'
      targetId: string
      text: string
      embedding: number[]
      runId?: string | null
    }
  | {
      kind: 'DELETE'
      targetId: string
      runId?: string | null
    }
  | { kind: 'NONE' }

export type FactExtractor = (
  messages: Array<{ role: string; content: string }>,
) => Promise<ExtractedFact[]>

export type FactReconcilerInput = {
  scope: FactScope
  candidates: ExtractedFact[]
  existing: ExistingFact[]
}

export type FactReconciler = (input: FactReconcilerInput) => Promise<FactOp[]>

export type FactRecallHit = {
  id: string
  text: string
  vsim: number
  krank: number
  score: number
  createdAt: string
}

export type RecallOptions = {
  topK?: number
  vectorPoolSize?: number
  weights?: { vector: number; keyword: number }
  /** include facts with thread_id IS NULL (channel-wide) in addition to scope.threadId */
  includeChannelWide?: boolean
}

// ---------- helpers ----------

export function normalizeFactText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function hashFactText(text: string): string {
  return crypto.createHash('md5').update(normalizeFactText(text)).digest('hex')
}

function assertEmbeddingDims(embedding: number[], label: string): void {
  if (embedding.length !== EMBEDDING_DIMS) {
    throw new TalosDbError(
      `${label} must be ${EMBEDDING_DIMS}-d (got ${embedding.length})`,
      'DB_BAD_EMBEDDING',
    )
  }
}

function embeddingLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

// ---------- recall ----------

/**
 * Hybrid recall over live facts in scope. Scoring identical to searchMessages:
 * `vsim * 0.7 + ts_rank * 0.3` over a top-N vector pool.
 *
 * Filters: deleted_at IS NULL, superseded_by IS NULL.
 * Scope: exact (agent_id, channel) match. thread_id matches `scope.threadId` exactly,
 * plus optionally facts with thread_id IS NULL when `includeChannelWide=true`.
 */
export async function recallFacts(
  db: Db,
  scope: FactScope,
  queryEmbedding: number[],
  queryText: string,
  options: RecallOptions = {},
): Promise<FactRecallHit[]> {
  assertEmbeddingDims(queryEmbedding, 'queryEmbedding')

  const topK = options.topK ?? 5
  const pool = options.vectorPoolSize ?? 20
  const wv = options.weights?.vector ?? 0.7
  const wk = options.weights?.keyword ?? 0.3
  const includeChannelWide = options.includeChannelWide ?? true

  const emb = embeddingLiteral(queryEmbedding)
  const threadId = scope.threadId ?? null

  const threadClause =
    threadId === null
      ? sql`thread_id IS NULL`
      : includeChannelWide
        ? sql`(thread_id = ${threadId} OR thread_id IS NULL)`
        : sql`thread_id = ${threadId}`

  const rows = await db.execute(sql`
    WITH live AS (
      SELECT id, text, embedding, created_at
      FROM facts
      WHERE agent_id = ${scope.agentId}
        AND channel = ${scope.channel}
        AND deleted_at IS NULL
        AND superseded_by IS NULL
        AND ${threadClause}
    ),
    v AS (
      SELECT id, text, created_at,
             1 - (embedding <=> ${emb}::vector) AS vsim
      FROM live
      ORDER BY embedding <=> ${emb}::vector
      LIMIT ${pool}
    ),
    k AS (
      SELECT id,
             ts_rank(to_tsvector('english', text), plainto_tsquery('english', ${queryText})) AS krank
      FROM live
      WHERE to_tsvector('english', text) @@ plainto_tsquery('english', ${queryText})
    )
    SELECT v.id, v.text, v.created_at, v.vsim,
           COALESCE(k.krank, 0) AS krank,
           v.vsim * ${wv} + COALESCE(k.krank, 0) * ${wk} AS score
    FROM v LEFT JOIN k USING (id)
    ORDER BY score DESC
    LIMIT ${topK}
  `)

  return (rows.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    text: String(row.text),
    vsim: Number(row.vsim),
    krank: Number(row.krank),
    score: Number(row.score),
    createdAt: String(row.created_at),
  }))
}

// ---------- write ----------

/**
 * Apply a batch of fact ops in a single transaction. Each op writes a fact_history row.
 * Returns the IDs of facts that were created or affected, in the same order as input.
 *
 * Op semantics:
 *  - ADD     : insert new live fact + history(event=ADD, new_text=text)
 *  - UPDATE  : insert replacement fact, set old.superseded_by = new.id,
 *              + history(fact_id=new, event=UPDATE, old_text, new_text)
 *  - DELETE  : set deleted_at = now() on target, + history(event=DELETE, old_text)
 *  - NONE    : skipped
 *
 * Idempotency: ADD ops that hash-match a live fact in the same (agent, channel) scope
 * are skipped (no insert, no history). The scope is derived from the input scope.
 */
export async function applyFactOps(
  db: Db,
  scope: FactScope,
  ops: FactOp[],
): Promise<Array<{ op: FactOp; factId: string | null; skipped: boolean }>> {
  for (const op of ops) {
    if (op.kind === 'ADD' || op.kind === 'UPDATE') {
      assertEmbeddingDims(op.embedding, `${op.kind} op embedding`)
    }
  }

  const results: Array<{ op: FactOp; factId: string | null; skipped: boolean }> = []

  await db.transaction(async (tx) => {
    for (const op of ops) {
      if (op.kind === 'NONE') {
        results.push({ op, factId: null, skipped: true })
        continue
      }

      if (op.kind === 'ADD') {
        const hash = hashFactText(op.text)

        const dup = await tx.execute(sql`
          SELECT id FROM facts
          WHERE agent_id = ${scope.agentId}
            AND channel = ${scope.channel}
            AND hash = ${hash}
            AND deleted_at IS NULL
            AND superseded_by IS NULL
          LIMIT 1
        `)
        if (dup.rows.length > 0) {
          const existingId = String((dup.rows[0] as Record<string, unknown>).id)
          results.push({ op, factId: existingId, skipped: true })
          continue
        }

        const inserted = await tx
          .insert(facts)
          .values({
            agentId: scope.agentId,
            channel: scope.channel,
            threadId: scope.threadId ?? null,
            text: op.text,
            embedding: op.embedding,
            hash,
            attributedToRunId: op.runId ?? null,
          })
          .returning({ id: facts.id })

        const factId = inserted[0]?.id
        if (!factId) throw new TalosDbError('ADD insert returned no row', 'DB_NO_ROW')

        await tx.insert(factHistory).values({
          factId,
          event: 'ADD',
          oldText: null,
          newText: op.text,
          runId: op.runId ?? null,
        })

        results.push({ op, factId, skipped: false })
        continue
      }

      if (op.kind === 'UPDATE') {
        const target = await tx.execute(sql`
          SELECT id, agent_id, channel, thread_id, text
          FROM facts
          WHERE id = ${op.targetId}
            AND deleted_at IS NULL
            AND superseded_by IS NULL
          LIMIT 1
        `)
        const row = target.rows[0] as Record<string, unknown> | undefined
        if (!row) {
          throw new TalosDbError(
            `UPDATE target ${op.targetId} not found or not live`,
            'DB_FACT_TARGET_MISSING',
          )
        }

        const oldText = String(row.text)
        const newHash = hashFactText(op.text)

        const inserted = await tx
          .insert(facts)
          .values({
            agentId: String(row.agent_id),
            channel: String(row.channel),
            threadId: row.thread_id == null ? null : String(row.thread_id),
            text: op.text,
            embedding: op.embedding,
            hash: newHash,
            attributedToRunId: op.runId ?? null,
          })
          .returning({ id: facts.id })

        const newId = inserted[0]?.id
        if (!newId) throw new TalosDbError('UPDATE insert returned no row', 'DB_NO_ROW')

        await tx.execute(sql`
          UPDATE facts
          SET superseded_by = ${newId}, updated_at = now()
          WHERE id = ${op.targetId}
        `)

        await tx.insert(factHistory).values({
          factId: newId,
          event: 'UPDATE',
          oldText,
          newText: op.text,
          runId: op.runId ?? null,
        })

        results.push({ op, factId: newId, skipped: false })
        continue
      }

      // DELETE
      const target = await tx.execute(sql`
        SELECT text FROM facts
        WHERE id = ${op.targetId}
          AND deleted_at IS NULL
        LIMIT 1
      `)
      const row = target.rows[0] as Record<string, unknown> | undefined
      if (!row) {
        throw new TalosDbError(
          `DELETE target ${op.targetId} not found or already deleted`,
          'DB_FACT_TARGET_MISSING',
        )
      }
      const oldText = String(row.text)

      await tx.execute(sql`
        UPDATE facts SET deleted_at = now(), updated_at = now()
        WHERE id = ${op.targetId}
      `)

      await tx.insert(factHistory).values({
        factId: op.targetId,
        event: 'DELETE',
        oldText,
        newText: null,
        runId: op.runId ?? null,
      })

      results.push({ op, factId: op.targetId, skipped: false })
    }
  })

  return results
}

// ---------- pipeline orchestrator ----------

export type PipelineDeps = {
  extract: FactExtractor
  reconcile: FactReconciler
  /** how many existing facts to retrieve per candidate (default 5) */
  candidatePoolSize?: number
  /** runId attributed to all ops emitted in this pass (optional) */
  runId?: string | null
}

/**
 * Full Mem0 pass: extract → search existing → reconcile → apply.
 * The LLM-backed extract + reconcile come from the runtime; this orchestrator
 * is pure data flow and can be tested with deterministic stubs.
 */
export async function reconcileAndApplyFacts(
  db: Db,
  scope: FactScope,
  newMessages: Array<{ role: string; content: string }>,
  deps: PipelineDeps,
): Promise<FactOp[]> {
  const candidates = await deps.extract(newMessages)
  if (candidates.length === 0) return []

  const candidatePoolSize = deps.candidatePoolSize ?? 5
  const existingIdSet = new Map<string, ExistingFact>()
  for (const c of candidates) {
    const hits = await recallFacts(db, scope, c.embedding, c.text, {
      topK: candidatePoolSize,
    })
    for (const h of hits) {
      const prior = existingIdSet.get(h.id)
      if (!prior || h.vsim > prior.vsim) {
        existingIdSet.set(h.id, { id: h.id, text: h.text, vsim: h.vsim })
      }
    }
  }
  const existing = Array.from(existingIdSet.values())

  const ops = await deps.reconcile({ scope, candidates, existing })
  if (ops.length === 0) return []

  const opsWithRun: FactOp[] = ops.map((op) => {
    if (op.kind === 'NONE') return op
    return { ...op, runId: op.runId ?? deps.runId ?? null }
  })

  await applyFactOps(db, scope, opsWithRun)
  return opsWithRun
}
