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

  // ── Phase 7c — band-2 (medium) levels, procedurally generated ──
  {
    piece: 'king', id: 6, name: 'King Path 1',
    pieceStart: 'a5', target: 'g2', obstacles: ["c1","e4","d8","f7"], par: 6,
  },
  {
    piece: 'king', id: 7, name: 'King Path 2',
    pieceStart: 'f4', target: 'a5', obstacles: ["e6","c8","e2","e3"], par: 5,
  },
  {
    piece: 'king', id: 8, name: 'King Path 3',
    pieceStart: 'h5', target: 'b1', obstacles: ["g6","b3","b2","b6"], par: 6,
  },
  {
    piece: 'king', id: 9, name: 'King Path 4',
    pieceStart: 'd1', target: 'h7', obstacles: ["d2","d7","h8","a2"], par: 6,
  },
  {
    piece: 'king', id: 10, name: 'King Path 5',
    pieceStart: 'a1', target: 'g6', obstacles: ["g2","e4","a5","f5"], par: 6,
  },
  {
    piece: 'knight', id: 6, name: 'Knight Path 1',
    pieceStart: 'e8', target: 'b2', obstacles: ["a4","a2","c4","d5"], par: 5,
  },
  {
    piece: 'knight', id: 7, name: 'Knight Path 2',
    pieceStart: 'a1', target: 'g6', obstacles: ["a2","c2","h8","b2"], par: 5,
  },
  {
    piece: 'knight', id: 8, name: 'Knight Path 3',
    pieceStart: 'g1', target: 'e8', obstacles: ["c1","h4","h6","g8"], par: 5,
  },
  {
    piece: 'knight', id: 9, name: 'Knight Path 4',
    pieceStart: 'f1', target: 'a7', obstacles: ["a3","e3","g2","h5"], par: 5,
  },
  {
    piece: 'knight', id: 10, name: 'Knight Path 5',
    pieceStart: 'h8', target: 'a2', obstacles: ["d5","e4","c8","f8"], par: 5,
  },
  {
    piece: 'pawn', id: 6, name: 'Pawn Path 1',
    pieceStart: 'c1', target: 'c7', obstacles: ["f1","e4","a1","a2"], par: 5,
  },
  {
    piece: 'pawn', id: 7, name: 'Pawn Path 2',
    pieceStart: 'd3', target: 'd8', obstacles: ["d2","h6","b8","b3"], par: 5,
  },
  {
    piece: 'pawn', id: 8, name: 'Pawn Path 3',
    pieceStart: 'b1', target: 'b8', obstacles: ["h3","a5","c6","h4"], par: 6,
  },
  {
    piece: 'pawn', id: 9, name: 'Pawn Path 4',
    pieceStart: 'a2', target: 'a8', obstacles: ["c8","h2","f6","b1"], par: 5,
  },
  {
    piece: 'pawn', id: 10, name: 'Pawn Path 5',
    pieceStart: 'e2', target: 'e8', obstacles: ["f8","h4","f5","f6"], par: 5,
  },
];

export function getMazeLevelsForPiece(
  piece: PieceMazeLevel['piece'],
): PieceMazeLevel[] {
  return PIECE_MAZE_LEVELS.filter((l) => l.piece === piece);
}
