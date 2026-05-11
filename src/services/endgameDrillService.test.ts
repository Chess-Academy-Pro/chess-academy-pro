/**
 * endgameDrillService tests — verifies the per-lesson drill pool
 * is correctly filtered by themes, popularity floors, and tier
 * rating bands.
 */
import { describe, it, expect } from 'vitest';
import {
  getDrillPositionsForLesson,
  getDrillPuzzleCount,
} from './endgameDrillService';
import { getEndgamePrinciples, getPawnEndings } from './endgameLessonsService';

describe('endgameDrillService', () => {
  it('returns empty drills for a lesson with no practiceThemes', () => {
    const fakeLesson = {
      id: 'no-themes',
      name: 'No themes',
      category: 'principle' as const,
      order: 99,
      narration: { intro: '', rule: '', why: '' },
      positions: [],
    };
    expect(getDrillPositionsForLesson(fakeLesson)).toEqual([]);
    expect(getDrillPuzzleCount(fakeLesson)).toBe(0);
  });

  it('returns drill positions for a lesson with practiceThemes', () => {
    const principles = getEndgamePrinciples();
    const lesson = principles.find((l) => (l.practiceThemes?.length ?? 0) > 0);
    expect(lesson).toBeDefined();
    if (!lesson) return;
    const drills = getDrillPositionsForLesson(lesson, { limit: 3, seed: 1 });
    expect(drills.length).toBeGreaterThan(0);
    expect(drills.length).toBeLessThanOrEqual(3);
    for (const d of drills) {
      expect(d.fen).toBeDefined();
      expect(d.bestMove).toBeDefined();
      expect(d.solution).toBeDefined();
      expect(d.solution?.length).toBeGreaterThan(0);
      expect(d.source).toMatch(/Lichess puzzle/);
    }
  });

  it('tier=beginner returns only puzzles rated < 1300', () => {
    const pawn = getPawnEndings();
    const lesson = pawn.find((l) => (l.practiceThemes?.length ?? 0) > 0);
    if (!lesson) return;
    const drills = getDrillPositionsForLesson(lesson, {
      limit: 5,
      seed: 1,
      tier: 'beginner',
    });
    for (const d of drills) {
      // Drill title carries the rating: "Drill — rating XXX"
      const m = d.title.match(/rating (\d+)/);
      if (m) {
        const rating = parseInt(m[1], 10);
        expect(rating).toBeLessThan(1300);
      }
    }
  });

  it('tier=advanced returns only puzzles rated ≥ 1700', () => {
    const pawn = getPawnEndings();
    const lesson = pawn.find((l) => (l.practiceThemes?.length ?? 0) > 0);
    if (!lesson) return;
    const drills = getDrillPositionsForLesson(lesson, {
      limit: 5,
      seed: 1,
      tier: 'advanced',
    });
    for (const d of drills) {
      const m = d.title.match(/rating (\d+)/);
      if (m) {
        const rating = parseInt(m[1], 10);
        expect(rating).toBeGreaterThanOrEqual(1700);
      }
    }
  });

  it('getDrillPuzzleCount returns a non-zero count for the mixed tier on a themed lesson', () => {
    const principles = getEndgamePrinciples();
    const lesson = principles.find((l) => (l.practiceThemes?.length ?? 0) > 0);
    if (!lesson) return;
    expect(getDrillPuzzleCount(lesson, 'mixed')).toBeGreaterThan(0);
  });

  it('per-tier counts sum to ≤ the mixed-tier count', () => {
    const principles = getEndgamePrinciples();
    const lesson = principles.find((l) => (l.practiceThemes?.length ?? 0) > 0);
    if (!lesson) return;
    const mixed = getDrillPuzzleCount(lesson, 'mixed');
    const beg = getDrillPuzzleCount(lesson, 'beginner');
    const int = getDrillPuzzleCount(lesson, 'intermediate');
    const adv = getDrillPuzzleCount(lesson, 'advanced');
    expect(beg + int + adv).toBeLessThanOrEqual(mixed);
    // Tier bands are exhaustive over the rating range so the sum
    // should equal the mixed count.
    expect(beg + int + adv).toBe(mixed);
  });
});
