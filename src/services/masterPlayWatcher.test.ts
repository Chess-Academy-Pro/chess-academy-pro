import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  prefetchMasterPlay,
  prefetchWalkthroughSequence,
  __isKidSurfaceForTests,
  LOOKAHEAD_CANDIDATES,
} from './masterPlayWatcher';
import {
  __resetMasterPlayLookupForTests,
} from './masterPlayLookup';
import { _resetLichessCircuitBreaker } from './lichessExplorerService';
import { masterPlayCache } from './masterPlayCache';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_FEN_4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
const AFTER_D4_FEN_4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -';

// Inject the fixture into all prefetches by passing it via the lookup
// path. We can't pass __testLocalDb through the watcher API, so we
// stub `import('../data/openings-lichess-extended.json')` via the
// lookup's dynamic import. Instead — set up a fetch stub returning
// empty, and rely on the local DB being loadable. The easiest path:
// directly call `lookupMasterPlay` with the fixture to warm the cache,
// then the watcher's calls will see cache hits. For miss cases, stub
// fetch.

// However the watcher CALLS lookupMasterPlay internally without
// __testLocalDb. So tests need to either:
//   a) Stub the dynamic import — complex.
//   b) Stub fetch and rely on live path.
// Going with (b). The cache state assertions still work because
// the watcher routes through masterPlayCache.

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

/** Build a Lichess explorer payload matching the fixture's starting-FEN
 *  entry so the watcher's "current" prefetch returns those 4 moves. */
const STARTING_FEN_EXPLORER_PAYLOAD = {
  white: 19950,
  draws: 20200,
  black: 9900,
  moves: [
    { uci: 'e2e4', san: 'e4', averageRating: 2480, white: 9000, draws: 8500, black: 4500, game: null },
    { uci: 'd2d4', san: 'd4', averageRating: 2510, white: 7600, draws: 7800, black: 3600, game: null },
    { uci: 'g1f3', san: 'Nf3', averageRating: 2500, white: 2400, draws: 2800, black: 1300, game: null },
    { uci: 'c2c4', san: 'c4', averageRating: 2520, white: 950, draws: 1100, black: 450, game: null },
  ],
  topGames: [],
  opening: null,
};

beforeEach(() => {
  __resetMasterPlayLookupForTests();
  _resetLichessCircuitBreaker();
});

afterEach(() => {
  __resetMasterPlayLookupForTests();
  vi.restoreAllMocks();
});

describe('__isKidSurfaceForTests', () => {
  it('matches /kid/* prefixes', () => {
    expect(__isKidSurfaceForTests('/kid')).toBe(true);
    expect(__isKidSurfaceForTests('/kid/pawn-games')).toBe(true);
    expect(__isKidSurfaceForTests('/kid/knight-games/play')).toBe(true);
    expect(__isKidSurfaceForTests('/kid/journey/level-1')).toBe(true);
  });

  it('does NOT match coach / openings / dashboard routes', () => {
    expect(__isKidSurfaceForTests('/coach/chat')).toBe(false);
    expect(__isKidSurfaceForTests('/coach/teach')).toBe(false);
    expect(__isKidSurfaceForTests('/openings/italian-game')).toBe(false);
    expect(__isKidSurfaceForTests('/')).toBe(false);
    expect(__isKidSurfaceForTests('/kidsomething')).toBe(false); // doesn't begin /kid/
  });
});

describe('prefetchMasterPlay — kid exclusion', () => {
  it('returns immediately without hitting cache or network on /kid/* surfaces', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await prefetchMasterPlay(STARTING_FEN, { surface: '/kid/pawn-games' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(masterPlayCache.size()).toBe(0);
  });

  it('returns immediately on /kid/journey/*', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await prefetchMasterPlay(STARTING_FEN, { surface: '/kid/journey/maze-1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefetchWalkthroughSequence also short-circuits on /kid/*', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await prefetchWalkthroughSequence([STARTING_FEN, AFTER_E4_FEN_4], {
      surface: '/kid/pawn-games',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('prefetchMasterPlay — current + look-ahead', () => {
  it('populates the cache for the current FEN', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat' });
    const cached = masterPlayCache.get(STARTING_FEN);
    expect(cached).not.toBeNull();
    expect(cached?.moves.map((m) => m.san)).toContain('e4');
  });

  it('look-ahead also populates the cache for the top-3 child positions', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat' });
    // Child positions after e4, d4, Nf3 should now be in the cache too.
    expect(masterPlayCache.has(AFTER_E4_FEN_4)).toBe(true);
    expect(masterPlayCache.has(AFTER_D4_FEN_4)).toBe(true);
  });

  it('look-ahead is bounded by LOOKAHEAD_CANDIDATES', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat' });
    // 1 current + 3 look-ahead (capped at LOOKAHEAD_CANDIDATES) = 4 entries.
    // Our fixture's starting FEN has 4 moves but only top-3 are
    // prefetched as children.
    expect(LOOKAHEAD_CANDIDATES).toBe(3);
    expect(masterPlayCache.size()).toBeLessThanOrEqual(LOOKAHEAD_CANDIDATES + 1);
  });

  it('skipLookahead=true does not fire child prefetches', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchMasterPlay(STARTING_FEN, {
      surface: '/coach/chat',
      skipLookahead: true,
    });
    expect(masterPlayCache.size()).toBe(1);
    expect(masterPlayCache.has(AFTER_E4_FEN_4)).toBe(false);
  });

  it('dedupes — second prefetch for the same FEN reuses the cache', async () => {
    const fetchSpy = stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat', skipLookahead: true });
    const firstCalls = fetchSpy.mock.calls.length;
    await prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat', skipLookahead: true });
    // Cache hit — fetch should not have been called again.
    expect(fetchSpy.mock.calls.length).toBe(firstCalls);
  });

  it('returns without throwing when the position has no master data (source:none)', async () => {
    stubFetch({ white: 0, draws: 0, black: 0, moves: [], topGames: [], opening: null });
    await expect(
      prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat' }),
    ).resolves.toBeUndefined();
    expect(masterPlayCache.get(STARTING_FEN)?.source).toBe('none');
  });

  it('handles a malformed SAN in master data without crashing look-ahead', async () => {
    // chess.js.move() will return null for an illegal SAN, which we
    // skip. Verify the watcher doesn't blow up on it.
    stubFetch({
      white: 100,
      draws: 100,
      black: 100,
      moves: [
        { uci: 'X1X2', san: 'Zzz9', averageRating: 2500, white: 100, draws: 100, black: 100, game: null },
        { uci: 'e2e4', san: 'e4', averageRating: 2500, white: 100, draws: 100, black: 100, game: null },
      ],
      topGames: [],
      opening: null,
    });
    await expect(
      prefetchMasterPlay(STARTING_FEN, { surface: '/coach/chat' }),
    ).resolves.toBeUndefined();
    // Real e4 child position should still be cached even though Zzz9 was invalid.
    expect(masterPlayCache.has(AFTER_E4_FEN_4)).toBe(true);
  });
});

describe('prefetchWalkthroughSequence', () => {
  it('prefetches every FEN in the sequence', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchWalkthroughSequence([STARTING_FEN], {
      surface: '/openings/italian-game',
    });
    expect(masterPlayCache.has(STARTING_FEN)).toBe(true);
  });

  it('uses the walkthrough-preload trigger label (does not fan out to look-ahead)', async () => {
    stubFetch(STARTING_FEN_EXPLORER_PAYLOAD);
    await prefetchWalkthroughSequence([STARTING_FEN], {
      surface: '/openings/italian-game',
    });
    // Walkthrough preload sets skipLookahead, so only the spine entry caches.
    expect(masterPlayCache.size()).toBe(1);
  });
});
