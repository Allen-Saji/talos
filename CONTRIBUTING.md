# Contributing

## Branch workflow

`main` is protected by a strict ruleset:

- direct push blocked (PR-required)
- force-push blocked
- branch deletion blocked

Both maintainers go through PRs.

```bash
git checkout -b feat/<short-name>
# ... commits ...
git push -u origin feat/<short-name>
gh pr create
# wait for CI green, squash-merge
```

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint.

```
feat(runtime): add provider router
fix(keeperhub): respect KNOWN_READONLY allowlist
chore: bump @ai-sdk/openai
docs(architecture): clarify thread keying
```

Allowed types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `build`, `ci`, `revert`.

## Code style

- Biome for lint and format. `pnpm lint` and `pnpm format`.
- Strict TypeScript. `noUncheckedIndexedAccess` on. No `any` unless guarded.
- Path alias `@/*` resolves to `src/*`.
- Co-locate unit tests as `*.test.ts`. Integration tests in `tests/integration/`. Eval in `tests/eval/`.
- Structured logging via `pino` (`@/shared/logger`). No `console.log` outside dev scripts.
- Typed errors from `@/shared/errors`. Throw subclasses, not bare `Error`.

## Pre-commit hook

`simple-git-hooks` runs on `pnpm install`:

- `pre-commit`: `pnpm lint && pnpm typecheck`
- `commit-msg`: commitlint

To re-install hooks after a fresh clone: `pnpm install` (the `prepare` script wires them up).

## Lanes

- **Lane A** (Allen): runtime, persistence, KeeperHub middleware, daemon control plane.
- **Lane B** (Amal): MCP host, tool wiring, knowledge cron.
- **Joint**: init wizard, channels impl, demo recording.

## Architectural changes

If a change touches a locked decision in `docs/architecture.md`, update the doc in the same PR.

## Local checks before opening a PR

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same matrix on Node 20 and 22.
