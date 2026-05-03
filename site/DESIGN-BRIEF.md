---
name: Talos landing page modernization
description: Reactbits-driven polish on top of the existing bronze automaton hero — ambient atmosphere, scroll reveals, and surgical micro-interactions while preserving locked hero art and copy
type: design-brief
created: 2026-05-04
---

# Design Brief — Talos landing modernization

## Product Summary

Talos is a self-hosted vertical Ethereum agent for ETHGlobal Open Agents. The visual identity is bronze automaton on warm-dark canvas — closer to a hand-forged tool than a SaaS dashboard. The current landing page is structurally sound (good hero art, clean type, tight copy) but visually static: it reads as a Starlight docs page with a hero image bolted on, not as a product launch. The goal is to add atmosphere and motion that earn the bronze mythology without breaking the dignified, tool-first tone. No purple gradients, no "AI shimmer", no kitchen-sink animation stack.

## Constraints (hard)

- Hero composition (logo image + headline + lead + CTA + meta line) is **locked**. Effects go *behind* and *around* it, not on top of the headline or in place of the image.
- Stack is Astro 5 + Starlight, pure CSS, no Tailwind. Reactbits components are React — anything chosen must justify adding `@astrojs/react` as an integration, lazy-mounted via `client:visible` or `client:idle`.
- Brand tokens already defined in `src/styles/theme.css`. Anything new must consume `--tlx-bronze`, `--tlx-bronze-bright`, `--tlx-bronze-deep`, `--tlx-eth-blue`, `--tlx-bg`, `--tlx-surface`, `--tlx-fg-*`. No new colors.
- Performance ceiling: ETH Open Agents judges land here on first paint. One ambient WebGL effect maximum, gated to the hero, lazy-mounted. Below-the-fold animations must be pure CSS or `motion` (framer-motion) at most — no second WebGL canvas.
- No emoji. No purple/teal/neon. No Tailwind classes (existing `tlx-*` CSS pattern only).

---

## Reactbits longlist (researched, then narrowed)

These are the candidates I evaluated against the bronze/dark dev-tool brief. Each is sourced from the `ts-tailwind` flavor of `DavidHDev/react-bits` (the React 19 + TypeScript variant — closest to what an Astro island should hydrate).

| # | Component | URL | Stack | Fit | Verdict |
|---|---|---|---|---|---|
| 1 | **Aurora** (background) | https://www.reactbits.dev/backgrounds/aurora | OGL/WebGL, GLSL simplex noise, `colorStops: string[]` prop | Soft horizon glow that maps perfectly to the dusk skybox already in the hero illustration. Three-stop bronze gradient keeps it on-brand. Transparent canvas, additive blend mode. | **PICK** — hero ambient |
| 2 | **DotGrid** (background) | https://www.reactbits.dev/backgrounds/dot-grid | Canvas 2D + GSAP InertiaPlugin, **no WebGL**, `baseColor`, `activeColor`, `proximity` props | Subtle dotted texture for section backgrounds — reads as engineering grid paper, dignified, plays well with mouse-near-dot ripple. Non-WebGL means cheap. | **PICK** — section atmosphere |
| 3 | **SplitText** | https://www.reactbits.dev/text-animations/split-text | GSAP + ScrollTrigger, `splitType: chars/words/lines`, configurable easing | Per-line reveal on H2s and section titles. Triggered on scroll. `power3.out` easing matches the bronze "weight" feeling. | **PICK** — section title reveal |
| 4 | **SpotlightCard** | https://www.reactbits.dev/components/spotlight-card | Pure CSS + radial gradient, `spotlightColor` RGBA prop | Mouse-following bronze radial highlight on the 3-up tile cards. Cheap (no canvas), a clear "this card is alive" moment. | **PICK** — replaces existing `.tlx-card:hover` |
| 5 | Beams | https://www.reactbits.dev/backgrounds/beams | Three.js + R3F + Drei | Heavier than Aurora (full three.js, not OGL). Aurora gives the same "shaft of light" mood without dragging in three.js. | **REJECT** — Aurora wins |
| 6 | Threads | https://www.reactbits.dev/backgrounds/threads | OGL, `color: [r,g,b]` tuple, perlin noise | Ribbon/wave pattern. Beautiful but reads "creative agency", not "self-hosted dev tool". Wrong tone. | REJECT — vibe mismatch |
| 7 | LightRays | https://www.reactbits.dev/backgrounds/light-rays | OGL, `raysColor`, `raysOrigin: top-center/corners/edges`, `pulsating` | Crepuscular rays from corner. Visually striking but competes with the automaton sword line in the illustration. | REJECT — fights hero art |
| 8 | Particles | https://www.reactbits.dev/backgrounds/particles | OGL, `particleColors[]`, `particleCount: 200` | Generic "tech" feel. Used everywhere. Bronze particles would just look like floating sparks. Doesn't earn its perf cost. | REJECT — too generic |
| 9 | ShinyText | https://www.reactbits.dev/text-animations/shiny-text | Framer Motion, `color`, `shineColor`, `speed` props | Considered for "424 tests passing" pill but it screams loyalty-card-app. Plain pulsing dot is more dignified. | REJECT — tonal mismatch |
| 10 | BlurText | https://www.reactbits.dev/text-animations/blur-text | Framer Motion + IntersectionObserver, `animateBy: words/letters` | Alternative to SplitText. Smoother but less character. SplitText has the per-line "type into existence" feel that suits a dev tool. | REJECT — SplitText wins |
| 11 | CountUp | https://www.reactbits.dev/text-animations/count-up | Framer Motion `useSpring`, viewport-triggered | If a stats strip is added later (TVL routed, txs audited), this is the right pick. Not needed for v1. | DEFER — phase 2 |
| 12 | Magnet | https://www.reactbits.dev/animations/magnet | CSS transforms + window mousemove | Cute but the primary CTA is a `CopyCodeBlock` and a docs link. Magnetism on those would feel gimmicky. | REJECT — wrong context |
| 13 | ClickSpark | https://www.reactbits.dev/animations/click-spark | Canvas 2D, `sparkColor`, `sparkCount`, `duration` | Click-feedback particles. Could fire on copy-command success. Feels too playful for a tool that audits chain mutations. | REJECT — tone |

**Key finding:** Aurora and DotGrid handle 100% of the "atmosphere" demand. Everything else is text reveal (SplitText) or card hover (SpotlightCard). Four picks total — well under the perf ceiling.

---

## Final shortlist (the 4 we ship)

### 1. Aurora — hero ambient background

**Where it goes:** Behind the entire `.tlx-hero` section, sitting underneath the existing `.tlx-halo` radial. The current halo stays as a top-right warm wash; Aurora adds a slow horizontal aurora ribbon along the bottom third of the hero, evoking the dusk horizon already painted into the logo image.

**Integration strategy:** React island. Justified because Aurora is shader-based (OGL + custom GLSL) — there's no clean vanilla-canvas port that wouldn't be a worse copy of the original. Mount with `client:visible` so it only hydrates when the hero scrolls into view (which on first paint *is* immediate, but the hydration blocks page interactivity less than `client:load`).

**Configuration:**
```ts
<Aurora
  colorStops={['#7a4f24', '#b87333', '#d4925a']} // bronze-deep -> bronze -> bronze-bright
  amplitude={0.8}     // low — it's ambient, not foreground
  blend={0.6}
  speed={0.4}         // slow drift; faster reads as lava lamp
/>
```

**File changes:**
- `package.json`: add `@astrojs/react`, `react`, `react-dom`, `ogl`
- `astro.config.mjs`: add `react()` to integrations (BEFORE starlight to avoid ordering edge cases)
- `tsconfig.json`: add JSX config
- New: `src/components/react/Aurora.tsx` — vendored from reactbits ts-tailwind, with the `cn()` utility removed (we don't have Tailwind) and the wrapper changed from a Tailwind class to a plain `style={{ width: '100%', height: '100%' }}` div
- `src/pages/index.astro`: import as React island, drop into `.tlx-hero` as a sibling of `.tlx-halo`. Position absolute, full-bleed, `pointer-events: none`, `z-index: 0`. Hero content keeps `z-index: 1`.

**Expected visual outcome:** A slow, low-amplitude bronze ribbon shimmers along the bottom of the hero section. The automaton image, headline, and CTA sit cleanly above it. On a 1440p screen the ribbon is roughly 30% of the hero height. Mobile gets a dimmed version (`opacity: 0.6` via media query) to cut GPU draw cost.

**Perf cost:** ~80 KB gzipped (`ogl` ~50 KB + Aurora component ~5 KB + React + ReactDOM ~25 KB). One canvas, one shader pass, ~1 ms/frame on integrated graphics. With `client:visible` the page is interactive before Aurora hydrates.

**Mobile gate:** Below 720 px, render at `pixelRatio = 1` (Aurora has internal DPR handling) and reduce `speed` to 0.2. If `prefers-reduced-motion: reduce`, render a static gradient PNG fallback instead of mounting the canvas. This is enforced at the Astro template level — wrap the import in `{!isReducedMotion && ...}` won't work server-side, so use a CSS-controlled wrapper with a `@media (prefers-reduced-motion)` rule that sets the canvas to `display: none` and shows a `.tlx-aurora-fallback` div with a static linear-gradient.

---

### 2. DotGrid — section atmosphere (KeeperHub stripe + behind 3-up tiles)

**Where it goes:** As an absolute-positioned background inside two specific sections:
- The KeeperHub sponsor stripe (`#keeperhub`) — replaces the flat surface with subtle moving texture during scroll-into-view
- Optionally behind the 3-up tile section (the one with "Vertical, not general", etc.) — gentle dotted backdrop with mouse-near-dot reaction

**Integration strategy:** React island (`client:visible`). DotGrid is canvas 2D + GSAP — no WebGL, but it's still a 200+ line component with InertiaPlugin physics that doesn't port cleanly to vanilla. React island is the right choice. GSAP InertiaPlugin is **not free** (requires Club GreenSock Premium) — verify before installing or fall back to dropping the inertia and using vanilla `requestAnimationFrame`. **Open question for Allen** flagged below.

**Configuration:**
```ts
<DotGrid
  dotSize={2}
  gap={28}
  baseColor="#25252f"      // --tlx-border, near-invisible at rest
  activeColor="#b87333"    // --tlx-bronze, lights up near cursor
  proximity={120}
  shockRadius={180}
  shockStrength={3}
  resistance={750}
  returnDuration={1.5}
/>
```

**File changes:**
- `package.json`: add `gsap` (and `@gsap/inertia` if licensed; otherwise patch component to remove)
- New: `src/components/react/DotGrid.tsx` — vendored, Tailwind classes replaced with inline styles
- `src/pages/index.astro`: drop a `<DotGrid client:visible />` inside the KeeperHub stripe wrapper

**Expected visual outcome:** A grid of nearly-invisible bronze-dark dots (gap 28 px). Cursor proximity lights nearby dots up to bright bronze with a subtle ripple. Click sends a soft shockwave outward. Reads as "engineering grid paper" — dignified, on-brand, rewards interaction without demanding it.

**Perf cost:** Canvas 2D, no WebGL. ~5 ms/frame at 1440p with mouse moving (throttled to 50 ms). Idle cost: near zero (animation pauses when no input). GSAP core is ~30 KB gzipped.

**Mobile gate:** Disable `proximity` interaction below 720 px (no hover on touch); render the static dot grid only. `prefers-reduced-motion` collapses the shockwave duration to 0.

---

### 3. SplitText — section H2 reveal

**Where it goes:** All four `<h2 class="tlx-section-title">` headings:
- "Drop Talos into your assistant."
- "Daemon plus thin clients."
- "Six sources, one tool surface."
- "One brain. Three faces."

Hero `<h1>` is **excluded** — it's the locked headline and we don't animate it. Same for the eyebrows above each H2 (they're already small, motion would be noise).

**Integration strategy:** React island (`client:visible`). GSAP ScrollTrigger needs DOM mounting; can't be SSR'd. Bundle reuses GSAP from DotGrid so no incremental cost.

**Configuration:**
```ts
<SplitText
  text="Daemon plus thin clients."
  splitType="words"
  from={{ opacity: 0, y: 24 }}
  to={{ opacity: 1, y: 0 }}
  duration={0.7}
  delay={40}                    // stagger between words, ms
  ease="power3.out"
  tag="h2"
  className="tlx-section-title"
/>
```

**File changes:**
- New: `src/components/react/SplitText.tsx` — vendored, exports a typed component
- For each section in `index.astro`, replace `<h2 class="tlx-section-title">...</h2>` with `<SplitText client:visible text="..." tag="h2" className="tlx-section-title" />`

**Expected visual outcome:** As each section scrolls into view, the H2 reveals word-by-word with a 24 px upward slide and fade. Total reveal duration ~0.9 s per heading. Feels like the heading is being "set in type" — fits the dev-tool craft tone.

**Perf cost:** No incremental bundle (GSAP shared with DotGrid). Per-heading: ~1 KB DOM cost at most.

**Reduced-motion fallback:** SplitText respects `prefers-reduced-motion` natively via GSAP's `gsap.config({ reducedMotion: 'reduce' })` — set this at module init. Or trivially: `from={{ opacity: 1, y: 0 }}` collapses the animation.

---

### 4. SpotlightCard — replace the hover state on 3-up tiles

**Where it goes:** The three `.tlx-card` elements in the 3-up tiles section ("Vertical, not general", "Three-tier memory", "Audit-by-default"). Optionally also the 6 cards in `<ToolGrid />` if it reads well.

**Integration strategy:** This one we **port to vanilla CSS**, no React. The reactbits SpotlightCard is just a radial-gradient overlay that follows the mouse — that's a 20-line CSS + tiny JS port. Not worth mounting React for it.

**Configuration (CSS port):**
```css
.tlx-card {
  position: relative;
  overflow: hidden; /* required so the spotlight clips to card bounds */
}
.tlx-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    600px circle at var(--mx, 50%) var(--my, 50%),
    rgba(184, 115, 51, 0.12),
    transparent 40%
  );
  opacity: 0;
  transition: opacity 240ms ease;
  pointer-events: none;
}
.tlx-card:hover::before { opacity: 1; }
```

```js
// Vanilla, ~10 lines, no framework
document.querySelectorAll('.tlx-card').forEach((card) => {
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
});
```

**File changes:**
- `src/styles/theme.css`: add the `::before` rules to `.tlx-card`
- `src/pages/index.astro`: add a tiny inline `<script>` at the bottom (or a deferred external) to wire up mousemove

**Expected visual outcome:** Hovering a card produces a bronze radial glow that follows the cursor inside the card. The existing border-color hover becomes the secondary signal; the spotlight is the primary one. Cards now read as interactive even before the user moves.

**Perf cost:** Zero incremental JS bundle. CSS-only with passive mousemove listeners. Negligible.

**Reduced-motion fallback:** Wrap the `::before` rules in `@media (prefers-reduced-motion: no-preference)` — fully removed when the user opts out.

---

## Non-reactbits polish (5 items)

These are surgical, on-brand, and don't depend on reactbits at all. They go in *after* the four picks above are stable.

### 5. Hero meta line: "424 tests passing" becomes a live-feeling micro-component

Current: static green dot + static text.
New: the green dot pulses (CSS-only), and a tiny mono-font caret blinks after the count. No CountUp, no fake metric ticker — just a small animation cue that signals "this is a real, running thing."

**Implementation:** add a `@keyframes tlx-pulse` to `theme.css`:
```css
@keyframes tlx-pulse {
  0%, 100% { box-shadow: 0 0 8px rgba(93,155,106,0.55); }
  50%      { box-shadow: 0 0 14px rgba(93,155,106,0.85); }
}
.tlx-dot--ok { animation: tlx-pulse 2.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .tlx-dot--ok { animation: none; } }
```

### 6. Sticky-nav refinement on scroll

Current: nav is sticky with `backdrop-filter: blur(10px)` always-on.
New: at scroll-top, nav has zero background and zero border (lets the hero breathe). Once the user scrolls past the hero, the blurred dark background and bronze hairline border fade in.

**Implementation:** add a single `IntersectionObserver` watching the hero section, toggle a `.is-scrolled` class on `.tlx-topnav`. Two-line CSS variation between states. ~15 lines of JS.

### 7. Section rhythm tightening

Current: `padding: 5rem 0` between sections, plus a `border-top` hairline. Reads slightly forum-thread on long scroll.
New: alternate between rest sections (5 rem) and "weight" sections (7 rem above architecture, KeeperHub stripe). Promote the architecture section's `LayerCake` and the KeeperHub stripe with extra breathing room. Drop the `border-top` between sections that share a backdrop (DotGrid'd ones), keep it between unstyled ones.

**Implementation:** add `.tlx-section--weight { padding: 7rem 0; }` and `.tlx-section--seamless + .tlx-section--seamless { border-top: none; }`. Apply selectively in `index.astro`.

### 8. Eyebrow-to-headline micro-animation

Current: eyebrows (`.tlx-eyebrow`) are static spans above each section title.
New: when their parent section enters the viewport, the eyebrow's character-spacing tightens from `0.24em` to `0.18em` over 600 ms, like the type is settling into place. CSS-only with `IntersectionObserver` toggling a class. Pairs well with SplitText reveal of the H2 below it — eyebrow settles, then H2 types in.

**Implementation:**
```css
.tlx-eyebrow { letter-spacing: 0.24em; transition: letter-spacing 600ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.tlx-section.is-visible .tlx-eyebrow { letter-spacing: 0.18em; }
@media (prefers-reduced-motion: reduce) { .tlx-eyebrow { letter-spacing: 0.18em; transition: none; } }
```

### 9. Hero halo refinement

Current: `.tlx-halo` is a single radial-gradient blob in the top-right.
New: keep it, but add a second radial — bottom-left, slightly smaller, blue-tinted (`--tlx-eth-blue` at 8% opacity). Two-tone halo grounds the bronze-vs-Ethereum dual identity (the mythology + the chain). Static, no animation, no perf cost.

**Implementation:** one extra `::after` pseudo-element on `.tlx-hero`. ~6 lines.

---

## What I'm NOT touching (guardrails)

These are off-limits during implementation. If a future change benefits any of them, escalate first; don't stealth-edit.

- **Hero `<h1>`** — "The bronze automaton for your wallet." stays as a plain `<h1>`. No SplitText, no shimmer, no per-letter reveal. The headline's gravitas comes from being still while the world animates around it.
- **Hero illustration** (`/site/src/assets/logo.png`) — no overlays, no colorize filters, no parallax tilt. The image is the product mascot; it is not a styling surface.
- **Hero copy** — every paragraph, button label, and meta tag stays verbatim. No regenerated marketing strings.
- **`CopyCodeBlock` component** — already does its job (terminal-prompt mono with copy affordance). No reactbits replacement.
- **Color palette** — bronze + Ethereum blue + warm-dark only. If a reactbits component's default looks like glassmorphism teal or violet shimmer, reskin it via tokens before mounting.
- **Tailwind** — not introduced. Reactbits ts-tailwind components are ported by stripping Tailwind classes and replacing with inline styles or `tlx-*` classes.
- **Tools/Architecture diagrams** (`LayerCake.astro`, `ToolGrid.astro`) — content-correctness matters more than animation here. Apply SpotlightCard hover at most; don't restructure.
- **Sticky nav links / footer copy** — locked.
- **Light mode** — none. The brand is dark-only; `data-theme` is hard-pinned.

---

## Implementation order (when approved)

1. Add `@astrojs/react` integration + verify hello-world React island works in the existing build pipeline. **Must not break Starlight docs pages** — verify `/docs/get-started/overview` still renders.
2. Vendor SplitText + SpotlightCard (the smaller two), wire them up. These are reversible if anything goes sideways.
3. Vendor DotGrid (KeeperHub stripe first, then evaluate behind 3-up tiles). Decide on GSAP InertiaPlugin licensing — see open question below.
4. Vendor Aurora last (highest perf cost). Verify mobile gating and reduced-motion fallback work before merging.
5. Add the 5 non-reactbits polish items in any order.
6. Walkthrough at all four breakpoints (375 / 768 / 1024 / 1440 px). Lighthouse perf budget: hero LCP < 2.0 s, CLS < 0.05.

---

## Open questions for Allen

1. **GSAP InertiaPlugin** — DotGrid's elastic shock animation depends on GSAP's premium InertiaPlugin (Club GreenSock subscription). Do you want to (a) buy the license, (b) drop the inertia and use a vanilla bezier ease, or (c) skip DotGrid entirely and rely on Aurora alone for atmosphere?
2. **DotGrid scope** — KeeperHub stripe only, or also behind the 3-up tile section? The latter doubles the visual interest but stacks two dotted-grid backdrops on the same scroll. Recommend KeeperHub-only for v1.
3. **SpotlightCard on `<ToolGrid />`** — apply spotlight hover to the 6 tool cards too, or keep it limited to the 3-up tiles for a hierarchy difference? Recommend cascading to ToolGrid since they share `.tlx-card` already.
4. **Mobile Aurora behavior** — keep at 60% opacity (still animated), drop to a static PNG fallback, or remove entirely below 720 px? The `prefers-reduced-motion` fallback is already a static PNG, so the same asset can serve double duty.
5. **Animation taste-check** — does "section H2 reveals word-by-word on scroll" (SplitText) feel right for a self-hosted dev tool, or is even that too much motion? A more conservative alternative is a single-pass fade-in (BlurText) on H2s only, or skip section-title animation entirely and rely on Aurora + DotGrid for motion.
