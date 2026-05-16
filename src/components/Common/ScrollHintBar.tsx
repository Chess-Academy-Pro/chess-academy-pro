/**
 * ScrollHintBar
 * -------------
 * A permanent gold visual-signature bar that sits below (horizontal)
 * or beside (vertical) a related element. The gold track always
 * renders — it's part of the app's visual identity, not a transient
 * hint. A soft gold-white shine sweeps continuously across the bar
 * so the surface always reads as alive.
 *
 * Design (David's iterative spec):
 *   - Solid gold track with a layered glow (inner highlight + mid
 *     amber bloom + soft amber halo) so the bar pops on dark bg.
 *     Renders unconditionally — never hidden.
 *   - Spotlight gradient: when caller passes `spotlightAt`, the
 *     track is brightest at that fractional position [0..1] and
 *     fades toward the edges — visually ties the bar to the active
 *     tab above without needing an explicit connector.
 *   - Shine: a soft, wide gold-white glint slides across the bar
 *     left → right (or top → bottom) on a continuous loop. No
 *     arrow shape — the shine is the motion. Always animates.
 *   - Sweeps in ONE direction only — left → right for x, top →
 *     bottom for y. No bouncing.
 *
 * `data-comet` continues to reflect the old overflow+pre-discovery
 * semantics for diagnostic logging — the visual is decoupled.
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

// Shine gradients — all-gold, no white. The eye reads "this region
// of the bar is brighter" rather than "a white object is moving over
// the bar" because the moving overlay never breaks the gold colour
// envelope. Peak alpha (~0.55) at ~90% of element width gives a soft
// brightness lean toward the leading edge; both extremes fade to
// fully transparent so there's no hard rectangle boundary.
//
// Composite math: at peak alpha 0.55 over the amber-400 track
// (251, 191, 36):
//   R: 251 * 0.45 + 255 * 0.55 = ~253
//   G: 191 * 0.45 + 235 * 0.55 = ~215
//   B: 36  * 0.45 + 120 * 0.55 = ~82
// Result ≈ (253, 215, 82) — a brighter, slightly creamier gold. Still
// firmly in the gold spectrum; not a white tracer.
const SHINE_GRADIENT_X =
  'linear-gradient(90deg, rgba(255, 220, 100, 0) 0%, rgba(255, 225, 120, 0.18) 45%, rgba(255, 235, 150, 0.38) 75%, rgba(255, 240, 170, 0.55) 90%, rgba(255, 220, 100, 0) 100%)';
const SHINE_GRADIENT_Y =
  'linear-gradient(180deg, rgba(255, 220, 100, 0) 0%, rgba(255, 225, 120, 0.18) 45%, rgba(255, 235, 150, 0.38) 75%, rgba(255, 240, 170, 0.55) 90%, rgba(255, 220, 100, 0) 100%)';

// Three-layer glow: outer halo, mid bloom, inner highlight. Same
// gold, three magnitudes — the bar reads as "lit" rather than
// "drawn."
const TRACK_GLOW =
  '0 0 24px rgba(251, 191, 36, 0.35), 0 0 8px rgba(251, 191, 36, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.4)';

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
        <div className="absolute inset-0 rounded-full overflow-hidden">
          <div
            className="absolute top-0 h-full w-1/2 animate-scroll-hint-x"
            data-testid="scroll-hint-shine"
            style={{ background: SHINE_GRADIENT_X }}
          />
        </div>
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
      <div className="absolute inset-0 rounded-full overflow-hidden">
        <div
          className="absolute left-0 w-full h-1/2 animate-scroll-hint-y"
          data-testid="scroll-hint-shine"
          style={{ background: SHINE_GRADIENT_Y }}
        />
      </div>
    </div>
  );
}
