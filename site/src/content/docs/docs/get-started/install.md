---
title: Installation
description: Install Talos from source. Node 22+, pnpm 9+, an OpenAI API key.
---

## Requirements

- **Node.js** ≥ 22
- **pnpm** ≥ 9
- **git**
- An **OpenAI API key** (BYOK — Talos never sees keys you don't paste in)

## Install (one-liner)

```bash
curl -fsSL https://talos.allensaji.dev/install.sh | bash
```

Installs to `~/.local/share/talos`, builds, and links `talos` globally. Override the location with `TALOS_DIR=...`.

:::note
npm publish is on the roadmap. The package name is TBD because `talos` collides with Talos Linux on npm. Until then, the installer above (or the manual path below) is the canonical install.
:::

## Install from source (manual)

```bash
git clone https://github.com/Allen-Saji/talos.git
cd talos
pnpm install
pnpm build
pnpm link --global
```

## Verify

```bash
pnpm typecheck
pnpm test
```

Expect 35 test files green and 425+ individual tests passing.

## Binaries

`pnpm build` produces two entrypoints in `dist/bin/`:

| Binary | Role |
|---|---|
| `talos` | CLI entry — `init`, `repl`, `serve --mcp`, `doctor`, `install-service` |
| `talosd` | Daemon entry — long-running WS control plane on `127.0.0.1:7711` |

After build, you can also link a global symlink:

```bash
pnpm link --global
talos --version
```

## Next

[Run `talos init`](/docs/get-started/init) to bootstrap config, the burner wallet, and KeeperHub OAuth.
