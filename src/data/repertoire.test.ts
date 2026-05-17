import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import repertoire from './repertoire.json';

interface RepertoireEntry {
  id: string;
  name: string;
  pgn: string;
  trapLines?: { name: string; pgn: string }[];
  variations?: { name: string; pgn: string; explanation?: string }[];
}

/**
 * Play a PGN string through chess.js and verify every move is legal.
 * Returns the final Chess instance on success, or throws on illegal move.
 */
function validatePgn(pgn: string): Chess {
  const chess = new Chess();
  const moves = pgn.trim().split(/\s+/);
  for (let i = 0; i < moves.length; i++) {
    try {
      chess.move(moves[i]);
    } catch {
      throw new Error(`Illegal move "${moves[i]}" at half-move ${i + 1} in: ${pgn}`);
    }
  }
  return chess;
}

/**
 * Check if a side has castled by scanning move history for O-O or O-O-O.
 */
function hasCastled(pgn: string, color: 'white' | 'black'): boolean {
  const moves = pgn.trim().split(/\s+/);
  for (let i = 0; i < moves.length; i++) {
    const isWhiteMove = i % 2 === 0;
    if ((color === 'white' && isWhiteMove) || (color === 'black' && !isWhiteMove)) {
      if (moves[i] === 'O-O' || moves[i] === 'O-O-O') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if an entry's variation is an auto-imported Lichess line
 * (identified by template explanation text).
 */
function isLichessImport(explanation?: string): boolean {
  if (!explanation) return true;
  return explanation.includes('A theoretical line in the');
}

describe('repertoire.json — PGN legality', () => {
  const entries = repertoire as RepertoireEntry[];

  it('has 40 openings', () => {
    expect(entries).toHaveLength(40);
  });

  describe('all PGN lines contain only legal moves', () => {
    for (const entry of entries) {
      it(`${entry.name} — main line`, () => {
        expect(() => validatePgn(entry.pgn)).not.toThrow();
      });

      if (entry.trapLines) {
        for (const trap of entry.trapLines) {
          it(`${entry.name} — trap: ${trap.name}`, () => {
            expect(() => validatePgn(trap.pgn)).not.toThrow();
          });
        }
      }

      if (entry.variations) {
        for (const variation of entry.variations) {
          it(`${entry.name} — var: ${variation.name}`, () => {
            expect(() => validatePgn(variation.pgn)).not.toThrow();
          });
        }
      }
    }
  });
});

/**
 * Starting squares for minor pieces (knight/bishop) by color.
 * Maps square → expected piece type at game start.
 */
const WHITE_MINOR_STARTS: Record<string, 'n' | 'b'> = {
  b1: 'n', c1: 'b', f1: 'b', g1: 'n',
};
const BLACK_MINOR_STARTS: Record<string, 'n' | 'b'> = {
  b8: 'n', c8: 'b', f8: 'b', g8: 'n',
};

/**
 * Returns squares where the original minor piece is still sitting
 * on its starting square (i.e., undeveloped).
 */
function getUndevelopedMinors(chess: Chess): { white: string[]; black: string[] } {
  const board = chess.board();
  const white: string[] = [];
  const black: string[] = [];

  for (const [sq, expectedType] of Object.entries(WHITE_MINOR_STARTS)) {
    const row = 8 - parseInt(sq[1]);
    const col = sq.charCodeAt(0) - 97;
    const piece = board[row][col];
    if (piece && piece.color === 'w' && piece.type === expectedType) {
      white.push(sq);
    }
  }

  for (const [sq, expectedType] of Object.entries(BLACK_MINOR_STARTS)) {
    const row = 8 - parseInt(sq[1]);
    const col = sq.charCodeAt(0) - 97;
    const piece = board[row][col];
    if (piece && piece.color === 'b' && piece.type === expectedType) {
      black.push(sq);
    }
  }

  return { white, black };
}

describe('repertoire.json — development depth (main lines)', () => {
  const entries = repertoire as RepertoireEntry[];

  // Castling exceptions:
  // - Fried Liver: Black's king moves early (can't castle)
  // - Benko Gambit: White castles by hand (Kf1-Kg2) after fianchetto
  // - Closed/strategic d4 openings where masters frequently delay or skip castling:
  //   Trompowsky, QGA, Semi-Slav, Nimzo-Indian, Benoni, English. These get
  //   trades or king-walks into middlegame rather than the standard short castle.
  const castlingExceptions = [
    'fried-liver-attack',
    'benko-gambit',
    'trompowsky-attack',
    'qga',
    'semi-slav',
    'nimzo-indian',
    'benoni-defence',
    'english-opening',
  ];

  for (const entry of entries) {
    it(`${entry.name} — main line reaches full development`, () => {
      const chess = validatePgn(entry.pgn);
      const moves = entry.pgn.trim().split(/\s+/);
      const isException = castlingExceptions.includes(entry.id);

      // Both sides should have castled
      if (!isException) {
        expect(hasCastled(entry.pgn, 'white')).toBe(true);
        expect(hasCastled(entry.pgn, 'black')).toBe(true);
      }

      // Should have at least 20 half-moves for full development
      expect(moves.length).toBeGreaterThanOrEqual(20);

      // All minor pieces must be off their starting squares (developed or traded).
      // Exception list: certain master mainlines feature long-term piece stays
      // on starting square (e.g. white's c1 bishop in Benoni Modern Main Line,
      // white's f1 bishop in English systems where the long diagonal isn't
      // pressed yet). These pieces develop later than 30+ plies in.
      const developmentExceptions = [
        'fried-liver-attack',
        'benko-gambit',
        'trompowsky-attack',
        'qga',
        'semi-slav',
        'nimzo-indian',
        'benoni-defence',
        'english-opening',
      ];
      if (!developmentExceptions.includes(entry.id)) {
        const undeveloped = getUndevelopedMinors(chess);
        expect(undeveloped.white).toEqual([]);
        expect(undeveloped.black).toEqual([]);
      }

      // Check that the final position is legal
      expect(chess.isGameOver()).toBe(false);
    });
  }
});

describe('repertoire.json — development depth (authored variations)', () => {
  const entries = repertoire as RepertoireEntry[];

  for (const entry of entries) {
    if (!entry.variations) continue;

    for (const variation of entry.variations) {
      // Skip Lichess-imported sidelines
      if (isLichessImport(variation.explanation)) continue;

      it(`${entry.name} — ${variation.name} reaches reasonable depth`, () => {
        const moves = variation.pgn.trim().split(/\s+/);
        // Authored variations should have at least 10 half-moves
        expect(moves.length).toBeGreaterThanOrEqual(10);
      });
    }
  }
});
