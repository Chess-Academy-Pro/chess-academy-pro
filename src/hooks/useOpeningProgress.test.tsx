import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { db } from '../db/schema';
import {
  useOpeningWalkthroughProgress,
  useOpeningLinesProgress,
  useOpeningTrapsProgress,
  useOpeningMistakesProgress,
  useOpeningPuzzlesProgress,
  useOpeningProgressPlaceholder,
} from './useOpeningProgress';
import {
  buildOpeningRecord,
  buildMistakePuzzle,
} from '../test/factories';
import { markStageComplete } from '../services/openingProgress';

describe('useOpeningProgress', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  describe('useOpeningWalkthroughProgress', () => {
    it('returns 0/5 with loading=false when no stages are completed', async () => {
      const { result } = renderHook(() => useOpeningWalkthroughProgress('Italian Game'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 5, loading: false });
    });

    it('returns 1/5 after one stage is marked complete', async () => {
      await markStageComplete('Italian Game', 'walkthrough');
      const { result } = renderHook(() => useOpeningWalkthroughProgress('Italian Game'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.completed).toBe(1);
      expect(result.current.total).toBe(5);
    });

    it('returns 5/5 when all stages are complete', async () => {
      for (const stage of ['walkthrough', 'concepts', 'findMove', 'drill', 'punish'] as const) {
        await markStageComplete('Sicilian Defense', stage);
      }
      const { result } = renderHook(() => useOpeningWalkthroughProgress('Sicilian Defense'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.completed).toBe(5);
    });

    it('matches case-insensitively (lowercased internally)', async () => {
      await markStageComplete('Caro-Kann Defense', 'concepts');
      const { result } = renderHook(() => useOpeningWalkthroughProgress('CARO-KANN DEFENSE'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.completed).toBe(1);
    });

    it('returns zero/done for null name (rolodex card without a selected opening)', async () => {
      const { result } = renderHook(() => useOpeningWalkthroughProgress(null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });
  });

  describe('useOpeningLinesProgress', () => {
    it('returns completed / total variations from the OpeningRecord', async () => {
      await db.openings.add(
        buildOpeningRecord({
          id: 'italian',
          name: 'Italian Game',
          variations: [
            { name: 'Two Knights', pgn: '', annotations: [] },
            { name: 'Giuoco Piano', pgn: '', annotations: [] },
            { name: 'Evans Gambit', pgn: '', annotations: [] },
          ],
          linesPerfected: [0, 2],
        }),
      );
      const { result } = renderHook(() => useOpeningLinesProgress('italian'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 2, total: 3, loading: false });
    });

    it('clamps stale linesPerfected indices that exceed the current variation count', async () => {
      // Defensive against sessions where the variations array shrank
      // between drill sessions but linesPerfected still has old entries.
      await db.openings.add(
        buildOpeningRecord({
          id: 'shrank',
          name: 'Old Opening',
          variations: [{ name: 'v1', pgn: '', annotations: [] }],
          linesPerfected: [0, 1, 2, 3, 4],
        }),
      );
      const { result } = renderHook(() => useOpeningLinesProgress('shrank'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.completed).toBe(1);
      expect(result.current.total).toBe(1);
    });

    it('returns 0/0 when the opening has no variations', async () => {
      await db.openings.add(
        buildOpeningRecord({ id: 'novars', name: 'Empty Opening', variations: null }),
      );
      const { result } = renderHook(() => useOpeningLinesProgress('novars'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });

    it('returns 0/0 when the opening id does not resolve', async () => {
      const { result } = renderHook(() => useOpeningLinesProgress('nonexistent'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });
  });

  describe('useOpeningTrapsProgress', () => {
    it('returns total = trapLines.length, completed = 0 (tracking pending)', async () => {
      await db.openings.add(
        buildOpeningRecord({
          id: 'italian-traps',
          name: 'Italian Game',
          trapLines: [
            { name: 'Fried Liver Bait', pgn: '', annotations: [] },
            { name: 'Legal Trap', pgn: '', annotations: [] },
          ],
        }),
      );
      const { result } = renderHook(() => useOpeningTrapsProgress('italian-traps'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 2, loading: false });
    });

    it('returns 0/0 when the opening has no trapLines', async () => {
      await db.openings.add(
        buildOpeningRecord({ id: 'plain', name: 'Plain Opening', trapLines: null }),
      );
      const { result } = renderHook(() => useOpeningTrapsProgress('plain'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });
  });

  describe('useOpeningMistakesProgress', () => {
    it('counts mistakes by openingName and breaks down by status', async () => {
      await db.mistakePuzzles.bulkAdd([
        buildMistakePuzzle({ id: 'm1', openingName: 'Italian Game', status: 'unsolved' }),
        buildMistakePuzzle({ id: 'm2', openingName: 'Italian Game', status: 'solved' }),
        buildMistakePuzzle({ id: 'm3', openingName: 'Italian Game', status: 'mastered' }),
        buildMistakePuzzle({ id: 'm4', openingName: 'Sicilian Defense', status: 'solved' }),
      ]);
      const { result } = renderHook(() => useOpeningMistakesProgress('Italian Game'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 2, total: 3, loading: false });
    });

    it('returns 0/0 when no mistakes match the opening name (exact match required)', async () => {
      await db.mistakePuzzles.add(
        buildMistakePuzzle({ id: 'm1', openingName: 'Italian Game', status: 'solved' }),
      );
      // Case-sensitive equals — Dexie's `.equals()` is exact-match.
      // Confirms we're not silently fuzzy-matching.
      const { result } = renderHook(() => useOpeningMistakesProgress('italian game'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });

    it('handles null openingName gracefully', async () => {
      const { result } = renderHook(() => useOpeningMistakesProgress(null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toEqual({ completed: 0, total: 0, loading: false });
    });
  });

  describe('useOpeningPuzzlesProgress (family-fallback)', () => {
    // The selector logic is tested exhaustively in
    // `puzzlesByOpening.test.ts`. These tests pin the hook's
    // useMemo wiring + null-handling.

    it('returns source=exact for a family-level opening with direct hits', () => {
      const { result } = renderHook(() => useOpeningPuzzlesProgress('Italian Game'));
      expect(result.current.source).toBe('exact');
      expect(result.current.count).toBeGreaterThan(0);
    });

    it('returns source=none for null / undefined openingName', () => {
      const { result } = renderHook(() => useOpeningPuzzlesProgress(null));
      expect(result.current).toEqual({ count: 0, source: 'none' });
    });

    it('memoizes — same opening returns referentially-stable result across re-renders', () => {
      const { result, rerender } = renderHook(
        ({ name }) => useOpeningPuzzlesProgress(name),
        { initialProps: { name: 'Italian Game' } },
      );
      const first = result.current;
      rerender({ name: 'Italian Game' });
      // useMemo + same dep means same reference.
      expect(result.current).toBe(first);
    });

    it('recomputes when opening name changes', () => {
      const { result, rerender } = renderHook(
        ({ name }) => useOpeningPuzzlesProgress(name),
        { initialProps: { name: 'Italian Game' } },
      );
      const first = result.current;
      rerender({ name: 'Sicilian Defense' });
      expect(result.current).not.toBe(first);
    });
  });

  describe('useOpeningProgressPlaceholder', () => {
    it('returns the not-tracked-yet sentinel', () => {
      const { result } = renderHook(() => useOpeningProgressPlaceholder());
      expect(result.current).toEqual({ status: 'not-tracked-yet' });
    });

    it('does not touch Dexie (safe to call before db.open)', async () => {
      // Close the db to assert no I/O — the placeholder hook must
      // be inert so the rolodex can render "—" rows without
      // blocking on storage.
      await db.delete();
      const { result } = renderHook(() => useOpeningProgressPlaceholder());
      expect(result.current.status).toBe('not-tracked-yet');
    });
  });
});
