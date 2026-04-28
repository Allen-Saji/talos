---
tags: [project, talos, architecture, design]
created: 2026-04-28
modified: 2026-04-28
status: draft
---

# Talos — Architecture

Runtime design for [[spec|Talos spec]]. Locked decisions, schemas, flows.

## Layer cake

```
┌────────────────────────────────────────────────────┐
│ Surface: CLI REPL │ MCP Server (stdio/SSE) │ Web  │
├────────────────────────────────────────────────────┤
│ Talos Runtime (~800 LOC TS)                        │
│  ├ Provider router  (BYOK Anthropic/OpenAI/Gemini) │
│  ├ Agent registry   (multi-agent ready, single v1) │
│  ├ Conversation manager (threads, runs, summaries) │
│  ├ Prompt builder   (persona + retrieved context)  │
│  ├ Agent loop       (Vercel AI SDK streamText)     │
│  ├ Middleware       (keeperhub, guardrails, audit) │
│  └ MCP host         (spawn, aggregate, namespace)  │
├────────────────────────────────────────────────────┤
│ Persistence (PGLite, Drizzle ORM)                  │
│  ├ Knowledge: ETH ecosystem (cron-fed nightly)     │
│  └ Conversations: threads, runs, steps, tool_calls │
├────────────────────────────────────────────────────┤
│ Wallet: viem + optional ZeroDev AA                 │
├────────────────────────────────────────────────────┤
│ MCP tools: AgentKit, Blockscout, EVM, Li.Fi,       │
│  Aave, Uniswap, Lido, Safe, Curve                  │
└────────────────────────────────────────────────────┘
```

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Agent loop substrate | Vercel AI SDK (`ai` package) |
| 2 | Persistence | PGLite single store (knowledge + conversations) |
| 3 | ORM | Drizzle (schema-as-TS, auto-generated migrations) |
| 4 | Embedding model | OpenAI `text-embedding-3-small` (1536-dim) |
| 5 | Retrieval | Hybrid: pgvector (HNSW) + tsvector (GIN) |
| 6 | Cross-thread recall | Adaptive: cosine ≥ 0.78, top-3, always-search |
| 7 | Summarization trigger | Turn count: every 20 runs |
| 8 | LLM call style | `streamText` everywhere (P0) |
| 9 | KeeperHub model | Block-and-wait for tx receipt before returning |
| 10 | Reasoning visibility | Stream every step to caller in realtime |
| 11 | Multi-agent abstraction | First-class `Agent` type now, single agent in v1 |
| 12 | Tool naming | `{server}_{tool}`, underscores, regex `[a-zA-Z0-9_]{1,64}` |
| 13 | MCP-server export thread model | One thread per host session, `talos_new_thread` to reset |

## Runtime: agent loop

Single shared loop powers both standalone (CLI/Web) and embedded (`talos serve --mcp`) modes.

```ts
async function* run(intent: string, ctx: { agent, thread, threadId }) {
  const userMsg = await mem.appendUserMessage(ctx.threadId, intent)

  const recalled = await mem.crossThreadRecall(intent, {
    threshold: 0.78, topK: 3, excludeThreadId: ctx.threadId,
  })

  const knowledge = await knowledgeStore.retrieve(intent, { topK: 5 })

  const system = buildSystemPrompt({
    persona: ctx.agent.persona,
    knowledge,
    recalled,
    tools: mcpHost.toolList(),
  })

  const stream = streamText({
    model: providers.resolve(ctx.agent.model),
    system,
    messages: await mem.recent(ctx.threadId, 20),
    tools: mcpHost.aggregatedTools(),
    maxSteps: 20,
    experimental_telemetry: { isEnabled: true },
  })

  const runId = await mem.openRun(ctx.threadId, intent)

  for await (const part of stream.fullStream) {
    yield part                                 // surface to CLI / MCP host

    switch (part.type) {
      case 'tool-call':       await audit.logToolCall(runId, part); break
      case 'tool-result':     await audit.logToolResult(runId, part); break
      case 'step-finish':     await mem.persistStep(runId, part); break
      case 'finish':          await mem.closeRun(runId, part.usage); break
    }
  }

  if (await mem.runCount(ctx.threadId) % 20 === 0) {
    await mem.summarizeThread(ctx.threadId)    // turn-count trigger
  }
}
```

## Persistence: PGLite + Drizzle

Single PGLite database at `~/.config/talos/talos.db`. Two namespaces in one file.

### Schema (Drizzle TS sketch)

```ts
// Conversations
export const threads = pgTable('threads', {
  id:        text('id').primaryKey(),                  // ULID
  agentId:   text('agent_id').notNull(),               // 'talos-eth' for v1
  title:     text('title'),                            // auto-generated
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  metadata:  jsonb('metadata'),                        // chain, model, etc
})

export const runs = pgTable('runs', {
  id:                  text('id').primaryKey(),
  threadId:            text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
  startedAt:           timestamp('started_at').defaultNow(),
  finishedAt:          timestamp('finished_at'),
  userMessage:         text('user_message').notNull(),
  finalAssistantText:  text('final_assistant_text'),
  totalTokens:         integer('total_tokens'),
  totalCostUsd:        real('total_cost_usd'),
  workflowId:          text('workflow_id'),            // KeeperHub if any
})

export const steps = pgTable('steps', {
  id:        text('id').primaryKey(),
  runId:     text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  idx:       integer('idx').notNull(),
  stepType:  text('step_type').notNull(),              // 'llm' | 'tool_call' | 'tool_result'
  content:   jsonb('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})

export const toolCalls = pgTable('tool_calls', {
  id:          text('id').primaryKey(),
  stepId:     text('step_id').references(() => steps.id, { onDelete: 'cascade' }),
  toolName:    text('tool_name').notNull(),            // 'aave_supply'
  args:        jsonb('args').notNull(),
  result:      jsonb('result'),
  durationMs:  integer('duration_ms'),
  error:       text('error'),
  workflowId:  text('workflow_id'),                    // KeeperHub workflow
  txHash:      text('tx_hash'),                        // chain tx if mutating
})

export const messageEmbeddings = pgTable('message_embeddings', {
  id:        text('id').primaryKey(),
  threadId:  text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
  runId:     text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  text:      text('text').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  tsv:       tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', text)`).stored(),
  createdAt: timestamp('created_at').defaultNow(),
})

// Knowledge namespace
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id:         text('id').primaryKey(),
  source:     text('source').notNull(),                // 'l2beat', 'defillama', etc
  sourceUrl:  text('source_url'),
  content:    text('content').notNull(),
  embedding:  vector('embedding', { dimensions: 1536 }),
  fetchedAt:  timestamp('fetched_at').defaultNow(),
})
```

### Indexes

```sql
CREATE INDEX threads_agent_updated  ON threads (agent_id, updated_at DESC);
CREATE INDEX runs_thread            ON runs (thread_id, started_at DESC);
CREATE INDEX tool_calls_name        ON tool_calls (tool_name);
CREATE INDEX msg_emb_hnsw           ON message_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX msg_emb_tsv            ON message_embeddings USING gin (tsv);
CREATE INDEX know_emb_hnsw          ON knowledge_chunks   USING hnsw (embedding vector_cosine_ops);
```

### Why PGLite + Drizzle (and not SQLite or raw SQL)

- PGLite is real Postgres in WASM → pgvector, tsvector, jsonb, generated columns. SQLite has none of this natively.
- Single file, zero install, no separate server process.
- Drizzle gives compile-time type safety on every query — refactor-safe at scale.
- Auto-generates migration SQL from schema diffs (`drizzle-kit generate`).
- Same DB serves knowledge layer + conversation layer → one embedding pipeline, one backup, one place to reason about storage.

## Memory: three-tier retrieval

Every run starts with three retrieval steps before the LLM call.

| Tier | Source | Trigger | Format in prompt |
|---|---|---|---|
| **Hot** | Last 20 runs in current thread, verbatim | Always | `messages[]` to LLM |
| **Warm** | Thread summary doc (regenerated every 20 runs) | When current thread has > 20 runs | Prepended to first user message in `messages[]` |
| **Cold** | Cross-thread semantic recall | Always-search; inject only if cosine ≥ 0.78, top-3 | System prompt section: `Prior context:` |

Knowledge layer (the daily ETH ecosystem cron) is a fourth retrieval, orthogonal:

| Source | Format |
|---|---|
| Top-5 knowledge chunks from current question | System prompt section: `Recent ETH ecosystem state:` |

### Why adaptive cold recall

Naive "always inject top-K cross-thread" pollutes prompts with irrelevant memories. Naive "only when context thin" misses recalls in long threads. Adaptive (always-search, threshold-gated, capped) gives both: silent when nothing relevant, full continuity when something is.

## Streaming: event taxonomy

Every layer that does work emits typed events into a per-run channel. CLI subscribes, prints live. MCP-server mode maps events to MCP `notifications/progress` messages so embedding hosts (OpenClaw, Claude Desktop) see live progress too.

### Vercel AI SDK native events (from `streamText.fullStream`)

| Type | Meaning | UX |
|---|---|---|
| `text-delta` | Token chunk from model | Print to stdout as it arrives |
| `tool-call` | LLM decided to call a tool | `↳ calling aave_supply { ... }` |
| `tool-call-streaming-start` | Args streaming in | (optional, low-noise) |
| `tool-result` | Tool returned | `  ✓ result preview` |
| `step-finish` | One LLM step complete | (silent, persist to DB) |
| `finish` | Full multi-step run complete | Done |
| `error` | Provider/tool error | Bubble up |

### Talos middleware events (custom, layered on top)

| Type | Meaning | UX |
|---|---|---|
| `keeperhub:workflow_create` | Wrapping tx in workflow | `  ↳ keeperhub: creating workflow wf_…` |
| `keeperhub:submitted` | Workflow accepted by executor | `  ↳ submitted, awaiting confirmation` |
| `keeperhub:tx_broadcast` | Chain tx broadcast | `  ↳ tx 0x…` |
| `keeperhub:tx_confirmed` | Tx mined | `  ↳ confirmed at block N, gas G` |
| `guardrails:exceeded` | Spend cap hit | `  ⚠ guardrail: per-day cap exceeded — abort?` |
| `audit:logged` | Step persisted to DB | (silent) |

### Example: `supply 100 USDC to Aave on Arbitrum`

```
You: supply 100 USDC to Aave on Arbitrum
↳ thinking…
↳ calling aave_supply { amount: "100", asset: "USDC", chain: "arbitrum" }
  ↳ keeperhub: creating workflow wf_a3f9c2…
  ↳ submitted, awaiting confirmation
  ↳ tx 0x4f2e…
  ↳ confirmed at block 198342177, gas 145k
  ↳ ✓ aTokens minted, balance updated
↳ Supplied 100 USDC to Aave on Arbitrum. New aUSDC balance: 1,234.56.
```

## KeeperHub middleware

Tag-based interception. Tools self-declare in their MCP descriptor whether they mutate chain state:

```ts
// inside an MCP tool descriptor
{
  name: 'aave_supply',
  description: '…',
  inputSchema: { … },
  annotations: { mutates: true, chain: 'eth' },   // ← Talos reads these
}
```

Loop:
1. LLM emits `tool-call` for `aave_supply`.
2. Middleware checks descriptor: `mutates === true`.
3. Call KeeperHub `create_workflow` with the intended call.
4. Stream `keeperhub:workflow_create`.
5. Call `execute_workflow`, poll executor.
6. On `submitted` → stream event.
7. On chain tx → stream `tx_broadcast`.
8. On confirmation → stream `tx_confirmed`.
9. Return tool result enriched with `workflowId`, `txHash` to LLM.

Read-only tools (`mutates: false` or absent) bypass KeeperHub entirely. No latency cost on `aave_get_position`, `uniswap_quote`, etc.

## Multi-agent: future-proof now, single agent in v1

`Agent` is a first-class type from day one even though we ship one agent.

```ts
type Agent = {
  id: string                    // 'talos-eth'
  persona: string               // base system prompt fragment
  model: ModelId                // 'anthropic/claude-opus-4'
  tools: ToolFilter             // which MCP tools this agent gets
  memory: MemoryConfig          // namespace, TTL, recall settings
}

class AgentRegistry {
  register(agent: Agent): void
  get(id: string): Agent
  list(): Agent[]
}

runtime.run(intent, { agentId: 'talos-eth', threadId })
```

### Future: sub-agents as tools

Cleanest multi-agent pattern is to expose other agents as callable tools:

```ts
// auto-generated tool when more than one agent registered
{
  name: 'delegate_research',
  description: 'Delegate to talos-eth-research for read-only ETH analysis',
  inputSchema: { query: z.string() },
}
```

Sub-agent has its own memory namespace and tool subset. Result flows back as a tool result to the parent. No new protocol — sub-agents are just structured tools.

### v1 → v2 path

| Version | Agents | Notes |
|---|---|---|
| v1 | `talos-eth` | All tools, all memory |
| v1.1 | + `talos-eth-research`, `talos-eth-exec` | Read/write split, KeeperHub only on exec |
| v2 | User-defined in `~/.config/talos/agents/*.yaml` | Custom personas, tool subsets |

## MCP-server export mode

`talos serve --mcp` is the same runtime, different surface. Single thread per host session keeps Talos *agent-ful* rather than *tool-ful* (host gets continuity across calls).

| Tool | What it does |
|---|---|
| `query_eth_knowledge(question)` | Hybrid retrieval over knowledge_chunks. Returns chunks + citations. |
| `eth_action(intent)` | Runs full agent loop. Streams progress to host as MCP `notifications/progress`. Returns final assistant text + workflow URL + tx hash. |
| `eth_status()` | Wallet, chains, last-sync, enabled MCPs, current thread. |
| `talos_new_thread()` | Resets the host's session thread. |

Embedded host config example (works for OpenClaw, Hermes, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "talos": {
      "command": "npx",
      "args": ["talos", "serve", "--mcp"]
    }
  }
}
```

## Migrations

`drizzle-kit generate` produces SQL diff files in `migrations/`:

```
migrations/
  0001_init.sql              # CREATE all tables + indexes
  0002_add_workflow_id.sql
  0003_…
```

Runtime `migrate()` on every Talos boot:
1. Open PGLite at `~/.config/talos/talos.db`.
2. Check `_migrations` table (Drizzle managed).
3. Apply any unapplied SQL files in order.
4. Continue.

User upgrade flow is invisible: `npm i -g talos@latest` → next run, schema evolves automatically.

## Out of scope (not v1)

- HTTP/SSE transport for `talos serve --mcp` (stdio first, SSE in F9.5)
- Auth gating for shared Talos instances (F9.8 P2)
- User-defined agents (v2)
- Multi-LLM routing within one agent (e.g., haiku for cheap subtasks, opus for reasoning) — future cost optimization
- Hardware wallet support (F1.8 P2)
- Voice interface (F5.8 P2)

## Open architecture questions (to revisit before code)

- Do we ship a default keeperhub-bypass mode for read-only flows, or always-on KeeperHub even for queries? Latter is heavier but simpler audit story. *Lean: bypass for `mutates: false`.*
- Embedding cache: do we re-embed user queries on every run or LRU-cache them? Most queries repeat. *Lean: in-memory LRU, 1000 entries.*
- Thread title generation: separate cheap-model call (haiku) on first-run, or piggyback on the main run? *Lean: separate haiku call, async, doesn't block first response.*
