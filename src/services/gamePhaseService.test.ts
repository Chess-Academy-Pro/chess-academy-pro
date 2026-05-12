import { describe, it, expect } from 'vitest';
import { classifyPhase, countMaterial, getPhaseBreakdown } from './gamePhaseService';
import type { CoachGameMove } from '../types';

describe('countMaterial', () => {
  it('counts full starting position material', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // 2Q(18) + 4R(20) + 4B(12) + 4N(12) + 16P(16) = 78
    expect(countMaterial(fen)).toBe(78);
  });

  it('counts endgame material correctly', () => {
    // K+R vs K+R (no pawns) = 5+5 = 10
    const fen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 40';
    expect(countMaterial(fen)).toBe(10);
  });

  it('counts material with queens and pawns', () => {
    // K+Q+3P vs K+Q+3P = 9+3+9+3 = 24
    const fen = 'q3k3/ppp5/8/8/8/8/PPP5/Q3K3 w - - 0 30';
    expect(countMaterial(fen)).toBe(24);
  });
});

describe('classifyPhase', () => {
  const fullStartFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('classifies early moves as opening', () => {
    expect(classifyPhase(fullStartFen, 1)).toBe('opening');
    expect(classifyPhase(fullStartFen, 10)).toBe('opening');
    expect(classifyPhase(fullStartFen, 20)).toBe('opening'); // full move 10
  });

  it('classifies moves after opening with full material as middlegame', () => {
    expect(classifyPhase(fullStartFen, 21)).toBe('middlegame'); // full move 11
    expect(classifyPhase(fullStartFen, 30)).toBe('middlegame');
  });

  it('classifies low-material positions as endgame', () => {
    const endgameFen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 40';
    expect(classifyPhase(endgameFen, 60)).toBe('endgame');
  });

  it('opening takes priority over endgame-level material in early moves', () => {
    // Even if material is low, early moves are opening
    const lowMaterialFen = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1';
    expect(classifyPhase(lowMaterialFen, 1)).toBe('opening');
  });
});

describe('getPhaseBreakdown', () => {
  const makeMoves = (overrides: Partial<CoachGameMove>[]): CoachGameMove[] =>
    overrides.map((o, i) => ({
      moveNumber: i + 1,
      san: 'e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      isCoachMove: false,
      commentary: '',
      evaluation: 20,
      classification: 'good',
      expanded: false,
      bestMove: 'e2e4',
      bestMoveEval: null,
      preMoveEval: 0,
      ...o,
    }));

  it('returns three phase entries', () => {
    const result = getPhaseBreakdown([], 'white');
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.phase)).toEqual(['opening', 'middlegame', 'endgame']);
  });

  it('counts player moves only', () => {
    const moves = makeMoves([
      { moveNumber: 1, isCoachMove: false },  // white player move
      { moveNumber: 2, isCoachMove: true },   // coach move (skipped)
      { moveNumber: 3, isCoachMove: false },  // white player move
    ]);
    const result = getPhaseBreakdown(moves, 'white');
    const opening = result.find((r) => r.phase === 'opening');
    expect(opening?.moveCount).toBe(2);
  });

  it('counts mistakes correctly', () => {
    const moves = makeMoves([
      { moveNumber: 1, classification: 'blunder' },
      { moveNumber: 3, classification: 'mistake' },
      { moveNumber: 5, classification: 'good' },
      { moveNumber: 7, classification: 'inaccuracy' },
    ]);
    const result = getPhaseBreakdown(moves, 'white');
    const opening = result.find((r) => r.phase === 'opening');
    expect(opening?.mistakes).toBe(3);
  });

  it('skips moves with missing evaluations', () => {
    const moves = makeMoves([
      { moveNumber: 1, evaluation: null },
      { moveNumber: 3, evaluation: 50 },
    ]);
    const result = getPhaseBreakdown(moves, 'white');
    const opening = result.find((r) => r.phase === 'opening');
    expect(opening?.moveCount).toBe(1);
  });

  it('uses harmonic mean so a single blunder drags the phase grade down (ship-2)', () => {
    // One catastrophic blunder + 10 clean moves in the same phase.
    // Under the old arithmetic-mean path this returned ~91%; the
    // win-percent + harmonic-mean path `calculateAccuracy` uses
    // produces a much lower number — the whole point of unifying.
    // All moves use white-player ply indices (odd moveNumbers) so they
    // land in `opening` (fullMoveNumber ≤ 10) for the assertion below.
    const cleanMoves = Array.from({ length: 9 }, (_, i): Partial<CoachGameMove> => ({
      moveNumber: i * 2 + 1,
      evaluation: 30,
      preMoveEval: 20,
      classification: 'good',
    }));
    const blunder: Partial<CoachGameMove> = {
      moveNumber: 19,
      evaluation: -700,
      preMoveEval: 30,
      classification: 'blunder',
    };
    const moves = makeMoves([...cleanMoves, blunder]);
    const result = getPhaseBreakdown(moves, 'white');
    const opening = result.find((r) => r.phase === 'opening');
    expect(opening?.moveCount).toBe(10); // sanity: all 10 moves landed
    // Arithmetic mean would put this in the high 80s; harmonic mean
    // floors near the blunder's per-move accuracy (~0%).
    expect(opening?.accuracy).toBeLessThan(80);
    expect(opening?.mistakes).toBe(1);
  });

  it('skips book moves like calculateAccuracy does (ship-2)', () => {
    // A run of book-classified moves shouldn't lift the phase grade;
    // book moves are excluded from the hero accuracy too.
    const moves = makeMoves([
      { moveNumber: 1, classification: 'book' },
      { moveNumber: 3, classification: 'book' },
      { moveNumber: 5, classification: 'good' },
    ]);
    const result = getPhaseBreakdown(moves, 'white');
    const opening = result.find((r) => r.phase === 'opening');
    expect(opening?.moveCount).toBe(1); // only the non-book move counted
  });
});
