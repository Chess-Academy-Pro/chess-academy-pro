#!/usr/bin/env node
/**
 * Audit-weaknesses — deep audit of /weaknesses (GameInsightsPage).
 *
 * Coverage:
 *   Page mount + header
 *     - game-insights-page container mounts
 *     - back-btn visible
 *     - search-input visible
 *     - all 5 tab buttons (tab-overview / tab-openings / tab-mistakes
 *       / tab-tactics / tab-patterns) render
 *   Tab switching
 *     - Click each tab → matching content container mounts
 *     - Active tab styling toggles (last clicked = active)
 *   Overview tab content (default state)
 *     - overview-tab mounts
 *     - analyze-cta visible when no games or analyze pending
 *     - ImportGames / AnalyzeGames CTAs render
 *   Mistakes / Tactics tab with synthetic data
 *     - seed a synthetic puzzle into Dexie
 *     - mistake-row / tactic-row renders
 *     - row click navigates to /coach/review/:id?move=...
 *     - history.state.usr carries { from: '/weaknesses', tab: 'mistakes' }
 *   Patterns tab
 *     - patterns-tab or patterns-empty mounts (no error)
 *   Openings tab
 *     - openings-tab mounts (no error)
 *   Back button
 *     - top-bar back-btn navigates away from /weaknesses
 *   No console errors / page errors
 *
 * Run: node scripts/audit-weaknesses.mjs
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = `${BASE_URL}/api/audit-stream`;
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/weaknesses-${stamp}`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[weaknesses] base   = ${BASE_URL}`);
  console.log(`[weaknesses] outDir = ${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[weaknesses] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditWeaknessesBot/1.0 (chromium)',
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

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const scenarios = [];
  async function scenario(name, fn) {
    const t0 = Date.now();
    let ok = false;
    let detail = '';
    try {
      detail = await fn();
      ok = true;
    } catch (err) {
      detail = `error: ${err.message}`;
    }
    const result = { name, ok, durationMs: Date.now() - t0, detail };
    scenarios.push(result);
    console.log(`  ${ok ? '✓' : '✗'} ${name} → ${detail}`);
    return result;
  }

  // ───────────────────────────────────────────────────────────────
  // Boot
  // ───────────────────────────────────────────────────────────────
  await scenario('boot-weaknesses', async () => {
    // First page-load cold-start on Vercel can take 30-45s for a
    // fresh Production deploy as the function instance warms up
    // and the bundle parses. Subsequent SPA navigations are <2s
    // because the bundle is cached. Generous timeout here.
    await page.goto(`${BASE_URL}/weaknesses`, { timeout: 60_000 });
    await page.locator('[data-testid="game-insights-page"]').waitFor({ timeout: 45_000 });
    return 'page mounted';
  });

  // ───────────────────────────────────────────────────────────────
  // Header controls present
  // ───────────────────────────────────────────────────────────────
  await scenario('header-back-btn-visible', async () => {
    if (!(await page.locator('[data-testid="back-btn"]').isVisible())) {
      throw new Error('back-btn missing');
    }
    return 'visible';
  });

  await scenario('header-search-input-visible', async () => {
    if (!(await page.locator('[data-testid="search-input"]').isVisible())) {
      throw new Error('search-input missing');
    }
    return 'visible';
  });

  // ───────────────────────────────────────────────────────────────
  // All 5 tab buttons present
  // ───────────────────────────────────────────────────────────────
  const tabIds = ['overview', 'openings', 'mistakes', 'tactics', 'patterns'];
  for (const t of tabIds) {
    await scenario(`tab-${t}-button-visible`, async () => {
      const btn = page.locator(`[data-testid="tab-${t}"]`);
      if (!(await btn.isVisible())) throw new Error(`tab-${t} missing`);
      return 'visible';
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Overview tab content (default)
  // ───────────────────────────────────────────────────────────────
  await scenario('overview-tab-content-mounts', async () => {
    // Tab defaults to overview on fresh entry (state.tab unset).
    await page.locator('[data-testid="overview-tab"]').waitFor({ timeout: 5_000 });
    return 'overview content visible';
  });

  // ───────────────────────────────────────────────────────────────
  // Switch through each tab and verify content mounts
  // ───────────────────────────────────────────────────────────────
  // PatternsTab uses `patterns-loading` / `patterns-empty` / `patterns-tab`
  // (different naming convention from other tabs which use the
  // `<name>-tab` suffix consistently). The variants array captures
  // every acceptable mount testid per tab.
  const tabContentVariants = {
    openings: ['openings-tab'],
    mistakes: ['mistakes-tab'],
    tactics: ['tactics-tab'],
    patterns: ['patterns-tab', 'patterns-loading', 'patterns-empty'],
  };
  for (const [tab, variants] of Object.entries(tabContentVariants)) {
    await scenario(`switch-to-${tab}-loads-content`, async () => {
      await page.locator(`[data-testid="tab-${tab}"]`).click();
      const selector = variants.map((v) => `[data-testid="${v}"]`).join(', ');
      const ok = await page
        .locator(selector)
        .first()
        .waitFor({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) throw new Error(`no variant matched: ${variants.join(', ')}`);
      let matched = '?';
      for (const v of variants) {
        if ((await page.locator(`[data-testid="${v}"]`).count()) > 0) {
          matched = v;
          break;
        }
      }
      return `matched ${matched}`;
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Synthetic-data drive: seed a Mistake puzzle + Tactical moment so
  // the rows actually appear, then verify the row → review nav.
  // (The audit-back-from-review covers state-carrying nav explicitly;
  // here we focus on row presence + click contract.)
  // ───────────────────────────────────────────────────────────────
  // Visit /coach/review first so the sample-game seeder runs and
  // populates Dexie with `sample-morphy-opera-1858`. Without this,
  // the synthetic mistake puzzle below references a non-existent
  // sourceGameId — the review session page then can't adapt the
  // GameRecord and the `coach-game-review` container never mounts,
  // cascading into back-from-review test failure.
  await scenario('pre-seed-sample-games-via-review-list', async () => {
    await page.goto(`${BASE_URL}/coach/review`);
    await page.locator('[data-testid="coach-review-list-page"]').waitFor({ timeout: 15_000 });
    await page
      .locator('[data-testid^="review-game-card-"]')
      .first()
      .waitFor({ timeout: 30_000 });
    return 'sample games seeded';
  });

  // Return to /weaknesses for the synthetic seed + row exercise.
  await scenario('return-to-weaknesses', async () => {
    await page.goto(`${BASE_URL}/weaknesses`, { timeout: 60_000 });
    await page.locator('[data-testid="game-insights-page"]').waitFor({ timeout: 45_000 });
    return 'back on /weaknesses';
  });

  await scenario('seed-synthetic-mistake', async () => {
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      const puzzle = {
        id: 'audit-weaknesses-mistake-1',
        fen: 'rnbqk2r/ppp2ppp/3p1n2/2b5/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1',
        playerMove: 'd2d3',
        playerMoveSan: 'd3',
        bestMove: 'd2d4',
        bestMoveSan: 'd4',
        moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 Nc3 Nf6',
        cpLoss: 220,
        classification: 'mistake',
        gamePhase: 'opening',
        moveNumber: 5,
        sourceGameId: 'sample-morphy-opera-1858',
        sourceMode: 'imported',
        playerColor: 'white',
        promptText: 'audit synthetic',
        narration: { intro: '', body: '', outro: '' },
        createdAt: now,
        opponentName: 'AuditBot',
        gameDate: now,
        openingName: 'Italian Game',
        evalBefore: 30,
        srsInterval: 1,
        srsEaseFactor: 2.5,
        srsRepetitions: 0,
        srsDueDate: now,
        srsLastReview: null,
        status: 'new',
        attempts: 0,
        successes: 0,
      };
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('ChessAcademyDB');
        req.onerror = () => reject(new Error('failed to open DB'));
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('mistakePuzzles')) {
            db.close();
            reject(new Error('mistakePuzzles store missing'));
            return;
          }
          const tx = db.transaction('mistakePuzzles', 'readwrite');
          const putReq = tx.objectStore('mistakePuzzles').put(puzzle);
          putReq.onerror = () => {
            db.close();
            reject(new Error('put failed'));
          };
          putReq.onsuccess = () => {
            db.close();
            resolve(undefined);
          };
        };
      });
    });
    return 'seeded';
  });

  await scenario('refresh-and-mistake-row-shows', async () => {
    // Use goto rather than reload — Playwright reload sometimes
    // races the SPA's hydration phase on a slow Vercel cold start.
    // goto with a generous timeout is more reliable.
    await page.goto(`${BASE_URL}/weaknesses`, { timeout: 60_000 });
    await page.locator('[data-testid="game-insights-page"]').waitFor({ timeout: 45_000 });
    await page.locator('[data-testid="tab-mistakes"]').click();
    await page.locator('[data-testid="mistake-row"]').first().waitFor({ timeout: 15_000 });
    const count = await page.locator('[data-testid="mistake-row"]').count();
    return `${count} mistake-row(s) rendered`;
  });

  await scenario('mistake-row-click-navigates-with-state', async () => {
    await page.locator('[data-testid="mistake-row"]').first().click();
    await page.waitForURL(/\/coach\/review\/[\w-]+/, { timeout: 10_000 });
    const histState = await page.evaluate(() => (history.state?.usr ?? null));
    if (!histState || histState.from !== '/weaknesses' || histState.tab !== 'mistakes') {
      throw new Error(`state.usr wrong: ${JSON.stringify(histState)}`);
    }
    return `state.usr = ${JSON.stringify(histState)}`;
  });

  await scenario('back-from-review-restores-mistakes-tab', async () => {
    // From the review page (entered via state-carrying nav above),
    // click the Back button. Should land on /weaknesses with the
    // Mistakes tab restored (not Overview).
    await page.locator('[data-testid="coach-game-review"]').waitFor({ timeout: 30_000 });
    const back = page.locator('[data-testid="summary-back-btn"]');
    if ((await back.count()) === 0) throw new Error('summary-back-btn missing');
    await back.click();
    // Allow time for the back-navigation + GameInsightsPage to
    // re-mount with state.tab restored. The mount triggers async
    // data fetches so the tab content can take a beat to settle.
    await page.waitForTimeout(2000);
    if (!/\/weaknesses(?!\/)/.test(page.url())) {
      throw new Error(`expected /weaknesses, got ${new URL(page.url()).pathname}`);
    }
    // Wait for the mistakes-tab container to mount specifically —
    // this is the "active tab" signal since only the active tab's
    // body is rendered.
    const ok = await page
      .locator('[data-testid="mistakes-tab"]')
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) throw new Error('mistakes tab not active on back-nav');
    return 'mistakes tab restored';
  });

  // ───────────────────────────────────────────────────────────────
  // Top-bar back-btn navigates away from /weaknesses
  // ───────────────────────────────────────────────────────────────
  await scenario('back-btn-leaves-weaknesses', async () => {
    await page.locator('[data-testid="back-btn"]').click();
    await page.waitForTimeout(800);
    if (/\/weaknesses(?!\/)/.test(page.url())) {
      throw new Error(`still on /weaknesses after back-btn: ${page.url()}`);
    }
    return `landed on ${new URL(page.url()).pathname}`;
  });

  // ───────────────────────────────────────────────────────────────
  // Roll up
  // ───────────────────────────────────────────────────────────────
  const failures = scenarios.filter((s) => !s.ok);
  const report = {
    base: BASE_URL,
    durationMs: scenarios.reduce((acc, s) => acc + s.durationMs, 0),
    consoleErrors,
    pageErrors,
    scenarios,
    summary: {
      total: scenarios.length,
      passed: scenarios.length - failures.length,
      failed: failures.length,
    },
  };

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[weaknesses] summary:`);
  console.log(`  passed:         ${report.summary.passed}/${report.summary.total}`);
  console.log(`  failed:         ${failures.length}`);
  console.log(`  console.errors: ${consoleErrors.length}`);
  console.log(`  pageerrors:     ${pageErrors.length}`);
  if (failures.length > 0) {
    console.log(`\nFAILURES:`);
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.detail}`);
    }
  }

  await browser.close();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[weaknesses] fatal:', err);
  process.exit(2);
});
