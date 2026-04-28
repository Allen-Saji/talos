# Talos

Vertical ETH agent. Always-running daemon plus thin clients (CLI, Telegram, MCP-server). Self-hosted, BYOK, daily-fresh ecosystem knowledge.

Built for [ETHGlobal Open Agents](https://ethglobal.com/events/open-agents) (Apr 24 – May 6, 2026).

## Status

Pre-alpha. Scaffold only. See [`docs/spec.md`](docs/spec.md) and [`docs/architecture.md`](docs/architecture.md) for the design.

## Requirements

- Node.js >= 20.11
- pnpm >= 9
- An OpenAI API key (BYOK)

## Quick start

```bash
pnpm install
cp .env.example .env
# fill in OPENAI_API_KEY and KEEPERHUB_URL

# dev
pnpm dev:cli
pnpm dev:daemon

# typecheck, lint, test, build
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Layout

```
src/
  runtime/        # agent loop, provider router
  persistence/    # PGLite + Drizzle
  memory/         # 3-tier hot/warm/cold
  keeperhub/      # MCP client + audit middleware
  mcp-host/       # multi-MCP-client orchestrator
  tools/          # protocol wiring (Aave, Uniswap, Blockscout, …)
  knowledge/      # nightly cron + embeddings
  wallet/         # viem + ZeroDev wrapper
  channels/
    cli/          # WS REPL
    telegram/     # grammY long-poll
    mcp-server/   # stdio→WS proxy (Talos-as-MCP)
  daemon/         # talosd, control plane WS
  protocol/       # WS frame zod schemas
  config/         # paths, env, token
  shared/         # logger, errors
bin/
  talos.ts        # CLI entry
  talosd.ts       # daemon entry
drizzle/          # generated migrations
tests/
  integration/
  eval/           # F12.16 demo-flow regression gate
docs/             # spec.md, architecture.md
```

## Contributing

Both maintainers use feature branches → PR → squash-merge. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).
