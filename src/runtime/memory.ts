import type { ModelMessage } from 'ai'
import { sql } from 'drizzle-orm'
import type { DbHandle } from '@/persistence/client'
import { latestThreadSummary, searchThreadSummaries } from '@/persistence/queries'

type Db = DbHandle['db']

/**
 * Hot-tier replay. Returns the most-recent N runs as a flat ModelMessage[].
 * For v1 we use the run's `prompt` (user) + `summary` (assistant) — simpler
 * than reconstructing from steps and good enough for the demo. The richer
 * step-history reconstruction can land in a v1.1 PR if needed.
 *
 * Excludes the current run by default; pass `excludeRunId` if your run is
 * already open when this is called.
 */
export async function recentMessages(
  db: Db,
  threadId: string,
  limit: number,
  excludeRunId?: string,
): Promise<ModelMessage[]> {
  const exclude = excludeRunId ?? null
  const rows = await db.execute(sql`
    SELECT prompt, summary, started_at
    FROM runs
    WHERE thread_id = ${threadId}
      AND status IN ('completed', 'failed')
      AND (${exclude}::uuid IS NULL OR id <> ${exclude}::uuid)
    ORDER BY started_at DESC
    LIMIT ${limit}
  `)

  const ordered = (rows.rows as Array<Record<string, unknown>>)
    .reverse()
    .flatMap<ModelMessage>((row) => {
      const prompt = String(row.prompt ?? '')
      const summary = row.summary == null ? '' : String(row.summary)
      const out: ModelMessage[] = []
      if (prompt) out.push({ role: 'user', content: prompt })
      if (summary) out.push({ role: 'assistant', content: summary })
      return out
    })

  return ordered
}

export async function warmTierSummary(db: Db, threadId: string): Promise<string | null> {
  const row = await latestThreadSummary(db, threadId)
  return row?.summary ?? null
}

export async function coldRecall(
  db: Db,
  queryEmbedding: number[],
  excludeThreadId: string,
  opts: { topK?: number; threshold?: number } = {},
): Promise<string[]> {
  const hits = await searchThreadSummaries(db, queryEmbedding, {
    topK: opts.topK ?? 3,
    threshold: opts.threshold ?? 0.78,
    excludeThreadId,
  })
  return hits.map((h) => h.summary)
}

export async function runCount(db: Db, threadId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM runs WHERE thread_id = ${threadId}
  `)
  const row = result.rows[0] as Record<string, unknown> | undefined
  return Number(row?.count ?? 0)
}
