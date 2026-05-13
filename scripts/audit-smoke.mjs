#!/usr/bin/env node
/**
 * Audit-smoke v2 — drives the live deployed app once (boot ←,
 * navigate SPA-style by clicking the bottom nav + tiles, no
 * page reloads), enables audit streaming via localStorage on the
 * headless browser, and intercepts outgoing audit POSTs to
 * summarize what fired per surface.
 *
 * Usage:
 *   node scripts/audit-smoke.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-smoke.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-smoke.mjs    # show browser
 *
 * Events are captured from the browser's outgoing network requests
 * rather than by polling /api/audit-stream — that way we don't
 * depend on Vercel function-instance coherency and we get the
 * exact payload the page tried to push.
 *
 * Output: audit-reports/smoke-<iso>/{<surface>.png, report.json}.
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
const OUT_DIR = `audit-reports/smoke-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SURFACE_SETTLE_MS = 4500;
const TEACH_SETTLE_MS = 10_000; // walkthrough surface needs more

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[smoke] base    = ${BASE_URL}`);
  console.log(`[smoke] stream  = ${STREAM_URL}`);
  console.log(`[smoke] outDir  = ${OUT_DIR}`);
  console.log(`[smoke] headed  = ${HEADED}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditSmokeBot/1.0 (chromium)',
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

  async function record(name, action, settleMs = SURFACE_SETTLE_MS) {
    const before = captured.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    let err = null;
    try {
      await action();
      await page.waitForTimeout(settleMs);
    } catch (e) {
      err = String(e?.message ?? e);
      console.log(`  [error] ${err}`);
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
    console.log(`\n[smoke] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);
    report.surfaces.push({
      name,
      url,
      durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kindCounts,
      screenshot: screenshotPath,
      consoleErrors: newConsole,
      pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      error: err,
    });
  }

  // 1. Boot once at /
  await record(
    'dashboard',
    async () => {
      await page.goto(`${BASE_URL}/`, {
        waitUntil: 'domcontentloaded',
        timeout: BOOT_TIMEOUT_MS,
      });
      await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
    },
    6000,
  );

  // 2. SPA navigate via bottom-nav clicks
  await record('openings-tab', async () => {
    await page.getByRole('link', { name: 'Openings' }).first().click();
  });

  await record('coach-home', async () => {
    await page.getByRole('link', { name: 'Coach' }).first().click();
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15_000 });
  });

  // 3. Drill into Learn-with-Coach tile (the walkthrough surface)
  await record(
    'coach-teach',
    async () => {
      await page.locator('[data-testid="coach-action-teach"]').click();
    },
    TEACH_SETTLE_MS,
  );

  // 4. Back to coach hub, then into Play-with-Coach
  await record('coach-home-2', async () => {
    await page.goBack();
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15_000 });
  });

  await record(
    'coach-play',
    async () => {
      await page.locator('[data-testid="coach-action-play"]').click();
    },
    TEACH_SETTLE_MS,
  );

  // 5. Tactics tab
  await record('tactics', async () => {
    await page.getByRole('link', { name: 'Tactics' }).first().click();
  });

  // 6. Weaknesses tab
  await record('weaknesses', async () => {
    await page.getByRole('link', { name: 'Weaknesses' }).first().click();
  });

  // 7. Back to home — exercise round-trip nav
  await record('home-return', async () => {
    await page.getByRole('link', { name: 'Home' }).first().click();
  });

  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[smoke] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  console.log(`[smoke] report: ${OUT_DIR}/report.json`);

  await browser.close();
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
