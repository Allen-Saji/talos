---
title: First run
description: Start the daemon, open the REPL, ask Talos something.
---

## Start the daemon

```bash
pnpm dev:daemon
```

You should see structured pino logs:

```
{"level":30,"time":...,"msg":"talosd starting"}
{"level":30,"time":...,"msg":"PGLite open at /home/you/.config/talos/db"}
{"level":30,"time":...,"msg":"WS control plane listening","host":"127.0.0.1","port":7711}
{"level":30,"time":...,"msg":"MCP host: 6 tool sources registered"}
{"level":30,"time":...,"msg":"talosd ready"}
```

If a service is installed, `talosd` will already be running — `pnpm dev:daemon` will fail with `EADDRINUSE`. Either stop the service (`launchctl unload ...` or `systemctl --user stop talosd`) or skip this step.

## Open the REPL

In a second terminal:

```bash
pnpm dev:cli repl
```

The REPL is a thin WebSocket client. `^C` aborts the current run, `^D` exits.

## Ask Talos something

```
You: what's my wallet address and ETH balance?
↳ calling agentkit_wallet_get_wallet_details
   ✓ 0x13CDAe5a4be3C4b4061eb2206e3dc239aD5F4399 — 0.0086 ETH

You: swap 0.001 ETH for USDC on uniswap, then supply 2 USDC to aave
↳ calling uniswap_get_quote { tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.001" }
   ✓ ~2.59 USDC at 0.3% fee
↳ calling uniswap_swap_exact_in { ... }
   ↳ keeperhub: workflow wf_8a3c... → tx 0x17643319... → confirmed
↳ calling aave_approve_pool { token: "USDC", amount: "2" }
   ↳ keeperhub: workflow wf_5d2e... → tx 0x4b9a... → confirmed
↳ calling aave_supply { token: "USDC", amount: "2" }
   ↳ keeperhub: workflow wf_b71f... → tx 0x9c2d... → confirmed

Done. Swapped 0.001 ETH for 2.59 USDC and supplied 2 USDC to Aave.
You now have an aUSDC position earning variable yield.
```

## Slash commands

The REPL handles slash commands client-side — no roundtrip to the daemon:

| Command | Effect |
|---|---|
| `/help` | List slash commands |
| `/status` | Daemon health, last sync, enabled MCPs |
| `/thread new` | Reset to a fresh thread (keeps cross-thread recall) |
| `/quit` | Same as `^D` |

## Where now?

- [Embed Talos in Claude / Cursor / OpenClaw](/docs/channels/mcp)
- [Wire the Telegram bot](/docs/channels/telegram)
- [Tour the tool catalogue](/docs/tools/aave)
