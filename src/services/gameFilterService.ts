/**
 * gameFilterService — the "games behind any stat" backbone.
 *
 * Every aggregate stat on /weaknesses (activity heatmap cells,
 * time-control rows, critical-moments cards, phase-strength
 * heatmap cells, tactic-recognition matrix rows, personal records,
 * opening proficiency cells, Patterns cards, etc.) can be
 * represented as a `StatFilter`. The drilldown UI passes a list of
 * filters; this service resolves them to a set of game IDs that
 * satisfy ALL of them (set intersection).
 *
 * The drilldown then renders those games — clickable, each routes
 * to `/coach/review/:gameId` for full review-with-coach.
 *
 * Design: every filter type encodes EXACTLY what's needed to
 * recompute the game set without re-running an analytics query.
 * That keeps the URL state compact and deterministic, and lets us
 * dedupe identical filter chips without ambiguity.
 */
import { db } from '../db/schema';
import type {
  GameRecord,
  GamePhase,
  TacticType,
} from '../types';
import type { TimeControlBucket } from './analyticsService';

// ─── Filter shape ─────────────────────────────────────────────────────────

/**
 * A single filter chip. Multi-select stacks these in an array — the
 * resolver intersects their gameId sets.
 *
 * `label` is human-readable, shown in the chip + analytics audit
 * trail. Every variant carries the label inline so the panel can
 * render chips without re-deriving labels from cryptic data.
 */
export type StatFilter =
  | { source: 'activity-day'; date: string; label: string }                            // YYYY-MM-DD
  | { source: 'time-control'; bucket: TimeControlBucket; label: string }
  | { source: 'phase-month'; phase: GamePhase; monthKey: string; label: string }       // YYYY-MM
  | { source: 'tactic-type'; tacticType: TacticType; label: string }
  | { source: 'opening'; eco: string | null; playerColor?: 'white' | 'black'; label: string }
  | { source: 'game-ids'; ids: string[]; label: string }                               // analytics-returned lists
  | { source: 'result'; result: 'win' | 'loss' | 'draw'; label: string }
  | { source: 'player-color'; color: 'white' | 'black'; label: string }
  | { source: 'critical-moments'; phase?: GamePhase; missed?: boolean; label: string };

export interface StatFilterSet {
  filters: StatFilter[];
}

// ─── Resolver ─────────────────────────────────────────────────────────────

const AI_NAMES = ['AI Coach', 'Stockfish Bot'];

function getPlayerColor(game: GameRecord, username: string | null): 'white' | 'black' | null {
  if (AI_NAMES.includes(game.white)) return 'black';
  if (AI_NAMES.includes(game.black)) return 'white';
  if (username) {
    const lower = username.toLowerCase();
    if (game.white.toLowerCase() === lower) return 'white';
    if (game.black.toLowerCase() === lower) return 'black';
  }
  return null;
}

function parseTimeControlBucket(pgn: string): TimeControlBucket {
  const match = /\[TimeControl\s+"([^"]+)"\]/.exec(pgn);
  if (!match) return 'unknown';
  const v = match[1].trim();
  if (v === '-' || v === '*') return 'unknown';
  if (/^\d+\/\d+$/.test(v)) return 'correspondence';
  const tc = /^(\d+)(?:\+(\d+))?$/.exec(v);
  if (!tc) return 'unknown';
  const initial = Number(tc[1]);
  const increment = tc[2] ? Number(tc[2]) : 0;
  const expected = initial + 40 * increment;
  if (expected <= 179) return 'bullet';
  if (expected <= 479) return 'blitz';
  if (expected <= 1499) return 'rapid';
  return 'classical';
}

function isWin(game: GameRecord, playerColor: 'white' | 'black'): boolean {
  return (playerColor === 'white' && game.result === '1-0') ||
    (playerColor === 'black' && game.result === '0-1');
}
function isLoss(game: GameRecord, playerColor: 'white' | 'black'): boolean {
  return (playerColor === 'white' && game.result === '0-1') ||
    (playerColor === 'black' && game.result === '1-0');
}

function phaseForMoveNumber(moveNumber: number): GamePhase {
  if (moveNumber <= 10) return 'opening';
  if (moveNumber >= 30) return 'endgame';
  return 'middlegame';
}

/** Apply one filter to a candidate set. Pure — no DB queries
 *  inside, just predicate evaluation. */
function gamePassesFilter(
  game: GameRecord,
  playerColor: 'white' | 'black',
  filter: StatFilter,
): boolean {
  switch (filter.source) {
    case 'activity-day':
      return (game.date || '').slice(0, 10) === filter.date;
    case 'time-control':
      return parseTimeControlBucket(game.pgn) === filter.bucket;
    case 'phase-month': {
      const monthKey = (game.date || '').slice(0, 7);
      if (monthKey !== filter.monthKey) return false;
      // Must have at least one annotated player move in the target phase
      if (!game.annotations || game.annotations.length === 0) return false;
      return game.annotations.some(
        (ann) => ann.color === playerColor && phaseForMoveNumber(ann.moveNumber) === filter.phase,
      );
    }
    case 'tactic-type':
      // Match games where the tactic appears in annotations (found or missed)
      if (!game.annotations || game.annotations.length === 0) return false;
      // Best-effort match: scan classifications + tactic tags on the
      // annotation. We don't have a dedicated `tacticType` on
      // MoveAnnotation today, so the resolver falls back to the
      // game's source mistakePuzzles for tactic attribution.
      return false; // resolved via game-ids path instead
    case 'opening':
      if (filter.eco && game.eco !== filter.eco) return false;
      if (filter.playerColor && playerColor !== filter.playerColor) return false;
      return true;
    case 'game-ids':
      return filter.ids.includes(game.id);
    case 'result':
      if (filter.result === 'win') return isWin(game, playerColor);
      if (filter.result === 'loss') return isLoss(game, playerColor);
      return game.result === '1/2-1/2';
    case 'player-color':
      return playerColor === filter.color;
    case 'critical-moments': {
      if (!game.fullyAnalyzed || !game.annotations) return false;
      const CRITICAL_CP = 100;
      return game.annotations.some((ann) => {
        if (ann.color !== playerColor) return false;
        if (ann.bestMoveEval === null || ann.evaluation === null || ann.bestMove === null) return false;
        if (filter.phase && phaseForMoveNumber(ann.moveNumber) !== filter.phase) return false;
        const playerBestEval = playerColor === 'white' ? ann.bestMoveEval : -ann.bestMoveEval;
        const playerActualEval = playerColor === 'white' ? ann.evaluation : -ann.evaluation;
        const swing = playerBestEval - playerActualEval;
        if (swing < CRITICAL_CP) return false;
        // If `missed` is true, only count critical positions the user MISSED.
        if (filter.missed === true) return ann.san !== ann.bestMove;
        if (filter.missed === false) return ann.san === ann.bestMove;
        return true;
      });
    }
  }
}

/** Resolve a set of filters to a list of game IDs. Multi-select =
 *  intersection (game must pass ALL filters). */
export async function resolveFiltersToGames(filters: StatFilter[]): Promise<GameRecord[]> {
  if (filters.length === 0) {
    return await db.games
      .filter((g) => !g.isMasterGame && g.result !== '*')
      .toArray();
  }
  const profile = await db.profiles.toCollection().first();
  const username = profile?.preferences.chessComUsername
    ?? profile?.preferences.lichessUsername
    ?? profile?.name
    ?? null;

  // Tactic-type filters resolve via the classifiedTactics table:
  // every row references a sourceGameId, so we collect the matching
  // game IDs upfront and treat the filter like a `game-ids` filter
  // for the rest of the pipeline. Avoids per-game annotation
  // scanning (which doesn't carry tactic-type metadata).
  const tacticTypeFilters = filters.filter(
    (f): f is Extract<StatFilter, { source: 'tactic-type' }> => f.source === 'tactic-type',
  );
  const tacticTypeIds: Set<string>[] = [];
  for (const f of tacticTypeFilters) {
    const rows = await db.classifiedTactics.where('tacticType').equals(f.tacticType).toArray();
    tacticTypeIds.push(new Set(rows.map((r) => r.sourceGameId)));
  }

  // Pull `game-ids` filters out of the predicate path — they short-
  // circuit the candidate set instead of being evaluated per-game.
  const gameIdFilters = filters.filter(
    (f): f is Extract<StatFilter, { source: 'game-ids' }> => f.source === 'game-ids',
  );
  const otherFilters = filters.filter((f) => f.source !== 'game-ids' && f.source !== 'tactic-type');

  let candidateIds: Set<string> | null = null;
  const collect = (next: Set<string>): void => {
    if (candidateIds === null) {
      candidateIds = next;
    } else {
      const intersected = new Set<string>();
      for (const id of candidateIds) {
        if (next.has(id)) intersected.add(id);
      }
      candidateIds = intersected;
    }
  };
  for (const f of gameIdFilters) collect(new Set<string>(f.ids));
  for (const set of tacticTypeIds) collect(set);

  const allGames = await db.games
    .filter((g) => !g.isMasterGame && g.result !== '*')
    .toArray();

  return allGames.filter((game) => {
    if (candidateIds && !candidateIds.has(game.id)) return false;
    const playerColor = getPlayerColor(game, username);
    if (!playerColor) return false;
    return otherFilters.every((f) => gamePassesFilter(game, playerColor, f));
  });
}

// ─── URL encode / decode ──────────────────────────────────────────────────
//
// Compact base64 of the filter array — keeps the URL readable when
// there are a few chips, scales to many without bloating beyond the
// browser's 2KB practical limit. We can swap for an in-memory store
// later if multi-select trains grow long.

export function encodeFilters(filters: StatFilter[]): string {
  try {
    return btoa(encodeURIComponent(JSON.stringify(filters)));
  } catch {
    return '';
  }
}

export function decodeFilters(encoded: string): StatFilter[] {
  if (!encoded) return [];
  try {
    const json = decodeURIComponent(atob(encoded));
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is StatFilter => typeof f === 'object' && f !== null && 'source' in f && 'label' in f,
    );
  } catch {
    return [];
  }
}
