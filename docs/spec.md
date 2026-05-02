---
tags: [project, talos, hackathon, eth-open-agents, spec]
created: 2026-04-27
modified: 2026-04-29
status: locked
---

# Talos — Spec

Vertical ETH agent for ETHGlobal Open Agents (Apr 24 – May 6 2026). Self-hosted, BYOK model keys, OpenClaw-style. Spec locked 2026-04-27.

Runtime design (frameworks, schemas, flows): see [[architecture]].

## Sponsor tracks

- **F0.1** P0 KeeperHub ($5k primary) — prize page names "OpenClaw" connector explicitly

## 1. Wallet Layer

- **F1.1** P0 BYOK private key via viem, local storage at `~/.config/talos/` with 0600 perms
- **F1.2** P0 ZeroDev wrap of viem signer for gasless tx + batch ops + cross-chain spend
- **F1.3** P0 Pure viem fallback when user opts out of ZeroDev
- **F1.4** P0 Fresh wallet generation at init, never reuse
- **F1.5** P0 Multi-chain config: Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia
- **F1.6** P1 Wallet import path for existing keys (with security warning)
- **F1.7** P1 Per-chain balance display in init summary and `status` command
- **F1.8** P2 Hardware wallet path (Ledger via viem)

## 2. Execution Layer (KeeperHub)

- **F2.1** P0 KeeperHub MCP wired in via `https://app.keeperhub.com/mcp`
- **F2.2** P0 Every agent tx routed through `create_workflow` + `execute_workflow` for audit trail
- **F2.3** P0 `@keeperhub/wallet` x402 hook installed for outbound paid API calls (Base)
- **F2.4** P0 Audit log surface: `get_direct_execution_status` exposed via CLI for direct executions (the path the audit middleware uses; arg `execution_id`, snake_case). `get_execution_logs` is workflow-only and uses `executionId` (camelCase).
- **F2.5** P1 Daily knowledge cron uses KeeperHub Schedule trigger instead of local cron
- **F2.6** P1 Spending guardrails: per-day cap, per-tx cap, configurable
- **F2.7** P2 Submit feedback bounty entry ($500 builder feedback prize)

## 3. MCP Tool Layer

- **F3.1** P0 AgentKit-as-MCP server with cherry-picked providers (Compound, Morpho, Pyth, Sushi, 0x, Enso, Zerion, Basename, Farcaster, OpenSea, Zora)
- **F3.2** P0 `blockscout/mcp-server` wired in for multi-chain data reads
- **F3.3** P0 `mcpdotdirect/evm-mcp-server` wired in for wallet ops + ENS lookup + ERC20/721
- **F3.4** P0 `lifinance/lifi-mcp` wired in for cross-chain bridges
- **F3.5** P0 Custom `aave-mcp`: read positions, supply, borrow, withdraw on Sepolia
- **F3.6** P0 Custom `uniswap-v3-mcp`: quote + swap + pool info on Sepolia
- **F3.7** P1 Custom `lido-mcp`: stake, wrap, request withdrawal
- **F3.8** P1 Custom `safe-mcp`: proposal create + sign + execute
- **F3.9** P1 Custom `curve-mcp`: pool reads + swaps
- **F3.10** P1 MCP registry config so users can add/remove tools without code edits
- **F3.11** P2 Auto-discover new MCPs from a community registry on each cron tick

## 4. Knowledge Layer (Daily Self-Update Cron)

- **F4.1** P0 Nightly scrape pipeline: L2Beat + DefiLlama + Etherscan releases + protocol GitHub changelogs
- **F4.2** P0 Embedding step + PGLite vector store (mirror GBrain pattern)
- **F4.3** P0 System prompt injection: top-N relevant chunks per user query
- **F4.4** P0 Cron writes `last-sync` timestamp + diff summary to local state file, surfaced in `status`
- **F4.5** P1 Source set extended: governance forums (Tally + Snapshot + Discourse), Mirror posts, X lists
- **F4.6** P1 User-configurable source list (`sources.yaml`)
- **F4.7** P1 First-run synchronous fetch on init so demo has fresh data immediately
- **F4.8** P2 Diff view CLI command: "what changed in ETH ecosystem since yesterday"

## 5. Agent Runtime

- **F5.1** P0 BYOK model keys (Anthropic, OpenAI, Gemini at minimum)
- **F5.2** P0 Tool-use loop aggregating all configured MCPs into one tool surface
- **F5.3** P0 Dynamic system prompt: base persona + protocol knowledge from cron
- **F5.4** P0 Conversation state persistence (threads, runs, steps, tool_calls, embeddings — see Section 10)
- **F5.5** P0 Text CLI interface (REPL)
- **F5.6** P1 Local web UI (React + Tailwind, single-page chat)
- **F5.7** P0 Streaming responses (`streamText`) — load-bearing for realtime reasoning UX
- **F5.8** P2 Voice interface via dTelecom provider (x402 micropayments)
- **F5.9** P0 First-class `Agent` type + AgentRegistry (multi-agent ready, single agent v1)
- **F5.10** P0 Vercel AI SDK (`ai` package) as agent loop substrate
- **F5.11** P0 Audit-by-default KeeperHub middleware: undeclared tools route through workflows; regex `KNOWN_READONLY` allowlist bypasses known read-only patterns

## 6. Onboarding (the wedge)

- **F6.1** P0 Single command: `npx talos init`
- **F6.2** P0 Interactive prompts: model + key, wallet (generate or import), default chain
- **F6.3** P0 Auto-runs first knowledge cron synchronously
- **F6.4** P0 Time-to-first-usable-agent under 60 seconds
- **F6.5** P0 Clear printout: agent's address, chains, MCPs enabled, KeeperHub status, last-sync timestamp
- **F6.6** P1 KeeperHub OAuth handoff during init (browser flow)
- **F6.7** P1 ZeroDev project ID auto-prompt with link to free tier signup
- **F6.8** P1 `talos status` command shows current capabilities, last cron run, balances
- **F6.9** P1 `talos doctor` command diagnoses misconfigs
- **F6.10** P0 `init` is idempotent: detects existing config, prompts keep / reset / partial-reset (re-do OAuth only)

## 7. Distribution

- **F7.1** P0 Open-source GitHub repo, license pending pick (MIT or Apache-2.0)
- **F7.2** P0 npm package with binary entrypoint
- **F7.3** P0 README with one-screen quickstart and recorded gif
- **F7.4** P1 Docker image
- **F7.5** P2 Homebrew tap

## 8. Demo Deliverables

- **F8.1** P0 Recorded video: install + 3 scripted interactions in under 3 minutes
- **F8.2** P0 Live demo URL or downloadable binary judges can run
- **F8.3** P0 Architecture diagram (BBG-style via diagram-kit)
- **F8.4** P0 Submission writeup for KeeperHub track

## 9. Embeddability (Talos-as-MCP)

(Implemented as the `mcp-server` channel adapter under Section 11.)

- **F9.1** P0 `talos serve --mcp` proxies host stdio MCP ↔ daemon WS (auto-starts daemon)
- **F9.2** P0 Tool: `query_eth_knowledge` — hits local PGLite vector DB, returns top-N chunks + cited sources
- **F9.3** P0 Tool: `eth_action` — runs full agent loop, returns KeeperHub workflow URL + tx hash
- **F9.4** P0 Tool: `eth_status` — wallet, chains, last-sync, enabled MCPs
- **F9.5** P0 Tool: `talos_new_thread` — resets the host's session thread
- **F9.6** P0 One thread per host session (continuity across `eth_action` calls)
- **F9.7** P1 HTTP/SSE transport in addition to stdio (for remote hosts)
- **F9.8** P1 Pass-through namespace: re-export curated DeFi MCPs under `talos.*` so importers get the bundle from one connector
- **F9.9** P1 README section: drop-in configs for OpenClaw, Hermes, Claude Desktop, Cursor
- **F9.10** P2 Auth token gate so multiple hosts can share one Talos instance safely

## 10. Conversation Layer

Detail in [[architecture]] §Persistence + §Memory.

- **F10.1** P0 PGLite single-store at `~/.config/talos/talos.db` (knowledge + conversations); daemon owns at runtime, one-shot commands open directly only when daemon is stopped
- **F10.2** P0 Drizzle ORM with auto-generated SQL migrations
- **F10.3** P0 Schema: `threads`, `runs`, `steps`, `tool_calls`, `message_embeddings`, `knowledge_chunks`
- **F10.4** P0 Hybrid retrieval: pgvector HNSW (semantic) + tsvector GIN (keyword)
- **F10.5** P0 Three-tier memory: hot (last 20 runs), warm (thread summary), cold (cross-thread recall)
- **F10.6** P0 Adaptive cross-thread recall: cosine ≥ 0.78, top-3, always-search threshold-gated
- **F10.7** P0 Turn-count summarization: regenerate thread summary every 20 runs
- **F10.8** P0 OpenAI `text-embedding-3-small` (1536-dim) for all embeddings
- **F10.9** P1 Thread title auto-generated via cheap-model call (haiku) on first run, async
- **F10.10** P1 `talos search "query"` for hybrid keyword + semantic recall across all threads
- **F10.11** P1 `talos thread <id>` to load and continue past threads
- **F10.12** P2 In-memory LRU cache for query embeddings (1000 entries)

## 11. Daemon & Channels (always-running, OpenClaw-pattern)

Detail in [[architecture]] §Daemon and channels.

- **F11.1** P0 `talosd` long-running daemon — holds runtime, hot MCP servers, PGLite, knowledge cron
- **F11.2** P0 WebSocket control plane on `127.0.0.1:7711`; bearer-token auth via `~/.config/talos/daemon.token` (0600)
- **F11.3** P0 In-process channel adapter contract; channels loaded at boot from `channels.yaml`
- **F11.4** P0 Lifecycle: `talos start | stop | restart | status | logs [-f]`
- **F11.5** P0 `talos install-service` — installs as launchd (macOS) / systemd user service (Linux)
- **F11.6** P0 Auto-start: `talos chat` and `talos serve --mcp` start daemon if not running
- **F11.7** P0 Concurrent runs across channels; each has its own `AbortController` and thread context
- **F11.8** P0 Thread keying: CLI `cli:{$USER}:default` persistent, TG `tg:{chatId}` persistent, MCP `mcp:{pid}:{startedAt}` per host session; cross-thread recall bridges across all
- **F11.9** P0 CLI channel: `talos chat` thin WS client REPL; ^C aborts run, ^D exits; slash commands client-side
- **F11.10** P0 MCP-server channel: `talos serve --mcp` proxies host stdio ↔ daemon WS (replaces standalone mode)
- **F11.11** P0 Telegram channel: long-poll Bot API via grammY; per-chat threads
- **F11.12** P0 Telegram streaming UX: edit-in-place (one message per run, progressive updates, ~1s throttle)
- **F11.13** P0 Single-user model: one wallet shared across channels; Telegram username/userId whitelist
- **F11.14** P0 `talos channels list | add | remove | enable | disable`
- **F11.15** P0 `channels.yaml` config schema; bot tokens via env-ref, never inline
- **F11.16** P1 Daemon log file with rotation at `~/.config/talos/daemon.log`
- **F11.17** P1 Daemon config hot-reload (SIGHUP rereads `channels.yaml` without restart)
- **F11.18** P1 OS service template generator (`talos install-service --print` for inspection)
- **F11.19** P2 Discord channel adapter
- **F11.20** P2 Web dashboard channel: tiny SPA at `127.0.0.1:7711/ui`

## 12. Tests

Stack: Vitest + PGLite-in-memory + seeded LLM eval. Demo-flow eval is the regression gate.

### P0 — required for v1

- **F12.1** P0 Provider router resolves model id → SDK adapter (unit)
- **F12.2** P0 KeeperHub middleware: `mutates: true` → routes through workflow (unit)
- **F12.3** P0 KeeperHub middleware: undeclared annotation → defaults to mutating (unit)
- **F12.4** P0 KeeperHub middleware: name matches `KNOWN_READONLY` allowlist → bypasses (unit)
- **F12.5** P0 Tool-result flattening: single text → string (unit)
- **F12.6** P0 Tool-result flattening: text-with-JSON → parsed object (unit)
- **F12.7** P0 Cross-thread recall: cosine ≥ 0.78 threshold gate enforces (unit)
- **F12.8** P0 Thread auto-summarization triggers at exactly 20 runs (unit)
- **F12.9** P0 Migrations: empty DB → schema at vN (integration)
- **F12.10** P0 Migrations: vN-1 → vN, no data loss (integration)
- **F12.11** P0 WS auth: bad bearer token → 401 (integration)
- **F12.12** P0 WS auth: valid token → connect + can run (integration)
- **F12.13** P0 Run abort: AbortController cancels `streamText`, persists `runs.error: 'aborted'` (integration)
- **F12.14** P0 Telegram whitelist: non-allowed user silently dropped (unit)
- **F12.15** P0 `init` idempotency: re-running with existing config prompts keep/reset/partial (unit)
- **F12.16** P0 **CRITICAL** Demo-flow eval: "supply 100 USDC to Aave on arbitrum" hits expected MCP sequence on locked seed (eval)

### P1 — required for v1.1

- **F12.17** P1 Tool-result flattening: multi-text blocks joined with `\n\n` (unit)
- **F12.18** P1 Tool-result flattening: error → wrapped with `error` tag (unit)
- **F12.19** P1 Concurrent runs across channels don't interfere (integration)
- **F12.20** P1 MCP-server proxy: stdio in → WS out → events back, end-to-end (integration)
- **F12.21** P1 Telegram edit-in-place: rate-limit throttle (~1.1s) holds (integration)
- **F12.22** P1 Knowledge cron: one source 503, others succeed, partial state surfaced (integration)
- **F12.23** P1 OAuth flow end-to-end against mocked KeeperHub (integration)

## Counts

130 features. P0 = 87. P1 = 33. P2 = 10.

## Open questions (deferred)

- License pick (MIT vs Apache-2.0)
- GitHub org / npm package name (collision check needed: Talos Linux, Cisco Talos exist in other domains)
- Project name suffix if needed (`talos-eth`, `talos-agent`, or just `talos`)

## Out of scope (parked)

- Identity layer (ENS subnames + ERC-8004 + reverse resolution + capability text records) — dropped 2026-04-27 to keep scope simple, may revisit
- ENS sponsor track ($5k) — given up with Identity layer
