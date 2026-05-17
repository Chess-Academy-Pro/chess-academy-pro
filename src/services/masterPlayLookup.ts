/**
 * masterPlayLookup
 * ----------------
 * Resolves master-play statistics for a given FEN. The single source
 * of truth that the watcher, pre-injection, and LLM tool path all
 * route through.
 *
 * Resolution order:
 *
 *   1. In-memory cache (sync) — `masterPlayCache.get(fen)`.
 *   2. Local extended DB (sync after first lazy-load) —
 *      `src/data/openings-lichess-extended.json`. Built offline by
 *      `scripts/enrich-openings-db.mjs` from the Lichess masters
 *      explorer. Sparse: `{ san, games }` per move. Tolerates an
 *      empty file (parallel workstream not merged yet — fall through
 *      cleanly to live).
 *   3. Live Lichess (async) — `lichessExplorerService.fetchLichessExplorer`
 *      with `source: 'masters'`. Only fired when:
 *        - local missed, AND
 *        - `navigator.onLine === true`, AND
 *        - `opts.localOnly !== true`.
 *      Lichess's circuit breaker + 8s timeout still apply.
 *   4. Both miss / offline / live failed → returns
 *      `{ source: 'none', totalGames: 0, moves: [] }`. Never null.
 *
 * In-flight dedup: two concurrent callers asking for the same FEN
 * share one promise via `masterPlayCache.setInFlight(...)`. The
 * watcher's look-ahead prefetch and the LLM tool's just-in-time call
 * converge.
 *
 * Emits `master-play-lookup` audit events for the resolver call (not
 * for prefetches — the watcher has its own `master-play-prefetch`).
 *
 * G3 contract: this function never returns invented data. When both
 * sources miss, source is `'none'` and `moves` is empty. The brain
 * sees that and either says-so to the user or stays silent on
 * grounded claims.
 */

import { masterPlayCache, positionFen } from './masterPlayCache';
import type {
  MasterPlayMove,
  MasterPlayResult,
  MasterPlayTopGame,
} from './masterPlayTypes';
import { fetchLichessExplorer } from './lichessExplorerService';
import { logAppAudit } from './appAuditor';
import type { LichessExplorerResult } from '../types';

/** Sparse local-DB shape produced by `scripts/enrich-openings-db.mjs`.
 *  Each position maps to a list of moves with at minimum `san` +
 *  `games`. Fixtures may include richer fields; we surface whatever
 *  is present and zero the rest. */
interface LocalDbMove {
  san: string;
  uci?: string;
  games: number;
  white?: number;
  draws?: number;
  black?: number;
  averageRating?: number;
}

interface LocalDbRichEntry {
  totalGames?: number;
  moves: LocalDbMove[];
  topGames?: MasterPlayTopGame[];
}

/** Two shapes accepted, in order of preference:
 *   1. `{ positions: { [fen]: LocalDbMove[] } }`  — enrich-openings-db.mjs output
 *   2. `{ [fen]: { totalGames, moves: LocalDbMove[], topGames? } }` — richer test fixture form
 *  Anything else (empty `{}`, `[]`, malformed, or 3-byte placeholder)
 *  is treated as universal local-miss. */
type LocalDb =
  | { positions: Record<string, LocalDbMove[]> }
  | Record<string, LocalDbRichEntry>;

/** Audit trigger label. The watcher emits its own `master-play-prefetch`
 *  events with these labels; the lookup re-uses the same vocabulary
 *  when called from non-prefetch paths so audit-stream filters work
 *  uniformly. */
export type LookupTrigger =
  | 'pre-injection'
  | 'llm-tool-call'
  | 'watcher-current'
  | 'watcher-lookahead'
  | 'watcher-walkthrough-preload'
  | 'manual';

export interface LookupOptions {
  /** Who is asking? Goes to the audit event. */
  triggeredBy: LookupTrigger;
  /** Surface name (e.g. `/coach/chat`). Goes to the audit event. */
  surface?: string;
  /** Session correlator. Goes to the audit event. */
  sessionId?: string;
  /** Skip the live Lichess fallback. Watcher's look-ahead may use
   *  this knob to keep prefetches free; pre-injection / tool call
   *  always lets the live path run. */
  localOnly?: boolean;
  /** Test-only — inject a synthetic local DB without touching the
   *  bundled `openings-lichess-extended.json`. Production code never
   *  passes this. */
  __testLocalDb?: LocalDb;
}

// ─── Local-DB lazy load ────────────────────────────────────────────

let localDbCache: LocalDb | null | undefined;

async function getLocalDb(): Promise<LocalDb | null> {
  if (localDbCache !== undefined) return localDbCache;
  try {
    const mod = await import('../data/openings-lichess-extended.json');
    const raw = (mod as { default?: unknown }).default ?? (mod as unknown);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      // Detect the "empty placeholder" case (3-byte `[]` or `{}`).
      if (Object.keys(obj).length === 0) {
        localDbCache = null;
        return null;
      }
      localDbCache = obj as LocalDb;
      return localDbCache;
    }
    localDbCache = null;
    return null;
  } catch {
    // File missing / parse error / dynamic-import not supported in this
    // env. Treat as "no local data" — every lookup falls through to
    // live. Silent: this is the expected steady state while the parallel
    // workstream's data hasn't merged.
    localDbCache = null;
    return null;
  }
}

/** Test-only — reset the lazy-load cache. */
export function __resetLocalDbForTests(): void {
  localDbCache = undefined;
}

// ─── Resolver ──────────────────────────────────────────────────────

function readLocal(
  db: LocalDb,
  fen: string,
): { moves: LocalDbMove[]; topGames?: MasterPlayTopGame[] } | null {
  const key = positionFen(fen);
  if ('positions' in db && db.positions && typeof db.positions === 'object') {
    const hit = (db as { positions: Record<string, LocalDbMove[]> }).positions[key];
    return Array.isArray(hit) && hit.length > 0 ? { moves: hit } : null;
  }
  const richHit = (db as Record<string, LocalDbRichEntry>)[key];
  if (richHit && Array.isArray(richHit.moves) && richHit.moves.length > 0) {
    return { moves: richHit.moves, topGames: richHit.topGames };
  }
  return null;
}

function buildResultFromLocal(
  fen: string,
  entry: { moves: LocalDbMove[]; topGames?: MasterPlayTopGame[] },
): MasterPlayResult {
  const sorted = [...entry.moves].sort((a, b) => b.games - a.games);
  const totalGames = sorted.reduce((sum, m) => sum + (m.games || 0), 0);
  const out: MasterPlayMove[] = sorted.map((m) => {
    const games = m.games || 0;
    const white = m.white ?? 0;
    const draws = m.draws ?? 0;
    const black = m.black ?? 0;
    const ratedGames = white + draws + black;
    const safe = ratedGames > 0 ? ratedGames : games;
    return {
      san: m.san,
      uci: m.uci,
      games,
      white,
      draws,
      black,
      whitePct: safe > 0 && ratedGames > 0 ? white / safe : 0,
      drawPct: safe > 0 && ratedGames > 0 ? draws / safe : 0,
      blackPct: safe > 0 && ratedGames > 0 ? black / safe : 0,
      averageRating: m.averageRating,
    };
  });
  return {
    fen: positionFen(fen),
    totalGames,
    moves: out,
    source: 'local',
    topGames: entry.topGames,
  };
}

function buildResultFromLichess(
  fen: string,
  payload: LichessExplorerResult,
): MasterPlayResult {
  const moves = payload.moves ?? [];
  const sorted = [...moves].sort((a, b) => {
    const ag = (a.white ?? 0) + (a.draws ?? 0) + (a.black ?? 0);
    const bg = (b.white ?? 0) + (b.draws ?? 0) + (b.black ?? 0);
    return bg - ag;
  });
  let totalGames = 0;
  const out: MasterPlayMove[] = sorted.map((m) => {
    const white = m.white ?? 0;
    const draws = m.draws ?? 0;
    const black = m.black ?? 0;
    const games = white + draws + black;
    totalGames += games;
    return {
      san: m.san,
      uci: m.uci,
      games,
      white,
      draws,
      black,
      whitePct: games > 0 ? white / games : 0,
      drawPct: games > 0 ? draws / games : 0,
      blackPct: games > 0 ? black / games : 0,
      averageRating: typeof m.averageRating === 'number' ? m.averageRating : undefined,
    };
  });
  const topGames: MasterPlayTopGame[] | undefined = Array.isArray(payload.topGames)
    ? payload.topGames.map((g) => ({
        id: g.id,
        white: g.white?.name,
        black: g.black?.name,
        whiteRating: g.white?.rating,
        blackRating: g.black?.rating,
        year: typeof g.year === 'number' ? g.year : undefined,
        month: g.month,
        // Lichess returns winner: 'white' | 'black' | null. null === draw.
        result:
          g.winner === 'white'
            ? '1-0'
            : g.winner === 'black'
              ? '0-1'
              : '1/2-1/2',
      }))
    : undefined;
  // An empty Lichess response — moves:[], totalGames:0 — carries no
  // grounded data, so callers must be able to distinguish it from a
  // successful response with statistics. Collapse to source:'none' so
  // the claim validator's "no chess claims allowed" branch fires
  // uniformly whether the source missed locally, missed live, or
  // returned an empty live response.
  if (out.length === 0 && totalGames === 0) {
    return { fen: positionFen(fen), totalGames: 0, moves: [], source: 'none' };
  }
  return {
    fen: positionFen(fen),
    totalGames,
    moves: out,
    source: 'lichess-live',
    topGames: topGames && topGames.length > 0 ? topGames : undefined,
  };
}

function emptyResult(fen: string): MasterPlayResult {
  return { fen: positionFen(fen), totalGames: 0, moves: [], source: 'none' };
}

function emitLookupAudit(
  fen: string,
  result: MasterPlayResult,
  latencyMs: number,
  opts: LookupOptions,
): void {
  void logAppAudit({
    kind: 'master-play-lookup',
    category: 'subsystem',
    source: 'masterPlayLookup.lookupMasterPlay',
    summary: `fen=${positionFen(fen).slice(0, 40)}… source=${result.source} moves=${result.moves.length} games=${result.totalGames} latency=${latencyMs}ms trigger=${opts.triggeredBy}`,
    details: JSON.stringify({
      fen: positionFen(fen),
      source: result.source,
      moveCount: result.moves.length,
      totalGames: result.totalGames,
      latencyMs,
      triggeredBy: opts.triggeredBy,
      surface: opts.surface,
      sessionId: opts.sessionId,
    }),
  });
}

/**
 * Resolve master-play statistics for a position. Always returns a
 * `MasterPlayResult` — never null. `source: 'none'` means both
 * sources missed (or the device is offline AND local missed).
 *
 * Idempotent: repeat callers within the cache TTL get the cached
 * value at zero network cost.
 */
export async function lookupMasterPlay(
  fen: string,
  opts: LookupOptions,
): Promise<MasterPlayResult> {
  const started = Date.now();
  const key = positionFen(fen);

  // 1. Cache hit?
  const cached = masterPlayCache.get(key);
  if (cached) {
    emitLookupAudit(key, cached, Date.now() - started, opts);
    return cached;
  }

  // 2. In-flight? Share the promise.
  const inflight = masterPlayCache.awaitInFlight(key);
  if (inflight) {
    const settled = await inflight;
    emitLookupAudit(key, settled, Date.now() - started, opts);
    return settled;
  }

  // 3. New lookup. Build a promise, register it for dedup, then
  //    resolve from local → live → none.
  const promise = (async (): Promise<MasterPlayResult> => {
    const db = opts.__testLocalDb ?? (await getLocalDb());
    if (db) {
      const localMoves = readLocal(db, key);
      if (localMoves) {
        return buildResultFromLocal(key, localMoves);
      }
    }
    if (opts.localOnly) {
      return emptyResult(key);
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return emptyResult(key);
    }
    try {
      const payload = await fetchLichessExplorer(key, 'masters');
      return buildResultFromLichess(key, payload);
    } catch {
      // lichessExplorerService already emits its own `lichess-error`
      // audit — don't double-log. Just return empty.
      return emptyResult(key);
    }
  })();

  masterPlayCache.setInFlight(key, promise);
  const result = await promise;
  emitLookupAudit(key, result, Date.now() - started, opts);
  return result;
}

/** Test-only — clear everything (cache + lazy-loaded local DB).
 *  Production code never calls this. */
export function __resetMasterPlayLookupForTests(): void {
  __resetLocalDbForTests();
  masterPlayCache.clear();
}
