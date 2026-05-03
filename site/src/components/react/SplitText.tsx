import { createElement, useEffect, useMemo, useRef, useState } from 'react';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'p' | 'span';

interface SplitTextProps {
  text: string;
  className?: string;
  tag?: HeadingTag;
  delay?: number;
  duration?: number;
  splitBy?: 'word' | 'char';
  threshold?: number;
}

export default function SplitText({
  text,
  className,
  tag = 'h2',
  delay = 40,
  duration = 700,
  splitBy = 'word',
  threshold = 0.3,
}: SplitTextProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  const segments = useMemo(() => {
    if (splitBy === 'char') return Array.from(text);
    return text.split(/(\s+)/);
  }, [text, splitBy]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setRevealed(true);
      return;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            obs.disconnect();
          }
        }
      },
      { threshold },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [threshold]);

  const children = segments.map((seg, i) =>
    /^\s+$/.test(seg)
      ? createElement('span', { key: i, 'aria-hidden': 'true' }, seg)
      : createElement(
          'span',
          {
            key: i,
            'aria-hidden': 'true',
            style: {
              display: 'inline-block',
              opacity: revealed ? 1 : 0,
              transform: revealed ? 'translateY(0)' : 'translateY(0.55em)',
              transition: `opacity ${duration}ms cubic-bezier(0.2, 0.8, 0.2, 1) ${i * delay}ms, transform ${duration}ms cubic-bezier(0.2, 0.8, 0.2, 1) ${i * delay}ms`,
              willChange: 'opacity, transform',
            },
          },
          seg,
        ),
  );

  return createElement(
    tag,
    { ref, className, 'aria-label': text },
    ...children,
  );
}
