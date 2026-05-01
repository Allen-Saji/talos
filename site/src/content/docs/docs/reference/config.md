---
title: Config files
description: channels.yaml and the JSON files in ~/.config/talos/.
---

Talos keeps user config under `~/.config/talos/`. The init wizard manages this directory; you can edit by hand if you know what you're doing.

## `channels.yaml`

Declares which channels are enabled and their per-channel options.

```yaml title="~/.config/talos/channels.yaml"
channels:
  cli:
    enabled: true
  telegram:
    enabled: true
    bot_token_ref: env:TELEGRAM_BOT_TOKEN
    allowed_users: ['@yourname']
    rate_limit_edits_per_sec: 1
  mcp_server:
    enabled: true
```

Restart `talosd` after edits. CLI is on by default; turning it off makes the WS REPL unauthorized.

## `daemon.token`

The bearer token thin clients present to the daemon. Plaintext, mode `0600`.

```
talos_dt_5f8c9...
```

Regenerate with `talos init --reset-token` (forces all open thin clients to reconnect).

## `keeperhub.json`

KeeperHub OAuth credentials. Mode `0600`. Don't edit by hand — use `talos init --reset-keeperhub` to refresh.

```json
{
  "client_id": "kh_dcr_...",
  "refresh_token": "kh_rt_...",
  "scope": "workflow:read workflow:write",
  "issued_at": "2026-04-29T10:30:00Z"
}
```

## `burner.json`

Burner wallet (only if `EVM_PRIVATE_KEY` is unset). Mode `0600`.

```json
{
  "address": "0x13CDAe5a4be3C4b4061eb2206e3dc239aD5F4399",
  "privateKey": "0x...",
  "createdAt": "2026-04-29T10:30:00Z"
}
```

## `daemon.log`

pino-formatted JSONL log. Rotated by the daemon; the latest is at `daemon.log` and previous days at `daemon.YYYY-MM-DD.log`.

```bash
# Tail with pino-pretty
tail -f ~/.config/talos/daemon.log | pino-pretty
```
