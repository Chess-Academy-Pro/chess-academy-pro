import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lookupTablebase, _internals } from './lichessTablebaseService';

describe('lichessTablebaseService', () => {
  describe('countPieces', () => {
    it('counts pieces in a fresh-board FEN', () => {
      expect(_internals.countPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(32);
    });

    it('counts pieces in a 7-piece endgame FEN', () => {
      // Lucena setup from the rook-endings catalog: 5 pieces.
      expect(_internals.countPieces('1K6/1P6/8/8/2k5/8/r7/4R3 w - - 0 1')).toBe(5);
    });

    it('counts a king + pawn vs king position (3 pieces)', () => {
      expect(_internals.countPieces('8/4k3/8/4K3/4P3/8/8/8 w - - 0 1')).toBe(3);
    });
  });

  describe('whiteRelative translation', () => {
    it('translates "win" with white to move to "white-wins"', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'win')).toBe('white-wins');
    });

    it('translates "win" with black to move to "black-wins"', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k b - - 0 1', 'win')).toBe('black-wins');
    });

    it('translates "loss" with white to move to "black-wins"', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'loss')).toBe('black-wins');
    });

    it('translates "draw" to "draw" regardless of side to move', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'draw')).toBe('draw');
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k b - - 0 1', 'draw')).toBe('draw');
    });

    it('treats cursed-win and maybe-win as wins', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'cursed-win')).toBe('white-wins');
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'maybe-win')).toBe('white-wins');
    });

    it('treats blessed-loss and maybe-loss as losses', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'blessed-loss')).toBe('black-wins');
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'maybe-loss')).toBe('black-wins');
    });

    it('returns null for unknown category', () => {
      expect(_internals.whiteRelative('8/8/8/8/8/8/8/K6k w - - 0 1', 'unknown')).toBeNull();
    });
  });

  describe('lookupTablebase', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns null for positions with >7 pieces (out of range)', async () => {
      const result = await lookupTablebase(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      );
      expect(result).toBeNull();
    });

    it('parses a successful tablebase response into the lookup shape', async () => {
      const mockJson = {
        category: 'draw',
        dtm: null,
        dtz: 0,
        checkmate: false,
        stalemate: false,
        insufficient_material: true,
      };
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockJson), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await lookupTablebase('8/8/8/8/8/8/8/K6k w - - 0 1');
      expect(result).not.toBeNull();
      expect(result?.category).toBe('draw');
      expect(result?.whiteRelativeResult).toBe('draw');
      expect(result?.insufficientMaterial).toBe(true);
    });

    it('returns null on HTTP failure', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('upstream-blocked', { status: 502 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await lookupTablebase('8/8/8/8/8/8/8/K6k w - - 0 1');
      expect(result).toBeNull();
    });

    it('returns null on network exception', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await lookupTablebase('8/8/8/8/8/8/8/K6k w - - 0 1');
      expect(result).toBeNull();
    });

    it('translates "win" with side-to-move correctly into white-relative', async () => {
      // Black to move, tablebase says "win" → black-wins.
      const mockJson = {
        category: 'win',
        dtm: 8,
        dtz: 8,
        checkmate: false,
        stalemate: false,
        insufficient_material: false,
      };
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockJson), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await lookupTablebase('8/4k3/8/4K3/4P3/8/8/8 b - - 0 1');
      expect(result?.whiteRelativeResult).toBe('black-wins');
    });
  });
});
