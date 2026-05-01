---
title: Uniswap V3
description: Custom MCP source for Uniswap V3 on Sepolia. Quote, approve, exact-input swap.
---

**Source kind:** native (custom MCP) · **Network:** Ethereum Sepolia · **KH routing:** mutates only

## Tools

| Tool | Mutates? | Description |
|---|---|---|
| `uniswap_get_quote` | no | Quoter V2 quote for an exact-input swap. Returns expected output and the encoded path. |
| `uniswap_approve_router` | yes | Approve the SwapRouter02 contract to spend an ERC-20. |
| `uniswap_swap_exact_in` | yes | Execute an exact-input swap with slippage protection. |

## Example

```
You: swap 0.001 ETH for USDC on uniswap

↳ calling uniswap_get_quote { tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.001" }
  ✓ ~2.59 USDC at 0.3% fee
↳ calling uniswap_swap_exact_in { ... slippage: 0.5% }
  ↳ keeperhub: workflow wf_8a3c... → tx 0x17643319... → confirmed

Done. Swapped 0.001 ETH for 2.59 USDC.
```

## Slippage

`uniswap_swap_exact_in` defaults to `slippageBps: 50` (0.5%). The agent can override per-call if the intent suggests urgency vs price sensitivity.

For ETH ↔ ERC-20 swaps, the action wraps automatically — supply `tokenIn: "ETH"` and the call internally wraps to WETH and unwraps the recipient if `tokenOut === "ETH"`.

## Where the code lives

`src/tools/uniswap/` — same five-file layout as [Aave](/docs/tools/aave). Pool fee defaults to 0.3% but can be overridden per call.
