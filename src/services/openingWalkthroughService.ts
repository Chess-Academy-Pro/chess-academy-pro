// openingWalkthroughService
// -------------------------
// Reconstruct the move sequence that led to a puzzle's pre-state by
// asking Lichess for the source game. Lichess's puzzle API returns
// `game.pgn` (the full game) + `puzzle.initialPly` (how many ply
// into that PGN the puzzle position starts). Slicing PGN to
// initialPly gives us the EXACT history — no probing, no guessing.
//
// Used by the Opening Traps "Show the opening" button so the user
// watches the position develop ply-by-ply instead of jump-cutting in.

import { Chess } from 'chess.js';

const PROXY_PATH = '/api/lichess-puzzle';
const FETCH_TIMEOUT_MS = 6_000;

export interface OpeningWalkthroughResult {
  /** SAN move list from the starting position to the puzzle's pre-state.
   *  Empty when the lookup failed. */
  sans: string[];
  /** True when sans.length > 0 AND the last move's resulting FEN
   *  matches the requested target (placement+turn+castling+ep). */
  found: boolean;
}

interface LichessPuzzleResponse {
  game?: {
    pgn?: string;
  };
  puzzle?: {
    initialPly?: number;
  };
}

function fenKey(fen: string): string {
  // Compare positions ignoring half-move clock + full-move number
  // (fields 5 & 6) — those drift between Lichess's PGN replay and
  // the puzzle FEN we ship locally.
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Fetch the puzzle's source game and return the SAN move list from
 *  the chess starting position up to the puzzle's pre-state. */
export async function reconstructPathForPuzzle(
  puzzleId: string,
  targetFen: string,
): Promise<OpeningWalkthroughResult> {
  let data: LichessPuzzleResponse | null = null;
  try {
    const resp = await fetch(`${PROXY_PATH}?id=${encodeURIComponent(puzzleId)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { sans: [], found: false };
    data = (await resp.json()) as LichessPuzzleResponse;
  } catch {
    return { sans: [], found: false };
  }

  const pgn = data?.game?.pgn ?? '';
  const initialPly = data?.puzzle?.initialPly;
  if (!pgn || typeof initialPly !== 'number') {
    return { sans: [], found: false };
  }

  // Lichess's `game.pgn` is space-separated SANs (no move numbers, no
  // header tags). Replay the first `initialPly` of them on a fresh
  // board to confirm we arrive at the puzzle's pre-state.
  const allSans = pgn.split(/\s+/).filter(Boolean);
  // The puzzle position is the position after Lichess plays
  // moves[initialPly] (the blunder), but for OUR purposes we want
  // the position BEFORE the blunder fires (that's what our local
  // puzzle FEN represents — moves[0] in our `moves` field IS that
  // blunder). So we slice up to initialPly (exclusive).
  const setupSans = allSans.slice(0, initialPly);

  // Verify the replay lands on the puzzle FEN. If it doesn't, the
  // Lichess data + our local FEN are out of sync and we'd rather
  // surface failure than animate the wrong sequence.
  const chess = new Chess();
  try {
    for (const san of setupSans) chess.move(san);
  } catch {
    return { sans: [], found: false };
  }
  const ok = fenKey(chess.fen()) === fenKey(targetFen);
  return ok
    ? { sans: setupSans, found: true }
    : { sans: setupSans, found: false };
}
