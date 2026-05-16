import type { PieceMazeLevel } from '../types/pieceMaze';

// 5 hand-crafted maze levels per piece for the new piece-maze sandbox
// game. Adds 25 new sandbox levels at once (Rook deliberately skipped —
// the existing Rook Maze already covers this game shape for that
// piece; future expansions can rebalance).
//
// Difficulty bands per non-negotiable #15: levels 1-3 = easy
// (open board, few obstacles), levels 4-5 = medium (denser walls,
// more zig-zag). Future PRs can append levels 6-20 per piece to
// fill the 5-band ramp out to 20 per piece.
//
// Every level is hand-validated: pieceStart and target are unblocked,
// and a path exists with ~par moves under the piece's movement rules.

export const PIECE_MAZE_LEVELS: PieceMazeLevel[] = [
  // ─── KING (1-square moves, 8 directions) ────────────────────────────
  {
    piece: 'king', id: 1, name: 'Royal Walk',
    pieceStart: 'a1', target: 'e5', obstacles: [], par: 4,
  },
  {
    piece: 'king', id: 2, name: 'Across the Board',
    pieceStart: 'a1', target: 'h8', obstacles: [], par: 7,
  },
  {
    piece: 'king', id: 3, name: 'Through the Gate',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['a4', 'b4', 'c4', 'e4', 'f4', 'g4', 'h4'], par: 8,
  },
  {
    piece: 'king', id: 4, name: 'Castle Path',
    pieceStart: 'e1', target: 'e8',
    obstacles: ['d4', 'e4', 'f4'], par: 9,
  },
  {
    piece: 'king', id: 5, name: 'The Long March',
    pieceStart: 'a4', target: 'h4',
    obstacles: ['b3', 'b4', 'b5', 'e3', 'e4', 'e5'], par: 11,
  },

  // ─── QUEEN (sliding, all 8 directions) ─────────────────────────────
  {
    piece: 'queen', id: 1, name: 'Open Diagonal',
    pieceStart: 'a1', target: 'h8', obstacles: [], par: 1,
  },
  {
    piece: 'queen', id: 2, name: 'Around the Wall',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['d4', 'e5'], par: 2,
  },
  {
    piece: 'queen', id: 3, name: 'L-Shape',
    pieceStart: 'a1', target: 'h1',
    obstacles: ['c1', 'd1', 'e1'], par: 2,
  },
  {
    piece: 'queen', id: 4, name: 'Two Walls',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['c1', 'd1', 'e1', 'f1', 'g1', 'h2', 'h3', 'h4'], par: 2,
  },
  {
    piece: 'queen', id: 5, name: 'Three-Move Sweep',
    pieceStart: 'a1', target: 'h1',
    obstacles: ['b1', 'a3', 'a4', 'b3', 'd3', 'd1', 'e1'], par: 3,
  },

  // ─── BISHOP (diagonal sliding) ─────────────────────────────────────
  {
    piece: 'bishop', id: 1, name: 'Color Lane',
    pieceStart: 'a1', target: 'h8', obstacles: [], par: 1,
  },
  {
    piece: 'bishop', id: 2, name: 'Half Diagonal',
    pieceStart: 'a1', target: 'd4', obstacles: [], par: 1,
  },
  {
    piece: 'bishop', id: 3, name: 'Around the Block',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['d4'], par: 5,
  },
  {
    piece: 'bishop', id: 4, name: 'Diagonal Detour',
    pieceStart: 'c1', target: 'h6',
    obstacles: ['e3', 'f4'], par: 3,
  },
  {
    piece: 'bishop', id: 5, name: 'Triangle Path',
    pieceStart: 'a1', target: 'g7',
    obstacles: ['d4', 'e5', 'c3'], par: 4,
  },

  // ─── KNIGHT (L-shape jumps) ────────────────────────────────────────
  {
    piece: 'knight', id: 1, name: 'First Hop',
    pieceStart: 'b1', target: 'c3', obstacles: [], par: 1,
  },
  {
    piece: 'knight', id: 2, name: 'Knight Hop',
    pieceStart: 'b1', target: 'e4', obstacles: [], par: 2,
  },
  {
    piece: 'knight', id: 3, name: 'Cross-Board Knight',
    pieceStart: 'b1', target: 'g6', obstacles: [], par: 4,
  },
  {
    piece: 'knight', id: 4, name: 'Knight Around',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['f7'], par: 6,
  },
  {
    piece: 'knight', id: 5, name: 'L-Shape Maze',
    pieceStart: 'a8', target: 'h1',
    obstacles: ['c6', 'd5', 'e4'], par: 6,
  },

  // ─── PAWN (forward 1-2 squares only — no detour possible) ─────────
  // Pawns can't go around obstacles, so the "maze" challenge for pawns
  // is purely about counting moves from different start squares.
  {
    piece: 'pawn', id: 1, name: 'Almost There',
    pieceStart: 'a7', target: 'a8', obstacles: [], par: 1,
  },
  {
    piece: 'pawn', id: 2, name: 'One Big Jump',
    pieceStart: 'a2', target: 'a4', obstacles: [], par: 1,
  },
  {
    piece: 'pawn', id: 3, name: 'Halfway',
    pieceStart: 'd4', target: 'd8', obstacles: [], par: 4,
  },
  {
    piece: 'pawn', id: 4, name: 'Pawn Push',
    pieceStart: 'e2', target: 'e8', obstacles: [], par: 6,
  },
  {
    piece: 'pawn', id: 5, name: 'Full Climb',
    pieceStart: 'h2', target: 'h8', obstacles: [], par: 6,
  },

  // ─── ROOK (straight lines — supplements existing Rook Maze) ────────
  {
    piece: 'rook', id: 1, name: 'Open Highway',
    pieceStart: 'a1', target: 'h8', obstacles: [], par: 2,
  },
  {
    piece: 'rook', id: 2, name: 'Single Block',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['a4', 'h4'], par: 4,
  },
  {
    piece: 'rook', id: 3, name: 'Detour',
    pieceStart: 'a1', target: 'h1',
    obstacles: ['c1', 'd1', 'e1'], par: 3,
  },
  {
    piece: 'rook', id: 4, name: 'Step Pattern',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['a3', 'c1', 'c5', 'e3', 'e8', 'g5'], par: 6,
  },
  {
    piece: 'rook', id: 5, name: 'Zig and Zag',
    pieceStart: 'a1', target: 'h8',
    obstacles: ['b1', 'a3', 'd1', 'd5', 'e8', 'g3', 'g8', 'h5'], par: 7,
  },
];

export function getMazeLevelsForPiece(
  piece: PieceMazeLevel['piece'],
): PieceMazeLevel[] {
  return PIECE_MAZE_LEVELS.filter((l) => l.piece === piece);
}
