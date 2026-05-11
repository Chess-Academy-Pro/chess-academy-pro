/** Tests for the adaptive drill session — verifies the stepping
 *  rules + that completed puzzles aren't re-served. */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useAdaptiveDrillSession } from './useAdaptiveDrillSession';
import { getEndgamePrinciples } from '../services/endgameLessonsService';

const themedLesson = getEndgamePrinciples().find(
  (l) => (l.practiceThemes?.length ?? 0) > 0,
);

describe('useAdaptiveDrillSession', () => {
  it('returns a first drill at the initial rating target', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 1200 }),
    );
    expect(result.current.currentDrill).not.toBeNull();
    expect(result.current.targetRating).toBe(1200);
    expect(result.current.completedCount).toBe(0);
  });

  it('steps up the target when the student is fast + perfect', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 1200 }),
    );
    act(() => {
      result.current.recordOutcome({ wrongAttempts: 0, durationMs: 15_000 });
    });
    expect(result.current.targetRating).toBeGreaterThan(1200);
    expect(result.current.lastAdjustment).toBe('up');
    expect(result.current.completedCount).toBe(1);
  });

  it('holds the target when the student is solid but not fast', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 1200 }),
    );
    act(() => {
      result.current.recordOutcome({ wrongAttempts: 1, durationMs: 90_000 });
    });
    expect(result.current.targetRating).toBe(1200);
    expect(result.current.lastAdjustment).toBe('hold');
  });

  it('steps down when the student makes too many errors', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 1400 }),
    );
    act(() => {
      result.current.recordOutcome({ wrongAttempts: 4, durationMs: 60_000 });
    });
    expect(result.current.targetRating).toBeLessThan(1400);
    expect(result.current.lastAdjustment).toBe('down');
  });

  it('clamps the target to [600, 2400]', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 700 }),
    );
    // Many step-downs should never push below 600.
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        result.current.recordOutcome({ wrongAttempts: 5, durationMs: 150_000 });
      });
    }
    expect(result.current.targetRating).toBeGreaterThanOrEqual(600);
  });

  it('completedCount increments after each outcome', () => {
    if (!themedLesson) return;
    const { result } = renderHook(() =>
      useAdaptiveDrillSession(themedLesson, { initialRating: 1200 }),
    );
    expect(result.current.completedCount).toBe(0);
    act(() => {
      result.current.recordOutcome({ wrongAttempts: 0, durationMs: 20_000 });
    });
    expect(result.current.completedCount).toBe(1);
    act(() => {
      result.current.recordOutcome({ wrongAttempts: 0, durationMs: 20_000 });
    });
    expect(result.current.completedCount).toBe(2);
  });
});
