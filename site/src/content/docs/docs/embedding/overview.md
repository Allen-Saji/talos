---
title: Embedding Talos
description: Use Talos as an MCP server inside another agent host. Tools, semantics, threading.
---

Talos exposes itself as an MCP server. Hosts that speak MCP — Claude Desktop, Cursor, OpenClaw, Hermes — can spawn `npx talos serve --mcp` and call Talos's tools.

For the per-host config snippets, see [Channels → MCP server](/docs/channels/mcp).

## Tools your host sees

| Tool | Mutates? | Use it for |
|---|---|---|
| `query_eth_knowledge` | no | RAG over the local knowledge corpus. Returns chunks + citations. The host's assistant uses this when the user asks an ETH ecosystem question. |
| `eth_action` | yes | Run a full Talos agent loop. Streams progress to the host. The host's assistant uses this when the user wants Talos to **do** something — swap, supply, bridge. |
| `eth_status` | no | Wallet, chains, last-sync, enabled MCPs. |
| `talos_new_thread` | no | Reset the host's session thread. Useful when context shifts and you want a clean slate. |

## How Talos coexists with the host's memory

When OpenClaw, Claude Desktop, or Cursor embeds Talos, you have **two runtimes and two memory stores side by side**. They do not merge — the only thing crossing the boundary is the input string going in and the result string coming out.

| Store | Owner | Contents |
|---|---|---|
| Host session log (e.g. `~/.openclaw/agents/<id>/sessions/<sid>.jsonl`) | Host | Full user-host conversation, including the `eth_action` call and result |
| Host persona files (`SOUL.md`, `AGENTS.md`, etc.) | Host | Host's persona, your profile, host-side tool conventions |
| `~/.config/talos/talos.db` (PGLite) | Talos | Threads, runs, steps, tool_calls, embeddings — only the ETH conversation |
| `~/.config/talos/burner.json` | Talos | The wallet that signs every tx |

What this means in practice:

- **The host's persona doesn't reach Talos.** Talos has its own ETH-specialist persona on the inside.
- **You can nudge the host to delegate.** In OpenClaw's `AGENTS.md` for example: *"For any ETH/DeFi questions, prefer the talos_eth tools (`eth_action`, `eth_status`, `query_eth_knowledge`). Don't try to do ETH math directly."*
- **Talos owns the wallet.** Whether you drive it from your host or from `talos repl` directly, the same wallet signs.
- **Audit is unified on the Talos side.** Every mutating call from any host (or any Talos channel) lands in the same `tool_calls` table behind the KH middleware.

## Threading

When a host spawns Talos via stdio, the thread keys as `mcp:{pid}:{startedAt}`. **Per host session.** Each Claude Desktop launch gets a fresh thread — but Talos's cross-thread recall still bridges to your CLI and Telegram history at cosine ≥ 0.78.

If you want continuity across host launches, call `talos_new_thread` and pass `threadId` explicitly via the host's MCP routing (some hosts allow this).

## Tool surface today vs roadmap

- **Today (Path A):** the host sees four flat tools — `eth_action`, `query_eth_knowledge`, `eth_status`, `talos_new_thread`. Inside `eth_action`, Talos runs its own LLM loop over the curated DeFi MCPs (Aave, Uniswap, Li.Fi, Blockscout, AgentKit, EVM-MCP) and returns the result.
- **Roadmap (Path B, spec F9.8):** Talos re-exports its DeFi MCPs under a `talos.*` namespace so the host's LLM can call `talos.aave_supply` / `talos.uniswap_quote` directly without nested LLM loops. Useful for hosts that want a curated tool bundle rather than a delegated agent.

## Streaming semantics

`eth_action` returns when the run completes. Progress streams via MCP `notifications/progress`:

```jsonc
// what the host sees during a run
{"method":"notifications/progress","params":{"progress":1,"total":8,"message":"calling uniswap_get_quote"}}
{"method":"notifications/progress","params":{"progress":2,"total":8,"message":"quote: ~2.59 USDC"}}
{"method":"notifications/progress","params":{"progress":3,"total":8,"message":"calling uniswap_swap_exact_in"}}
{"method":"notifications/progress","params":{"progress":4,"total":8,"message":"keeperhub: workflow wf_8a3c..."}}
{"method":"notifications/progress","params":{"progress":5,"total":8,"message":"tx 0x17643319... submitted"}}
{"method":"notifications/progress","params":{"progress":6,"total":8,"message":"tx confirmed in block 5612343"}}
```

Hosts that render progress (Claude Desktop, Cursor) show the live trace. Hosts that don't, just see the final result.

## Distribution

Want to set Talos up for users of your host? Send them this URL:

> [`https://talos.allensaji.dev/install`](https://talos.allensaji.dev/install)

It returns plaintext `npx talos init`. Pipe-friendly. Agent-friendly.
