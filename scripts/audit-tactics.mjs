#!/usr/bin/env node
/**
 * Audit-tactics — full-coverage deep-flow audit of every surface
 * under /tactics/*. Drives the deployed app (or local dev via
 * AUDIT_SMOKE_URL) like a user, waits for animations to settle, and
 * verifies observable outcomes — board state changes, text updates,
 * audit-stream events firing — not just testid presence.
 *
 * Each scenario picks one capability per surface and exercises it
 * end-to-end. Surface-mount-only checks were the structural weakness
 * of the prior version; this rewrite forces every interactive
 * affordance to do something visible.
 *
 * Usage:
 *   node scripts/audit-tactics.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-tactics.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-tactics.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// Sandbox/CI environments often have a Chromium build pre-installed
// at /opt/pw-browsers but at a different build number than the npm
// `playwright` package expects. Probing the installed path lets the
// audit run without a fresh `npx playwright install`, which is
// frequently blocked by network policy. Same path the previous
// session's runs used (the sandbox image carries
// chromium_headless_shell-1194 + chromium-1194). When the binary is
// absent (developer's laptop with a normal install), `playwright`
// uses its own resolved path — we only override if the file exists.
async function resolveExecutablePath(headed) {
  const candidates = headed
    ? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    : [
        '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
        '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  return undefined;
}

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = `${BASE_URL}/api/audit-stream`;
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/tactics-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SETTLE_SHORT = 2500;
const SETTLE_MED = 5000;
const SETTLE_PUZZLE = 8000;
const SETTLE_ENGINE = 6500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[tactics] base    = ${BASE_URL}`);
  console.log(`[tactics] stream  = ${STREAM_URL}`);
  console.log(`[tactics] outDir  = ${OUT_DIR}`);
  console.log(`[tactics] headed  = ${HEADED}`);

  const executablePath = await resolveExecutablePath(HEADED);
  if (executablePath) console.log(`[tactics] chromium  = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
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
      } catch {}
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
      } catch {}
    }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));

  const report = { base: BASE_URL, startedAt: stamp, scenarios: [] };

  async function scenario(name, action, settleMs, expectations = [], expectedEventKinds = []) {
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
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {}
    const fresh = captured.slice(before);
    const kindCounts = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const url = page.url();
    // Auto-expand `expectedEventKinds` into pass/fail checks. This is
    // the SHOULD-WORK contract's audit-trail row enforcement — if a
    // surface CLAIMS to emit `tactics-surface-event` but the stream
    // never sees one during this scenario, the audit catches the
    // missing emit. Mirrors PR #504's F1 fix: zero audit emits in
    // /weaknesses caught the same way.
    const effectiveExpectations = [
      ...expectations,
      ...expectedEventKinds.map((kind) => ({
        label: `audit-stream saw kind="${kind}"`,
        fn: () => fresh.some((e) => e?.kind === kind),
      })),
    ];
    const checks = [];
    for (const exp of effectiveExpectations) {
      try {
        const ok = await exp.fn();
        checks.push({ label: exp.label, ok: !!ok, detail: exp.detail });
      } catch (e) {
        checks.push({ label: exp.label, ok: false, error: String(e?.message ?? e) });
      }
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    console.log(`\n[tactics] ${name}  →  ${url}  (${Date.now() - t0}ms, ${fresh.length} events)`);
    for (const c of checks) {
      console.log(`    ${c.ok ? 'PASS' : 'FAIL'} — ${c.label}${c.error ? ` (${c.error})` : ''}`);
    }
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);
    report.scenarios.push({
      name, url, durationMs: Date.now() - t0, eventCount: fresh.length,
      kindCounts, checks, screenshot: screenshotPath,
      consoleErrors: newConsole, pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      error: actionErr,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════
  const visible = (tid) =>
    page.locator(`[data-testid="${tid}"]`).first().isVisible().catch(() => false);
  const bodyText = async () => (await page.textContent('body').catch(() => '')) ?? '';
  const hasText = async (needle) => (await bodyText()).toLowerCase().includes(needle.toLowerCase());
  const count = async (sel) => await page.locator(sel).count().catch(() => 0);

  // Read every rendered piece into a square→piece map (react-chessboard
  // sets data-square on each square and data-piece on the piece DOM).
  async function readBoard() {
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
  function boardDiff(before, after) {
    const changed = [];
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const sq of keys) {
      if ((before ?? {})[sq] !== (after ?? {})[sq]) {
        changed.push({ sq, was: (before ?? {})[sq] ?? null, now: (after ?? {})[sq] ?? null });
      }
    }
    return changed;
  }
  // Orientation by a1/h8 vertical position.
  async function orientation() {
    return await page.evaluate(() => {
      const a1 = document.querySelector('[data-square="a1"]');
      const h8 = document.querySelector('[data-square="h8"]');
      if (!a1 || !h8) return null;
      return a1.getBoundingClientRect().top > h8.getBoundingClientRect().top
        ? 'white-bottom' : 'black-bottom';
    });
  }
  // Poll until predicate returns true, OR timeout.
  async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await predicate()) return true; } catch {}
      await page.waitForTimeout(intervalMs);
    }
    return false;
  }
  // Poll a value until it stops changing for stableForMs (great for
  // animations — returns the final stable state).
  async function waitForStable(readFn, { timeoutMs = 10_000, stableForMs = 800 } = {}) {
    const t0 = Date.now();
    let lastVal = JSON.stringify(await readFn());
    let lastChangeT = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await page.waitForTimeout(150);
      const cur = JSON.stringify(await readFn());
      if (cur !== lastVal) { lastVal = cur; lastChangeT = Date.now(); }
      if (Date.now() - lastChangeT >= stableForMs) return JSON.parse(lastVal);
    }
    return JSON.parse(lastVal);
  }

  // Nav helpers
  async function clickTacticsNav() {
    await page.getByRole('link', { name: 'Tactics' }).first().click().catch(() => {});
    await page.locator('[data-testid="tactics-page"]').waitFor({ timeout: 12_000 }).catch(() => {});
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
    [
      { label: 'app boot', fn: () => hasText('chess academy pro') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics — Hub
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '02-hub-render',
    async () => { await clickTacticsNav(); },
    SETTLE_SHORT,
    [
      { label: 'page mount', fn: () => visible('tactics-page') },
      { label: 'title "Tactical Training"', fn: () => hasText('tactical training') },
      { label: 'search input present', fn: async () => (await count('input[placeholder*="Search"]')) > 0 },
      { label: 'all 4 fixed tiles', fn: async () =>
        (await visible('section-spot')) && (await visible('section-daily')) &&
        (await visible('section-setup')) && (await visible('section-random-mix')) },
      { label: '11 theme tiles (THEME_MAP entries)', fn: async () => {
        const themes = ['opening traps', 'forks', 'pins & skewers', 'discovered attacks',
          'back rank mates', 'sacrifices', 'deflection & decoy', 'removing the guard',
          'zugzwang', 'endgame technique', 'mating nets'];
        for (const t of themes) {
          if (!(await visible(`section-${t}`))) return false;
        }
        return true;
      } },
      { label: 'My Weaknesses + My Mistakes tiles', fn: async () =>
        (await visible('section-my-weaknesses')) && (await visible('section-my mistakes')) },
    ],
  );

  // Hub SmartSearchBar: type, verify retains, verify clears
  await scenario(
    '03-hub-search-typing',
    async () => {
      const input = page.locator('input[placeholder*="Search"]').first();
      await input.fill('Sicilian Dragon');
      await page.waitForTimeout(800);
    },
    500,
    [
      { label: 'input retains value', fn: async () =>
        (await page.locator('input[placeholder*="Search"]').first().inputValue()) === 'Sicilian Dragon' },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/profile — TacticalProfilePage
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '04-profile-mount',
    async () => {
      await page.locator('[data-testid="section-spot"]').click();
      // Header (with back btn) MUST appear even during loading.
      await page.locator('[data-testid="back-btn"]').waitFor({ timeout: 8000 });
      // Body (Train Weakest CTA) appears after getThemeSkills resolves.
      await page.locator('[data-testid="begin-training-btn"]').waitFor({ timeout: 25_000 }).catch(() => {});
    },
    1000,
    [
      { label: 'route /tactics/profile', fn: () => page.url().endsWith('/tactics/profile') },
      { label: 'page mount', fn: () => visible('tactical-profile-page') },
      { label: 'back btn visible (loading + loaded)', fn: () => visible('back-btn') },
      { label: 'refresh btn visible', fn: () => visible('refresh-btn') },
      { label: 'Train Your Weakest CTA visible', fn: () => visible('begin-training-btn') },
      { label: '11 theme rows', fn: async () => (await count('[data-testid="theme-row"]')) === 11 },
      { label: 'stats: Puzzles Solved + Overall Accuracy + Themes Practiced',
        fn: async () => (await hasText('Puzzles Solved')) && (await hasText('Overall Accuracy')) && (await hasText('Themes Practiced')) },
    ],
  );

  // Refresh button click — must not throw, page should still be there
  await scenario(
    '05-profile-refresh',
    async () => {
      await page.locator('[data-testid="refresh-btn"]').click().catch(() => {});
      await page.waitForTimeout(2000);
    },
    500,
    [
      { label: 'page still mounted after refresh', fn: () => visible('tactical-profile-page') },
      { label: 'Train Weakest CTA still present', fn: () => visible('begin-training-btn') },
    ],
  );

  // Train Weakest navigation — must land on /tactics/drill
  await scenario(
    '06-profile-train-weakest',
    async () => {
      await page.locator('[data-testid="begin-training-btn"]').click();
      await waitUntil(() => page.url().endsWith('/tactics/drill'), 5000);
    },
    SETTLE_PUZZLE,
    [
      { label: 'navigated to /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'drill page mounted', fn: () => visible('tactic-drill-page') },
    ],
  );

  // Theme row navigation — click first row, verify navigation
  await clickTacticsNav();
  await page.locator('[data-testid="section-spot"]').click();
  await page.locator('[data-testid="begin-training-btn"]').waitFor({ timeout: 25_000 }).catch(() => {});
  await scenario(
    '07-profile-theme-row-nav',
    async () => {
      await page.locator('[data-testid="theme-row"]').first().click().catch(() => {});
      await waitUntil(() => page.url().endsWith('/tactics/drill'), 5000);
    },
    SETTLE_PUZZLE,
    [
      { label: 'theme row navigates to /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/classic — PuzzleTrainerPage (Daily Training)
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '08-classic-mount',
    async () => {
      await page.locator('[data-testid="section-daily"]').click();
      await page.locator('[data-testid="puzzle-trainer"]').waitFor({ timeout: 10_000 });
      await page.locator('[data-testid="puzzle-mode-selector"]').waitFor({ timeout: 8000 }).catch(() => {});
    },
    1500,
    [
      { label: 'route /tactics/classic', fn: () => page.url().endsWith('/tactics/classic') },
      { label: 'puzzle-trainer mount', fn: () => visible('puzzle-trainer') },
      { label: 'mode selector visible', fn: () => visible('puzzle-mode-selector') },
      { label: 'header shows user rating', fn: async () => /rating:\s*\d+/i.test(await bodyText()) },
      { label: 'all 5 PUZZLE_MODES visible', fn: async () => {
        return (await visible('mode-standard')) && (await visible('mode-timed_blitz')) &&
               (await visible('mode-daily_challenge')) && (await visible('mode-opening_traps')) &&
               (await visible('mode-endgame'));
      } },
    ],
  );

  // Click "standard" mode → puzzle should load
  await scenario(
    '09-classic-mode-select-flow',
    async () => {
      await page.locator('[data-testid="mode-standard"]').click();
      await waitUntil(() => visible('puzzle-board').then((v) => v) || hasText('No puzzles available').then((v) => v), 10_000);
    },
    SETTLE_PUZZLE,
    [
      { label: 'puzzle-board appears OR empty-state shown',
        fn: async () => (await visible('puzzle-board')) || (await hasText('no puzzles')) || (await visible('session-complete')) },
      { label: 'tactic-type-heading present when puzzle loaded',
        fn: async () => (await visible('puzzle-board')) ? await visible('tactic-type-heading') : true },
      { label: 'back-to-modes button visible',
        fn: () => visible('back-to-modes') },
    ],
  );

  // back-to-modes returns to mode selector
  await scenario(
    '10-classic-back-to-modes',
    async () => {
      const btn = page.locator('[data-testid="back-to-modes"]');
      if (await btn.isVisible().catch(() => false)) await btn.click();
      await page.waitForTimeout(800);
    },
    500,
    [
      { label: 'back returns to mode selector OR session-complete',
        fn: async () => (await visible('puzzle-mode-selector')) || (await visible('session-complete')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/setup — TacticSetupPage
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '11-setup-select',
    async () => {
      await page.locator('[data-testid="section-setup"]').click();
      await waitUntil(() => visible('difficulty-1').then((v) => v), 8000);
    },
    500,
    [
      { label: 'route /tactics/setup', fn: () => page.url().endsWith('/tactics/setup') },
      { label: 'all 3 difficulty buttons', fn: async () =>
        (await visible('difficulty-1')) && (await visible('difficulty-2')) && (await visible('difficulty-3')) },
      { label: 'back-btn present', fn: () => visible('back-btn') },
      { label: 'intro text mentions "engineer the fork"', fn: () => hasText('engineer the fork') },
    ],
  );

  await scenario(
    '12-setup-beginner-queue',
    async () => {
      await page.locator('[data-testid="difficulty-1"]').click();
      // Either queue loads (puzzle-nav appears) OR summary shows (empty queue with import CTA)
      await waitUntil(
        async () => (await visible('puzzle-nav')) || (await visible('session-summary')),
        12_000,
      );
    },
    1500,
    [
      { label: 'puzzle-nav OR session-summary', fn: async () =>
        (await visible('puzzle-nav')) || (await visible('session-summary')) },
      { label: 'IF empty: Import Games CTA',
        fn: async () => (await visible('puzzle-nav')) || (await hasText('Import Games')) },
      { label: 'IF queue loaded: setup board visible',
        fn: async () => (await visible('session-summary')) || (await visible('setup-board')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/drill — Random Mix
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '13-random-mix-drill',
    async () => {
      await page.locator('[data-testid="section-random-mix"]').click();
      await page.locator('[data-testid="tactic-drill-page"]').waitFor({ timeout: 10_000 });
      // PuzzleBoard takes ~600ms to play the setup move, plus loading.
      await waitUntil(() => visible('puzzle-board').then((v) => v), 10_000);
    },
    SETTLE_PUZZLE,
    [
      { label: 'route /tactics/drill', fn: () => page.url().endsWith('/tactics/drill') },
      { label: 'page mount', fn: () => visible('tactic-drill-page') },
      { label: 'theme label "Mixed"', fn: () => hasText('mixed') },
      { label: 'PuzzleBoard mounted', fn: () => visible('puzzle-board') },
      { label: 'tactic-type-heading visible', fn: () => visible('tactic-type-heading') },
      { label: 'puzzle-nav visible', fn: () => visible('puzzle-nav') },
      { label: 'nav-prev disabled at start',
        fn: async () => await page.locator('[data-testid="nav-prev"]').isDisabled().catch(() => false) },
      { label: 'Target rating displayed', fn: () => hasText('Target:') },
      { label: 'stats line: solved + missed',
        fn: async () => (await hasText('solved')) && (await hasText('missed')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Random Mix deep-flow: verify setup move auto-plays (board changes
  // ~600ms after mount), nav-next loads a new puzzle (board differs).
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '14-random-mix-puzzle-progression',
    async () => {
      // wait for stable board (initial setup move done)
      const before = await waitForStable(readBoard, { timeoutMs: 6000, stableForMs: 800 });
      report.scenarios._tempBefore = before;
      // Click next puzzle — board should change to a new puzzle's position
      await page.locator('[data-testid="nav-next"]').click();
      await page.waitForTimeout(SETTLE_PUZZLE);
    },
    0,
    [
      { label: 'next puzzle loads a different position',
        fn: async () => {
          const after = await readBoard();
          const before = report.scenarios._tempBefore;
          delete report.scenarios._tempBefore;
          const changes = boardDiff(before, after).length;
          // A different puzzle = many squares change (effectively a new FEN).
          return changes >= 5;
        } },
      { label: 'puzzle-nav still visible after advance', fn: () => visible('puzzle-nav') },
      { label: 'progress shows "2 / 10"', fn: () => hasText('2 / 10') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Theme drills — sample 3 themes (rest follow same code path)
  // ═══════════════════════════════════════════════════════════════════
  for (const tile of ['section-forks', 'section-mating nets', 'section-back rank mates']) {
    await clickTacticsNav();
    const slug = tile.replace(/[^a-z0-9-]/gi, '-');
    await scenario(
      `15-theme-drill-${slug}`,
      async () => {
        await page.locator(`[data-testid="${tile}"]`).click();
        await page.locator('[data-testid="tactic-drill-page"]').waitFor({ timeout: 10_000 });
        await waitUntil(() => visible('puzzle-board').then((v) => v), 10_000);
      },
      SETTLE_SHORT,
      [
        { label: 'tactic-drill-page mounts', fn: () => visible('tactic-drill-page') },
        { label: 'PuzzleBoard renders', fn: () => visible('puzzle-board') },
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/adaptive — AdaptivePuzzlePage
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '16-adaptive-difficulty-select',
    async () => {
      await page.goto(`${BASE_URL}/tactics/adaptive`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="adaptive-puzzle-page"]').waitFor({ timeout: 10_000 });
    },
    SETTLE_SHORT,
    [
      { label: 'route /tactics/adaptive', fn: () => page.url().endsWith('/tactics/adaptive') },
      { label: 'page mount', fn: () => visible('adaptive-puzzle-page') },
      { label: 'back-button present (in select phase)', fn: () => visible('back-button') },
      { label: 'all 3 difficulty buttons', fn: async () =>
        (await visible('difficulty-easy')) && (await visible('difficulty-medium')) && (await visible('difficulty-hard')) },
      { label: 'player rating header', fn: () => visible('player-rating-header') },
      { label: 'classic + mistakes cross-links',
        fn: async () => (await visible('classic-trainer-link')) && (await visible('my-mistakes-link')) },
    ],
  );

  // Back button from select phase → /tactics
  await scenario(
    '17-adaptive-back-from-select',
    async () => {
      await page.locator('[data-testid="back-button"]').click();
      await waitUntil(() => page.url().endsWith('/tactics'), 5000);
    },
    SETTLE_SHORT,
    [
      { label: 'back from select → /tactics', fn: () => page.url().endsWith('/tactics') },
      { label: 'tactics-page mounted', fn: () => visible('tactics-page') },
    ],
  );

  // Easy difficulty pick → puzzle loads
  await page.goto(`${BASE_URL}/tactics/adaptive`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="adaptive-puzzle-page"]').waitFor({ timeout: 10_000 });
  await scenario(
    '18-adaptive-easy-pick',
    async () => {
      await page.locator('[data-testid="difficulty-easy"]').click();
      await waitUntil(
        async () => (await visible('puzzle-board')) || (await visible('loading')),
        10_000,
      );
    },
    SETTLE_PUZZLE,
    [
      { label: 'puzzle-board OR loading visible',
        fn: async () => (await visible('puzzle-board')) || (await visible('loading')) },
      { label: 'end-session button when puzzle-board',
        fn: async () => (await visible('puzzle-board')) ? await visible('end-session') : true },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/opening-traps — OpeningBlundersPage (DEEP FLOW)
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '19-opening-traps-hub',
    async () => {
      await page.locator('[data-testid="section-opening traps"]').click();
      await page.locator('[data-testid="opening-blunders-page"]').waitFor({ timeout: 12_000 });
    },
    SETTLE_SHORT,
    [
      { label: 'route /tactics/opening-traps', fn: () => page.url().endsWith('/tactics/opening-traps') },
      { label: 'page mount', fn: () => visible('opening-blunders-page') },
      { label: '4 phase tabs', fn: async () => (await count('[data-testid^="opening-blunder-phase-"]')) >= 4 },
      { label: '>=1 family tile', fn: async () => (await count('[data-testid^="opening-blunder-family-"]')) > 0 },
      { label: 'French Defense family tile (David hit bug here)', fn: () => visible('opening-blunder-family-french_defense') },
    ],
  );

  // Phase tab switching: click "middlegame", subtitle should update
  await scenario(
    '20-opening-traps-phase-tabs',
    async () => {
      await page.locator('[data-testid="opening-blunder-phase-middlegame"]').click();
      await page.waitForTimeout(800);
    },
    500,
    [
      { label: 'subtitle mentions middlegame', fn: () => hasText('middlegame') },
    ],
  );

  // Pick first family (default phase) — verify color picker appears
  await page.locator('[data-testid="opening-blunder-phase-opening"]').click();
  await page.waitForTimeout(600);
  await scenario(
    '21-opening-traps-pick-french',
    async () => {
      await page.locator('[data-testid="opening-blunder-family-french_defense"]').click();
      await waitUntil(
        async () => (await count('[data-testid^="opening-blunder-color-"]')) >= 1
          || (await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="opening-blunder-"]'))
            .filter(el => /^opening-blunder-[a-zA-Z0-9]{5}$/.test(el.getAttribute('data-testid') ?? '')).length > 0)),
        8000,
      );
    },
    SETTLE_SHORT,
    [
      { label: 'color picker OR puzzle list rendered',
        fn: async () => (await count('[data-testid^="opening-blunder-color-"]')) >= 1
          || (await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="opening-blunder-"]'))
            .filter(el => /^opening-blunder-[a-zA-Z0-9]{5}$/.test(el.getAttribute('data-testid') ?? '')).length > 0)) },
    ],
  );

  // Pick first available puzzle
  await scenario(
    '22-opening-traps-pick-puzzle',
    async () => {
      const firstColor = page.locator('[data-testid^="opening-blunder-color-"]').first();
      if (await firstColor.isVisible().catch(() => false)) {
        await firstColor.click();
        await page.waitForTimeout(600);
      }
      const puzzles = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="opening-blunder-"]'))
          .map((el) => el.getAttribute('data-testid'))
          .filter((tid) => tid && /^opening-blunder-[a-zA-Z0-9]{5}$/.test(tid)),
      );
      if (puzzles.length === 0) throw new Error('no puzzle tiles found');
      await page.locator(`[data-testid="${puzzles[0]}"]`).click();
      // Wait for the board to render its setup move
      await waitForStable(readBoard, { timeoutMs: 8000, stableForMs: 800 });
    },
    SETTLE_SHORT,
    [
      { label: 'board pieces rendered', fn: async () => (await count('[data-piece]')) > 0 },
      { label: 'orientation recognized',
        fn: async () => ['white-bottom', 'black-bottom'].includes(await orientation()) },
      { label: '"Show the opening" button visible', fn: () => visible('opening-blunder-show-opening') },
    ],
  );

  // SHOW THE OPENING — deep flow (David's bug). Verify:
  //  - Multiple ply changes happen (animation runs)
  //  - The transition from animation-end to puzzle-position is NOT a
  //    multi-square jump (with the snap fix, the final move is
  //    animated via walkthroughFen, so handoff to playout.fen is a
  //    visual no-op when reconstruction matched).
  let beforeShowOpening = null;
  await scenario(
    '23-show-the-opening-flow',
    async () => {
      beforeShowOpening = await readBoard();
      await page.locator('[data-testid="opening-blunder-show-opening"]').click();
      // Wait up to 20s for the "Showing the opening · ply X/Y" indicator
      // to appear AND finish (ply X === Y).
      await waitUntil(
        async () => {
          const txt = await bodyText();
          const m = txt.match(/Showing the opening.*?ply (\d+)\/(\d+)/);
          if (!m) return false;
          // Done when ply >= total
          return Number(m[1]) >= Number(m[2]);
        },
        25_000,
      );
      // Allow the extra dwell tick + handoff to playout.fen.
      await waitForStable(readBoard, { timeoutMs: 4000, stableForMs: 800 });
    },
    0,
    [
      { label: 'animation indicator disappeared (walkthrough done)',
        fn: async () => !(await hasText('showing the opening')) },
      { label: 'final position equals puzzle starting position',
        fn: async () => {
          const after = await readBoard();
          const changes = boardDiff(beforeShowOpening, after).length;
          // After walkthrough returns to puzzle position, board should
          // match where it started (the puzzle's setup FEN).
          return changes === 0;
        },
        detail: 'walkthrough should land on puzzle FEN' },
      { label: 'Show-the-opening button hidden after use',
        fn: async () => !(await visible('opening-blunder-show-opening')) },
    ],
  );

  // PLAY-IT-OUT DEEP FLOW — verify side does not flip after reveal +
  // Stockfish kick.
  let orientationAtPuzzleStart = null;
  await scenario(
    '24-play-it-out-reveal-then-engage',
    async () => {
      orientationAtPuzzleStart = await orientation();
      // Trigger reveal by making 2 wrong moves (any harmless pawn push).
      const tries = [['a2','a3'], ['a7','a6'], ['h2','h3'], ['h7','h6'], ['b2','b3'], ['b7','b6']];
      for (const [from, to] of tries) {
        if (await visible('opening-blunder-reveal')) break;
        const fromSq = page.locator(`[data-square="${from}"]`);
        if (!(await fromSq.isVisible().catch(() => false))) continue;
        await fromSq.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(150);
        await page.locator(`[data-square="${to}"]`).click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      if (await visible('opening-blunder-reveal')) {
        await page.locator('[data-testid="opening-blunder-reveal"]').click();
        await page.waitForTimeout(2000);
      }
    },
    1500,
    [
      { label: 'Play-it-out button surfaces after reveal',
        fn: () => visible('opening-blunder-play-out') },
      { label: 'orientation unchanged after reveal',
        fn: async () => (await orientation()) === orientationAtPuzzleStart },
    ],
  );

  // Engage Play-it-out, wait for Stockfish, verify no side flip
  let beforePlayOut = null;
  await scenario(
    '25-play-it-out-engine-color',
    async () => {
      beforePlayOut = await readBoard();
      const btn = page.locator('[data-testid="opening-blunder-play-out"]');
      if (!(await btn.isVisible().catch(() => false))) {
        throw new Error('play-out button not present');
      }
      await btn.click();
      await page.waitForTimeout(SETTLE_ENGINE);
    },
    1000,
    [
      { label: 'orientation unchanged', fn: async () => (await orientation()) === orientationAtPuzzleStart },
      {
        label: 'no side-flip: opponent color moved OR position unchanged',
        fn: async () => {
          const after = await readBoard();
          const colorsMoved = new Set();
          for (const sq of Object.keys(after)) {
            const was = beforePlayOut[sq];
            const now = after[sq];
            if (was !== now && now) {
              const c = now[0]; // 'w' or 'b'
              if (c === 'w') colorsMoved.add('white');
              else if (c === 'b') colorsMoved.add('black');
            }
          }
          if (colorsMoved.size === 0) return true; // even-length: no engine move expected
          const student = orientationAtPuzzleStart === 'white-bottom' ? 'white' : 'black';
          const opp = student === 'white' ? 'black' : 'white';
          return colorsMoved.has(opp) && !colorsMoved.has(student);
        },
      },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/weakness-themes — WeaknessThemesPage
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '26-weakness-themes-mount',
    async () => {
      await page.locator('[data-testid="section-my-weaknesses"]').click();
      await page.locator('[data-testid="weakness-themes-page"]').waitFor({ timeout: 8000 });
      // Wait for loading → themes/summary transition
      await waitUntil(async () =>
        (await visible('themes-list')) || (await visible('session-summary')) ||
        (await hasText('No weakness data')), 8000);
    },
    1000,
    [
      { label: 'route /tactics/weakness-themes', fn: () => page.url().endsWith('/tactics/weakness-themes') },
      { label: 'page mount', fn: () => visible('weakness-themes-page') },
      { label: 'back-btn present', fn: () => visible('back-btn') },
      { label: 'themes list OR empty CTA',
        fn: async () => (await visible('themes-list')) || (await hasText('Import Games')) || (await visible('session-summary')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/weakness — WeaknessPuzzlePage
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '27-weakness-puzzle',
    async () => {
      await page.goto(`${BASE_URL}/tactics/weakness`, { waitUntil: 'domcontentloaded' });
      await waitUntil(async () =>
        (await visible('puzzle-nav')) || (await visible('session-summary')) ||
        (await visible('loading')), 12_000);
    },
    SETTLE_PUZZLE,
    [
      { label: 'route /tactics/weakness', fn: () => page.url().endsWith('/tactics/weakness') },
      { label: 'back-btn present', fn: () => visible('back-btn') },
      { label: 'puzzle-nav OR summary OR loading',
        fn: async () => (await visible('puzzle-nav')) || (await visible('session-summary')) || (await visible('loading')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/mistakes — MyMistakesPage
  // ═══════════════════════════════════════════════════════════════════
  await clickTacticsNav();
  await scenario(
    '28-mistakes-mount',
    async () => {
      await page.locator('[data-testid="section-my mistakes"]').click();
      await waitUntil(async () =>
        (await visible('my-mistakes-page')) || (await visible('empty-state')), 8000);
    },
    SETTLE_SHORT,
    [
      { label: 'route /tactics/mistakes', fn: () => page.url().endsWith('/tactics/mistakes') },
      { label: 'page OR empty-state mount',
        fn: async () => (await visible('my-mistakes-page')) || (await visible('empty-state')) },
      { label: 'all 4 phase tabs',
        fn: async () => (await visible('phase-tab-all')) && (await visible('phase-tab-opening'))
          && (await visible('phase-tab-middlegame')) && (await visible('phase-tab-endgame')) },
      { label: 're-analyze button OR empty-state CTA',
        fn: async () => (await visible('reanalyze-button')) || (await visible('empty-state')) },
    ],
  );

  // Phase tab click + filter changes — must not throw
  await scenario(
    '29-mistakes-tabs-filters',
    async () => {
      if (await visible('phase-tab-opening')) {
        await page.locator('[data-testid="phase-tab-opening"]').click();
        await page.waitForTimeout(500);
      }
      if (await visible('classification-filter')) {
        await page.locator('[data-testid="classification-filter"]').selectOption('blunder').catch(() => {});
        await page.waitForTimeout(400);
        await page.locator('[data-testid="classification-filter"]').selectOption('all').catch(() => {});
      }
      if (await visible('status-filter')) {
        await page.locator('[data-testid="status-filter"]').selectOption('unsolved').catch(() => {});
        await page.waitForTimeout(400);
      }
    },
    500,
    [
      { label: 'no new pageerror after filter changes', fn: () => true /* tracked globally */ },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/lichess — LichessDashboardPage
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '30-lichess-mount',
    async () => {
      await page.goto(`${BASE_URL}/tactics/lichess`, { waitUntil: 'domcontentloaded' });
      await waitUntil(async () =>
        (await visible('lichess-dashboard-no-token')) ||
        (await visible('lichess-dashboard-page')) ||
        (await visible('dashboard-loading')) ||
        (await visible('dashboard-error')), 10_000);
    },
    SETTLE_SHORT,
    [
      { label: 'route /tactics/lichess', fn: () => page.url().endsWith('/tactics/lichess') },
      { label: 'one of: no-token, loaded, loading, error states',
        fn: async () =>
          (await visible('lichess-dashboard-no-token')) ||
          (await visible('lichess-dashboard-page')) ||
          (await visible('dashboard-loading')) ||
          (await visible('dashboard-error')) },
      { label: 'back-btn present (testid)', fn: () => visible('back-btn') },
    ],
  );

  // Lichess back button must go to /tactics (fix verification)
  await scenario(
    '31-lichess-back-to-tactics',
    async () => {
      await page.locator('[data-testid="back-btn"]').click().catch(() => {});
      await waitUntil(() => page.url().endsWith('/tactics'), 5000);
    },
    SETTLE_SHORT,
    [
      { label: 'back goes to /tactics (not /weaknesses)', fn: () => page.url().endsWith('/tactics') },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // /tactics/create — TacticCreatePage
  // ═══════════════════════════════════════════════════════════════════
  await scenario(
    '32-create-mount',
    async () => {
      await page.goto(`${BASE_URL}/tactics/create`, { waitUntil: 'domcontentloaded' });
      await waitUntil(async () =>
        (await visible('loading')) || (await visible('session-summary')) ||
        (await hasText('context depth')), 10_000);
    },
    SETTLE_SHORT,
    [
      { label: 'route /tactics/create', fn: () => page.url().endsWith('/tactics/create') },
      { label: 'back-btn present', fn: () => visible('back-btn') },
      { label: 'loading state OR summary state visible (empty queue)',
        fn: async () => (await visible('loading')) || (await visible('session-summary'))
          || (await hasText('context depth')) },
    ],
  );

  // ═══════════════════════════════════════════════════════════════════
  // Legacy redirects — all 11
  // ═══════════════════════════════════════════════════════════════════
  const redirects = [
    ['/puzzles', '/tactics'],
    ['/puzzles/classic', '/tactics/classic'],
    ['/puzzles/adaptive', '/tactics/adaptive'],
    ['/puzzles/mistakes', '/tactics/mistakes'],
    ['/puzzles/weakness', '/tactics/weakness'],
    ['/puzzles/lichess-dashboard', '/tactics/lichess'],
    ['/weaknesses/puzzles', '/tactics/weakness'],
    ['/weaknesses/adaptive', '/tactics/adaptive'],
    ['/weaknesses/classic', '/tactics/classic'],
    ['/weaknesses/mistakes', '/tactics/mistakes'],
    ['/weaknesses/lichess-dashboard', '/tactics/lichess'],
  ];
  for (const [src, dst] of redirects) {
    await scenario(
      `33-redirect-${src.replace(/\//g, '-')}`,
      async () => {
        await page.goto(`${BASE_URL}${src}`, { waitUntil: 'domcontentloaded' });
      },
      1500,
      [{ label: `${src} → ${dst}`, fn: () => page.url().endsWith(dst) }],
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
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

  // SHOULD-WORK contract enforcement: audit-hook coverage on every
  // /tactics/* surface. Iterate scenarios; for any whose final URL
  // matches a tactics surface, verify at least one
  // `tactics-surface-event` was emitted during the scenario. This is
  // the F1-lineage check (PR #504) — pre-fix, every row here would
  // FAIL because the tactics tab had zero `logAppAudit` emit sites.
  const TACTICS_URL_RX = /\/tactics(\/|$|\?)/;
  const auditCoverageGaps = report.scenarios
    .filter((s) => s.url && TACTICS_URL_RX.test(s.url))
    .filter((s) => !(s.kindCounts && s.kindCounts['tactics-surface-event'] >= 1))
    .map((s) => ({
      scenario: s.name,
      url: s.url,
      reason: 'no tactics-surface-event seen during scenario',
    }));
  report.auditCoverageGaps = auditCoverageGaps;
  for (const g of auditCoverageGaps) {
    failed.push({ scenario: g.scenario, label: 'audit-hook coverage', error: g.reason });
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const allChecks = report.scenarios.reduce((n, s) => n + (s.checks?.length ?? 0), 0);
  const passed = allChecks - failed.length;
  const md = [
    `# Tactics Audit — ${stamp}`,
    ``,
    `Base: ${BASE_URL}`,
    ``,
    `Scenarios: ${report.scenarios.length}`,
    `Checks: ${passed}/${allChecks} passed`,
    `Console errors: ${consoleErrors.length}`,
    `Page errors: ${pageErrors.length}`,
    `Runtime-error audit events: ${report.runtimeErrorEvents.length}`,
    `Tactics surfaces with audit-stream coverage: ${report.scenarios.filter((s) => s.url && /\/tactics(\/|$|\?)/.test(s.url) && s.kindCounts && s.kindCounts['tactics-surface-event'] >= 1).length} / ${report.scenarios.filter((s) => s.url && /\/tactics(\/|$|\?)/.test(s.url)).length}`,
    ``,
    `## Failures`,
    ``,
  ];
  if (failed.length === 0) md.push('_None._');
  else for (const f of failed) md.push(`- **${f.scenario}** — ${f.label}${f.error ? ` — \`${String(f.error).slice(0, 200)}\`` : ''}`);
  if (auditCoverageGaps.length > 0) {
    md.push(``, `## Audit-hook coverage gaps`, ``);
    md.push(`These scenarios reached a /tactics surface but no \`tactics-surface-event\` was emitted during the run — observability gap, see TACTICS_SHOULD_WORK.md.`);
    md.push(``);
    for (const g of auditCoverageGaps) md.push(`- **${g.scenario}** — ${g.url}`);
  }
  await writeFile(join(OUT_DIR, 'report.md'), md.join('\n'));

  console.log(`\n[tactics] DONE — ${passed}/${allChecks} checks passed`);
  console.log(`[tactics] events=${captured.length} console.errors=${consoleErrors.length} pageerrors=${pageErrors.length} runtime-err-events=${report.runtimeErrorEvents.length}`);
  if (failed.length) {
    console.log(`[tactics] ${failed.length} failures:`);
    for (const f of failed) console.log(`  - ${f.scenario} :: ${f.label}${f.error ? ` :: ${String(f.error).slice(0, 120)}` : ''}`);
  }
  console.log(`[tactics] report: ${OUT_DIR}/report.json + report.md`);

  await browser.close();
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error('[tactics] fatal:', err); process.exit(1); });
