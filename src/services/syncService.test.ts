import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/schema';
import { importUserData } from './syncService';
import { exportUserData } from './dbService';
import type { UserProfile } from '../types';
import { buildGameRecord, buildMistakePuzzle, buildSetupPuzzle } from '../test/factories';

function createProfile(): UserProfile {
  return {
    id: 'main',
    name: 'SyncTest',
    isKidMode: false,
    currentRating: 1400,
    puzzleRating: 1400,
    xp: 0,
    level: 1,
    currentStreak: 0,
    longestStreak: 0,
    streakFreezes: 0,
    lastActiveDate: '2026-03-04',
    skillRadar: { opening: 50, tactics: 50, endgame: 50, memory: 50, calculation: 50 },
    badHabits: [],
    preferences: {
      theme: 'dark-premium',
      boardColor: 'classic',
      pieceSet: 'staunton',
      showEvalBar: true,
      showEngineLines: false,
      soundEnabled: true,
      voiceEnabled: true,
      dailySessionMinutes: 45,
      aiProvider: 'deepseek',
      apiKeyEncrypted: null,
      apiKeyIv: null,
      anthropicApiKeyEncrypted: null,
      anthropicApiKeyIv: null,
      preferredModel: { commentary: 'deepseek-chat', analysis: 'deepseek-reasoner', reports: 'deepseek-reasoner' },
      monthlyBudgetCap: null,
      estimatedSpend: 0,
      elevenlabsKeyEncrypted: null,
      elevenlabsKeyIv: null,
      elevenlabsVoiceId: null,
      voiceSpeed: 1.0,
      kokoroEnabled: true,
      kokoroVoiceId: 'af_bella',
      systemVoiceURI: null,
      highlightLastMove: true,
      showLegalMoves: true,
      showCoordinates: true,
      pieceAnimationSpeed: 'medium',
      boardOrientation: true,
      moveQualityFlash: true,
      showHints: true,
      moveMethod: 'both',
      moveConfirmation: false,
      autoPromoteQueen: true,
      pollyEnabled: false,
      pollyVoice: 'ruth',
      masterAllOff: false,
    },
  };
}

describe('syncService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  describe('importUserData', () => {
    it('imports profiles from JSON', async () => {
      const profile = createProfile();
      const json = JSON.stringify({ profiles: [profile] });

      await importUserData(json);

      const imported = await db.profiles.get('main');
      expect(imported).toBeDefined();
      expect(imported?.name).toBe('SyncTest');
    });

    it('imports sessions from JSON', async () => {
      const json = JSON.stringify({
        sessions: [{
          id: 's1',
          date: '2026-03-04',
          profileId: 'main',
          durationMinutes: 30,
          plan: { blocks: [], totalMinutes: 30 },
          completed: true,
          puzzlesSolved: 5,
          puzzleAccuracy: 80,
          xpEarned: 50,
          coachSummary: null,
        }],
      });

      await importUserData(json);

      const sessions = await db.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('s1');
    });

    it('merges data by id (put, not add)', async () => {
      const profile = createProfile();
      await db.profiles.put(profile);

      const updated = { ...profile, name: 'Updated' };
      const json = JSON.stringify({ profiles: [updated] });

      await importUserData(json);

      const result = await db.profiles.get('main');
      expect(result?.name).toBe('Updated');
    });

    it('handles empty JSON gracefully', async () => {
      await importUserData('{}');
      const profiles = await db.profiles.toArray();
      expect(profiles).toHaveLength(0);
    });

    it('imports flashcards', async () => {
      const json = JSON.stringify({
        flashcards: [{
          id: 'fc1',
          openingId: 'op1',
          type: 'best_move',
          questionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          questionText: 'What is the best move?',
          answerMove: 'e4',
          answerText: 'e4 is the best move',
          srsInterval: 1,
          srsEaseFactor: 2.5,
          srsRepetitions: 0,
          srsDueDate: '2026-03-04',
          srsLastReview: null,
        }],
      });

      await importUserData(json);

      const cards = await db.flashcards.toArray();
      expect(cards).toHaveLength(1);
    });

    it('imports games with annotations', async () => {
      const game = buildGameRecord({
        id: 'lichess-abc123',
        annotations: [
          { moveNumber: 1, color: 'white', san: 'e4', evaluation: 0.3, bestMove: null, classification: 'good', comment: null },
          { moveNumber: 1, color: 'black', san: 'e5', evaluation: 0.2, bestMove: null, classification: 'good', comment: null },
        ],
        coachAnalysis: 'Solid opening play.',
      });
      const json = JSON.stringify({ games: [game] });

      await importUserData(json);

      const imported = await db.games.get('lichess-abc123');
      expect(imported).toBeDefined();
      expect(imported?.annotations).toHaveLength(2);
      expect(imported?.coachAnalysis).toBe('Solid opening play.');
    });

    it('imports mistake puzzles', async () => {
      const puzzle = buildMistakePuzzle({ id: 'mp-1', sourceGameId: 'lichess-abc123' });
      const json = JSON.stringify({ mistakePuzzles: [puzzle] });

      await importUserData(json);

      const imported = await db.mistakePuzzles.toArray();
      expect(imported).toHaveLength(1);
      expect(imported[0].sourceGameId).toBe('lichess-abc123');
    });

    it('imports classified tactics', async () => {
      const tactic = {
        id: 'ct-1',
        sourceGameId: 'lichess-abc123',
        moveIndex: 12,
        fen: 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2',
        bestMoveUci: 'e4e5',
        bestMoveSan: 'e5',
        playerMoveUci: 'd2d3',
        playerMoveSan: 'd3',
        playerColor: 'white' as const,
        tacticType: 'fork' as const,
        evalSwing: 2.5,
        explanation: 'Missed a fork',
        opponentName: null,
        gameDate: null,
        openingName: null,
        puzzleAttempts: 0,
        puzzleSuccesses: 0,
        createdAt: '2026-03-04',
      };
      const json = JSON.stringify({ classifiedTactics: [tactic] });

      await importUserData(json);

      const imported = await db.classifiedTactics.toArray();
      expect(imported).toHaveLength(1);
      expect(imported[0].tacticType).toBe('fork');
    });

    it('imports setup puzzles', async () => {
      const puzzle = buildSetupPuzzle({ id: 'sp-1' });
      const json = JSON.stringify({ setupPuzzles: [puzzle] });

      await importUserData(json);

      const imported = await db.setupPuzzles.toArray();
      expect(imported).toHaveLength(1);
    });

    it('imports opening weak spots', async () => {
      const weakSpot = {
        id: 'ows-1',
        openingId: 'italian-game',
        openingName: 'Italian Game',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
        moveIndex: 4,
        correctMoveSan: 'Bc5',
        failCount: 3,
        lastFailedAt: '2026-03-04',
        lastDrilledAt: null,
      };
      const json = JSON.stringify({ openingWeakSpots: [weakSpot] });

      await importUserData(json);

      const imported = await db.openingWeakSpots.toArray();
      expect(imported).toHaveLength(1);
      expect(imported[0].openingName).toBe('Italian Game');
    });
  });

  describe('exportUserData includes games and analysis', () => {
    it('round-trips games through export and import', async () => {
      const game = buildGameRecord({
        id: 'lichess-round-trip',
        annotations: [
          { moveNumber: 1, color: 'white', san: 'e4', evaluation: 0.3, bestMove: null, classification: 'good', comment: null },
        ],
        coachAnalysis: 'Well played.',
      });
      await db.games.put(game);

      const exported = await exportUserData();
      await db.games.clear();
      expect(await db.games.count()).toBe(0);

      await importUserData(exported);

      const restored = await db.games.get('lichess-round-trip');
      expect(restored).toBeDefined();
      expect(restored?.annotations).toHaveLength(1);
      expect(restored?.coachAnalysis).toBe('Well played.');
    });

    it('round-trips mistake puzzles through export and import', async () => {
      const puzzle = buildMistakePuzzle({ id: 'mp-rt' });
      await db.mistakePuzzles.put(puzzle);

      const exported = await exportUserData();
      await db.mistakePuzzles.clear();

      await importUserData(exported);

      const restored = await db.mistakePuzzles.toArray();
      expect(restored).toHaveLength(1);
      expect(restored[0].id).toBe('mp-rt');
    });

    it('round-trips the meta blob (coach memory + rolodex state) — WO-ROLODEX-UI-01 PR-4', async () => {
      // Stand in for whatever the in-app store writes: a serialized
      // coachMemory.v1 entry holding rolodex order state.
      await db.meta.put({
        key: 'coachMemory.v1',
        value: JSON.stringify({
          activeOpeningCardId: { white: 'italian', black: null },
          lastActiveRolodexColor: 'white',
          favoritedAt: { italian: '2026-05-17T00:00:00.000Z' },
          userOrderedFavorites: { white: ['italian'], black: [] },
        }),
      });
      await db.meta.put({ key: 'openingProgress', value: JSON.stringify({ italian: ['walkthrough'] }) });

      const exported = await exportUserData();
      await db.meta.clear();
      expect(await db.meta.count()).toBe(0);

      await importUserData(exported);

      const restored = await db.meta.toArray();
      const byKey = Object.fromEntries(restored.map((r) => [r.key, r.value]));
      expect(byKey['coachMemory.v1']).toBeDefined();
      expect(byKey['openingProgress']).toBeDefined();
      // Value round-trips intact — the importer is opaque about the
      // blob shape, so any serialization-safe payload survives.
      const restoredCoach = JSON.parse(byKey['coachMemory.v1']) as {
        activeOpeningCardId: { white: string | null };
      };
      expect(restoredCoach.activeOpeningCardId.white).toBe('italian');
    });
  });
});
