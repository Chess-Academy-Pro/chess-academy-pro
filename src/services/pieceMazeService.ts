// Generic piece-maze game logic. Used by /kid/<piece>-games/maze/:level
// for all 6 pieces. Per-piece movement rules computed at runtime — no
// chess.js game-state machinery needed because the maze is a
// single-piece-on-empty-board affair (kid piece + obstacles). chess.js
// would over-validate (turn order, checks, captures we don't want).

import { db } from '../db/schema';
import type { ChessPiece } from '../types';
import type { PieceMazeProgress, PieceMazeLevelProgress } from '../types/pieceMaze';

const FILES = 'abcdefgh';
function fileIndex(sq: string): number { return FILES.indexOf(sq[0]); }
function rankIndex(sq: string): number { return parseInt(sq[1], 10) - 1; }
function toSquare(f: number, r: number): string {
  return `${FILES[f]}${r + 1}`;
}

function slide(
  from: string,
  blocked: Set<string>,
  dirs: ReadonlyArray<[number, number]>,
  maxSteps = 7,
): string[] {
  const moves: string[] = [];
  const f = fileIndex(from);
  const r = rankIndex(from);
  for (const [df, dr] of dirs) {
    let cf = f + df, cr = r + dr;
    let steps = 0;
    while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8 && steps < maxSteps) {
      const sq = toSquare(cf, cr);
      if (blocked.has(sq)) break;
      moves.push(sq);
      cf += df; cr += dr; steps += 1;
    }
  }
  return moves;
}

const ROOK_DIRS: ReadonlyArray<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const BISHOP_DIRS: ReadonlyArray<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS: ReadonlyArray<[number, number]> = [...ROOK_DIRS, ...BISHOP_DIRS];

function knightMoves(from: string, blocked: Set<string>): string[] {
  const f = fileIndex(from);
  const r = rankIndex(from);
  const deltas: ReadonlyArray<[number, number]> = [
    [1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];
  const moves: string[] = [];
  for (const [df, dr] of deltas) {
    const cf = f + df, cr = r + dr;
    if (cf < 0 || cf >= 8 || cr < 0 || cr >= 8) continue;
    const sq = toSquare(cf, cr);
    if (blocked.has(sq)) continue;
    moves.push(sq);
  }
  return moves;
}

function pawnMoves(from: string, blocked: Set<string>): string[] {
  // Kid plays white. Pawn can push forward 1 square, or 2 from rank 2,
  // not blocked. No captures in maze mode (obstacles are pure blocks).
  const f = fileIndex(from);
  const r = rankIndex(from);
  if (r >= 7) return [];
  const moves: string[] = [];
  const one = toSquare(f, r + 1);
  if (!blocked.has(one)) {
    moves.push(one);
    if (r === 1) {
      const two = toSquare(f, r + 2);
      if (!blocked.has(two)) moves.push(two);
    }
  }
  return moves;
}

/** Piece-specific legal-move computation for the maze surface. */
export function getPieceLegalMoves(
  piece: ChessPiece,
  from: string,
  blocked: Set<string>,
): string[] {
  switch (piece) {
    case 'king':   return slide(from, blocked, QUEEN_DIRS, 1);
    case 'queen':  return slide(from, blocked, QUEEN_DIRS);
    case 'rook':   return slide(from, blocked, ROOK_DIRS);
    case 'bishop': return slide(from, blocked, BISHOP_DIRS);
    case 'knight': return knightMoves(from, blocked);
    case 'pawn':   return pawnMoves(from, blocked);
  }
}

const PIECE_LETTER: Record<ChessPiece, string> = {
  king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P',
};

/** Build a piece-square map (used by ConsistentChessboard static mode). */
export function buildPieceMazePieceMap(
  piece: ChessPiece,
  piecePos: string,
  obstacles: string[],
): Record<string, { pieceType: string }> {
  const map: Record<string, { pieceType: string }> = {};
  map[piecePos] = { pieceType: `w${PIECE_LETTER[piece]}` };
  for (const obs of obstacles) {
    map[obs] = { pieceType: 'bP' };
  }
  return map;
}

export function calculateStars(moves: number, par: number): number {
  if (moves <= par) return 3;
  if (moves <= par + 2) return 2;
  return 1;
}

// ─── Persistence ─────────────────────────────────────────────────────

const PIECE_MAZE_META_KEY = 'piece_maze_progress_v1';

function defaultProgress(): PieceMazeProgress {
  return { levels: {} };
}

export async function getPieceMazeProgress(): Promise<PieceMazeProgress> {
  const record = await db.meta.get(PIECE_MAZE_META_KEY);
  if (!record) return defaultProgress();
  return JSON.parse(record.value) as PieceMazeProgress;
}

export async function savePieceMazeProgress(progress: PieceMazeProgress): Promise<void> {
  await db.meta.put({ key: PIECE_MAZE_META_KEY, value: JSON.stringify(progress) });
}

export async function completePieceMazeLevel(
  piece: ChessPiece,
  levelId: number,
  moves: number,
  par: number,
): Promise<PieceMazeLevelProgress> {
  const progress = await getPieceMazeProgress();
  const key = `${piece}:${levelId}`;
  const prior = progress.levels[key];
  const stars = calculateStars(moves, par);
  const next: PieceMazeLevelProgress = {
    completed: true,
    bestMoves: prior && prior.completed ? Math.min(prior.bestMoves, moves) : moves,
    stars: prior && prior.completed ? Math.max(prior.stars, stars) : stars,
  };
  progress.levels[key] = next;
  await savePieceMazeProgress(progress);
  return next;
}
