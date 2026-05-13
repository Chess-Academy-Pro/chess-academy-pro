#!/usr/bin/env node
/**
 * Audit-tactics — drives the Tactics tab end-to-end against the
 * deployed app (or a local dev server via AUDIT_SMOKE_URL).
 *
 * Mirrors the audit-smoke.mjs pattern:
 *   - one Chromium session, no page reloads
 *   - SPA navigation via real clicks
 *   - audit-stream enabled via localStorage; outgoing POSTs
 *     intercepted so we get the exact payload the page tried to push
 *   - console.errors + pageerrors captured per surface
 *   - screenshot + per-surface event summary in report.json
 *
 * Every capability the Tactics hub exposes is exercised at least once:
 *   - hub render + tile count + SmartSearchBar visibility
 *   - all 4 fixed tiles (Profile / Daily / Setup / Random Mix)
 *   - 3 representative theme drills (Forks, Pins & Skewers, Mating Nets)
 *   - My Weaknesses + My Mistakes
 *   - Profile refresh + Train-Your-Weakest CTA
 *   - Setup-trainer difficulty pick (Beginner)
 *   - legacy /puzzles/* redirect → /tactics/*
 *
 * Usage:
 *   node scripts/audit-tactics.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-tactics.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-tactics.mjs
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
const OUT_DIR = `audit-reports/tactics-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const PUZZLE_SETTLE_MS = 8000; // boards + Stockfish + puzzle load

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[tactics] base    = ${BASE_URL}`);
  console.log(`[tactics] stream  = ${STREAM_URL}`);
  console.log(`[tactics] outDir  = ${OUT_DIR}`);
  console.log(`[tactics] headed  = ${HEADED}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditTacticsBot/1.0 (chromium)',
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

  const report = { base: BASE_URL, startedAt: stamp, surfaces: [], expectations: [] };

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
    const kindCounts = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const sortedKinds = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
    const url = page.url();

    // Run expectations against the *current* page state
    const checks = [];
    for (const exp of expectations) {
      try {
        const ok = await exp.fn();
        checks.push({ label: exp.label, ok: !!ok });
      } catch (e) {
        checks.push({ label: exp.label, ok: false, error: String(e?.message ?? e) });
      }
    }

    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);

    console.log(`\n[tactics] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    for (const c of checks) {
      console.log(`    ${c.ok ? 'PASS' : 'FAIL'} — ${c.label}${c.error ? ` (${c.error})` : ''}`);
    }
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

    report.surfaces.push({
      name,
      url,
      durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kindCounts,
      checks,
      screenshot: screenshotPath,
      consoleErrors: newConsole,
      pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      error: actionErr,
    });
  }

  async function visible(testid) {
    return await page.locator(`[data-testid="${testid}"]`).first().isVisible().catch(() => false);
  }

  async function hasText(needle) {
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    return body.toLowerCase().includes(needle.toLowerCase());
  }

  async function tileCount() {
    return await page.locator('[data-testid^="section-"]').count().catch(() => 0);
  }

  // ───────────────────────────────────────────────────────────────────
  // 1. Boot
  // ───────────────────────────────────────────────────────────────────
  await record(
    'dashboard',
    async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
    },
    6000,
  );

  // ───────────────────────────────────────────────────────────────────
  // 2. Tactics hub via bottom nav — should show 16 tiles + search
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-hub',
    async () => {
      await page.getByRole('link', { name: 'Tactics' }).first().click();
      await page.locator('[data-testid="tactics-page"]').waitFor({ timeout: 15_000 });
    },
    4500,
    [
      { label: 'tactics-page testid present', fn: () => visible('tactics-page') },
      { label: 'page title visible', fn: () => hasText('tactical training') },
      { label: 'search bar present', fn: async () => (await page.locator('input[placeholder*="Search"]').count()) > 0 },
      { label: 'all 16 tiles render', fn: async () => (await tileCount()) >= 16 },
      { label: 'My Profile tile present', fn: () => visible('section-spot') },
      { label: 'Daily Training tile present', fn: () => visible('section-daily') },
      { label: 'Setup Trainer tile present', fn: () => visible('section-setup') },
      { label: 'Random Mix tile present', fn: () => visible('section-random-mix') },
      { label: 'Forks tile present', fn: () => visible('section-forks') },
      { label: 'Mating Nets tile present', fn: () => visible('section-mating nets') },
      { label: 'My Weaknesses tile present', fn: () => visible('section-my-weaknesses') },
      { label: 'My Mistakes tile present', fn: () => visible('section-my mistakes') },
    ],
  );

  // helper — bounce back to hub via the Tactics nav link
  async function backToHub() {
    await page.getByRole('link', { name: 'Tactics' }).first().click().catch(() => {});
    await page.locator('[data-testid="tactics-page"]').waitFor({ timeout: 10_000 }).catch(() => {});
  }

  // ───────────────────────────────────────────────────────────────────
  // 3. My Profile tile
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-profile',
    async () => {
      await page.locator('[data-testid="section-spot"]').click();
    },
    SHORT_SETTLE_MS,
    [
      { label: 'route is /tactics/profile', fn: () => page.url().endsWith('/tactics/profile') },
      { label: 'back button rendered', fn: () => visible('back-btn') },
      {
        label: 'profile body content visible (CTA or loading)',
        fn: async () => (await visible('begin-training-btn')) || (await hasText('tactical profile')),
      },
      { label: 'refresh button rendered (or empty-state)', fn: async () => (await visible('refresh-btn')) || (await hasText('loading')) },
    ],
  );

  // exercise refresh
  await record(
    'tactics-profile-refresh',
    async () => {
      const r = page.locator('[data-testid="refresh-btn"]');
      if (await r.isVisible().catch(() => false)) await r.click();
    },
    2500,
    [
      { label: 'no page error after refresh', fn: () => true },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 4. Daily Training (PuzzleTrainerPage)
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-classic',
    async () => {
      await page.locator('[data-testid="section-daily"]').click();
    },
    PUZZLE_SETTLE_MS,
    [
      { label: 'route is /tactics/classic', fn: () => page.url().endsWith('/tactics/classic') },
      {
        label: 'trainer or empty-state visible',
        fn: async () =>
          (await visible('puzzle-trainer')) ||
          (await visible('session-complete')) ||
          (await hasText('puzzle')),
      },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 5. Setup Trainer — difficulty select + Beginner queue
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-setup-select',
    async () => {
      await page.locator('[data-testid="section-setup"]').click();
    },
    SHORT_SETTLE_MS,
    [
      { label: 'route is /tactics/setup', fn: () => page.url().endsWith('/tactics/setup') },
      { label: 'difficulty Beginner button present', fn: () => visible('difficulty-1') },
      { label: 'difficulty Intermediate button present', fn: () => visible('difficulty-2') },
      { label: 'difficulty Advanced button present', fn: () => visible('difficulty-3') },
    ],
  );

  await record(
    'tactics-setup-beginner',
    async () => {
      const d1 = page.locator('[data-testid="difficulty-1"]');
      if (await d1.isVisible().catch(() => false)) await d1.click();
    },
    PUZZLE_SETTLE_MS,
    [
      {
        label: 'queue loads OR empty-summary shown',
        fn: async () =>
          (await visible('puzzle-nav')) ||
          (await visible('session-summary')) ||
          (await visible('loading')),
      },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 6. Random Mix (col-span Random Mix tile passes filterThemes state)
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-random-mix',
    async () => {
      await page.locator('[data-testid="section-random-mix"]').click();
    },
    PUZZLE_SETTLE_MS,
    [
      { label: 'route is /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'drill page mounts', fn: () => visible('tactic-drill-page') },
      {
        label: 'board or summary visible',
        fn: async () =>
          (await visible('puzzle-nav')) ||
          (await visible('session-summary')) ||
          (await hasText('loading puzzle')),
      },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 7. Theme drills — Forks
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-drill-forks',
    async () => {
      await page.locator('[data-testid="section-forks"]').click();
    },
    PUZZLE_SETTLE_MS,
    [
      { label: 'route is /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'drill page mounts', fn: () => visible('tactic-drill-page') },
      { label: 'theme label shows "Fork" or "Mixed"', fn: async () => (await hasText('drill: fork')) || (await hasText('mixed')) },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 8. Theme drills — Pins & Skewers
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-drill-pins',
    async () => {
      await page.locator('[data-testid="section-pins & skewers"]').click();
    },
    PUZZLE_SETTLE_MS,
    [
      { label: 'route is /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'drill page mounts', fn: () => visible('tactic-drill-page') },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 9. Theme drills — Mating Nets
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-drill-mating-nets',
    async () => {
      await page.locator('[data-testid="section-mating nets"]').click();
    },
    PUZZLE_SETTLE_MS,
    [
      { label: 'route is /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'drill page mounts', fn: () => visible('tactic-drill-page') },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 10. My Weaknesses (theme detection)
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-weakness-themes',
    async () => {
      await page.locator('[data-testid="section-my-weaknesses"]').click();
    },
    SHORT_SETTLE_MS,
    [
      { label: 'route is /tactics/weakness-themes', fn: () => page.url().endsWith('/tactics/weakness-themes') },
      { label: 'weakness page mounts', fn: () => visible('weakness-themes-page') },
      {
        label: 'themes list OR empty-state visible',
        fn: async () => (await visible('themes-list')) || (await visible('loading')),
      },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 11. My Mistakes
  // ───────────────────────────────────────────────────────────────────
  await record(
    'tactics-mistakes',
    async () => {
      await page.locator('[data-testid="section-my mistakes"]').click();
    },
    SHORT_SETTLE_MS,
    [
      { label: 'route is /tactics/mistakes', fn: () => page.url().endsWith('/tactics/mistakes') },
      {
        label: 'mistakes page mounts',
        fn: async () => (await visible('my-mistakes-page')) || (await visible('loading')) || (await visible('empty-state')),
      },
    ],
  );

  await backToHub();

  // ───────────────────────────────────────────────────────────────────
  // 12. Legacy /puzzles → /tactics redirect (hard-goto allowed for
  //     redirect tests since the SPA still handles it)
  // ───────────────────────────────────────────────────────────────────
  await record(
    'legacy-redirect-puzzles',
    async () => {
      await page.goto(`${BASE_URL}/puzzles`, { waitUntil: 'domcontentloaded' });
    },
    3000,
    [
      { label: '/puzzles redirects to /tactics', fn: () => page.url().endsWith('/tactics') },
      { label: 'tactics hub re-renders after redirect', fn: () => visible('tactics-page') },
    ],
  );

  await record(
    'legacy-redirect-puzzles-classic',
    async () => {
      await page.goto(`${BASE_URL}/puzzles/classic`, { waitUntil: 'domcontentloaded' });
    },
    3000,
    [
      { label: '/puzzles/classic redirects to /tactics/classic', fn: () => page.url().endsWith('/tactics/classic') },
    ],
  );

  // ───────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  report.errorLevelEvents = captured.filter((e) => String(e.level ?? '').toLowerCase() === 'error');

  // Failure roll-up
  const failedChecks = [];
  for (const s of report.surfaces) {
    for (const c of s.checks ?? []) {
      if (!c.ok) failedChecks.push({ surface: s.name, label: c.label, error: c.error });
    }
    if (s.error) failedChecks.push({ surface: s.name, label: 'navigation action', error: s.error });
    if (s.pageErrors?.length) {
      for (const e of s.pageErrors) failedChecks.push({ surface: s.name, label: 'pageerror', error: e });
    }
  }
  report.failedChecks = failedChecks;

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[tactics] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  console.log(`[tactics] failures: ${failedChecks.length}`);
  if (failedChecks.length) {
    for (const f of failedChecks) {
      console.log(`  - ${f.surface} :: ${f.label}${f.error ? ` :: ${f.error}` : ''}`);
    }
  }
  console.log(`[tactics] report: ${OUT_DIR}/report.json`);

  await browser.close();
  if (failedChecks.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[tactics] fatal:', err);
  process.exit(1);
});
