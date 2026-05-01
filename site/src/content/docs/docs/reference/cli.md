---
title: CLI commands
description: Every command the talos binary exposes.
---

The `talos` binary has subcommands. The `talosd` binary is the daemon — no subcommands.

## `talos init`

Interactive bootstrap wizard. See [`talos init` walkthrough](/docs/get-started/init).

```bash
talos init [--non-interactive] [--skip-keeperhub] [--reset-keeperhub] [--reset-wallet]
```

## `talos repl`

Open a WebSocket REPL against the running daemon.

```bash
talos repl [--token <bearer>] [--url ws://127.0.0.1:7711]
```

By default reads the bearer token from `~/.config/talos/daemon.token`.

## `talos serve --mcp`

Run as an MCP server (stdio↔WS proxy back to `talosd`). For host configs see [Channels → MCP server](/docs/channels/mcp).

```bash
talos serve --mcp
```

This is what hosts spawn as a child process.

## `talos doctor`

Print diagnostics. Run when something feels off — missing config, broken auth, stale data.

```bash
talos doctor [--keeperhub] [--db] [--knowledge]
```

| Flag | Subcheck |
|---|---|
| (none) | All checks: env, files, daemon socket, KH OAuth, DB integrity, last cron run |
| `--keeperhub` | OAuth token validity, refresh round-trip |
| `--db` | PGLite migrations applied, integrity check |
| `--knowledge` | Last cron timestamp + retrieval smoke query |

## `talos install-service`

Install a launchd (macOS) or systemd-user (Linux) unit so `talosd` starts on login.

```bash
talos install-service [--remove] [--name talosd]
```

User-level only. No root install. Unit lives at `~/Library/LaunchAgents/com.allen.talosd.plist` (macOS) or `~/.config/systemd/user/talosd.service` (Linux).

## `talos knowledge:refresh`

Force the nightly knowledge cron to run now.

```bash
talos knowledge:refresh
```

Streams progress to stdout. Useful right after an L2Beat / DefiLlama outage — refreshes the local corpus on demand.
