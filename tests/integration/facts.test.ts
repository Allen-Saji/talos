import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFactOps,
  createDb,
  type DbHandle,
  type ExtractedFact,
  type FactExtractor,
  type FactOp,
  type FactReconciler,
  type FactScope,
  hashFactText,
  normalizeFactText,
  recallFacts,
  reconcileAndApplyFacts,
  runMigrations,
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

const SCOPE: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-facts' }

describe('facts — text helpers', () => {
  it('normalizes whitespace + case', () => {
    expect(normalizeFactText('  Hello  WORLD  ')).toBe('hello world')
    expect(normalizeFactText('Aave  on\tArbitrum\n')).toBe('aave on arbitrum')
  })

  it('hash collides on equivalent normalized text', () => {
    expect(hashFactText('Aave on Arbitrum')).toBe(hashFactText('aave  on  arbitrum'))
    expect(hashFactText('a')).not.toBe(hashFactText('b'))
  })
})

describe('facts — applyFactOps', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('ADD inserts a live fact + history(ADD) row', async () => {
    const result = await applyFactOps(handle.db, SCOPE, [
      { kind: 'ADD', text: 'user prefers Aave on Arbitrum', embedding: fakeEmbedding(1) },
    ])

    expect(result.length).toBe(1)
    const r = result[0]
    expect(r).toBeDefined()
    if (!r) return
    expect(r.skipped).toBe(false)
    expect(r.factId).not.toBeNull()

    const factRows = await handle.pg.query<{ id: string; text: string; deleted_at: string | null }>(
      `SELECT id, text, deleted_at FROM facts WHERE id = $1`,
      [r.factId],
    )
    expect(factRows.rows.length).toBe(1)
    expect(factRows.rows[0]?.text).toBe('user prefers Aave on Arbitrum')
    expect(factRows.rows[0]?.deleted_at).toBeNull()

    const hist = await handle.pg.query<{ event: string; new_text: string }>(
      `SELECT event, new_text FROM fact_history WHERE fact_id = $1`,
      [r.factId],
    )
    expect(hist.rows.length).toBe(1)
    expect(hist.rows[0]?.event).toBe('ADD')
    expect(hist.rows[0]?.new_text).toBe('user prefers Aave on Arbitrum')
  })

  it('ADD is hash-idempotent within scope (skipped on duplicate)', async () => {
    const first = await applyFactOps(handle.db, SCOPE, [
      { kind: 'ADD', text: 'main wallet 0xABCD', embedding: fakeEmbedding(2) },
    ])
    const second = await applyFactOps(handle.db, SCOPE, [
      { kind: 'ADD', text: 'main  wallet  0xABCD', embedding: fakeEmbedding(2) },
    ])

    expect(first[0]?.skipped).toBe(false)
    expect(second[0]?.skipped).toBe(true)
    expect(second[0]?.factId).toBe(first[0]?.factId)

    const hist = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM fact_history WHERE fact_id = $1`,
      [first[0]?.factId],
    )
    expect(hist.rows[0]?.count).toBe('1')
  })

  it('UPDATE inserts a replacement, sets supersede pointer, writes history(UPDATE)', async () => {
    const add = await applyFactOps(handle.db, SCOPE, [
      { kind: 'ADD', text: 'user uses Compound', embedding: fakeEmbedding(3) },
    ])
    const oldId = add[0]?.factId
    expect(oldId).toBeDefined()
    if (!oldId) return

    const upd = await applyFactOps(handle.db, SCOPE, [
      {
        kind: 'UPDATE',
        targetId: oldId,
        text: 'user prefers Aave over Compound',
        embedding: fakeEmbedding(4),
      },
    ])
    const newId = upd[0]?.factId
    expect(newId).toBeDefined()
    expect(newId).not.toBe(oldId)

    const oldRow = await handle.pg.query<{ superseded_by: string | null }>(
      `SELECT superseded_by FROM facts WHERE id = $1`,
      [oldId],
    )
    expect(oldRow.rows[0]?.superseded_by).toBe(newId)

    const hist = await handle.pg.query<{ event: string; old_text: string; new_text: string }>(
      `SELECT event, old_text, new_text FROM fact_history WHERE fact_id = $1`,
      [newId],
    )
    expect(hist.rows[0]?.event).toBe('UPDATE')
    expect(hist.rows[0]?.old_text).toBe('user uses Compound')
    expect(hist.rows[0]?.new_text).toBe('user prefers Aave over Compound')
  })

  it('UPDATE on missing target throws', async () => {
    await expect(
      applyFactOps(handle.db, SCOPE, [
        {
          kind: 'UPDATE',
          targetId: '00000000-0000-0000-0000-000000000000',
          text: 'noop',
          embedding: fakeEmbedding(5),
        },
      ]),
    ).rejects.toThrow(/UPDATE target .* not found/)
  })

  it('DELETE soft-deletes + writes history(DELETE)', async () => {
    const add = await applyFactOps(handle.db, SCOPE, [
      { kind: 'ADD', text: 'user holds USDC on mainnet', embedding: fakeEmbedding(6) },
    ])
    const id = add[0]?.factId
    expect(id).toBeDefined()
    if (!id) return

    await applyFactOps(handle.db, SCOPE, [{ kind: 'DELETE', targetId: id }])

    const row = await handle.pg.query<{ deleted_at: string | null; text: string }>(
      `SELECT deleted_at, text FROM facts WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]?.deleted_at).not.toBeNull()
    expect(row.rows[0]?.text).toBe('user holds USDC on mainnet')

    const hist = await handle.pg.query<{
      event: string
      old_text: string
      new_text: string | null
    }>(
      `SELECT event, old_text, new_text FROM fact_history
       WHERE fact_id = $1 AND event = 'DELETE'`,
      [id],
    )
    expect(hist.rows[0]?.event).toBe('DELETE')
    expect(hist.rows[0]?.old_text).toBe('user holds USDC on mainnet')
    expect(hist.rows[0]?.new_text).toBeNull()
  })

  it('NONE op writes nothing', async () => {
    const result = await applyFactOps(handle.db, SCOPE, [{ kind: 'NONE' }])
    expect(result[0]?.skipped).toBe(true)
    const all = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM fact_history`,
    )
    expect(all.rows[0]?.count).toBe('0')
  })

  it('rejects wrong-dim embeddings before opening transaction', async () => {
    await expect(
      applyFactOps(handle.db, SCOPE, [{ kind: 'ADD', text: 'bad', embedding: [1, 2, 3] }]),
    ).rejects.toThrow(/embedding must be 1536/)
  })
})

describe('facts — recallFacts', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)

    const seedScope: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-recall' }
    await applyFactOps(handle.db, seedScope, [
      { kind: 'ADD', text: 'user prefers Aave on Arbitrum', embedding: fakeEmbedding(1) },
      { kind: 'ADD', text: 'user holds 5 ETH on mainnet', embedding: fakeEmbedding(50) },
      { kind: 'ADD', text: 'user uses Uniswap for swaps', embedding: fakeEmbedding(100) },
    ])
    // channel-wide fact (thread_id = null)
    await applyFactOps(handle.db, { agentId: 'talos-eth', channel: 'cli', threadId: null }, [
      { kind: 'ADD', text: "user's main wallet 0xCAFE", embedding: fakeEmbedding(1) },
    ])
    // unrelated scope (different channel) — must not leak
    await applyFactOps(handle.db, { agentId: 'talos-eth', channel: 'tg', threadId: 't-recall' }, [
      { kind: 'ADD', text: 'should never appear in cli recall', embedding: fakeEmbedding(1) },
    ])
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('returns hits ordered by hybrid score, scoped per (agent, channel)', async () => {
    const hits = await recallFacts(
      handle.db,
      { agentId: 'talos-eth', channel: 'cli', threadId: 't-recall' },
      fakeEmbedding(1),
      'aave arbitrum',
      { topK: 5, includeChannelWide: true },
    )

    expect(hits.length).toBeGreaterThan(0)
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]
      const curr = hits[i]
      if (prev && curr) expect(prev.score).toBeGreaterThanOrEqual(curr.score)
    }
    expect(hits.some((h) => h.text.toLowerCase().includes('aave'))).toBe(true)
    expect(hits.some((h) => h.text.includes('cli recall'))).toBe(false)
  })

  it('excludes channel-wide facts when includeChannelWide=false', async () => {
    const hits = await recallFacts(
      handle.db,
      { agentId: 'talos-eth', channel: 'cli', threadId: 't-recall' },
      fakeEmbedding(1),
      'wallet',
      { topK: 10, includeChannelWide: false },
    )
    expect(hits.some((h) => h.text.includes('main wallet'))).toBe(false)
  })

  it('skips superseded + deleted facts', async () => {
    const scope: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-recall' }
    const live = await recallFacts(handle.db, scope, fakeEmbedding(1), 'aave', { topK: 10 })
    const aave = live.find((h) => h.text.toLowerCase().includes('aave'))
    expect(aave).toBeDefined()
    if (!aave) return

    await applyFactOps(handle.db, scope, [
      {
        kind: 'UPDATE',
        targetId: aave.id,
        text: 'user prefers Compound after all',
        embedding: fakeEmbedding(200),
      },
    ])

    const after = await recallFacts(handle.db, scope, fakeEmbedding(1), 'aave', { topK: 10 })
    expect(after.find((h) => h.id === aave.id)).toBeUndefined()
    expect(after.some((h) => h.text.includes('Compound after all'))).toBe(true)

    const compound = after.find((h) => h.text.includes('Compound after all'))
    if (compound) {
      await applyFactOps(handle.db, scope, [{ kind: 'DELETE', targetId: compound.id }])
      const final = await recallFacts(handle.db, scope, fakeEmbedding(1), 'aave', { topK: 10 })
      expect(final.find((h) => h.id === compound.id)).toBeUndefined()
    }
  })

  it('rejects wrong-dim query embeddings', async () => {
    await expect(recallFacts(handle.db, SCOPE, [1, 2, 3], 'q')).rejects.toThrow(
      /queryEmbedding must be 1536/,
    )
  })
})

describe('facts — reconcileAndApplyFacts (pipeline)', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('runs extract → reconcile → apply with mocked deps', async () => {
    const scope: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-pipe' }

    const candidates: ExtractedFact[] = [
      { text: 'user prefers Aave on Arbitrum', embedding: fakeEmbedding(1) },
      { text: 'user holds 5 ETH on mainnet', embedding: fakeEmbedding(50) },
    ]

    const extract: FactExtractor = async () => candidates
    const reconcile: FactReconciler = async ({ candidates: cands }) =>
      cands.map<FactOp>((c) => ({ kind: 'ADD', text: c.text, embedding: c.embedding }))

    const ops = await reconcileAndApplyFacts(
      handle.db,
      scope,
      [{ role: 'user', content: 'I usually use Aave on Arbitrum and hold ~5 ETH on mainnet' }],
      { extract, reconcile, runId: null },
    )

    expect(ops.length).toBe(2)
    expect(ops.every((o) => o.kind === 'ADD')).toBe(true)

    const hits = await recallFacts(handle.db, scope, fakeEmbedding(1), 'aave', { topK: 5 })
    expect(hits.some((h) => h.text.includes('Aave on Arbitrum'))).toBe(true)
  })

  it('reconciler can return UPDATE based on existing facts', async () => {
    const scope: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-pipe2' }

    await applyFactOps(handle.db, scope, [
      { kind: 'ADD', text: 'user uses Compound', embedding: fakeEmbedding(3) },
    ])

    const extract: FactExtractor = async () => [
      { text: 'user prefers Aave over Compound now', embedding: fakeEmbedding(4) },
    ]

    const reconcile: FactReconciler = async ({ existing, candidates: cands }) => {
      const target = existing[0]
      const cand = cands[0]
      if (!target || !cand) return []
      return [{ kind: 'UPDATE', targetId: target.id, text: cand.text, embedding: cand.embedding }]
    }

    const ops = await reconcileAndApplyFacts(
      handle.db,
      scope,
      [{ role: 'user', content: 'switching from Compound to Aave' }],
      { extract, reconcile },
    )

    expect(ops[0]?.kind).toBe('UPDATE')
    const hits = await recallFacts(handle.db, scope, fakeEmbedding(4), 'aave', { topK: 5 })
    expect(hits.some((h) => h.text.includes('prefers Aave over Compound now'))).toBe(true)
  })

  it('returns empty when extractor returns no candidates', async () => {
    const scope: FactScope = { agentId: 'talos-eth', channel: 'cli', threadId: 't-empty' }
    const ops = await reconcileAndApplyFacts(handle.db, scope, [], {
      extract: async () => [],
      reconcile: async () => {
        throw new Error('reconcile should not be called')
      },
    })
    expect(ops).toEqual([])
  })
})
