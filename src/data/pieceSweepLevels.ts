import type { PieceSweepLevel } from '../types/pieceSweep';

// 5 hand-crafted sweep levels per piece × 6 pieces = 30 new sandbox
// levels. Win condition: capture every target. Move count vs par
// yields 1-3 stars (same formula as the maze and existing Rook Maze /
// Knight Sweep games).
//
// All 30 levels BFS-validated solvable + par achievable — see the
// validation script at the bottom of this file's commit message.

export const PIECE_SWEEP_LEVELS: PieceSweepLevel[] = [
  // ─── KING (1-square moves) ─────────────────────────────────────────
  {
    piece: 'king', id: 1, name: 'Two Targets',
    pieceStart: 'd4', targets: ['c5', 'e3'], obstacles: [], par: 3,
  },
  {
    piece: 'king', id: 2, name: 'Diagonal Sweep',
    pieceStart: 'a1', targets: ['b2', 'c3'], obstacles: [], par: 2,
  },
  {
    piece: 'king', id: 3, name: 'Triangle',
    pieceStart: 'd4', targets: ['c5', 'e5', 'd6'], obstacles: [], par: 4,
  },
  {
    piece: 'king', id: 4, name: 'L-Shape Walk',
    pieceStart: 'a1', targets: ['c1', 'c3'], obstacles: [], par: 4,
  },
  {
    piece: 'king', id: 5, name: 'Five-Square Tour',
    pieceStart: 'd4', targets: ['c5', 'e5', 'e3', 'c3', 'd5'], obstacles: [], par: 7,
  },

  // ─── QUEEN (sliding all 8 directions) ──────────────────────────────
  {
    piece: 'queen', id: 1, name: 'Three in a Row',
    pieceStart: 'a1', targets: ['a4', 'a7'], obstacles: [], par: 2,
  },
  {
    piece: 'queen', id: 2, name: 'Diagonal Sweep',
    pieceStart: 'a1', targets: ['d4', 'h8'], obstacles: [], par: 2,
  },
  {
    piece: 'queen', id: 3, name: 'Cross Pattern',
    pieceStart: 'd4', targets: ['d8', 'h4', 'd1', 'a4'], obstacles: [], par: 4,
  },
  {
    piece: 'queen', id: 4, name: 'Star Pattern',
    pieceStart: 'd4', targets: ['a1', 'h8', 'a7', 'g1'], obstacles: [], par: 4,
  },
  {
    piece: 'queen', id: 5, name: 'Five Captures',
    pieceStart: 'a1', targets: ['c3', 'f6', 'h1', 'a8', 'c8'], obstacles: [], par: 5,
  },

  // ─── ROOK (straight lines) ─────────────────────────────────────────
  {
    piece: 'rook', id: 1, name: 'Same File',
    pieceStart: 'a1', targets: ['a4', 'a8'], obstacles: [], par: 2,
  },
  {
    piece: 'rook', id: 2, name: 'L-Pattern',
    pieceStart: 'a1', targets: ['a5', 'd5'], obstacles: [], par: 2,
  },
  {
    piece: 'rook', id: 3, name: 'Three Corners',
    pieceStart: 'a1', targets: ['a8', 'h8', 'h1'], obstacles: [], par: 3,
  },
  {
    piece: 'rook', id: 4, name: 'Box Sweep',
    pieceStart: 'a1', targets: ['a4', 'd4', 'd1', 'b1'], obstacles: [], par: 4,
  },
  {
    piece: 'rook', id: 5, name: 'Five Rooks Job',
    pieceStart: 'a1', targets: ['a4', 'd4', 'd7', 'g7', 'g1'], obstacles: [], par: 5,
  },

  // ─── BISHOP (diagonals) ────────────────────────────────────────────
  {
    piece: 'bishop', id: 1, name: 'Same Diagonal',
    pieceStart: 'a1', targets: ['c3', 'h8'], obstacles: [], par: 2,
  },
  {
    piece: 'bishop', id: 2, name: 'Diagonal Switch',
    pieceStart: 'a1', targets: ['c3', 'a5'], obstacles: [], par: 2,
  },
  {
    piece: 'bishop', id: 3, name: 'Three Diagonals',
    pieceStart: 'a1', targets: ['d4', 'd2', 'b4'], obstacles: [], par: 4,
  },
  {
    piece: 'bishop', id: 4, name: 'Four Captures',
    pieceStart: 'a1', targets: ['c3', 'b4', 'd2', 'a5'], obstacles: [], par: 4,
  },
  {
    piece: 'bishop', id: 5, name: 'Bishop Sweep',
    pieceStart: 'c1', targets: ['e3', 'g5', 'f4', 'd6', 'b4'], obstacles: [], par: 6,
  },

  // ─── KNIGHT (L-jumps) ──────────────────────────────────────────────
  {
    piece: 'knight', id: 1, name: 'One Hop Two',
    pieceStart: 'b1', targets: ['c3', 'a3'], obstacles: [], par: 3,
  },
  {
    piece: 'knight', id: 2, name: 'Knight Triangle',
    pieceStart: 'b1', targets: ['c3', 'd2'], obstacles: [], par: 3,
  },
  {
    piece: 'knight', id: 3, name: 'Three Hop',
    pieceStart: 'b1', targets: ['c3', 'a3', 'd2'], obstacles: [], par: 5,
  },
  {
    piece: 'knight', id: 4, name: 'Knight Square',
    pieceStart: 'd4', targets: ['b3', 'b5', 'f5', 'f3'], obstacles: [], par: 7,
  },
  {
    piece: 'knight', id: 5, name: 'Five-Jump Sweep',
    pieceStart: 'd4', targets: ['b3', 'b5', 'f5', 'f3', 'e2'], obstacles: [], par: 9,
  },

  // ─── PAWN (diagonal captures only — limited geometry) ─────────────
  // Pawns can only capture diagonally one square forward, so sweep
  // levels are necessarily short and use diagonal target trails.
  {
    piece: 'pawn', id: 1, name: 'First Capture',
    pieceStart: 'a2', targets: ['b3'], obstacles: [], par: 1,
  },
  {
    piece: 'pawn', id: 2, name: 'Trail of Two',
    pieceStart: 'a2', targets: ['b3', 'c4'], obstacles: [], par: 2,
  },
  {
    piece: 'pawn', id: 3, name: 'Zigzag',
    pieceStart: 'a2', targets: ['b3', 'a4'], obstacles: [], par: 2,
  },
  {
    piece: 'pawn', id: 4, name: 'Three Diagonals',
    pieceStart: 'b2', targets: ['c3', 'd4', 'e5'], obstacles: [], par: 3,
  },
  {
    piece: 'pawn', id: 5, name: 'Pawn Sweep',
    pieceStart: 'a2', targets: ['b3', 'c4', 'd5', 'e6'], obstacles: [], par: 4,
  },

  // ── Phase 7c — band-2 (medium) levels, procedurally generated ──
  {
    piece: 'king', id: 6, name: 'King Hunt 1',
    pieceStart: 'b6', targets: ["c4","c7","e2","f4"], obstacles: ["g4"], par: 8,
  },
  {
    piece: 'king', id: 7, name: 'King Hunt 2',
    pieceStart: 'd7', targets: ["c1","c6","f3","g3"], obstacles: ["h2"], par: 9,
  },
  {
    piece: 'king', id: 8, name: 'King Hunt 3',
    pieceStart: 'b8', targets: ["e1","e6","f1","g2"], obstacles: ["e3"], par: 9,
  },
  {
    piece: 'king', id: 9, name: 'King Hunt 4',
    pieceStart: 'e6', targets: ["e4","f1","g2","h2"], obstacles: ["b1"], par: 7,
  },
  {
    piece: 'king', id: 10, name: 'King Hunt 5',
    pieceStart: 'c7', targets: ["b2","c4","c6","e2"], obstacles: ["e3"], par: 8,
  },
  {
    piece: 'queen', id: 6, name: 'Queen Hunt 1',
    pieceStart: 'c5', targets: ["d7","e2","e6","g5"], obstacles: ["a6"], par: 5,
  },
  {
    piece: 'queen', id: 7, name: 'Queen Hunt 2',
    pieceStart: 'b2', targets: ["a7","b7","d8","f1"], obstacles: ["a5"], par: 6,
  },
  {
    piece: 'queen', id: 8, name: 'Queen Hunt 3',
    pieceStart: 'c7', targets: ["d4","f4","g3","g4"], obstacles: ["h5"], par: 4,
  },
  {
    piece: 'queen', id: 9, name: 'Queen Hunt 4',
    pieceStart: 'b7', targets: ["a4","c7","g3","h1"], obstacles: ["e2"], par: 6,
  },
  {
    piece: 'queen', id: 10, name: 'Queen Hunt 5',
    pieceStart: 'h4', targets: ["a1","a2","g2","h1"], obstacles: ["b4"], par: 4,
  },
  {
    piece: 'rook', id: 6, name: 'Rook Hunt 1',
    pieceStart: 'h1', targets: ["b8","c1","g4","h7"], obstacles: ["e4"], par: 7,
  },
  {
    piece: 'rook', id: 7, name: 'Rook Hunt 2',
    pieceStart: 'c4', targets: ["c3","d5","g2","h3"], obstacles: ["a2"], par: 6,
  },
  {
    piece: 'rook', id: 8, name: 'Rook Hunt 3',
    pieceStart: 'g5', targets: ["b3","c1","e3","f6"], obstacles: ["g1"], par: 7,
  },
  {
    piece: 'rook', id: 9, name: 'Rook Hunt 4',
    pieceStart: 'f4', targets: ["a2","b5","h4","h5"], obstacles: ["f1"], par: 5,
  },
  {
    piece: 'rook', id: 10, name: 'Rook Hunt 5',
    pieceStart: 'a8', targets: ["a7","b5","c2","d3"], obstacles: ["b3"], par: 7,
  },
  {
    piece: 'bishop', id: 6, name: 'Bishop Hunt 1',
    pieceStart: 'a4', targets: ["b1","b5","c4","c8"], obstacles: ["h6"], par: 6,
  },
  {
    piece: 'bishop', id: 7, name: 'Bishop Hunt 2',
    pieceStart: 'b6', targets: ["c7","d2","f8","g5"], obstacles: ["h6"], par: 6,
  },
  {
    piece: 'bishop', id: 8, name: 'Bishop Hunt 3',
    pieceStart: 'a5', targets: ["a1","c3","e5","h6"], obstacles: ["g1"], par: 5,
  },
  {
    piece: 'bishop', id: 9, name: 'Bishop Hunt 4',
    pieceStart: 'a1', targets: ["a5","b6","g3","h2"], obstacles: ["c6"], par: 6,
  },
  {
    piece: 'bishop', id: 10, name: 'Bishop Hunt 5',
    pieceStart: 'g1', targets: ["d8","e1","e3","g3"], obstacles: ["h7"], par: 6,
  },
  {
    piece: 'knight', id: 6, name: 'Knight Hunt 1',
    pieceStart: 'a5', targets: ["c5","f7","g6","g7"], obstacles: ["b4"], par: 9,
  },
  {
    piece: 'knight', id: 7, name: 'Knight Hunt 2',
    pieceStart: 'f8', targets: ["c3","d6","g7","h5"], obstacles: ["c5"], par: 8,
  },
  {
    piece: 'knight', id: 8, name: 'Knight Hunt 3',
    pieceStart: 'd1', targets: ["f1","f3","g6","h8"], obstacles: ["d7"], par: 7,
  },
  {
    piece: 'knight', id: 9, name: 'Knight Hunt 4',
    pieceStart: 'f4', targets: ["c3","d5","f1","h5"], obstacles: ["g5"], par: 6,
  },
  {
    piece: 'knight', id: 10, name: 'Knight Hunt 5',
    pieceStart: 'f2', targets: ["b7","c1","f1","g3"], obstacles: ["b4"], par: 9,
  },
];

export function getSweepLevelsForPiece(
  piece: PieceSweepLevel['piece'],
): PieceSweepLevel[] {
  return PIECE_SWEEP_LEVELS.filter((l) => l.piece === piece);
}
