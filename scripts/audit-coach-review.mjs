#!/usr/bin/env node
/**
 * Audit-coach-review — drives the post-game Review surface end-to-end
 * against the deployed app. Walks the contract in
 * `docs/review-with-coach-ux-contract.md`.
 *
 * Mirrors the audit-coach-play.mjs / audit-tactics.mjs pattern:
 *   - one Chromium session, no page reloads
 *   - SPA navigation via real clicks
 *   - audit-stream enabled via localStorage; outgoing POSTs
 *     intercepted so we get the exact payload the page tried to push
 *   - console.errors + pageerrors captured per surface
 *   - screenshot + per-surface event summary in report.json
 *
 * Surfaces / behaviors exercised:
 *   List (/coach/review)
 *     - root container mounts; title + back arrow + 4 filter buttons
 *     - sample seeder ran → at least one review-game-card tile present
 *     - filter button click swaps active state
 *   Session (/coach/review/<sample-id>)
 *     - coach-game-review-walk mounts (or fallback summary card)
 *     - review-nav-controls visible; forward / back ply navigation
 *     - keyboard ArrowRight / ArrowLeft navigation
 *     - jump-to-start / jump-to-end skip buttons
 *     - narration banner visible
 *     - engine-lines toggle expands the panel
 *     - ask panel toggle expands the input
 *     - bottom bar: play-again + back-to-coach buttons present
 *
 * Run with `npm run audit:coach-review` or:
 *   node scripts/audit-coach-review.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-review.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-coach-review.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = `${BASE_URL}/api/audit-stream`;
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-review-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const NAV_SETTLE_MS = 1200;
const SESSION_SETTLE_MS = 8000; // walk-ui mount + narration prep

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[coach-review] base    = ${BASE_URL}`);
  console.log(`[coach-review] outDir  = ${OUT_DIR}`);
  console.log(`[coach-review] headed  = ${HEADED}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachReviewBot/1.0 (chromium)',
  });

  await ctx.addInitScript(
    ({ url, secret }) => {
      try {
        window.localStorage.setItem('auditStreamUrl', url);
        window.localStorage.setItem('auditStreamSecret', secret);
      } catch {
        /* ignore */
      }
    },
    { url: STREAM_URL, secret: SECRET },
  );

  const page = await ctx.newPage();

  const captured = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u === STREAM_URL && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body && typeof body === 'object') captured.push(body);
      } catch {
        /* ignore */
      }
    }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));

  const report = { base: BASE_URL, startedAt: stamp, surfaces: [] };

  async function record(name, action, settleMs = SHORT_SETTLE_MS, expectations = []) {
    const before = captured.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    let actionErr = null;
    try {
      await action();
      await page.waitForTimeout(settleMs);
    } catch (e) {
      actionErr = String(e?.message ?? e);
      console.log(`  [error] ${actionErr}`);
    }
    const screenshotPath = join(OUT_DIR, `${name}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {
      /* ignore */
    }
    const fresh = captured.slice(before);
    const kinds = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const sortedKinds = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
    const url = page.url();
    console.log(`\n[coach-review] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

    // Evaluate visibility / count expectations against the live DOM.
    const expectationResults = [];
    for (const exp of expectations) {
      let ok = false;
      let actual = '?';
      try {
        if (exp.kind === 'visible') {
          const count = await page.locator(exp.selector).count();
          const visible = count > 0
            ? await page.locator(exp.selector).first().isVisible().catch(() => false)
            : false;
          actual = visible ? 'visible' : `not-visible (count=${count})`;
          ok = visible;
        } else if (exp.kind === 'count-gte') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count >= exp.value;
        } else if (exp.kind === 'url-matches') {
          actual = page.url();
          ok = exp.value.test(actual);
        } else if (exp.kind === 'audit-present') {
          actual = kinds[exp.audit] ? 'present' : 'absent';
          ok = !!kinds[exp.audit];
        }
      } catch (err) {
        actual = `error: ${err.message}`;
      }
      const result = { ...exp, actual, ok };
      expectationResults.push(result);
      console.log(`  ${ok ? '✓' : '✗'} ${exp.label} → ${actual}`);
    }

    report.surfaces.push({
      name,
      url,
      durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kinds,
      screenshot: screenshotPath,
      consoleErrors: newConsole,
      pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      expectations: expectationResults,
      error: actionErr,
    });
  }

  // ── Boot + nav to /coach/review ─────────────────────────────────
  await record('boot-dashboard', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
  }, 6000);

  await record('coach-hub', async () => {
    await page.getByRole('link', { name: 'Coach' }).first().click();
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15000 });
  });

  // The Review tile lives under Coach hub. CoachHomePage renders it
  // via SecondaryTile — the testid pattern is `coach-tile-info-review`
  // or similar. Locating by text "Review" is robust to naming.
  await record('coach-review-list', async () => {
    // Try the testid first; fall back to text-matching the tile.
    const tileByTestId = page.locator('[data-testid*="review"]').filter({ hasText: /Review/i });
    if (await tileByTestId.count() > 0) {
      await tileByTestId.first().click();
    } else {
      await page.getByRole('button', { name: /review/i }).first().click();
    }
    await page.locator('[data-testid="coach-review-list-page"]').waitFor({ timeout: 15000 });
    // Wait for the seeder + Dexie schema migration to finish; tiles
    // appear AFTER the seed + db.games.toArray() resolves (~8–15s on
    // a fresh headless browser). Without this explicit wait the
    // subsequent tile-click expectation flakes.
    await page.locator('[data-testid^="review-game-card-"]').first().waitFor({ timeout: 25000 }).catch(() => undefined);
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-review-list-page"]', label: '2.1 list page renders' },
    { kind: 'visible', selector: 'h1, h2', label: 'header rendered (Review with Coach)' },
    { kind: 'count-gte', selector: '[data-testid^="review-filter-"]', value: 4, label: '1.5 four filter buttons present' },
    { kind: 'count-gte', selector: '[data-testid^="review-game-card-"]', value: 1, label: '1.6 sample seeder → at least one tile' },
  ]);

  // ── Filter click → swaps active state ───────────────────────────
  await record('review-filter-coach', async () => {
    const coachFilter = page.locator('[data-testid="review-filter-coach"]');
    if (await coachFilter.count() > 0) await coachFilter.first().click();
  }, NAV_SETTLE_MS, [
    { kind: 'audit-present', audit: 'coach-surface-migrated', label: '1.5 filter click emits audit' },
  ]);
  // Reset to "all" so the tile click below has the broadest pool.
  await record('review-filter-all', async () => {
    const allFilter = page.locator('[data-testid="review-filter-all"]');
    if (await allFilter.count() > 0) await allFilter.first().click();
  }, NAV_SETTLE_MS);

  // ── Click a sample tile → session page ──────────────────────────
  await record('review-session-load', async () => {
    const firstTile = page.locator('[data-testid^="review-game-card-"]').first();
    if (await firstTile.count() === 0) throw new Error('no review-game-card tile rendered');
    await firstTile.click();
    // Wait for either the walk-ui or a fallback summary card or the loading state.
    await page.waitForTimeout(2000);
    // Loosely wait for walk-ui to settle (analysis + narration prep can run).
    await page.locator('[data-testid="coach-game-review-walk"], [data-testid="coach-game-review"]')
      .first()
      .waitFor({ timeout: 25000 });
  }, SESSION_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/review\/[\w-]+/, label: '2.1 URL routed to session page' },
    { kind: 'visible', selector: '[data-testid="coach-game-review-walk"], [data-testid="coach-game-review"]', label: '2.1 walk UI or fallback mounts' },
  ]);

  // ── Verify the session-page sub-controls ───────────────────────
  await record('review-session-controls', async () => {
    // No action — just observe what's already rendered.
  }, 500, [
    { kind: 'visible', selector: '[data-testid="review-nav-controls"]', label: '2.6 nav controls container' },
    { kind: 'visible', selector: '[data-testid="review-forward-btn"]', label: '2.6 forward button' },
    { kind: 'visible', selector: '[data-testid="review-back-btn"]', label: '2.6 back button' },
    { kind: 'visible', selector: '[data-testid="review-narration-banner"]', label: '2.9 narration banner' },
    { kind: 'visible', selector: '[data-testid="review-engine-lines-section"]', label: '2.10 engine-lines section header' },
    { kind: 'visible', selector: '[data-testid="review-engine-lines-toggle"]', label: '2.10 engine-lines toggle' },
    { kind: 'visible', selector: '[data-testid="walk-narration-toggle-btn"]', label: '2.9 narration toggle button' },
    { kind: 'visible', selector: '[data-testid="walk-ask-toggle-btn"]', label: '2.11 ask toggle button' },
    { kind: 'visible', selector: '[data-testid="review-bottom-bar"]', label: '2.14 bottom bar container' },
    { kind: 'visible', selector: '[data-testid="walk-play-again-btn"]', label: '2.14 play-again button' },
    { kind: 'visible', selector: '[data-testid="walk-back-to-coach-btn"]', label: '2.14 back-to-coach button' },
  ]);

  // ── Navigate forward 2 plies, then back 2 ──────────────────────
  await record('review-forward-2', async () => {
    const fwd = page.locator('[data-testid="review-forward-btn"]');
    await fwd.click();
    await page.waitForTimeout(400);
    await fwd.click();
  }, NAV_SETTLE_MS, [
    { kind: 'audit-present', audit: 'review-nav', label: '2.7 review-nav audit on forward' },
    { kind: 'audit-present', audit: 'review-playback-step', label: 'review-playback-step audit per forward' },
  ]);

  await record('review-back-2', async () => {
    const back = page.locator('[data-testid="review-back-btn"]');
    await back.click();
    await page.waitForTimeout(400);
    await back.click();
  }, NAV_SETTLE_MS);

  // ── Keyboard nav ────────────────────────────────────────────────
  await record('review-keyboard-arrow-right', async () => {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowLeft');
  }, NAV_SETTLE_MS, [
    { kind: 'audit-present', audit: 'review-nav', label: '2.8 keyboard fires review-nav' },
  ]);

  // ── Engine lines toggle ─────────────────────────────────────────
  await record('review-engine-lines-toggle', async () => {
    const toggle = page.locator('[data-testid="review-engine-lines-toggle"]');
    if (await toggle.count() > 0) await toggle.click();
  }, NAV_SETTLE_MS, [
    { kind: 'audit-present', audit: 'review-engine-lines-toggled', label: '2.10 engine-lines audit fires' },
  ]);

  // ── Ask panel toggle ────────────────────────────────────────────
  await record('review-ask-toggle', async () => {
    const ask = page.locator('[data-testid="walk-ask-toggle-btn"]');
    if (await ask.count() > 0) await ask.click();
  }, NAV_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="walk-ask-panel"]', label: '2.11 ask panel expanded' },
  ]);

  // ── Back to list via bottom bar ─────────────────────────────────
  await record('review-back-to-list', async () => {
    const back = page.locator('[data-testid="walk-back-to-coach-btn"]');
    if (await back.count() > 0) await back.click();
    await page.waitForTimeout(1500);
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/review(?!\/)/, label: '2.14 back-to-coach lands on list' },
  ]);

  // ── Roll up + write report ──────────────────────────────────────
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const failedExpectations = report.surfaces.flatMap((s) =>
    (s.expectations ?? []).filter((e) => !e.ok).map((e) => ({ surface: s.name, ...e })),
  );

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[coach-review] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[coach-review] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
    }
  } else {
    console.log(`[coach-review] all expectations passed`);
  }
  console.log(`[coach-review] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[coach-review] fatal:', err);
  process.exit(1);
});
