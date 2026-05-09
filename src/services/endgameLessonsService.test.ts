import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
  getAllEndgameLessons,
  getEndgamePrinciples,
  getPawnEndings,
  getDrawingPatterns,
  getRookEndings,
  getEndgameLessonById,
} from './endgameLessonsService';
import type { EndgameLesson } from '../types/endgameLesson';

/** Hand-authored endgame lesson invariants. Every entry has to:
 *  1. Have all required narration fields filled
 *  2. Have at least one reference position
 *  3. Have a chess.js-legal FEN per position
 *  4. Have a chess.js-legal bestMove (when specified)
 *  5. Have a chess.js-legal solution sequence (when specified)
 *  6. Have a unique slug across the entire catalog
 *  7. Have a category that matches its containing array
 *  These are the data invariants — if any future entry violates
 *  them, the test fires and we don't ship malformed content. */

function validatePosition(lesson: EndgameLesson, posIndex: number): void {
  const pos = lesson.positions[posIndex];
  // FEN legality
  expect(() => new Chess(pos.fen)).not.toThrow();
  // Required fields
  expect(pos.title.length).toBeGreaterThan(0);
  expect(pos.explanation.length).toBeGreaterThan(0);
  expect(['white-wins', 'black-wins', 'draw']).toContain(pos.result);
  // Best move chess.js-legal when specified
  if (pos.bestMove) {
    const probe = new Chess(pos.fen);
    expect(() => probe.move(pos.bestMove!)).not.toThrow();
  }
  // Solution sequence replay-legal when specified
  if (pos.solution) {
    const probe = new Chess(pos.fen);
    for (const m of pos.solution) {
      expect(() => probe.move(m)).not.toThrow();
    }
  }
}

function validateLesson(lesson: EndgameLesson, expectedCategory: string[]): void {
  expect(lesson.id).toMatch(/^[a-z0-9-]+$/);
  expect(lesson.name.length).toBeGreaterThan(0);
  expect(expectedCategory).toContain(lesson.category);
  expect(typeof lesson.order).toBe('number');
  expect(lesson.narration.intro.length).toBeGreaterThan(50);
  expect(lesson.narration.rule.length).toBeGreaterThan(20);
  expect(lesson.narration.why.length).toBeGreaterThan(100);
  expect(lesson.positions.length).toBeGreaterThan(0);
  for (let i = 0; i < lesson.positions.length; i += 1) {
    validatePosition(lesson, i);
  }
}

describe('endgameLessonsService', () => {
  describe('catalog shape invariants', () => {
    it('has the expected category counts', () => {
      expect(getEndgamePrinciples().length).toBe(7);
      expect(getPawnEndings().length).toBeGreaterThanOrEqual(6);
      expect(getDrawingPatterns().length).toBe(8);
      expect(getRookEndings().length).toBeGreaterThanOrEqual(4);
    });

    it('lesson IDs are globally unique (no collisions across tabs)', () => {
      const all = getAllEndgameLessons();
      const ids = new Set<string>();
      for (const lesson of all) {
        expect(ids.has(lesson.id)).toBe(false);
        ids.add(lesson.id);
      }
    });

    it('every principle is well-formed', () => {
      for (const lesson of getEndgamePrinciples()) {
        validateLesson(lesson, ['principle']);
      }
    });

    it('every pawn ending is well-formed', () => {
      for (const lesson of getPawnEndings()) {
        validateLesson(lesson, ['pawn-concept', 'pawn-technique']);
      }
    });

    it('every drawing pattern is well-formed', () => {
      for (const lesson of getDrawingPatterns()) {
        validateLesson(lesson, ['drawn-pattern']);
      }
    });

    it('every rook ending is well-formed', () => {
      for (const lesson of getRookEndings()) {
        validateLesson(lesson, ['rook-position']);
      }
    });
  });

  describe('narration quality gates', () => {
    it('every lesson narration cites a source (history field) for theory', () => {
      // Most theoretical content cites a chess source. The 'history'
      // field is optional but principle and drawn-pattern lessons
      // should have it — they're claiming theory and need authority.
      const principlesWithoutHistory = getEndgamePrinciples().filter(
        (p) => !p.narration.history,
      );
      expect(principlesWithoutHistory).toEqual([]);
      const patternsWithoutHistory = getDrawingPatterns().filter(
        (p) => !p.narration.history,
      );
      expect(patternsWithoutHistory).toEqual([]);
    });

    it("no lesson narration uses generic chess clichés", () => {
      // Voice consistency check — banned phrases that signal lazy
      // writing. If any of these appear, the voice has drifted from
      // the agreed-upon "concrete squares, geometric mechanism" style.
      const banned = [
        /\bstrong move\b/i,
        /\bgood piece\b/i,
        /\bnice position\b/i,
        /\bquite\s+(strong|good|nice)\b/i,
        /\bgreat\s+(move|position|piece)\b/i,
      ];
      const offenders: string[] = [];
      for (const lesson of getAllEndgameLessons()) {
        const blob = JSON.stringify(lesson.narration);
        for (const re of banned) {
          if (re.test(blob)) {
            offenders.push(`${lesson.id}: matches ${re}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('lookup', () => {
    it('finds a known lesson by ID', () => {
      const found = getEndgameLessonById('opposition');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('Opposition');
    });

    it('returns null for unknown ID', () => {
      expect(getEndgameLessonById('not-a-real-lesson-xyz')).toBeNull();
    });
  });
});
