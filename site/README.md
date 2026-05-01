# Talos site

Landing page + docs for [Talos](https://github.com/Allen-Saji/talos).

Astro 5 + Starlight. SSG. Self-hosted Inter + JetBrains Mono via Fontsource. Bronze-on-dark theme.

## Develop

```bash
pnpm install
pnpm dev          # → http://127.0.0.1:4321
```

## Build

```bash
pnpm build        # astro check + astro build + scripts/build-llms-txt.mjs
pnpm preview      # serve dist/ locally
```

`build` produces `dist/` with the static site, `dist/llms.txt`, `dist/sitemap-index.xml`, and a static `dist/install` plaintext.

## Regenerate brand assets

The favicons + OG image are derived from `src/assets/logo.png`. Re-run when the logo changes:

```bash
pnpm gen:assets
```

Outputs to `public/`: `favicon-{16,32,192,512}.png`, `apple-touch-icon.png`, `favicon.svg`, `og.png`.

## Layout

```
src/
  pages/
    index.astro          custom landing
    install.ts           plaintext /install endpoint
  content/
    docs/                Starlight docs collection
      docs/              all doc pages live under /docs/*
        get-started/
        architecture/
        channels/
        tools/
        reference/
        self-hosting/
        embedding/
      index.mdx          /docs hub (CardGrid)
  components/            landing components
  styles/theme.css       brand tokens + Starlight overrides
  assets/logo.png        source logo

public/                  copied verbatim — favicons, og.png, _headers, fonts
scripts/
  gen-assets.mjs         logo → favicons + OG via sharp
  build-llms-txt.mjs     dist/llms.txt builder

astro.config.mjs         Starlight + sitemap + mdx integrations
```

## Agent-friendly bits

| URL | Format |
|---|---|
| `/install` | `text/plain` — `npx talos init` (pipe-friendly) |
| `/llms.txt` | [llmstxt.org](https://llmstxt.org) standard, every doc page indexed |
| `/sitemap-index.xml` | Standard sitemap protocol |

Per-host MCP integration snippets live in `src/components/MCPHostTabs.astro` and `src/content/docs/docs/channels/mcp.mdx`. They are kept in sync manually — when the host config format changes, update both.

## Deploy

Static SSG output. Drop `dist/` on any host. `_headers` covers Cloudflare Pages / Netlify; `vercel.json` covers Vercel.

The site is configured for `https://talos.allensaji.dev` (see `astro.config.mjs` `site:`); change there before deploying to a different origin.
