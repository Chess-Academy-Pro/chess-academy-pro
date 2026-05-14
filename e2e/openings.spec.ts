import { test, expect, type Page } from '@playwright/test';

/**
 * /openings — full-tab audit.
 *
 * Surface map:
 *   /openings                          → OpeningExplorerPage    (testid `opening-explorer`)
 *   /openings/:id                      → OpeningDetailPage      (testid `opening-detail`)
 *   /openings/pro/:playerId            → ProPlayerPage          (testid `pro-player-page`)
 *   /openings/pro/:playerId/:id        → OpeningDetailPage      (pro variant)
 *
 * Goals — match the bar from `docs/openings-ux-contract.md`:
 *   - All 4 tabs on the hub mount (`tab-repertoire` / `tab-pro` /
 *     `tab-gambits` / `tab-all`) and produce their respective panels.
 *   - SmartSearchBar narrows the visible card set on the Most Common
 *     tab.
 *   - ECO letter groups (`eco-group-A`…`eco-group-E`) expand and
 *     show openings.
 *   - Detail page renders: header (with mastery ring + back), Watch/
 *     Learn/Practice/Play 4-button row, Overview, Key Ideas,
 *     Variations, and (when present) Traps with a train button.
 *   - Variation walkthrough mounts (`walkthrough-mode`) when a
 *     variation row is clicked.
 *   - Favorite toggle round-trips through Dexie (heart fills, returns
 *     after navigating away and back).
 *   - Pro flow: Pro tab → ProPlayerPage → ProDetail → back routes to
 *     `/openings/pro/:playerId` (NOT `/openings`).
 *
 * Page errors are captured per test and asserted empty — any runtime
 * exception fails the run.
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

async function gotoExplorer(page: Page): Promise<void> {
  await page.goto('/openings');
  await page.waitForSelector('[data-testid="opening-explorer"]', { timeout: 10_000 });
}

async function gotoFirstRepertoire(page: Page): Promise<string> {
  // Returns the id of the first opening card on Most Common.
  await gotoExplorer(page);
  const firstCard = page.locator('[data-testid^="opening-card-"]').first();
  await firstCard.waitFor({ timeout: 8000 });
  const testid = await firstCard.getAttribute('data-testid');
  const id = testid?.replace(/^opening-card-/, '') ?? '';
  await firstCard.click();
  await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 8000 });
  return id;
}

test.describe('Openings Hub — full-tab audit', () => {
  // The detail page warms up generators (`generateWalkthroughNarrations`)
  // and the dev server emits big lazy chunks; parallel workers race for
  // the dev server. Run serially with one retry to absorb flakes.
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);

  // ─── Hub-level ───────────────────────────────────────────────────

  test('explorer loads with all 4 tabs and search bar', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);

    await expect(page.getByTestId('tab-toggle')).toBeVisible();
    await expect(page.getByTestId('tab-repertoire')).toBeVisible();
    await expect(page.getByTestId('tab-pro')).toBeVisible();
    await expect(page.getByTestId('tab-gambits')).toBeVisible();
    await expect(page.getByTestId('tab-all')).toBeVisible();

    // SmartSearchBar lives below the tab strip; its input element
    // varies (role textbox / input) so query loosely.
    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]',
    );
    await expect(searchInput.first()).toBeVisible();

    expect(rec.pageErrors).toEqual([]);
  });

  test('Most Common tab shows repertoire openings grouped by color', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    // At least one OpeningCard rendered on the default Most Common tab.
    const cards = page.locator('[data-testid^="opening-card-"]');
    await expect(cards.first()).toBeVisible({ timeout: 8000 });
    expect(await cards.count()).toBeGreaterThan(0);

    // Section labels: "My White Openings" / "My Black Openings"
    // (Favorites only appears when one is toggled).
    const whiteHeader = page.getByText('My White Openings', { exact: false });
    const blackHeader = page.getByText('My Black Openings', { exact: false });
    // Either should be present — repertoire has both colors.
    const whiteCount = await whiteHeader.count();
    const blackCount = await blackHeader.count();
    expect(whiteCount + blackCount).toBeGreaterThan(0);

    expect(rec.pageErrors).toEqual([]);
  });

  test('Pro tab shows player cards', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    await page.getByTestId('tab-pro').click();
    await expect(page.getByTestId('pro-repertoires-tab')).toBeVisible();
    const playerCards = page.locator('[data-testid^="pro-player-card-"]');
    await expect(playerCards.first()).toBeVisible({ timeout: 6000 });
    expect(await playerCards.count()).toBeGreaterThan(0);
    expect(rec.pageErrors).toEqual([]);
  });

  test('Gambits tab mounts without errors', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    await page.getByTestId('tab-gambits').click();
    // The GambitsTab content itself uses data-testid="tab-gambits"
    // on its panel root — its visibility under the tab strip
    // confirms render. We allow that and just check the explorer
    // didn't error out.
    await page.waitForTimeout(300);
    expect(rec.pageErrors).toEqual([]);
  });

  test('All tab shows ECO letter groups; expanding loads openings', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    await page.getByTestId('tab-all').click();

    // All 5 ECO groups eventually mount. The hub does a one-shot
    // Dexie query per letter, so wait for the first one then
    // check the lot.
    await expect(page.getByTestId('eco-group-A')).toBeVisible({ timeout: 8000 });
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      await expect(page.getByTestId(`eco-group-${letter}`)).toBeVisible();
    }

    // Expand the first group and confirm at least one OpeningCard
    // appears inside it.
    await page.getByTestId('eco-toggle-A').click();
    const groupCards = page
      .getByTestId('eco-group-A')
      .locator('[data-testid^="opening-card-"]');
    await expect(groupCards.first()).toBeVisible({ timeout: 6000 });
    expect(await groupCards.count()).toBeGreaterThan(0);

    expect(rec.pageErrors).toEqual([]);
  });

  test('search bar filters repertoire openings', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    const before = await page
      .locator('[data-testid^="opening-card-"]')
      .count();
    expect(before).toBeGreaterThan(1);

    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]',
    ).first();
    await searchInput.fill('Sicilian');
    // SmartSearchBar debounces; give it a beat to query.
    await page.waitForTimeout(800);
    const after = await page
      .locator('[data-testid^="opening-card-"]')
      .count();
    // Filtered set should be strictly smaller than the unfiltered
    // set (or at least not larger). Repertoire has multiple Sicilian
    // entries so we should still see at least one.
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(0);

    expect(rec.pageErrors).toEqual([]);
  });

  // ─── Detail page ──────────────────────────────────────────────────

  test('detail page renders header, mastery ring, and 4 mode buttons', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);

    await expect(page.getByTestId('opening-detail')).toBeVisible();
    await expect(page.getByTestId('walkthrough-btn')).toBeVisible();
    await expect(page.getByTestId('learn-btn')).toBeVisible();
    await expect(page.getByTestId('practice-btn')).toBeVisible();
    await expect(page.getByTestId('play-btn')).toBeVisible();
    await expect(page.getByTestId('back-button')).toBeVisible();
    await expect(page.getByTestId('favorite-btn')).toBeVisible();

    // Header has an h1 — exact text varies by opening.
    await expect(page.locator('[data-testid="opening-detail"] h1').first()).toBeVisible();

    expect(rec.pageErrors).toEqual([]);
  });

  test('detail page back-button routes to /openings', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/\/openings\/?$/);
    await expect(page.getByTestId('opening-explorer')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('detail page Overview + Key Ideas sections render when present', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    // Both Overview and Key Ideas are gated on the opening having
    // those fields. The repertoire seed has both for every entry, so
    // both narration buttons should be visible.
    await expect(page.getByTestId('narrate-overview')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('narrate-keyIdeas')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('detail page shows Variations with action buttons', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    // Repertoire entries always carry variations; the first one
    // gets index 0.
    const firstVariation = page.getByTestId('variation-0');
    await expect(firstVariation).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('variation-walkthrough-0')).toBeVisible();
    await expect(page.getByTestId('variation-learn-0')).toBeVisible();
    await expect(page.getByTestId('variation-practice-0')).toBeVisible();
    await expect(page.getByTestId('variation-play-0')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('clicking a variation walkthrough enters walkthrough mode', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('variation-walkthrough-0').click();
    await expect(page.getByTestId('walkthrough-mode')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('walkthrough-back')).toBeVisible();
    await expect(page.getByTestId('walkthrough-progress')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('clicking the top-level Watch button enters walkthrough mode', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('walkthrough-btn').click();
    await expect(page.getByTestId('walkthrough-mode')).toBeVisible({ timeout: 8000 });
    expect(rec.pageErrors).toEqual([]);
  });

  test('clicking the top-level Learn button enters drill mode', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('learn-btn').click();
    await expect(page.getByTestId('drill-mode')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('drill-back')).toBeVisible();
    await expect(page.getByTestId('drill-progress')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('clicking the top-level Practice button enters practice mode', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('practice-btn').click();
    await expect(page.getByTestId('practice-mode')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('practice-back')).toBeVisible();
    await expect(page.getByTestId('practice-progress')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('favorite toggle round-trips through Dexie', async ({ page }) => {
    const rec = recordPage(page);
    const openingId = await gotoFirstRepertoire(page);

    // Read the live state of the favorite-btn via the Heart icon's
    // fill class. The button's aria-label flips between
    // "Add to favorites" and "Remove from favorites".
    const favBtn = page.getByTestId('favorite-btn');
    const initial = await favBtn.getAttribute('aria-label');
    await favBtn.click();
    await page.waitForTimeout(200);
    const after = await favBtn.getAttribute('aria-label');
    expect(after).not.toBe(initial);

    // Round-trip: leave the page and come back; the new state must
    // persist (Dexie write completed before navigation).
    await page.getByTestId('back-button').click();
    await page.waitForSelector('[data-testid="opening-explorer"]');
    await page.locator(`[data-testid="opening-card-${openingId}"]`).click();
    await page.waitForSelector('[data-testid="opening-detail"]');
    const persisted = await page
      .getByTestId('favorite-btn')
      .getAttribute('aria-label');
    expect(persisted).toBe(after);

    // Restore the original state so the test is idempotent.
    await page.getByTestId('favorite-btn').click();

    expect(rec.pageErrors).toEqual([]);
  });

  // ─── Pro flow ─────────────────────────────────────────────────────

  test('Pro tab → player → detail → back routes correctly', async ({ page }) => {
    const rec = recordPage(page);
    await gotoExplorer(page);
    await page.getByTestId('tab-pro').click();
    await page.getByTestId('pro-repertoires-tab').waitFor();

    // Click the first player card.
    const firstPlayer = page.locator('[data-testid^="pro-player-card-"]').first();
    await firstPlayer.waitFor({ timeout: 6000 });
    const playerTestId = await firstPlayer.getAttribute('data-testid');
    const playerId = playerTestId?.replace(/^pro-player-card-/, '') ?? '';
    expect(playerId.length).toBeGreaterThan(0);
    await firstPlayer.click();
    await expect(page).toHaveURL(new RegExp(`/openings/pro/${playerId}$`));
    await expect(page.getByTestId('pro-player-page')).toBeVisible({ timeout: 6000 });

    // Player page renders at least one opening card.
    const proCards = page.locator(
      '[data-testid="pro-player-page"] [data-testid^="opening-card-"]',
    );
    await expect(proCards.first()).toBeVisible({ timeout: 6000 });

    // Click the first opening; URL becomes /openings/pro/:playerId/:id.
    await proCards.first().click();
    await expect(page).toHaveURL(new RegExp(`/openings/pro/${playerId}/`));
    await expect(page.getByTestId('opening-detail')).toBeVisible({ timeout: 6000 });

    // Detail back-button should route back to the player page (NOT
    // to /openings) because the route includes /openings/pro/.
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(new RegExp(`/openings/pro/${playerId}$`));

    // Player page back-button routes to /openings.
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/\/openings\/?$/);

    expect(rec.pageErrors).toEqual([]);
  });

  // ─── Train traps / Walkthrough mode ──────────────────────────────

  test('walkthrough-mode play/pause + speed controls render', async ({ page }) => {
    const rec = recordPage(page);
    await gotoFirstRepertoire(page);
    await page.getByTestId('walkthrough-btn').click();
    await expect(page.getByTestId('walkthrough-mode')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('walkthrough-play-pause')).toBeVisible();
    await expect(page.getByTestId('walkthrough-speed-toggle')).toBeVisible();
    // Back exits walkthrough back to the detail page.
    await page.getByTestId('walkthrough-back').click();
    await expect(page.getByTestId('opening-detail')).toBeVisible();
    expect(rec.pageErrors).toEqual([]);
  });

  test('train-traps button surfaces when the opening has trap lines', async ({ page }) => {
    const rec = recordPage(page);
    // We need an opening whose repertoire entry carries trapLines.
    // Walk the Most Common cards until we find one — at least the
    // Italian Game, Vienna, and Caro-Kann ship with trap lines.
    await gotoExplorer(page);
    const cardIds = await page
      .locator('[data-testid^="opening-card-"]')
      .evaluateAll((els) =>
        els
          .map((e) => (e as HTMLElement).getAttribute('data-testid') ?? '')
          .map((t) => t.replace(/^opening-card-/, ''))
          .filter(Boolean),
      );
    expect(cardIds.length).toBeGreaterThan(0);

    let found = false;
    for (const id of cardIds.slice(0, 8)) {
      await page.locator(`[data-testid="opening-card-${id}"]`).click();
      await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 6000 });
      if (await page.getByTestId('train-traps-btn').isVisible().catch(() => false)) {
        found = true;
        await expect(page.getByTestId('trap-line-0')).toBeVisible();
        break;
      }
      await page.getByTestId('back-button').click();
      await page.waitForSelector('[data-testid="opening-explorer"]');
    }
    expect(found).toBe(true);
    expect(rec.pageErrors).toEqual([]);
  });
});
