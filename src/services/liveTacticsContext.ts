/**
 * Live tactics context builder — turns the surface's Stockfish read
 * + current FEN + the student's rating into the `TacticsLiveContext`
 * block the brain envelope expects.
 *
 * The job is purely data-prep: detect what's on the board right now
 * (forks/pins/skewers/hanging pieces via `tacticClassifier`), scan
 * Stockfish's principal variation forward by the rating-adaptive
 * lookahead depth (`getTacticLookahead`), and emit the structured
 * block that `formatTacticsSubBlock` renders into the prompt.
 *
 * This module never calls the LLM. The LLM's tactical vocabulary is
 * bounded by what this scan produces — G3 contract — so when the
 * scan finds nothing (quiet position) we return an empty context and
 * the envelope's renderer drops the block entirely.
 *
 * Used by:
 *   - CoachTeachPage (handleSubmit, when building LiveState for the
 *     brain call)
 *   - CoachGamePage (move-time narration build)
 *   - any future surface that wants the coach to name tactics
 *     proactively
 *
 * Stockfish analysis is the SAME analysis the surface already runs
 * for its eval bar — no extra round trip. If the surface doesn't
 * have analysis cached (FEN changed faster than the debounce), pass
 * `null` and the immediate-tactics + hanging-pieces detection still
 * runs (those only need the FEN).
 */
import { Chess } from 'chess.js';
import type { TacticsLiveContext } from '../coach/types';
import type { StockfishAnalysis } from '../types';
import {
  classifyPosition,
  findHangingPieces,
  scanUpcomingTactics,
} from './tacticClassifier';
import { getTacticLookahead } from './tacticAlertService';
import type { TacticPattern, UpcomingTactic } from '../types/tacticTypes';

/**
 * Build the `TacticsLiveContext` block for the brain envelope.
 *
 * @param fen           - The position the coach is about to discuss.
 * @param analysis      - Stockfish analysis for `fen` (top-N PV +
 *                        eval). Pass `null` when no analysis is
 *                        cached — immediate tactics + hanging pieces
 *                        still surface from FEN alone.
 * @param playerColor   - 'w' | 'b' — which side the student plays.
 * @param playerRating  - Used to size the lookahead via
 *                        `getTacticLookahead`. David's call: 1-2
 *                        plies for beginners, 4 for intermediate+.
 */
export function buildTacticsLiveContext(
  fen: string,
  analysis: StockfishAnalysis | null,
  playerColor: 'w' | 'b',
  playerRating: number,
): TacticsLiveContext {
  const lookaheadDepth = getTacticLookahead(playerRating);

  // 1. Immediate tactics + hanging pieces — no PV needed.
  const immediate = detectImmediateTactics(fen, playerColor);
  const hanging = detectHangingPieces(fen);

  // 2. Forward scan of the PV (threats + opportunities).
  let threats: TacticsLiveContext['threats'] = [];
  let opportunities: TacticsLiveContext['opportunities'] = [];
  if (analysis && analysis.topLines.length > 0) {
    const upcoming = scanUpcomingTactics(
      fen,
      analysis.topLines,
      playerColor,
      lookaheadDepth,
    );
    for (const u of upcoming) {
      const entry = upcomingToEntry(u);
      if (u.beneficiary === 'opponent') threats.push(entry);
      else opportunities.push(entry);
    }
    // Cap each list at 5 — token budget; the brain doesn't need 20
    // upcoming entries to narrate well, and 5 covers the top PV
    // contributors.
    threats = threats.slice(0, 5);
    opportunities = opportunities.slice(0, 5);
  }

  return {
    immediate,
    hanging,
    threats,
    opportunities,
    lookaheadDepth,
  };
}

/** Run `classifyPosition` against the current FEN as a null-move-style
 *  classification to surface tactics already on the board. Uses a
 *  pass-through evalBefore/evalAfter so the function falls through
 *  the eval-swing gating and returns whatever its tactic detectors
 *  find. */
function detectImmediateTactics(
  fen: string,
  _playerColor: 'w' | 'b',
): TacticsLiveContext['immediate'] {
  try {
    // classifyPosition expects (fenBefore, fenAfter, san, evalBefore,
    // evalAfter). With fenBefore = fenAfter and no san, the eval-
    // swing math returns 0 (no move quality change), but the tactic
    // detectors still scan the current position for forks, pins,
    // back-rank threats, etc. Wrapped in try because chess.js is
    // strict about input. Filter out 'none' placeholders so the
    // brain envelope only carries real patterns (G3 bounded vocab).
    const result = classifyPosition(fen, fen, '', 0, 0);
    return result.tactics
      .filter((t) => t.type !== 'none')
      .map(tacticPatternToEntry);
  } catch {
    return [];
  }
}

function detectHangingPieces(fen: string): TacticsLiveContext['hanging'] {
  try {
    const chess = new Chess(fen);
    const hanging = findHangingPieces(chess);
    return hanging.map((h) => ({ square: h.square, piece: h.piece, color: h.color }));
  } catch {
    return [];
  }
}

function tacticPatternToEntry(t: TacticPattern): TacticsLiveContext['immediate'][number] {
  return {
    type: t.type,
    description: t.description,
    squares: t.involvedSquares,
  };
}

function upcomingToEntry(u: UpcomingTactic): TacticsLiveContext['threats'][number] {
  return {
    type: u.pattern.type,
    description: u.pattern.description,
    depthAhead: u.depthAhead,
    line: u.line,
  };
}
