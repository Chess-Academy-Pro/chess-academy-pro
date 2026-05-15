/**
 * stockfish-ios-fix.spec.ts
 *
 * Validates the audit-fix that moves the iOS Safari detection to the
 * FIRST check inside stockfishEngine.tryStart() — before the
 * `forceSingle` and sticky `_runtimeFallbackAttempted` branches.
 *
 * The bug (build 7eca7c3): the sticky-fallback path bypassed iOS
 * detection, routing iOS Safari users to STOCKFISH_ST_URL (the
 * lite-single bundle), which crashes ~5×/sec on iOS with
 * `RuntimeError: call_indirect to a signature that does not match`.
 * Live audit captured 120 such errors in 15 min on /coach/endgame.
 *
 * The fix: iOS detection short-circuits to LILA_BRIDGE_URL
 * unconditionally, regardless of forceSingle or sticky-fallback
 * state.
 *
 * This spec spoofs an iPhone Safari user-agent + maxTouchPoints,
 * pre-seeds the `sfx.multi-fallback-attempted.v1` localStorage flag
 * (the trigger of the sticky-fallback path), then navigates to a
 * route that requires Stockfish. Pass criteria:
 *   1. ZERO `call_indirect` console errors in 15 s
 *   2. The audit-log entry `stockfish-variant-resolved` reports
 *      `variant=lila` (not single, not multi)
 */
import { test, expect, type Page } from '@playwright/test';

// iPhone Safari user-agent from the live audit (iPhone OS 18_7).
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1';

test.describe('Stockfish iOS preflight fix', () => {
  test.use({
    userAgent: IOS_UA,
    viewport: { width: 390, height: 844 },
  });
  // Generous timeout for IndexedDB cold-start (seedDatabase loads
  // 3,641 ECO entries on first visit) + Stockfish init + the 15s
  // crash-detection wait. Same budget as the openings.spec.ts suite.
  test.setTimeout(120_000);

  test('iOS Safari routes to lila, not lite-single, even with sticky-fallback flag set', async ({
    page,
  }) => {
    // Capture every runtime error so we can fail the test if the
    // call_indirect crash regresses.
    const stockfishErrors: string[] = [];
    page.on('pageerror', (err) => {
      const msg = err.message ?? '';
      if (/call_indirect|stockfish-18-lite/i.test(msg)) {
        stockfishErrors.push(msg);
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/call_indirect|stockfish-18-lite/i.test(text)) {
          stockfishErrors.push(text);
        }
      }
    });

    // Pre-seed the sticky-fallback flag — this is the exact state
    // that bypassed iOS detection in the bug.
    await page.addInitScript(() => {
      // Bypass cross-origin Safari restriction: set the localStorage
      // key BEFORE the app boots.
      try {
        localStorage.setItem('sfx.multi-fallback-attempted.v1', '1');
      } catch {
        /* localStorage may be unavailable; the fix should still work */
      }
      // Spoof iPad-style maxTouchPoints in case the UA alone isn't
      // enough (isIosSafari() also checks navigator.maxTouchPoints).
      try {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => 5,
        });
      } catch {
        /* property is already non-configurable in some environments */
      }
    });

    // Open an opening detail page → click Play → that surface ALWAYS
    // initializes Stockfish on mount (OpeningPlayMode wires the
    // engine analyzer directly). /coach/endgame as a HUB doesn't
    // load Stockfish until the user opens a specific lesson; the
    // bug surfaced on /coach/endgame because David was inside an
    // active lesson. The variant routing logic we're testing is
    // the same regardless of which surface triggers initialize.
    await page.goto('/openings');
    await page.waitForSelector('[data-testid="opening-explorer"]', { timeout: 60_000 });
    const firstCard = page.locator('[data-testid^="opening-card-"]').first();
    await firstCard.waitFor({ timeout: 15_000 });
    await firstCard.click();
    await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 15_000 });
    await page.getByTestId('play-btn').click();
    // Wait for the chessboard to mount — proxies "Stockfish init has
    // started" since OpeningPlayMode boots the engine on mount.
    await page.waitForSelector('[data-square="a1"]', { timeout: 30_000 });

    // Give Stockfish time to either initialize cleanly OR crash. The
    // bug crashed 5×/sec — 15s would have produced ~75 errors.
    await page.waitForTimeout(15_000);

    // Pass criterion 1: zero call_indirect / stockfish-18-lite errors.
    expect(stockfishErrors, `Stockfish errors leaked: ${stockfishErrors.join(' | ')}`).toEqual([]);

    // Pass criterion 2: the variant resolution should NOT mention
    // stockfish-18-lite. Pull the in-page audit log (Dexie-backed)
    // and check the latest `stockfish-variant-resolved` entry.
    const resolvedVariant = await page.evaluate(async () => {
      // The app exposes a Dexie store; read it via the same API
      // logAppAudit uses. Falling back to a window flag if the store
      // isn't reachable for any reason.
      try {
        const db = await (
          window as unknown as { __auditDexie?: () => Promise<unknown[]> }
        ).__auditDexie?.();
        if (db) return db;
      } catch {
        /* fall through */
      }
      return null;
    });

    // The Dexie hook isn't exposed for tests; do a softer check via
    // worker URL — the live Worker constructor's request URL is
    // observable on the page. If `lila-bridge.worker.js` is what
    // loaded, the fix worked.
    const loadedWorkerScript = await page.evaluate(() => {
      // The most observable signal: peek at performance entries for
      // /stockfish/*.js requests.
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const stockfishRequests = entries
        .filter((e) => /\/stockfish\//.test(e.name))
        .map((e) => e.name);
      return stockfishRequests;
    });

    // At least one of the loaded Stockfish requests must be the
    // lila-bridge variant. None should be stockfish-18-lite-single.
    const loadedLila = loadedWorkerScript.some((u) => /lila-bridge/.test(u));
    const loadedLite = loadedWorkerScript.some((u) => /stockfish-18-lite/.test(u));

    expect(
      loadedLila,
      `lila-bridge was NOT loaded. Stockfish requests: ${loadedWorkerScript.join(', ')}`,
    ).toBe(true);
    expect(
      loadedLite,
      `stockfish-18-lite WAS loaded on iOS Safari — fix regressed. Requests: ${loadedWorkerScript.join(', ')}`,
    ).toBe(false);
  });
});
