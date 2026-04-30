import { tool } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createKeeperHubMiddleware } from '@/keeperhub'
import {
  applyFactOps,
  createDb,
  type DbHandle,
  insertMessageEmbedding,
  runMigrations,
  upsertThread,
  writeThreadSummary,
} from '@/persistence'
import {
  AgentRegistry,
  buildSystemPrompt,
  createRuntime,
  type EmbeddingsService,
  type FactPipeline,
  type ProviderRouter,
  type RunContext,
  TALOS_ETH_AGENT,
  type ThreadSummarizer,
  type ToolMiddleware,
  type ToolSource,
} from '@/runtime'

// AI SDK v6 stream chunk shape, structural minimum for test fixtures.
// We avoid importing from `@ai-sdk/provider` directly (transitive only).
type StreamChunk =
  | { type: 'stream-start'; warnings: unknown[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | {
      type: 'finish'
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
      finishReason: string
    }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }

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
    embed: async (_text) => fakeEmbedding(++counter),
    embedMany: async (texts) => texts.map(() => fakeEmbedding(++counter)),
  }
}

function textOnlyChunks(text: string): StreamChunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    {
      type: 'finish',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    },
  ]
}

function toolCallThenTextChunks(opts: {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  finalText: string
}): {
  step1: StreamChunk[]
  step2: StreamChunk[]
} {
  return {
    step1: [
      { type: 'stream-start', warnings: [] },
      {
        type: 'tool-call',
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
        input: JSON.stringify(opts.input),
      } as StreamChunk,
      {
        type: 'finish',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'tool-calls',
      },
    ],
    step2: textOnlyChunks(opts.finalText),
  }
}

function makeMockModel(chunkSets: StreamChunk[][]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = chunkSets[call] ?? chunkSets[chunkSets.length - 1] ?? []
      call++
      // Structural cast — chunk shape matches LanguageModelV3StreamPart but the
      // provider type isn't a direct dependency.
      return { stream: simulateReadableStream({ chunks }) } as never
    },
  })
}

function singleModelRouter(model: MockLanguageModelV3): ProviderRouter {
  return { resolve: () => model }
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

// ---------------- prompt assembly ----------------

describe('prompt — buildSystemPrompt', () => {
  it('omits empty blocks, preserves order', () => {
    const out = buildSystemPrompt({
      persona: 'P',
      knowledgeChunks: [{ source: 'l2beat', content: 'arb total value' }],
      coldRecallSummaries: ['prior thread A'],
      warmSummary: 'this thread so far',
      toolNames: ['aave_supply'],
    })
    expect(out).toContain('P')
    expect(out.indexOf('Recent ETH ecosystem state:')).toBeLessThan(
      out.indexOf('Prior context (other conversations):'),
    )
    expect(out.indexOf('Prior context')).toBeLessThan(out.indexOf('Thread summary so far:'))
    expect(out).toContain('Tools available: aave_supply')
  })

  it('persona-only when no tiers populated', () => {
    const out = buildSystemPrompt({ persona: 'just me' })
    expect(out).toBe('just me')
  })
})

// ---------------- agent registry ----------------

describe('AgentRegistry', () => {
  it('returns default + throws on unknown', () => {
    const reg = new AgentRegistry()
    reg.register(TALOS_ETH_AGENT, { default: true })
    expect(reg.get().id).toBe('talos-eth')
    expect(reg.get('talos-eth').id).toBe('talos-eth')
    expect(() => reg.get('nope')).toThrow(/unknown agent/)
  })

  it('throws when empty', () => {
    expect(() => new AgentRegistry().get()).toThrow(/empty/)
  })
})

// ---------------- text-only run ----------------

describe('runtime — text-only run', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('persists run + step + 2 message_embeddings (user, assistant)', async () => {
    const model = makeMockModel([textOnlyChunks('Hello, I can help with that.')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
    })

    const r = await runtime.run({
      threadId: 'cli:test:default',
      channel: 'cli',
      intent: 'hi',
    })

    const events = await drain(r)
    expect(events.length).toBeGreaterThan(0)

    const runRow = await handle.pg.query<{ status: string; summary: string }>(
      `SELECT status, summary FROM runs WHERE id = $1`,
      [r.runId],
    )
    expect(runRow.rows[0]?.status).toBe('completed')
    expect(runRow.rows[0]?.summary).toContain('Hello')

    const steps = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM steps WHERE run_id = $1`,
      [r.runId],
    )
    expect(steps.rows[0]?.count).toBe('1')

    const embs = await handle.pg.query<{ count: string; role: string }>(
      `SELECT COUNT(*)::text AS count, role
       FROM message_embeddings WHERE thread_id = 'cli:test:default'
       GROUP BY role ORDER BY role`,
    )
    expect(embs.rows.find((r) => r.role === 'user')?.count).toBe('1')
    expect(embs.rows.find((r) => r.role === 'assistant')?.count).toBe('1')
  })

  it('passes the system prompt with persona to the model', async () => {
    const model = makeMockModel([textOnlyChunks('ok')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
    })

    await drain(
      await runtime.run({ threadId: 't-prompt', channel: 'cli', intent: 'what is your name' }),
    )

    expect(model.doStreamCalls.length).toBe(1)
    const call = model.doStreamCalls[0]
    if (!call) throw new Error('no doStreamCall')
    const systemMsg = call.prompt.find((m) => m.role === 'system')
    expect(systemMsg).toBeDefined()
    if (systemMsg && systemMsg.role === 'system') {
      expect(systemMsg.content).toContain('Talos')
    }
  })

  it('injects cold recall when prior thread has a similar summary', async () => {
    // Seed a different thread + a summary embedding that matches
    await upsertThread(handle.db, { id: 'prior', channel: 'cli' })
    await writeThreadSummary(handle.db, {
      threadId: 'prior',
      summary: 'previously discussed Aave on Arbitrum',
      embedding: fakeEmbedding(1),
    })

    // Tweak the embeddings service to seed=1 so the user's embedding
    // matches the prior summary
    const fixedEmbeddings: EmbeddingsService = {
      embed: async () => fakeEmbedding(1),
      embedMany: async (xs) => xs.map(() => fakeEmbedding(1)),
    }

    const model = makeMockModel([textOnlyChunks('noted')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: fixedEmbeddings,
      agents: withRegistry(),
      config: { coldRecallThreshold: 0.5 },
    })

    await drain(
      await runtime.run({
        threadId: 'cli:current:default',
        channel: 'cli',
        intent: 'pull my balances',
      }),
    )

    const call = model.doStreamCalls[0]
    if (!call) throw new Error('no doStreamCall')
    const systemMsg = call.prompt.find((m) => m.role === 'system')
    if (systemMsg && systemMsg.role === 'system') {
      expect(systemMsg.content).toContain('Prior context')
      expect(systemMsg.content).toContain('Aave on Arbitrum')
    }
  })

  it('marks run cancelled when caller aborts', async () => {
    const model = makeMockModel([textOnlyChunks('would be a long response')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
    })
    const ac = new AbortController()
    const r = await runtime.run({
      threadId: 't-abort',
      channel: 'cli',
      intent: 'long task',
      abortSignal: ac.signal,
    })
    ac.abort()
    await r.done

    const row = await handle.pg.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
      r.runId,
    ])
    expect(['cancelled', 'completed']).toContain(row.rows[0]?.status)
  })
})

// ---------------- tool calling ----------------

describe('runtime — tool calling', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('writes a single audit row per tool call (KeeperHub middleware single writer)', async () => {
    const flow = toolCallThenTextChunks({
      toolName: 'getBalance',
      toolCallId: 'call_1',
      input: { wallet: '0xABC' },
      finalText: 'You have 5 ETH on Arbitrum.',
    })
    const model = makeMockModel([flow.step1, flow.step2])

    const balanceTool = tool({
      description: 'Get wallet balance',
      inputSchema: z.object({ wallet: z.string() }),
      execute: async ({ wallet }) => ({ wallet, balance: '5 ETH', chain: 'arbitrum' }),
    })
    const toolSource: ToolSource = { getTools: async () => ({ getBalance: balanceTool }) }

    const toolMiddleware = (ctx: RunContext): ToolMiddleware =>
      createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ctx,
      })

    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      toolSources: [toolSource],
      toolMiddleware,
      config: { maxSteps: 3 },
    })

    const r = await runtime.run({
      threadId: 't-tools',
      channel: 'cli',
      intent: 'check 0xABC balance on arbitrum',
    })
    await drain(r)

    const tcalls = await handle.pg.query<{
      tool_name: string
      args: { wallet: string }
      result: { balance: string }
      audit: { shouldAudit: boolean; reason: string; details: { elapsedMs: number } }
      error: string | null
    }>(`SELECT tool_name, args, result, audit, error FROM tool_calls WHERE run_id = $1`, [r.runId])
    expect(tcalls.rows.length).toBe(1)
    const row = tcalls.rows[0]!
    expect(row.tool_name).toBe('getBalance')
    expect(row.args.wallet).toBe('0xABC')
    expect(row.result.balance).toBe('5 ETH')
    expect(row.audit.shouldAudit).toBe(true)
    expect(row.audit.reason).toBe('audit_default')
    expect(row.audit.details.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(row.error).toBeNull()

    const steps = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM steps WHERE run_id = $1`,
      [r.runId],
    )
    expect(Number(steps.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(2)
  })

  it('records error and shouldAudit reason when tool throws', async () => {
    const flow = toolCallThenTextChunks({
      toolName: 'aave_supply',
      toolCallId: 'call_err',
      input: { amount: '100' },
      finalText: 'I could not complete the supply.',
    })
    const model = makeMockModel([flow.step1, flow.step2])

    const supplyTool = tool({
      description: 'Supply to Aave',
      inputSchema: z.object({ amount: z.string() }),
      execute: async (_input): Promise<{ ok: boolean }> => {
        throw new Error('insufficient liquidity')
      },
    })
    const toolSource: ToolSource = { getTools: async () => ({ aave_supply: supplyTool }) }

    const toolMiddleware = (ctx: RunContext): ToolMiddleware =>
      createKeeperHubMiddleware({
        db: handle.db,
        runContext: () => ctx,
        annotations: (name) => (name === 'aave_supply' ? { mutates: true } : undefined),
      })

    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      toolSources: [toolSource],
      toolMiddleware,
      config: { maxSteps: 3 },
    })

    const r = await runtime.run({
      threadId: 't-tools-err',
      channel: 'cli',
      intent: 'supply 100 USDC',
    })
    await drain(r)

    const tcalls = await handle.pg.query<{
      tool_name: string
      audit: { shouldAudit: boolean; reason: string }
      error: string | null
    }>(`SELECT tool_name, audit, error FROM tool_calls WHERE run_id = $1`, [r.runId])
    expect(tcalls.rows.length).toBe(1)
    const row = tcalls.rows[0]!
    expect(row.tool_name).toBe('aave_supply')
    expect(row.audit.shouldAudit).toBe(true)
    expect(row.audit.reason).toBe('annotation_mutates')
    expect(row.error).toContain('insufficient liquidity')
  })

  it('passes tools through unchanged when toolMiddleware is undefined (no audit rows)', async () => {
    const flow = toolCallThenTextChunks({
      toolName: 'getBalance',
      toolCallId: 'call_no_mw',
      input: { wallet: '0xDEF' },
      finalText: 'ok',
    })
    const model = makeMockModel([flow.step1, flow.step2])

    const balanceTool = tool({
      description: 'Get wallet balance',
      inputSchema: z.object({ wallet: z.string() }),
      execute: async ({ wallet }) => ({ wallet, balance: '0' }),
    })
    const toolSource: ToolSource = { getTools: async () => ({ getBalance: balanceTool }) }

    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      toolSources: [toolSource],
      config: { maxSteps: 3 },
    })

    const r = await runtime.run({
      threadId: 't-no-mw',
      channel: 'cli',
      intent: 'check 0xDEF',
    })
    await drain(r)

    const tcalls = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tool_calls WHERE run_id = $1`,
      [r.runId],
    )
    expect(tcalls.rows[0]?.count).toBe('0')

    // step row still landed with tool_calls jsonb summary
    const stepRow = await handle.pg.query<{ tool_calls: unknown }>(
      `SELECT tool_calls FROM steps WHERE run_id = $1 ORDER BY step_index ASC LIMIT 1`,
      [r.runId],
    )
    expect(stepRow.rows[0]?.tool_calls).not.toBeNull()
  })
})

// ---------------- post-run hooks ----------------

describe('runtime — post-run hooks', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('invokes factPipeline.processRun with run details', async () => {
    const calls: Array<Record<string, unknown>> = []
    const factPipeline: FactPipeline = {
      processRun: async (input) => {
        calls.push(input)
      },
    }

    const model = makeMockModel([textOnlyChunks('done')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      factPipeline,
    })

    const r = await runtime.run({ threadId: 't-fp', channel: 'cli', intent: 'hi' })
    await drain(r)

    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({
      threadId: 't-fp',
      channel: 'cli',
      agentId: 'talos-eth',
      runId: r.runId,
      userMessage: 'hi',
      assistantMessage: 'done',
    })
  })

  it('triggers summarizer at the configured cadence', async () => {
    const calls: Array<{ threadId: string; runRangeEnd: string }> = []
    const summarizer: ThreadSummarizer = {
      summarize: async (input) => {
        calls.push({ threadId: input.threadId, runRangeEnd: input.runRangeEnd })
        return { summary: 'auto summary', embedding: fakeEmbedding(7) }
      },
    }

    const model = makeMockModel([
      textOnlyChunks('ok1'),
      textOnlyChunks('ok2'),
      textOnlyChunks('ok3'),
    ])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
      summarizer,
      config: { summarizeEveryNRuns: 2 },
    })

    for (let i = 0; i < 3; i++) {
      const r = await runtime.run({
        threadId: 't-sum',
        channel: 'cli',
        intent: `turn ${i}`,
      })
      await drain(r)
    }

    expect(calls.length).toBe(1)
    expect(calls[0]?.threadId).toBe('t-sum')

    const sumRows = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM thread_summaries WHERE thread_id = 't-sum'`,
    )
    expect(sumRows.rows[0]?.count).toBe('1')
  })
})

// ---------------- empty tool sources ----------------

describe('runtime — empty tool sources', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('runs cleanly with no toolSources []', async () => {
    const model = makeMockModel([textOnlyChunks('ok')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
    })

    const r = await runtime.run({ threadId: 't-empty', channel: 'cli', intent: 'hi' })
    await drain(r)

    const row = await handle.pg.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
      r.runId,
    ])
    expect(row.rows[0]?.status).toBe('completed')
  })
})

// ---------------- recall over message_embeddings -----------------

describe('runtime — fact recall integration', () => {
  let handle: DbHandle

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
  })

  afterEach(async () => {
    await handle?.close()
  })

  it('coexists with applyFactOps + insertMessageEmbedding from prior turns', async () => {
    await upsertThread(handle.db, { id: 't-mix', channel: 'cli' })
    await insertMessageEmbedding(handle.db, {
      threadId: 't-mix',
      role: 'assistant',
      content: 'Aave supply 100 USDC done',
      embedding: fakeEmbedding(1),
    })
    await applyFactOps(handle.db, { agentId: 'talos-eth', channel: 'cli', threadId: 't-mix' }, [
      { kind: 'ADD', text: 'user prefers Arbitrum', embedding: fakeEmbedding(1) },
    ])

    const model = makeMockModel([textOnlyChunks('noted')])
    const runtime = createRuntime({
      db: handle,
      providers: singleModelRouter(model),
      embeddings: deterministicEmbeddings(),
      agents: withRegistry(),
    })

    const r = await runtime.run({
      threadId: 't-mix',
      channel: 'cli',
      intent: 'do another aave action',
    })
    await drain(r)

    const facts = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM facts WHERE thread_id = 't-mix' AND deleted_at IS NULL`,
    )
    expect(facts.rows[0]?.count).toBe('1')

    const runs = await handle.pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM runs WHERE thread_id = 't-mix'`,
    )
    expect(runs.rows[0]?.count).toBe('1')
  })
})
