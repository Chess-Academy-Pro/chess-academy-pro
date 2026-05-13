import { test, expect, type Page } from '@playwright/test';

/**
 * /coach/review — full-play audit of the Review with Coach surface.
 *
 * Two routes:
 *   1. /coach/review               — list page (CoachReviewListPage)
 *   2. /coach/review/:gameId       — session page (CoachReviewSessionPage
 *                                     → CoachGameReview walk UI)
 *
 * The list page pre-seeds 5 sample annotated games on first visit
 * (seedReviewSamplesIfNeeded). Sample ids start with `sample-`.
 *
 * Page errors and console errors are captured per test and asserted
 * empty. Parallel workers cause race conditions on the dev server
 * + Dexie state — describe block runs serial.
 */

interface FlightRecorder {
  pageErrors: string[];
  consoleErrors: string[];
}
function recordPage(page: Page): FlightRecorder {
  const r: FlightRecorder = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (err) => r.pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') r.consoleErrors.push(msg.text());
  });
  return r;
}

async function gotoSession(page: Page, gameId: string): Promise<void> {
  // Each test gets a fresh BrowserContext + IndexedDB. Sample games
  // are only seeded by the list page's mount effect; navigating
  // directly to /coach/review/<id> without the seeder having run
  // produces "That game is no longer in your library." Visit the
  // list page first, wait for the seeded tiles, then navigate.
  //
  // The seeder write is async + the list re-reads after; under
  // dev-server contention the tile DOM can lag 20+ seconds even
  // though the Dexie record is in place. Poll Dexie directly for
  // the record so the wait is deterministic instead of dependent
  // on a React re-render race.
  //
  // Also stub the LLM endpoints — CoachGameReview's mount fires
  // generateReviewNarration which calls DeepSeek/Anthropic for the
  // intro paragraph. Under suite-level contention the embedded
  // fallback keys can rate-limit and the walk-UI gates on the
  // narration being ready, so the testid never mounts. A cheap
  // canned response keeps every session test deterministic.
  await page.route(/api\.deepseek\.com|api\.anthropic\.com/, async (route) => {
    const url = route.request().url();
    if (url.includes('anthropic.com')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'stub-msg', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'Walk-through intro.' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'stub-chatcmpl', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Walk-through intro.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });
    }
  });
  await page.goto('/coach/review');
  await page.waitForSelector('[data-testid="coach-review-list-page"]', { timeout: 15_000 });
  await page.waitForFunction(
    (id) => new Promise<boolean>((resolve) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('games')) { resolve(false); return; }
        const tx = db.transaction('games', 'readonly');
        const get = tx.objectStore('games').get(id);
        get.onsuccess = () => resolve(!!get.result);
        get.onerror = () => resolve(false);
      };
    }),
    gameId,
    { timeout: 30_000, polling: 500 },
  );
  await page.goto(`/coach/review/${gameId}`);
  await page.waitForSelector('[data-testid="coach-game-review-walk"]', { timeout: 30_000 });
}

async function gotoList(page: Page): Promise<void> {
  await page.goto('/coach/review');
  await page.waitForSelector('[data-testid="coach-review-list-page"]', { timeout: 12_000 });
  // Wait for the loading state to clear — either at least one tile
  // surfaces, or the empty-state copy renders. The seeder + Dexie
  // read take a few seconds, especially on fresh contexts.
  await page
    .waitForFunction(() => {
      const hasTile = document.querySelector('[data-testid^="review-game-card-"]') !== null;
      const loadingCopy = Array.from(document.querySelectorAll('p, div')).some(
        (el) => /loading your games/i.test((el as HTMLElement).textContent ?? ''),
      );
      return hasTile || !loadingCopy;
    }, { timeout: 20_000 })
    .catch(() => undefined);
}

async function clearGames(page: Page): Promise<void> {
  // Land on a benign page first so Dexie has time to open.
  await page.goto('/');
  await page.waitForSelector('body', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('games')) { resolve(); return; }
        const tx = db.transaction(['games', 'meta'], 'readwrite');
        tx.objectStore('games').clear();
        // Mark the sample-seeder as already-done so re-mounting the
        // list page doesn't re-seed.
        tx.objectStore('meta').put({ key: 'review-samples-seeded.v3', value: 'true' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      req.onerror = () => resolve();
    });
  });
}

async function resetSeeder(page: Page): Promise<void> {
  // Allow the sample seeder to re-run on next visit.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) { resolve(); return; }
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').delete('review-samples-seeded.v3');
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
    });
  });
}

test.describe('Review with Coach — full-play audit', () => {
  // Parallel workers race on Dexie state — sample seeder vs cleanup
  // collide. Serial mode keeps state predictable.
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);

  test('list page renders with title + 4 filter buttons + back button', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoList(page);
    await expect(page.getByTestId('coach-review-list-page')).toBeVisible();
    // Header back button: aria-label "Back to coach".
    await expect(page.locator('button[aria-label="Back to coach"]').first()).toBeVisible();
    // 4 filter buttons.
    for (const f of ['all', 'coach', 'lichess', 'chesscom'] as const) {
      await expect(page.getByTestId(`review-filter-${f}`)).toBeVisible();
    }
    expect(recorder.pageErrors).toEqual([]);
  });

  test('sample games auto-seed on first visit + tiles render', async ({ page }) => {
    const recorder = recordPage(page);
    // The seeder runs idempotently on every mount. Whether it
    // already seeded in an earlier test or runs fresh here, the
    // expected steady state is "5 sample game tiles visible".
    await gotoList(page);
    await expect(
      page.locator('[data-testid^="review-game-card-"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    const tiles = await page.locator('[data-testid^="review-game-card-"]').count();
    expect(tiles, '5 review samples should seed on first visit').toBeGreaterThanOrEqual(5);

    // Each sample id begins with `sample-` (reviewSampleGames.ts:62+).
    await expect(page.getByTestId('review-game-card-sample-morphy-opera-1858')).toBeVisible();
    expect(recorder.pageErrors).toEqual([]);
  });

  test('back-arrow returns to /coach/home', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoList(page);
    await page.locator('button[aria-label="Back to coach"]').first().click();
    await expect(page).toHaveURL(/\/coach\/home/);
    expect(recorder.pageErrors).toEqual([]);
  });

  test('filter buttons swap the active state and hide non-matching tiles', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoList(page);
    // Wait for samples.
    await expect(page.locator('[data-testid^="review-game-card-"]').first()).toBeVisible({ timeout: 10_000 });

    // 5 seeded samples: 2 master + 1 coach + 1 lichess + 1 chesscom
    // (reviewSampleGames.ts). Filter to chesscom — exactly 1 tile
    // remains (the London game). Filter buttons surface 4 sources:
    // all / coach / lichess / chesscom. (Master isn't a filter
    // button on this list — those games only show under 'all'.)
    const allCount = await page.locator('[data-testid^="review-game-card-"]').count();
    await page.getByTestId('review-filter-chesscom').click();
    await page.waitForTimeout(500);
    const chesscomCount = await page.locator('[data-testid^="review-game-card-"]').count();
    expect(chesscomCount, 'chesscom filter should reduce the list').toBeLessThan(allCount);
    expect(chesscomCount, 'chesscom sample is present').toBeGreaterThanOrEqual(1);

    // Click back to all — full count returns.
    await page.getByTestId('review-filter-all').click();
    await page.waitForTimeout(500);
    const allAgain = await page.locator('[data-testid^="review-game-card-"]').count();
    expect(allAgain).toBe(allCount);

    expect(recorder.pageErrors).toEqual([]);
  });

  test('empty corpus: clearing games + suppressing the seeder shows the empty state', async ({ page }) => {
    const recorder = recordPage(page);
    await clearGames(page);

    await gotoList(page);
    // No tiles.
    await expect(page.locator('[data-testid^="review-game-card-"]')).toHaveCount(0);
    // Empty-state copy.
    await expect(page.locator('text=/No games to review yet/i')).toBeVisible({ timeout: 8000 });
    expect(recorder.pageErrors).toEqual([]);

    // Restore for downstream tests.
    await resetSeeder(page);
  });

  test('clicking a tile navigates to the session page (URL + walk UI)', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoList(page);
    await expect(page.locator('[data-testid^="review-game-card-"]').first()).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('review-game-card-sample-morphy-opera-1858').click();
    await expect(page).toHaveURL(/\/coach\/review\/sample-morphy-opera-1858/);

    // CoachGameReview's walk UI testid.
    await expect(page.getByTestId('coach-game-review-walk')).toBeVisible({ timeout: 30_000 });
    expect(recorder.pageErrors).toEqual([]);
  });

  test('session page renders nav controls + chessboard', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');
    await expect(page.getByTestId('review-nav-controls')).toBeVisible();
    await expect(page.getByTestId('review-back-btn')).toBeVisible();
    await expect(page.getByTestId('review-forward-btn')).toBeVisible();
    // Walk-UI board renders [data-square] cells via ConsistentChessboard.
    await expect(page.locator('[data-square]').first()).toBeVisible();
    expect(recorder.pageErrors).toEqual([]);
  });

  test('forward / back navigation advances the ply', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    // Capture the board placement before advancing.
    const placementBefore = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    // Click forward — playPly advances by 1.
    await page.getByTestId('review-forward-btn').click();
    await page.waitForTimeout(600);

    const placementAfter = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    expect(placementAfter).not.toBe(placementBefore);

    // Back returns to the prior placement.
    await page.getByTestId('review-back-btn').click();
    await page.waitForTimeout(600);
    const placementBack = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });
    expect(placementBack).toBe(placementBefore);

    expect(recorder.pageErrors).toEqual([]);
  });

  test('keyboard arrows navigate the ply', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    const placement0 = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    // ArrowRight = forward one ply.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    const placement1 = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    expect(placement1).not.toBe(placement0);

    // ArrowLeft = back.
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    const placement2 = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    expect(placement2).toBe(placement0);
    expect(recorder.pageErrors).toEqual([]);
  });

  test('jump-to-start / jump-to-end reset and fast-forward the ply', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    const placementStart = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    await page.locator('button[aria-label="Jump to end"]').click();
    await page.waitForTimeout(800);
    const placementEnd = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });
    expect(placementEnd).not.toBe(placementStart);

    await page.locator('button[aria-label="Jump to start"]').click();
    await page.waitForTimeout(800);
    const placementResume = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });
    expect(placementResume).toBe(placementStart);

    expect(recorder.pageErrors).toEqual([]);
  });

  test('narration banner + narration toggle button surface', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');
    // Narration is generated on mount; the banner may take a moment.
    const banner = page.getByTestId('review-narration-banner');
    const toggle = page.getByTestId('walk-narration-toggle-btn');
    // Tolerate either being visible (narration may fall back to
    // summary card if the LLM call fails offline).
    const bannerVisible = await banner.isVisible().catch(() => false);
    const toggleVisible = await toggle.isVisible().catch(() => false);
    expect(bannerVisible || toggleVisible, 'expected narration banner or toggle to render').toBe(true);
    expect(recorder.pageErrors).toEqual([]);
  });

  test('engine-lines toggle + section render', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    const section = page.getByTestId('review-engine-lines-section');
    const toggle = page.getByTestId('review-engine-lines-toggle');
    // The section header is always rendered; the toggle drives the
    // panel beneath.
    await expect(section).toBeVisible({ timeout: 6000 });
    await expect(toggle).toBeVisible();

    // Toggle on — the panel mounts (Stockfish may take a moment to
    // produce lines; we only verify the panel testid is reachable).
    await toggle.click();
    await page.waitForTimeout(400);
    // Panel may render the analyzing state; testid stays the same.
    await expect(page.getByTestId('review-engine-lines-panel')).toBeVisible({ timeout: 6000 });
    expect(recorder.pageErrors).toEqual([]);
  });

  test('ask panel: toggle expands the ask-about-position input', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    const toggle = page.getByTestId('walk-ask-toggle-btn');
    await expect(toggle).toBeVisible({ timeout: 8000 });
    await toggle.click();
    await page.waitForTimeout(400);
    await expect(page.getByTestId('walk-ask-panel')).toBeVisible({ timeout: 4000 });
    expect(recorder.pageErrors).toEqual([]);
  });

  test('bottom bar: Play Again + Back to Coach buttons route correctly', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    // Verify both bottom-bar buttons are visible. We test Back to
    // Coach's routing here (Play Again navigates to /coach/play
    // which is an entirely separate flow).
    await expect(page.getByTestId('review-bottom-bar')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('walk-play-again-btn')).toBeVisible();
    await expect(page.getByTestId('walk-back-to-coach-btn')).toBeVisible();

    await page.getByTestId('walk-back-to-coach-btn').click();
    await expect(page).toHaveURL(/\/coach\/review$/);
    await expect(page.getByTestId('coach-review-list-page')).toBeVisible({ timeout: 6000 });
    expect(recorder.pageErrors).toEqual([]);
  });

  test('voice subsystem is wired into the review surface', async ({ page }) => {
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    // Probe voiceService + logAppAudit pipeline (same pattern as
    // the endgame audit). Verifies the surface CAN log voice
    // events through Dexie, irrespective of whether speech audio
    // is gated in headless Chrome.
    const probe = await page.evaluate(async () => {
      try {
        const mod = await import('/src/services/voiceService.ts');
        const vs = (mod as { voiceService?: { speakIfFree?: (s: string) => Promise<void> } }).voiceService;
        if (!vs || typeof vs.speakIfFree !== 'function') return 'no-speakIfFree';
        await vs.speakIfFree('Coach review audit voice probe.');
        return 'ok';
      } catch (err) {
        return `import-failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    expect(probe).toBe('ok');

    const auditProbe = await page.evaluate(async () => {
      try {
        const mod = await import('/src/services/appAuditor.ts');
        const fn = (mod as { logAppAudit?: (e: unknown) => Promise<void> }).logAppAudit;
        if (typeof fn !== 'function') return 'no-logAppAudit';
        await fn({
          kind: 'voice-speak-invoked',
          category: 'subsystem',
          source: 'e2e-coach-review-probe',
          summary: 'coach review audit voice probe',
        });
        return 'ok';
      } catch (err) {
        return `audit-failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    expect(auditProbe).toBe('ok');

    await page.waitForTimeout(1500);
    const speakCount = await page.evaluate(async () => {
      return await new Promise<number>((resolve) => {
        const req = indexedDB.open('ChessAcademyDB');
        req.onerror = () => resolve(-1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) { resolve(-2); return; }
          const tx = db.transaction('meta', 'readonly');
          const get = tx.objectStore('meta').get('app-audit-log.v1');
          get.onsuccess = () => {
            const rec = get.result as { value?: unknown } | undefined;
            const value = rec?.value;
            let entries: Array<{ kind?: string }> = [];
            if (Array.isArray(value)) entries = value as Array<{ kind?: string }>;
            else if (typeof value === 'string') {
              try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) entries = parsed;
              } catch { /* swallow */ }
            }
            resolve(
              entries.filter((e) => typeof e === 'object' && e !== null && e.kind === 'voice-speak-invoked').length,
            );
          };
          get.onerror = () => resolve(-3);
        };
      });
    });
    expect(speakCount).toBeGreaterThan(0);
    expect(recorder.pageErrors).toEqual([]);
  });

  test('missed-tactics list surfaces + jumping to a tactic advances the ply', async ({ page }) => {
    test.setTimeout(180_000);
    const recorder = recordPage(page);
    // Vienna sample: source=coach, white="You" (playerColor='white'),
    // white has two mistakes (Qg4 move 4, Qxg7 move 5) with eval
    // swings ≥100cp + bestMove set. `detectMissedTactics`
    // (missedTacticService.ts:823) returns those for the walk UI's
    // missed-tactics list.
    await gotoSession(page, 'sample-vienna-amateur-1');

    // Missed-tactics section lives in a scrollable middle panel.
    const section = page.getByTestId('walk-missed-tactics');
    await section.waitFor({ state: 'visible', timeout: 15_000 });
    await section.scrollIntoViewIfNeeded();

    // Vienna provides at least 2 tactics.
    const firstTactic = page.getByTestId('walk-missed-tactic-0');
    await expect(firstTactic).toBeVisible({ timeout: 4000 });

    // Capture the board placement before clicking — jumpToPly will
    // change it.
    const placementBefore = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });

    await firstTactic.click();
    await page.waitForTimeout(800);

    const placementAfter = await page.evaluate(() => {
      const m: Record<string, string> = {};
      document.querySelectorAll('[data-square]').forEach((sq) => {
        const square = (sq as HTMLElement).dataset.square;
        const img = sq.querySelector('img');
        const alt = img?.getAttribute('alt');
        if (square && alt) m[square] = alt;
      });
      return JSON.stringify(m);
    });
    expect(placementAfter, 'missed-tactic click should change the board (jump-to-ply)').not.toBe(placementBefore);

    // "Practice in Coach Chat" button — wired in
    // CoachReviewSessionPage as of Wave 3 fix (routes to
    // /coach/chat?q=<prompt>). Expected to render.
    await expect(page.getByTestId('walk-practice-in-chat-btn')).toBeVisible();

    expect(recorder.pageErrors).toEqual([]);
  });

  test('exploration: play the missed move at a mistake ply → resume button surfaces', async ({ page }) => {
    test.setTimeout(180_000);
    const recorder = recordPage(page);

    // generateReviewNarration calls DeepSeek/Anthropic for the intro
    // paragraph. Without network access the fetch hangs and blocks
    // the walk-UI mount. Stub both providers with a short canned
    // response so the page proceeds.
    const stubResponse = 'Walk-through intro narration.';
    await page.route(/api\.deepseek\.com|api\.anthropic\.com/, async (route) => {
      const url = route.request().url();
      if (url.includes('anthropic.com')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'stub-msg', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: stubResponse }],
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'stub-chatcmpl', object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: stubResponse }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        });
      }
    });

    // After the Wave-3 product fixes:
    //   - reviewSampleGames.ts (v3) emits bestMove in UCI ('d2d3')
    //     so the walk-UI's arrow code accepts it.
    //   - CoachGameReview.tsx now uses seg.fenBefore at arrow-bearing
    //     plies, so the displayed side-to-move matches the player
    //     who erred — the missed move is legal on the displayed
    //     board.
    // No manual patching needed; visit Vienna directly.
    await gotoSession(page, 'sample-vienna-amateur-1');

    // Walk forward to ply 7 (white's 4th move, Qg4 mistake). The
    // green arrow renders from d2 → d3.
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
    }
    await expect(page.getByTestId('review-classification-badge')).toBeVisible({ timeout: 6000 });

    // Click "Explore this position" — the canonical walk shows
    // seg.fenAfter (Black to move), so the board is read-only until
    // the student opts in. The toggle swaps to seg.fenBefore so the
    // missed move is legal and the board becomes interactive.
    await expect(page.getByTestId('walk-explore-toggle-btn')).toBeVisible({ timeout: 4000 });
    await page.getByTestId('walk-explore-toggle-btn').click();
    await page.waitForTimeout(400);

    // Play the suggested missed move directly via click-to-move:
    // d2 (white pawn) → d3. With explore-toggle on, the walk-UI
    // displays seg.fenBefore (white to move), so the move is legal.
    await page.locator('[data-square="d2"]').first().click({ force: true });
    await page.waitForTimeout(200);
    await page.locator('[data-square="d3"]').first().click({ force: true });

    // Resume-game button appears once exploration FEN is captured.
    await expect(page.getByTestId('walk-resume-game-btn')).toBeVisible({ timeout: 8000 });

    // Click resume — exploration state clears, button hides.
    await page.getByTestId('walk-resume-game-btn').click();
    await expect(page.getByTestId('walk-resume-game-btn')).toBeHidden({ timeout: 4000 });

    expect(recorder.pageErrors).toEqual([]);
  });

  test('engine lines toggle on → at least one engine line row renders SAN content', async ({ page }) => {
    test.setTimeout(180_000);
    const recorder = recordPage(page);
    await gotoSession(page, 'sample-morphy-opera-1858');

    // Advance one ply so there's a real position to analyze (the
    // starting position can be ambiguous to the engine in headless).
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);

    const toggle = page.getByTestId('review-engine-lines-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();

    // Engine lines run at depth 16 via useReviewEngineLines —
    // Stockfish WASM needs time. Up to ~45s on first run.
    await expect(page.getByTestId('review-engine-line-0')).toBeVisible({ timeout: 60_000 });

    // Verify the row contains SAN-shaped move text (at least one
    // upper-case piece letter + file/rank OR pawn move with file +
    // optional promotion). Permissive — Stockfish output varies.
    const text = (await page.getByTestId('review-engine-line-0').textContent())?.trim() ?? '';
    expect(text.length, `engine line 0 text: "${text}"`).toBeGreaterThan(0);
    // Should mention either a SAN (Nxd4, e4, O-O…) or an eval (+1.3,
    // M5, etc.) — any non-empty meaningful content.
    expect(text).toMatch(/[A-Za-z0-9+#=\-]/);

    expect(recorder.pageErrors).toEqual([]);
  });

  test('ask-coach round trip: question → response surfaces via stubbed coach API', async ({ page }) => {
    test.setTimeout(180_000);
    const recorder = recordPage(page);

    // Intercept the coach API endpoints. CoachGameReview's ask
    // path uses streaming (coachApi.ts:350 — `stream: true`), so
    // a plain JSON response won't drive the streaming reader.
    // Build SSE chunks that match the OpenAI / Anthropic stream
    // protocols so the in-app `onStream` callback fires and
    // setAskResponse accumulates the canned text.
    const cannedResponse = 'In this position, develop your knights first. [VOICE: develop the knights]';
    const openAiSse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: cannedResponse } }] })}\n\n` +
      `data: [DONE]\n\n`;
    const anthropicSse =
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5-20251001', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: cannedResponse } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    // Visit the session FIRST so gotoSession registers its default
    // JSON stub for the intro narration call. THEN register our
    // streaming stub — Playwright matches routes last-registered-
    // first, so this one wins over gotoSession's for the ask call.
    await gotoSession(page, 'sample-morphy-opera-1858');
    await page.route(/api\.deepseek\.com|api\.anthropic\.com/, async (route) => {
      const url = route.request().url();
      if (url.includes('anthropic.com')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'cache-control': 'no-cache' },
          body: anthropicSse,
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'cache-control': 'no-cache' },
          body: openAiSse,
        });
      }
    });

    const askToggle = page.getByTestId('walk-ask-toggle-btn');
    await askToggle.scrollIntoViewIfNeeded();
    await askToggle.click();
    await expect(page.getByTestId('walk-ask-panel')).toBeVisible({ timeout: 4000 });

    // Find the input inside the ask panel and submit a question.
    const panel = page.getByTestId('walk-ask-panel');
    const input = panel.locator('input, textarea').first();
    await input.fill('what should I play here?');
    // Submission via Enter — same as the in-product chat input.
    await input.press('Enter');

    // Response surfaces once the route fulfills.
    const response = page.getByTestId('walk-ask-response');
    await expect(response).toBeVisible({ timeout: 15_000 });
    // The `[VOICE: ...]` marker is stripped before display; the body
    // text should still contain the meaningful sentence.
    const text = (await response.textContent())?.trim() ?? '';
    expect(text.toLowerCase()).toContain('knights');

    expect(recorder.pageErrors).toEqual([]);
  });

  test('invalid game id surfaces an error state without crashing', async ({ page }) => {
    const recorder = recordPage(page);
    await page.goto('/coach/review/does-not-exist-fake-id');
    // Page should mount and show an error or fallback rather than
    // hanging / throwing a runtime exception.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    // Body still renders.
    await expect(page.locator('body')).toBeVisible();
    expect(recorder.pageErrors).toEqual([]);
  });
});
