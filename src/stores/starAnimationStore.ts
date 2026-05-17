/**
 * starAnimationStore
 * ------------------
 * Tiny event-bus store for the favorite-an-opening star animation
 * (WO-ROLODEX-UI-01 PR-5). When the user taps the heart on any
 * source surface (OpeningCard, OpeningDetailPage, ProPlayerPage),
 * the source captures its bounding rect + opening name and calls
 * `trigger(...)`. A single app-root `<StarAnimationLayer />` reads
 * the active list and renders a ghost that slides from the source
 * rect toward the Coach nav tab. On animation end, the layer calls
 * `complete(id)` to remove the entry.
 *
 * Why a store instead of refs/portal direct calls: the source
 * surface and the animation layer are far apart in the React tree
 * (different routes, different layout slots). A pub/sub store
 * decouples them — sources don't need to know the layer exists,
 * the layer doesn't need to know about sources. Adding new
 * favoriting surfaces in the future = call `trigger`, done.
 *
 * Non-persistent. Animation state is purely in-memory; restart
 * clears all in-flight animations. No Dexie sync.
 */
import { create } from 'zustand';

/** Serializable rectangle (matches DOMRect's coord fields without
 *  pulling the live DOMRect across module boundaries). */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One in-flight star animation. The layer reads this and renders
 *  a corresponding ghost element until `complete(id)` fires. */
export interface StarAnimation {
  id: string;
  /** Source rect in viewport coordinates (from
   *  `getBoundingClientRect()`). The ghost begins overlaid on this
   *  rect, then slides to the Coach nav tab. */
  sourceRect: SourceRect;
  /** Display name for accessibility (`aria-label` on the ghost) and
   *  any future heads-up text. */
  openingName: string;
  /** Color of the opening — drives the ghost tint so the animation
   *  carries the same visual cue as the rolodex card. */
  openingColor: 'white' | 'black';
  startedAt: number;
}

interface StarAnimationState {
  active: StarAnimation[];
  /** Fire a star animation. Returns the assigned animation id so
   *  callers can correlate complete events if needed (rare). */
  trigger: (input: Omit<StarAnimation, 'id' | 'startedAt'>) => string;
  /** Remove an in-flight animation from the active list. Called by
   *  the layer when its motion.div's `onAnimationComplete` fires. */
  complete: (id: string) => void;
  /** Test-only — clear all active animations. */
  __resetForTests: () => void;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `star-anim-${Date.now()}-${counter}`;
}

export const useStarAnimationStore = create<StarAnimationState>((set) => ({
  active: [],
  trigger: (input) => {
    const id = nextId();
    const entry: StarAnimation = { ...input, id, startedAt: Date.now() };
    set((state) => ({ active: [...state.active, entry] }));
    return id;
  },
  complete: (id) =>
    set((state) => ({ active: state.active.filter((a) => a.id !== id) })),
  __resetForTests: () => set({ active: [] }),
}));
