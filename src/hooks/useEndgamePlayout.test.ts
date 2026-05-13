/** Tests for the multi-ply endgame playout runner. */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/coachPlaySession', () => ({
  resolveConfig: vi.fn(() => ({ skill: 8, moveTimeMs: 500, label: 'Easy' })),
  getCoachMove: vi.fn(),
}));

import { useEndgamePlayout } from './useEndgamePlayout';
import { getCoachMove } from '../services/coachPlaySession';
import type { PieceDropHandlerArgs } from 'react-chessboard';

const drop = (sourceSquare: string, targetSquare: string): PieceDropHandlerArgs =>
  ({ sourceSquare, targetSquare, piece: { pieceType: 'wp' } }) as unknown as PieceDropHandlerArgs;

// K+P endgame: White to play, push the passed pawn. 1.a5 Ke5 2.a6 ...
const KP_FEN = '8/8/8/5k2/P7/8/8/2K5 w - - 0 1';

describe('useEndgamePlayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('curated line — happy path', () => {
    it('starts in student-to-move phase with the first expected SAN', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5', 'Ke5', 'a6', 'Kd5', 'a7', 'Kc6', 'a8=Q+'],
        }),
      );
      expect(result.current.phase).toBe('student-to-move');
      expect(result.current.expectedSan).toBe('a5');
      expect(result.current.studentSide).toBe('white');
      expect(result.current.curatedStudentMoves).toBe(4);
      expect(result.current.firstTryPerfect).toBe(true);
      expect(result.current.studentMovesPlayed).toBe(0);
    });

    it('accepts the correct first move and auto-plays the opponent reply', async () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5', 'Ke5', 'a6', 'Kd5'],
          replyDelayMs: 0,
        }),
      );
      let accepted = false;
      act(() => {
        accepted = result.current.onPieceDrop(drop('a4', 'a5'));
      });
      expect(accepted).toBe(true);
      // Wait for the async opponent reply to land.
      await waitFor(() => {
        expect(result.current.studentMovesPlayed).toBe(1);
      });
      await waitFor(() => {
        expect(result.current.phase).toBe('student-to-move');
      });
      expect(result.current.expectedSan).toBe('a6');
      expect(result.current.firstTryPerfect).toBe(true);
    });

    it('reaches complete after the curated line is fully played', async () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5', 'Ke5', 'a6'],
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('a4', 'a5'));
      });
      await waitFor(() => {
        expect(result.current.studentMovesPlayed).toBe(1);
      });
      await waitFor(() => {
        expect(result.current.phase).toBe('student-to-move');
      });
      act(() => {
        result.current.onPieceDrop(drop('a5', 'a6'));
      });
      await waitFor(() => {
        expect(result.current.isComplete).toBe(true);
      });
      expect(result.current.firstTryPerfect).toBe(true);
    });
  });

  describe('curated line — wrong moves', () => {
    it('rejects a wrong move, flashes the destination, drops first-try-perfect', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5', 'Ke5'],
          replyDelayMs: 0,
        }),
      );
      let accepted = true;
      act(() => {
        // Wrong move: pushing the king, not the pawn.
        accepted = result.current.onPieceDrop(drop('c1', 'c2'));
      });
      expect(accepted).toBe(false);
      expect(result.current.wrongAttempts).toBe(1);
      expect(result.current.wrongSquare).toBe('c2');
      expect(result.current.firstTryPerfect).toBe(false);
      expect(result.current.studentMovesPlayed).toBe(0);
    });

    it('still accepts the right move after wrong attempts', async () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('c1', 'c2'));
      });
      expect(result.current.wrongAttempts).toBe(1);
      act(() => {
        result.current.onPieceDrop(drop('a4', 'a5'));
      });
      await waitFor(() => {
        expect(result.current.isComplete).toBe(true);
      });
      expect(result.current.wrongAttempts).toBe(0);
      expect(result.current.firstTryPerfect).toBe(false);
    });

    it('rejects illegal moves (returns false, no state change)', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          replyDelayMs: 0,
        }),
      );
      let accepted = true;
      act(() => {
        // Illegal: a4 to b6 isn't a pawn move
        accepted = result.current.onPieceDrop(drop('a4', 'b6'));
      });
      expect(accepted).toBe(false);
      expect(result.current.wrongAttempts).toBe(0);
      expect(result.current.firstTryPerfect).toBe(true);
    });
  });

  describe('acceptableSans (Phase 6 — eval-tolerant gate)', () => {
    it('accepts an alternate SAN as if it were curated-correct', async () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          // Alternative: just push the king to the centre instead.
          // In the real review flow this comes from useAcceptableMoves'
          // multipv eval; here we hand it in directly.
          acceptableSans: ['Kd2'],
          replyDelayMs: 0,
        }),
      );
      let accepted = false;
      act(() => {
        accepted = result.current.onPieceDrop(drop('c1', 'd2'));
      });
      expect(accepted).toBe(true);
      expect(result.current.wrongAttempts).toBe(0);
      expect(result.current.firstTryPerfect).toBe(true);
      await waitFor(() => {
        expect(result.current.studentMovesPlayed).toBe(1);
      });
    });

    it('still rejects moves outside the acceptable set', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          acceptableSans: ['Kd2'],
          replyDelayMs: 0,
        }),
      );
      let accepted = true;
      act(() => {
        // Pushing the king backwards is neither expected nor in the
        // acceptable set — should flash red as before.
        accepted = result.current.onPieceDrop(drop('c1', 'b1'));
      });
      expect(accepted).toBe(false);
      expect(result.current.wrongAttempts).toBe(1);
      expect(result.current.firstTryPerfect).toBe(false);
    });

    it('is inert when acceptableSans is omitted (strict mode preserved)', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          replyDelayMs: 0,
        }),
      );
      let accepted = true;
      act(() => {
        accepted = result.current.onPieceDrop(drop('c1', 'd2'));
      });
      expect(accepted).toBe(false);
      expect(result.current.wrongAttempts).toBe(1);
    });
  });

  describe('reveal and reset', () => {
    it('reveal auto-plays the remaining curated line and marks complete', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5', 'Ke5', 'a6'],
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.reveal();
      });
      expect(result.current.isComplete).toBe(true);
      expect(result.current.firstTryPerfect).toBe(false);
    });

    it('reset returns to the starting position and re-arms the playout', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'],
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('c1', 'c2'));
      });
      expect(result.current.wrongAttempts).toBe(1);
      act(() => {
        result.current.reset();
      });
      expect(result.current.wrongAttempts).toBe(0);
      expect(result.current.firstTryPerfect).toBe(true);
      expect(result.current.fen).toBe(KP_FEN);
      expect(result.current.phase).toBe('student-to-move');
    });
  });

  describe('bestMove fallback', () => {
    it('uses bestMove as a single-move curated line when solution is empty', async () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: [],
          bestMove: 'a5',
          replyDelayMs: 0,
        }),
      );
      expect(result.current.expectedSan).toBe('a5');
      expect(result.current.curatedStudentMoves).toBe(1);
      act(() => {
        result.current.onPieceDrop(drop('a4', 'a5'));
      });
      await waitFor(() => {
        expect(result.current.isComplete).toBe(true);
      });
    });

    it('marks complete immediately when no solution and no bestMove', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: [],
        }),
      );
      expect(result.current.phase).toBe('complete');
      expect(result.current.isComplete).toBe(true);
    });
  });

  describe('natural endpoints (David\'s Photo 1: play past the critical moment)', () => {
    it('terminates on student-delivered checkmate without asking for an engine reply', async () => {
      // K+Q vs K, queen delivers mate in one. There should be no
      // engine reply requested — chess.js says the game is over.
      const MATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: MATE_FEN,
          solution: [], // no curated moves — straight into fallback
          bestMove: 'Qg7#',
          stockfishFallback: true,
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('f7', 'g7'));
      });
      await waitFor(() => {
        expect(result.current.phase).toBe('complete');
      });
      expect(getCoachMove).not.toHaveBeenCalled();
    });

    it('terminates after the student promotes (obvious-win signal)', async () => {
      // 7th-rank pawn one push from promotion, with king escort.
      // a8=Q ends the playout immediately even though there's no
      // checkmate yet — promotion is the obvious-win cue David
      // wanted us to honor.
      const PROMO_FEN = '8/P7/K7/8/8/8/8/4k3 w - - 0 1';
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: PROMO_FEN,
          solution: [],
          bestMove: 'a8=Q',
          stockfishFallback: true,
          fallbackPliesToPlay: 8,
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('a7', 'a8'));
      });
      await waitFor(() => {
        expect(result.current.phase).toBe('complete');
      });
      expect(getCoachMove).not.toHaveBeenCalled();
    });
  });

  describe('Stockfish fallback (Eval Lab stage 2)', () => {
    it('hands off to getCoachMove after the curated line ends', async () => {
      vi.mocked(getCoachMove).mockResolvedValueOnce({
        uci: 'f5e5',
        from: 'f5',
        to: 'e5',
      });
      vi.mocked(getCoachMove).mockResolvedValueOnce({
        uci: 'e5d5',
        from: 'e5',
        to: 'd5',
      });
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KP_FEN,
          solution: ['a5'], // curated student move; opponent reply comes from engine
          stockfishFallback: true,
          fallbackPliesToPlay: 2,
          replyDelayMs: 0,
        }),
      );
      act(() => {
        result.current.onPieceDrop(drop('a4', 'a5'));
      });
      // After the student's only curated move, the runner should
      // request a Stockfish reply.
      await waitFor(() => {
        expect(getCoachMove).toHaveBeenCalled();
      });
    });
  });

  describe('free-play (Phase 7c — piece-mate fundamentals)', () => {
    // K+Q vs K, white to move, free play: no curated line.
    const KQ_VS_K = '8/8/8/8/8/3k4/8/3K3Q w - - 0 1';

    it('starts in student-to-move when solution is empty AND stockfishFallback is true', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KQ_VS_K,
          solution: [],
          stockfishFallback: true,
          fallbackPliesToPlay: 30,
          replyDelayMs: 0,
        }),
      );
      expect(result.current.phase).toBe('student-to-move');
      expect(result.current.curatedStudentMoves).toBe(0);
    });

    it('keeps the legacy "complete on empty solution" behavior when stockfishFallback is off', () => {
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KQ_VS_K,
          solution: [],
          stockfishFallback: false,
          replyDelayMs: 0,
        }),
      );
      expect(result.current.phase).toBe('complete');
    });

    it('accepts any legal student move and requests a Stockfish reply', async () => {
      vi.mocked(getCoachMove).mockResolvedValueOnce({
        uci: 'd3c3',
        from: 'd3',
        to: 'c3',
      });
      const { result } = renderHook(() =>
        useEndgamePlayout({
          startFen: KQ_VS_K,
          solution: [],
          stockfishFallback: true,
          fallbackPliesToPlay: 30,
          replyDelayMs: 0,
        }),
      );
      // Free play: any legal queen move is acceptable.
      let accepted = false;
      act(() => {
        accepted = result.current.onPieceDrop(drop('h1', 'h3'));
      });
      expect(accepted).toBe(true);
      expect(result.current.wrongAttempts).toBe(0);
      await waitFor(() => {
        expect(getCoachMove).toHaveBeenCalled();
      });
    });
  });
});
