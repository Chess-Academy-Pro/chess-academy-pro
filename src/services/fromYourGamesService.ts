/**
 * fromYourGamesService
 * --------------------
 * Mines the user's imported games for endgame positions where the
 * player blundered or made a serious mistake. Surfaces those
 * positions as personalized practice tiles in the "From Your
 * Games" tab — turns the user's actual losses into their custom
 * practice corpus.
 *
 * Same architectural contract as everywhere else: positions and
 * moves come from data (the user's imported PGNs), the runtime
 * LLM is voice-only. Engine-classified mistakes (`'mistake'` /
 * `'blunder'` from the existing per-move analysis) drive the
 * mining; we don't generate any new analysis here, just surface
 * what's already in the games table.
 *
 * Endgame phase definition: the position is in the endgame when
 * EITHER the queens are off the board OR the move number is ≥30.
 * Either signal is enough; both together is just stronger
 * evidence.
 */
import { Chess } from 'chess.js';
import { db } from '../db/schema';
import type { GameRecord, MoveAnnotation } from '../types';

const ENDGAME_MOVE_NUMBER_THRESHOLD = 30;
const MIN_EVAL_DROP_CP = 100;

/** A single mined endgame mistake — the unit the From Your Games
 *  tab renders as a practice tile. */
export interface MinedEndgamePosition {
  /** Source game ID — links back to the original record. */
  gameId: string;
  /** Header summary: "vs paulrudd · Mar 14 · 0-1". */
  gameLabel: string;
  /** Whose move was the mistake. */
  color: 'white' | 'black';
  /** Move number (from the standard PGN move count, 1-indexed). */
  moveNumber: number;
  /** FEN BEFORE the mistake. This is the position the user must
   *  solve from — find the better move that the player missed. */
  fen: string;
  /** SAN of the mistake the player actually made in the game. */
  playedMove: string;
  /** SAN of the engine's recommendation (when available). */
  bestMove: string | null;
  /** Centipawn drop the engine measured. Used to rank tiles by
   *  severity. Negative numbers; -800 = blunder, -200 = mistake. */
  evalDrop: number;
  /** Classification: only 'mistake' or 'blunder' qualify here.
   *  Inaccuracies are noisier and mostly annotation-quality
   *  artifacts; we surface only the bigger swings. */
  classification: 'mistake' | 'blunder';
  /** Whether the queens were already off the board. Stronger
   *  endgame signal than the move-number heuristic alone. */
  queensOff: boolean;
}

interface MineOptions {
  /** Cap the result count to avoid swamping the UI. Default 30. */
  limit?: number;
  /** Skip games not flagged `fullyAnalyzed`. Default true —
   *  sparse-annotation games tend to miss real mistakes and
   *  surface false positives. */
  requireFullAnalysis?: boolean;
}

/** Mine all imported games for endgame mistakes. Async because it
 *  reads from Dexie. Returns positions sorted by severity (largest
 *  eval drop first) so the most-impactful practice surfaces at the
 *  top of the tile list. */
export async function mineEndgamePositions(
  options: MineOptions = {},
): Promise<MinedEndgamePosition[]> {
  // Default 200 — a practical "more than any session can use"
  // ceiling. David's audit removed the old 30-row cap. Mining
  // every position from every imported game can run thousands of
  // chess.js replays, so we keep a finite ceiling for performance
  // even though it's high enough to feel unlimited in practice.
  const limit = options.limit ?? 200;
  const requireFullAnalysis = options.requireFullAnalysis ?? true;
  const games = await db.games.toArray();
  const positions: MinedEndgamePosition[] = [];

  for (const game of games) {
    if (requireFullAnalysis && !game.fullyAnalyzed) continue;
    if (!game.annotations || game.annotations.length === 0) continue;
    const minedFromGame = mineGame(game);
    positions.push(...minedFromGame);
  }

  // Severity sort — biggest eval swings first.
  positions.sort((a, b) => a.evalDrop - b.evalDrop);
  return positions.slice(0, limit);
}

/** Mine a single game record for endgame mistakes. Replays the PGN
 *  through chess.js so we can capture the exact FEN before each
 *  flagged move plus the queen-count signal. */
function mineGame(game: GameRecord): MinedEndgamePosition[] {
  const found: MinedEndgamePosition[] = [];
  const annotationsByPly = indexAnnotationsByPly(game.annotations ?? []);
  const chess = new Chess();
  const moves = parseMoves(game.pgn);
  if (moves.length === 0) return found;

  for (let ply = 0; ply < moves.length; ply += 1) {
    const fenBefore = chess.fen();
    const queensOffBefore = countQueens(fenBefore) === 0;
    const moveNumber = Math.floor(ply / 2) + 1;
    const color: 'white' | 'black' = ply % 2 === 0 ? 'white' : 'black';
    const annotation = annotationsByPly.get(ply);

    // Play the actual move so the next iteration's FEN is correct.
    let played;
    try {
      played = chess.move(moves[ply]);
    } catch {
      // Malformed PGN; abandon this game.
      return found;
    }

    if (!annotation) continue;
    if (annotation.classification !== 'mistake' && annotation.classification !== 'blunder') {
      continue;
    }
    if (annotation.evaluation === null) continue;

    // Compute eval drop. The previous ply's eval (if any) is the
    // baseline; this annotation's eval is the post-move state.
    const previousAnnotation = ply > 0 ? annotationsByPly.get(ply - 1) : undefined;
    const beforeEval = previousAnnotation?.evaluation ?? 0;
    // Both evals are white-relative cp; the player's "drop" is in
    // their direction. For white, drop = afterEval - beforeEval
    // (negative = bad). For black, drop = beforeEval - afterEval.
    const afterEval = annotation.evaluation;
    const drop =
      color === 'white' ? afterEval - beforeEval : beforeEval - afterEval;
    if (drop > -MIN_EVAL_DROP_CP) continue;

    // Endgame phase gate: queens off OR move ≥30.
    if (!queensOffBefore && moveNumber < ENDGAME_MOVE_NUMBER_THRESHOLD) continue;

    found.push({
      gameId: game.id,
      gameLabel: buildGameLabel(game),
      color,
      moveNumber,
      fen: fenBefore,
      playedMove: played.san,
      bestMove: annotation.bestMove,
      evalDrop: drop,
      classification: annotation.classification,
      queensOff: queensOffBefore,
    });
  }
  return found;
}

function indexAnnotationsByPly(
  annotations: MoveAnnotation[],
): Map<number, MoveAnnotation> {
  const out = new Map<number, MoveAnnotation>();
  for (const a of annotations) {
    const ply = (a.moveNumber - 1) * 2 + (a.color === 'white' ? 0 : 1);
    out.set(ply, a);
  }
  return out;
}

function parseMoves(pgn: string): string[] {
  // Strip PGN headers + result tokens, keep just SAN moves.
  const body = pgn
    .replace(/\[.*?\]\n?/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\d+\.{1,3}/g, '')
    .replace(/(?:1-0|0-1|1\/2-1\/2|\*)\s*$/m, '')
    .trim();
  return body.split(/\s+/).filter((tok) => tok.length > 0);
}

function countQueens(fen: string): number {
  const board = fen.split(' ')[0];
  return (board.match(/[Qq]/g) ?? []).length;
}

function buildGameLabel(game: GameRecord): string {
  const opp = game.white === 'You' || game.white === '' ? game.black : game.white;
  const dateLabel = game.date && game.date.length >= 10 ? game.date.slice(0, 10) : '';
  const parts = [`vs ${opp || 'opponent'}`];
  if (dateLabel) parts.push(dateLabel);
  parts.push(game.result);
  return parts.join(' · ');
}
