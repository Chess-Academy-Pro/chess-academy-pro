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
  // 9b. Opening Traps — DEEP flow: hub tile → puzzle → reveal →
  //     Play-it-out. Catches the Play-it-out side-flip bug: ODD-length
  //     curated solutions land in the playout with the OPPONENT to
  //     move; pre-fix the hook re-derived studentSide from the FEN and
  //     Stockfish then played the student's actual color when it
  //     kicked in. Audit clicks through and verifies orientation +
  //     whose-color-moved after Stockfish responds.
  // ───────────────────────────────────────────────────────────────────

  // Helper: read each rendered piece into a square→piece map. Uses
  // the chessboard's `data-square` + `data-piece` (set by react-
  // chessboard for every visible piece). Returns null if the board
  // hasn't rendered pieces yet.
  async function readBoardState() {
    return await page.evaluate(() => {
      const squares = document.querySelectorAll('[data-square]');
      const out = {};
      for (const sq of squares) {
        const square = sq.getAttribute('data-square');
        if (!square) continue;
        const piece = sq.querySelector('[data-piece]');
        out[square] = piece?.getAttribute('data-piece') ?? null;
      }
      return out;
    });
  }

  // Read whether a1 is in the bottom half of the board (white at
  // bottom) or the top half (black at bottom).
  async function readOrientation() {
    return await page.evaluate(() => {
      const a1 = document.querySelector('[data-square="a1"]');
      const h8 = document.querySelector('[data-square="h8"]');
      if (!a1 || !h8) return null;
      const a = a1.getBoundingClientRect();
      const h = h8.getBoundingClientRect();
      // If a1.top > h8.top, a1 is BELOW h8 → white at bottom (normal).
      // If a1.top < h8.top, a1 is ABOVE h8 → black at bottom (flipped).
      if (a.top > h.top) return 'white-bottom';
      if (a.top < h.top) return 'black-bottom';
      return 'unknown';
    });
  }

  await record(
    'tactics-opening-traps-hub',
    async () => {
      await page.locator('[data-testid="section-opening traps"]').click();
      await page.locator('[data-testid="opening-blunders-page"]').waitFor({ timeout: 15_000 });
    },
    3500,
    [
      { label: 'route is /tactics/opening-traps', fn: () => page.url().endsWith('/tactics/opening-traps') },
      { label: 'opening-blunders-page mounts', fn: () => visible('opening-blunders-page') },
      { label: 'phase tabs render', fn: async () => (await page.locator('[data-testid^="opening-blunder-phase-"]').count()) >= 4 },
      { label: 'at least one family tile renders', fn: async () => (await page.locator('[data-testid^="opening-blunder-family-"]').count()) > 0 },
    ],
  );

  // Click first family → first color → first puzzle
  await record(
    'tactics-opening-traps-puzzle',
    async () => {
      const firstFamily = page.locator('[data-testid^="opening-blunder-family-"]').first();
      await firstFamily.click({ timeout: 5_000 });
      await page.waitForTimeout(800);
      const firstColor = page.locator('[data-testid^="opening-blunder-color-"]').first();
      if (await firstColor.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstColor.click();
        await page.waitForTimeout(600);
      }
      const puzzleTile = page
        .locator('[data-testid^="opening-blunder-"]')
        .filter({ hasNotText: 'Opening' })
        .filter({ hasNotText: 'Transition' })
        .filter({ hasNotText: 'Middlegame' });
      // Skip phase/family/color tiles by data-testid prefix exclusion
      const puzzles = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('[data-testid^="opening-blunder-"]'));
        return all
          .map((el) => el.getAttribute('data-testid'))
          .filter((tid) =>
            tid &&
            !tid.startsWith('opening-blunder-phase-') &&
            !tid.startsWith('opening-blunder-family-') &&
            !tid.startsWith('opening-blunder-color-') &&
            tid !== 'opening-blunder-play-out' &&
            tid !== 'opening-blunder-show-opening' &&
            tid !== 'opening-blunder-hint' &&
            tid !== 'opening-blunder-reveal' &&
            tid !== 'opening-blunder-next' &&
            tid !== 'opening-blunders-page',
          );
      });
      if (puzzles.length === 0) throw new Error('no puzzle tiles found under family/color');
      await page.locator(`[data-testid="${puzzles[0]}"]`).click({ timeout: 5_000 });
      await page.waitForTimeout(2500); // wait for board to mount
    },
    3500,
    [
      { label: 'board pieces rendered', fn: async () => (await page.locator('[data-piece]').count()) > 0 },
      {
        label: 'orientation is recognized (white-bottom OR black-bottom)',
        fn: async () => {
          const o = await readOrientation();
          return o === 'white-bottom' || o === 'black-bottom';
        },
      },
    ],
  );

  // Snapshot board state BEFORE we touch anything
  const orientationBefore = await readOrientation();
  const studentBottom = orientationBefore === 'white-bottom' ? 'white' : 'black';

  // Make wrong moves until the reveal button appears (or we give up).
  // Cycle through harmless pawn pushes so we hit a legal-but-wrong
  // move regardless of whose turn it is.
  await record(
    'tactics-opening-traps-reveal',
    async () => {
      const tries = [
        ['a2', 'a3'],
        ['a7', 'a6'],
        ['h2', 'h3'],
        ['h7', 'h6'],
        ['b2', 'b3'],
        ['b7', 'b6'],
        ['g2', 'g3'],
        ['g7', 'g6'],
      ];
      for (let i = 0; i < tries.length; i++) {
        const reveal = page.locator('[data-testid="opening-blunder-reveal"]');
        if (await reveal.isVisible().catch(() => false)) break;
        const [from, to] = tries[i];
        const fromSq = page.locator(`[data-square="${from}"]`);
        const toSq = page.locator(`[data-square="${to}"]`);
        if (!(await fromSq.isVisible().catch(() => false))) continue;
        await fromSq.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(150);
        await toSq.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      const reveal = page.locator('[data-testid="opening-blunder-reveal"]');
      if (await reveal.isVisible().catch(() => false)) await reveal.click();
      await page.waitForTimeout(2000); // curated line auto-plays
    },
    1500,
    [
      {
        label: 'play-out button appears after reveal',
        fn: async () => await visible('opening-blunder-play-out'),
      },
      {
        label: 'orientation unchanged after curated reveal',
        fn: async () => (await readOrientation()) === orientationBefore,
      },
    ],
  );

  // Capture state right before Play-it-out, engage, wait for engine
  const stateBeforePlayOut = await readBoardState();
  await record(
    'tactics-opening-traps-play-out',
    async () => {
      const btn = page.locator('[data-testid="opening-blunder-play-out"]');
      if (!(await btn.isVisible().catch(() => false))) {
        throw new Error('play-out button not present (puzzle did not complete)');
      }
      await btn.click();
      // Give Stockfish time to fire its first move
      await page.waitForTimeout(6500);
    },
    1500,
    [
      {
        label: 'orientation unchanged after Play-it-out engages',
        fn: async () => (await readOrientation()) === orientationBefore,
      },
      {
        // Core check for the side-flip bug: after Play-it-out engages,
        // the engine's first move is OPPONENT's color. We detect by
        // diffing piece positions between before-engine-moved and now,
        // looking at the new-piece destination's color suffix.
        // Piece codes from react-chessboard are 'wP','wN',...,'bK'.
        label: 'engine first move is OPPONENT color (not student color)',
        fn: async () => {
          const after = await readBoardState();
          // Find squares that changed: new piece appeared OR piece colour changed
          const colorsMoved = new Set();
          for (const sq of Object.keys(after)) {
            const was = stateBeforePlayOut[sq];
            const now = after[sq];
            if (was !== now && now) {
              // A piece now occupies a square it didn't before
              const c = now[0]; // 'w' or 'b'
              if (c === 'w') colorsMoved.add('white');
              else if (c === 'b') colorsMoved.add('black');
            }
          }
          if (colorsMoved.size === 0) return false; // engine didn't move at all
          const opponent = studentBottom === 'white' ? 'black' : 'white';
          // Stockfish should have moved opponent's color exclusively
          return colorsMoved.has(opponent) && !colorsMoved.has(studentBottom);
        },
      },
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
