---
title: Environment variables
description: Every env var Talos reads, what it does, and where it's set.
---

Talos reads its `.env` from the install directory and merges with the user shell env. The init wizard writes the `.env` file with `0600` perms.

## Required

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | Default LLM provider. BYOK. |

## Wallet

| Var | Purpose |
|---|---|
| `EVM_PRIVATE_KEY` | If set, signer is this key. If unset, Talos generates a burner at `~/.config/talos/burner.json`. |

## RPC URLs (optional, sane defaults if unset)

| Var | Purpose |
|---|---|
| `RPC_URL_SEPOLIA` | Sepolia RPC override |
| `RPC_URL_BASE_SEPOLIA` | Base Sepolia RPC override |
| `RPC_URL_MAINNET` | Mainnet RPC override (read-only — no signing in v1) |

## Channels

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather (only if Telegram channel enabled in `channels.yaml`) |

## AgentKit gated providers (optional)

| Var | Provider |
|---|---|
| `ZERION_API_KEY` | Zerion portfolio reads |
| `ZEROEX_API_KEY` | 0x quotes + swaps |
| `OPENSEA_API_KEY` | OpenSea NFT reads |
| `PINATA_JWT` | Required for Zora coin minting |

## Daemon

| Var | Purpose |
|---|---|
| `TALOS_HOST` | WS host (default `127.0.0.1`) |
| `TALOS_PORT` | WS port (default `7711`) |
| `TALOS_DB_PATH` | PGLite directory override (default `~/.config/talos/db`) |
| `TALOS_LOG_LEVEL` | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

## KeeperHub

| Var | Purpose |
|---|---|
| `KEEPERHUB_DISABLE_MUTATES` | When `true`, mutate tools skip KH routing and execute directly via viem. Audit logging to `tool_calls` stays on. Use during KH outages or to cut latency for demos. Accepts `true`/`1`/`yes`/`on` (and false equivalents). |

## Locations

| File | Mode |
|---|---|
| `~/.config/talos/daemon.token` | 0600 |
| `~/.config/talos/burner.json` | 0600 |
| `~/.config/talos/keeperhub.json` | 0600 |
| `~/.config/talos/channels.yaml` | 0644 |
| `~/.config/talos/daemon.log` | 0644 |
| `<install>/.env` | 0600 |
