/**
 * ScrollHintBar
 * -------------
 * A permanent gold visual-signature bar that sits below (horizontal)
 * or beside (vertical) a related element. The gold track always
 * renders — it's part of the app's visual identity, not a transient
 * hint. The comet sweep only animates when the tracked element
 * actually overflows AND the student hasn't yet scrolled to discover
 * the off-screen content.
 *
 * Design (David's iterative spec):
 *   - Solid gold track with a layered glow (inner highlight + mid
 *     amber bloom + soft amber halo) so the bar pops on dark bg.
 *     Renders unconditionally — never hidden.
 *   - Spotlight gradient: when caller passes `spotlightAt`, the
 *     track is brightest at that fractional position [0..1] and
 *     fades toward the edges — visually ties the bar to the active
 *     tab above without needing an explicit connector.
 *   - Accent is a comet, not a shape that moves: bright leading
 *     edge with a long trailing gradient, clipped into the arrow
 *     polygon. Reads as motion. Gated on actual overflow +
 *     pre-discovery so the sweep stays meaningful, not perpetual.
 *   - Sweeps in ONE direction only — left → right for x, top →
 *     bottom for y. No bouncing.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   <div ref={ref} className="overflow-x-auto">...</div>
 *   <ScrollHintBar targetRef={ref} axis="x" spotlightAt={0.5} />
 */
import { useEffect, useRef, useState } from 'react';
import { logAppAudit } from '../../services/appAuditor';

interface ScrollHintBarProps {
  /** Ref to the scrollable element. The bar reads its
   *  scrollWidth/clientWidth (or height) to decide whether to show. */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Scroll axis to monitor. Default 'x' (horizontal tab strips). */
  axis?: 'x' | 'y';
  /** Fractional position [0..1] where the bar is brightest — used
   *  to align the lit region with the active tab above. When
   *  omitted, the whole bar is uniformly bright. */
  spotlightAt?: number;
  /** Optional extra Tailwind classes for positioning. */
  className?: string;
}

// Arrow polygons — chevron-flag shape pointing in the sweep
// direction. The accent gets clipped to this shape so the comet
// trail reads as an arrow head, not a generic shimmer.
const ARROW_CLIP_X = 'polygon(0% 25%, 70% 25%, 70% 0%, 100% 50%, 70% 100%, 70% 75%, 0% 75%)';
const ARROW_CLIP_Y = 'polygon(25% 0%, 75% 0%, 75% 70%, 100% 70%, 50% 100%, 0% 70%, 25% 70%)';

// Comet gradients — fully transparent at the tail, ramping through
// saturated gold and finishing at a near-white leading edge. The
// clip-path keeps the visible region an arrow. Brightness boosted
// per David — the comet now reads from across the room instead of
// blending into the gold track.
const COMET_GRADIENT_X =
  'linear-gradient(90deg, rgba(255, 245, 200, 0) 0%, rgba(255, 220, 120, 0.85) 50%, rgba(255, 250, 220, 1) 85%, rgba(255, 255, 255, 1) 100%)';
const COMET_GRADIENT_Y =
  'linear-gradient(180deg, rgba(255, 245, 200, 0) 0%, rgba(255, 220, 120, 0.85) 50%, rgba(255, 250, 220, 1) 85%, rgba(255, 255, 255, 1) 100%)';

// Three-layer glow: outer halo, mid bloom, inner highlight. Same
// gold, three magnitudes — the bar reads as "lit" rather than
// "drawn."
const TRACK_GLOW =
  '0 0 24px rgba(251, 191, 36, 0.35), 0 0 8px rgba(251, 191, 36, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
// Accent glow stack: outer halo + mid bloom + tight near-white inner
// edge. Larger radii than the original 18px/6px so the comet trails
// a visible glow halo, not just a clipped gradient.
const ACCENT_GLOW =
  '0 0 32px rgba(255, 230, 130, 0.9), 0 0 14px rgba(255, 240, 170, 1), 0 0 4px rgba(255, 255, 255, 1)';

/** Build a spotlight gradient: brightest gold at `at`, falling off
 *  toward the edges. Falls back to a flat gold when `at` is null. */
function buildSpotlightBg(axis: 'x' | 'y', at: number | undefined): string {
  if (at === undefined) return 'rgb(251, 191, 36)'; // amber-400 flat
  const pct = Math.round(Math.max(0, Math.min(1, at)) * 100);
  const direction = axis === 'x' ? '90deg' : '180deg';
  return `linear-gradient(${direction}, rgba(251, 191, 36, 0.55) 0%, rgba(255, 215, 80, 1) ${pct}%, rgba(251, 191, 36, 0.55) 100%)`;
}

export function ScrollHintBar({
  targetRef,
  axis = 'x',
  spotlightAt,
  className = '',
}: ScrollHintBarProps): JSX.Element {
  const [overflow, setOverflow] = useState<boolean>(false);
  // Track whether the user has scrolled to discover the off-screen
  // content; gates the comet sweep so it stops once it's done its
  // job. Does NOT hide the gold track — that's a permanent signature.
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

  const showComet = overflow && !discovered;

  // Emit one audit when the comet state flips. Diagnoses
  // "the gold bar isn't moving" / "the bar shouldn't be there" reports.
  const lastCometRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastCometRef.current === showComet) return;
    lastCometRef.current = showComet;
    void logAppAudit({
      kind: 'scroll-hint-state',
      category: 'subsystem',
      source: 'ScrollHintBar',
      summary: `comet=${showComet} overflow=${overflow} discovered=${discovered} axis=${axis}`,
    });
  }, [showComet, overflow, discovered, axis]);

  if (axis === 'x') {
    return (
      <div
        className={`relative h-1.5 rounded-full ${className}`}
        aria-hidden="true"
        data-testid="scroll-hint-x"
        data-comet={String(showComet)}
        style={{
          background: buildSpotlightBg('x', spotlightAt),
          boxShadow: TRACK_GLOW,
        }}
      >
        {showComet && (
          <div className="absolute inset-0 rounded-full overflow-hidden">
            <div
              className="absolute top-0 h-full w-32 animate-scroll-hint-x"
              style={{
                background: COMET_GRADIENT_X,
                clipPath: ARROW_CLIP_X,
                boxShadow: ACCENT_GLOW,
              }}
            />
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={`relative w-1.5 rounded-full ${className}`}
      aria-hidden="true"
      data-testid="scroll-hint-y"
      data-comet={String(showComet)}
      style={{
        background: buildSpotlightBg('y', spotlightAt),
        boxShadow: TRACK_GLOW,
      }}
    >
      {showComet && (
        <div className="absolute inset-0 rounded-full overflow-hidden">
          <div
            className="absolute left-0 w-full h-32 animate-scroll-hint-y"
            style={{
              background: COMET_GRADIENT_Y,
              clipPath: ARROW_CLIP_Y,
              boxShadow: ACCENT_GLOW,
            }}
          />
        </div>
      )}
    </div>
  );
}
