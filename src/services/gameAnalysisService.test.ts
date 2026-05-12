import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db/schema';
import { countGamesNeedingAnalysis, analyzeAllGames, analyzeRecentGames } from './gameAnalysisService';
import { buildGameRecord, buildUserProfile } from '../test/factories';
import { useAppStore } from '../stores/appStore';
import type { StockfishAnalysis } from '../types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./stockfishEngine', () => ({
  stockfishEngine: {
    initialize: vi.fn(),
    analyzePosition: vi.fn(),
  },
}));

vi.mock('./weaknessAnalyzer', () => ({
  computeWeaknessProfile: vi.fn(),
}));

vi.mock('./mistakePuzzleService', () => ({
  generateMistakePuzzlesFromGame: vi.fn().mockResolvedValue(0),
}));

import { stockfishEngine } from './stockfishEngine';
import { computeWeaknessProfile } from './weaknessAnalyzer';

const mockAnalyzePosition = vi.mocked(stockfishEngine).analyzePosition;
const mockInitialize = vi.mocked(stockfishEngine).initialize;
const mockComputeWeaknessProfile = vi.mocked(computeWeaknessProfile);

function mockAnalysis(evaluation: number, bestMove: string): StockfishAnalysis {
  return { evaluation, bestMove, isMate: false, mateIn: null, depth: 12, topLines: [], nodesPerSecond: 100000 };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('gameAnalysisService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete();
    await db.open();
    mockInitialize.mockResolvedValue(undefined);
    mockComputeWeaknessProfile.mockResolvedValue({
      computedAt: new Date().toISOString(),
      items: [],
      strengths: [],
      strengthItems: [],
      overallAssessment: '',
    });

    const profile = buildUserProfile();
    useAppStore.getState().setActiveProfile(profile);
    await db.profiles.add(profile);
  });

  describe('countGamesNeedingAnalysis', () => {
    it('returns 0 when no games exist', async () => {
      const count = await countGamesNeedingAnalysis();
      expect(count).toBe(0);
    });

    it('counts games with missing or partial annotations', async () => {
      // Game with full annotations (1 annotation per move) should NOT be counted.
      // Evals are centipawns; `bestMoveEval` present so gameNeedsAnalysis
      // doesn't flag the record as a pre-fix legacy shape.
      const fullPgn = '1. e4 e5 1/2-1/2';
      const fullAnnotations = [
        { moveNumber: 1, color: 'white' as const, san: 'e4', evaluation: 30, bestMove: null, bestMoveEval: 0, classification: 'good' as const, comment: null },
        { moveNumber: 1, color: 'black' as const, san: 'e5', evaluation: 20, bestMove: null, bestMoveEval: 30, classification: 'good' as const, comment: null },
      ];

      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', annotations: null }),
        buildGameRecord({ id: 'g2', annotations: [] }),
        buildGameRecord({ id: 'g3', pgn: fullPgn, annotations: fullAnnotations, fullyAnalyzed: true }),
      ]);

      const count = await countGamesNeedingAnalysis();
      expect(count).toBe(2);
    });

    it('excludes master games', async () => {
      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', annotations: null, isMasterGame: true }),
        buildGameRecord({ id: 'g2', annotations: null, isMasterGame: false }),
      ]);

      const count = await countGamesNeedingAnalysis();
      expect(count).toBe(1);
    });
  });

  describe('analyzeAllGames', () => {
    it('returns 0 and recomputes weakness profile when no games need analysis', async () => {
      const result = await analyzeAllGames();
      expect(result).toBe(0);
      expect(mockComputeWeaknessProfile).toHaveBeenCalledTimes(1);
    });

    it('analyzes games without annotations and writes them back', async () => {
      const game = buildGameRecord({
        id: 'analyze-me',
        pgn: '1. e4 e5 2. Nf3 Nc6 1/2-1/2',
        annotations: null,
        isMasterGame: false,
      });
      await db.games.add(game);

      // Mock Stockfish to return evals for each position (5 positions for 4 half-moves + start)
      mockAnalyzePosition
        .mockResolvedValueOnce(mockAnalysis(30, 'e2e4'))   // start
        .mockResolvedValueOnce(mockAnalysis(25, 'e7e5'))   // after e4
        .mockResolvedValueOnce(mockAnalysis(30, 'g1f3'))   // after e5
        .mockResolvedValueOnce(mockAnalysis(20, 'b8c6'))   // after Nf3
        .mockResolvedValueOnce(mockAnalysis(25, 'd2d4'));  // after Nc6

      const result = await analyzeAllGames();
      expect(result).toBe(1);

      // Verify annotations were written back
      const updated = await db.games.get('analyze-me');
      expect(updated?.annotations).not.toBeNull();
      expect(updated?.annotations?.length).toBe(4);
    });

    it('reports progress during analysis', async () => {
      const game = buildGameRecord({
        id: 'progress-test',
        pgn: '1. e4 e5 1/2-1/2',
        annotations: null,
        isMasterGame: false,
      });
      await db.games.add(game);

      mockAnalyzePosition.mockResolvedValue(mockAnalysis(30, 'e2e4'));

      const progressUpdates: Array<{ phase: string }> = [];
      await analyzeAllGames((progress) => {
        progressUpdates.push({ phase: progress.phase });
      });

      const phases = progressUpdates.map((p) => p.phase);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('computing_weaknesses');
      expect(phases).toContain('done');
    });

    it('skips games that already have full annotations', async () => {
      // Centipawn evals + `bestMoveEval` present + fullyAnalyzed flag —
      // matches the post-ship-1 annotation shape so gameNeedsAnalysis
      // short-circuits.
      await db.games.add(buildGameRecord({
        id: 'already-done',
        pgn: '1. e4 e5 1/2-1/2',
        annotations: [
          { moveNumber: 1, color: 'white', san: 'e4', evaluation: 30, bestMove: null, bestMoveEval: 0, classification: 'good', comment: null },
          { moveNumber: 1, color: 'black', san: 'e5', evaluation: 20, bestMove: null, bestMoveEval: 30, classification: 'good', comment: null },
        ],
        fullyAnalyzed: true,
        isMasterGame: false,
      }));

      const result = await analyzeAllGames();
      expect(result).toBe(0);
      expect(mockAnalyzePosition).not.toHaveBeenCalled();
    });
  });

  describe('analyzeRecentGames', () => {
    it('returns 0 when no games need analysis', async () => {
      const result = await analyzeRecentGames(5);
      expect(result).toBe(0);
      expect(mockAnalyzePosition).not.toHaveBeenCalled();
    });

    it('analyzes only the N most-recent unanalyzed games', async () => {
      // Add 4 games dated oldest → newest. Only the 2 newest should
      // be analyzed when n=2.
      const games = [
        buildGameRecord({ id: 'g-old-1', date: '2024-01-01', pgn: '1. e4 e5 1/2-1/2', annotations: null, isMasterGame: false }),
        buildGameRecord({ id: 'g-old-2', date: '2024-02-01', pgn: '1. e4 e5 1/2-1/2', annotations: null, isMasterGame: false }),
        buildGameRecord({ id: 'g-new-1', date: '2025-12-01', pgn: '1. e4 e5 1/2-1/2', annotations: null, isMasterGame: false }),
        buildGameRecord({ id: 'g-new-2', date: '2026-04-01', pgn: '1. e4 e5 1/2-1/2', annotations: null, isMasterGame: false }),
      ];
      for (const g of games) await db.games.add(g);

      mockAnalyzePosition.mockResolvedValue(mockAnalysis(0, 'e2e4'));

      const result = await analyzeRecentGames(2);
      expect(result).toBe(2);

      const newest = await db.games.get('g-new-2');
      const second = await db.games.get('g-new-1');
      const older = await db.games.get('g-old-2');
      expect(newest?.fullyAnalyzed).toBe(true);
      expect(second?.fullyAnalyzed).toBe(true);
      expect(older?.fullyAnalyzed).toBeUndefined();
    });

    it('reports per-game progress', async () => {
      await db.games.add(buildGameRecord({
        id: 'r1', date: '2026-01-01', pgn: '1. e4 e5 1/2-1/2', annotations: null, isMasterGame: false,
      }));
      mockAnalyzePosition.mockResolvedValue(mockAnalysis(0, 'e2e4'));

      const updates: Array<{ current: number; total: number; label: string }> = [];
      await analyzeRecentGames(5, (p) => updates.push(p));

      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0].label).toMatch(/Analyzing game/);
      expect(updates[updates.length - 1].label).toMatch(/Ready/);
    });
  });
});
