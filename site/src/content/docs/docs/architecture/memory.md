---
title: Three-tier memory
description: Hot, warm, and cold recall — how Talos remembers across runs and threads.
---

| Tier | Window | Trigger | Source |
|---|---|---|---|
| **Hot** | Last 20 runs of the current thread | Always injected | `runs` + `steps` tables |
| **Warm** | Per-thread summary | Every 20 runs, lazy | LLM summarizer over warm slice |
| **Cold** | Across all threads, cosine ≥ 0.78, top-3 | Per query | `embeddings` table, pgvector HNSW |

## Hot

Every run reads its thread's last 20 runs (with their step traces) into the system prompt. This is what gives Talos coherence within a session — "did we just supply USDC to Aave?" stays in scope.

## Warm

Every 20 runs, a summarizer condenses the warm slice into a thread-level summary stored on `threads.summary`. The summary is injected when the thread expands beyond what hot can hold. The summarizer is its own LLM call with a tight system prompt — see `src/memory/summarize.ts`.

## Cold

Cross-thread recall is the genuinely hard part. Every user message and assistant response is embedded with `text-embedding-3-small` (1536-dim) and stored in `embeddings` indexed by HNSW. Per query, Talos pulls the top-3 chunks at cosine ≥ 0.78 and injects them as "from your past conversations" context.

The threshold is **adaptive**: it falls when the user is in a fresh thread (no warm context yet) and rises when there's already enough hot+warm to ground the response. See `src/memory/recall.ts`.

## Hybrid retrieval

Knowledge retrieval (the nightly cron-fed corpus) uses hybrid pgvector + tsvector:

- **pgvector HNSW** for semantic similarity
- **tsvector GIN** for lexical match on protocol names, contract addresses, EIP numbers
- Reciprocal rank fusion to merge results — semantic-first, lexical breaks ties

This is what keeps "tell me about EIP-7702" from getting outranked by an unrelated semantic neighbor.
