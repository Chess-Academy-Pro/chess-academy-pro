/**
 * ScrollHintBar
 * -------------
 * A solid gold indicator that sits below (horizontal) or beside
 * (vertical) a scrollable container with an arrow-shaped accent
 * that sweeps across in one direction only. Auto-detects whether
 * the tracked element actually overflows; renders nothing when
 * there's nothing to scroll. Hides itself automatically once the
 * student has scrolled to discover the off-screen content.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   <div ref={ref} className="overflow-x-auto">...</div>
 *   <ScrollHintBar targetRef={ref} axis="x" />
 *
 * Design (David's spec): solid gold bar, bright arrow accent that
 * passes ONLY rightward (or downward on the y-axis variant) — no
 * bouncing. The arrow shape comes from a clip-path polygon so the
 * accent reads as a direction cue, not a generic shimmer.
 */
import { useEffect, useRef, useState } from 'react';

interface ScrollHintBarProps {
  /** Ref to the scrollable element. The bar reads its
   *  scrollWidth/clientWidth (or height) to decide whether to show. */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Scroll axis to monitor. Default 'x' (horizontal tab strips). */
  axis?: 'x' | 'y';
  /** Optional extra Tailwind classes for positioning. */
  className?: string;
}

// Arrow polygons — drawn as a horizontal arrow head + shaft for x,
// rotated for y. The accent sits ON TOP of the gold track and is
// brighter, so it reads as a sweep, not a separate shape.
const ARROW_CLIP_X = 'polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)';
const ARROW_CLIP_Y = 'polygon(25% 0%, 75% 0%, 75% 65%, 100% 65%, 50% 100%, 0% 65%, 25% 65%)';

const ACCENT_GRADIENT_X = 'linear-gradient(90deg, rgba(255, 250, 220, 0.4), rgba(255, 250, 220, 1))';
const ACCENT_GRADIENT_Y = 'linear-gradient(180deg, rgba(255, 250, 220, 0.4), rgba(255, 250, 220, 1))';

const ACCENT_SHADOW = '0 0 10px rgba(251, 191, 36, 0.95)';

export function ScrollHintBar({
  targetRef,
  axis = 'x',
  className = '',
}: ScrollHintBarProps): JSX.Element | null {
  const [overflow, setOverflow] = useState<boolean>(false);
  // Hide once the user has scrolled past the start — they've
  // discovered the content; further hinting is noise.
  const [discovered, setDiscovered] = useState<boolean>(false);
  const initialRef = useRef<{ checked: boolean }>({ checked: false });

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    const recompute = (): void => {
      const overflowing =
        axis === 'x'
          ? el.scrollWidth > el.clientWidth + 4
          : el.scrollHeight > el.clientHeight + 4;
      setOverflow(overflowing);
      if (axis === 'x' && el.scrollLeft > 16) setDiscovered(true);
      if (axis === 'y' && el.scrollTop > 16) setDiscovered(true);
      const atEnd =
        axis === 'x'
          ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 16
          : el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
      if (atEnd && initialRef.current.checked) setDiscovered(true);
      initialRef.current.checked = true;
    };
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [targetRef, axis]);

  if (!overflow || discovered) return null;

  if (axis === 'x') {
    return (
      <div
        className={`relative h-1.5 bg-amber-400 rounded-full overflow-hidden ${className}`}
        aria-hidden="true"
        data-testid="scroll-hint-x"
      >
        <div
          className="absolute top-0 h-full w-10 animate-scroll-hint-x"
          style={{
            background: ACCENT_GRADIENT_X,
            clipPath: ARROW_CLIP_X,
            boxShadow: ACCENT_SHADOW,
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={`relative w-1.5 bg-amber-400 rounded-full overflow-hidden ${className}`}
      aria-hidden="true"
      data-testid="scroll-hint-y"
    >
      <div
        className="absolute left-0 w-full h-10 animate-scroll-hint-y"
        style={{
          background: ACCENT_GRADIENT_Y,
          clipPath: ARROW_CLIP_Y,
          boxShadow: ACCENT_SHADOW,
        }}
      />
    </div>
  );
}
