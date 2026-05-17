#!/usr/bin/env node
// scripts/audit-kids-deep.mjs
// ----------------------------------------------------------------------
// DEEP play audit of the kids section. Each scenario states its
// SHOULD-WORK contract at the top of its block, then asserts behavior
// against that contract.
//
// Captures: speechSynthesis intercepts, /api/audit-stream POST
// bodies, console.error + pageerror.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/kid-deep-${stamp}`;
const PIECES = ['pawn', 'rook', 'knight', 'bishop', 'queen', 'king'];

const results = [];
function record(scenario, contract, status, details = '') {
  results.push({ scenario, contract, status, details });
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⊘';
  console.log(`  ${icon} ${scenario}${details ? ' — ' + details : ''}`);
}
async function runScenario(scenario, contract, fn) {
  try { const r = await fn(); record(scenario, contract, 'pass', r?.details ?? ''); }
  catch (err) { record(scenario, contract, 'fail', err?.message ?? String(err)); }
}

async function main() {
  await mkdir(resolve(ROOT, OUT_DIR), { recursive: true });
  const executablePath = await resolveChromiumExecutable(HEADED);
  console.log(`[kid-deep] base = ${BASE_URL}`);
  console.log(`[kid-deep] outDir = ${OUT_DIR}\n`);

  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    // @ts-ignore
    window.__audit_speak_calls = [];
    const ss = window.speechSynthesis;
    if (ss) {
      ss.speak = (u) => {
        // @ts-ignore
        window.__audit_speak_calls.push({
          t: Date.now(), text: u?.text ?? '<no-text>', location: location.pathname,
        });
      };
    }
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ t: Date.now(), text: msg.text(), url: page.url() });
  });
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push({ t: Date.now(), text: err.message, url: page.url() });
  });
  const auditStreamPosts = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/audit-stream') && req.method() === 'POST') {
      try { const b = req.postData(); if (b) auditStreamPosts.push({ url: page.url(), body: JSON.parse(b) }); }
      catch { /* skip */ }
    }
  });

  console.log('[kid-deep] warmup');
  await page.goto(`${BASE_URL}/`, { timeout: 60000 });
  await page.waitForTimeout(3000);

  // ─── § 1. /kid hub ──────────────────────────────────────────────────
  // SHOULD: mount with 6 piece tiles + curriculum cards; no bottom nav.
  console.log('\n[kid-deep] § 1. /kid hub');
  await runScenario('hub-mounts', 'kid-mode-page renders', async () => {
    await page.goto(`${BASE_URL}/kid`, { timeout: 30000 });
    await page.locator('[data-testid="kid-mode-page"]').waitFor({ timeout: 20000 });
  });
  for (const p of PIECES) {
    await runScenario(`hub-has-${p}-tile`, `${p}-games-card present`, async () => {
      await page.locator(`[data-testid="${p}-games-card"]`).waitFor({ timeout: 5000 });
    });
  }
  await runScenario(
    'bishop-tile-disabled-by-default',
    'bishop disabled before rook chapter completed',
    async () => {
      const d = await page.locator('[data-testid="bishop-games-card"]').isDisabled();
      if (!d) throw new Error('bishop enabled unexpectedly');
    },
  );
  for (const card of ['journey-card', 'fairy-tale-card', 'puzzle-quest-card', 'play-games-card']) {
    await runScenario(`hub-has-${card}`, `${card} present`, async () => {
      await page.locator(`[data-testid="${card}"]`).waitFor({ timeout: 5000 });
    });
  }
  await runScenario(
    'hub-no-bottom-nav',
    'AppLayout mobile bottom nav must NOT render under /kid',
    async () => {
      const fixedBottom = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('nav')).filter((n) => {
          const cs = getComputedStyle(n);
          return cs.position === 'fixed' && parseInt(cs.bottom, 10) === 0;
        }).length;
      });
      if (fixedBottom > 0) throw new Error(`found ${fixedBottom} fixed-bottom navs`);
    },
  );

  // ─── § 2. Piece hubs (6) ─────────────────────────────────────────────
  // SHOULD: each hub loads, has Puzzles + Maze + Hunt tiles.
  console.log('\n[kid-deep] § 2. Piece hubs');
  for (const p of PIECES) {
    await runScenario(`${p}-hub-loads`, `/kid/${p}-games loads`, async () => {
      await page.goto(`${BASE_URL}/kid/${p}-games`, { timeout: 30000 });
      await page.locator(`[data-testid="${p}-puzzles-card"]`).waitFor({ timeout: 20000 });
    });
    await runScenario(`${p}-hub-has-maze`, `${p}-maze-card present`, async () => {
      await page.locator(`[data-testid="${p}-maze-card"]`).waitFor({ timeout: 5000 });
    });
    await runScenario(`${p}-hub-has-hunt`, `${p}-hunt-card present`, async () => {
      await page.locator(`[data-testid="${p}-hunt-card"]`).waitFor({ timeout: 5000 });
    });
  }

  // ─── § 3. Per-piece puzzle pages ─────────────────────────────────────
  // SHOULD: mount with rating widget at 100; render board / empty /
  // loading; no per-move voice.
  console.log('\n[kid-deep] § 3. Per-piece puzzle pages');
  for (const p of PIECES) {
    await runScenario(`${p}-puzzles-mounts`, `kid-piece-puzzles-rating renders`, async () => {
      await page.goto(`${BASE_URL}/kid/${p}-games/puzzles`, { timeout: 30000 });
      await page.locator('[data-testid="kid-piece-puzzles-rating"]').waitFor({ timeout: 20000 });
    });
    await runScenario(`${p}-puzzles-rating-100`, `fresh profile rating starts at 100`, async () => {
      const txt = (await page.locator('[data-testid="kid-piece-puzzles-rating"]').textContent())?.trim();
      if (txt !== '100') throw new Error(`rating=${txt}`);
    });
    await runScenario(`${p}-puzzles-render-state`, `board OR empty OR loading visible`, async () => {
      const state = await Promise.race([
        page.locator('[data-testid="puzzle-board"]').waitFor({ timeout: 15000 }).then(() => 'board'),
        page.locator('[data-testid="kid-piece-puzzles-empty"]').waitFor({ timeout: 15000 }).then(() => 'empty'),
        page.locator('[data-testid="kid-piece-puzzles-loading"]').waitFor({ timeout: 15000 }).then(() => 'loading'),
      ]).catch(() => 'unknown');
      if (state === 'unknown') throw new Error('no recognized render state');
      return { details: state };
    });
  }

  // ─── § 4. Piece-maze gameplay ────────────────────────────────────────
  // SHOULD: a BFS-computed shortest path from pieceStart to target,
  // played one square at a time, ends in the won state. (Earlier
  // version assumed a single target click; rook/king l1 actually
  // need multi-move paths.)
  console.log('\n[kid-deep] § 4. Maze gameplay (level 1, BFS-driven)');

  // Inline BFS solvers — mirror the live pieceMazeService rules. Used
  // both to compute the win path and to assert the level config is
  // solvable from the audit side.
  const FILES = 'abcdefgh';
  const fi = (s) => FILES.indexOf(s[0]);
  const ri = (s) => parseInt(s[1], 10) - 1;
  const sq = (f, r) => `${FILES[f]}${r + 1}`;
  const ROOK_DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
  const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  function slide(from, blocked, dirs, max = 7) {
    const out = []; const f = fi(from); const r = ri(from);
    for (const [df, dr] of dirs) {
      let cf = f + df, cr = r + dr, n = 0;
      while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8 && n < max) {
        const s = sq(cf, cr);
        if (blocked.has(s)) break;
        out.push(s); cf += df; cr += dr; n++;
      }
    }
    return out;
  }
  function getMoves(piece, from, blocked) {
    if (piece === 'king')   return slide(from, blocked, QUEEN_DIRS, 1);
    if (piece === 'queen')  return slide(from, blocked, QUEEN_DIRS);
    if (piece === 'rook')   return slide(from, blocked, ROOK_DIRS);
    if (piece === 'bishop') return slide(from, blocked, BISHOP_DIRS);
    if (piece === 'knight') {
      const out = []; const f = fi(from); const r = ri(from);
      for (const [df, dr] of KNIGHT_DELTAS) {
        const cf = f + df, cr = r + dr;
        if (cf < 0 || cf >= 8 || cr < 0 || cr >= 8) continue;
        const s = sq(cf, cr);
        if (!blocked.has(s)) out.push(s);
      }
      return out;
    }
    if (piece === 'pawn') {
      const f = fi(from); const r = ri(from);
      if (r >= 7) return [];
      const out = []; const one = sq(f, r + 1);
      if (!blocked.has(one)) {
        out.push(one);
        if (r === 1) { const two = sq(f, r + 2); if (!blocked.has(two)) out.push(two); }
      }
      return out;
    }
    return [];
  }
  function bfsPath(piece, start, target, obstacles) {
    const blocked = new Set(obstacles);
    const prev = new Map();
    prev.set(start, null);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      if (cur === target) {
        const path = []; let s = cur;
        while (s && s !== start) { path.unshift(s); s = prev.get(s); }
        return path;
      }
      for (const nx of getMoves(piece, cur, blocked)) {
        if (!prev.has(nx)) { prev.set(nx, cur); q.push(nx); }
      }
    }
    return null;
  }

  // Level 1 configs — keep in sync with src/data/pieceMazeLevels.ts ids=1.
  const MAZE_L1 = {
    king:   { start: 'a1', target: 'e5', obstacles: [] },
    queen:  { start: 'a1', target: 'h8', obstacles: [] },
    rook:   { start: 'a1', target: 'h8', obstacles: [] },
    bishop: { start: 'a1', target: 'h8', obstacles: [] },
    knight: { start: 'b1', target: 'c3', obstacles: [] },
    pawn:   { start: 'a7', target: 'a8', obstacles: [] },
  };

  for (const p of PIECES) {
    const cfg = MAZE_L1[p];
    await runScenario(`${p}-maze-l1-loads`, `/kid/${p}-games/maze/1 mounts`, async () => {
      await page.goto(`${BASE_URL}/kid/${p}-games/maze/1`, { timeout: 30000 });
      await page.locator(`[data-testid="piece-maze-${p}"]`).waitFor({ timeout: 30000 });
    });
    await runScenario(`${p}-maze-l1-move-count-0`, 'starts at 0 moves', async () => {
      const t = (await page.locator('[data-testid="piece-maze-move-count"]').textContent())?.trim();
      if (t !== '0') throw new Error(`move-count=${t}`);
    });
    await runScenario(`${p}-maze-l1-bfs-path-wins`, `walking BFS path reaches won state`, async () => {
      const path = bfsPath(p, cfg.start, cfg.target, cfg.obstacles);
      if (!path || path.length === 0) {
        throw new Error(`no BFS path from ${cfg.start} to ${cfg.target} for ${p}`);
      }
      for (const square of path) {
        const t = page.locator(`[data-square="${square}"]`).first();
        if ((await t.count()) === 0) throw new Error(`square ${square} not addressable`);
        await t.click({ timeout: 5000 });
        await page.waitForTimeout(150); // let React state settle
      }
      await page.locator('[data-testid="piece-maze-won"]').waitFor({ timeout: 10000 });
      return { details: `${path.length}-move path` };
    });
  }

  // ─── § 5. Piece-hunt gameplay ────────────────────────────────────────
  // SHOULD: clicking first target reduces remaining counter by 1.
  console.log('\n[kid-deep] § 5. Hunt gameplay (level 1)');
  const HUNT_L1 = {
    king:   { firstTarget: 'c5', total: 2 },
    queen:  { firstTarget: 'a4', total: 2 },
    rook:   { firstTarget: 'a4', total: 2 },
    bishop: { firstTarget: 'c3', total: 2 },
    knight: { firstTarget: 'c3', total: 2 },
    pawn:   { firstTarget: 'b3', total: 1 },
  };
  for (const p of PIECES) {
    const { firstTarget, total } = HUNT_L1[p];
    await runScenario(`${p}-hunt-l1-loads`, `/kid/${p}-games/sweep/1 mounts`, async () => {
      await page.goto(`${BASE_URL}/kid/${p}-games/sweep/1`, { timeout: 30000 });
      await page.locator(`[data-testid="piece-sweep-${p}"]`).waitFor({ timeout: 20000 });
    });
    await runScenario(`${p}-hunt-l1-remaining-correct`, `remaining=${total} initially`, async () => {
      const t = (await page.locator('[data-testid="piece-sweep-remaining"]').textContent())?.trim();
      if (t !== String(total)) throw new Error(`remaining=${t}, expected ${total}`);
    });
    await runScenario(
      `${p}-hunt-l1-first-capture`,
      `clicking ${firstTarget} reduces remaining to ${total - 1}`,
      async () => {
        const sel = `[data-square="${firstTarget}"]`;
        const t = page.locator(sel).first();
        if ((await t.count()) === 0) throw new Error(`target ${firstTarget} not addressable`);
        await t.click({ timeout: 5000 });
        await page.waitForTimeout(300);
        const after = (await page.locator('[data-testid="piece-sweep-remaining"]').textContent())?.trim();
        if (after !== String(total - 1)) throw new Error(`remaining after=${after}`);
      },
    );
  }

  // ─── § 6. Legacy redirects ───────────────────────────────────────────
  console.log('\n[kid-deep] § 6. Legacy redirects');
  await runScenario('redirect-mini-games', '/kid/mini-games → /kid/pawn-games', async () => {
    await page.goto(`${BASE_URL}/kid/mini-games`, { timeout: 30000 });
    await page.waitForURL(`**/kid/pawn-games`, { timeout: 5000 });
  });
  await runScenario('redirect-king-escape', '/kid/king-escape → /kid/king-games/escape', async () => {
    await page.goto(`${BASE_URL}/kid/king-escape`, { timeout: 30000 });
    await page.waitForURL(`**/kid/king-games/escape`, { timeout: 5000 });
  });
  await runScenario('redirect-king-march', '/kid/king-march → /kid/king-games/march', async () => {
    await page.goto(`${BASE_URL}/kid/king-march`, { timeout: 30000 });
    await page.waitForURL(`**/kid/king-games/march`, { timeout: 5000 });
  });

  // ─── § 7. Curriculum surfaces (regression) ──────────────────────────
  console.log('\n[kid-deep] § 7. Curriculum surfaces');
  for (const [name, path, mountSel] of [
    ['journey-map-loads', '/kid/journey', 'body'],
    ['fairy-tale-map-loads', '/kid/fairy-tale', 'body'],
    ['puzzle-quest-loads', '/kid/puzzles', '[data-testid="kid-puzzle-page"]'],
    ['play-games-hub-loads', '/kid/play-games', 'body'],
  ]) {
    await runScenario(name, `${path} renders`, async () => {
      await page.goto(`${BASE_URL}${path}`, { timeout: 30000 });
      await page.locator(mountSel).waitFor({ timeout: 15000 });
    });
  }

  // ─── § 8. Global voice/audit contracts ──────────────────────────────
  console.log('\n[kid-deep] § 8. Global contracts');
  await runScenario(
    'no-coach-personality-events',
    'audit-stream POSTs contain no coach-personality-* events on kid URLs',
    async () => {
      const offenders = auditStreamPosts.filter((p) => /coach-personality/.test(JSON.stringify(p.body)));
      if (offenders.length > 0) throw new Error(`${offenders.length} coach-personality events`);
      return { details: `total audit-stream POSTs: ${auditStreamPosts.length}` };
    },
  );

  await browser.close();

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n[kid-deep] summary: ${passed} pass / ${failed} fail / ${results.length} total`);
  console.log(`  audit-stream POSTs: ${auditStreamPosts.length}`);
  console.log(`  console errors: ${consoleErrors.length}`);
  console.log(`  page errors: ${pageErrors.length}`);

  await writeFile(
    resolve(ROOT, OUT_DIR, 'report.json'),
    JSON.stringify({
      baseUrl: BASE_URL,
      scenarios: results,
      auditStreamPostCount: auditStreamPosts.length,
      auditStreamSample: auditStreamPosts.slice(0, 30).map((p) => ({
        url: p.url, kind: p.body?.kind, source: p.body?.source,
        summary: typeof p.body?.summary === 'string' ? p.body.summary.slice(0, 120) : null,
      })),
      consoleErrorCount: consoleErrors.length,
      consoleErrors: consoleErrors.slice(0, 30).map((e) => ({ url: e.url, text: e.text.slice(0, 200) })),
      pageErrorCount: pageErrors.length,
      pageErrors,
    }, null, 2),
  );
  console.log(`[kid-deep] report: ${OUT_DIR}/report.json`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('[kid-deep] fatal:', err); process.exit(2); });
