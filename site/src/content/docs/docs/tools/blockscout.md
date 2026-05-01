---
title: Blockscout
description: Multi-chain block, contract, and tx reads via the hosted Blockscout MCP.
---

**Source kind:** hosted MCP (Streamable HTTP) · **Networks:** every Blockscout-indexed chain · **KH routing:** read-only allowlist

## Tools

Blockscout exposes ~25 read tools. Frequently-used:

| Tool | Description |
|---|---|
| `blockscout_get_block` | Block header + tx list by number or hash |
| `blockscout_get_transaction` | Tx receipt, decoded logs, internal txs |
| `blockscout_get_address` | Address overview — balance, tx count, decoded role |
| `blockscout_get_contract` | Contract ABI, source if verified, proxy implementation |
| `blockscout_get_token_holders` | ERC-20 / 721 / 1155 holder list |
| `blockscout_search` | Free-text across addresses, contracts, ENS names |

See the full list at `mcp.blockscout.com`.

## Why hosted

Blockscout's hosted MCP at `https://mcp.blockscout.com` speaks **Streamable HTTP** (Model Context Protocol's HTTP-based transport). Talos's MCP host connects over Streamable HTTP transport — no local node, no API key needed for the public surface.

## Why this exists alongside `evm-mcp`

`evm-mcp` is generic JSON-RPC. It can `eth_call` or `eth_getTransactionReceipt`, but it doesn't decode logs, doesn't resolve ENS to display names, and its public mainnet RPC is unreliable. Blockscout's indexer fills that gap — decoded logs, contract verification status, token metadata, ENS, all in one place.

## Routing

All Blockscout tools are annotated `readonly: true`, so they bypass [KeeperHub](/docs/architecture/keeperhub).
