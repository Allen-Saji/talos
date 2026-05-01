---
title: AgentKit
description: Coinbase AgentKit cherry-pick — wallet primitives, Pyth, Compound, Morpho, and more.
---

**Source kind:** MCP-as-source (cherry-picked from `@coinbase/agentkit`) · **Networks:** mostly mainnet/testnet via shared viem signer · **KH routing:** annotation-driven

## What's pulled in

Always-on (no API key required):

| Provider | Highlights |
|---|---|
| **Wallet** | `wallet_get_wallet_details`, native + ERC-20 transfer |
| **Pyth** | `fetch_price_feed_id`, `fetch_price` for oracle feeds |
| **Compound** | Supply, borrow, redeem on supported markets |
| **Morpho** | Supply, withdraw, market browsing |
| **SushiRouter** | Quotes + swaps via Sushi |
| **Enso** | Bundle multi-step transactions |
| **Basename** | Resolve / mint Base names |
| **Zora** | Coin minting (requires `PINATA_JWT`) |

Gated on API key (skip if missing):

| Provider | Required key |
|---|---|
| **Zerion** | `ZERION_API_KEY` |
| **0x** | `ZEROEX_API_KEY` |
| **OpenSea** | `OPENSEA_API_KEY` |

## Wallet bootstrap

AgentKit needs a viem signer. Talos wires its single wallet module (see [`src/wallet/`](/docs/get-started/install)) — the same signer used by Aave, Uniswap, and Li.Fi. No double-key, no double-tracking.

If `EVM_PRIVATE_KEY` is set, that's the signer. Otherwise Talos generates a burner persisted to `~/.config/talos/burner.json` mode `0600`.

## Routing

AgentKit tools are passed through with their original MCP annotations. Pyth `fetch_*` actions are read-only and bypass KeeperHub. Compound `supply`/`borrow` are mutates and route through it.

## Gotchas (cherry-pick patches)

- Tool names from AgentKit are PascalCase-prefixed (`PythActionProvider_fetch_price`). Talos normalizes them to snake_case (`pyth_fetch_price`) before routing.
- AgentKit ships Zod 3; Talos uses Zod 4. Schemas are converted via `zod-to-json-schema` to bridge the gap.
- `@coinbase/agentkit-vercel-ai-sdk@0.1.0` produces JSON Schemas missing `"type": "object"` for empty Zod schemas, which OpenAI rejects. Talos walks `agentKit.getActions()` directly and patches the root.
- `@zoralabs/coins-sdk` requires Node ≥22. Talos's `engines.node` is bumped accordingly.
