/**
 * StarAnimationLayer
 * ------------------
 * App-root portal layer that renders ghost elements for every
 * in-flight star animation triggered via `useStarAnimationStore`.
 * Sits in `<App>` once, listens for triggers from any source
 * surface (OpeningCard, OpeningDetailPage, ProPlayerPage), and
 * animates a small heart ghost from the source rect to the Coach
 * nav tab (the closest visible affordance to /coach/plan, per
 * Dave's PR-5 stop-and-ask call).
 *
 * Animation choreography:
 *   1. Ghost mounts at source rect, fades in at scale 1.4 (matches
 *      the bloom on the source heart itself)
 *   2. Springs to the Coach nav tab's rect, scaling down to 0.5
 *   3. Fades out on arrival, fires `complete(id)`
 *
 * If the Coach nav tab isn't in the DOM (e.g. the user is on a
 * fullscreen surface that hides it, or DOM not ready), the ghost
 * fades on the source rect — graceful degradation, no slide.
 *
 * Position math: `position: fixed` + `top: 0, left: 0` + transforms
 * keeps the ghost in viewport coordinates regardless of any
 * scrolling on the source surface. `pointer-events-none` on every
 * ghost so they never block underlying interactions.
 *
 * Audit: each trigger fires a `star-animation-triggered` audit
 * (kind registered in `appAuditor.ts`). Drives the post-deploy
 * audit's expectation that favoriting from any surface emits the
 * event.
 */
import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart } from 'lucide-react';
import { useStarAnimationStore, type StarAnimation } from '../stores/starAnimationStore';
import { logAppAudit } from '../services/appAuditor';

// Matches the data-testid AppLayout writes for the Coach bottom-nav
// tab — `/coach/home` → `nav-coach-home-tab` via the slash→dash
// path-to-id convention. The Coach tab is the closest visible
// affordance to /coach/plan (per Dave's PR-5 stop-and-ask call).
const NAV_COACH_SELECTOR = '[data-testid="nav-coach-home-tab"]';

/** Look up the Coach nav tab's bounding rect in viewport coords.
 *  Returns null when the tab isn't in the DOM (mobile drawer
 *  closed, fullscreen surface, etc.) — caller falls back to a
 *  fade-on-source-rect. */
function getCoachTabRect(): { x: number; y: number; width: number; height: number } | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(NAV_COACH_SELECTOR);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function StarGhost({ entry }: { entry: StarAnimation }): JSX.Element {
  const complete = useStarAnimationStore((s) => s.complete);

  const target = useMemo(() => getCoachTabRect(), []);

  const startX = entry.sourceRect.x + entry.sourceRect.width / 2 - 12;
  const startY = entry.sourceRect.y + entry.sourceRect.height / 2 - 12;
  const endX = target ? target.x + target.width / 2 - 12 : startX;
  const endY = target ? target.y + target.height / 2 - 12 : startY;

  const tintClass =
    entry.openingColor === 'white'
      ? 'text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]'
      : 'text-rose-400 drop-shadow-[0_0_8px_rgba(251,113,133,0.6)]';

  return (
    <motion.div
      className={`fixed pointer-events-none z-[9999] ${tintClass}`}
      style={{ top: 0, left: 0 }}
      initial={{ x: startX, y: startY, scale: 1.4, opacity: 0 }}
      animate={
        target
          ? {
              x: [startX, endX],
              y: [startY, endY],
              scale: [1.4, 0.5],
              opacity: [1, 1, 0],
            }
          : {
              x: startX,
              y: startY,
              scale: [1.4, 1, 0.5],
              opacity: [1, 1, 0],
            }
      }
      transition={{
        duration: target ? 0.65 : 0.45,
        ease: [0.4, 0, 0.2, 1],
        times: target ? [0, 0.85, 1] : [0, 0.5, 1],
      }}
      onAnimationComplete={() => complete(entry.id)}
      aria-label={`Favorited ${entry.openingName}`}
      role="presentation"
      data-testid={`star-animation-ghost-${entry.id}`}
    >
      <Heart size={24} fill="currentColor" strokeWidth={0} />
    </motion.div>
  );
}

export function StarAnimationLayer(): JSX.Element {
  const active = useStarAnimationStore((s) => s.active);

  // Audit on every new trigger. Effect-based instead of inline in
  // the store action so the store stays free of side effects beyond
  // state management (cleaner for testing the store in isolation).
  useEffect(() => {
    if (active.length === 0) return;
    const latest = active[active.length - 1];
    void logAppAudit({
      kind: 'star-animation-triggered',
      category: 'subsystem',
      source: 'StarAnimationLayer',
      summary: `${latest.openingColor} "${latest.openingName}"`,
      details: JSON.stringify({
        id: latest.id,
        openingName: latest.openingName,
        openingColor: latest.openingColor,
        sourceRect: latest.sourceRect,
        targetFound: getCoachTabRect() !== null,
      }),
    });
  }, [active.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {active.map((entry) => (
        <StarGhost key={entry.id} entry={entry} />
      ))}
    </AnimatePresence>
  );
}
