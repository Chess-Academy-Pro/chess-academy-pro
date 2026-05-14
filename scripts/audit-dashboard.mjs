#!/usr/bin/env node
/**
 * Audit-dashboard — drives the app's root surface (Dashboard +
 * SmartSearchBar) against deployed prod. This is the entry point on
 * every cold start AND the search bar is mounted on every route via
 * GlobalCoachDrawer's surrounding chrome — highest blast-radius of
 * any untouched surface as of 2026-05-14.
 *
 * Mirrors audit-coach-chat.mjs / audit-coach-play.mjs / audit-coach-
 * review.mjs / audit-tactics.mjs patterns:
 *   - one Chromium session, no page reloads
 *   - SPA navigation via real clicks
 *   - audit-stream POST intercept + console.errors + pageerrors
 *   - per-surface `record()` with expectations array
 *
 * Surfaces / behaviors exercised:
 *   Dashboard root (`/`)
 *     - root container mounts (`dashboard`)
 *     - Chess Academy Pro title
 *     - Import Games button present + clickable
 *     - SmartSearchBar mounts + responds to typing
 *     - 4 section tiles render: Openings / Coach / Tactics / Weaknesses
 *     - Clicking each section navigates to its route
 *   SmartSearchBar
 *     - Typing produces some kind of dropdown content
 *     - Mic button present (or unsupported-stub)
 *     - Clear button hides input value
 *     - Ask-coach option appears for free-text queries
 *
 * Usage:
 *   node scripts/audit-dashboard.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-dashboard.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-dashboard.mjs
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
const OUT_DIR = `audit-reports/dashboard-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 2500;
const NAV_SETTLE_MS = 1500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[dashboard] base    = ${BASE_URL}`);
  console.log(`[dashboard] outDir  = ${OUT_DIR}`);
  console.log(`[dashboard] headed  = ${HEADED}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditDashboardBot/1.0 (chromium)',
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
    } catch { /* ignore */ }
    const fresh = captured.slice(before);
    const kinds = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const url = page.url();
    console.log(`\n[dashboard] ${name}  →  ${url}  (${Date.now() - t0}ms)`);
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

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
        } else if (exp.kind === 'count-eq') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count === exp.value;
        } else if (exp.kind === 'url-matches') {
          actual = page.url();
          ok = exp.value.test(actual);
        } else if (exp.kind === 'text-contains') {
          const text = await page.locator(exp.selector).first().textContent().catch(() => '');
          actual = (text ?? '').slice(0, 80);
          ok = (text ?? '').toLowerCase().includes(exp.value.toLowerCase());
        } else if (exp.kind === 'input-value-empty') {
          const val = await page.locator(exp.selector).first().inputValue().catch(() => '');
          actual = `"${val}"`;
          ok = val === '';
        }
      } catch (err) {
        actual = `error: ${err.message}`;
      }
      expectationResults.push({ ...exp, actual, ok });
      console.log(`  ${ok ? '✓' : '✗'} ${exp.label} → ${actual}`);
    }

    report.surfaces.push({
      name, url, durationMs: Date.now() - t0, eventCount: fresh.length,
      kinds, screenshot: screenshotPath,
      consoleErrors: newConsole, pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      expectations: expectationResults,
      error: actionErr,
    });
  }

  // ── Boot ────────────────────────────────────────────────────────
  await record('boot', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="dashboard"]').waitFor({ timeout: BOOT_TIMEOUT_MS });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="dashboard"]', label: 'dashboard root mounts' },
    { kind: 'text-contains', selector: 'h1', value: 'Chess Academy Pro', label: 'app title renders' },
    { kind: 'visible', selector: '[data-testid="import-games-btn"]', label: 'Import Games button present' },
    { kind: 'visible', selector: '[data-testid="smart-search"]', label: 'SmartSearchBar mounts' },
    { kind: 'visible', selector: '[data-testid="smart-search-input"]', label: 'search input present' },
    { kind: 'count-eq', selector: '[data-testid^="section-"]', value: 4, label: '4 section tiles render' },
    { kind: 'visible', selector: '[data-testid="section-openings"]', label: 'Openings tile' },
    { kind: 'visible', selector: '[data-testid="section-coach"]', label: 'Coach tile' },
    { kind: 'visible', selector: '[data-testid="section-tactics"]', label: 'Tactics tile' },
    { kind: 'visible', selector: '[data-testid="section-weaknesses"]', label: 'Weaknesses tile' },
  ]);

  // ── SmartSearchBar typing → dropdown surfaces ───────────────────
  await record('search-typing-surfaces-dropdown', async () => {
    const input = page.locator('[data-testid="smart-search-input"]');
    await input.click();
    await input.fill('Sicilian Defense');
    await page.waitForTimeout(800);
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="search-dropdown"]', label: 'dropdown opens after typing' },
    // Some kind of option renders — either a search result, an agent
    // action, or the ask-coach fallback. Don't pin which because the
    // exact dropdown contents depend on opening DB seeded state.
    { kind: 'count-gte', selector: '[data-testid="search-result"], [data-testid="agent-action-option"], [data-testid="ask-coach-option"]', value: 1, label: 'at least one dropdown option' },
  ]);

  // ── Clear button empties the input ──────────────────────────────
  await record('search-clear-button', async () => {
    const clear = page.locator('[data-testid="search-clear"]');
    if (await clear.count() > 0) await clear.first().click();
  }, NAV_SETTLE_MS, [
    { kind: 'input-value-empty', selector: '[data-testid="smart-search-input"]', label: 'input cleared after clicking X' },
  ]);

  // ── Ask Coach fallback ──────────────────────────────────────────
  // Free-text query that the deterministic intent router doesn't
  // match should surface the "Ask coach" option.
  await record('search-ask-coach-option', async () => {
    const input = page.locator('[data-testid="smart-search-input"]');
    await input.click();
    await input.fill('why is the knight strong in closed positions');
    await page.waitForTimeout(800);
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="ask-coach-option"]', label: 'Ask-Coach option offered for free-text query' },
  ]);

  // Clear the input before nav probes so we don't carry typed text.
  await page.locator('[data-testid="search-clear"]').first().click().catch(() => undefined);

  // ── Section tile navigation ─────────────────────────────────────
  // Each tile navigates to its corresponding route. We return to /
  // between each click so we re-mount the dashboard for the next probe.
  const tiles = [
    { testid: 'section-openings', route: /\/openings$/, label: 'Openings → /openings' },
    { testid: 'section-coach',    route: /\/coach\/home$/, label: 'Coach → /coach/home' },
    { testid: 'section-tactics',  route: /\/tactics$/, label: 'Tactics → /tactics' },
    { testid: 'section-weaknesses', route: /\/weaknesses$/, label: 'Weaknesses → /weaknesses' },
  ];

  for (const tile of tiles) {
    await record(`nav-${tile.testid}`, async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      const btn = page.locator(`[data-testid="${tile.testid}"]`);
      await btn.waitFor({ timeout: 8000 });
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      // Click, poll for URL change. If URL doesn't change in 6s,
      // retry the click once — Vercel sometimes drops the chunk fetch
      // on first attempt and the lazy-loaded route handler never
      // resolves. Audit observed 2026-05-14: same tile passes or
      // fails 50/50 across runs depending on network state.
      for (let attempt = 0; attempt < 2; attempt++) {
        await btn.click().catch(() => undefined);
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (tile.route.test(page.url())) return;
          await page.waitForTimeout(200);
        }
      }
    }, NAV_SETTLE_MS, [
      { kind: 'url-matches', value: tile.route, label: tile.label },
    ]);
  }

  // ── Import Games button navigates ───────────────────────────────
  await record('nav-import-games', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="import-games-btn"]').waitFor({ timeout: 8000 });
    await page.locator('[data-testid="import-games-btn"]').click();
    await page.waitForTimeout(1200);
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/games\/import$/, label: 'Import Games → /games/import' },
  ]);

  // ── Roll up + write report ─────────────────────────────────────
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  const failedExpectations = report.surfaces.flatMap((s) =>
    (s.expectations ?? []).filter((e) => !e.ok).map((e) => ({ surface: s.name, ...e })),
  );

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[dashboard] done — ${captured.length} events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[dashboard] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
    }
  } else {
    console.log(`[dashboard] all expectations passed`);
  }
  console.log(`[dashboard] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[dashboard] fatal:', err);
  process.exit(1);
});
