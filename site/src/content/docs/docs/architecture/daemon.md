---
title: Daemon + thin clients
description: Why talosd owns the world and clients are dumb.
---

`talosd` is the only process that holds open PGLite, the MCP host, and the wallet. Every other surface (CLI, Telegram, MCP server) is a thin client that connects in over a localhost WebSocket on `127.0.0.1:7711`.

## Why centralize

- **PGLite** wants a single owner per database. Cross-process file locks make multi-owner setups fragile.
- The **MCP host** holds long-running stdio child processes. Spawning per CLI invocation would cost ~2-3s per run.
- The **wallet** is sensitive. One process, one fd, one signer minimizes blast radius.
- Cross-channel **memory** (CLI → Telegram → MCP) only works if all three see the same database.

## Control plane

The daemon listens on `127.0.0.1:7711` (configurable). Bearer-token auth — token at `~/.config/talos/daemon.token`, mode `0600`.

The protocol is JSON over WebSocket. Frame types are validated with Zod schemas in `src/protocol/`. See [Reference → Config files](/docs/reference/config) for the channel manifest format.

## Lifecycle

| Phase | What happens |
|---|---|
| `startup` | Open PGLite, run pending migrations, register MCP sources, bind WS |
| `ready` | Accept channel connections; nightly cron registers |
| `request` | Per-run thread keying, retrieval, agent loop, middleware, response stream |
| `shutdown` | Drain in-flight runs (with timeout), close PGLite, flush logs |

Crash recovery: PGLite is durable on every commit, so a hard kill is recoverable. In-flight runs at the LLM are aborted; tool calls already submitted to KeeperHub keep their workflow ID — re-running the run picks up the receipt.

## Service install

```bash
talos install-service           # launchd (macOS) or systemd-user (Linux)
talos install-service --remove
```

User-level only. No root install. The unit file targets `~/.local/share/...` so admin permission is never required.
