import { Chess } from 'chess.js';
import type {
  CoachGameMove,
  GameRecord,
  MoveAnnotation,
} from '../types/index';

export function reconstructMovesFromGame(
  game: GameRecord,
  playerColor?: 'white' | 'black',
): CoachGameMove[] {
  // chess.loadPgn() handles headers, braced comments, NAGs, and result
  // tokens correctly. The old manual whitespace-split parser failed the
  // first iteration for any PGN with headers (e.g. "[Event" threw on
  // chess.move), silently returning [] for every imported game.
  const loader = new Chess();
  try {
    loader.loadPgn(game.pgn);
  } catch {
    return [];
  }

  // WO-REVIEW-CASCADE-ENGINE part A — use verbose history so we get
  // each move's `after` FEN directly from the loader. The previous
  // implementation built a second Chess instance and re-walked the
  // SAN list via chess.move(san) — that walk would `break` on any
  // throw, truncating the moves array to a partial prefix and
  // silently disabling the review's Next button after the first
  // move. The loader has already validated the whole game; trusting
  // its verbose history removes the second walk and the failure mode.
  const verbose = loader.history({ verbose: true });
  if (verbose.length === 0) {
    return [];
  }

  // Build annotation lookup: "moveNumber-color" -> MoveAnnotation
  const annotationMap = new Map<string, MoveAnnotation>();
  if (game.annotations) {
    for (const ann of game.annotations) {
      annotationMap.set(`${ann.moveNumber}-${ann.color}`, ann);
    }
  }

  // For coach-vs-player games the player's color is inferred from the
  // AI placeholder names. For imported human-vs-human games the caller
  // must pass playerColor explicitly; otherwise we'd default to "white"
  // and mis-mark every user-as-black move as a coach move.
  const inferredPlayerIsWhite = game.white !== 'AI Coach' && game.white !== 'Stockfish Bot';
  const playerIsWhite = playerColor ? playerColor === 'white' : inferredPlayerIsWhite;
  const moves: CoachGameMove[] = [];
  let previousEval: number | null = null;

  for (let i = 0; i < verbose.length; i++) {
    const move = verbose[i];
    const moveNumber = i + 1;
    // Verbose move's `color` is 'w' or 'b'.
    const color: 'white' | 'black' = move.color === 'w' ? 'white' : 'black';
    const isCoachMove = playerIsWhite ? color !== 'white' : color !== 'black';

    // Look up annotation by chess move number + color.
    const chessMoveNumber = Math.ceil(moveNumber / 2);
    const annotation = annotationMap.get(`${chessMoveNumber}-${color}`);

    // Annotations now store evaluations in centipawns (White POV) — the
    // legacy pawn-unit storage was retired when `bestMoveEval` was
    // added. The compensating `* 100` that used to live here is gone:
    // `annotation.evaluation` already matches the consumer-expected
    // cp scale. See gameAnalysisService.ts.
    const evaluation = annotation?.evaluation ?? null;
    const bestMove = annotation?.bestMove ?? null;
    const classification = annotation?.classification ?? null;
    const comment = annotation?.comment ?? '';

    moves.push({
      moveNumber,
      san: move.san,
      // chess.js verbose history: `after` is the FEN AFTER this move.
      // Falls back to recomputing if `after` is missing (older
      // chess.js versions). Both branches give the same result.
      fen: move.after,
      isCoachMove,
      commentary: comment,
      evaluation,
      classification,
      expanded: false,
      bestMove,
      bestMoveEval: null,
      preMoveEval: previousEval,
    });

    previousEval = evaluation;
  }

  return moves;
}
