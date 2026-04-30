import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle, runMigrations } from '@/persistence'
import { AgentRegistry, createRuntime, TALOS_ETH_AGENT } from '@/runtime'
import type { EmbeddingsService } from '@/runtime/types'
import { createFixtureToolSource, FIXTURE_TOOL_NAMES, type FixtureCallLog } from './fixture-tools'
import { formatTrace } from './format-trace'
import { createDemoMockProvider, DEMO_FINAL_TEXT } from './mock-provider'

/**
 * F12.16 — demo-flow eval (regression gate, P0 CRITICAL).
 *
 * End-to-end agent run on the locked demo prompt against a mock LLM and
 * fixture tools. Asserts:
 *   1. Tool-call sequence equals [balance, quote, swap]
 *   2. Final assistant message contains the balance, quoted USDC, and tx hash
 *   3. Step count matches the recorded 4-step conversation
 *   4. `runs.status` is `completed` and at least the user + assistant
 *      message_embeddings landed
 *
 * The eval is fully deterministic: no live OpenAI, no live Sepolia, no
 * real AgentKit init. Future PRs that change tool naming, drop a tool,
 * regress the runtime loop, or break persistence on the happy path will
 * fail here before merge.
 */

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

function deterministicEmbeddings(): EmbeddingsService {
  let counter = 0
  return {
    embed: async () => fakeEmbedding(++counter),
    embedMany: async (texts) => texts.map(() => fakeEmbedding(++counter)),
  }
}

function withRegistry(): AgentRegistry {
  const reg = new AgentRegistry()
  reg.register(TALOS_ETH_AGENT, { default: true })
  return reg
}

async function drain(handle: { fullStream: AsyncIterable<unknown>; done: Promise<void> }) {
  const events: unknown[] = []
  for await (const part of handle.fullStream) events.push(part)
  await handle.done
  return events
}

describe('demo-flow eval — F12.16', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('emits balance -> quote -> swap and surfaces all three results in the final message', async () => {
    const fixtureSource = createFixtureToolSource()
    const runtime = createRuntime({
      db: handle,
      providers: createDemoMockProvider(),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      toolSources: [fixtureSource],
      // No tool middleware — eval focuses on the demo path itself, not
      // KeeperHub audit. `tool_calls` rows therefore stay empty (single-
      // writer rule), but `steps` + `runs` are still written.
    })

    const run = await runtime.run({
      threadId: 'eval:demo-flow',
      channel: 'cli',
      intent: "what's my eth balance, then quote me 0.01 ETH -> USDC on Sepolia, then execute",
    })

    await drain(run)

    // 1. Tool-call sequence — fixture source records every execute() call.
    const expectedSequence = [
      FIXTURE_TOOL_NAMES.balance,
      FIXTURE_TOOL_NAMES.quote,
      FIXTURE_TOOL_NAMES.swap,
    ]
    const actualSequence = fixtureSource.calls
    assertSequence(expectedSequence, actualSequence)

    // 2. Tool-call args — sanity-check the agent forwarded the prompt's
    //    numbers so a future regression that scrambles JSON wiring fails here.
    expect(actualSequence[1]?.args).toMatchObject({
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amountIn: '0.01',
    })
    expect(actualSequence[2]?.args).toMatchObject({
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amountIn: '0.01',
    })

    // 3. Final assistant message — must mention balance, quoted USDC, tx hash.
    const finalText = await readRunSummary(handle, run.runId)
    expect(finalText, 'final assistant message empty').toBe(DEMO_FINAL_TEXT)
    expect(finalText).toContain('1.0 ETH')
    expect(finalText).toContain('25.00 USDC')
    expect(finalText).toContain('0xabc')

    // 4. Persistence — runs row completed, steps written, user + assistant
    //    embeddings landed. Catches "agent looks fine in stream but fails
    //    silently to persist" regressions.
    const runRow = await handle.pg.query<{ status: string }>(
      'SELECT status FROM runs WHERE id = $1',
      [run.runId],
    )
    expect(runRow.rows[0]?.status).toBe('completed')

    const stepRows = await handle.pg.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM steps WHERE run_id = $1',
      [run.runId],
    )
    expect(Number(stepRows.rows[0]?.count ?? '0')).toBe(4)

    const embRows = await handle.pg.query<{ role: string; count: string }>(
      `SELECT role, COUNT(*)::text AS count
       FROM message_embeddings WHERE thread_id = 'eval:demo-flow'
       GROUP BY role`,
    )
    expect(embRows.rows.find((r) => r.role === 'user')?.count).toBe('1')
    expect(embRows.rows.find((r) => r.role === 'assistant')?.count).toBe('1')
  })
})

function assertSequence(expected: readonly string[], actual: readonly FixtureCallLog[]): void {
  const ok =
    actual.length === expected.length && expected.every((name, i) => actual[i]?.name === name)
  if (ok) return
  throw new Error(`tool-call sequence mismatch\n${formatTrace(expected, actual)}`)
}

async function readRunSummary(handle: DbHandle, runId: string): Promise<string> {
  const r = await handle.pg.query<{ summary: string | null }>(
    'SELECT summary FROM runs WHERE id = $1',
    [runId],
  )
  return r.rows[0]?.summary ?? ''
}
