---
title: Aave V3
description: Custom MCP source for Aave V3 on Sepolia. Supply, borrow, repay, withdraw, account-data reads.
---

**Source kind:** native (custom MCP) · **Network:** Ethereum Sepolia · **KH routing:** mutates only

## Tools

| Tool | Mutates? | Description |
|---|---|---|
| `aave_get_user_account_data` | no | Total collateral, total debt, available borrows, current LTV, liquidation threshold, health factor. |
| `aave_approve_pool` | yes | Approve the Aave V3 Pool contract to spend an ERC-20 (gate for `supply`, `repay`). |
| `aave_supply` | yes | Supply an asset to receive an aToken position. |
| `aave_borrow` | yes | Borrow an asset against your collateral. |
| `aave_repay` | yes | Repay outstanding debt for an asset. |
| `aave_withdraw` | yes | Withdraw an asset by burning the aToken. |

## Example

```
You: deposit 10 USDC into aave

↳ calling aave_approve_pool { token: "USDC", amount: "10" }
  ↳ keeperhub: workflow wf_5d2e... → tx 0x4b9a... → confirmed
↳ calling aave_supply { token: "USDC", amount: "10" }
  ↳ keeperhub: workflow wf_b71f... → tx 0x9c2d... → confirmed

Done. Supplied 10 USDC. You hold ~10 aUSDC.
```

## Routing

Every Aave write is annotated `mutates: true`, so the [KeeperHub middleware](/docs/architecture/keeperhub) wraps each call in a workflow. Reads (`get_user_account_data`) are annotated `readonly: true` and bypass.

## Where the code lives

`src/tools/aave/` — six small files:

- `contracts.ts` — Pool / WETHGateway addresses, ABIs
- `tokens.ts` — Sepolia token registry (USDC, DAI, ETH, WETH, ...)
- `actions/*.ts` — one file per tool, all viem-based
- `source.ts` — `NativeToolSource` registration
- `index.ts` — barrel export
