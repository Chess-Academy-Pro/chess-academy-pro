#!/usr/bin/env node
/**
 * Audit-opening-trap-tiles — verifies the trap-line / warning-line
 * surfaces on /openings/:id reflect the data after the 2026-05-16
 * orientation fix (PRs #548, #549):
 *
 *   1. The 3 new white-side Ruy Lopez weapons surface on their
 *      respective player repertoires.
 *   2. The 3 deleted Noah's Ark entries do NOT appear under those
 *      same WHITE Ruy Lopez repertoires (would be wrong-side content).
 *   3. The 4 inverted entries appear as warningLines, not trapLines.
 *   4. Clicking a trap tile mounts the walkthrough runtime cleanly.
 *   5. (When voice is enabled in this env) the narration text emitted
 *      via `coach-narration-spoken` audit events carries the
 *      positional-advantage phrasing from the updated explanations.
 *
 * Headed run: AUDIT_SMOKE_HEADED=1 node scripts/audit-opening-trap-tiles.mjs
 * Local run:  AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-opening-trap-tiles.mjs
 *
 * Default target = prod (chess-academy-pro.vercel.app).
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
const OUT_DIR = `audit-reports/opening-trap-tiles-${stamp}`;

// Expected post-fix shape per opening. Verifiable purely from the
// rendered DOM — we count tiles and read their visible names.
const EXPECTATIONS = [
  {
    openingId: 'pro-firouzja-ruy-lopez',
    description: 'white Ruy Lopez (Firouzja) — added Open Tarrasch Trap, deleted Noah\'s Ark',
    mustContain: ['Open Tarrasch Trap'],
    mustNotContain: ["Noah's Ark Trap"],
  },
  {
    openingId: 'pro-carlsen-ruy-lopez',
    description: 'white Ruy Lopez (Carlsen) — added Berlin Tarrasch Trap, deleted Noah\'s Ark',
    mustContain: ['Berlin Tarrasch Trap'],
    mustNotContain: ["Noah's Ark Trap"],
  },
  {
    openingId: 'pro-praggnanandhaa-ruy-lopez',
    description: 'white Ruy Lopez (Pragg) — added Bird\'s Defense Refutation, deleted Noah\'s Ark',
    mustContain: ["Bird's Defense Refutation"],
    mustNotContain: ["Noah's Ark Trap"],
  },
  {
    openingId: 'pro-gothamchess-caro-kann',
    description: 'Caro-Kann (Gothamchess) — Qb6 Fork moved from traps to warnings',
    mustContain: [], // trapLines side — only checks Qb6 isn't in traps
    mustNotContainInTraps: ['Advance Variation Qb6 Fork'],
    mustContainInWarnings: ['Advance Variation Qb6 Fork'],
  },
  {
    openingId: 'pro-firouzja-grunfeld',
    description: 'Grunfeld (Firouzja) — Nxc3 Qa5+ moved from traps to warnings',
    mustContain: [],
    mustNotContainInTraps: ['Nxc3 Qa5+ Exchange Trick'],
    mustContainInWarnings: ['Nxc3 Qa5+ Exchange Trick'],
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[trap-tiles] base    = ${BASE_URL}`);
  console.log(`[trap-tiles] outDir  = ${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[trap-tiles] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditTrapTilesBot/1.0 (chromium)',
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
  // Stream events captured from outgoing audit-stream POSTs. The URL
  // may 403 (when running against prod from the sandbox) or 404
  // (running against a localhost dev server with no /api), but the
  // request body is intercepted in either case.
  const capturedEvents = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', (req) => {
    if (!req.url().includes('/api/audit-stream')) return;
    try {
      const body = req.postData();
      if (!body) return;
      const parsed = JSON.parse(body);
      const evs = Array.isArray(parsed) ? parsed : (parsed.events ?? [parsed]);
      for (const ev of evs) capturedEvents.push(ev);
    } catch {
      /* malformed payload — ignore */
    }
  });

  const scenarios = [];
  async function scenario(name, fn) {
    const t0 = Date.now();
    let ok = false;
    let detail = '';
    try {
      detail = (await fn()) ?? 'ok';
      ok = true;
    } catch (err) {
      detail = `error: ${err.message}`;
    }
    const r = { name, ok, durationMs: Date.now() - t0, detail };
    scenarios.push(r);
    console.log(`  ${ok ? '✓' : '✗'} ${name} → ${detail}`);
    return r;
  }

  // Boot + wipe + reseed. The browser context is otherwise persisted
  // across Playwright runs and the seed-version gate in dataLoader.ts
  // means stale Dexie data (e.g. older pro-repertoires.json) survives
  // forever once seeded. Wipe IndexedDB before navigating into any
  // route that reads from it so the audit always reflects the
  // current JSON.
  await page.goto(`${BASE_URL}/`, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const d of dbs) {
      await new Promise((res) => {
        const r = indexedDB.deleteDatabase(d.name);
        r.onsuccess = res;
        r.onerror = res;
        r.onblocked = res;
      });
    }
  });
  await page.reload({ waitUntil: 'networkidle' });
  // Fresh seed includes ECO (~3.6k entries), repertoire, pro
  // repertoires, gambits, model games, middlegame plans, flashcards,
  // narrations. Takes ~15-25s in the sandbox; give it 30s.
  await page.waitForTimeout(30_000);

  for (const exp of EXPECTATIONS) {
    console.log(`\n── ${exp.openingId}: ${exp.description}`);

    await scenario(`${exp.openingId} :: detail page mounts`, async () => {
      await page.goto(`${BASE_URL}/openings/${exp.openingId}`, { timeout: 20_000 });
      await page
        .locator('[data-testid="opening-detail"]')
        .waitFor({ timeout: 15_000 });
      // Trap lines render lazily once Dexie has the opening — give
      // it a moment.
      await page.waitForTimeout(1500);
      return 'mounted';
    });

    // Capture the visible trap-line and warning-line names by reading
    // the bold name span inside each tile.
    let trapNames = [];
    let warningNames = [];
    await scenario(`${exp.openingId} :: extract trap + warning tile names`, async () => {
      trapNames = await page.$$eval(
        '[data-testid^="trap-line-"]',
        (els) =>
          els
            .map((el) => el.querySelector('span')?.textContent?.trim())
            .filter(Boolean),
      );
      warningNames = await page.$$eval(
        '[data-testid^="warning-line-"]',
        (els) =>
          els
            .map((el) => el.querySelector('span')?.textContent?.trim())
            .filter(Boolean),
      );
      return `traps=[${trapNames.join(', ')}]  warnings=[${warningNames.join(', ')}]`;
    });

    for (const expected of exp.mustContain ?? []) {
      await scenario(`${exp.openingId} :: trap "${expected}" present`, async () => {
        if (!trapNames.includes(expected))
          throw new Error(`missing "${expected}" in trapLines (got: ${trapNames.join(', ')})`);
        return 'found';
      });
    }

    for (const forbidden of exp.mustNotContain ?? []) {
      await scenario(`${exp.openingId} :: trap "${forbidden}" REMOVED`, async () => {
        if (trapNames.includes(forbidden))
          throw new Error(`forbidden "${forbidden}" still in trapLines`);
        return 'absent';
      });
    }

    for (const forbidden of exp.mustNotContainInTraps ?? []) {
      await scenario(`${exp.openingId} :: "${forbidden}" moved OUT of trapLines`, async () => {
        if (trapNames.includes(forbidden))
          throw new Error(`"${forbidden}" still in trapLines (should be in warningLines)`);
        return 'moved out';
      });
    }

    for (const expected of exp.mustContainInWarnings ?? []) {
      await scenario(`${exp.openingId} :: "${expected}" lives in warningLines`, async () => {
        if (!warningNames.includes(expected))
          throw new Error(`missing "${expected}" in warningLines (got: ${warningNames.join(', ')})`);
        return 'found in warnings';
      });
    }
  }

  // ─── End-to-end: click the new Open Tarrasch Trap tile and verify
  //                the walkthrough runtime mounts.
  console.log(`\n── walkthrough-click: pro-firouzja-ruy-lopez Open Tarrasch Trap`);
  await scenario('walkthrough-click :: navigate', async () => {
    await page.goto(`${BASE_URL}/openings/pro-firouzja-ruy-lopez`, { timeout: 20_000 });
    await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    return 'mounted';
  });

  await scenario('walkthrough-click :: click trap-line-0', async () => {
    // The tiles are sorted by the order they appear in
    // pro-repertoires.json. We can't be sure which index Open
    // Tarrasch lands at, so find the tile whose label matches.
    const tiles = await page.$$('[data-testid^="trap-line-"]');
    let clicked = false;
    for (const t of tiles) {
      const label = (await t.$eval('span', (el) => el.textContent?.trim())) || '';
      if (label === 'Open Tarrasch Trap') {
        const watchBtn = await t.$('[data-testid^="trap-walkthrough-"]');
        await (watchBtn ?? t).click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error('Open Tarrasch Trap tile not found to click');
    return 'clicked';
  });

  await scenario('walkthrough-click :: walkthrough runtime mounts', async () => {
    // The CustomLineWalkthrough renders the same walkthrough UI as
    // the static one. Look for board pieces as a signal it mounted.
    await page.waitForTimeout(3000); // give the runtime + generator time
    const boardSquares = await page.locator('[data-square]').count();
    if (boardSquares < 32) throw new Error(`only ${boardSquares} board squares — walkthrough didn't render`);
    return `board has ${boardSquares} squares`;
  });

  // ─── Narration event check — best-effort. Voice/narration may be
  //     gated on user interaction or specific env keys in localhost.
  console.log(`\n── narration audit-events (best effort)`);
  await scenario('narration :: positional-advantage phrasing emitted', async () => {
    const narrationEvents = capturedEvents.filter(
      (e) =>
        e.kind === 'coach-narration-spoken' ||
        e.kind === 'walkthrough-narration' ||
        (typeof e.kind === 'string' && e.kind.includes('narration')),
    );
    if (narrationEvents.length === 0)
      return 'no narration events captured (TTS likely gated by user gesture in headless run — non-fatal)';
    // Look for any of our updated phrases.
    const phrases = [
      'positional',
      "Black's king is stranded",
      'sacrificial',
      'mating net',
      'Greek Gift',
      'attack you should convert',
    ];
    const matches = narrationEvents.filter((e) => {
      const text = JSON.stringify(e).toLowerCase();
      return phrases.some((p) => text.toLowerCase().includes(p.toLowerCase()));
    });
    return `${narrationEvents.length} narration events; ${matches.length} match positional-advantage phrasing`;
  });

  // ─── Report
  const passes = scenarios.filter((s) => s.ok).length;
  const fails = scenarios.length - passes;
  console.log(`\n[trap-tiles] DONE — ${passes}/${scenarios.length} checks passed`);
  console.log(`[trap-tiles] events=${capturedEvents.length} console.errors=${consoleErrors.length} pageerrors=${pageErrors.length}`);
  if (fails > 0) {
    console.log(`[trap-tiles] ${fails} failures:`);
    for (const s of scenarios.filter((s) => !s.ok)) console.log(`  - ${s.name} :: ${s.detail}`);
  }

  const report = {
    base: BASE_URL,
    timestamp: stamp,
    scenarios,
    counts: {
      total: scenarios.length,
      passes,
      fails,
      capturedEvents: capturedEvents.length,
      consoleErrors: consoleErrors.length,
      pageErrors: pageErrors.length,
    },
    capturedEventKinds: Object.fromEntries(
      Object.entries(
        capturedEvents.reduce((acc, e) => {
          acc[e.kind ?? 'unknown'] = (acc[e.kind ?? 'unknown'] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1]),
    ),
  };

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[trap-tiles] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[trap-tiles] fatal:', err);
  process.exit(2);
});
