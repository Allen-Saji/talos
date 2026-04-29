import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendStep,
  assertNoLiveDaemon,
  closeRun,
  createDb,
  type DbHandle,
  insertMessageEmbedding,
  openRun,
  recordToolCall,
  runMigrations,
  searchMessages,
  upsertThread,
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

describe('persistence — migrations + schema', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('creates all tables idempotently (re-run is a no-op)', async () => {
    await runMigrations(handle)
    const result = await handle.pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    )
    const names = result.rows.map((r) => r.table_name)
    expect(names).toEqual(
      expect.arrayContaining([
        'threads',
        'runs',
        'steps',
        'tool_calls',
        'message_embeddings',
        'knowledge_chunks',
      ]),
    )
  })

  it('writes thread → run → step → tool_call respecting FKs', async () => {
    const thread = await upsertThread(handle.db, {
      id: 'cli:test:default',
      channel: 'cli',
      title: 'test thread',
    })
    expect(thread.id).toBe('cli:test:default')

    const run = await openRun(handle.db, {
      threadId: thread.id,
      prompt: 'supply 100 USDC to Aave on Arbitrum',
    })
    expect(run.status).toBe('running')

    const step = await appendStep(handle.db, {
      runId: run.id,
      stepIndex: 0,
      role: 'assistant',
      content: 'invoking aave_supply',
    })
    expect(step.runId).toBe(run.id)

    const tc = await recordToolCall(handle.db, {
      runId: run.id,
      stepId: step.id,
      toolCallId: 'call_1',
      toolName: 'aave_supply',
      args: { amount: '100', asset: 'USDC', chain: 'arbitrum' },
    })
    expect(tc.toolName).toBe('aave_supply')

    await closeRun(handle.db, run.id, { status: 'completed', summary: 'done' })

    const after = await handle.pg.query<{ status: string; summary: string }>(
      `SELECT status, summary FROM runs WHERE id = $1`,
      [run.id],
    )
    expect(after.rows[0]?.status).toBe('completed')
    expect(after.rows[0]?.summary).toBe('done')
  })
})

describe('persistence — vector + hybrid search', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
    await upsertThread(handle.db, { id: 't-search', channel: 'cli' })
  })

  afterEach(async () => {
    await handle?.close()
  })

  const corpus = [
    'supply 100 USDC to Aave on Arbitrum',
    'check my Aave health factor',
    'swap 1 ETH for USDC on Uniswap',
    'bridge ETH from Mainnet to Base via Lifi',
    'stake 32 ETH to Lido',
    'borrow DAI from Aave',
    'create a Safe multisig',
    'pull current ETH price from Pyth',
    'sweep dust from Optimism to Base',
    'what is my wallet balance on Arbitrum',
  ]

  it('returns rows ordered by HNSW cosine + tsvector hybrid score', async () => {
    for (let i = 0; i < corpus.length; i++) {
      const content = corpus[i]
      if (!content) continue
      await insertMessageEmbedding(handle.db, {
        threadId: 't-search',
        role: 'user',
        content,
        embedding: fakeEmbedding(i + 1),
      })
    }

    const queryEmb = fakeEmbedding(1)
    const hits = await searchMessages(handle.db, 't-search', queryEmb, 'aave arbitrum', {
      topK: 5,
    })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)

    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]
      const curr = hits[i]
      if (prev && curr) expect(prev.score).toBeGreaterThanOrEqual(curr.score)
    }

    const top = hits[0]
    expect(top).toBeDefined()
    if (top) {
      expect(top.threadId).toBe('t-search')
      expect(top.score).toBeGreaterThan(0)
    }

    const aaveHit = hits.find((h) => h.content.toLowerCase().includes('aave'))
    expect(aaveHit).toBeDefined()
  })

  it('rejects wrong-dimension embeddings', async () => {
    await expect(
      insertMessageEmbedding(handle.db, {
        threadId: 't-search',
        role: 'user',
        content: 'bad',
        embedding: [1, 2, 3],
      }),
    ).rejects.toThrow(/embedding must be 1536/)
  })
})

describe('persistence — ownership', () => {
  let tmpDir: string
  let pidPath: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talos-ownership-'))
    pidPath = path.join(tmpDir, 'daemon.pid')
    dbPath = path.join(tmpDir, 'db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when no pidfile', () => {
    expect(() => assertNoLiveDaemon({ paths: { pidPath, dbPath } })).not.toThrow()
  })

  it('throws when pidfile points at a live process', () => {
    fs.writeFileSync(pidPath, String(process.pid))
    expect(() =>
      assertNoLiveDaemon({ paths: { pidPath, dbPath }, selfPid: process.pid + 1 }),
    ).toThrow(/daemon \(pid \d+\) holds/)
  })

  it('clears stale pidfile when pid is dead', () => {
    fs.writeFileSync(pidPath, '999999999')
    expect(() => assertNoLiveDaemon({ paths: { pidPath, dbPath } })).not.toThrow()
    expect(fs.existsSync(pidPath)).toBe(false)
  })

  it('passes when pidfile points at self', () => {
    fs.writeFileSync(pidPath, String(process.pid))
    expect(() => assertNoLiveDaemon({ paths: { pidPath, dbPath } })).not.toThrow()
  })

  it('discards pidfile with malformed contents', () => {
    fs.writeFileSync(pidPath, 'not-a-pid')
    expect(() => assertNoLiveDaemon({ paths: { pidPath, dbPath } })).not.toThrow()
    expect(fs.existsSync(pidPath)).toBe(false)
  })
})
