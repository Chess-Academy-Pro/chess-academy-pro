import type { CoachGameMove, GamePhase, PhaseAccuracy } from '../types';
import { winPercent, accuracyFromWinDelta } from './accuracyService';

/**
 * Piece material values for endgame detection.
 * Counts only non-pawn, non-king pieces by value.
 */
const PIECE_VALUES: Record<string, number> = {
  q: 9, Q: 9,
  r: 5, R: 5,
  b: 3, B: 3,
  n: 3, N: 3,
  p: 1, P: 1,
};

/** Endgame threshold — total material (excluding kings) at or below this is endgame */
const ENDGAME_MATERIAL_THRESHOLD = 13;

/** Opening cutoff — moves at or below this number are considered opening */
const OPENING_MOVE_CUTOFF = 10;

/**
 * Count total material on the board from a FEN string (excluding kings).
 */
export function countMaterial(fen: string): number {
  const ranks = fen.split(' ')[0];
  let total = 0;
  for (const char of ranks) {
    if (char in PIECE_VALUES) {
      total += PIECE_VALUES[char];
    }
  }
  return total;
}

/**
 * Classify the game phase for a given position.
 *
 * - `opening`: moveNumber ≤ 10
 * - `endgame`: total piece material ≤ 13 (excluding kings)
 * - `middlegame`: everything else
 *
 * Note: moveNumber is 1-indexed (move 1, move 2, etc.)
 * where odd = white's move, even = black's move.
 * We use the chess "full move" number: Math.ceil(moveNumber / 2).
 */
export function classifyPhase(fen: string, moveNumber: number): GamePhase {
  const fullMoveNumber = Math.ceil(moveNumber / 2);

  if (fullMoveNumber <= OPENING_MOVE_CUTOFF) {
    return 'opening';
  }

  const material = countMaterial(fen);
  if (material <= ENDGAME_MATERIAL_THRESHOLD) {
    return 'endgame';
  }

  return 'middlegame';
}

/**
 * Compute accuracy + mistake counts per game phase for a given player
 * color. Uses the SAME win-percent + harmonic-mean algorithm as
 * `calculateAccuracy` so per-phase grades agree with the hero accuracy
 * number on the review summary card. The previous arithmetic-mean
 * `cpLossToAccuracy` path consistently overreported phase accuracy —
 * one blunder + 30 clean moves came back as 96.7% phase / 47% hero
 * because arithmetic mean ≠ harmonic mean. Same algo means same scale.
 */
export function getPhaseBreakdown(
  moves: CoachGameMove[],
  playerColor: 'white' | 'black',
): PhaseAccuracy[] {
  const phases: Record<GamePhase, { accs: number[]; mistakes: number }> = {
    opening: { accs: [], mistakes: 0 },
    middlegame: { accs: [], mistakes: 0 },
    endgame: { accs: [], mistakes: 0 },
  };

  for (const move of moves) {
    // Skip coach moves
    if (move.isCoachMove) continue;

    // Filter by player color: odd moveNumber = white, even = black
    const isWhiteMove = move.moveNumber % 2 === 1;
    if ((playerColor === 'white' && !isWhiteMove) || (playerColor === 'black' && isWhiteMove)) {
      continue;
    }

    // Book moves are excluded from accuracy in `calculateAccuracy`; we
    // mirror that here so book-heavy openings don't drag the phase
    // grade above the player's actual play.
    if (move.classification === 'book') continue;

    // Need evaluations for accuracy
    if (move.evaluation === null || move.preMoveEval === null) {
      continue;
    }

    const phase = classifyPhase(move.fen, move.moveNumber);
    const bucket = phases[phase];

    // Win-percent must be from the moving side's perspective. Same
    // contract as calculateAccuracy:108-118.
    const winBefore = isWhiteMove
      ? winPercent(move.preMoveEval)
      : 100 - winPercent(move.preMoveEval);
    const winAfter = isWhiteMove
      ? winPercent(move.evaluation)
      : 100 - winPercent(move.evaluation);

    const moveAcc = accuracyFromWinDelta(winBefore - winAfter);
    bucket.accs.push(moveAcc);

    // Count mistakes (inaccuracy, mistake, blunder)
    const cls = move.classification;
    if (cls === 'inaccuracy' || cls === 'mistake' || cls === 'blunder') {
      bucket.mistakes++;
    }
  }

  return (['opening', 'middlegame', 'endgame'] as GamePhase[]).map((phase) => {
    const bucket = phases[phase];
    return {
      phase,
      accuracy: bucket.accs.length > 0
        ? Math.round(harmonicMean(bucket.accs) * 10) / 10
        : 0,
      moveCount: bucket.accs.length,
      mistakes: bucket.mistakes,
    };
  });
}

/**
 * Harmonic mean — same aggregator `calculateAccuracy` uses in
 * `accuracyService`. Gives extra weight to bad moves so a single
 * blunder drags the phase grade down meaningfully instead of being
 * averaged away by a stretch of clean moves. Clamped at 1 per value to
 * avoid division-by-zero on perfect-zero scores (matches the upstream
 * implementation).
 */
function harmonicMean(values: number[]): number {
  if (values.length === 0) return 0;
  let reciprocalSum = 0;
  for (const v of values) {
    reciprocalSum += 1 / Math.max(1, v);
  }
  return values.length / reciprocalSum;
}
