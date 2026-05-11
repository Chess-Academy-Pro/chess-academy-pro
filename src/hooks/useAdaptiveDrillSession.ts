/**
 * useAdaptiveDrillSession
 * -----------------------
 * Infinite-stream drill mode for endgame lessons. Each drill is
 * pulled from the Lichess puzzle DB at a target rating; after the
 * student completes a drill, the hook adjusts the target up or
 * down based on their performance (errors + time-to-solve), then
 * picks the next puzzle closest to the new target.
 *
 * Adjustment rules:
 *   - 0 errors,  < 30s  → +75  (step up sharply)
 *   - 0 errors,  < 60s  → +25  (step up gently)
 *   - ≤2 errors, < 120s → ±0   (hold target)
 *   - 3+ errors OR  ≥ 120s → −50  (step down)
 *
 * The target clamps to [600, 2400] so the student doesn't run off
 * the rating ladder in either direction. Excludes previously-
 * played puzzles within the session so the student doesn't repeat
 * the same drill until the pool exhausts.
 *
 * Persistence is intentionally NOT in this hook — the host can
 * pass `initialRating` from Dexie if a stored target exists; this
 * hook returns the live targetRating for the host to persist on
 * recordOutcome if it wants to.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPuzzleAtRating } from '../services/endgameDrillService';
import type { EndgameLesson, EndgameLessonPosition } from '../types/endgameLesson';

const CLAMP_MIN = 600;
const CLAMP_MAX = 2400;

export interface AdaptiveDrillOutcome {
  /** Total wrong move attempts on the drill. */
  wrongAttempts: number;
  /** Wall-clock time the student spent on the drill, in ms. */
  durationMs: number;
}

export interface AdaptiveDrillSession {
  /** Current drill, or null when the theme pool is exhausted. */
  currentDrill: EndgameLessonPosition | null;
  /** The rating target the next puzzle was picked at. */
  targetRating: number;
  /** Drills the student has played in this session (any outcome). */
  completedCount: number;
  /** Sum of wrong attempts across the session. Surfaces "you've
   *  had a tough run" coaching cues. */
  totalWrongAttempts: number;
  /** Sum of durations across the session. */
  totalDurationMs: number;
  /** Most-recent adjustment to the target ('up' / 'down' / 'hold'). */
  lastAdjustment: 'up' | 'down' | 'hold' | null;
  /** Record the just-finished drill's outcome and advance to the
   *  next puzzle. */
  recordOutcome: (outcome: AdaptiveDrillOutcome) => void;
  /** Reset the session — clears history, returns target to initial. */
  reset: () => void;
}

export function useAdaptiveDrillSession(
  lesson: EndgameLesson,
  options: { initialRating?: number; seed?: number } = {},
): AdaptiveDrillSession {
  const initialRating = clamp(options.initialRating ?? 1200);
  const [targetRating, setTargetRating] = useState<number>(initialRating);
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());
  const [completedCount, setCompletedCount] = useState<number>(0);
  const [totalWrong, setTotalWrong] = useState<number>(0);
  const [totalDuration, setTotalDuration] = useState<number>(0);
  const [lastAdjustment, setLastAdjustment] = useState<'up' | 'down' | 'hold' | null>(null);
  const [currentDrill, setCurrentDrill] = useState<EndgameLessonPosition | null>(null);

  // Pick the initial drill when the lesson changes.
  useEffect(() => {
    const first = getPuzzleAtRating(lesson, initialRating, new Set());
    setCurrentDrill(first);
    setTargetRating(initialRating);
    setPlayedIds(new Set(first ? [extractPuzzleId(first)] : []));
    setCompletedCount(0);
    setTotalWrong(0);
    setTotalDuration(0);
    setLastAdjustment(null);
  }, [lesson, initialRating]);

  const recordOutcome = useCallback(
    (outcome: AdaptiveDrillOutcome) => {
      const adjustment = computeAdjustment(outcome);
      const direction = adjustment > 0 ? 'up' : adjustment < 0 ? 'down' : 'hold';
      const nextTarget = clamp(targetRating + adjustment);

      const nextPlayed = new Set(playedIds);
      // currentDrill should be in playedIds already (added on advance),
      // but defensive — make sure it is.
      if (currentDrill) {
        const id = extractPuzzleId(currentDrill);
        if (id) nextPlayed.add(id);
      }
      const nextDrill = getPuzzleAtRating(lesson, nextTarget, nextPlayed);

      setTargetRating(nextTarget);
      setPlayedIds(
        nextDrill
          ? (() => {
              const s = new Set(nextPlayed);
              const id = extractPuzzleId(nextDrill);
              if (id) s.add(id);
              return s;
            })()
          : nextPlayed,
      );
      setCompletedCount((n) => n + 1);
      setTotalWrong((n) => n + outcome.wrongAttempts);
      setTotalDuration((n) => n + outcome.durationMs);
      setLastAdjustment(direction);
      setCurrentDrill(nextDrill);
    },
    [lesson, targetRating, playedIds, currentDrill],
  );

  const reset = useCallback(() => {
    const first = getPuzzleAtRating(lesson, initialRating, new Set());
    setCurrentDrill(first);
    setTargetRating(initialRating);
    setPlayedIds(new Set(first ? [extractPuzzleId(first)] : []));
    setCompletedCount(0);
    setTotalWrong(0);
    setTotalDuration(0);
    setLastAdjustment(null);
  }, [lesson, initialRating]);

  return useMemo(
    () => ({
      currentDrill,
      targetRating,
      completedCount,
      totalWrongAttempts: totalWrong,
      totalDurationMs: totalDuration,
      lastAdjustment,
      recordOutcome,
      reset,
    }),
    [
      currentDrill,
      targetRating,
      completedCount,
      totalWrong,
      totalDuration,
      lastAdjustment,
      recordOutcome,
      reset,
    ],
  );
}

/** Compute the rating adjustment based on the drill outcome. */
function computeAdjustment(outcome: AdaptiveDrillOutcome): number {
  const { wrongAttempts, durationMs } = outcome;
  if (wrongAttempts === 0 && durationMs < 30_000) return 75;
  if (wrongAttempts === 0 && durationMs < 60_000) return 25;
  if (wrongAttempts <= 2 && durationMs < 120_000) return 0;
  return -50;
}

function clamp(rating: number): number {
  return Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, rating));
}

/** Extract the Lichess puzzle id from a drill's `source` field.
 *  The drill service writes "Lichess puzzle #abc12 (rating 1234)"
 *  for puzzle-derived positions. */
function extractPuzzleId(pos: EndgameLessonPosition): string {
  const src = pos.source ?? '';
  const m = src.match(/Lichess puzzle\s*#?\s*([A-Za-z0-9]+)/);
  return m ? m[1] : pos.fen;
}
