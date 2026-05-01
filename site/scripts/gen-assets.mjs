import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = resolve(ROOT, 'src/assets/logo.png');
const PUB = resolve(ROOT, 'public');

await mkdir(PUB, { recursive: true });

const sizes = [
  { name: 'favicon-16.png', size: 16 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-192.png', size: 192 },
  { name: 'favicon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

for (const { name, size } of sizes) {
  await sharp(SRC).resize(size, size, { fit: 'cover' }).png().toFile(resolve(PUB, name));
  console.log(`favicon ${name} (${size}x${size})`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="g" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#d4925a"/>
      <stop offset="1" stop-color="#7a4f24"/>
    </radialGradient>
  </defs>
  <rect width="32" height="32" rx="6" fill="#0a0a0c"/>
  <circle cx="16" cy="16" r="11" fill="url(#g)"/>
  <path d="M16 6.5 L21.5 16 L16 19 L10.5 16 Z" fill="#0a0a0c" opacity="0.85"/>
  <path d="M16 19.8 L21.3 16.7 L16 24 L10.7 16.7 Z" fill="#0a0a0c" opacity="0.85"/>
</svg>`;
await writeFile(resolve(PUB, 'favicon.svg'), svg);
console.log('favicon.svg');

const W = 1200, H = 630;
const logoSize = 480;

const logoBuf = await sharp(SRC)
  .resize(logoSize, logoSize, { fit: 'cover' })
  .toBuffer();

const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="halo" cx="0.28" cy="0.5" r="0.42">
      <stop offset="0" stop-color="#b87333" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#0a0a0c" stop-opacity="0"/>
    </radialGradient>
    <style><![CDATA[
      .h { font: 700 78px Inter, system-ui, sans-serif; fill: #f4f1ea; letter-spacing: -2px; }
      .s { font: 500 32px Inter, system-ui, sans-serif; fill: #c9c4ba; letter-spacing: -0.4px; }
      .pill { font: 600 20px 'JetBrains Mono', ui-monospace, monospace; fill: #d4925a; letter-spacing: 1px; }
    ]]></style>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <text class="pill" x="560" y="190">A SELF-HOSTED ETHEREUM AGENT</text>
  <text class="h" x="560" y="290">Talos</text>
  <text class="s" x="560" y="358">Daemon plus thin clients.</text>
  <text class="s" x="560" y="402">Curated DeFi tools.</text>
  <text class="s" x="560" y="446">Daily-fresh ecosystem knowledge.</text>
  <line x1="560" y1="490" x2="700" y2="490" stroke="#b87333" stroke-width="2"/>
  <text class="pill" x="560" y="528">npx talos init</text>
</svg>`;

await sharp({
  create: { width: W, height: H, channels: 3, background: { r: 10, g: 10, b: 12 } },
})
  .composite([
    { input: Buffer.from(textSvg), top: 0, left: 0 },
    { input: logoBuf, top: Math.round((H - logoSize) / 2), left: 60 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(resolve(PUB, 'og.png'));
console.log('og.png (1200x630)');
