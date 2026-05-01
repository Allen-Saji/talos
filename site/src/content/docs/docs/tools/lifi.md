---
title: Li.Fi
description: Cross-chain bridges and quotes via the Li.Fi SDK.
---

**Source kind:** native (Li.Fi SDK wrapped as MCP) · **Networks:** all Li.Fi-supported chains · **KH routing:** mutates only

## Tools

| Tool | Mutates? | Description |
|---|---|---|
| `lifi_get_chains` | no | List supported chains. |
| `lifi_get_connections` | no | Bridges + DEXs that route between two specific chains. |
| `lifi_get_quote` | no | Quote a specific token-in/token-out across chains. |
| `lifi_get_status` | no | Poll status for a previously-executed quote. |
| `lifi_execute_quote` | yes | Execute a quote — submits the source-chain tx, polls bridge status. |

## Example

```
You: bridge 5 USDC from Sepolia to Base Sepolia

↳ calling lifi_get_quote { fromChain: 11155111, toChain: 84532, fromToken: "USDC", toToken: "USDC", fromAmount: "5000000" }
  ✓ via Across, ETA 90s, fee 0.04 USDC
↳ calling lifi_execute_quote
  ↳ keeperhub: workflow wf_c19a... → tx 0x3b22... → submitted
↳ calling lifi_get_status { txHash: "0x3b22..." }
  ✓ DONE — destination tx 0x9aff... on Base Sepolia
```

## NativeToolSource pattern

Li.Fi is a normal SDK, not an MCP server. Talos wraps it via `NativeToolSource` — same surface as a real MCP client to the runtime, but the actions are TypeScript functions. See `src/tools/native/source.ts`.

The cross-chain status loop is the bit that reads "execute" semantics — `lifi_execute_quote` doesn't return until the destination chain confirms or the timeout fires.
