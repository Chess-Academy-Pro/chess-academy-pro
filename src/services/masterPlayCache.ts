/**
 * masterPlayCache
 * ---------------
 * In-memory LRU + in-flight promise map for master-play lookups.
 *
 * Two roles:
 *
 *   1. Caches resolved `MasterPlayResult`s keyed by normalized
 *      position-FEN. Bounded at MAX_ENTRIES; least-recently-used
 *      eviction. Master statistics never change — entries do not
 *      expire on time, only on capacity pressure.
 *
 *   2. Tracks in-flight lookup promises. Two callers asking for the
 *      same FEN simultaneously share one network round-trip. The
 *      watcher's look-ahead prefetch and the LLM tool's just-in-time
 *      lookup converge cleanly through this dedup.
 *
 * Keys are normalized to the 4-field "position FEN" (piece placement,
 * side, castling, en-passant) so transpositions hit the same entry
 * regardless of halfmove / fullmove counters. Callers can pass either
 * a 4-field or 6-field FEN; the cache normalizes internally.
 *
 * No Dexie persistence — in-memory only. Cold-start cost is paid on
 * the watcher's first prefetch, which happens before the user can
 * type a question.
 */

import type { MasterPlayResult } from './masterPlayTypes';

/** Bound on resolved entries. ~1 KB per entry → ~1 MB at cap. */
const MAX_ENTRIES = 1000;

/**
 * Normalize an arbitrary FEN to the 4-field position-FEN form. Strips
 * halfmove + fullmove counters so transpositions key identically.
 * Trims and collapses internal whitespace.
 *
 * Exported so `masterPlayLookup` and the watcher reuse the same
 * normalization — divergent normalizers would cause cache misses on
 * positions that should hit.
 */
export function positionFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) return fen.trim();
  return fields.slice(0, 4).join(' ');
}

class MasterPlayCache {
  private readonly maxEntries: number;
  private readonly entries: Map<string, MasterPlayResult>;
  private readonly inFlight: Map<string, Promise<MasterPlayResult>>;

  constructor(maxEntries: number = MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  /** Synchronous read. Returns null on miss. On hit, refreshes the
   *  entry's LRU position. */
  get(fen: string): MasterPlayResult | null {
    const key = positionFen(fen);
    const hit = this.entries.get(key);
    if (!hit) return null;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** Store a resolved entry. Evicts the least-recently-used entry if
   *  the cache is at capacity. */
  set(fen: string, result: MasterPlayResult): void {
    const key = positionFen(fen);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, result);
  }

  /** Tells callers whether a resolved entry exists without bumping
   *  the LRU position. Use for read-without-touch checks. */
  has(fen: string): boolean {
    return this.entries.has(positionFen(fen));
  }

  /** Is a lookup for this FEN already in flight? */
  hasInFlight(fen: string): boolean {
    return this.inFlight.has(positionFen(fen));
  }

  /** Return the in-flight promise for this FEN, or null. Callers
   *  awaiting an existing prefetch don't trigger a duplicate network
   *  round-trip. */
  awaitInFlight(fen: string): Promise<MasterPlayResult> | null {
    return this.inFlight.get(positionFen(fen)) ?? null;
  }

  /** Register an in-flight promise. Auto-removes on settle (resolve
   *  or reject) so a failed lookup doesn't poison subsequent calls
   *  for the same FEN. */
  setInFlight(fen: string, promise: Promise<MasterPlayResult>): void {
    const key = positionFen(fen);
    this.inFlight.set(key, promise);
    void promise
      .then((result) => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
          this.set(key, result);
        }
      })
      .catch(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
  }

  /** Current count of resolved entries. Test-only. */
  size(): number {
    return this.entries.size;
  }

  /** Current count of in-flight promises. Test-only. */
  inFlightSize(): number {
    return this.inFlight.size;
  }

  /** Test-only — flush both maps. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

/** Process-singleton cache. Watcher + lookup + tool-handler all share. */
export const masterPlayCache = new MasterPlayCache();

/** Test-only — fresh instance for isolation. Production code does
 *  not call this. */
export function __createMasterPlayCacheForTests(maxEntries?: number): MasterPlayCache {
  return new MasterPlayCache(maxEntries);
}

export type { MasterPlayCache };
