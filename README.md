<div align="center">
  <img src="./assets/logo.png" alt="Talos" width="240" />

  <h1>Talos</h1>

  <p><strong>A self-hosted, vertical Ethereum agent.</strong></p>

  <p>
    Daemon plus thin clients. Curated DeFi tools. Daily-fresh ecosystem knowledge.<br/>
    Bring your own keys. Your wallet never leaves your machine.
  </p>

  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
    <a href="package.json"><img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-43853d.svg" /></a>
    <img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-3178c6.svg" />
    <img alt="Tests" src="https://img.shields.io/badge/tests-424%20passing-success.svg" />
    <a href="https://ethglobal.com/events/open-agents"><img alt="ETHGlobal Open Agents" src="https://img.shields.io/badge/ETHGlobal-Open%20Agents-7c3aed.svg" /></a>
  </p>
</div>

---

> In Greek myth, **Talos** was the bronze automaton forged by Hephaestus to guard the island of Crete — circling its shores three times a day, repelling intruders. This Talos guards your Ethereum positions instead.

## What is Talos?

Talos is an opinionated agent for working with Ethereum. It runs locally as an always-on daemon (`talosd`) with thin clients on top — a CLI REPL, a Telegram bot, and an MCP server you can drop into Claude Desktop, Cursor, or OpenClaw. The daemon owns a single PGLite database, a hot pool of curated DeFi MCP servers, a nightly knowledge cron over the ETH ecosystem, and a wallet that never leaves your machine.

It is **vertical** by design. General-purpose agents will cheerfully invent contract addresses and miss the difference between Aave and Uniswap. Talos ships with first-party tools for Aave V3, Uniswap V3, Li.Fi, Blockscout, the Coinbase AgentKit, and a generic EVM MCP — all wired through a single tool-routing surface that the agent loop sees as one bundle.

Every chain-mutating call is routed through [KeeperHub](https://keeperhub.com) for an auditable execution trail. Read-only calls bypass the audit hop. The default is **audit-by-default**: a tool that doesn't explicitly declare itself read-only is treated as if it mutates state.

## Why Talos?

| Problem | What Talos does |
|---|---|
| General agents are shallow on DeFi specifics | Curated, namespaced tools per protocol with annotation-driven routing |
| Stateless agents forget across sessions | Three-tier memory: hot (last 20 runs) + warm (thread summary) + cold (cross-thread semantic recall) |
| Hosted agents take custody of your wallet | Local viem signer, mode-0600 storage, BYOK model keys |
| One-shot LLM tools are slow to spin up | Always-running daemon — CLI invocations hit a hot runtime in <100ms |
| Plain prompts go stale | Nightly knowledge cron over L2Beat, DefiLlama, Etherscan, protocol changelogs |
| Audit trails are an afterthought | Every mutating tool call routed through KeeperHub workflows by default |

## Features

**Curated DeFi tools (Sepolia)**
- Aave V3 — supply, borrow, repay, withdraw, account-data reads
- Uniswap V3 — quotes, approvals, exact-input swaps with slippage
- Li.Fi — cross-chain bridges and quotes
- Blockscout — block, contract, and tx reads
- Coinbase AgentKit — wallet primitives, Pyth, Compound, and more
- Generic `evm-mcp` — arbitrary EVM RPC ops + ENS

**Memory and retrieval**
- PGLite single-file database with pgvector (HNSW) and tsvector (GIN)
- Hybrid retrieval (semantic + lexical) over conversation and knowledge namespaces
- Adaptive cross-thread recall (cosine ≥ 0.78, top-3, threshold-gated)
- Auto-summarization every 20 runs

**Knowledge layer**
- Nightly cron over L2Beat, DefiLlama, Etherscan releases, protocol GitHub changelogs
- Embeddings via OpenAI `text-embedding-3-small` (1536-dim)
- Top-N relevant chunks injected into the system prompt per query

**Channels**
- CLI REPL (`talos repl`) — thin WebSocket client, ^C aborts in-flight runs
- Telegram bot — long-polling via grammY, edit-in-place streaming
- MCP server (`talos serve --mcp`) — drop into Claude Desktop, Cursor, OpenClaw, Hermes
- All channels share one wallet, one knowledge base, one memory store

**Execution and audit**
- KeeperHub middleware with audit-by-default and a `KNOWN_READONLY` regex bypass
- OAuth 2.1 + Dynamic Client Registration + PKCE — no manual API keys
- Live progress streaming: every step yields a typed event to the caller

**Operations**
- One-command bootstrap: `talos init` (interactive wizard with idempotency)
- `talos doctor` for diagnostics, `talos install-service` for launchd/systemd
- Structured logs via pino, rotated to `~/.config/talos/daemon.log`

## Architecture

```
                     ┌──────────────────────────────────────────────┐
                     │  Thin clients                                │
                     │   talos repl  │  Telegram  │  MCP hosts     │
                     └─────┬─────────────┬─────────────┬────────────┘
                           │ WS:7711     │ in-process  │ stdio + WS
                           ▼             ▼             ▼
        ┌────────────────────────────────────────────────────────┐
        │  talosd  (always-running daemon, launchd/systemd)      │
        │                                                        │
        │  ┌─ Channel adapters ────────────────────────────────┐ │
        │  │  cli-ws    │   telegram   │   mcp-server         │ │
        │  └───────────────────────────────────────────────────┘ │
        │                                                        │
        │  ┌─ Runtime (Vercel AI SDK v6) ─────────────────────┐ │
        │  │  Provider router  │  Agent registry              │ │
        │  │  Memory manager   │  Prompt builder              │ │
        │  │  Agent loop (streamText) + middleware            │ │
        │  └───────────────────────────────────────────────────┘ │
        │                                                        │
        │  ┌─ KeeperHub middleware ───────────────────────────┐ │
        │  │  Annotation-driven routing │ audit-by-default    │ │
        │  └───────────────────────────────────────────────────┘ │
        ├────────────────────────────────────────────────────────┤
        │  PGLite + Drizzle  (knowledge + conversations)         │
        ├────────────────────────────────────────────────────────┤
        │  Wallet (viem) + nightly knowledge cron                │
        ├────────────────────────────────────────────────────────┤
        │  Hot MCP tool servers                                  │
        │   AgentKit  │  Blockscout  │  EVM  │  Li.Fi           │
        │   Aave (native)  │  Uniswap V3 (native)               │
        └────────────────────────────────────────────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the full design — schemas, event taxonomy, retrieval strategy, daemon lifecycle, and the audit-by-default contract.

## Quick start

### Requirements

- Node.js **>= 22**
- pnpm **>= 9**
- An OpenAI API key (BYOK)

### Install

```bash
git clone https://github.com/Allen-Saji/talos.git
cd talos
pnpm install
```

> npm publish is on the roadmap — package name TBD because `talos` collides with Talos Linux on npm.

### Initialize

```bash
pnpm dev:cli init
```

The interactive wizard walks you through:

1. OpenAI API key (written to `.env`, mode 0600)
2. Burner wallet generation (viem mnemonic, exported as private key)
3. KeeperHub OAuth (browser handoff via RFC 8252 loopback redirect)
4. Channel configuration (`channels.yaml`)
5. Daemon bearer token
6. Database migrations
7. Optional service install (launchd / systemd)

Re-running `init` is idempotent — it detects existing config and prompts to keep, reset, or partial-reset (re-do OAuth only). Pass `--non-interactive` for CI, `--skip-keeperhub` to defer the OAuth handoff.

### Run

```bash
# Start the daemon (foreground)
pnpm dev:daemon

# In another terminal, open the REPL
pnpm dev:cli repl
```

Or production-style, after `pnpm build`:

```bash
talosd &
talos repl
```

### Example interaction

```
You: what's my wallet address and ETH balance?
↳ calling agentkit_wallet_get_wallet_details
   ✓ 0x13CDAe5a4be3C4b4061eb2206e3dc239aD5F4399 — 0.0086 ETH

You: swap 0.001 ETH for USDC on uniswap, then supply 2 USDC to aave
↳ calling uniswap_get_quote { tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.001" }
   ✓ ~2.59 USDC at 0.3% fee
↳ calling uniswap_swap_exact_in { ... }
   ↳ keeperhub: workflow wf_8a3c... → tx 0x17643319... → confirmed
↳ calling aave_approve_pool { token: "USDC", amount: "2" }
   ↳ keeperhub: workflow wf_5d2e... → tx 0x4b9a... → confirmed
↳ calling aave_supply { token: "USDC", amount: "2" }
   ↳ keeperhub: workflow wf_b71f... → tx 0x9c2d... → confirmed

Done. Swapped 0.001 ETH for 2.59 USDC and supplied 2 USDC to Aave.
You now have an aUSDC position earning variable yield.
```

## Channels

### CLI

```bash
talos repl
```

Thin WebSocket client. ^C aborts the current run, ^D exits. Slash commands (`/help`, `/thread new`, `/status`) handled client-side.

### Telegram

Set `TELEGRAM_BOT_TOKEN` and enable the channel in `channels.yaml`:

```yaml
channels:
  telegram:
    enabled: true
    bot_token_ref: env:TELEGRAM_BOT_TOKEN
    allowed_users: ['@yourname']
```

The bot streams progress edit-in-place — one message per run, throttled to ~1 edit/second to stay under Telegram's rate limit.

### MCP server (Claude Desktop, Cursor, OpenClaw)

Talos exposes itself as an MCP server. Drop this into your host's config:

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

Tools exposed to the host:

| Tool | What it does |
|---|---|
| `query_eth_knowledge` | Hybrid retrieval over the local knowledge base; returns chunks + citations |
| `eth_action` | Runs the full Talos agent loop; streams progress to the host as MCP `notifications/progress` |
| `eth_status` | Wallet, chains, last-sync, enabled MCPs |
| `talos_new_thread` | Resets the host's session thread |

One thread per host session, so calls within a session share continuity. Cross-thread recall bridges to your CLI and Telegram history.

## Tool catalogue

| Source | Tools | Mode | Routed via KH? |
|---|---|---|---|
| Aave V3 (Sepolia) | `aave_get_user_account_data`, `aave_approve_pool`, `aave_supply`, `aave_borrow`, `aave_repay`, `aave_withdraw` | native | mutates only |
| Uniswap V3 (Sepolia) | `uniswap_get_quote`, `uniswap_approve_router`, `uniswap_swap_exact_in` | native | mutates only |
| Li.Fi | `lifi_get_chains`, `lifi_get_connections`, `lifi_get_quote`, `lifi_get_status`, `lifi_execute_quote` | native | mutates only |
| AgentKit | wallet primitives + Pyth, Compound, Morpho, and more (Coinbase action providers) | MCP-as-source | annotation-driven |
| Blockscout | multi-chain block, contract, tx reads | hosted MCP (Streamable HTTP) | read-only allowlist |
| `mcpdotdirect/evm-mcp` | generic EVM RPC, ENS, ERC-20/721 | local MCP | annotation overrides |

Adding a tool is an exercise in copying any of the `src/tools/<name>/` folders — five small files (`contracts.ts`, `tokens.ts`, the action files, `source.ts`, `index.ts`) and a `MutateRoute` per mutating tool.

## Project layout

```
src/
  runtime/         agent loop, provider router, agent registry
  persistence/     PGLite + Drizzle (threads, runs, steps, embeddings, knowledge)
  memory/          three-tier hot / warm / cold retrieval
  keeperhub/       OAuth client + audit-by-default middleware
  mcp-host/        multi-MCP-client orchestrator with namespacing
  tools/
    aave/          custom Aave V3 source
    uniswap/       custom Uniswap V3 source
    lifi/          Li.Fi cross-chain source
    agentkit/      Coinbase AgentKit cherry-pick
    native/        NativeToolSource base
  knowledge/       nightly cron + retrieval pipeline
  wallet/          viem signer
  init/            `talos init` wizard (idempotent, RFC 8252 loopback OAuth)
  channels/
    cli/           WS REPL client
    telegram/      grammY bot
    mcp-server/    stdio↔WS proxy (Talos-as-MCP)
  daemon/          talosd, control plane WS, lifecycle, doctor, install-service
  protocol/        WS frame zod schemas
  config/          paths, env, token
  shared/          logger, errors

bin/
  talos.ts         CLI entry
  talosd.ts        daemon entry

drizzle/           generated migrations
docs/              spec.md, architecture.md
tests/
  integration/     end-to-end tests against PGLite-in-memory
  eval/            demo-flow regression eval (locked seed, mocked LLM)
```

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Conventional Commits enforced via commitlint pre-commit hook. Lint and typecheck run on every commit.

The eval suite (`pnpm test:eval`) runs the locked demo-flow regression against a mocked LLM tape — it verifies that the agent emits the expected MCP tool sequence for a known intent. This is the gate; tools that change behaviour need a fresh tape.

For the full contributor workflow, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

Built for **[ETHGlobal Open Agents](https://ethglobal.com/events/open-agents)** (Apr 24 – May 6, 2026). Targeting the **KeeperHub** sponsor track ($5k primary, "OpenClaw connector").

| Layer | State |
|---|---|
| Runtime + agent loop | shipped |
| PGLite persistence + three-tier memory | shipped |
| KeeperHub middleware (OAuth + audit) | shipped |
| MCP host + namespaced tool surface | shipped |
| Channels (CLI, Telegram, MCP server) | shipped |
| Native tools (Aave, Uniswap V3, Li.Fi) | shipped |
| Hosted MCPs (Blockscout, evm-mcp, AgentKit) | shipped |
| Nightly knowledge cron | shipped |
| `talos init` interactive wizard | shipped |
| Demo-flow regression eval | shipped |
| Live KH OAuth round-trip verification | pending |
| Demo recording + submission writeup | pending |
| ZeroDev account-abstraction wrap | deferred to v1.1 |

424 tests passing across 35 files at the time of writing.

## License

[MIT](LICENSE) © Allen Saji

## Acknowledgements

- [Vercel AI SDK](https://github.com/vercel/ai) — agent loop substrate
- [Drizzle ORM](https://orm.drizzle.team) — schema-as-TS persistence
- [PGLite](https://pglite.dev) — Postgres-in-WASM, the reason this app fits in a single binary
- [viem](https://viem.sh) — Ethereum client
- [grammY](https://grammy.dev) — Telegram bot framework
- [KeeperHub](https://keeperhub.com) — execution + audit infrastructure
- The **ETHGlobal Open Agents** organisers and judges
