/**
 * useAdaptiveEndgameSession
 * -------------------------
 * Adaptive infinite-stream drill mode for endgame puzzles. Wraps
 * `adaptiveEndgameService` to expose a React hook with the same
 * surface as the old `useAdaptiveDrillSession`, but the algorithm
 * is now the same Elo+session-step pattern the puzzle tab uses
 * (so a right answer → harder next puzzle; wrong → easier next;
 * persistent Elo against the user's `endgameRating` field).
 *
 * Replaces `useAdaptiveDrillSession` for endgame surfaces. Other
 * surfaces (Play with Coach, Learn) are untouched.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyAdaptiveOutcome,
  createAdaptiveEndgameState,
  pickAdaptivePuzzle,
  adaptivePuzzleToLessonPosition,
  DEFAULT_ENDGAME_RATING,
  type AdaptiveEndgameState,
} from '../services/adaptiveEndgameService';
import { db } from '../db/schema';
import { useAppStore } from '../stores/appStore';
import type { EndgameLesson, EndgameLessonPosition } from '../types/endgameLesson';

export interface AdaptiveEndgameSession {
  /** Current drill — null while loading, or when the theme pool
   *  has no remaining puzzles. */
  currentDrill: EndgameLessonPosition | null;
  /** Lichess rating of the current drill. */
  currentDrillRating: number | null;
  /** Live session target rating (drives next-puzzle selection). */
  sessionRating: number;
  /** Persistent user rating after the most recent attempt. */
  userRating: number;
  /** Puzzles solved this session. */
  solved: number;
  /** Puzzles failed this session. */
  failed: number;
  /** Best correct-answer streak this session. */
  bestStreak: number;
  /** Last adjustment — drives the up/down arrow chip. */
  lastAdjustment: 'up' | 'down' | null;
  /** Record an attempt outcome: applies Elo to the user rating,
   *  steps the session target, advances to the next drill, and
   *  flushes the new user rating to Dexie. */
  recordOutcome: (firstTryPerfect: boolean) => void;
  /** Reset the in-memory session — keeps the persisted user
   *  rating but clears streak / solved / played history. */
  reset: () => void;
}

interface UseAdaptiveEndgameOptions {
  /** Themes to filter the puzzle pool. Default — no filter
   *  (entire endgame-tagged pool). Pass the lesson's
   *  `practiceThemes` to scope to one lesson's tactic family. */
  themes?: ReadonlyArray<string>;
  /** Override the starting user rating (defaults to the value
   *  stored on the active profile, falling back to 1200). */
  initialRating?: number;
}

export function useAdaptiveEndgameSession(
  lesson: EndgameLesson | null,
  options: UseAdaptiveEndgameOptions = {},
): AdaptiveEndgameSession {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  // Start rating: explicit option > stored endgameRating > default.
  const initial =
    options.initialRating ??
    activeProfile?.endgameRating ??
    DEFAULT_ENDGAME_RATING;
  const themes = options.themes ?? lesson?.practiceThemes ?? [];

  const [state, setState] = useState<AdaptiveEndgameState>(() =>
    createAdaptiveEndgameState(initial),
  );
  const [currentRaw, setCurrentRaw] = useState(() =>
    pickAdaptivePuzzle(createAdaptiveEndgameState(initial), { themes }),
  );

  // Reset everything when the lesson changes.
  useEffect(() => {
    const fresh = createAdaptiveEndgameState(initial);
    setState(fresh);
    setCurrentRaw(pickAdaptivePuzzle(fresh, { themes }));
    // We intentionally exclude `themes` from the dep array — its
    // identity changes on every render via the `??` lookup. Lesson
    // id is the stable signal we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id, initial]);

  const currentDrill = useMemo<EndgameLessonPosition | null>(() => {
    if (!currentRaw) return null;
    return adaptivePuzzleToLessonPosition(currentRaw, lesson ?? undefined);
  }, [currentRaw, lesson]);

  const recordOutcome = useCallback(
    (firstTryPerfect: boolean) => {
      if (!currentRaw) return;
      const next = applyAdaptiveOutcome(state, {
        firstTryPerfect,
        puzzleRating: currentRaw.rating,
        puzzleId: currentRaw.id,
      });
      setState(next);
      setCurrentRaw(pickAdaptivePuzzle(next, { themes }));
      // Persist the new user rating to the active profile + Dexie.
      if (activeProfile) {
        const updated = { ...activeProfile, endgameRating: next.userRating };
        setActiveProfile(updated);
        void db.profiles.update(activeProfile.id, { endgameRating: next.userRating });
      }
    },
    // themes is derived from lesson.practiceThemes on each render;
    // we depend on lesson?.id (stable) instead so the callback
    // identity doesn't flap on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentRaw, state, activeProfile, setActiveProfile, lesson?.id],
  );

  const reset = useCallback(() => {
    const fresh = createAdaptiveEndgameState(initial);
    setState(fresh);
    setCurrentRaw(pickAdaptivePuzzle(fresh, { themes }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, lesson?.id]);

  return {
    currentDrill,
    currentDrillRating: currentRaw?.rating ?? null,
    sessionRating: state.sessionRating,
    userRating: state.userRating,
    solved: state.solved,
    failed: state.failed,
    bestStreak: state.bestStreak,
    lastAdjustment: state.lastAdjustment,
    recordOutcome,
    reset,
  };
}
