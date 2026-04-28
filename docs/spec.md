---
tags: [project, talos, hackathon, eth-open-agents, spec]
created: 2026-04-27
modified: 2026-04-27
status: locked
---

# Talos — Spec

Vertical ETH agent for ETHGlobal Open Agents (Apr 24 – May 6 2026). Self-hosted, BYOK model keys, OpenClaw-style. Spec locked 2026-04-27.

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
- **F2.4** P0 Audit log surface: `get_execution_logs` exposed via CLI command
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
- **F5.4** P0 Conversation state persistence per user (since AgentKit is stateless)
- **F5.5** P0 Text CLI interface (REPL)
- **F5.6** P1 Local web UI (React + Tailwind, single-page chat)
- **F5.7** P1 Streaming responses
- **F5.8** P2 Voice interface via dTelecom provider (x402 micropayments)

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

## Counts

60 features. P0 = 32. P1 = 22. P2 = 6.

## Open questions (deferred)

- License pick (MIT vs Apache-2.0)
- GitHub org / npm package name (collision check needed: Talos Linux, Cisco Talos exist in other domains)
- Project name suffix if needed (`talos-eth`, `talos-agent`, or just `talos`)

## Out of scope (parked)

- Identity layer (ENS subnames + ERC-8004 + reverse resolution + capability text records) — dropped 2026-04-27 to keep scope simple, may revisit
- ENS sponsor track ($5k) — given up with Identity layer
