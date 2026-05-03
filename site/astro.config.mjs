import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';

const SITE = 'https://talos.allensaji.dev';

export default defineConfig({
  site: SITE,
  trailingSlash: 'never',
  integrations: [
    react({
      include: ['**/components/react/**'],
    }),
    starlight({
      title: 'Talos',
      description: 'A self-hosted, vertical Ethereum agent. Daemon plus thin clients. Curated DeFi tools. Daily-fresh ecosystem knowledge. BYOK.',
      favicon: '/favicon.svg',
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:secure_url', content: `${SITE}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:type', content: 'image/png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Talos — a bronze automaton holding a sword, an Ethereum diamond on its chest, set against a dusk horizon.' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:site', content: '@SajiBhai011' } },
        { tag: 'meta', attrs: { name: 'twitter:creator', content: '@SajiBhai011' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Talos — a bronze automaton holding a sword, an Ethereum diamond on its chest, set against a dusk horizon.' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' } },
        { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Allen-Saji/talos' },
      ],
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Overview', slug: 'docs/get-started/overview' },
            { label: 'Installation', slug: 'docs/get-started/install' },
            { label: 'talos init walkthrough', slug: 'docs/get-started/init' },
            { label: 'First run', slug: 'docs/get-started/first-run' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Layer cake', slug: 'docs/architecture/layer-cake' },
            { label: 'Daemon + thin clients', slug: 'docs/architecture/daemon' },
            { label: 'Three-tier memory', slug: 'docs/architecture/memory' },
            { label: 'KeeperHub middleware', slug: 'docs/architecture/keeperhub' },
          ],
        },
        {
          label: 'Channels',
          items: [
            { label: 'CLI REPL', slug: 'docs/channels/cli' },
            { label: 'Telegram', slug: 'docs/channels/telegram' },
            { label: 'MCP server', slug: 'docs/channels/mcp' },
          ],
        },
        {
          label: 'Tools',
          items: [
            { label: 'Aave V3', slug: 'docs/tools/aave' },
            { label: 'Uniswap V3', slug: 'docs/tools/uniswap' },
            { label: 'Li.Fi', slug: 'docs/tools/lifi' },
            { label: 'Blockscout', slug: 'docs/tools/blockscout' },
            { label: 'AgentKit', slug: 'docs/tools/agentkit' },
            { label: 'EVM-MCP', slug: 'docs/tools/evm-mcp' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI commands', slug: 'docs/reference/cli' },
            { label: 'Environment variables', slug: 'docs/reference/env' },
            { label: 'Config files', slug: 'docs/reference/config' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'launchd / systemd', slug: 'docs/self-hosting/service' },
            { label: 'Doctor diagnostics', slug: 'docs/self-hosting/doctor' },
          ],
        },
        {
          label: 'Embedding Talos',
          items: [
            { label: 'As an MCP server', slug: 'docs/embedding/overview' },
          ],
        },
      ],
    }),
    sitemap(),
    mdx(),
  ],
});
