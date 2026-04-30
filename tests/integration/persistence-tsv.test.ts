import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDb,
  type DbHandle,
  insertMessageEmbedding,
  runMigrations,
  upsertThread,
} from '@/persistence'

const EMBEDDING_DIMS = 1536

function fakeEmbedding(seed: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0)
  v[0] = seed
  let norm = 0
  for (const n of v) norm += n * n
  norm = Math.sqrt(norm) || 1
  return v.map((n) => n / norm)
}

/**
 * Acceptance tests for issue #15 — `message_embeddings.tsv` is a STORED
 * generated column populated automatically by Postgres, indexed by GIN.
 */
describe('message_embeddings.tsv — generated column + GIN index', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
    await upsertThread(handle.db, { id: 't-tsv', channel: 'cli' })
  })

  afterEach(async () => {
    await handle.close()
  })

  it('auto-populates tsv on insert (no explicit value passed)', async () => {
    await insertMessageEmbedding(handle.db, {
      threadId: 't-tsv',
      role: 'user',
      content: 'check my wallet balance on Arbitrum',
      embedding: fakeEmbedding(1),
    })

    const result = (await handle.db.execute(sql`
      SELECT tsv::text AS tsv FROM message_embeddings WHERE thread_id = 't-tsv'
    `)) as { rows: Array<{ tsv: string }> }

    expect(result.rows).toHaveLength(1)
    const tsv = result.rows[0]?.tsv ?? ''
    // Stemmed lexemes — 'wallet', 'balanc', 'arbitrum' all show up
    expect(tsv).toMatch(/wallet/)
    expect(tsv).toMatch(/balanc/)
    expect(tsv).toMatch(/arbitrum/)
  })

  it('matches via to_tsquery prefix lexeme', async () => {
    await insertMessageEmbedding(handle.db, {
      threadId: 't-tsv',
      role: 'user',
      content: 'sweep ETH from Optimism to Base',
      embedding: fakeEmbedding(2),
    })
    await insertMessageEmbedding(handle.db, {
      threadId: 't-tsv',
      role: 'assistant',
      content: 'supplied 100 USDC to Aave on Arbitrum',
      embedding: fakeEmbedding(3),
    })

    const result = (await handle.db.execute(sql`
      SELECT content
      FROM message_embeddings
      WHERE thread_id = 't-tsv'
        AND tsv @@ to_tsquery('english', 'aave:*')
    `)) as { rows: Array<{ content: string }> }

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.content).toContain('Aave')
  })

  it('rejects manual writes to tsv (column is GENERATED ALWAYS)', async () => {
    await insertMessageEmbedding(handle.db, {
      threadId: 't-tsv',
      role: 'user',
      content: 'hello world',
      embedding: fakeEmbedding(4),
    })

    // Postgres rejects updates to a generated column. PGLite wraps the
    // underlying error so we only assert that it throws — the prior insert
    // proves the column is auto-populated, this proves it can't be hijacked.
    await expect(
      handle.db.execute(sql`
        UPDATE message_embeddings
        SET tsv = to_tsvector('english', 'override')
        WHERE thread_id = 't-tsv'
      `),
    ).rejects.toThrow()
  })

  it('GIN index on tsv exists', async () => {
    const result = (await handle.db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'message_embeddings'
        AND indexname = 'message_embeddings_tsv_gin_idx'
    `)) as { rows: Array<{ indexname: string; indexdef: string }> }

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.indexdef).toMatch(/USING gin/i)
    expect(result.rows[0]?.indexdef).toMatch(/\(tsv\)/)
  })

  it('updates tsv when content changes', async () => {
    await insertMessageEmbedding(handle.db, {
      threadId: 't-tsv',
      role: 'user',
      content: 'initial content',
      embedding: fakeEmbedding(5),
    })

    await handle.db.execute(sql`
      UPDATE message_embeddings
      SET content = 'updated message about Uniswap'
      WHERE thread_id = 't-tsv'
    `)

    const result = (await handle.db.execute(sql`
      SELECT tsv::text AS tsv
      FROM message_embeddings
      WHERE thread_id = 't-tsv'
    `)) as { rows: Array<{ tsv: string }> }

    expect(result.rows[0]?.tsv).toMatch(/uniswap/)
    expect(result.rows[0]?.tsv).not.toMatch(/initial/)
  })
})
