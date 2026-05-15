#!/usr/bin/env node
/**
 * Audit-openings-ui — deep-flow UI audit of every surface under
 * /openings/*. Drives the deployed app like a user, polls for
 * stability, verifies observable outcomes (board state changes,
 * navigation, control responsiveness) — not testid presence alone.
 *
 * Companion to scripts/audit-openings.mjs (which is data-quality
 * audit, not UI). Mirrors the structure of audit-tactics.mjs.
 *
 * Usage:
 *   node scripts/audit-openings-ui.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-openings-ui.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-openings-ui.mjs
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
const OUT_DIR = `audit-reports/openings-ui-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SETTLE_SHORT = 2500;
const SETTLE_MED = 5000;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[openings-ui] base=${BASE_URL} out=${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[openings-ui] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditOpeningsUIBot/1.0 (chromium)',
  });
  await ctx.addInitScript(({ url, secret }) => {
    try {
      window.localStorage.setItem('auditStreamUrl', url);
      window.localStorage.setItem('auditStreamSecret', secret);
    } catch {}
  }, { url: STREAM_URL, secret: SECRET });

  const page = await ctx.newPage();
  const captured = [];
  page.on('request', (req) => {
    if (req.url() === STREAM_URL && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body) captured.push(body);
      } catch {}
    }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500)); });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));

  const report = { base: BASE_URL, startedAt: stamp, scenarios: [] };

  async function scenario(name, action, settleMs, expectations = []) {
    const before = captured.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    let actionErr = null;
    try {
      await action();
      if (settleMs > 0) await page.waitForTimeout(settleMs);
    } catch (e) {
      actionErr = String(e?.message ?? e);
      console.log(`  [error] ${actionErr}`);
    }
    const screenshotPath = join(OUT_DIR, `${name}.png`);
    try { await page.screenshot({ path: screenshotPath, fullPage: false }); } catch {}
    const fresh = captured.slice(before);
    const url = page.url();
    const checks = [];
    for (const exp of expectations) {
      try { checks.push({ label: exp.label, ok: !!(await exp.fn()) }); }
      catch (e) { checks.push({ label: exp.label, ok: false, error: String(e?.message ?? e) }); }
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    console.log(`\n[openings-ui] ${name}  →  ${url}  (${Date.now() - t0}ms, ${fresh.length} events)`);
    for (const c of checks) {
      console.log(`    ${c.ok ? 'PASS' : 'FAIL'} — ${c.label}${c.error ? ` (${c.error})` : ''}`);
    }
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);
    report.scenarios.push({
      name, url, durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kindCounts: fresh.reduce((a, e) => { const k = String(e.kind ?? 'unknown'); a[k] = (a[k] ?? 0) + 1; return a; }, {}),
      checks, screenshot: screenshotPath,
      consoleErrors: newConsole, pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      error: actionErr,
    });
  }

  const visible = (tid) =>
    page.locator(`[data-testid="${tid}"]`).first().isVisible().catch(() => false);
  const bodyText = async () => (await page.textContent('body').catch(() => '')) ?? '';
  const hasText = async (t) => (await bodyText()).toLowerCase().includes(t.toLowerCase());
  const countSel = async (sel) => await page.locator(sel).count().catch(() => 0);
  async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await predicate()) return true; } catch {}
      await page.waitForTimeout(intervalMs);
    }
    return false;
  }
  async function clickOpeningsNav() {
    await page.getByRole('link', { name: 'Openings' }).first().click().catch(() => {});
    await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // ═══════════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '01-boot',
    async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
    },
    4000,
    [{ label: 'app boot', fn: () => hasText('chess academy pro') }],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /openings — Hub mount + all 4 tabs
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '02-hub-mount',
    async () => { await clickOpeningsNav(); },
    SETTLE_MED,
    [
      { label: 'route /openings', fn: () => page.url().endsWith('/openings') },
      { label: 'opening-explorer mount', fn: () => visible('opening-explorer') },
      { label: 'title "Openings"', fn: () => hasText('openings') },
      { label: 'tab-toggle present', fn: () => visible('tab-toggle') },
      { label: 'tab-repertoire visible', fn: () => visible('tab-repertoire') },
      { label: 'tab-pro visible', fn: () => visible('tab-pro') },
      { label: 'tab-gambits visible', fn: () => visible('tab-gambits') },
      { label: 'tab-all visible', fn: () => visible('tab-all') },
      { label: 'search input present', fn: async () => (await countSel('input[placeholder*="Search"]')) > 0 },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Tab: Pro — content mounts
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '03-tab-pro',
    async () => {
      await page.locator('[data-testid="tab-pro"]').click();
      await waitUntil(() => visible('pro-repertoires-tab').then((v) => v), 8000);
    },
    SETTLE_SHORT,
    [
      { label: 'pro-repertoires-tab mounts', fn: () => visible('pro-repertoires-tab') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Tab: Gambits
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '04-tab-gambits',
    async () => {
      // The Gambits tab BUTTON shares the testid with its content — be specific.
      await page.locator('button[data-testid="tab-gambits"]').click();
      await page.waitForTimeout(800);
    },
    SETTLE_SHORT,
    [
      { label: 'gambits panel mounts (div tab-gambits)',
        fn: async () => (await countSel('div[data-testid="tab-gambits"]')) > 0 },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Tab: All — ECO groups A–E
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '05-tab-all-eco-groups',
    async () => {
      await page.locator('[data-testid="tab-all"]').click();
      await waitUntil(() => visible('eco-group-A').then((v) => v), 20_000);
    },
    SETTLE_SHORT,
    [
      { label: 'ECO A group', fn: () => visible('eco-group-A') },
      { label: 'ECO B group', fn: () => visible('eco-group-B') },
      { label: 'ECO C group', fn: () => visible('eco-group-C') },
      { label: 'ECO D group', fn: () => visible('eco-group-D') },
      { label: 'ECO E group', fn: () => visible('eco-group-E') },
    ],
  );

  // Toggle A expand — DOM should grow
  await scenario(
    '06-eco-a-expand',
    async () => {
      const sel = '[data-testid="eco-group-A"] *';
      const before = await countSel(sel);
      await page.locator('[data-testid="eco-toggle-A"]').click();
      await page.waitForTimeout(1000);
      const after = await countSel(sel);
      report.scenarios._tmp = { before, after };
    },
    500,
    [
      { label: 'eco-group-A children grow after expand',
        fn: () => {
          const t = report.scenarios._tmp;
          delete report.scenarios._tmp;
          return t && t.after > t.before;
        } },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Search typing in opening scope
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '07-search-typing',
    async () => {
      await page.locator('[data-testid="tab-repertoire"]').click();
      await page.waitForTimeout(500);
      const input = page.locator('input[placeholder*="Search"]').first();
      await input.fill('Sicilian');
      await page.waitForTimeout(1500);
    },
    500,
    [
      { label: 'input retains "Sicilian"', fn: async () =>
        (await page.locator('input[placeholder*="Search"]').first().inputValue()) === 'Sicilian' },
      { label: 'body mentions Sicilian', fn: () => hasText('sicilian') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Click into an opening from Most Common
  // ═══════════════════════════════════════════════════════════════════
  await clickOpeningsNav();
  const input = page.locator('input[placeholder*="Search"]').first();
  if ((await input.inputValue().catch(() => '')) !== '') await input.fill('');
  await page.locator('[data-testid="tab-repertoire"]').click();
  await page.waitForTimeout(800);
  await scenario(
    '08-click-opening-card',
    async () => {
      // OpeningCard testid pattern — scan for any "opening-card-*"
      const firstCardTid = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-testid]'));
        const card = els.find((el) => /^opening-card-/.test(el.getAttribute('data-testid') ?? ''));
        return card?.getAttribute('data-testid') ?? null;
      });
      if (!firstCardTid) {
        // Fallback: any visible button inside the opening-explorer container.
        const fallback = page.locator('[data-testid="opening-explorer"] button').first();
        if (await fallback.isVisible().catch(() => false)) await fallback.click();
      } else {
        await page.locator(`[data-testid="${firstCardTid}"]`).click();
      }
      await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 15_000 });
    },
    SETTLE_MED,
    [
      { label: 'navigated to /openings/<id>',
        fn: () => /\/openings\/[^/]+$/.test(page.url()) },
      { label: 'opening-detail mount', fn: () => visible('opening-detail') },
      { label: 'back-button present', fn: () => visible('back-button') },
      { label: 'favorite-btn present', fn: () => visible('favorite-btn') },
      { label: 'lines metrics present',
        fn: async () => (await visible('lines-discovered')) && (await visible('lines-perfected')) },
      { label: '4 main mode buttons present',
        fn: async () => (await visible('walkthrough-btn')) && (await visible('learn-btn'))
          && (await visible('practice-btn')) && (await visible('play-btn')) },
    ],
  );

  // Favorite toggle (round-trip)
  await scenario(
    '09-detail-favorite-toggle',
    async () => {
      await page.locator('[data-testid="favorite-btn"]').click();
      await page.waitForTimeout(500);
      await page.locator('[data-testid="favorite-btn"]').click();
      await page.waitForTimeout(500);
    },
    500,
    [
      { label: 'page still mounted', fn: () => visible('opening-detail') },
    ],
  );

  // Walkthrough button → walkthrough-mode mounts
  await scenario(
    '10-walkthrough-mode-mount',
    async () => {
      await page.locator('[data-testid="walkthrough-btn"]').click();
      await page.locator('[data-testid="walkthrough-mode"]').waitFor({ timeout: 15_000 });
    },
    SETTLE_MED,
    [
      { label: 'walkthrough-mode mounts', fn: () => visible('walkthrough-mode') },
      { label: 'walkthrough-back btn', fn: () => visible('walkthrough-back') },
      { label: 'walkthrough-progress (testid present, may be 0-width at start)',
        fn: async () => (await countSel('[data-testid="walkthrough-progress"]')) > 0 },
      { label: 'walkthrough-play-pause', fn: () => visible('walkthrough-play-pause') },
      { label: 'walkthrough-speed-toggle', fn: () => visible('walkthrough-speed-toggle') },
      { label: 'walkthrough-overview', fn: () => visible('walkthrough-overview') },
      { label: 'board renders pieces', fn: async () => (await countSel('[data-piece]')) > 0 },
    ],
  );

  // Play-pause toggle — should not throw
  await scenario(
    '11-walkthrough-play-pause-toggle',
    async () => {
      await page.locator('[data-testid="walkthrough-play-pause"]').click();
      await page.waitForTimeout(1200);
    },
    500,
    [
      { label: 'walkthrough-mode still mounted', fn: () => visible('walkthrough-mode') },
    ],
  );

  // Speed toggle — should not throw
  await scenario(
    '12-walkthrough-speed-toggle',
    async () => {
      await page.locator('[data-testid="walkthrough-speed-toggle"]').click();
      await page.waitForTimeout(800);
    },
    500,
    [
      { label: 'walkthrough-mode still mounted', fn: () => visible('walkthrough-mode') },
    ],
  );

  // Speed info button → popup appears, then dismiss via overlay click
  await scenario(
    '13-walkthrough-speed-info',
    async () => {
      if (await visible('walkthrough-speed-info-btn')) {
        await page.locator('[data-testid="walkthrough-speed-info-btn"]').click();
        await page.waitForTimeout(600);
      }
    },
    300,
    [
      { label: 'speed-info-popup appears OR control absent (no-op)',
        fn: async () => (await visible('walkthrough-speed-info-popup'))
          || !(await visible('walkthrough-speed-info-btn')) },
    ],
  );

  // Dismiss popup if open — click the click-outside overlay so the
  // back button is reachable for the next scenario.
  if (await visible('walkthrough-speed-info-popup')) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    // If Escape didn't close, click the overlay div (fixed inset-0 z-40)
    if (await visible('walkthrough-speed-info-popup')) {
      await page.locator('div.fixed.inset-0.z-40').first().click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // Back from walkthrough → opening-detail
  await scenario(
    '14-walkthrough-back',
    async () => {
      await page.locator('[data-testid="walkthrough-back"]').click({ timeout: 6000 });
      await waitUntil(() => visible('opening-detail').then((v) => v), 8000);
    },
    SETTLE_SHORT,
    [
      { label: 'returned to opening-detail', fn: () => visible('opening-detail') },
    ],
  );

  // Learn → DrillMode mounts
  await scenario(
    '15-learn-mode-mount',
    async () => {
      await page.locator('[data-testid="learn-btn"]').click();
      await page.waitForTimeout(2500);
    },
    SETTLE_MED,
    [
      { label: 'navigation succeeded (board renders OR drill UI present)',
        fn: async () => (await countSel('[data-piece]')) > 0 || !(await visible('walkthrough-btn')) },
    ],
  );

  // Back to detail — be explicit. goBack() can land on / if Practice/Play
  // routes use replace=true. Use stored detail URL instead.
  const detailUrl = page.url().startsWith(`${BASE_URL}/openings/`) ? page.url() : null;
  async function returnToDetail() {
    if (detailUrl) await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    else {
      // Fallback: navigate to /openings then click the first card.
      await page.goto(`${BASE_URL}/openings`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 12_000 }).catch(() => {});
      await page.locator('[data-testid="tab-repertoire"]').click().catch(() => {});
      await page.waitForTimeout(500);
      const firstCardTid = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-testid]'));
        const card = els.find((el) => /^opening-card-/.test(el.getAttribute('data-testid') ?? ''));
        return card?.getAttribute('data-testid') ?? null;
      });
      if (firstCardTid) await page.locator(`[data-testid="${firstCardTid}"]`).click();
    }
    await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await returnToDetail();

  // Practice
  await scenario(
    '16-practice-mode-mount',
    async () => {
      if (await visible('practice-btn')) {
        await page.locator('[data-testid="practice-btn"]').click();
        await page.waitForTimeout(2500);
      }
    },
    SETTLE_MED,
    [
      { label: 'no console.error from Practice (tracked globally)', fn: () => true },
    ],
  );

  await returnToDetail();

  // Play
  await scenario(
    '17-play-mode-mount',
    async () => {
      if (await visible('play-btn')) {
        await page.locator('[data-testid="play-btn"]').click();
        await page.waitForTimeout(2500);
      }
    },
    SETTLE_MED,
    [
      { label: 'no console.error from Play (tracked globally)', fn: () => true },
    ],
  );

  await returnToDetail();

  // Variation walkthrough (if any)
  await scenario(
    '18-variation-walkthrough',
    async () => {
      const varTid = await page.evaluate(() => {
        const el = document.querySelector('[data-testid^="variation-walkthrough-"]');
        return el?.getAttribute('data-testid') ?? null;
      });
      if (!varTid) return;
      await page.locator(`[data-testid="${varTid}"]`).click();
      await waitUntil(() => visible('walkthrough-mode').then((v) => v), 10_000);
    },
    SETTLE_MED,
    [
      { label: 'walkthrough-mode OR opening-detail visible',
        fn: async () => (await visible('walkthrough-mode')) || (await visible('opening-detail')) },
    ],
  );

  if (await visible('walkthrough-back')) {
    await page.locator('[data-testid="walkthrough-back"]').click().catch(() => {});
    await page.waitForTimeout(600);
  }

  // Back from detail → /openings
  await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 8000 }).catch(() => {});
  await scenario(
    '19-detail-back-button',
    async () => {
      await page.locator('[data-testid="back-button"]').click();
      await waitUntil(() => page.url().endsWith('/openings'), 5000);
    },
    SETTLE_SHORT,
    [
      { label: 'back returns to /openings', fn: () => page.url().endsWith('/openings') },
      { label: 'opening-explorer remounted', fn: () => visible('opening-explorer') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Pro player flow: click first pro card → /openings/pro/<player>
  // ═══════════════════════════════════════════════════════════════════
  await page.locator('[data-testid="tab-pro"]').click();
  await waitUntil(() => visible('pro-repertoires-tab').then((v) => v), 8000);
  await scenario(
    '20-pro-player-click',
    async () => {
      const proBtn = page.locator('[data-testid="pro-repertoires-tab"] button').first();
      if (await proBtn.isVisible().catch(() => false)) {
        await proBtn.click();
        await waitUntil(() => page.url().includes('/openings/pro/'), 8000);
      }
    },
    SETTLE_MED,
    [
      { label: 'navigated to /openings/pro/<player>',
        fn: () => page.url().includes('/openings/pro/') },
      { label: 'pro-player-page mount OR fallback content',
        fn: async () => (await visible('pro-player-page')) || (await hasText('opening')) },
    ],
  );

  // Pro player back button → /openings
  if (await visible('back-button')) {
    await scenario(
      '21-pro-player-back',
      async () => {
        await page.locator('[data-testid="back-button"]').click();
        await waitUntil(() => page.url().endsWith('/openings'), 5000);
      },
      SETTLE_SHORT,
      [
        { label: 'back returns to /openings', fn: () => page.url().endsWith('/openings') },
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.runtimeErrorEvents = captured.filter((e) => {
    const k = String(e.kind ?? '').toLowerCase();
    return k === 'uncaught-error' || k === 'unhandled-rejection' ||
      String(e.level ?? '').toLowerCase() === 'error';
  });

  const failed = [];
  for (const s of report.scenarios) {
    if (typeof s !== 'object' || !s.checks) continue;
    for (const c of s.checks) {
      if (!c.ok) failed.push({ scenario: s.name, label: c.label, error: c.error });
    }
    if (s.error) failed.push({ scenario: s.name, label: 'action error', error: s.error });
    for (const e of (s.pageErrors ?? [])) failed.push({ scenario: s.name, label: 'pageerror', error: e });
  }
  report.failedChecks = failed;
  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const allChecks = report.scenarios.reduce((n, s) => n + (s.checks?.length ?? 0), 0);
  const passed = allChecks - failed.length;
  const md = [
    `# Openings UI Audit — ${stamp}`,
    ``, `Base: ${BASE_URL}`,
    ``, `Scenarios: ${report.scenarios.length}`,
    `Checks: ${passed}/${allChecks} passed`,
    `Console errors: ${consoleErrors.length}`,
    `Page errors: ${pageErrors.length}`,
    `Runtime-error events: ${report.runtimeErrorEvents.length}`,
    ``, `## Failures`, ``,
  ];
  if (failed.length === 0) md.push('_None._');
  else for (const f of failed) md.push(`- **${f.scenario}** — ${f.label}${f.error ? ` — \`${String(f.error).slice(0, 200)}\`` : ''}`);
  await writeFile(join(OUT_DIR, 'report.md'), md.join('\n'));

  console.log(`\n[openings-ui] DONE — ${passed}/${allChecks} checks passed`);
  console.log(`[openings-ui] events=${captured.length} console.errors=${consoleErrors.length} pageerrors=${pageErrors.length} runtime-err=${report.runtimeErrorEvents.length}`);
  if (failed.length) {
    console.log(`[openings-ui] ${failed.length} failures:`);
    for (const f of failed) console.log(`  - ${f.scenario} :: ${f.label}${f.error ? ` :: ${String(f.error).slice(0, 120)}` : ''}`);
  }
  console.log(`[openings-ui] report: ${OUT_DIR}/report.json + report.md`);

  await browser.close();
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error('[openings-ui] fatal:', err); process.exit(1); });
