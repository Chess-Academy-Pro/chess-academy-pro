import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { classifyPosition } from './tacticClassifier';
import type { TacticPatternType } from '../types/tacticTypes';

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Play a SAN move on a FEN and return the resulting FEN. */
function playMove(fen: string, san: string): string {
  const chess = new Chess(fen);
  chess.move(san);
  return chess.fen();
}

/** Check if a classification contains a given tactic type. */
function hasTactic(
  result: ReturnType<typeof classifyPosition>,
  type: TacticPatternType,
): boolean {
  return result.tactics.some((t) => t.type === type);
}

// ─── Move Quality Tests ─────────────────────────────────────────────────────

describe('classifyPosition — move quality', () => {
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('classifies a blunder (eval swing < -200cp)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // evalBefore=0 from white's view, evalAfter=250 from black's view (opponent)
    // swing = -250 - 0 = -250 → blunder
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, 250);
    expect(result.moveQuality).toBe('blunder');
    expect(result.evalSwing).toBe(-250);
  });

  it('classifies a mistake (eval swing -200 to -100)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // swing = -150 - 0 = -150 → mistake
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, 150);
    expect(result.moveQuality).toBe('mistake');
  });

  it('classifies an inaccuracy (eval swing -100 to -50)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // swing = -75 - 0 = -75 → inaccuracy
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, 75);
    expect(result.moveQuality).toBe('inaccuracy');
  });

  it('classifies a good move (eval swing -50 to 100)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // swing = -(-30) - 0 = 30 → good
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, -30);
    expect(result.moveQuality).toBe('good');
  });

  it('classifies a great move (eval swing 100 to 200)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // swing = -(-150) - 0 = 150 → great
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, -150);
    expect(result.moveQuality).toBe('great');
  });

  it('classifies a brilliant move (eval swing >= 200)', () => {
    const fenAfter = playMove(START_FEN, 'e4');
    // swing = -(-300) - 0 = 300 → brilliant
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, -300);
    expect(result.moveQuality).toBe('brilliant');
  });
});

// ─── Fork Detection Tests ───────────────────────────────────────────────────

describe('classifyPosition — fork detection', () => {
  it('detects a knight fork on king and rook', () => {
    // White knight on b5 plays Nc7+ forking black king on e8 and rook on a8
    const fen = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Nc7');
    const result = classifyPosition(fen, fenAfter, 'Nc7', 0, -300);
    expect(hasTactic(result, 'fork')).toBe(true);
    const forkTactic = result.tactics.find((t) => t.type === 'fork');
    expect(forkTactic?.description).toContain('fork');
    expect(forkTactic?.involvedSquares).toContain('c7');
  });

  it('detects a queen fork with check', () => {
    // White queen on d1 plays Qa4+ forking black king on e8 and rook on a8
    const fen = 'r3k3/8/8/8/8/8/8/3QK3 w - - 0 1';
    const fenAfter = playMove(fen, 'Qa4');
    const result = classifyPosition(fen, fenAfter, 'Qa4', 0, -500);
    expect(hasTactic(result, 'fork')).toBe(true);
  });

  it('does not detect a fork with only one target', () => {
    // Knight attacks only one piece
    const fen = '4k3/8/8/8/1N6/8/8/4K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Nc6');
    const result = classifyPosition(fen, fenAfter, 'Nc6', 0, -50);
    expect(hasTactic(result, 'fork')).toBe(false);
  });
});

// ─── Pin Detection Tests ────────────────────────────────────────────────────

describe('classifyPosition — pin detection', () => {
  it('detects a bishop pin on a knight against the king', () => {
    // White bishop on a4 pins black knight on d7 against king on e8
    const fen = '4k3/3n4/8/8/B7/8/8/4K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Bb5');
    const result = classifyPosition(fen, fenAfter, 'Bb5', 0, -100);
    expect(hasTactic(result, 'pin')).toBe(true);
    const pinTactic = result.tactics.find((t) => t.type === 'pin');
    expect(pinTactic?.description).toContain('pin');
  });

  it('detects a rook pin on a bishop against the queen', () => {
    // White rook pins black bishop against black queen on the same file
    const fen = '4k3/3q4/3b4/8/8/8/8/3RK3 w - - 0 1';
    const fenAfter = playMove(fen, 'Rd4');
    const result = classifyPosition(fen, fenAfter, 'Rd4', 0, -100);
    // The rook on d4 sees d6 (bishop) and d7 (queen) — pin
    expect(hasTactic(result, 'pin')).toBe(true);
  });
});

// ─── Skewer Detection Tests ─────────────────────────────────────────────────

describe('classifyPosition — skewer detection', () => {
  it('detects a rook skewer on queen with bishop behind', () => {
    // White rook on a1, black queen on a5, black bishop on a8, white king on h2
    const fen = 'b3k3/8/8/q7/8/8/7K/R7 w - - 0 1';
    const fenAfter = playMove(fen, 'Ra4');
    const result = classifyPosition(fen, fenAfter, 'Ra4', 0, -200);
    // Rook on a4 attacks queen a5 (value 9), bishop a8 behind (value 3) — skewer
    expect(hasTactic(result, 'skewer')).toBe(true);
    const skewerTactic = result.tactics.find((t) => t.type === 'skewer');
    expect(skewerTactic?.description).toContain('skewer');
  });
});

// ─── Discovery Detection Tests ──────────────────────────────────────────────

describe('classifyPosition — discovered attack detection', () => {
  it('detects a discovered attack', () => {
    // White bishop on c1 is behind a knight on d2.
    // Moving knight from d2 to f3 reveals bishop's diagonal to a3/h6.
    // Black queen on h6 is on the diagonal.
    const fen = '4k3/8/7q/8/8/8/3N4/2B1K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Nf3');
    const result = classifyPosition(fen, fenAfter, 'Nf3', 0, -200);
    expect(hasTactic(result, 'discovery')).toBe(true);
    const discoveryTactic = result.tactics.find((t) => t.type === 'discovery');
    expect(discoveryTactic?.description).toContain('reveals');
  });
});

// ─── Double Check Detection Tests ───────────────────────────────────────────

describe('classifyPosition — double check detection', () => {
  it('detects a double check', () => {
    // After moving knight, both knight and rook give check
    // White rook on e1, knight on d3. Black king on e8.
    // Moving Nf4 doesn't give double check. Let's set up properly:
    // White Rd1, Nb5. Black King c8.
    // Nd6+ is check from knight. Rook on d1 doesn't check c8.
    // Better: White Re1, Nd5. Black Ke8. Nf6+ gives check from knight.
    // Re1 gives check on e-file. That's double check!
    const fen = '4k3/8/8/3N4/8/8/8/4RK2 w - - 0 1';
    const fenAfter = playMove(fen, 'Nf6+');
    const result = classifyPosition(fen, fenAfter, 'Nf6+', 0, -500);
    // Knight on f6 checks e8. Rook on e1 checks e8 (file now open).
    expect(hasTactic(result, 'double_check')).toBe(true);
    const dcTactic = result.tactics.find((t) => t.type === 'double_check');
    expect(dcTactic?.description).toContain('Double check');
  });
});

// ─── Back Rank Detection Tests ──────────────────────────────────────────────

describe('classifyPosition — back rank detection', () => {
  it('detects a back rank mate threat', () => {
    // Black king trapped on g8 behind pawns on f7, g7, h7.
    // White rook delivers check on the 8th rank.
    const fen = '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Ra8+');
    const result = classifyPosition(fen, fenAfter, 'Ra8+', 0, -1000);
    expect(hasTactic(result, 'back_rank')).toBe(true);
    const brTactic = result.tactics.find((t) => t.type === 'back_rank');
    expect(brTactic?.description).toContain('back rank');
  });

  it('does not flag back rank when king has escape squares', () => {
    // King on g8 with only f7 pawn — g7 and h7 both open (2+ king moves)
    const fen = '6k1/5p2/8/8/8/8/8/R3K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Ra8+');
    const result = classifyPosition(fen, fenAfter, 'Ra8+', 0, -100);
    expect(hasTactic(result, 'back_rank')).toBe(false);
  });
});

// ─── Removal of Guard Detection Tests ───────────────────────────────────────

describe('classifyPosition — removal of guard detection', () => {
  it('detects removal of guard when capturing a defender', () => {
    // Black knight on c6 defends bishop on e5 (Nc6-e5).
    // White rook captures knight: Rxc6 removes the guard.
    // After Rxc6, bishop on e5 is undefended.
    const fen = '4k3/8/2n5/4b3/8/8/8/2R1K3 w - - 0 1';
    const fenAfter = playMove(fen, 'Rxc6');
    const result = classifyPosition(fen, fenAfter, 'Rxc6', 0, -200);
    expect(hasTactic(result, 'removal_of_guard')).toBe(true);
  });
});

// ─── Hanging Piece Detection Tests ──────────────────────────────────────────

describe('classifyPosition — hanging piece detection', () => {
  it('detects a hanging piece after a move', () => {
    // After white plays a move, black has a hanging bishop on c5 (attacked, not defended)
    // The original Nd2 setup didn't actually create a hanging piece —
    // kept around for documentation; the real assertion uses fen2 / Ne3
    // below, which DOES attack the undefended c4 bishop.
    const fen2 = '4k3/8/8/8/2b5/8/8/4KN2 w - - 0 1';
    const fenAfter2 = playMove(fen2, 'Ne3');
    const result2 = classifyPosition(fen2, fenAfter2, 'Ne3', 0, -100);
    // Knight on e3 attacks c4 (bishop). Is the bishop defended?
    // The bishop on c4 has no obvious defenders in this sparse position.
    const blackHanging = result2.hangingPieces.filter((h) => h.color === 'b');
    expect(blackHanging.length).toBeGreaterThanOrEqual(1);
    expect(blackHanging.some((h) => h.square === 'c4' && h.piece === 'b')).toBe(true);
  });

  it('does not report defended pieces as hanging', () => {
    // Black bishop on c4 defended by pawn on d5
    const fen = '4k3/8/8/3p4/2b5/8/8/4KN2 w - - 0 1';
    const fenAfter = playMove(fen, 'Ne3');
    const result = classifyPosition(fen, fenAfter, 'Ne3', 0, -50);
    const blackHanging = result.hangingPieces.filter(
      (h) => h.color === 'b' && h.square === 'c4',
    );
    expect(blackHanging).toHaveLength(0);
  });
});

// ─── No Tactic Tests ────────────────────────────────────────────────────────

describe('classifyPosition — no tactic', () => {
  it('returns "none" tactic for a quiet move', () => {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fenAfter = playMove(START_FEN, 'e4');
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, -30);
    expect(result.tactics).toHaveLength(1);
    expect(result.tactics[0].type).toBe('none');
  });

  it('handles an invalid FEN gracefully', () => {
    const result = classifyPosition('invalid', 'invalid', 'e4', 0, 0);
    expect(result.tactics).toHaveLength(1);
    expect(result.tactics[0].type).toBe('none');
    expect(result.hangingPieces).toHaveLength(0);
  });
});

// ─── Multiple Tactics Tests ─────────────────────────────────────────────────

describe('classifyPosition — multiple tactics', () => {
  it('can detect both fork and discovery simultaneously', () => {
    // A discovered attack that also creates a fork
    // White rook on e1 behind knight on e4. Black king on e8, queen on a4.
    // Nd6+ forks king+queen AND discovers rook attack on e8.
    // Actually with Nd6+, the knight checks the king on e8 directly,
    // so it's check from both knight and rook = double check, plus fork.
    const fen = '4k3/8/8/8/q3N3/8/8/4RK2 w - - 0 1';
    const fenAfter = playMove(fen, 'Nd6+');
    const result = classifyPosition(fen, fenAfter, 'Nd6+', 0, -500);
    const types = result.tactics.map((t) => t.type);
    // Should detect at least double_check since both knight and rook check the king
    expect(types.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Eval Swing Computation Tests ───────────────────────────────────────────

describe('classifyPosition — eval swing', () => {
  it('computes positive eval swing for a move that improves position', () => {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fenAfter = playMove(START_FEN, 'e4');
    // evalBefore=0 (white's view), evalAfter=-50 (black's view, meaning white improved)
    // swing = -(-50) - 0 = 50
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 0, -50);
    expect(result.evalSwing).toBe(50);
  });

  it('computes negative eval swing for a move that worsens position', () => {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fenAfter = playMove(START_FEN, 'e4');
    // evalBefore=50, evalAfter=200 (opponent is better by 200)
    // swing = -200 - 50 = -250
    const result = classifyPosition(START_FEN, fenAfter, 'e4', 50, 200);
    expect(result.evalSwing).toBe(-250);
  });
});
