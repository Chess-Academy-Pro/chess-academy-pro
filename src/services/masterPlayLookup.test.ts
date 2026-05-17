import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  lookupMasterPlay,
  __resetMasterPlayLookupForTests,
} from './masterPlayLookup';
import { _resetLichessCircuitBreaker } from './lichessExplorerService';
import { masterPlayCache, positionFen } from './masterPlayCache';
import fixture from '../test/fixtures/masters-test-db.json';

const STARTING_FEN_4 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const STARTING_FEN_6 = `${STARTING_FEN_4} 0 1`;
// Pre-3.Bc4 position — the fixture has topGames at this entry.
const ITALIAN_PRE_BC4_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -';
const UNKNOWN_FEN = '8/8/8/8/8/8/8/8 w - -';

function stubFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async (): Promise<Response> =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(fn);
  return fn;
}

beforeEach(() => {
  __resetMasterPlayLookupForTests();
  _resetLichessCircuitBreaker();
});

afterEach(() => {
  __resetMasterPlayLookupForTests();
  vi.restoreAllMocks();
});

describe('lookupMasterPlay — local hits', () => {
  it('returns source:local when the fixture has the position', async () => {
    const r = await lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.source).toBe('local');
    expect(r.fen).toBe(STARTING_FEN_4);
    expect(r.totalGames).toBe(22000 + 19000 + 6500 + 2500);
    expect(r.moves.map((m) => m.san)).toEqual(['e4', 'd4', 'Nf3', 'c4']);
    expect(r.moves[0].whitePct).toBeGreaterThan(0);
    expect(
      r.moves[0].whitePct + r.moves[0].drawPct + r.moves[0].blackPct,
    ).toBeCloseTo(1, 5);
  });

  it('normalizes 6-field FEN to the same local entry', async () => {
    const r = await lookupMasterPlay(STARTING_FEN_6, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.source).toBe('local');
    expect(r.totalGames).toBeGreaterThan(0);
  });

  it('promotes entry-level topGames into result.topGames', async () => {
    const r = await lookupMasterPlay(ITALIAN_PRE_BC4_FEN, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.source).toBe('local');
    expect(r.topGames?.length).toBe(1);
    expect(r.topGames?.[0].white).toBe('Carlsen, M');
    expect(r.topGames?.[0].black).toBe('Caruana, F');
    expect(r.topGames?.[0].year).toBe(2018);
  });

  it('accepts the sparse `{ positions: { fen: [{san,games}] } }` shape', async () => {
    const sparseDb = {
      positions: {
        [STARTING_FEN_4]: [
          { san: 'e4', games: 100 },
          { san: 'd4', games: 80 },
        ],
      },
    };
    const r = await lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: sparseDb,
    });
    expect(r.source).toBe('local');
    expect(r.totalGames).toBe(180);
    expect(r.moves[0].san).toBe('e4');
    expect(r.moves[0].whitePct).toBe(0);
    expect(r.moves[0].drawPct).toBe(0);
    expect(r.moves[0].blackPct).toBe(0);
  });
});

describe('lookupMasterPlay — caching + dedup', () => {
  it('serves the second call from the cache (no second local read)', async () => {
    const r1 = await lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    const r2 = await lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: { positions: {} },
    });
    expect(r2).toBe(r1);
  });

  it('dedupes concurrent callers asking for the same FEN', async () => {
    const p1 = lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    const p2 = lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(masterPlayCache.hasInFlight(STARTING_FEN_4)).toBe(true);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });
});

describe('lookupMasterPlay — live fallback', () => {
  it('falls through to live Lichess when local misses, online', async () => {
    stubFetch({
      white: 10,
      draws: 20,
      black: 5,
      moves: [
        { uci: 'e2e4', san: 'e4', averageRating: 2500, white: 10, draws: 20, black: 5, game: null },
      ],
      topGames: [],
      opening: null,
    });
    const r = await lookupMasterPlay(UNKNOWN_FEN, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.source).toBe('lichess-live');
    expect(r.moves[0].san).toBe('e4');
    expect(r.moves[0].games).toBe(35);
    expect(r.moves[0].whitePct).toBeCloseTo(10 / 35, 5);
  });

  it('skips live when localOnly is true (returns source:none on miss)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    const r = await lookupMasterPlay(UNKNOWN_FEN, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
      localOnly: true,
    });
    expect(r.source).toBe('none');
    expect(r.totalGames).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns source:none on Lichess error (no throw to caller)', async () => {
    stubFetch({ error: 'boom' }, 500);
    const r = await lookupMasterPlay(UNKNOWN_FEN, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.source).toBe('none');
    expect(r.moves).toEqual([]);
  });

  it('returns source:none when offline (does not even attempt live)', async () => {
    const originalDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const r = await lookupMasterPlay(UNKNOWN_FEN, {
        triggeredBy: 'manual',
        __testLocalDb: fixture,
      });
      expect(r.source).toBe('none');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (originalDesc) Object.defineProperty(globalThis.navigator, 'onLine', originalDesc);
    }
  });

  it('maps Lichess topGames into result.topGames with mapped winner→result', async () => {
    stubFetch({
      white: 100,
      draws: 100,
      black: 100,
      moves: [
        { uci: 'e2e4', san: 'e4', averageRating: 2500, white: 100, draws: 100, black: 100, game: null },
      ],
      topGames: [
        { id: 'g1', white: { name: 'A', rating: 2700 }, black: { name: 'B', rating: 2680 }, winner: 'white', year: 2010, month: '2010-03' },
        { id: 'g2', white: { name: 'C', rating: 2710 }, black: { name: 'D', rating: 2690 }, winner: 'black', year: 2011, month: '2011-06' },
        { id: 'g3', white: { name: 'E', rating: 2720 }, black: { name: 'F', rating: 2700 }, winner: null, year: 2012, month: '2012-09' },
      ],
      opening: null,
    });
    const r = await lookupMasterPlay(UNKNOWN_FEN, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.topGames?.length).toBe(3);
    expect(r.topGames?.[0].result).toBe('1-0');
    expect(r.topGames?.[1].result).toBe('0-1');
    expect(r.topGames?.[2].result).toBe('1/2-1/2');
  });
});

describe('lookupMasterPlay — empty/missing local DB', () => {
  it('treats `{}` as universal miss; falls through to live', async () => {
    stubFetch({
      white: 1,
      draws: 1,
      black: 1,
      moves: [{ uci: 'e2e4', san: 'e4', averageRating: 2500, white: 1, draws: 1, black: 1, game: null }],
      topGames: [],
      opening: null,
    });
    const r = await lookupMasterPlay(STARTING_FEN_4, {
      triggeredBy: 'manual',
      __testLocalDb: {},
    });
    expect(r.source).toBe('lichess-live');
  });

  it('uses positionFen key on the result regardless of input form', async () => {
    const r = await lookupMasterPlay(STARTING_FEN_6, {
      triggeredBy: 'manual',
      __testLocalDb: fixture,
    });
    expect(r.fen).toBe(positionFen(STARTING_FEN_6));
    expect(r.fen).toBe(STARTING_FEN_4);
  });
});
