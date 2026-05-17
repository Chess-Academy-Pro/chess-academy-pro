/**
 * masterPlayTypes
 * ---------------
 * Shared types for the master-play grounding pipeline (cache, lookup,
 * watcher, claim validator, brain integration). Kept in a leaf module
 * so every consumer pulls the same shape and circular imports stay
 * impossible.
 */

/** One master move from the lookup. Mirrors the meaningful subset of
 *  the Lichess explorer payload. */
export interface MasterPlayMove {
  /** Standard algebraic notation, e.g. "Nf3", "O-O", "exd5". */
  san: string;
  /** UCI, e.g. "g1f3". Optional — the local DB may not store it. */
  uci?: string;
  /** Total game count seen in this position with this move played. */
  games: number;
  /** Wins / draws / losses from White's perspective (Lichess shape). */
  white: number;
  draws: number;
  black: number;
  /** Pre-computed percentages 0-1. Avoids division-by-zero traps in
   *  consumers — the lookup zeros these when games===0. */
  whitePct: number;
  drawPct: number;
  blackPct: number;
  /** Average rating across games with this move, when known. */
  averageRating?: number;
}

/** A famous master game where this position arose. Result-level
 *  attribution (Lichess returns these at the top-level of the payload,
 *  not per-move). */
export interface MasterPlayTopGame {
  id?: string;
  white?: string;
  black?: string;
  whiteRating?: number;
  blackRating?: number;
  year?: number;
  month?: string;
  event?: string;
  /** "1-0" / "0-1" / "1/2-1/2". */
  result?: '1-0' | '0-1' | '1/2-1/2';
}

/** Result of a master-play lookup for a given position. Always
 *  returned (never null) — when no data is available, `source: 'none'`
 *  + empty `moves[]`. Callers branch on the source field instead of
 *  null-checking. */
export interface MasterPlayResult {
  /** Normalized 4-field position-FEN keyed against. */
  fen: string;
  /** Sum of games across all `moves[]`. Zero when source === 'none'. */
  totalGames: number;
  /** Master moves played in this position, sorted by `games` desc.
   *  Empty when source === 'none'. */
  moves: ReadonlyArray<MasterPlayMove>;
  /** Where the data came from. `'local'` hits the in-app
   *  `openings-lichess-extended.json`. `'lichess-live'` hits the live
   *  Lichess explorer via the /api/lichess-explorer proxy. `'none'`
   *  means both layers missed (or the device is offline).  */
  source: 'local' | 'lichess-live' | 'none';
  /** Famous master games where this position arose. Present when the
   *  source provides them (Lichess live always; local DB may not).
   *  Used by `claimValidator` to ground player / year / event claims. */
  topGames?: ReadonlyArray<MasterPlayTopGame>;
}

/** The block injected into the LLM system prompt at Layer B. Built
 *  from one or more MasterPlayResults (current FEN + look-ahead
 *  children). Read by `claimValidator` to ground SAN / numeric /
 *  entity / comparative claims. */
export interface MasterPlayContext {
  /** Primary position the user is currently looking at. */
  current: MasterPlayResult;
  /** Up to N look-ahead positions, one per top master move from the
   *  current position. Lets the LLM answer "and if I play X?" without
   *  a tool call. */
  lookahead: ReadonlyArray<{
    /** SAN of the move that produced this look-ahead position. */
    moveFromCurrent: string;
    result: MasterPlayResult;
  }>;
}
