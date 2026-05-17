import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePuzzleFen, generateKidPuzzles } from './kidPuzzleService';
import { buildUserProfile } from '../test/factories';
import type { JourneyChapter, PuzzleRecord } from '../types';

vi.mock('./puzzleService', () => ({
  seedPuzzles: vi.fn().mockResolvedValue(undefined),
  getKidPiecePuzzles: vi.fn(),
}));
vi.mock('./kidRatingService', () => ({
  getKidRating: vi.fn().mockResolvedValue(100),
}));

function dbPuzzle(overrides: Partial<PuzzleRecord> = {}): PuzzleRecord {
  return {
    id: 'p1',
    fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
    moves: 'e2e4',
    rating: 100,
    themes: ['oneMove'],
    openingTags: null,
    popularity: 100,
    nbPlays: 0,
    srsInterval: 0,
    srsEaseFactor: 2.5,
    srsRepetitions: 0,
    srsDueDate: '1970-01-01',
    srsLastReview: null,
    userRating: 100,
    attempts: 0,
    successes: 0,
    ...overrides,
  };
}

const MOCK_PAWN_CHAPTER: JourneyChapter = {
  id: 'pawn',
  title: 'The Brave Pawn',
  subtitle: 'Learn how pawns move and capture',
  icon: '♟',
  storyIntro: 'Once upon a time...',
  storyOutro: 'Amazing!',
  requiredPuzzleScore: 2,
  lessons: [],
  puzzles: [
    {
      id: 'pawn-puzzle-1',
      fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
      solution: ['e4'],
      hint: 'Move two squares!',
      successMessage: 'Great job!',
    },
    {
      id: 'pawn-puzzle-2',
      fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
      solution: ['dxe5'],
      hint: 'Capture diagonally!',
      successMessage: 'You captured!',
    },
  ],
};

const MOCK_TACTICS_CHAPTER: JourneyChapter = {
  ...MOCK_PAWN_CHAPTER,
  id: 'tactics',
  title: 'First Tactics',
};

describe('kidPuzzleService', () => {
  describe('validatePuzzleFen', () => {
    it('returns true for a valid position and legal move', () => {
      expect(validatePuzzleFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e4')).toBe(true);
    });
    it('returns true for a capture move', () => {
      expect(validatePuzzleFen('4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1', 'dxe5')).toBe(true);
    });
    it('returns false for an illegal move', () => {
      expect(validatePuzzleFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e5')).toBe(false);
    });
    it('returns false for an invalid FEN', () => {
      expect(validatePuzzleFen('not-a-fen', 'e4')).toBe(false);
    });
    it('returns false for a move that does not exist', () => {
      expect(validatePuzzleFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'Nf3')).toBe(false);
    });
  });

  describe('generateKidPuzzles (DB-anchored, non-negotiable #17)', () => {
    let mockGetKidPiecePuzzles: ReturnType<typeof vi.fn>;
    let mockGetKidRating: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const puzzleService = await import('./puzzleService');
      const ratingService = await import('./kidRatingService');
      mockGetKidPiecePuzzles = puzzleService.getKidPiecePuzzles as ReturnType<typeof vi.fn>;
      mockGetKidRating = ratingService.getKidRating as ReturnType<typeof vi.fn>;
      mockGetKidPiecePuzzles.mockReset();
      mockGetKidRating.mockResolvedValue(100);
    });

    it('returns DB-sourced puzzles for piece chapters with db- id prefix', async () => {
      mockGetKidPiecePuzzles.mockResolvedValue([
        dbPuzzle({ id: 'abc' }),
        dbPuzzle({ id: 'def', fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1', moves: 'd4e5' }),
      ]);
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);

      expect(puzzles).toHaveLength(2);
      expect(puzzles[0].id).toBe('db-abc');
      expect(puzzles[1].id).toBe('db-def');
      // Solutions converted from UCI → SAN via chess.js.
      expect(puzzles[0].solution).toEqual(['e4']);
      expect(puzzles[1].solution).toEqual(['dxe5']);
      // Static hint comes from the piece-hint template.
      expect(puzzles[0].hint).toContain('pawn');
    });

    it('falls back to chapter.puzzles for non-piece chapters (tactics, first-game)', async () => {
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_TACTICS_CHAPTER, profile);
      expect(puzzles).toBe(MOCK_TACTICS_CHAPTER.puzzles);
      expect(mockGetKidPiecePuzzles).not.toHaveBeenCalled();
    });

    it('reads kid rating via kidRatingService and forwards to the picker', async () => {
      mockGetKidRating.mockResolvedValue(225);
      mockGetKidPiecePuzzles.mockResolvedValue([dbPuzzle(), dbPuzzle({ id: 'p2' })]);
      const profile = buildUserProfile();
      await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);
      expect(mockGetKidRating).toHaveBeenCalledWith('pawn');
      expect(mockGetKidPiecePuzzles).toHaveBeenCalledWith('pawn', 225, expect.any(Number));
    });

    it('falls back to chapter.puzzles when DB returns fewer than 2 puzzles', async () => {
      mockGetKidPiecePuzzles.mockResolvedValue([dbPuzzle()]);
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);
      expect(puzzles).toBe(MOCK_PAWN_CHAPTER.puzzles);
    });

    it('falls back to chapter.puzzles when the picker throws', async () => {
      mockGetKidPiecePuzzles.mockRejectedValue(new Error('Dexie offline'));
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);
      expect(puzzles).toBe(MOCK_PAWN_CHAPTER.puzzles);
    });

    it('skips DB puzzles whose UCI first move is illegal from the FEN', async () => {
      mockGetKidPiecePuzzles.mockResolvedValue([
        // First move e2e5 (3-square pawn push) is illegal — should be dropped.
        dbPuzzle({ id: 'bad', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: 'e2e5' }),
        dbPuzzle({ id: 'ok1' }),
        dbPuzzle({ id: 'ok2', fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1', moves: 'd4e5' }),
      ]);
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);
      expect(puzzles).toHaveLength(2);
      expect(puzzles.map((p) => p.id)).toEqual(['db-ok1', 'db-ok2']);
    });

    it('no AI-id prefix appears in any returned puzzle (non-negotiable #17)', async () => {
      mockGetKidPiecePuzzles.mockResolvedValue([dbPuzzle(), dbPuzzle({ id: 'p2' })]);
      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_PAWN_CHAPTER, profile);
      for (const p of puzzles) {
        expect(p.id.startsWith('ai-')).toBe(false);
      }
    });
  });
});
