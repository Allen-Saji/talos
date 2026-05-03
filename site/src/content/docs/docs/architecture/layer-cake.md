---
title: Layer cake
description: How talosd, the runtime, persistence, the wallet, and the hot MCP host fit together.
---

![Talos layer cake — thin clients, talosd (channel adapters / runtime / KeeperHub middleware), PGLite + Drizzle, wallet + knowledge cron, hot MCP tool servers](/talos-arch.png)

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
| 8 | LLM call style | `streamText` everywhere |
| 9 | KeeperHub default | **Audit-by-default** — undeclared tools routed |

For the full design — schemas, event taxonomy, retrieval strategy, daemon lifecycle, audit-by-default contract — see [`docs/architecture.md`](https://github.com/Allen-Saji/talos/blob/main/docs/architecture.md) in the repo.
