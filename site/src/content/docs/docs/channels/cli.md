---
title: CLI REPL
description: A thin WebSocket REPL over talosd. ^C aborts, ^D exits.
---

```bash
talos repl
```

The CLI is a thin WS client. It auths to `talosd` with the bearer token from `~/.config/talos/daemon.token`. All execution happens daemon-side — the CLI just renders streamed events.

## Streaming

Each agent run streams events:

```
You: what's my Aave health factor?

↳ retrieving from knowledge: 3 chunks
↳ calling aave_get_user_account_data { user: "0x13CD..." }
   ✓ healthFactor 1.74, ltv 0.40
↳ thinking...

Your Aave health factor is 1.74 (LTV 40%). You have ~$520 of borrowing
headroom before liquidation risk rises.
```

Every `↳` is a typed event from the runtime: `tool_call`, `tool_result`, `text_delta`, `step_finished`, `run_finished`. The CLI renderer maps each to a glyph.

## Slash commands

Slash commands are handled client-side (no daemon roundtrip):

| Command | Effect |
|---|---|
| `/help` | Show slash command list |
| `/status` | Print daemon health, last cron sync, enabled MCPs |
| `/thread new` | Switch to a fresh thread (cross-thread recall still bridges) |
| `/thread list` | Show recent threads |
| `/thread switch <id>` | Resume an older thread |
| `/quit` | Disconnect and exit (same as `^D`) |

## Aborting

`^C` sends an `abort_run` frame — the daemon cancels the in-flight run and returns. In-flight tool calls already submitted to KeeperHub keep their workflow IDs; you can resume by re-issuing the request.

## Thread keying

CLI threads key as `cli:{$USER}:default` per process. The same `$USER` resumes the same thread across REPL restarts unless you `/thread new`.

See [Architecture → Three-tier memory](/docs/architecture/memory) for what's remembered.
