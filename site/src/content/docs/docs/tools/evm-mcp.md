---
title: EVM-MCP
description: Generic EVM RPC operations via mcpdotdirect/evm-mcp — ENS, ERC-20, ERC-721.
---

**Source kind:** local MCP (`mcpdotdirect/evm-mcp` via stdio) · **Networks:** any EVM chain with an RPC URL · **KH routing:** annotation overrides

## Tools

`evm-mcp` ships ~16 tools. The frequently-used:

| Tool | Description |
|---|---|
| `evm_eth_call` | Generic JSON-RPC call against any contract |
| `evm_eth_estimateGas` | Estimate gas for a tx |
| `evm_eth_getBalance` | Native balance for an address |
| `evm_eth_getCode` | Contract code at an address |
| `evm_resolve_ens` | ENS name → address (mainnet) |
| `evm_lookup_ens` | Reverse — address → ENS name |
| `evm_erc20_balance_of` | ERC-20 balance |
| `evm_erc20_transfer` | ERC-20 transfer (mutates) |
| `evm_erc721_owner_of` | ERC-721 owner |
| `evm_erc721_transfer_from` | ERC-721 transfer (mutates) |

## Annotation overrides

`evm-mcp`'s upstream annotations don't always classify reads vs writes correctly. Talos applies an **annotation override** layer (`src/mcp-host/overrides.ts`) that re-marks specific tools — e.g. `eth_call` is forced `readonly: true`, `erc20_transfer` is forced `mutates: true`.

This is an explicit table, not a regex — false-positives in either direction are a security issue.

## Why this exists alongside Blockscout

EVM-MCP is the **mutator path** for arbitrary contracts. Blockscout is read-only. If you need to call a custom contract function with custom calldata, you go through `evm_eth_call` (read) or wrap it in your own native source (write).

## RPC config

Each chain needs a URL. Set in `.env`:

```bash
RPC_URL_SEPOLIA=https://sepolia.gateway.tenderly.co
RPC_URL_BASE_SEPOLIA=https://base-sepolia.public.blastapi.io
RPC_URL_MAINNET=https://eth.gateway.tenderly.co  # mainnet reads only — no signing
```

Talos's `src/wallet/` module reads these at chain-context construction.
