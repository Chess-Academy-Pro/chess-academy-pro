import type { ChessPiece } from './index';

/** A single maze level — kid moves a chess piece around obstacles to
 *  reach the target square. Generic across all 6 pieces; the piece's
 *  movement rules are derived from the `piece` field via
 *  pieceMazeService.getPieceLegalMoves. */
export interface PieceMazeLevel {
  piece: ChessPiece;
  id: number;
  name: string;
  pieceStart: string;
  target: string;
  /** Squares the kid's piece can't land on or move through. */
  obstacles: string[];
  /** Optimal-move count. ≤ par → 3 stars, ≤ par+2 → 2 stars, else 1. */
  par: number;
}

export interface PieceMazeLevelProgress {
  completed: boolean;
  bestMoves: number;
  stars: number;
}

export interface PieceMazeProgress {
  /** Keyed by `${piece}:${levelId}`. */
  levels: Record<string, PieceMazeLevelProgress>;
}
