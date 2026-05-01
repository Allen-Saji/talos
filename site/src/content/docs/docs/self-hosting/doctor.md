---
title: Doctor diagnostics
description: talos doctor prints what's wrong and how to fix it.
---

`talos doctor` runs structured diagnostics. Output is plain text — designed to be copy-pasted into an issue.

```bash
talos doctor
```

Sample run:

```
talos doctor — 2026-05-01T14:23:00Z

[ok]    .env present, mode 0600
[ok]    OPENAI_API_KEY set (sk-...gE7)
[ok]    ~/.config/talos/burner.json present, mode 0600 (0x13CD...4399)
[ok]    ~/.config/talos/daemon.token present, mode 0600
[ok]    ~/.config/talos/channels.yaml: 3 channels enabled (cli, telegram, mcp_server)
[ok]    PGLite at ~/.config/talos/db: 7 migrations, last applied 2026-04-30
[ok]    Daemon socket: 127.0.0.1:7711 reachable, version 0.1.0
[warn]  Last knowledge cron: 27h ago — expected ≤ 25h. Run `talos knowledge:refresh`.
[ok]    KeeperHub OAuth: refresh round-trip successful (token expires in 14d)
[ok]    MCP host: 6 sources registered, 65 tools total

1 warning. Service is healthy enough to run.
```

## Targeted checks

| Flag | Subcheck |
|---|---|
| `--keeperhub` | OAuth token validity, refresh round-trip, mint a fresh access token |
| `--db` | Migration state + integrity check (vacuum + analyze) |
| `--knowledge` | Last cron run, retrieval smoke query against the corpus |
| `--daemon` | Socket reachability, version, in-flight runs |
| `--all` | Same as default |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All ok or warnings only |
| 1 | One or more failed checks |
| 2 | Missing config (run `talos init` first) |

Wire into CI as a smoke gate:

```bash
talos init --non-interactive --skip-keeperhub
talos doctor --keeperhub --db --knowledge || exit 1
```
