#!/usr/bin/env node
/**
 * Audit-coach-middlegame-endgame — interactive end-to-end probe of
 * the middlegame + endgame coach surfaces against the 5-mode
 * template the /coach/teach picker now uses (Teach / Drill / Quiz /
 * Trap / Play). Same Playwright + audit-stream sidecar pattern as
 * scripts/audit-coach-teach-unknown-line.mjs.
 *
 * Scope is AUDIT-ONLY per the user's call (2026-05-18). The script
 * documents what each surface supports today; gaps are reported
 * in the summary, not patched.
 *
 * Endgame (`/coach/endgame`) — 8 tabs, expected coverage:
 *   - mating-patterns : Teach + Drill (pattern picker → puzzle playout)
 *   - principles      : Teach (narration intros)
 *   - pawn-endings    : Teach + Drill (lesson picker → playthrough)
 *   - rook-endings    : Teach + Drill
 *   - drawing-patterns: Teach + Drill
 *   - eval-lab        : Quiz (recognition + find-the-move) + Play (play-it-out)
 *   - calculation     : Drill (calculation skills)
 *   - from-your-games : Teach/Drill if user has imported games (usually
 *                       empty in a fresh session)
 *
 * Middlegame (`/coach/session/middlegame?opening=<id>`) — Teach only.
 * 180 plans in middlegame-plans.json drive the walkthrough; no drill /
 * quiz / trap / play surfaces exist today.
 *
 * Usage:
 *   AUDIT_SMOKE_URL=http://localhost:5173 \
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   node scripts/audit-coach-middlegame-endgame.mjs
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { startAuditListener } from './audit-lib/audit-listener.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-middlegame-endgame-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const HYDRATE_SETTLE_MS = 1500;
const TAB_SETTLE_MS = 1500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const listener = await startAuditListener();
  console.log(`[mid-end] base       = ${BASE_URL}`);
  console.log(`[mid-end] listener   = ${listener.url}`);
  console.log(`[mid-end] outDir     = ${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[mid-end] chromium   = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachMidEndBot/1.0 (chromium)',
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
    { url: listener.url, secret: listener.secret },
  );

  const page = await ctx.newPage();

  const intercepted = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/audit-stream') && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body && typeof body === 'object') {
          const events = Array.isArray(body) ? body : (body.events ?? [body]);
          for (const ev of events) intercepted.push(ev);
        }
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

  const report = {
    base: BASE_URL,
    startedAt: stamp,
    listenerUrl: listener.url,
    scenarios: [],
    modeMatrix: {
      // populated below as scenarios run
      endgame: {},
      middlegame: {},
    },
  };

  async function snapshot(name) {
    const p = join(OUT_DIR, `${name}.png`);
    try {
      await page.screenshot({ path: p, fullPage: false });
    } catch {
      /* ignore */
    }
    return p;
  }

  async function recordScenario(name, options) {
    const startIdx = intercepted.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    console.log(`\n[mid-end] ${name}`);
    let err = null;
    try {
      await options.run();
    } catch (e) {
      err = String(e?.message ?? e);
      console.log(`  [error] ${err}`);
    }
    const screenshotPath = await snapshot(name);
    const events = intercepted.slice(startIdx);
    const kinds = events.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  events=${events.length}  duration=${Date.now() - t0}ms`);

    const assertions = [];
    for (const a of options.assertions ?? []) {
      let ok = false;
      let actual = '?';
      try {
        if (a.kind === 'visible') {
          const count = await page.locator(a.selector).count();
          const visible = count > 0
            ? await page.locator(a.selector).first().isVisible().catch(() => false)
            : false;
          actual = visible ? 'visible' : `not-visible (count=${count})`;
          ok = visible;
        } else if (a.kind === 'count-gte') {
          const count = await page.locator(a.selector).count();
          actual = String(count);
          ok = count >= a.value;
        } else if (a.kind === 'count-eq') {
          const count = await page.locator(a.selector).count();
          actual = String(count);
          ok = count === a.value;
        } else if (a.kind === 'not-visible') {
          const count = await page.locator(a.selector).count();
          const visible = count > 0
            ? await page.locator(a.selector).first().isVisible().catch(() => false)
            : false;
          actual = visible ? `visible (count=${count})` : 'absent (as expected)';
          ok = !visible;
        } else if (a.kind === 'url-matches') {
          actual = page.url();
          ok = a.value.test(actual);
        } else if (a.kind === 'audit-present') {
          actual = kinds[a.audit] ? `${kinds[a.audit]}× present` : 'absent';
          ok = !!kinds[a.audit];
        } else if (a.kind === 'audit-summary-contains') {
          const matchEv = events.find(
            (e) => (e.summary ?? '').toLowerCase().includes(String(a.value).toLowerCase()),
          );
          actual = matchEv ? `${matchEv.kind}: ${(matchEv.summary ?? '').slice(0, 80)}` : 'absent';
          ok = !!matchEv;
        } else if (a.kind === 'text-on-page') {
          const t = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
          actual = (t ?? '').toLowerCase().includes(String(a.value).toLowerCase()) ? 'present' : 'absent';
          ok = actual === 'present';
        }
      } catch (e) {
        actual = `error: ${e.message?.slice(0, 80)}`;
      }
      assertions.push({ ...a, actual, ok });
      console.log(`  ${ok ? '✓' : '✗'} ${a.label} → ${actual}`);
    }

    report.scenarios.push({
      name,
      url: page.url(),
      durationMs: Date.now() - t0,
      eventCount: events.length,
      kinds,
      screenshot: screenshotPath,
      consoleErrors: consoleErrors.slice(consBefore),
      pageErrors: pageErrors.slice(errsBefore),
      sampleEvents: events.slice(0, 5),
      assertions,
      error: err,
      ...(options.extras ?? {}),
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION A — Endgame  (/coach/endgame, 8 tabs)
  // ─────────────────────────────────────────────────────────────────

  // A1: Boot dashboard + navigate to /coach/endgame
  await recordScenario('A1_boot_endgame_page', {
    run: async () => {
      await page.goto(`${BASE_URL}/coach/endgame`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      await page.locator('[data-testid="coach-endgame-page"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(HYDRATE_SETTLE_MS);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="coach-endgame-page"]', label: 'endgame page mounts' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-mating-patterns"]', label: 'Mating tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-principles"]', label: 'Principles tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-pawn-endings"]', label: 'Pawn tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-rook-endings"]', label: 'Rook tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-drawing-patterns"]', label: 'Drawn tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-eval-lab"]', label: 'Eval Lab tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-calculation"]', label: 'Calc tab present' },
      { kind: 'visible', selector: '[data-testid="endgame-tab-from-your-games"]', label: 'Your Games tab present' },
    ],
  });

  // Helper: re-navigate to /coach/endgame fresh + activate the named
  // tab. Picking a pattern / lesson navigates the tab bar OUT of
  // view, so each subsequent tab probe needs a fresh hub mount.
  async function gotoEndgameTab(tabId) {
    await page.goto(`${BASE_URL}/coach/endgame`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    // 30s — sandbox is intermittently slow; the page sometimes
    // sits on the Chess Academy Pro splash for 12-15s while modules
    // and Dexie hydrate.
    await page.locator('[data-testid="coach-endgame-page"]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
    const tab = page.locator(`[data-testid="endgame-tab-${tabId}"]`);
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(TAB_SETTLE_MS);
    }
  }

  // A2: Mating Patterns tab — Teach + Drill (grid renders + pick lands on drill UI)
  await recordScenario('A2_endgame_mating_teach_drill', {
    run: async () => {
      await gotoEndgameTab('mating-patterns');
      // Pick the first pattern (count of 37 expected).
      const firstPattern = page.locator('[data-testid^="endgame-pattern-"]').first();
      if (await firstPattern.isVisible().catch(() => false)) {
        await firstPattern.click();
        await page.waitForTimeout(3000);
      }
    },
    assertions: [
      // After tapping a pattern, either the lesson UI mounts (drill-style
      // playthrough) or a fork/options surface appears.
      {
        kind: 'visible',
        selector: '[data-testid="endgame-mating-hint"], [data-testid="endgame-show-options"], [data-testid="endgame-practice-more"], [data-testid="curated-mating-position-strip"], [data-testid="curated-mating-next-position"]',
        label: 'mating drill UI surfaces after pick',
      },
    ],
    extras: { modeMatrix: { teach: 'covered', drill: 'covered' } },
  });
  report.modeMatrix.endgame['mating-patterns'] = {
    teach: 'covered (pattern picker + narration intros)',
    drill: 'covered (puzzle playthrough)',
    quiz: 'n/a (not in this tab)',
    trap: 'n/a (endgames have no opponent traps)',
    play: 'n/a (covered in Eval Lab)',
  };

  // A3: Principles tab — Teach (narration intros)
  await recordScenario('A3_endgame_principles_teach', {
    run: async () => {
      await gotoEndgameTab('principles');
      const firstLesson = page.locator('[data-testid^="endgame-lesson-"]').first();
      if (await firstLesson.isVisible().catch(() => false)) {
        await firstLesson.click();
        await page.waitForTimeout(2500);
      }
    },
    assertions: [
      {
        kind: 'visible',
        selector: '[data-testid="endgame-concept-hint"], [data-testid="endgame-play-it-out"], [data-testid="endgame-position-mastered"], [data-testid="endgame-replay-narration"], [data-testid="endgame-lesson-done"]',
        label: 'principles drill/teach UI surfaces after pick',
      },
    ],
  });
  report.modeMatrix.endgame['principles'] = {
    teach: 'covered (intro narration + keystone position)',
    drill: 'covered (play-it-out vs Stockfish)',
    quiz: 'n/a',
    trap: 'n/a',
    play: 'covered (endgame-play-it-out)',
  };

  // A4 / A5 / A6: Pawn / Rook / Drawn — Teach + Drill (same pattern as principles)
  for (const tab of ['pawn-endings', 'rook-endings', 'drawing-patterns']) {
    await recordScenario(`A_endgame_${tab.replace(/-/g, '_')}_teach_drill`, {
      run: async () => {
        await gotoEndgameTab(tab);
        const firstLesson = page.locator('[data-testid^="endgame-lesson-"]').first();
        if (await firstLesson.isVisible().catch(() => false)) {
          await firstLesson.click();
          await page.waitForTimeout(2500);
        }
      },
      assertions: [
        {
          kind: 'visible',
          selector: '[data-testid="endgame-concept-hint"], [data-testid="endgame-play-it-out"], [data-testid="endgame-position-mastered"], [data-testid="endgame-replay-narration"], [data-testid="endgame-lesson-done"]',
          label: `${tab} lesson UI surfaces`,
        },
      ],
    });
    report.modeMatrix.endgame[tab] = {
      teach: 'covered',
      drill: 'covered',
      quiz: 'n/a',
      trap: 'n/a',
      play: 'covered (endgame-play-it-out)',
    };
  }

  // A7: Eval Lab — Quiz (recognition + find-the-move) + Play (play-it-out)
  await recordScenario('A7_endgame_eval_lab_quiz_play', {
    run: async () => {
      await gotoEndgameTab('eval-lab');
      await page.waitForTimeout(2500); // Eval Lab loads a puzzle async
    },
    assertions: [
      {
        kind: 'visible',
        selector: '[data-testid^="eval-lab-stage0-"], [data-testid="eval-lab-hint"], [data-testid="eval-lab-next"]',
        label: 'Eval Lab quiz UI surfaces',
      },
    ],
  });
  report.modeMatrix.endgame['eval-lab'] = {
    teach: 'partial (stage transitions narrate)',
    drill: 'n/a (this is the quiz tab)',
    quiz: 'covered (recognition + find-the-move MC)',
    trap: 'n/a',
    play: 'covered (play-it-out vs Stockfish stage)',
  };

  // A8: Calculation tab — Drill
  await recordScenario('A8_endgame_calculation', {
    run: async () => {
      await gotoEndgameTab('calculation');
    },
    assertions: [
      { kind: 'url-matches', value: /\/coach\/endgame/, label: 'still on endgame page (calc tab active)' },
      { kind: 'visible', selector: '[data-testid="coach-endgame-page"]', label: 'page still mounted' },
    ],
  });
  report.modeMatrix.endgame['calculation'] = {
    teach: 'partial',
    drill: 'covered (calculation skill drills)',
    quiz: 'n/a',
    trap: 'n/a',
    play: 'n/a',
  };

  // A9: Your Games tab — Teach/Drill IF user has imports (likely empty in
  // a fresh session). Don't assert content — just verify the tab mounts
  // and the page doesn't crash.
  await recordScenario('A9_endgame_your_games', {
    run: async () => {
      await gotoEndgameTab('from-your-games');
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="coach-endgame-page"]', label: 'page still mounted on Your Games tab' },
    ],
  });
  report.modeMatrix.endgame['from-your-games'] = {
    teach: 'covered if user has imports',
    drill: 'covered if user has imports',
    quiz: 'n/a',
    trap: 'n/a',
    play: 'n/a',
    note: 'empty in fresh session — depends on imported games',
  };

  // ─────────────────────────────────────────────────────────────────
  // SECTION B — Middlegame  (/coach/session/middlegame)
  // ─────────────────────────────────────────────────────────────────

  // B1: Direct navigate — italian-game plan (one of 180 in middlegame-plans.json)
  await recordScenario('B1_middlegame_session_italian_teach', {
    run: async () => {
      await page.goto(
        `${BASE_URL}/coach/session/middlegame?opening=italian-game&orientation=white`,
        { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS },
      );
      // The session shell waits for the walkthrough to load. We give
      // it a generous settle so resolveMiddlegameSessionWithFallback
      // can finish (DB read + buildSession from plan PGN).
      await page.waitForTimeout(SHORT_SETTLE_MS + 5000);
    },
    assertions: [
      { kind: 'url-matches', value: /\/coach\/session\/middlegame/, label: 'navigated to middlegame session route' },
      // Either the walkthrough text mentions "middlegame", OR the
      // session header text "Walkthrough" / "Italian" surfaces, OR
      // an error/empty state. Any of these confirms the route mounted
      // without crashing.
      { kind: 'text-on-page', value: 'italian', label: 'page mounted (Italian content surfaces)' },
    ],
  });
  report.modeMatrix.middlegame['italian-game'] = {
    teach: 'covered (single-pass walkthrough via useWalkthroughRunner)',
    drill: 'MISSING (no drill mode)',
    quiz: 'MISSING (no quiz mode)',
    trap: 'MISSING (no trap mode)',
    play: 'MISSING (no live-game mode from middlegame plan)',
    note: '180 plans in middlegame-plans.json; only the Teach surface exists. The remaining 4 modes are not built.',
  };

  // B2: Confirm no /coach/teach-style mode picker exists on the
  //     middlegame surface (this is the documented gap).
  await recordScenario('B2_middlegame_no_picker_modes', {
    run: async () => {
      // Re-navigate and probe for any drill / quiz / trap chips like
      // the /coach/teach picker has.
      await page.goto(
        `${BASE_URL}/coach/session/middlegame?opening=italian-game&orientation=white`,
        { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS },
      );
      await page.waitForTimeout(SHORT_SETTLE_MS);
    },
    assertions: [
      // These testids belong to /coach/teach's picker. They MUST be
      // absent on the middlegame session — confirms the documented
      // gap (middlegame has no Drill / Quiz / Trap surfaces today).
      { kind: 'not-visible', selector: '[data-testid="teach-picker-action-drill"]', label: 'drill picker chip absent (gap: no drill mode)' },
      { kind: 'not-visible', selector: '[data-testid="teach-picker-action-quiz"]', label: 'quiz picker chip absent (gap: no quiz mode)' },
      { kind: 'not-visible', selector: '[data-testid="teach-picker-action-trap"]', label: 'trap picker chip absent (gap: no trap mode)' },
    ],
  });

  // ─────────────────────────────────────────────────────────────────
  // Summary + report
  // ─────────────────────────────────────────────────────────────────
  report.consoleErrors = consoleErrors.slice(0, 60);
  report.pageErrors = pageErrors.slice(0, 60);
  report.totalEvents = intercepted.length;
  report.sidecarCapturedCount = listener.getCapturedEvents().length;

  const summary = report.scenarios.map((s) => {
    const a = s.assertions ?? [];
    const passed = a.filter((x) => x.ok).length;
    const failed = a.filter((x) => !x.ok).length;
    return { name: s.name, passed, failed, total: a.length, error: s.error };
  });
  report.summary = summary;
  console.log(`\n[mid-end] === scenario summary ===`);
  for (const s of summary) {
    const tag = s.failed === 0 && !s.error ? '✓' : '✗';
    console.log(`  ${tag}  ${s.name}: ${s.passed}/${s.total}${s.error ? ` (error: ${s.error.slice(0, 60)})` : ''}`);
  }

  console.log(`\n[mid-end] === mode coverage matrix ===`);
  console.log(`  ENDGAME (/coach/endgame):`);
  for (const [tab, modes] of Object.entries(report.modeMatrix.endgame)) {
    console.log(`    ${tab}:`);
    for (const [m, status] of Object.entries(modes)) {
      console.log(`      ${m.padEnd(6)} ${status}`);
    }
  }
  console.log(`  MIDDLEGAME (/coach/session/middlegame):`);
  for (const [op, modes] of Object.entries(report.modeMatrix.middlegame)) {
    console.log(`    ${op}:`);
    for (const [m, status] of Object.entries(modes)) {
      console.log(`      ${m.padEnd(6)} ${status}`);
    }
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(join(OUT_DIR, 'all-events.json'), JSON.stringify(intercepted, null, 2), 'utf-8');
  console.log(`\n[mid-end] DONE — report: ${OUT_DIR}/report.json`);

  await browser.close();
  await listener.stop();
}

main().catch((err) => {
  console.error('[mid-end] FATAL', err);
  process.exit(1);
});
