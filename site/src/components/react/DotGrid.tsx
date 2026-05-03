import { useEffect, useRef } from 'react';

interface DotGridProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  shockRadius?: number;
  shockStrength?: number;
  returnDuration?: number;
}

interface Dot {
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const hexToRgb = (hex: string): [number, number, number] => {
  const m = hex.replace('#', '').match(/.{1,2}/g);
  if (!m || m.length < 3) return [255, 255, 255];
  return [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)];
};

const lerpColor = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): string => {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
};

export default function DotGrid({
  dotSize = 2,
  gap = 28,
  baseColor = '#25252f',
  activeColor = '#b87333',
  proximity = 120,
  shockRadius = 180,
  shockStrength = 4,
  returnDuration = 1200,
}: DotGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let dots: Dot[] = [];
    const baseRgb = hexToRgb(baseColor);
    const activeRgb = hexToRgb(activeColor);

    const buildGrid = () => {
      w = container.offsetWidth;
      h = container.offsetHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.scale(dpr, dpr);

      const cols = Math.floor(w / gap) + 1;
      const rows = Math.floor(h / gap) + 1;
      const offsetX = (w - (cols - 1) * gap) / 2;
      const offsetY = (h - (rows - 1) * gap) / 2;
      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = offsetX + c * gap;
          const y = offsetY + r * gap;
          dots.push({ x, y, ox: x, oy: y, vx: 0, vy: 0 });
        }
      }
    };

    buildGrid();

    const ro = new ResizeObserver(() => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      buildGrid();
    });
    ro.observe(container);

    let mouseX = -9999;
    let mouseY = -9999;

    const onMove = (e: MouseEvent) => {
      const r = container.getBoundingClientRect();
      mouseX = e.clientX - r.left;
      mouseY = e.clientY - r.top;
    };
    const onLeave = () => {
      mouseX = -9999;
      mouseY = -9999;
    };
    const onClick = (e: MouseEvent) => {
      if (reduced) return;
      const r = container.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      for (const dot of dots) {
        const dx = dot.ox - cx;
        const dy = dot.oy - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < shockRadius) {
          const falloff = 1 - dist / shockRadius;
          const force = falloff * shockStrength;
          dot.vx += (dx / Math.max(dist, 0.0001)) * force;
          dot.vy += (dy / Math.max(dist, 0.0001)) * force;
        }
      }
    };

    if (!isTouch) {
      container.addEventListener('mousemove', onMove, { passive: true });
      container.addEventListener('mouseleave', onLeave);
      container.addEventListener('click', onClick);
    }

    let frameId = 0;
    let last = performance.now();
    const damping = Math.exp(-1000 / returnDuration);

    const render = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      ctx.clearRect(0, 0, w, h);

      for (const dot of dots) {
        // spring back to origin
        const dx = dot.ox - dot.x;
        const dy = dot.oy - dot.y;
        dot.vx = dot.vx * damping + dx * 12 * dt;
        dot.vy = dot.vy * damping + dy * 12 * dt;
        dot.x += dot.vx * dt * 60;
        dot.y += dot.vy * dt * 60;

        let intensity = 0;
        if (!isTouch && mouseX > -1000) {
          const px = dot.x - mouseX;
          const py = dot.y - mouseY;
          const d = Math.sqrt(px * px + py * py);
          if (d < proximity) {
            intensity = easeOutCubic(1 - d / proximity);
          }
        }

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dotSize, 0, Math.PI * 2);
        ctx.fillStyle = lerpColor(baseRgb, activeRgb, intensity);
        ctx.fill();
      }

      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      ro.disconnect();
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
      container.removeEventListener('click', onClick);
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }, [
    dotSize,
    gap,
    baseColor,
    activeColor,
    proximity,
    shockRadius,
    shockStrength,
    returnDuration,
  ]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',
      }}
      aria-hidden="true"
    />
  );
}
