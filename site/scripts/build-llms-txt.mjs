/* Build llms.txt — flat manifest of every doc page for LLM crawlers.
   Spec: https://llmstxt.org */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTENT = resolve(ROOT, 'src/content/docs');
const DIST = resolve(ROOT, 'dist');

const SITE = 'https://talos.allensaji.dev';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(md|mdx)$/.test(entry.name)) yield full;
  }
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (k && v) out[k] = v;
  }
  return out;
}

function slugFromPath(p) {
  const rel = relative(CONTENT, p).replace(/\.(md|mdx)$/, '');
  if (rel === 'index') return '';
  return rel.replace(/\/index$/, '').replace(/\\/g, '/');
}

const sectionLabels = {
  '': 'Top level',
  docs: 'Docs',
  'docs/get-started': 'Get started',
  'docs/architecture': 'Architecture',
  'docs/channels': 'Channels',
  'docs/tools': 'Tools',
  'docs/reference': 'Reference',
  'docs/self-hosting': 'Self-hosting',
  'docs/embedding': 'Embedding Talos',
};

const sectionOrder = [
  'docs/get-started',
  'docs/architecture',
  'docs/channels',
  'docs/tools',
  'docs/reference',
  'docs/self-hosting',
  'docs/embedding',
  'docs',
  '',
];

const pages = [];
for await (const file of walk(CONTENT)) {
  const text = await readFile(file, 'utf8');
  const fm = frontmatter(text);
  const slug = slugFromPath(file);
  const url = slug ? `${SITE}/${slug}` : SITE + '/';
  pages.push({ slug, url, title: fm.title ?? slug, description: fm.description ?? '' });
}

const grouped = new Map();
for (const p of pages) {
  const dir = p.slug.split('/').slice(0, -1).join('/');
  const section = dir;
  if (!grouped.has(section)) grouped.set(section, []);
  grouped.get(section).push(p);
}

const lines = [];
lines.push('# Talos');
lines.push('');
lines.push('> A self-hosted, vertical Ethereum agent. Daemon plus thin clients. Curated DeFi tools. Daily-fresh ecosystem knowledge. Bring your own keys.');
lines.push('');
lines.push('Talos is an open-source agent for working with Ethereum. It runs locally as `talosd`, exposes thin clients (CLI REPL, Telegram bot, MCP server), and routes every chain-mutating tool call through KeeperHub for an auditable trail. Read-only calls bypass the audit hop.');
lines.push('');
lines.push('Install: `npx talos init`');
lines.push('Repo: https://github.com/Allen-Saji/talos');
lines.push('License: MIT');
lines.push('');

for (const section of sectionOrder) {
  const items = grouped.get(section);
  if (!items?.length) continue;
  const label = sectionLabels[section] ?? section;
  lines.push(`## ${label}`);
  lines.push('');
  for (const p of items.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const desc = p.description ? `: ${p.description}` : '';
    lines.push(`- [${p.title}](${p.url})${desc}`);
  }
  lines.push('');
}

await mkdir(DIST, { recursive: true });
await writeFile(resolve(DIST, 'llms.txt'), lines.join('\n'));
console.log(`llms.txt written (${pages.length} pages)`);
