/**
 * useOpeningProgress
 * ------------------
 * Per-opening progress hooks for the Training Plan rolodex
 * (WO-ROLODEX-PLUMBING-01 item 7). Each hook returns a shape the
 * rolodex card row can render as "X / Y" — counts of "things done"
 * over "things available" for a given opening.
 *
 * Shape contract:
 *   • Tracked hooks return `{ completed, total, loading }` with
 *     `loading: true` while Dexie reads are in flight and the
 *     count fields temporarily zero. Once `loading` flips to
 *     `false` the counts are authoritative.
 *   • The placeholder hook returns `{ status: 'not-tracked-yet' }`
 *     for rolodex rows that have no per-opening data infrastructure
 *     yet (GM Games, Practice from move 1, Practice middlegame).
 *     Distinct shape so the UI can render "—" + nudge copy
 *     unconditionally instead of treating 0/0 as a degenerate case.
 *
 * Family-fallback discipline (WO item 13): family-fallback logic
 * lives ONLY in the Puzzles selector (item 11 — separate file).
 * The four hooks here do exact-name lookups against the canonical
 * per-opening data substrates. If a future row needs the same
 * fallback ladder, lift the pattern from there rather than
 * duplicating it here.
 *
 * No useLiveQuery / dexie-react-hooks pattern in this codebase —
 * each hook does a useState + async-useEffect load, re-firing when
 * its identifier dep changes. Consumers that mutate the underlying
 * data (mark walkthrough complete, solve a mistake) must trigger a
 * remount or pass a refetch key — there's no global invalidation
 * hook today. The rolodex card row mounts on tap, so per-mount
 * freshness is sufficient for v1.
 */
import { useEffect, useMemo, useState } from 'react';
import { db } from '../db/schema';
import { getCompletedStages, type ProgressStage } from '../services/openingProgress';
import { getPuzzlesProgress, type PuzzlesProgress } from '../services/puzzlesByOpening';

/** Five-stage walkthrough taxonomy from `openingProgress.ts`:
 *  walkthrough · concepts · findMove · drill · punish. Hard-coded
 *  here rather than re-derived from a runtime list — the
 *  `ProgressStage` union is the single source of truth and we
 *  hand-mirror its count to keep the constant inline. */
const WALKTHROUGH_TOTAL_STAGES = 5;

/** Shape returned by the four data-tracking hooks (walkthrough,
 *  lines, traps, mistakes). */
export interface OpeningProgressTracked {
  completed: number;
  total: number;
  loading: boolean;
}

/** Shape returned by the placeholder hook. Distinct from the
 *  tracked shape so the UI can render "—" + nudge copy without
 *  branching on count values. */
export interface OpeningProgressPlaceholder {
  status: 'not-tracked-yet';
}

const ZERO_LOADING: OpeningProgressTracked = { completed: 0, total: 0, loading: true };
const ZERO_DONE: OpeningProgressTracked = { completed: 0, total: 0, loading: false };

/** Walkthrough stage progress for an opening — completed stages
 *  (`walkthrough` / `concepts` / `findMove` / `drill` / `punish`)
 *  out of 5. Reads from the `meta.openingProgress` JSON blob via
 *  `getCompletedStages(openingName)`. Lowercased name lookup is
 *  handled inside that function. */
export function useOpeningWalkthroughProgress(
  openingName: string | null | undefined,
): OpeningProgressTracked {
  const [state, setState] = useState<OpeningProgressTracked>(ZERO_LOADING);
  useEffect(() => {
    if (!openingName) {
      setState(ZERO_DONE);
      return;
    }
    const flag = { cancelled: false };
    void (async () => {
      try {
        const completed = await getCompletedStages(openingName);
        if (flag.cancelled) return;
        setState({ completed: completed.size, total: WALKTHROUGH_TOTAL_STAGES, loading: false });
      } catch {
        if (flag.cancelled) return;
        setState(ZERO_DONE);
      }
    })();
    return () => {
      flag.cancelled = true;
    };
  }, [openingName]);
  return state;
}

/** Lines studied progress — completed lines (`linesPerfected[]`)
 *  out of total variations on the OpeningRecord. Lookup by
 *  opening id (not name) since `OpeningRecord.variations[]` is
 *  attached to the row in the `openings` Dexie table.
 *
 *  "Lines discovered" is the broader "have I seen this line"
 *  signal; "lines perfected" is the "I drilled it clean" signal.
 *  Rolodex uses `linesPerfected.length` as the completion count
 *  per CLAUDE.md's drill criteria — only fully-cleared lines
 *  count as done. */
export function useOpeningLinesProgress(
  openingId: string | null | undefined,
): OpeningProgressTracked {
  const [state, setState] = useState<OpeningProgressTracked>(ZERO_LOADING);
  useEffect(() => {
    if (!openingId) {
      setState(ZERO_DONE);
      return;
    }
    const flag = { cancelled: false };
    void (async () => {
      try {
        const opening = await db.openings.get(openingId);
        if (flag.cancelled) return;
        const total = opening?.variations?.length ?? 0;
        const completed = opening?.linesPerfected?.length ?? 0;
        // Defensive clamp: linesPerfected can hold stale indices
        // if the variations array shrank between sessions.
        const clamped = Math.min(completed, total);
        setState({ completed: clamped, total, loading: false });
      } catch {
        if (flag.cancelled) return;
        setState(ZERO_DONE);
      }
    })();
    return () => {
      flag.cancelled = true;
    };
  }, [openingId]);
  return state;
}

/** Traps & pitfalls progress — total = `trapLines.length` on the
 *  OpeningRecord. Completion tracking is pending: `OpeningRecord`
 *  has no `trapsPerfected[]` parallel to `linesPerfected[]` yet,
 *  so the hook returns `completed: 0` until the trap-completion
 *  infrastructure ships. Documented in PLAN.md
 *  `2026-05-16-rolodex-plumbing.md` decisions log. The UI can
 *  render "0 / N" or "N traps available" — either reads correctly
 *  with this shape. When trap-completion lands, swap the
 *  `completed` line below and tests will catch any rolodex UI that
 *  treated `0` as a known-done count. */
export function useOpeningTrapsProgress(
  openingId: string | null | undefined,
): OpeningProgressTracked {
  const [state, setState] = useState<OpeningProgressTracked>(ZERO_LOADING);
  useEffect(() => {
    if (!openingId) {
      setState(ZERO_DONE);
      return;
    }
    const flag = { cancelled: false };
    void (async () => {
      try {
        const opening = await db.openings.get(openingId);
        if (flag.cancelled) return;
        const total = opening?.trapLines?.length ?? 0;
        // TODO(WO-OPENING-TRAP-COMPLETION-01): replace with the
        // real per-trap completion count once trapsPerfected[]
        // or equivalent lands on OpeningRecord.
        const completed = 0;
        setState({ completed, total, loading: false });
      } catch {
        if (flag.cancelled) return;
        setState(ZERO_DONE);
      }
    })();
    return () => {
      flag.cancelled = true;
    };
  }, [openingId]);
  return state;
}

/** Mistakes-from-your-games progress — total = mistake puzzles
 *  whose `openingName` matches the input; completed = mistakes
 *  with `status === 'solved'` or `'mastered'`. Direct opening-
 *  keyed query — `MistakePuzzle.openingName` is the canonical
 *  field, set when the mistake was analyzed from a played game. */
export function useOpeningMistakesProgress(
  openingName: string | null | undefined,
): OpeningProgressTracked {
  const [state, setState] = useState<OpeningProgressTracked>(ZERO_LOADING);
  useEffect(() => {
    if (!openingName) {
      setState(ZERO_DONE);
      return;
    }
    const flag = { cancelled: false };
    void (async () => {
      try {
        // `openingName` isn't a secondary index on the mistakePuzzles
        // table (see src/db/schema.ts). Use Collection.filter() rather
        // than where().equals() to scan rows in-memory — Dexie's
        // where() only operates on indexed fields. Volume is low
        // (per-user mistake puzzles cap at a few hundred typically),
        // so the table scan is fine for v1. If this becomes hot, add
        // `openingName` to the schema indexes in a Dexie version bump.
        const all = await db.mistakePuzzles
          .filter((p) => p.openingName === openingName)
          .toArray();
        if (flag.cancelled) return;
        const total = all.length;
        const completed = all.filter(
          (p) => p.status === 'solved' || p.status === 'mastered',
        ).length;
        setState({ completed, total, loading: false });
      } catch {
        if (flag.cancelled) return;
        setState(ZERO_DONE);
      }
    })();
    return () => {
      flag.cancelled = true;
    };
  }, [openingName]);
  return state;
}

/** Puzzles count for the rolodex row, with family-fallback (WO
 *  item 11). Synchronous — the bundled puzzles.json index is in
 *  memory after first call. The hook wraps it in `useMemo` keyed
 *  on the opening name so consumers can treat it like the other
 *  progress hooks (call once per render, identifier-stable
 *  result).
 *
 *  Shape differs from the other four progress hooks: returns
 *  `{ count, source: 'exact' | 'family' | 'none', family? }`
 *  instead of `{ completed, total, loading }`. The rolodex UI
 *  uses `source` to render the right label and link target — a
 *  family-fallback row chips "Italian Game family ✕" rather than
 *  "0 / 0" or the deep variation name.
 *
 *  See `src/services/puzzlesByOpening.ts` for the ladder
 *  implementation and `src/services/puzzlesFamilyFallbackNotify.ts`
 *  for the LLM voice-acknowledgment companion. */
export function useOpeningPuzzlesProgress(
  openingName: string | null | undefined,
): PuzzlesProgress {
  return useMemo<PuzzlesProgress>(() => {
    if (!openingName) return { count: 0, source: 'none' };
    return getPuzzlesProgress(openingName);
  }, [openingName]);
}

/** Placeholder for rolodex rows with no per-opening data substrate
 *  yet (GM Games, Practice from move 1, Practice middlegame). The
 *  UI renders "—" + nudge copy ("track your games to see counts
 *  here") instead of "0 / 0" which would imply completion data
 *  exists. WO-ROLODEX-PLUMBING-01 item 7.
 *
 *  Returns a static value — no Dexie I/O — so it's safe to call
 *  unconditionally and is trivially stable across renders. */
export function useOpeningProgressPlaceholder(): OpeningProgressPlaceholder {
  return { status: 'not-tracked-yet' };
}

// Re-export the stage type so the rolodex UI consuming the
// walkthrough hook has a single import surface.
export type { ProgressStage };
