/**
 * lichessTablebaseService
 * -----------------------
 * Client wrapper around `/api/lichess-tablebase`. Provides
 * mathematical-certainty win/draw/loss verdicts for any standard
 * position with ≤7 pieces. Used by the Eval Lab quiz to verify
 * hand-curated `result` claims with the tablebase oracle.
 *
 * Returns null when:
 *   - Position has >7 pieces (out of range)
 *   - Network request fails
 *   - Upstream returns malformed JSON
 *
 * The caller is responsible for falling back to the curator's
 * authored `result` field when the lookup returns null.
 */

const TABLEBASE_PROXY_PATH = '/api/lichess-tablebase';
const FETCH_TIMEOUT_MS = 8_000;

/** Lichess tablebase categories (returned in the `category` field
 *  of upstream responses). All but the cursed/blessed/maybe are
 *  hard verdicts; cursed-win etc. are 50-move-rule edge cases that
 *  still represent the underlying win or loss for our purposes. */
export type TablebaseCategory =
  | 'win'
  | 'loss'
  | 'draw'
  | 'cursed-win'
  | 'blessed-loss'
  | 'maybe-win'
  | 'maybe-loss'
  | 'unknown';

export interface TablebaseLookupResult {
  /** Raw upstream category — perspective is the side TO MOVE. */
  category: TablebaseCategory;
  /** Resolved as White-relative result: 'white-wins' | 'black-wins'
   *  | 'draw' | null. Computed by combining `category` with the
   *  side-to-move from the input FEN. */
  whiteRelativeResult: 'white-wins' | 'black-wins' | 'draw' | null;
  /** Distance to mate (DTM, half-moves), if known. Negative for the
   *  side to move losing. */
  dtm: number | null;
  /** Distance to zeroing (DTZ, half-moves), if known. Steps until
   *  the next pawn move or capture. */
  dtz: number | null;
  checkmate: boolean;
  stalemate: boolean;
  insufficientMaterial: boolean;
}

/** Count pieces in a FEN's first field. Used to short-circuit
 *  before issuing a request the proxy will reject anyway. */
function countPieces(fen: string): number {
  const board = fen.split(' ')[0];
  return board.replace(/[^a-zA-Z]/g, '').length;
}

/** Translate the tablebase category (relative to the side TO MOVE)
 *  into a White-relative verdict. */
function whiteRelative(
  fen: string,
  category: TablebaseCategory,
): 'white-wins' | 'black-wins' | 'draw' | null {
  const sideToMove = fen.split(' ')[1];
  const movesWin = sideToMove === 'w' ? 'white-wins' : 'black-wins';
  const movesLose = sideToMove === 'w' ? 'black-wins' : 'white-wins';
  switch (category) {
    case 'win':
    case 'cursed-win':
    case 'maybe-win':
      return movesWin;
    case 'loss':
    case 'blessed-loss':
    case 'maybe-loss':
      return movesLose;
    case 'draw':
      return 'draw';
    case 'unknown':
    default:
      return null;
  }
}

/** Look up a position in the Lichess tablebase. Returns null when
 *  the position is out of range (>7 pieces) or the network call
 *  fails. */
export async function lookupTablebase(fen: string): Promise<TablebaseLookupResult | null> {
  if (countPieces(fen) > 7) return null;
  const url = new URL(TABLEBASE_PROXY_PATH, window.location.origin);
  url.searchParams.set('fen', fen);
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      category?: TablebaseCategory;
      dtm?: number | null;
      dtz?: number | null;
      checkmate?: boolean;
      stalemate?: boolean;
      insufficient_material?: boolean;
    };
    if (!json.category) return null;
    return {
      category: json.category,
      whiteRelativeResult: whiteRelative(fen, json.category),
      dtm: json.dtm ?? null,
      dtz: json.dtz ?? null,
      checkmate: !!json.checkmate,
      stalemate: !!json.stalemate,
      insufficientMaterial: !!json.insufficient_material,
    };
  } catch {
    return null;
  }
}

/** Test helper: re-export the piece-count gate so tests can
 *  validate the threshold logic without a network round-trip. */
export const _internals = {
  countPieces,
  whiteRelative,
};
