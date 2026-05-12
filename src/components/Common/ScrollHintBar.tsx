/**
 * ScrollHintBar
 * -------------
 * A thin amber indicator that sits below (horizontal) or beside
 * (vertical) a scrollable container. Auto-detects whether the
 * tracked element actually overflows; renders nothing when there's
 * nothing to scroll. When overflow exists, an animated accent
 * slides along the bar to hint that the student can scroll.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   <div ref={ref} className="overflow-x-auto">...</div>
 *   <ScrollHintBar targetRef={ref} axis="x" />
 *
 * The component is dumb-by-design: pass a ref to the scrollable
 * element + the axis you care about, get a hint bar. Hides itself
 * automatically when the user has scrolled all the way to the end
 * (so it stops nagging after the student has discovered the
 * content).
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

export function ScrollHintBar({
  targetRef,
  axis = 'x',
  className = '',
}: ScrollHintBarProps): JSX.Element | null {
  const [overflow, setOverflow] = useState<boolean>(false);
  // Hide once the user has scrolled within `tolerance` of the end —
  // they've discovered the content; further hinting is noise.
  const [discovered, setDiscovered] = useState<boolean>(false);
  // Detect coarse pointer (touch). On touch devices the user can
  // swipe directly on the strip itself; on mouse/trackpad, the
  // wider hint helps because the scrollbars are typically hidden.
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
      // Mark discovered when the user scrolls to (within ~16px of)
      // the end of the axis in either direction.
      const atEnd =
        axis === 'x'
          ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 16 ||
            el.scrollLeft <= 16 && !initialRef.current.checked
          : el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
      if (axis === 'x' && el.scrollLeft > 16) setDiscovered(true);
      if (axis === 'y' && el.scrollTop > 16) setDiscovered(true);
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
        className={`relative h-0.5 bg-amber-500/20 rounded-full overflow-hidden ${className}`}
        aria-hidden="true"
        data-testid="scroll-hint-x"
      >
        <div
          className="absolute top-0 h-0.5 w-10 bg-amber-400 rounded-full animate-scroll-hint-x"
          style={{ boxShadow: '0 0 6px rgba(251, 191, 36, 0.7)' }}
        />
      </div>
    );
  }
  return (
    <div
      className={`relative w-0.5 bg-amber-500/20 rounded-full overflow-hidden ${className}`}
      aria-hidden="true"
      data-testid="scroll-hint-y"
    >
      <div
        className="absolute left-0 w-0.5 h-10 bg-amber-400 rounded-full animate-scroll-hint-y"
        style={{ boxShadow: '0 0 6px rgba(251, 191, 36, 0.7)' }}
      />
    </div>
  );
}
