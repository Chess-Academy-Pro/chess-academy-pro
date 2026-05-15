import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChessGame, type MoveResult } from './useChessGame';

vi.mock('../services/stockfishEngine', () => ({
  stockfishEngine: {
    getBestMove: vi.fn(),
  },
}));

import { stockfishEngine } from '../services/stockfishEngine';

// Fool's mate: white king on e1 is checkmated
const FOOLS_MATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';

// Position with white in check (not mate): after 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7+
const CHECK_FEN = 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';

describe('useChessGame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts with the standard opening position', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.turn).toBe('w');
      expect(result.current.inCheck).toBe(false);
      expect(result.current.isCheck).toBe(false);
      expect(result.current.checkSquare).toBeNull();
      expect(result.current.isGameOver).toBe(false);
      expect(result.current.isCheckmate).toBe(false);
      expect(result.current.isStalemate).toBe(false);
      expect(result.current.isDraw).toBe(false);
      expect(result.current.lastMove).toBeNull();
      expect(result.current.history).toHaveLength(0);
      expect(result.current.selectedSquare).toBeNull();
      expect(result.current.legalMoves).toHaveLength(0);
      expect(result.current.boardOrientation).toBe('white');
    });

    it('accepts a custom starting FEN', () => {
      const { result } = renderHook(() => useChessGame(CHECK_FEN));
      expect(result.current.turn).toBe('b');
      expect(result.current.inCheck).toBe(true);
      expect(result.current.isCheck).toBe(true);
    });

    it('exposes position as an alias for fen', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.position).toBe(result.current.fen);
    });

    it('accepts an initialOrientation parameter', () => {
      const { result } = renderHook(() => useChessGame(undefined, 'black'));
      expect(result.current.boardOrientation).toBe('black');
    });
  });

  describe('makeMove', () => {
    it('returns a MoveResult for a valid move', () => {
      const { result } = renderHook(() => useChessGame());
      let moveResult: MoveResult | null = null;
      act(() => {
        moveResult = result.current.makeMove('e2', 'e4');
      });
      expect(moveResult).not.toBeNull();
      expect(moveResult).toMatchObject({ from: 'e2', to: 'e4', san: 'e4' });
      expect(typeof (moveResult as unknown as MoveResult).fen).toBe('string');
    });

    it('returns null for an illegal move', () => {
      const { result } = renderHook(() => useChessGame());
      let moveResult = null;
      act(() => {
        moveResult = result.current.makeMove('e2', 'e5');
      });
      expect(moveResult).toBeNull();
    });

    it('returns null for moving the wrong color', () => {
      const { result } = renderHook(() => useChessGame());
      let moveResult = null;
      act(() => {
        moveResult = result.current.makeMove('e7', 'e5');
      });
      expect(moveResult).toBeNull();
    });

    it('updates turn after a move', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.turn).toBe('w');
      act(() => {
        result.current.makeMove('e2', 'e4');
      });
      expect(result.current.turn).toBe('b');
    });

    it('updates lastMove after a move', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.lastMove).toBeNull();
      act(() => {
        result.current.makeMove('d2', 'd4');
      });
      expect(result.current.lastMove).toEqual({ from: 'd2', to: 'd4' });
    });

    it('updates history after a move', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
      });
      expect(result.current.history).toEqual(['e4']);
    });

    it('handles promotion by auto-queening', () => {
      // White pawn on e7, black king on h8 (queen on e8 will give check along rank 8)
      const promotionFen = '7k/4P3/8/8/8/8/8/4K3 w - - 0 1';
      const { result } = renderHook(() => useChessGame(promotionFen));
      let moveResult: MoveResult | null = null;
      act(() => {
        moveResult = result.current.makeMove('e7', 'e8', 'q');
      });
      expect(moveResult).not.toBeNull();
      expect((moveResult as unknown as MoveResult).san).toBe('e8=Q+');
    });
  });

  describe('getLegalMoves', () => {
    it('returns legal destination squares for a piece', () => {
      const { result } = renderHook(() => useChessGame());
      const moves = result.current.getLegalMoves('e2');
      expect(moves).toContain('e3');
      expect(moves).toContain('e4');
      expect(moves).not.toContain('e5');
    });

    it('returns empty array for an empty square', () => {
      const { result } = renderHook(() => useChessGame());
      const moves = result.current.getLegalMoves('e4');
      expect(moves).toHaveLength(0);
    });

    it('returns empty array for an opponent piece', () => {
      const { result } = renderHook(() => useChessGame());
      // Black's e7 pawn — white to move, so no legal moves for opponent
      const moves = result.current.getLegalMoves('e7');
      expect(moves).toHaveLength(0);
    });

    it('deduplicates promotion squares', () => {
      // White pawn on e7, black king on h8 — pawn can promote on e8
      const promotionFen = '7k/4P3/8/8/8/8/8/4K3 w - - 0 1';
      const { result } = renderHook(() => useChessGame(promotionFen));
      const moves = result.current.getLegalMoves('e7');
      // Pawn can promote to 4 pieces — all to e8, so result should deduplicate
      expect(moves).toEqual(['e8']);
    });
  });

  describe('getPiece', () => {
    it('returns piece info for occupied square', () => {
      const { result } = renderHook(() => useChessGame());
      const piece = result.current.getPiece('e1');
      expect(piece).toMatchObject({ type: 'k', color: 'w' });
    });

    it('returns null for empty square', () => {
      const { result } = renderHook(() => useChessGame());
      const piece = result.current.getPiece('e4');
      expect(piece).toBeNull();
    });
  });

  describe('check detection', () => {
    it('detects when the king is in check', () => {
      const { result } = renderHook(() => useChessGame(CHECK_FEN));
      expect(result.current.inCheck).toBe(true);
    });

    it('returns the correct check square', () => {
      const { result } = renderHook(() => useChessGame(CHECK_FEN));
      // Black king is at e8 and is in check
      expect(result.current.checkSquare).toBe('e8');
    });

    it('returns null checkSquare when not in check', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.checkSquare).toBeNull();
    });
  });

  describe('checkmate detection', () => {
    it("detects checkmate (fool's mate)", () => {
      const { result } = renderHook(() => useChessGame(FOOLS_MATE_FEN));
      expect(result.current.inCheck).toBe(true);
      expect(result.current.isCheckmate).toBe(true);
      expect(result.current.isGameOver).toBe(true);
    });

    it('identifies the mated king square', () => {
      const { result } = renderHook(() => useChessGame(FOOLS_MATE_FEN));
      // White king is on e1 and is checkmated
      expect(result.current.checkSquare).toBe('e1');
    });
  });

  describe('reset / resetGame', () => {
    it('resets to the starting position', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
        result.current.makeMove('e7', 'e5');
      });
      expect(result.current.history).toHaveLength(2);

      act(() => {
        result.current.reset();
      });

      expect(result.current.history).toHaveLength(0);
      expect(result.current.lastMove).toBeNull();
      expect(result.current.turn).toBe('w');
    });

    it('resets to a custom FEN when provided', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.reset(CHECK_FEN);
      });
      expect(result.current.turn).toBe('b');
      expect(result.current.inCheck).toBe(true);
    });

    it('resetGame clears selection state', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.onSquareClick('e2'); // select e2 pawn
      });
      expect(result.current.selectedSquare).toBe('e2');

      act(() => {
        result.current.resetGame();
      });

      expect(result.current.selectedSquare).toBeNull();
      expect(result.current.legalMoves).toHaveLength(0);
    });
  });

  describe('loadFen', () => {
    it('loads a valid FEN and returns true', () => {
      const { result } = renderHook(() => useChessGame());
      let success = false;
      act(() => {
        success = result.current.loadFen(CHECK_FEN);
      });
      expect(success).toBe(true);
      expect(result.current.inCheck).toBe(true);
    });

    it('returns false for an invalid FEN', () => {
      const { result } = renderHook(() => useChessGame());
      let success = true;
      act(() => {
        success = result.current.loadFen('this is not a fen');
      });
      expect(success).toBe(false);
    });

    it('clears lastMove after loading a new FEN', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
      });
      expect(result.current.lastMove).not.toBeNull();

      act(() => {
        result.current.loadFen(CHECK_FEN);
      });
      expect(result.current.lastMove).toBeNull();
    });
  });

  // ─── New WO-02 features ─────────────────────────────────────────────────────

  describe('undoMove', () => {
    it('reverts the last move', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
      });
      expect(result.current.history).toHaveLength(1);

      act(() => {
        result.current.undoMove();
      });

      expect(result.current.history).toHaveLength(0);
      expect(result.current.turn).toBe('w');
    });

    it('restores lastMove to the preceding move', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
        result.current.makeMove('e7', 'e5');
      });
      expect(result.current.lastMove).toEqual({ from: 'e7', to: 'e5' });

      act(() => {
        result.current.undoMove();
      });

      // After undoing e7-e5, lastMove should be e2-e4
      expect(result.current.lastMove).toEqual({ from: 'e2', to: 'e4' });
    });

    it('sets lastMove to null when undoing the first move', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.makeMove('e2', 'e4');
      });

      act(() => {
        result.current.undoMove();
      });

      expect(result.current.lastMove).toBeNull();
    });

    it('clears selection state on undo', () => {
      const { result } = renderHook(() => useChessGame());
      // Make a move so there's something to undo (turn flips to Black)
      act(() => { result.current.makeMove('e2', 'e4'); });
      // Select a Black pawn (it is now Black's turn)
      act(() => { result.current.onSquareClick('e7'); });
      expect(result.current.selectedSquare).toBe('e7');

      act(() => {
        result.current.undoMove();
      });

      expect(result.current.selectedSquare).toBeNull();
    });

    it('does nothing when there are no moves to undo', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.history).toHaveLength(0);
      act(() => {
        result.current.undoMove(); // no-op
      });
      expect(result.current.history).toHaveLength(0);
    });
  });

  describe('flipBoard', () => {
    it('toggles boardOrientation from white to black', () => {
      const { result } = renderHook(() => useChessGame());
      expect(result.current.boardOrientation).toBe('white');

      act(() => {
        result.current.flipBoard();
      });

      expect(result.current.boardOrientation).toBe('black');
    });

    it('toggles back to white on second call', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.flipBoard();
        result.current.flipBoard();
      });
      expect(result.current.boardOrientation).toBe('white');
    });
  });

  describe('onDrop', () => {
    it('executes a valid drop and returns a MoveResult', () => {
      const { result } = renderHook(() => useChessGame());
      let dropResult: ReturnType<typeof result.current.onDrop> = null;

      act(() => {
        dropResult = result.current.onDrop('e2', 'e4');
      });

      expect(dropResult).not.toBeNull();
      expect(dropResult).toMatchObject({ from: 'e2', to: 'e4', san: 'e4' });
      expect(result.current.history).toHaveLength(1);
    });

    it('returns null for an illegal drop', () => {
      const { result } = renderHook(() => useChessGame());
      let dropResult: ReturnType<typeof result.current.onDrop> = null;

      act(() => {
        dropResult = result.current.onDrop('e2', 'e5'); // illegal
      });

      expect(dropResult).toBeNull();
      expect(result.current.history).toHaveLength(0);
    });

    it('clears selection after a drop', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.onSquareClick('e2'); // select
      });
      expect(result.current.selectedSquare).toBe('e2');

      act(() => {
        result.current.onDrop('e2', 'e4');
      });

      expect(result.current.selectedSquare).toBeNull();
    });
  });

  describe('onSquareClick', () => {
    it('selects a piece on first click', () => {
      const { result } = renderHook(() => useChessGame());

      act(() => {
        result.current.onSquareClick('e2');
      });

      expect(result.current.selectedSquare).toBe('e2');
      expect(result.current.legalMoves).toContain('e3');
      expect(result.current.legalMoves).toContain('e4');
    });

    it('deselects when clicking the selected square again', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.onSquareClick('e2');
      });
      expect(result.current.selectedSquare).toBe('e2');

      act(() => {
        result.current.onSquareClick('e2');
      });

      expect(result.current.selectedSquare).toBeNull();
      expect(result.current.legalMoves).toHaveLength(0);
    });

    it('executes a move on second click to legal destination', () => {
      const { result } = renderHook(() => useChessGame());
      // Each click must be a separate act so the hook re-renders with updated
      // selectedSquare before the second onSquareClick closure is evaluated.
      act(() => { result.current.onSquareClick('e2'); }); // select
      act(() => { result.current.onSquareClick('e4'); }); // move

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0]).toBe('e4');
      expect(result.current.selectedSquare).toBeNull();
    });

    it('returns null when just selecting (no move)', () => {
      const { result } = renderHook(() => useChessGame());
      let clickResult: ReturnType<typeof result.current.onSquareClick> = null;

      act(() => {
        clickResult = result.current.onSquareClick('e2');
      });

      expect(clickResult).toBeNull();
    });

    it('returns MoveResult when a move is executed', () => {
      const { result } = renderHook(() => useChessGame());
      let clickResult: ReturnType<typeof result.current.onSquareClick> = null;

      act(() => { result.current.onSquareClick('e2'); }); // select
      act(() => {
        clickResult = result.current.onSquareClick('e4'); // move
      });

      expect(clickResult).not.toBeNull();
      expect(clickResult).toMatchObject({ from: 'e2', to: 'e4' });
    });

    it('clears selection when clicking an empty non-legal square', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.onSquareClick('e2'); // select pawn
      });
      expect(result.current.selectedSquare).toBe('e2');

      act(() => {
        result.current.onSquareClick('e6'); // empty, not legal
      });

      expect(result.current.selectedSquare).toBeNull();
    });

    it('handles castling', () => {
      // White can castle kingside: Ke1-g1
      const castlingFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
      const { result } = renderHook(() => useChessGame(castlingFen));

      act(() => { result.current.onSquareClick('e1'); }); // select king
      act(() => { result.current.onSquareClick('g1'); }); // castle kingside

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0]).toBe('O-O');
    });
  });

  describe('clearSelection', () => {
    it('clears selectedSquare and legalMoves', () => {
      const { result } = renderHook(() => useChessGame());
      act(() => {
        result.current.onSquareClick('e2');
      });
      expect(result.current.selectedSquare).toBe('e2');

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedSquare).toBeNull();
      expect(result.current.legalMoves).toHaveLength(0);
    });
  });

  describe('computer opponent (Stockfish)', () => {
    it('calls Stockfish getBestMove when it is the computer turn', async () => {
      // Computer plays black — after white moves, Stockfish should be called
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);
      getBestMoveMock.mockResolvedValueOnce('e7e5');

      const { result } = renderHook(() => useChessGame(undefined, 'white', 'b'));

      // White makes a move
      act(() => {
        result.current.makeMove('e2', 'e4');
      });

      // Advance past the 500ms delay
      await act(async () => {
        vi.advanceTimersByTime(600);
        await vi.runAllTimersAsync();
      });

      expect(getBestMoveMock).toHaveBeenCalledTimes(1);
      // Should have been called with the FEN after e4
      expect(getBestMoveMock.mock.calls[0][0]).toContain('rnbqkbnr/pppppppp/8/8/4P3');
    });

    it('executes the Stockfish move on the board', async () => {
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);
      getBestMoveMock.mockResolvedValueOnce('e7e5');

      const { result } = renderHook(() => useChessGame(undefined, 'white', 'b'));

      act(() => {
        result.current.makeMove('e2', 'e4');
      });

      // Advance past the 500ms delay and flush the resolved promise
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });

      expect(result.current.turn).toBe('w');
      expect(result.current.history).toEqual(['e4', 'e5']);
    });

    it('does not call Stockfish when computerColor is not set', () => {
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);

      const { result } = renderHook(() => useChessGame());

      act(() => {
        result.current.makeMove('e2', 'e4');
      });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(getBestMoveMock).not.toHaveBeenCalled();
    });

    it('does not call Stockfish when it is not the computer turn', () => {
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);

      // Computer is white, but white has not moved yet — it IS the computer's turn at start
      // Use a position where it's black's turn instead
      renderHook(() => useChessGame(undefined, 'white', 'b'));

      act(() => {
        vi.advanceTimersByTime(600);
      });

      // At start, it's white's turn but computer is black — should not call
      expect(getBestMoveMock).not.toHaveBeenCalled();
    });

    it('falls back to random move when Stockfish fails', async () => {
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);
      getBestMoveMock.mockRejectedValueOnce(new Error('Stockfish failed'));

      const { result } = renderHook(() => useChessGame(undefined, 'white', 'b'));

      act(() => {
        result.current.makeMove('e2', 'e4');
      });

      // Advance past delay and flush the rejected promise + catch handler
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Should still have made a move (random fallback)
      expect(result.current.turn).toBe('w');
      expect(result.current.history).toHaveLength(2);
    });

    it('handles UCI promotion moves', async () => {
      // White pawn on e7, black king on h8, computer plays white — should promote
      const promotionFen = '7k/4P3/8/8/8/8/8/4K3 w - - 0 1';
      const getBestMoveMock = vi.mocked(stockfishEngine.getBestMove);
      getBestMoveMock.mockResolvedValueOnce('e7e8q');

      const { result } = renderHook(() => useChessGame(promotionFen, 'black', 'w'));

      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });

      expect(result.current.turn).toBe('b');
      expect(result.current.history).toHaveLength(1);
    });
  });
});
