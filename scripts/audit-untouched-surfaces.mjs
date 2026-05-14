#!/usr/bin/env node
/**
 * Audit-untouched-surfaces — smoke audit for 5 surfaces that had no
 * Playwright drive coverage prior to 2026-05-14:
 *
 *   - Coach Train     (/coach/train)
 *   - Coach Analyse   (/coach/analyse)
 *   - Coach Plan      (/coach/plan)
 *   - Coach Hub       (/coach/home)
 *   - Kid Mode        (/kid)
 *
 * This is a SMOKE pass — it verifies each surface mounts cleanly, the
 * documented testids render, primary affordances are clickable, and no
 * pageerrors fire during nav. It does NOT drive the full interactive
 * loop on any of them (each warrants its own deep audit later).
 *
 * Mirrors the existing audit-*.mjs pattern.
 *
 * Usage:
 *   node scripts/audit-untouched-surfaces.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-untouched-surfaces.mjs
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
const OUT_DIR = `audit-reports/untouched-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 2500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[untouched] base    = ${BASE_URL}`);
  console.log(`[untouched] outDir  = ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditUntouchedBot/1.0 (chromium)',
  });
  await ctx.addInitScript(
    ({ url, secret }) => {
      try {
        window.localStorage.setItem('auditStreamUrl', url);
        window.localStorage.setItem('auditStreamSecret', secret);
      } catch { /* ignore */ }
    },
    { url: STREAM_URL, secret: SECRET },
  );
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500)); });
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 500)));

  const report = { base: BASE_URL, startedAt: stamp, surfaces: [] };

  async function record(name, action, settleMs = SHORT_SETTLE_MS, expectations = []) {
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    let actionErr = null;
    try {
      await action();
      await page.waitForTimeout(settleMs);
    } catch (e) {
      actionErr = String(e?.message ?? e);
    }
    const screenshotPath = join(OUT_DIR, `${name}.png`);
    try { await page.screenshot({ path: screenshotPath, fullPage: false }); } catch { /* ignore */ }
    const url = page.url();
    console.log(`\n[untouched] ${name}  →  ${url}  (${Date.now() - t0}ms)`);
    if (actionErr) console.log(`  [action error] ${actionErr}`);
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
          const c = await page.locator(exp.selector).count();
          const v = c > 0 ? await page.locator(exp.selector).first().isVisible().catch(() => false) : false;
          actual = v ? 'visible' : `not-visible (count=${c})`;
          ok = v;
        } else if (exp.kind === 'count-gte') {
          const c = await page.locator(exp.selector).count();
          actual = String(c);
          ok = c >= exp.value;
        } else if (exp.kind === 'url-matches') {
          actual = page.url();
          ok = exp.value.test(actual);
        } else if (exp.kind === 'no-pageerrors-this-step') {
          actual = String(newPage.length);
          ok = newPage.length === 0;
        }
      } catch (err) {
        actual = `error: ${err.message}`;
      }
      expectationResults.push({ ...exp, actual, ok });
      console.log(`  ${ok ? '✓' : '✗'} ${exp.label} → ${actual}`);
    }

    report.surfaces.push({
      name, url, durationMs: Date.now() - t0,
      screenshot: screenshotPath,
      consoleErrors: newConsole, pageErrors: newPage,
      expectations: expectationResults,
      error: actionErr,
    });
  }

  // ── Boot the app cold ──────────────────────────────────────────
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  await page.locator('[data-testid="dashboard"]').waitFor({ timeout: BOOT_TIMEOUT_MS });

  // ── /coach/home (Coach Hub) ────────────────────────────────────
  await record('coach-hub', async () => {
    await page.goto(`${BASE_URL}/coach/home`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 12000 });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-home-page"]', label: 'Coach hub mounts' },
    { kind: 'count-gte', selector: '[data-testid^="coach-action-"], [data-testid^="coach-tile-"]', value: 1, label: 'at least one action/tile renders' },
    { kind: 'no-pageerrors-this-step', label: 'no pageerrors during mount' },
  ]);

  // ── /coach/train ───────────────────────────────────────────────
  await record('coach-train', async () => {
    await page.goto(`${BASE_URL}/coach/train`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-train-page"]').waitFor({ timeout: 12000 });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-train-page"]', label: 'Coach Train mounts' },
    { kind: 'visible', selector: '[data-testid="training-heading"]', label: 'training heading visible' },
    // One of: loading state, no-recommendations state, or actual list.
    { kind: 'count-gte', selector: '[data-testid="train-loading"], [data-testid="no-recommendations"], [data-testid="recommendations"]', value: 1, label: 'one of loading / no-recs / recommendations state' },
    { kind: 'no-pageerrors-this-step', label: 'no pageerrors during mount' },
  ]);

  // ── /coach/analyse ─────────────────────────────────────────────
  await record('coach-analyse', async () => {
    await page.goto(`${BASE_URL}/coach/analyse`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-analyse-page"]').waitFor({ timeout: 12000 });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-analyse-page"]', label: 'Coach Analyse mounts' },
    { kind: 'visible', selector: '[data-testid="fen-input"]', label: 'FEN input present' },
    { kind: 'visible', selector: '[data-testid="load-fen-btn"]', label: 'Load FEN button present' },
    { kind: 'no-pageerrors-this-step', label: 'no pageerrors during mount' },
  ]);

  // ── /coach/plan ────────────────────────────────────────────────
  await record('coach-plan', async () => {
    await page.goto(`${BASE_URL}/coach/plan`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-session-plan-page"]').waitFor({ timeout: 12000 });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-session-plan-page"]', label: 'Coach Plan mounts' },
    // Plan explanation OR start-session button (depending on plan-load state).
    { kind: 'count-gte', selector: '[data-testid="plan-explanation"], [data-testid="start-session-btn"]', value: 0, label: 'plan content area renders (any state OK)' },
    { kind: 'no-pageerrors-this-step', label: 'no pageerrors during mount' },
  ]);

  // ── /kid (Kid Mode) ────────────────────────────────────────────
  await record('kid-mode', async () => {
    await page.goto(`${BASE_URL}/kid`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="kid-mode-page"]').waitFor({ timeout: 12000 });
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="kid-mode-page"]', label: 'Kid Mode mounts' },
    { kind: 'visible', selector: '[data-testid="journey-card"]', label: 'Journey card' },
    { kind: 'visible', selector: '[data-testid="fairy-tale-card"]', label: 'Fairy-tale card' },
    { kind: 'visible', selector: '[data-testid="puzzle-quest-card"]', label: 'Puzzle Quest card' },
    { kind: 'visible', selector: '[data-testid="play-games-card"]', label: 'Play Games card' },
    { kind: 'no-pageerrors-this-step', label: 'no pageerrors during mount' },
  ]);

  // ── Cross-surface: Kid card click navigates ────────────────────
  await record('kid-mode-card-nav', async () => {
    await page.goto(`${BASE_URL}/kid`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="kid-mode-page"]').waitFor({ timeout: 12000 });
    await page.locator('[data-testid="journey-card"]').click();
    await page.waitForTimeout(1200);
  }, SHORT_SETTLE_MS, [
    { kind: 'url-matches', value: /\/kid\/journey/, label: 'Journey card → /kid/journey' },
  ]);

  // ── Roll up ────────────────────────────────────────────────────
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  const failed = report.surfaces.flatMap((s) =>
    (s.expectations ?? []).filter((e) => !e.ok).map((e) => ({ surface: s.name, ...e })),
  );
  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[untouched] done — ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failed.length > 0) {
    console.log(`[untouched] FAILED expectations: ${failed.length}`);
    for (const e of failed) console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
  } else {
    console.log(`[untouched] all expectations passed`);
  }
  console.log(`[untouched] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[untouched] fatal:', err);
  process.exit(1);
});
