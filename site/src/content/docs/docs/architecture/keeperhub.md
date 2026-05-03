---
title: KeeperHub middleware
description: Audit-by-default execution for every chain-mutating tool.
---

[KeeperHub](https://keeperhub.com) is an execution-and-audit layer for blockchain tool calls. Talos routes every chain-mutating tool through it. The middleware is **safe-by-default**: any tool that doesn't explicitly declare itself read-only is treated as if it mutates state.

## The contract

For every tool call:

1. Look up the tool's MCP annotations (the `annotations` field on the MCP tool registration).
2. If `annotations.readonly === true` → bypass KeeperHub, call the tool directly.
3. If the tool name matches the `KNOWN_READONLY` regex (e.g. `^(get|read|fetch|query)_`) → bypass.
4. Otherwise → wrap the tool call in a KeeperHub workflow, await receipt, log to `tool_calls`.

That third bullet is the safety net for legacy MCP servers that don't ship annotations. The regex is conservative; false positives mean we audit a read, which is fine. False negatives — auditing nothing — would be the bug.

## OAuth handoff

Talos is a KeeperHub OAuth 2.1 client with **Dynamic Client Registration** and **PKCE**. No manual API key. The flow:

1. `talos init` opens your browser to the KeeperHub authorize endpoint
2. KeeperHub redirects back to `http://127.0.0.1:<random>/callback` (RFC 8252 loopback)
3. Talos exchanges the code for a refresh token, stores it at `~/.config/talos/keeperhub.json` mode `0600`
4. Refresh tokens are rotated on every access token mint

If the browser handoff fails, run `talos doctor --keeperhub` for diagnostic output.

## The audit trail

Every routed call writes a row to `tool_calls`:

| Column | What |
|---|---|
| `run_id` | Which agent run made the call |
| `step_id` | Step ordinal within the run |
| `tool` | Namespaced tool name (e.g. `aave_supply`) |
| `args` | JSON of inputs (PII-scrubbed) |
| `kh_workflow_id` | KeeperHub workflow ID |
| `kh_status` | `ok` / `failed` / `pending` |
| `tx_hash` | If the workflow produced a tx |
| `latency_ms` | End-to-end |

Read this table to reconstruct any agent run, audit it, replay it, or pull tx hashes for accounting.

## Bypass list

The `KNOWN_READONLY` regex is in `src/keeperhub/middleware.ts`. Adding to it requires a code change — intentionally; it's a security boundary. To override per call, set `annotations.readonly: true` on the MCP tool itself.

## Escape hatch: `KEEPERHUB_DISABLE_MUTATES`

Set `KEEPERHUB_DISABLE_MUTATES=true` in `~/.config/talos/.env` (or your shell) to skip KH routing for mutates. When the flag is on:

| What | Behaviour |
|---|---|
| Mutate tools | Execute directly via viem against the configured RPC |
| Read-only tools | Unchanged — still bypass KH as usual |
| Audit log | Still written to `tool_calls` (no `kh_workflow_id`, no `executionId`) |
| Latency | ~5s per swap on Sepolia vs ~2 min KH polling timeout |

When to use it:

- KH origin is returning 5xx or opaque `failed` workflow results
- You're recording a demo and need predictable confirmation latency
- Debugging encoding issues — direct viem surfaces the raw revert reason

The flag is parsed by `envBool()`, which accepts `true`/`1`/`yes`/`on` (and the matching false values). No other variant.

Long-term, KH stays the default. The flag exists so KH-side problems never block the local agent.
