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

## Threading

When a host spawns Talos via stdio, the thread keys as `mcp:{pid}:{startedAt}`. **Per host session.** Each Claude Desktop launch gets a fresh thread — but cross-thread recall still bridges to your CLI and Telegram history at cosine ≥ 0.78.

If you want continuity across host launches, call `talos_new_thread` and pass `threadId` explicitly via the host's MCP routing (some hosts allow this).

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
