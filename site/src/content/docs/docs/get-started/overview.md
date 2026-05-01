---
title: Overview
description: What Talos is, what it does, and how it fits into your stack.
---

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

## What's next

- [Install](/docs/get-started/install) — clone, install, build.
- [`talos init` walkthrough](/docs/get-started/init) — the wizard, step by step.
- [First run](/docs/get-started/first-run) — REPL, Telegram, MCP host.
