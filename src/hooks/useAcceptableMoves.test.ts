import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAcceptableMoves } from './useAcceptableMoves';

vi.mock('../services/stockfishEngine', () => ({
  stockfishEngine: {
    analyzePosition: vi.fn(),
  },
}));

import { stockfishEngine } from '../services/stockfishEngine';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAcceptableMoves', () => {
  it('starts empty + loading when enabled', () => {
    vi.mocked(stockfishEngine.analyzePosition).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAcceptableMoves({ fen: FEN }));
    expect(result.current.sans).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('is inert when enabled=false', () => {
    const { result } = renderHook(() => useAcceptableMoves({ fen: FEN, enabled: false }));
    expect(result.current.sans).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(stockfishEngine.analyzePosition).not.toHaveBeenCalled();
  });

  it('includes lines within the cp tolerance', async () => {
    vi.mocked(stockfishEngine.analyzePosition).mockResolvedValue({
      bestMove: 'e2e4',
      evaluation: 30,
      isMate: false,
      mateIn: null,
      depth: 12,
      topLines: [
        { rank: 1, evaluation: 30, moves: ['e2e4'], mate: null },
        { rank: 2, evaluation: 25, moves: ['d2d4'], mate: null },
        { rank: 3, evaluation: -50, moves: ['a2a3'], mate: null },
      ],
      nodesPerSecond: 0,
    });
    const { result } = renderHook(() => useAcceptableMoves({ fen: FEN, toleranceCp: 30 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sans).toEqual(['e4', 'd4']);
  });

  it('rejects lines outside the tolerance', async () => {
    vi.mocked(stockfishEngine.analyzePosition).mockResolvedValue({
      bestMove: 'e2e4',
      evaluation: 100,
      isMate: false,
      mateIn: null,
      depth: 12,
      topLines: [
        { rank: 1, evaluation: 100, moves: ['e2e4'], mate: null },
        { rank: 2, evaluation: 10, moves: ['d2d4'], mate: null },
      ],
      nodesPerSecond: 0,
    });
    const { result } = renderHook(() => useAcceptableMoves({ fen: FEN, toleranceCp: 30 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sans).toEqual(['e4']);
  });

  it('handles black to move (evaluation sign-flipped)', async () => {
    const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    vi.mocked(stockfishEngine.analyzePosition).mockResolvedValue({
      bestMove: 'e7e5',
      // From white's perspective: black's best line scores -30 (good for black).
      evaluation: -30,
      isMate: false,
      mateIn: null,
      depth: 12,
      topLines: [
        { rank: 1, evaluation: -30, moves: ['e7e5'], mate: null },
        { rank: 2, evaluation: -25, moves: ['c7c5'], mate: null },
      ],
      nodesPerSecond: 0,
    });
    const { result } = renderHook(() => useAcceptableMoves({ fen: BLACK_TO_MOVE, toleranceCp: 30 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sans).toEqual(['e5', 'c5']);
  });

  it('returns empty when Stockfish rejects', async () => {
    vi.mocked(stockfishEngine.analyzePosition).mockRejectedValue(new Error('engine fail'));
    const { result } = renderHook(() => useAcceptableMoves({ fen: FEN }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sans).toEqual([]);
  });
});
