import { describe, it, expect, beforeEach } from 'vitest';
import {
  __createMasterPlayCacheForTests,
  positionFen,
  type MasterPlayCache,
} from './masterPlayCache';
import type { MasterPlayResult } from './masterPlayTypes';

const PIRC_FEN_4 = 'rnbqkb1r/ppp1pp1p/3p1np1/8/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq -';
const PIRC_FEN_6 = `${PIRC_FEN_4} 0 4`;
const ITALIAN_FEN_4 = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -';
const NAJDORF_FEN_4 = 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq -';

function buildResult(
  fen: string,
  totalGames = 1000,
  source: MasterPlayResult['source'] = 'local',
): MasterPlayResult {
  return {
    fen: positionFen(fen),
    totalGames,
    moves: [
      {
        san: 'e4',
        games: totalGames,
        white: 400,
        draws: 400,
        black: 200,
        whitePct: 0.4,
        drawPct: 0.4,
        blackPct: 0.2,
      },
    ],
    source,
  };
}

describe('positionFen', () => {
  it('strips halfmove + fullmove counters from a 6-field FEN', () => {
    expect(positionFen(PIRC_FEN_6)).toBe(PIRC_FEN_4);
  });

  it('is a no-op on a 4-field FEN', () => {
    expect(positionFen(PIRC_FEN_4)).toBe(PIRC_FEN_4);
  });

  it('trims and collapses surrounding whitespace', () => {
    expect(positionFen(`  ${PIRC_FEN_6}  `)).toBe(PIRC_FEN_4);
  });

  it('returns trimmed input when the FEN has fewer than 4 fields (defensive)', () => {
    expect(positionFen('garbage')).toBe('garbage');
  });
});

describe('MasterPlayCache', () => {
  let cache: MasterPlayCache;

  beforeEach(() => {
    cache = __createMasterPlayCacheForTests();
  });

  describe('get / set', () => {
    it('stores then retrieves a result by 4-field FEN', () => {
      const r = buildResult(PIRC_FEN_4);
      cache.set(PIRC_FEN_4, r);
      expect(cache.get(PIRC_FEN_4)).toBe(r);
    });

    it('normalizes 6-field FENs to the same key as their 4-field form', () => {
      const r = buildResult(PIRC_FEN_4);
      cache.set(PIRC_FEN_6, r);
      expect(cache.get(PIRC_FEN_4)).toBe(r);
      expect(cache.get(PIRC_FEN_6)).toBe(r);
    });

    it('returns null on miss', () => {
      expect(cache.get(NAJDORF_FEN_4)).toBeNull();
    });

    it('overwrites an existing entry when set is called twice for the same FEN', () => {
      const a = buildResult(PIRC_FEN_4, 100);
      const b = buildResult(PIRC_FEN_4, 999);
      cache.set(PIRC_FEN_4, a);
      cache.set(PIRC_FEN_4, b);
      expect(cache.get(PIRC_FEN_4)?.totalGames).toBe(999);
      expect(cache.size()).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used entry once at capacity', () => {
      const smallCache = __createMasterPlayCacheForTests(2);
      smallCache.set(PIRC_FEN_4, buildResult(PIRC_FEN_4));
      smallCache.set(ITALIAN_FEN_4, buildResult(ITALIAN_FEN_4));
      smallCache.set(NAJDORF_FEN_4, buildResult(NAJDORF_FEN_4));
      expect(smallCache.size()).toBe(2);
      expect(smallCache.get(PIRC_FEN_4)).toBeNull();
      expect(smallCache.get(ITALIAN_FEN_4)).not.toBeNull();
      expect(smallCache.get(NAJDORF_FEN_4)).not.toBeNull();
    });

    it('refreshes LRU position on get so a touched entry survives the next eviction', () => {
      const smallCache = __createMasterPlayCacheForTests(2);
      smallCache.set(PIRC_FEN_4, buildResult(PIRC_FEN_4));
      smallCache.set(ITALIAN_FEN_4, buildResult(ITALIAN_FEN_4));
      smallCache.get(PIRC_FEN_4);
      smallCache.set(NAJDORF_FEN_4, buildResult(NAJDORF_FEN_4));
      expect(smallCache.get(PIRC_FEN_4)).not.toBeNull();
      expect(smallCache.get(ITALIAN_FEN_4)).toBeNull();
      expect(smallCache.get(NAJDORF_FEN_4)).not.toBeNull();
    });

    it('refreshes LRU position on set (overwrite)', () => {
      const smallCache = __createMasterPlayCacheForTests(2);
      smallCache.set(PIRC_FEN_4, buildResult(PIRC_FEN_4));
      smallCache.set(ITALIAN_FEN_4, buildResult(ITALIAN_FEN_4));
      smallCache.set(PIRC_FEN_4, buildResult(PIRC_FEN_4, 5));
      smallCache.set(NAJDORF_FEN_4, buildResult(NAJDORF_FEN_4));
      expect(smallCache.get(PIRC_FEN_4)?.totalGames).toBe(5);
      expect(smallCache.get(ITALIAN_FEN_4)).toBeNull();
    });
  });

  describe('in-flight dedup', () => {
    it('returns null awaitInFlight for an unknown FEN', () => {
      expect(cache.awaitInFlight(PIRC_FEN_4)).toBeNull();
      expect(cache.hasInFlight(PIRC_FEN_4)).toBe(false);
    });

    it('exposes a registered in-flight promise to subsequent callers', async () => {
      let resolveIt: (r: MasterPlayResult) => void = () => undefined;
      const promise = new Promise<MasterPlayResult>((res) => {
        resolveIt = res;
      });
      cache.setInFlight(PIRC_FEN_4, promise);
      expect(cache.hasInFlight(PIRC_FEN_4)).toBe(true);
      expect(cache.awaitInFlight(PIRC_FEN_4)).toBe(promise);
      const r = buildResult(PIRC_FEN_4);
      resolveIt(r);
      const settled = await promise;
      expect(settled).toBe(r);
    });

    it('clears the in-flight entry and stores the result on resolve', async () => {
      let resolveIt: (r: MasterPlayResult) => void = () => undefined;
      const promise = new Promise<MasterPlayResult>((res) => {
        resolveIt = res;
      });
      cache.setInFlight(PIRC_FEN_4, promise);
      const r = buildResult(PIRC_FEN_4);
      resolveIt(r);
      await promise;
      expect(cache.hasInFlight(PIRC_FEN_4)).toBe(false);
      expect(cache.get(PIRC_FEN_4)).toEqual(r);
    });

    it('clears the in-flight entry on reject without storing anything', async () => {
      let rejectIt: (e: unknown) => void = () => undefined;
      const promise = new Promise<MasterPlayResult>((_res, rej) => {
        rejectIt = rej;
      });
      cache.setInFlight(PIRC_FEN_4, promise);
      rejectIt(new Error('boom'));
      await promise.catch(() => undefined);
      expect(cache.hasInFlight(PIRC_FEN_4)).toBe(false);
      expect(cache.get(PIRC_FEN_4)).toBeNull();
    });

    it('a later setInFlight replaces the prior promise (no stale auto-store)', async () => {
      let resolveA: (r: MasterPlayResult) => void = () => undefined;
      const promiseA = new Promise<MasterPlayResult>((res) => {
        resolveA = res;
      });
      cache.setInFlight(PIRC_FEN_4, promiseA);

      let resolveB: (r: MasterPlayResult) => void = () => undefined;
      const promiseB = new Promise<MasterPlayResult>((res) => {
        resolveB = res;
      });
      cache.setInFlight(PIRC_FEN_4, promiseB);

      resolveA(buildResult(PIRC_FEN_4, 1));
      await promiseA;
      expect(cache.get(PIRC_FEN_4)).toBeNull();

      resolveB(buildResult(PIRC_FEN_4, 999));
      await promiseB;
      expect(cache.get(PIRC_FEN_4)?.totalGames).toBe(999);
    });
  });

  describe('clear', () => {
    it('flushes both maps', () => {
      cache.set(PIRC_FEN_4, buildResult(PIRC_FEN_4));
      const pending = new Promise<MasterPlayResult>(() => undefined);
      cache.setInFlight(ITALIAN_FEN_4, pending);
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.hasInFlight(ITALIAN_FEN_4)).toBe(false);
    });
  });
});
