import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/schema';
import {
  buildGameRecord,
  buildMistakePuzzle,
  buildOpeningRecord,
  buildUserProfile,
  resetFactoryCounter,
} from '../test/factories';
import type { CoachGameMove, GameAccuracy, MoveClassificationCounts, PhaseAccuracy, MissedTactic } from '../types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReconstructMovesFromGame = vi.fn<() => CoachGameMove[]>();
const mockCalculateAccuracy = vi.fn<() => GameAccuracy>();
const mockGetClassificationCounts = vi.fn<() => MoveClassificationCounts>();
const mockGetPhaseBreakdown = vi.fn<() => PhaseAccuracy[]>();
const mockDetectMissedTactics = vi.fn<() => MissedTactic[]>();
const mockGetMistakePuzzleStats = vi.fn();

vi.mock('./gameReconstructionService', () => ({
  reconstructMovesFromGame: (...args: unknown[]): unknown => mockReconstructMovesFromGame(...args as []),
}));

vi.mock('./accuracyService', () => ({
  calculateAccuracy: (...args: unknown[]): unknown => mockCalculateAccuracy(...args as []),
  getClassificationCounts: (...args: unknown[]): unknown => mockGetClassificationCounts(...args as []),
}));

vi.mock('./gamePhaseService', () => ({
  getPhaseBreakdown: (...args: unknown[]): unknown => mockGetPhaseBreakdown(...args as []),
}));

vi.mock('./missedTacticService', () => ({
  detectMissedTactics: (...args: unknown[]): unknown => mockDetectMissedTactics(...args as []),
}));

vi.mock('./mistakePuzzleService', () => ({
  getMistakePuzzleStats: (...args: unknown[]): unknown => mockGetMistakePuzzleStats(...args as []),
}));

vi.mock('./openingService', () => ({
  getRepertoireOpenings: vi.fn().mockResolvedValue([]),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyClassifications(): MoveClassificationCounts {
  return { brilliant: 0, great: 0, good: 0, book: 0, miss: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

function buildCoachMove(overrides?: Partial<CoachGameMove>): CoachGameMove {
  return {
    moveNumber: 1,
    san: 'e4',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    isCoachMove: false,
    commentary: '',
    evaluation: 0,
    classification: 'good',
    expanded: false,
    bestMove: 'e4',
    bestMoveEval: 0,
    preMoveEval: 0,
    ...overrides,
  };
}

function setupAnnotatedMocks(): void {
  mockReconstructMovesFromGame.mockReturnValue([
    buildCoachMove({ moveNumber: 1, san: 'e4', classification: 'good', isCoachMove: false }),
    buildCoachMove({ moveNumber: 2, san: 'e5', classification: 'good', isCoachMove: true }),
  ]);
  mockCalculateAccuracy.mockReturnValue({ white: 85, black: 78, moveCount: 2 });
  mockGetClassificationCounts.mockReturnValue(emptyClassifications());
  mockGetPhaseBreakdown.mockReturnValue([]);
  mockDetectMissedTactics.mockReturnValue([]);
  mockGetMistakePuzzleStats.mockResolvedValue({
    total: 0,
    unsolved: 0,
    solved: 0,
    mastered: 0,
    dueCount: 0,
    byClassification: { inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 },
    byPhase: { opening: 0, middlegame: 0, endgame: 0 },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('gameInsightsService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    resetFactoryCounter();
    vi.clearAllMocks();
    setupAnnotatedMocks();
  });

  describe('getOverviewInsights', () => {
    it('returns zeros when no games exist', async () => {
      const { getOverviewInsights } = await import('./gameInsightsService');
      const result = await getOverviewInsights();

      expect(result.totalGames).toBe(0);
      expect(result.wins).toBe(0);
      expect(result.losses).toBe(0);
      expect(result.draws).toBe(0);
      expect(result.winRate).toBe(0);
      expect(result.avgElo).toBe(0);
      expect(result.avgAccuracy).toBe(0);
      expect(result.highestBeaten).toBeNull();
      expect(result.lowestLostTo).toBeNull();
    });

    it('returns correct W/L/D counts and win rates', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      const ann = [{ moveNumber: 1, color: 'white' as const, san: 'e4', evaluation: 0, bestMove: 'e4', classification: 'good' as const }];
      // 2 wins, 1 loss, 1 draw as white (AI opponent = black means player is white)
      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', white: 'TestUser', black: 'AI Coach', result: '1-0', blackElo: 1500, eco: 'C65', annotations: ann }),
        buildGameRecord({ id: 'g2', white: 'TestUser', black: 'AI Coach', result: '1-0', blackElo: 1600, eco: 'C65', annotations: ann }),
        buildGameRecord({ id: 'g3', white: 'TestUser', black: 'AI Coach', result: '0-1', blackElo: 1200, eco: 'C65', annotations: ann }),
        buildGameRecord({ id: 'g4', white: 'TestUser', black: 'AI Coach', result: '1/2-1/2', blackElo: 1400, eco: 'C65', annotations: ann }),
      ]);

      const { getOverviewInsights } = await import('./gameInsightsService');
      const result = await getOverviewInsights();

      expect(result.totalGames).toBe(4);
      expect(result.wins).toBe(2);
      expect(result.losses).toBe(1);
      expect(result.draws).toBe(1);
      expect(result.winRate).toBe(50);
    });

    it('computes accuracy from fully-analyzed games', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      // Default PGN has 6 plies (1.e4 e5 2.Nf3 Nc6 3.Bb5 a6). Provide an
      // annotation per ply so gameNeedsAnalysis() returns false. Evals
      // are centipawns (White POV) with `bestMoveEval` set — matches
      // the post-ship-1 annotation shape so gameNeedsAnalysis doesn't
      // flag the record as a pre-fix legacy record.
      const fullAnnotations = [
        { moveNumber: 1, color: 'white' as const, san: 'e4', evaluation: 30, bestMove: 'e4', bestMoveEval: 0, classification: 'good' as const, comment: null },
        { moveNumber: 1, color: 'black' as const, san: 'e5', evaluation: 20, bestMove: 'e5', bestMoveEval: 30, classification: 'good' as const, comment: null },
        { moveNumber: 2, color: 'white' as const, san: 'Nf3', evaluation: 30, bestMove: 'Nf3', bestMoveEval: 20, classification: 'good' as const, comment: null },
        { moveNumber: 2, color: 'black' as const, san: 'Nc6', evaluation: 20, bestMove: 'Nc6', bestMoveEval: 30, classification: 'good' as const, comment: null },
        { moveNumber: 3, color: 'white' as const, san: 'Bb5', evaluation: 30, bestMove: 'Bb5', bestMoveEval: 20, classification: 'good' as const, comment: null },
        { moveNumber: 3, color: 'black' as const, san: 'a6', evaluation: 20, bestMove: 'a6', bestMoveEval: 30, classification: 'good' as const, comment: null },
      ];

      await db.games.add(
        buildGameRecord({
          id: 'g1',
          white: 'TestUser',
          black: 'AI Coach',
          result: '1-0',
          blackElo: 1500,
          eco: 'C65',
          annotations: fullAnnotations,
          fullyAnalyzed: true,
        }),
      );

      const { getOverviewInsights } = await import('./gameInsightsService');
      const result = await getOverviewInsights();

      expect(result.analyzedGameCount).toBe(1);
      expect(result.gamesNeedingAnalysis).toBe(0);
      expect(result.avgAccuracy).toBeGreaterThan(0);
      expect(result.accuracyWhite).toBeGreaterThan(0);
    });

    it('treats sparse-annotation games as needing analysis (no accuracy contribution)', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      // Sparse annotations — what detectBlunders() emits on import. The
      // game has 6 plies but only 1 annotation, so it should be flagged
      // as needing analysis and excluded from accuracy averages.
      await db.games.add(
        buildGameRecord({
          id: 'g1',
          white: 'TestUser',
          black: 'AI Coach',
          result: '1-0',
          blackElo: 1500,
          eco: 'C65',
          annotations: [
            { moveNumber: 1, color: 'white', san: 'e4', evaluation: 0.3, bestMove: 'e4', classification: 'good' },
          ],
        }),
      );

      const { getOverviewInsights } = await import('./gameInsightsService');
      const result = await getOverviewInsights();

      expect(result.totalGames).toBe(1);
      expect(result.analyzedGameCount).toBe(0);
      expect(result.gamesNeedingAnalysis).toBe(1);
      expect(result.avgAccuracy).toBe(0);
      expect(result.strengths).not.toContain('1 games with zero blunders');
    });

    it('tracks highest beaten and lowest lost to', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      const ann = [{ moveNumber: 1, color: 'white' as const, san: 'e4', evaluation: 0, bestMove: 'e4', classification: 'good' as const }];
      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', white: 'TestUser', black: 'AI Coach', result: '1-0', blackElo: 1800, annotations: ann }),
        buildGameRecord({ id: 'g2', white: 'TestUser', black: 'AI Coach', result: '1-0', blackElo: 1600, annotations: ann }),
        buildGameRecord({ id: 'g3', white: 'TestUser', black: 'AI Coach', result: '0-1', blackElo: 1100, annotations: ann }),
        buildGameRecord({ id: 'g4', white: 'TestUser', black: 'AI Coach', result: '0-1', blackElo: 1300, annotations: ann }),
      ]);

      const { getOverviewInsights } = await import('./gameInsightsService');
      const result = await getOverviewInsights();

      expect(result.highestBeaten).not.toBeNull();
      expect(result.highestBeaten?.elo).toBe(1800);
      expect(result.lowestLostTo).not.toBeNull();
      expect(result.lowestLostTo?.elo).toBe(1100);
    });
  });

  describe('getOpeningInsights', () => {
    it('groups games by ECO and computes repertoire coverage', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      const { getRepertoireOpenings } = await import('./openingService');
      (getRepertoireOpenings as ReturnType<typeof vi.fn>).mockResolvedValue([
        buildOpeningRecord({ eco: 'C65', name: 'Ruy Lopez' }),
      ]);

      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', white: 'TestUser', black: 'AI Coach', result: '1-0', eco: 'C65' }),
        buildGameRecord({ id: 'g2', white: 'TestUser', black: 'AI Coach', result: '1-0', eco: 'C65' }),
        buildGameRecord({ id: 'g3', white: 'TestUser', black: 'AI Coach', result: '0-1', eco: 'B20' }),
      ]);

      const { getOpeningInsights } = await import('./gameInsightsService');
      const result = await getOpeningInsights();

      expect(result.repertoireCoverage.inBook).toBe(2);
      expect(result.repertoireCoverage.offBook).toBe(1);
      expect(result.mostPlayedWhite.length).toBeGreaterThan(0);
    });

    it('returns empty arrays when no games exist', async () => {
      const { getOpeningInsights } = await import('./gameInsightsService');
      const result = await getOpeningInsights();

      expect(result.repertoireCoverage.inBook).toBe(0);
      expect(result.repertoireCoverage.offBook).toBe(0);
      expect(result.mostPlayedWhite).toEqual([]);
      expect(result.mostPlayedBlack).toEqual([]);
    });
  });

  describe('getMistakeInsights', () => {
    it('counts errors by classification', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      await db.mistakePuzzles.bulkAdd([
        buildMistakePuzzle({ id: 'm1', classification: 'blunder', cpLoss: 300, gamePhase: 'opening', evalBefore: 150, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm2', classification: 'mistake', cpLoss: 100, gamePhase: 'middlegame', evalBefore: 50, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm3', classification: 'inaccuracy', cpLoss: 50, gamePhase: 'endgame', evalBefore: -200, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm4', classification: 'miss', cpLoss: 200, gamePhase: 'middlegame', evalBefore: 0, playerColor: 'white' }),
      ]);

      const { getMistakeInsights } = await import('./gameInsightsService');
      const result = await getMistakeInsights();

      expect(result.errorBreakdown.blunders).toBe(1);
      expect(result.errorBreakdown.mistakes).toBe(1);
      expect(result.errorBreakdown.inaccuracies).toBe(1);
      expect(result.missedWins).toBe(1);
    });

    it('counts errors by phase', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      await db.mistakePuzzles.bulkAdd([
        buildMistakePuzzle({ id: 'm1', classification: 'blunder', cpLoss: 300, gamePhase: 'opening', evalBefore: 0, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm2', classification: 'mistake', cpLoss: 100, gamePhase: 'opening', evalBefore: 0, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm3', classification: 'mistake', cpLoss: 50, gamePhase: 'endgame', evalBefore: 0, playerColor: 'white' }),
      ]);

      const { getMistakeInsights } = await import('./gameInsightsService');
      const result = await getMistakeInsights();

      const openingPhase = result.errorsByPhase.find((p) => p.phase === 'opening');
      const endgamePhase = result.errorsByPhase.find((p) => p.phase === 'endgame');

      expect(openingPhase?.errors).toBe(2);
      expect(endgamePhase?.errors).toBe(1);
    });

    it('counts errors by situation', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      await db.mistakePuzzles.bulkAdd([
        buildMistakePuzzle({ id: 'm1', classification: 'blunder', cpLoss: 300, gamePhase: 'opening', evalBefore: 200, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm2', classification: 'mistake', cpLoss: 100, gamePhase: 'middlegame', evalBefore: 0, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm3', classification: 'mistake', cpLoss: 50, gamePhase: 'endgame', evalBefore: -200, playerColor: 'white' }),
      ]);

      const { getMistakeInsights } = await import('./gameInsightsService');
      const result = await getMistakeInsights();

      expect(result.errorsBySituation.winning).toBe(1);
      expect(result.errorsBySituation.equal).toBe(1);
      expect(result.errorsBySituation.losing).toBe(1);
    });

    it('returns empty state when no mistake puzzles exist', async () => {
      const { getMistakeInsights } = await import('./gameInsightsService');
      const result = await getMistakeInsights();

      expect(result.errorBreakdown.blunders).toBe(0);
      expect(result.errorBreakdown.mistakes).toBe(0);
      expect(result.errorBreakdown.inaccuracies).toBe(0);
      expect(result.avgCpLoss).toBe(0);
      expect(result.costliestMistakes).toEqual([]);
    });

    it('returns costliest mistakes sorted by cpLoss', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      await db.mistakePuzzles.bulkAdd([
        buildMistakePuzzle({ id: 'm1', classification: 'blunder', cpLoss: 500, gamePhase: 'middlegame', playerMoveSan: 'Qh5', evalBefore: 0, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm2', classification: 'mistake', cpLoss: 150, gamePhase: 'opening', playerMoveSan: 'Nf3', evalBefore: 0, playerColor: 'white' }),
        buildMistakePuzzle({ id: 'm3', classification: 'blunder', cpLoss: 800, gamePhase: 'endgame', playerMoveSan: 'Kf1', evalBefore: 0, playerColor: 'white' }),
      ]);

      const { getMistakeInsights } = await import('./gameInsightsService');
      const result = await getMistakeInsights();

      expect(result.costliestMistakes.length).toBe(3);
      expect(result.costliestMistakes[0].cpLoss).toBe(800);
      expect(result.costliestMistakes[1].cpLoss).toBe(500);
    });
  });

  describe('getTacticInsights', () => {
    it('counts brilliant and great moves', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      mockGetClassificationCounts.mockReturnValue({
        ...emptyClassifications(),
        brilliant: 2,
        great: 3,
      });

      await db.games.add(
        buildGameRecord({
          id: 'g1',
          white: 'TestUser',
          black: 'AI Coach',
          result: '1-0',
          eco: 'C65',
          annotations: [
            { moveNumber: 1, color: 'white', san: 'e4', evaluation: 0, bestMove: 'e4', classification: 'brilliant' },
          ],
        }),
      );

      const { getTacticInsights } = await import('./gameInsightsService');
      const result = await getTacticInsights();

      expect(result.tacticsFound.brilliant).toBe(2);
      expect(result.tacticsFound.great).toBe(3);
    });

    it('detects missed tactics', async () => {
      await db.profiles.add(buildUserProfile({ id: 'p1', name: 'TestUser' }));

      mockDetectMissedTactics.mockReturnValue([
        {
          moveIndex: 15,
          playerMoved: 'Nf3',
          bestMove: 'Nxe5',
          fen: 'some-fen',
          evalSwing: -300,
          tacticType: 'fork' as const,
          explanation: 'Missed a knight fork',
        },
      ]);

      await db.games.add(
        buildGameRecord({
          id: 'g1',
          white: 'TestUser',
          black: 'AI Coach',
          result: '0-1',
          eco: 'C65',
          annotations: [
            { moveNumber: 1, color: 'white', san: 'e4', evaluation: 0, bestMove: 'e4', classification: 'good' },
          ],
        }),
      );

      const { getTacticInsights } = await import('./gameInsightsService');
      const result = await getTacticInsights();

      expect(result.worstMisses.length).toBe(1);
      expect(result.missedByType.length).toBe(1);
      expect(result.missedByType[0].type).toBe('fork');
      expect(result.foundVsMissed.missed).toBe(1);
    });

    it('returns empty state when no games exist', async () => {
      const { getTacticInsights } = await import('./gameInsightsService');
      const result = await getTacticInsights();

      expect(result.tacticsFound.brilliant).toBe(0);
      expect(result.tacticsFound.great).toBe(0);
      expect(result.bestSequences).toEqual([]);
      expect(result.worstMisses).toEqual([]);
      expect(result.awarenessRate).toBe(0);
      expect(result.totalGames).toBe(0);
    });
  });

  describe('getGamesByOpening', () => {
    it('returns games filtered by ECO', async () => {
      await db.games.bulkAdd([
        buildGameRecord({ id: 'g1', eco: 'C65', isMasterGame: false }),
        buildGameRecord({ id: 'g2', eco: 'C65', isMasterGame: false }),
        buildGameRecord({ id: 'g3', eco: 'B20', isMasterGame: false }),
        buildGameRecord({ id: 'g4', eco: 'C65', isMasterGame: true }),
      ]);

      const { getGamesByOpening } = await import('./gameInsightsService');
      const result = await getGamesByOpening('C65');

      expect(result.length).toBe(2);
      expect(result.every((g) => g.eco === 'C65' && !g.isMasterGame)).toBe(true);
    });

    it('returns empty array for unknown ECO', async () => {
      const { getGamesByOpening } = await import('./gameInsightsService');
      const result = await getGamesByOpening('Z99');

      expect(result).toEqual([]);
    });
  });
});
