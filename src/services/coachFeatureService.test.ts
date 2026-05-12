import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/schema';
import { detectBadHabits, detectBadHabitsFromGame, buildProfileContext, buildReviewSegments } from './coachFeatureService';
import type { ReviewMoveInput } from './coachFeatureService';
import { buildUserProfile, buildBadHabit } from '../test/factories';
import type { UserProfile } from '../types';

// Mock puzzleService (getThemeSkills)
vi.mock('./puzzleService', () => ({
  getThemeSkills: vi.fn(),
}));

import { getThemeSkills } from './puzzleService';
const getThemeSkillsMock = vi.mocked(getThemeSkills);

describe('coachFeatureService', () => {
  let profile: UserProfile;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
    getThemeSkillsMock.mockResolvedValue([]);

    profile = buildUserProfile({ id: 'test-profile' });
    await db.profiles.put(profile);
  });

  describe('detectBadHabits', () => {
    it('creates a new bad habit when theme accuracy is below 40% with 5+ attempts', async () => {
      getThemeSkillsMock.mockResolvedValue([
        { theme: 'fork', accuracy: 0.3, attempts: 10 },
      ]);

      const habits = await detectBadHabits(profile);
      const forkHabit = habits.find((h) => h.id === 'weak-fork');
      expect(forkHabit).toBeDefined();
      expect(forkHabit?.isResolved).toBe(false);
      expect(forkHabit?.description).toContain('fork');
      expect(forkHabit?.description).toContain('30%');
    });

    it('increments occurrences for existing weak theme habits', async () => {
      const existingHabit = buildBadHabit({
        id: 'weak-fork',
        description: 'Struggling with fork puzzles',
        occurrences: 2,
      });
      profile = buildUserProfile({ id: 'test-profile', badHabits: [existingHabit] });
      await db.profiles.put(profile);

      getThemeSkillsMock.mockResolvedValue([
        { theme: 'fork', accuracy: 0.35, attempts: 10 },
      ]);

      const habits = await detectBadHabits(profile);
      const forkHabit = habits.find((h) => h.id === 'weak-fork');
      expect(forkHabit?.occurrences).toBe(3);
    });

    it('resolves habit when accuracy reaches 60%', async () => {
      const existingHabit = buildBadHabit({
        id: 'weak-fork',
        description: 'Struggling with fork puzzles',
        occurrences: 3,
        isResolved: false,
      });
      profile = buildUserProfile({ id: 'test-profile', badHabits: [existingHabit] });
      await db.profiles.put(profile);

      getThemeSkillsMock.mockResolvedValue([
        { theme: 'fork', accuracy: 0.65, attempts: 10 },
      ]);

      const habits = await detectBadHabits(profile);
      const forkHabit = habits.find((h) => h.id === 'weak-fork');
      expect(forkHabit?.isResolved).toBe(true);
    });

    it('does not create habit when accuracy is above 40%', async () => {
      getThemeSkillsMock.mockResolvedValue([
        { theme: 'fork', accuracy: 0.5, attempts: 10 },
      ]);

      const habits = await detectBadHabits(profile);
      expect(habits.find((h) => h.id === 'weak-fork')).toBeUndefined();
    });

    it('does not create habit when attempts are below 5', async () => {
      getThemeSkillsMock.mockResolvedValue([
        { theme: 'fork', accuracy: 0.2, attempts: 3 },
      ]);

      const habits = await detectBadHabits(profile);
      expect(habits.find((h) => h.id === 'weak-fork')).toBeUndefined();
    });
  });

  describe('detectBadHabitsFromGame', () => {
    it('detects time-pressure habit when 2+ blunders in last 10 moves', async () => {
      const moves = Array.from({ length: 30 }, (_, i) => ({
        classification: i >= 22 ? (i % 3 === 0 ? 'blunder' : 'good') : 'good',
        san: `move${i}`,
      }));
      // Ensure at least 2 blunders in last 10
      moves[25] = { classification: 'blunder', san: 'blunder1' };
      moves[28] = { classification: 'mistake', san: 'mistake1' };

      const habits = await detectBadHabitsFromGame(moves, profile);
      const timePressure = habits.find((h) => h.id === 'game-time-pressure');
      expect(timePressure).toBeDefined();
      expect(timePressure?.isResolved).toBe(false);
    });

    it('detects calculation habit when 3+ blunders/mistakes total', async () => {
      const moves = [
        { classification: 'blunder', san: 'b1' },
        { classification: 'mistake', san: 'm1' },
        { classification: 'blunder', san: 'b2' },
        { classification: 'good', san: 'g1' },
        { classification: 'good', san: 'g2' },
      ];

      const habits = await detectBadHabitsFromGame(moves, profile);
      const calcHabit = habits.find((h) => h.id === 'game-calculation');
      expect(calcHabit).toBeDefined();
      expect(calcHabit?.description).toContain('2 blunders');
      expect(calcHabit?.description).toContain('1 mistakes');
    });

    it('resolves calculation habit for clean game', async () => {
      const existingHabit = buildBadHabit({
        id: 'game-calculation',
        description: 'Calculation errors',
        isResolved: false,
      });
      profile = buildUserProfile({ id: 'test-profile', badHabits: [existingHabit] });
      await db.profiles.put(profile);

      const moves = [
        { classification: 'good', san: 'g1' },
        { classification: 'good', san: 'g2' },
        { classification: 'good', san: 'g3' },
        { classification: 'inaccuracy', san: 'i1' },
      ];

      const habits = await detectBadHabitsFromGame(moves, profile);
      const calcHabit = habits.find((h) => h.id === 'game-calculation');
      expect(calcHabit?.isResolved).toBe(true);
    });

    it('does not resolve calculation habit if there are mistakes', async () => {
      const existingHabit = buildBadHabit({
        id: 'game-calculation',
        description: 'Calculation errors',
        isResolved: false,
      });
      profile = buildUserProfile({ id: 'test-profile', badHabits: [existingHabit] });
      await db.profiles.put(profile);

      const moves = [
        { classification: 'good', san: 'g1' },
        { classification: 'mistake', san: 'm1' },
      ];

      const habits = await detectBadHabitsFromGame(moves, profile);
      const calcHabit = habits.find((h) => h.id === 'game-calculation');
      expect(calcHabit?.isResolved).toBe(false);
    });

    it('increments time-pressure habit if it already exists', async () => {
      const existingHabit = buildBadHabit({
        id: 'game-time-pressure',
        description: 'Time pressure',
        occurrences: 2,
        isResolved: false,
      });
      profile = buildUserProfile({ id: 'test-profile', badHabits: [existingHabit] });
      await db.profiles.put(profile);

      const moves = Array.from({ length: 10 }, () => ({
        classification: 'blunder',
        san: 'x',
      }));

      const habits = await detectBadHabitsFromGame(moves, profile);
      const timePressure = habits.find((h) => h.id === 'game-time-pressure');
      expect(timePressure?.occurrences).toBe(3);
    });

    it('persists habits to DB', async () => {
      const moves = [
        { classification: 'blunder', san: 'b1' },
        { classification: 'blunder', san: 'b2' },
        { classification: 'blunder', san: 'b3' },
      ];

      await detectBadHabitsFromGame(moves, profile);
      const updated = await db.profiles.get('test-profile');
      expect(updated?.badHabits.length).toBeGreaterThan(0);
    });
  });

  describe('buildProfileContext', () => {
    it('returns valid CoachContext from profile', () => {
      const ctx = buildProfileContext(profile);
      expect(ctx.fen).toBeTruthy();
      expect(ctx.playerProfile.rating).toBe(profile.currentRating);
    });

    it('includes unresolved bad habits as weaknesses', () => {
      const profileWithHabits = buildUserProfile({
        badHabits: [
          buildBadHabit({ description: 'Weak at forks', isResolved: false }),
          buildBadHabit({ description: 'Time pressure', isResolved: true }),
        ],
      });
      const ctx = buildProfileContext(profileWithHabits);
      expect(ctx.playerProfile.weaknesses).toContain('Weak at forks');
      expect(ctx.playerProfile.weaknesses).not.toContain('Time pressure');
    });

    it('sets default values for position fields', () => {
      const ctx = buildProfileContext(profile);
      expect(ctx.lastMoveSan).toBeNull();
      expect(ctx.moveNumber).toBe(0);
      expect(ctx.pgn).toBe('');
      expect(ctx.openingName).toBeNull();
      expect(ctx.stockfishAnalysis).toBeNull();
      expect(ctx.playerMove).toBeNull();
      expect(ctx.moveClassification).toBeNull();
    });
  });

  describe('buildReviewSegments (ship-3 — deterministic narration)', () => {
    // Helper to build a ReviewMoveInput with sensible defaults so the
    // test bodies stay focused on classification + bestMove.
    function move(overrides: Partial<ReviewMoveInput> & { ply: number; san: string }): ReviewMoveInput {
      return {
        isCoachMove: false,
        classification: 'good',
        evaluation: 0,
        preMoveEval: 0,
        bestMove: null,
        fenAfter: '',
        ...overrides,
      };
    }

    it('returns silence for book + good moves (CLAUDE.md voice rule #4)', () => {
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4', classification: 'book' }),
        move({ ply: 2, san: 'e5', classification: 'book', isCoachMove: true }),
        move({ ply: 3, san: 'Nf3', classification: 'good' }),
      ]);
      expect(segments).toHaveLength(3);
      expect(segments.every((s) => s.narration === null)).toBe(true);
    });

    it('returns templated prose for student mistakes with the best move SAN', () => {
      // Pre-move position: classical Italian. White just played a
      // blunder ("Qh5??"); engine wanted Nf3 instead.
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4', classification: 'book' }),
        move({ ply: 2, san: 'e5', classification: 'book', isCoachMove: true }),
        move({
          ply: 3,
          san: 'Qh5',
          classification: 'blunder',
          bestMove: 'g1f3',
          preMoveEval: 25,
          evaluation: -300,
        }),
      ]);
      const blunderSeg = segments[2];
      expect(blunderSeg.narration).not.toBeNull();
      expect(blunderSeg.narration).toMatch(/Nf3/);
      // Should NOT include the played SAN — rule #3 ("don't restate the board")
      expect(blunderSeg.narration).not.toMatch(/Qh5/);
      // Should include the swing magnitude in pawns
      expect(blunderSeg.narration).toMatch(/3\.[0-9] pawns/);
    });

    it('frames opponent mistakes from the student perspective', () => {
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4', classification: 'book' }),
        move({
          ply: 2,
          san: 'f6',
          classification: 'mistake',
          isCoachMove: true,
          bestMove: 'e7e5',
          preMoveEval: 25,
          evaluation: 180,
        }),
      ]);
      const seg = segments[1];
      expect(seg.narration).toMatch(/opponent/i);
      expect(seg.narration).toMatch(/e5/);
      // Never frame an opponent move with "you played" (voice rule)
      expect(seg.narration).not.toMatch(/^You /);
    });

    it('falls back to a generic line when bestMove is missing', () => {
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4', classification: 'book' }),
        move({
          ply: 2,
          san: 'e5',
          classification: 'book',
          isCoachMove: true,
        }),
        move({
          ply: 3,
          san: 'Bc4',
          classification: 'inaccuracy',
          bestMove: null,
          preMoveEval: 30,
          evaluation: -10,
        }),
      ]);
      const seg = segments[2];
      expect(seg.narration).not.toBeNull();
      // Generic version still mentions the classification family
      expect(seg.narration?.toLowerCase()).toMatch(/inaccuracy|more precise/);
    });

    it('reconstructs fenBefore / fenAfter per ply via chess.js', () => {
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4' }),
        move({ ply: 2, san: 'e5', isCoachMove: true }),
      ]);
      expect(segments).toHaveLength(2);
      expect(segments[0].fenBefore).toContain('rnbqkbnr/pppppppp');
      expect(segments[0].fenAfter).toContain('4P3');
      expect(segments[1].fenBefore).toBe(segments[0].fenAfter);
    });

    it('stops at the first illegal SAN without crashing', () => {
      const segments = buildReviewSegments([
        move({ ply: 1, san: 'e4' }),
        move({ ply: 2, san: 'NOT_A_MOVE', isCoachMove: true }),
        move({ ply: 3, san: 'Nf3' }),
      ]);
      // Only the first move could replay; the chain truncates at the
      // bad SAN. Better one usable ply than refusing the whole review.
      expect(segments).toHaveLength(1);
      expect(segments[0].san).toBe('e4');
    });
  });
});
