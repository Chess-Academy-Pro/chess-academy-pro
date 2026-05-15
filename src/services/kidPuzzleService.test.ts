import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePuzzleFen, generateKidPuzzles } from './kidPuzzleService';
import { buildUserProfile } from '../test/factories';
import type { JourneyChapter } from '../types';

// Mock the coachApi module
vi.mock('./coachApi', () => ({
  getCoachChatResponse: vi.fn(),
}));

const MOCK_CHAPTER: JourneyChapter = {
  id: 'pawn',
  title: 'The Brave Pawn',
  subtitle: 'Learn how pawns move and capture',
  icon: '\u265F',
  storyIntro: 'Once upon a time...',
  storyOutro: 'Amazing!',
  requiredPuzzleScore: 2,
  lessons: [
    {
      id: 'pawn-lesson-1',
      title: 'First Steps',
      story: 'Pawns move forward.',
      fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
      highlightSquares: ['e3', 'e4'],
      instruction: 'Move the pawn.',
    },
  ],
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

  describe('generateKidPuzzles', () => {
    let mockGetCoachChatResponse: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const coachApi = await import('./coachApi');
      mockGetCoachChatResponse = coachApi.getCoachChatResponse as ReturnType<typeof vi.fn>;
      mockGetCoachChatResponse.mockReset();
    });

    it('parses valid AI-generated puzzles', async () => {
      const aiResponse = JSON.stringify([
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'e4',
          hint: 'Push the pawn!',
          successMessage: 'Well done!',
        },
        {
          fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
          solution: 'dxe5',
          hint: 'Capture!',
          successMessage: 'You got it!',
        },
        {
          fen: '4k3/8/8/8/4P3/8/8/4K3 w - - 0 1',
          solution: 'e5',
          hint: 'Push forward!',
          successMessage: 'Nice!',
        },
      ]);

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile({ currentRating: 600, level: 1 });
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toHaveLength(3);
      expect(puzzles[0].id).toBe('ai-pawn-1');
      expect(puzzles[0].solution).toEqual(['e4']);
      expect(puzzles[0].hint).toBe('Push the pawn!');
    });

    it('handles JSON wrapped in code fences', async () => {
      const aiResponse = '```json\n' + JSON.stringify([
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'e4',
          hint: 'Go!',
          successMessage: 'Yes!',
        },
        {
          fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
          solution: 'dxe5',
          hint: 'Capture!',
          successMessage: 'Great!',
        },
      ]) + '\n```';

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toHaveLength(2);
      expect(puzzles[0].solution).toEqual(['e4']);
    });

    it('filters out puzzles with invalid FEN', async () => {
      const aiResponse = JSON.stringify([
        {
          fen: 'invalid-fen',
          solution: 'e4',
          hint: 'Bad!',
          successMessage: 'No!',
        },
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'e4',
          hint: 'Good!',
          successMessage: 'Yes!',
        },
        {
          fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
          solution: 'dxe5',
          hint: 'Nice!',
          successMessage: 'Great!',
        },
      ]);

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toHaveLength(2);
      expect(puzzles[0].fen).toBe('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    });

    it('filters out puzzles with illegal solution moves', async () => {
      const aiResponse = JSON.stringify([
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'Nf3',
          hint: 'Wrong piece!',
          successMessage: 'No!',
        },
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'e4',
          hint: 'Right!',
          successMessage: 'Yes!',
        },
        {
          fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
          solution: 'dxe5',
          hint: 'Capture!',
          successMessage: 'Great!',
        },
      ]);

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toHaveLength(2);
      expect(puzzles[0].solution).toEqual(['e4']);
    });

    it('falls back to hardcoded puzzles when fewer than 2 valid AI puzzles', async () => {
      const aiResponse = JSON.stringify([
        {
          fen: 'invalid-fen',
          solution: 'e4',
          hint: 'Bad',
          successMessage: 'No',
        },
      ]);

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toBe(MOCK_CHAPTER.puzzles);
    });

    it('falls back to hardcoded puzzles on API error', async () => {
      mockGetCoachChatResponse.mockRejectedValue(new Error('API error'));

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toBe(MOCK_CHAPTER.puzzles);
    });

    it('falls back when response is not valid JSON', async () => {
      mockGetCoachChatResponse.mockResolvedValue('Sorry, I cannot generate puzzles right now.');

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles).toBe(MOCK_CHAPTER.puzzles);
    });

    it('generates puzzle IDs based on chapter and index', async () => {
      const aiResponse = JSON.stringify([
        {
          fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
          solution: 'e4',
          hint: 'Go!',
          successMessage: 'Yes!',
        },
        {
          fen: '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1',
          solution: 'dxe5',
          hint: 'Capture!',
          successMessage: 'Great!',
        },
      ]);

      mockGetCoachChatResponse.mockResolvedValue(aiResponse);

      const profile = buildUserProfile();
      const puzzles = await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(puzzles[0].id).toBe('ai-pawn-1');
      expect(puzzles[1].id).toBe('ai-pawn-2');
    });

    it('includes profile info in the prompt sent to the API', async () => {
      mockGetCoachChatResponse.mockResolvedValue('[]');

      const profile = buildUserProfile({ currentRating: 800, level: 3 });
      await generateKidPuzzles(MOCK_CHAPTER, profile);

      expect(mockGetCoachChatResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
             
            content: expect.stringContaining('800'),
          }),
        ]),
        expect.any(String),
      );
    });
  });
});
