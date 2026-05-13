---
title: talos init walkthrough
description: The interactive wizard, step by step.
---

`talos init` is the canonical bootstrap. It is **idempotent** — re-running detects existing config and prompts to keep or reset.

```bash
pnpm dev:cli init
# or, after pnpm build + link:
talos init
```

## Steps

The wizard walks you through six steps:

1. **OpenAI API key** — written to `.env` with mode `0600`.
2. **Burner wallet** — viem mnemonic generated, exported as a private key, persisted to `~/.config/talos/burner.json` mode `0600`. Set `EVM_PRIVATE_KEY` in your env to override.
3. **Channel configuration** — writes `channels.yaml` (CLI / Telegram / MCP enabled flags).
4. **Daemon bearer token** — written to `~/.config/talos/daemon.token` mode `0600`. Used by all thin clients to authenticate to `talosd`.
5. **Database migrations** — Drizzle migrations applied to PGLite at `~/.config/talos/db/`.
6. **Optional service install** — launchd (macOS) or systemd-user (Linux) unit so `talosd` starts on login.

## Flags

| Flag | What it does |
|---|---|
| `--non-interactive` | Skip all prompts; fail if any required input is missing. For CI. |
| `--skip-service` | Skip the optional launchd / systemd install prompt. |

## Idempotency

Re-running `talos init` shows you each existing piece of config and asks:

```
Found existing OpenAI API key in .env (sk-...gE7).
  [k] Keep
  [r] Reset (re-prompt)
  [s] Skip
```

Selecting **Keep** for everything is a no-op — useful for verifying state without rewriting anything.

## Troubleshooting

If init fails partway, run `talos doctor` to check what's missing. Doctor will print exactly which file is absent or malformed and how to recover it.
