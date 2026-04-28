---
tags: [project, talos, architecture, design]
created: 2026-04-28
modified: 2026-04-29
status: draft
---

# Talos — Architecture

Runtime design for [[spec|Talos spec]]. Locked decisions, schemas, flows.

## Layer cake

```
┌────────────────────────────────────────────────────────┐
│ Thin clients                                            │
│   talos chat   |   Telegram users   |   MCP hosts      │
│      ▼                  ▼                  ▼            │
│   ws:7711         (in-process)       stdio + WS proxy  │
└──────┼──────────────────┼──────────────────┼───────────┘
       ▼                  ▼                  ▼
┌────────────────────────────────────────────────────────┐
│ talosd (always-running daemon, launchd/systemd)         │
│                                                         │
│  Control plane: WebSocket on 127.0.0.1:7711            │
│   + bearer-token auth (~/.config/talos/daemon.token)   │
│                                                         │
│  Channel adapters:  cli-ws  |  telegram  |  mcp-server │
│                                                         │
│  Talos Runtime (Vercel AI SDK v6):                     │
│   ├ Provider router (BYOK Anthropic/OpenAI/Gemini)     │
│   ├ Agent registry  (multi-agent ready, single v1)     │
│   ├ Conversation mgr (threads, runs, summaries)        │
│   ├ Prompt builder  (persona + retrieved context)      │
│   ├ Agent loop      (streamText, hot MCP host)         │
│   └ Middleware      (keeperhub, guardrails, audit)     │
├────────────────────────────────────────────────────────┤
│ Persistence (PGLite, Drizzle ORM, kept open)            │
│  ├ Knowledge: ETH ecosystem (cron-fed nightly)         │
│  └ Conversations: threads, runs, steps, tool_calls     │
├────────────────────────────────────────────────────────┤
│ Wallet: viem + optional ZeroDev AA                      │
├────────────────────────────────────────────────────────┤
│ MCP tool servers (hot, no respawn cost):                │
│  AgentKit, Blockscout, EVM, Li.Fi, Aave, Uniswap, Lido │
└────────────────────────────────────────────────────────┘
```

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Agent loop substrate | Vercel AI SDK **v6** (`ai` ≥ 6.0, `@ai-sdk/mcp` for MCP client) |
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
| 14 | Process model | Daemon (`talosd`) + thin clients — always-running, OpenClaw-pattern |
| 15 | Daemon control plane | **WebSocket** on 127.0.0.1:7711 + bearer-token auth |
| 16 | Auto-start | `talos chat` and `talos serve --mcp` start daemon if not running |
| 17 | OS service | `talos install-service` ships in v1 (launchd / systemd user service) |
| 18 | v1 channels | CLI (WS REPL) + Telegram (long-poll) + MCP-server (stdio→WS proxy) |
| 19 | Telegram streaming | Edit-in-place — one message per run, progressively updated |
| 20 | Multi-tenancy | Single-user model in v1; one wallet shared across channels; Telegram username/userId whitelist |
| 21 | KeeperHub default annotation | **Audit-by-default** — undeclared tools route through workflows; regex allowlist (`KNOWN_READONLY`) bypasses known read-only patterns |
| 22 | Thread keying | CLI: `cli:{$USER}:default` persistent · TG: `tg:{chatId}` persistent · MCP: `mcp:{pid}:{startedAt}` per host session · cross-thread recall bridges across all |
| 23 | PGLite ownership | Daemon owns at runtime. One-shot commands (`init`, `migrate`, `doctor`) open the DB directly when daemon is stopped, then close. Never concurrent. |
| 24 | Test stack | Vitest + PGLite-in-memory + seeded LLM eval; demo-flow eval is the regression gate |

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
    stopWhen: stepCountIs(20),                  // v6: replaces maxSteps
    experimental_telemetry: { isEnabled: true },
  })

  const runId = await mem.openRun(ctx.threadId, intent)

  for await (const part of stream.fullStream) {
    yield part                                 // surface to CLI / MCP host

    switch (part.type) {
      case 'text-delta':      /* part.text — token chunk */ break
      case 'tool-call':       await audit.logToolCall(runId, part); break    // part.input
      case 'tool-result':     await audit.logToolResult(runId, part); break  // part.output (raw MCP content array)
      case 'finish-step':     await mem.persistStep(runId, part); break      // v6: was step-finish
      case 'finish':          await mem.closeRun(runId, part.totalUsage); break
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

### Ownership and concurrent-handle rule

PGLite locks the database file when opened. Two processes opening `~/.config/talos/talos.db` at the same time will collide — one wins, the other errors. The plan respects this with a single ownership rule:

**At runtime, the daemon owns the DB.** It opens PGLite at boot, holds the handle for the daemon's lifetime, and serves all queries through the WS control plane.

**One-shot commands open the DB directly, but only when the daemon is stopped.** These commands are:
- `talos init` — first-time setup writes schema and seed data, then closes
- `talos migrate` — explicit schema upgrade (not normally needed; daemon migrates on boot)
- `talos doctor --repair-schema` — diagnostic / recovery

Each one-shot command checks `~/.config/talos/daemon.pid`; if a daemon is running, refuses with a clear error ("stop the daemon first: `talos stop`").

The migration runner is a shared utility (`src/db/migrate.ts` exporting `runMigrations(db)`) called by both init and the daemon's startup path. Init writes the initial schema; the daemon re-runs `runMigrations` on every boot to apply any unapplied migrations from a Talos upgrade. Idempotent — applies only what's missing.

This keeps init self-contained (no daemon dependency, fast-fail UX) and gives future CLI tooling a clean direct-access path.

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

### Vercel AI SDK v6 native events (from `streamText.fullStream`)

| Type | Field | Meaning | UX |
|---|---|---|---|
| `start` | — | Run begins | (silent) |
| `text-delta` | `text` | Token chunk from model | Print to stdout as it arrives |
| `tool-input-start` | `toolName` | LLM about to emit tool args | (optional, low-noise) |
| `tool-input-delta` | `delta` | Args streaming in | (optional, low-noise) |
| `tool-call` | `input` | LLM finalized a tool call | `↳ calling aave_supply { ... }` |
| `tool-result` | `output` | Tool returned (raw MCP content array — flatten in middleware) | `  ✓ result preview` |
| `tool-error` | `error` | Tool threw | Surface to user, abort or retry |
| `finish-step` | `usage`, `finishReason` | One LLM step complete | (silent, persist to DB) |
| `finish` | `totalUsage`, `finishReason` | Full multi-step run complete | Done |
| `error` | `error` | Provider/transport error | Bubble up |

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

### Default is audit-by-default (safe-by-default)

Tools without an explicit `mutates: false` annotation are routed through KeeperHub. This protects against third-party MCP servers (AgentKit, Blockscout, Li.Fi, EVM MCP) that don't know about our annotation field — silently bypassing audit on `agentkit_swap` because nobody declared it would be a load-bearing bug for the audit-trail prize.

A regex allowlist bypasses well-known read-only patterns to avoid the round-trip cost (~200ms per workflow create):

```ts
const KNOWN_READONLY: RegExp[] = [
  /_get_/,            // get_balance, get_position, get_block_number
  /_quote$/,          // uniswap_quote
  /_status$/,
  /_balance$/,
  /_position$/,
  /_search/,
  /^blockscout_/,     // Blockscout server is fully read-only
]

function shouldAudit(toolName: string, annotations?: { mutates?: boolean }): boolean {
  if (annotations?.mutates === false) return false           // explicit opt-out
  if (KNOWN_READONLY.some(rx => rx.test(toolName))) return false  // known-safe pattern
  return true                                                 // default: audit
}
```

Adding a new third-party MCP requires either declaring `mutates: false` in our wrapper or adding the tool name to the allowlist. Defaulting to "audit everything" trades a small latency cost on missed read-only tools for zero silent bypass holes.

### KeeperHub auth (OAuth 2.1 + DCR)

Spike confirmed: KeeperHub's MCP endpoint is gated by OAuth 2.1, fully discoverable via `.well-known/oauth-authorization-server` and `.well-known/oauth-protected-resource`.

- Authorization Code flow with PKCE (S256)
- **Dynamic Client Registration** at `/api/oauth/register` — Talos registers itself, no manual API key entry
- Public-client mode (PKCE-only, `token_endpoint_auth_methods_supported: ['none']`) — no client secret to store
- Scopes: `mcp:read`, `mcp:write`, `mcp:admin`

`talos init` flow: hit well-known → register client → open browser to `/oauth/authorize` → loopback redirect captures code → exchange at `/api/oauth/token` → persist refresh + access token at `~/.config/talos/keeperhub.json` (0600). AI SDK v6's `@ai-sdk/mcp` ships `OAuthClientProvider` types for this.

### Tool-result flattening

MCP tool results arrive as `{ content: [{ type: 'text', text: '...' }, ...] }`. The LLM sees this verbatim by default — noisy. A middleware step flattens to plain text (or JSON if a single text block parses) before reinjecting into the conversation. Errors (`isError: true`) get tagged so the model can react appropriately.

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

## Daemon and channels

**Pattern (OpenClaw-shaped):** one always-running daemon, many channels. Channels are in-process plugins. Clients (CLI, MCP hosts) are thin — they don't carry runtime state.

### Why a daemon

The runtime owns expensive, long-lived state: PGLite (~1s cold boot), MCP server subprocesses (1-3s each × 11 servers), provider clients with cached config, the knowledge cron schedule. Re-paying that cost per CLI invocation is unacceptable. The daemon pays it once. CLI and Telegram messages hit a hot runtime in <100ms.

### Control plane

WebSocket server bound to `127.0.0.1:7711`. JSON message frames. Bearer-token auth — token is a 32-byte URL-safe random written on first daemon start to `~/.config/talos/daemon.token` (mode 0600). Clients read the token from disk and pass `Authorization: Bearer <token>` in the WS upgrade headers.

| Direction | Frame type | Purpose |
|---|---|---|
| C → S | `run` | `{ threadId, intent, agentId? }` — start a new run |
| C → S | `abort` | `{ runId }` — cancel an in-flight run |
| C → S | `threads.list` / `threads.get` | thread queries |
| C → S | `status` | wallet, chains, sync, channels |
| S → C | `event` | `{ runId, part: TextStreamPart }` — streamed |
| S → C | `error` | protocol-level error |

The `event` frames mirror Vercel AI SDK's `TextStreamPart` 1:1 — no translation between runtime and clients.

### Thread keying

Each channel keys its threads deterministically so reconnects feel like resumption, not a fresh start.

| Channel | Thread ID format | Lifetime |
|---|---|---|
| **CLI** | `cli:{$USER}:default` | Persistent. Every `talos chat` reattaches. `/thread new` creates `cli:{$USER}:{ulid}` for explicit fresh starts. |
| **Telegram** | `tg:{chatId}` | Persistent per Telegram chat. DM with the bot ≠ group chat. |
| **MCP-server** | `mcp:{hostPid}:{startedAt}` | One per host process session. Claude Desktop closing → fresh thread on next open. |

Cross-thread recall (cosine ≥ 0.78, top-3) bridges across all channels. So if you supplied USDC via CLI yesterday and ask about your position via Telegram today, the agent gets a "Prior context:" injection in the system prompt. It does *not* resume the CLI conversation — that would be confusing across channels.

Resume vs recall is the key distinction:
- **Resume**: same thread, full message history. "Pick up where we left off."
- **Recall**: different thread, top-K relevant chunks injected as background. "By the way, you've talked about this."

Adapter contract for thread allocation: `threads.findOrCreate(key: string) → threadId`. Idempotent; first call creates, subsequent calls return the same thread.

### Channel adapter contract

Every channel is a plugin loaded at daemon startup based on `channels.yaml`:

```ts
interface ChannelAdapter {
  name: string                                        // 'cli' | 'telegram' | 'mcp-server'
  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
}

interface AdapterContext {
  runtime: Runtime                                    // entry to agent loop
  threads: ThreadStore
  config: Record<string, unknown>                     // adapter's slice of channels.yaml
  logger: Logger
}
```

Each adapter:
- Listens on its own protocol (WS for CLI, long-poll for TG, stdio for MCP-server)
- Translates incoming messages → `runtime.run(intent, threadId)`
- Maps the streamed `TextStreamPart`s back to its surface

### CLI channel (`talos chat`)

Thin WebSocket client. ~200 LOC. Connects to daemon, opens REPL, prints events live. Built on Node's `readline` + `chalk` + `cli-spinners`. Slash commands (`/help`, `/thread new`, `/status`, `/clear`) handled client-side — no daemon roundtrip.

`^C` sends `abort` for the in-flight run, returns to prompt. `^D` exits cleanly.

If the daemon isn't running and `auto_start_daemon: true` in config: spawn `talosd` in the background and wait for it to come up before connecting.

### Telegram channel

Long-polling Bot API via [grammY](https://grammy.dev). Per Telegram chat → its own thread (`tg:{chatId}`). Whitelist enforced at message receipt — non-allowed users silently ignored.

**Edit-in-place streaming** is the polish:

```ts
bot.on('message:text', async (tgCtx) => {
  if (!cfg.allowedUsers.includes(tgCtx.from.username)) return
  const threadId = await threads.findOrCreate(`tg:${tgCtx.chat.id}`)
  const msg = await tgCtx.reply('↻ thinking…')
  let trace: string[] = ['↻ thinking…']
  let lastEdit = Date.now()
  let final = ''

  for await (const part of runtime.run(tgCtx.message.text, { threadId })) {
    if (part.type === 'tool-call')      trace.push(`↻ ${part.toolName}`)
    else if (part.type === 'tool-result') trace[trace.length - 1] += '  ✓'
    else if (part.type === 'text-delta') final += part.text
    else if (part.type === 'finish')      trace = [final.trim()]

    // Telegram rate limit: ~1 edit/sec per chat
    if (Date.now() - lastEdit > 1100) {
      await bot.api.editMessageText(tgCtx.chat.id, msg.message_id, trace.join('\n'))
      lastEdit = Date.now()
    }
  }
  await bot.api.editMessageText(tgCtx.chat.id, msg.message_id, trace.join('\n'))
})
```

One message per run. Watcher sees the trace progress live, then snap to final answer. Non-spammy.

### MCP-server channel (`talos serve --mcp`)

Two-hop proxy: the host (Claude Desktop, OpenClaw, Cursor) spawns `talos serve --mcp` as a subprocess, talks stdio MCP to it. The proxy holds an MCP server on stdio + a WS client to the daemon. Tools/calls/results flow through unchanged. Daemon's `event` frames map to MCP `notifications/progress`.

```
host  ◀──stdio MCP──▶  talos-mcp-proxy  ◀──WS──▶  talosd
```

If daemon isn't running on first invocation: auto-start it. ~150 LOC for the proxy.

### channels.yaml

```yaml
# ~/.config/talos/channels.yaml
auto_start_daemon: true

daemon:
  bind: 127.0.0.1:7711
  log_file: ~/.config/talos/daemon.log

channels:
  cli:
    enabled: true                        # always on
  telegram:
    enabled: false
    bot_token_ref: env:TALOS_TG_BOT_TOKEN   # never store token inline
    allowed_users: ['@allensaji']
    polling_interval_ms: 1000
  mcp_server:
    enabled: true                        # served on stdio when invoked
```

### Lifecycle

```
talos init                  # one-time wizard
talos install-service       # writes launchd plist / systemd user unit
talos start                 # runs daemon (foreground unless --detach)
talos stop
talos restart
talos status                # daemon? channels? sync? wallet?
talos logs [-f]
talos channels list | add <name> [opts] | remove <name> | enable <name> | disable <name>
talos chat                  # thin client
talos serve --mcp           # MCP-server proxy mode
```

### Auth model

- Daemon binds to `127.0.0.1` only. No LAN/WAN exposure in v1.
- Bearer token in `~/.config/talos/daemon.token` (0600). Rotated on `talos restart --rotate-token`.
- Telegram is **in-process** with the daemon — no auth between TG adapter and runtime; the secret here is the bot token (config-managed).
- KeeperHub OAuth tokens stored separately in `~/.config/talos/keeperhub.json` (0600). Refresh handled by daemon.

### Concurrency

Multiple channels can run requests in parallel. Each `runtime.run()` invocation:
- Has its own `AbortController` keyed by `runId`
- Operates on its own thread context (memory + retrieval are thread-scoped)
- Shares hot resources: PGLite pool (MVCC), MCP server subprocesses (parallel-call safe per spec), provider clients

Knowledge cron is daemon-scoped; runs on a single timer regardless of how many channels are active.

### Failure modes

| Failure | Behavior |
|---|---|
| Daemon crashes | OS service auto-restarts (launchd/systemd). In-flight runs lost; threads stay consistent (closed `runs.finishedAt` with `error: aborted`) |
| Channel adapter throws | Logged, adapter restarted; daemon stays up; other channels unaffected |
| MCP server subprocess dies | Hot-restart on next call; tool list refreshed |
| KeeperHub OAuth expires | Daemon refreshes via refresh_token transparently; surfaces error if refresh fails |
| Provider rate-limit | Bubbles to client as `error` event; user retries |

## MCP-server export mode

`talos serve --mcp` is the **MCP-server channel adapter**, exposed as a top-level command for convenience. Same runtime, different surface. Single thread per host session keeps Talos *agent-ful* rather than *tool-ful* (host gets continuity across calls).

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
