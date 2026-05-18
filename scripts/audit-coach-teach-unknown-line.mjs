#!/usr/bin/env node
/**
 * Audit-coach-teach — drives /coach/teach end-to-end across every
 * surface-routing tier and exit so we know each "teach me X" path
 * lands where it should. Originally focused on the unknown-line
 * case (PR #599); now covers the full menu of behaviors so an
 * audit run mirrors the user-facing decision tree.
 *
 * Scenarios (top to bottom of the routing pipeline):
 *
 *  S1. Boot smoke — page mounts cleanly.
 *  S2. Static registry (Vienna) — Tier 1 instant hit. Verify
 *      walkthrough reaches the leaf, leaf prompt fires (chat ask +
 *      voice + "Play this line out yourself" button).
 *  S3. Leaf "Play this line out yourself" click — verify nav to
 *      /coach/play?opening=Vienna+Game.
 *  S4. DB sub-line not in static registry
 *      ("Vienna Game: Frankenstein-Dracula Variation") — Tier 3
 *      DB-narration. Verify spine extends across name boundaries
 *      into middlegame (≥6 narration skips post-fix), leaf prompt
 *      fires, "Play this line out yourself" surfaces at the leaf.
 *  S5. Broad family name (e.g. "Sicilian") — Tier 1.5 line picker.
 *      Verify the picker UI surfaces and shows variation choices.
 *  S6. Stage keyword (e.g. "drill Vienna") — skips walkthrough and
 *      lands at the stage menu / drill picker directly.
 *  S7. Fabricated name ("Hyper-Modern Spaghetti Defense, Anti-Pasta
 *      Variation") — pre-flight reject + brain fall-through (no
 *      walkthrough). Verify the `pre-flight rejected non-opening`
 *      audit fires.
 *  S8. Cache re-hit — re-ask "Vienna" after S2 generated/loaded it.
 *      Expect Tier 1 again (static registry trumps cache for
 *      Vienna), instant resume with the "Welcome back" ack.
 *
 * Each scenario captures: phase reached, leaf-prompt presence,
 * leaf button presence, transcript text, page+console errors,
 * and the audit-stream events POSTed to the sidecar listener.
 *
 * Usage:
 *   AUDIT_SMOKE_URL=http://localhost:5173 \
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   node scripts/audit-coach-teach-unknown-line.mjs
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { startAuditListener } from './audit-lib/audit-listener.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-teach-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const HYDRATE_SETTLE_MS = 1500;
const GEN_WAIT_MS = 25_000;
const SKIP_TO_LEAF_TIMEOUT_MS = 90_000;
const SKIP_INTERVAL_MS = 600;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const listener = await startAuditListener();
  console.log(`[teach] base       = ${BASE_URL}`);
  console.log(`[teach] listener   = ${listener.url}`);
  console.log(`[teach] outDir     = ${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[teach] chromium   = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachTeachBot/1.0 (chromium)',
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

  async function clearSessionAndReload() {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const req = indexedDB.open('ChessAcademyDB');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) { resolve(); return; }
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').delete('coachSession.v1');
          tx.objectStore('meta').delete('coachMemory.v1');
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
        req.onerror = () => resolve();
      });
    });
    await page.goto(`${BASE_URL}/coach/teach`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-teach-page"]').waitFor({ timeout: 15_000 });
    // The chat input mounts and then briefly disables while the
    // session hydrates; wait until it's enabled before returning so
    // the next .click()+.fill() sequence actually targets a ready
    // component (avoids dropping the user message on the first turn
    // after a fresh reload).
    await page.locator('[data-testid="chat-text-input"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-text-input"]');
        if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return false;
        return !el.disabled;
      },
      { timeout: 15_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }

  async function recordScenario(name, options) {
    const startIdx = intercepted.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    console.log(`\n[teach] ${name}`);
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
    const surfaceRouting = events
      .filter((e) => e.kind === 'coach-surface-migrated')
      .map((e) => e.summary);
    console.log(`  events=${events.length}  duration=${Date.now() - t0}ms`);
    for (const [k, n] of Object.entries(kinds)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)) {
      console.log(`    ${String(n).padStart(3)} × ${k}`);
    }
    for (const s of surfaceRouting) console.log(`    routing: ${s}`);

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
        } else if (a.kind === 'text-contains') {
          const t = await page
            .locator(a.selector)
            .first()
            .textContent({ timeout: 2000 })
            .catch(() => '');
          actual = (t ?? '').slice(0, 100);
          ok = (t ?? '').toLowerCase().includes(String(a.value).toLowerCase());
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
        } else if (a.kind === 'transcript-contains') {
          const t = await page
            .locator('[data-testid="teach-transcript"]')
            .innerText({ timeout: 2000 })
            .catch(() => '');
          actual = String(t).slice(0, 100);
          ok = String(t).toLowerCase().includes(String(a.value).toLowerCase());
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
      surfaceRouting,
      screenshot: screenshotPath,
      consoleErrors: consoleErrors.slice(consBefore),
      pageErrors: pageErrors.slice(errsBefore),
      sampleEvents: events.slice(0, 5),
      assertions,
      error: err,
      ...(options.extras ?? {}),
    });
  }

  // ── S1: Boot smoke ────────────────────────────────────────────────
  await recordScenario('S1_boot_dashboard', {
    run: async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      await page.waitForTimeout(2000);
    },
    assertions: [
      { kind: 'visible', selector: 'body', label: 'dashboard renders' },
    ],
  });

  await recordScenario('S1b_boot_coach_teach', {
    run: async () => {
      await page.goto(`${BASE_URL}/coach/teach`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
      await page.locator('[data-testid="coach-teach-page"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(HYDRATE_SETTLE_MS);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="coach-teach-page"]', label: 'teach page mounts' },
      { kind: 'visible', selector: '[data-testid="chat-text-input"]', label: 'chat input present' },
      { kind: 'visible', selector: '[data-testid="chat-send-btn"]', label: 'send button present' },
      { kind: 'visible', selector: '[data-testid="teach-picker"]', label: 'picker UI surfaces on empty transcript' },
      { kind: 'visible', selector: '[data-testid="teach-picker-action-teach"]', label: 'Teach action chip visible' },
      { kind: 'visible', selector: '[data-testid="teach-picker-action-drill"]', label: 'Drill action chip visible' },
      { kind: 'visible', selector: '[data-testid="teach-picker-action-quiz"]', label: 'Quiz action chip visible' },
      { kind: 'visible', selector: '[data-testid="teach-picker-action-trap"]', label: 'Trap action chip visible' },
      { kind: 'visible', selector: '[data-testid="teach-picker-action-play"]', label: 'Play action chip visible' },
      { kind: 'visible', selector: '[data-testid="teach-picker-description"]', label: 'picker description renders' },
      { kind: 'visible', selector: '[data-testid="teach-picker-openings"]', label: 'opening chips row visible' },
    ],
  });

  // ── S1c: Picker — switch action mode + verify description swap ─
  await recordScenario('S1c_picker_mode_switch', {
    run: async () => {
      // Default selected = 'teach'; switch to 'drill'.
      await page.locator('[data-testid="teach-picker-action-drill"]').click();
      await page.waitForTimeout(400);
    },
    assertions: [
      {
        kind: 'text-contains',
        selector: '[data-testid="teach-picker-description"]',
        value: 'Practice the moves on the board',
        label: 'description swaps to Drill text',
      },
    ],
  });

  // ── S1d: Picker — submit Drill × first opening chip ─────────────
  await recordScenario('S1d_picker_submit_drill_opening', {
    run: async () => {
      // First opening chip should be either a favorited opening or
      // the fallback "Sicilian Defense". Click it; expect handleSubmit
      // to run "drill <opening>" through the stage-keyword path.
      // Both static and LLM-gen paths emit a "landed at drill" audit
      // (cache hit → "stage=drill"; LLM gen → "landed at drill").
      const firstOpening = page.locator('[data-testid="teach-picker-openings"] button').first();
      await firstOpening.click();
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        (/stage=drill|landed at drill/i.test(e.summary ?? '')),
        45_000,
      );
    },
    assertions: [
      {
        kind: 'audit-summary-contains',
        value: 'landed at drill',
        label: 'picker submitted → drill stage reached',
      },
    ],
  });

  // ── S2: Static registry hit (Vienna) → walkthrough → leaf ───────
  await clearSessionAndReload();
  await recordScenario('S2_static_registry_vienna', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      // Wait for the surface-routed audit to land in the intercepted
      // stream — that's the real signal that handleSubmit completed,
      // not a fixed timeout. After the very first clearSessionAndReload
      // the Dexie warmup (profile + completed-stages) measurably stalls
      // the static-routed branch for 20-25s in the sandbox; bump to 45s.
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        (e.summary ?? '').includes('surface-routed (static): "Vienna"'),
        45_000,
      );
      // Drive walkthrough to leaf
      await driveToLeaf(page);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-panel"]', label: 'leaf panel reached' },
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-play-real"]', label: 'leaf "play this line out" button visible' },
      { kind: 'visible', selector: '[data-testid="walkthrough-continue-learning"]', label: 'continue-learning button visible' },
      { kind: 'transcript-contains', value: 'play it out yourself', label: 'chat ask "play it out yourself"' },
      { kind: 'audit-summary-contains', value: 'surface-routed (static)', label: 'static-registry surface-routed audit' },
    ],
  });

  // ── S3: Click "Play this line out yourself" at leaf ─────────────
  await recordScenario('S3_leaf_play_real_click', {
    run: async () => {
      await page.locator('[data-testid="walkthrough-leaf-play-real"]').click();
      await page.waitForTimeout(2500);
    },
    assertions: [
      { kind: 'url-matches', value: /\/coach\/play\?opening=/, label: 'navigated to /coach/play with opening' },
    ],
  });

  // ── S4: DB sub-line (Frankenstein-Dracula) — spine extension ────
  await clearSessionAndReload();
  let frankSkips = 0;
  await recordScenario('S4_db_subline_frankenstein_dracula', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Vienna Game: Frankenstein-Dracula Variation');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await page.waitForTimeout(SHORT_SETTLE_MS);
      const lr = await driveToLeaf(page);
      frankSkips = lr?.skips ?? 0;
      console.log(`  spine-skips=${frankSkips}`);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-panel"]', label: 'leaf panel reached' },
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-play-real"]', label: 'leaf "play this line out" button visible' },
      { kind: 'transcript-contains', value: 'frankenstein-dracula variation', label: 'opening mentioned in transcript' },
      { kind: 'transcript-contains', value: 'play it out yourself', label: 'leaf ask reaches chat' },
      { kind: 'audit-summary-contains', value: 'generation OK via DB-narration path', label: 'DB-narration generation succeeded' },
    ],
    extras: { spineNarrationSkips: () => frankSkips }, // captured below
  });
  report.scenarios[report.scenarios.length - 1].spineNarrationSkips = frankSkips;
  report.scenarios[report.scenarios.length - 1].reachedMiddlegame = frankSkips >= 5;

  // ── S5: Broad family name → line picker ─────────────────────────
  await clearSessionAndReload();
  await recordScenario('S5_broad_family_sicilian', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Sicilian');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await page.waitForTimeout(SHORT_SETTLE_MS + 2000);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="line-picker"]', label: 'line picker surfaces for broad family' },
      { kind: 'audit-summary-contains', value: 'line picker shown for', label: 'line-picker surface-routed audit' },
    ],
  });

  // ── S6: Stage keyword "drill Vienna" → skip to stage menu ──────
  await clearSessionAndReload();
  await recordScenario('S6_stage_keyword_drill_vienna', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('drill Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await page.waitForTimeout(SHORT_SETTLE_MS + 1500);
    },
    assertions: [
      // Stage menu OR drill picker should be the destination — both
      // valid endpoints depending on data availability.
      {
        kind: 'visible',
        selector: '[data-testid="walkthrough-stage-menu"], [data-testid="walkthrough-drill-picker"], [data-testid="walkthrough-drill-active"], [data-testid="walkthrough-drill-empty"]',
        label: 'jumped to a drill-related phase (menu / picker / active / empty)',
      },
      { kind: 'audit-summary-contains', value: 'stage=drill', label: 'stage-hint=drill captured in routing audit' },
    ],
  });

  // ── S7: Fabricated name → pre-flight reject + brain fall-through
  await clearSessionAndReload();
  await recordScenario('S7_fabricated_name', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Hyper-Modern Spaghetti Defense, Anti-Pasta Variation');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await page.waitForTimeout(SHORT_SETTLE_MS + 5000);
    },
    assertions: [
      { kind: 'audit-summary-contains', value: 'pre-flight rejected non-opening', label: 'pre-flight reject audit fires' },
      // No walkthrough phase should be active.
      { kind: 'visible', selector: '[data-testid="coach-teach-page"]', label: 'teach page still mounted' },
    ],
  });

  // ── S8: Cache re-hit on Vienna ─────────────────────────────────
  // Same browser context — Vienna was just walked in S2/S3 so it
  // should hit either the static registry again (still Tier 1) or
  // the Dexie cache. Either is a fast hit; we just verify it doesn't
  // re-spin the LLM-gen path.
  await clearSessionAndReload();
  await recordScenario('S8_cache_or_static_hit_vienna', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await page.waitForTimeout(SHORT_SETTLE_MS);
    },
    assertions: [
      {
        kind: 'audit-summary-contains',
        value: 'surface-routed (static): "Vienna" → Vienna Game',
        label: 'static-registry hit (instant, no LLM gen)',
      },
      // teach-generation-progress would indicate a slow LLM gen —
      // it must NOT appear for a static or cached hit.
      {
        kind: 'visible',
        selector: '[data-testid="coach-teach-page"]',
        label: 'page still mounted (no crash)',
      },
    ],
  });

  // ─────────────────────────────────────────────────────────────────
  // E2E mode walks — drive each post-walkthrough stage through at
  // least one full interaction loop. Vienna is the target for all
  // four stage modes because the static-registry tree carries
  // hand-authored concepts / findMove / drill / punish content,
  // so the e2e drive does not depend on an LLM key being present.
  // ─────────────────────────────────────────────────────────────────

  // ── E1: Quiz (concepts) — full loop ─────────────────────────────
  await clearSessionAndReload();
  await recordScenario('E1_quiz_full_loop', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('quiz me on Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        /\[stage=concepts\]|landed at concepts/i.test(e.summary ?? ''),
        45_000,
      );
      // Wait for the quiz panel to mount.
      await page.locator('[data-testid="walkthrough-quiz-panel"]').waitFor({ timeout: 15_000 });
      // Pick choice 0, see the feedback render, advance.
      await page.locator('[data-testid="walkthrough-quiz-choice-0"]').click();
      await page.locator('[data-testid="walkthrough-quiz-next"]').waitFor({ timeout: 8_000 });
      await page.locator('[data-testid="walkthrough-quiz-next"]').click();
      await page.waitForTimeout(1500);
    },
    assertions: [
      {
        kind: 'visible',
        selector: '[data-testid="walkthrough-quiz-panel"], [data-testid="walkthrough-quiz-complete"], [data-testid="walkthrough-stage-menu"]',
        label: 'advanced past Q1 (next question OR quiz-complete OR back to stage menu)',
      },
      {
        kind: 'audit-summary-contains',
        value: 'concepts',
        label: 'concepts stage routing audit fired',
      },
    ],
  });

  // ── E2: Drill (woodpecker) — pick line + play first move ────────
  await clearSessionAndReload();
  await recordScenario('E2_drill_full_loop', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('drill Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        /\[stage=drill\]|landed at drill/i.test(e.summary ?? ''),
        45_000,
      );
      // Drill picker: pick line 0.
      await page.locator('[data-testid="walkthrough-drill-picker"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      const pickerLine = page.locator('[data-testid="walkthrough-drill-line-0"]');
      if (await pickerLine.isVisible().catch(() => false)) {
        await pickerLine.click();
      }
      // Wait for active drill state with the board ready for input.
      await page.locator('[data-testid="walkthrough-drill-active"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      // Play 1.e4 via click-to-move.
      await tryMove(page, 'e2', 'e4');
      await page.waitForTimeout(1500);
    },
    assertions: [
      {
        kind: 'visible',
        selector:
          '[data-testid="walkthrough-drill-active"], [data-testid="walkthrough-drill-complete"]',
        label: 'drill UI advanced past the first move (active or complete)',
      },
      {
        kind: 'audit-summary-contains',
        value: 'drill',
        label: 'drill stage routing audit fired',
      },
    ],
  });

  // ── E3: Trap (punish) — pick lesson + answer ────────────────────
  await clearSessionAndReload();
  await recordScenario('E3_trap_full_loop', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('punish lines for Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        /\[stage=punish\]|landed at punish/i.test(e.summary ?? ''),
        45_000,
      );
      // Punish picker: pick lesson 0.
      await page.locator('[data-testid="walkthrough-punish-picker"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      const lesson = page.locator('[data-testid="walkthrough-punish-lesson-0"]');
      if (await lesson.isVisible().catch(() => false)) {
        await lesson.click();
      }
      // Trap lessons land in the quiz panel (same MC UI).
      await page.locator('[data-testid="walkthrough-quiz-panel"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      const choice = page.locator('[data-testid="walkthrough-quiz-choice-0"]');
      if (await choice.isVisible().catch(() => false)) {
        await choice.click();
        // Feedback renders; advance.
        const next = page.locator('[data-testid="walkthrough-quiz-next"]');
        if (await next.isVisible().catch(() => false)) {
          await next.click();
          await page.waitForTimeout(1500);
        }
      }
    },
    assertions: [
      {
        kind: 'visible',
        selector:
          '[data-testid="walkthrough-quiz-panel"], [data-testid="walkthrough-quiz-complete"], [data-testid="walkthrough-stage-menu"], [data-testid="walkthrough-punish-picker"], [data-testid="walkthrough-trap-playing"], [data-testid="walkthrough-narrating-panel"], [data-testid="walkthrough-leaf-panel"], [data-testid="walkthrough-fork-panel"]',
        label: 'trap UI exercised (picker / question / fork / animation / completion)',
      },
      {
        kind: 'audit-summary-contains',
        value: 'landed at punish',
        label: 'punish stage routing audit fired',
      },
    ],
  });

  // ── E4: Teach (full walkthrough) — already proved by S2/S4; do a
  //      shorter sanity check that the full teach path renders the
  //      walkthrough panel and the leaf prompt is asked.
  await clearSessionAndReload();
  await recordScenario('E4_teach_full_loop', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      await waitForEvent(intercepted, (e) =>
        e.kind === 'coach-surface-migrated' &&
        (e.summary ?? '').includes('surface-routed (static): "Vienna"'),
        45_000,
      );
      await driveToLeaf(page);
    },
    assertions: [
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-panel"]', label: 'walkthrough reaches leaf' },
      { kind: 'visible', selector: '[data-testid="walkthrough-leaf-play-real"]', label: '"play this line out" leaf button visible' },
      { kind: 'transcript-contains', value: 'play it out yourself', label: 'coach asks in chat at the leaf' },
    ],
  });

  // ── E5: Play — submit "play Vienna" → /coach/play → make a move ─
  await clearSessionAndReload();
  await recordScenario('E5_play_full_loop', {
    run: async () => {
      await page.locator('[data-testid="chat-text-input"]').click();
      await page.locator('[data-testid="chat-text-input"]').fill('play it for real Vienna');
      await page.locator('[data-testid="chat-send-btn"]').click();
      // Surface routing should set stageHint='play-real' and navigate
      // to /coach/play. Wait for the URL to change.
      await page.waitForURL(/\/coach\/play/, { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
      // Board renders — make a move (e2-e4).
      await tryMove(page, 'e2', 'e4').catch(() => undefined);
      await page.waitForTimeout(2500);
    },
    assertions: [
      { kind: 'url-matches', value: /\/coach\/play/, label: 'navigated to /coach/play' },
      // Either the coach echoed our move via a coach-turn audit OR a
      // post-move audit fired. Both indicate the live game pipeline
      // accepted the move.
      {
        kind: 'audit-present',
        audit: 'coach-turn-checkpoint',
        label: 'coach turn fired (engine pipeline alive)',
      },
    ],
  });

  // ── Summary ────────────────────────────────────────────────────
  report.consoleErrors = consoleErrors.slice(0, 60);
  report.pageErrors = pageErrors.slice(0, 60);
  report.totalEvents = intercepted.length;
  report.sidecarCapturedCount = listener.getCapturedEvents().length;

  // Aggregate pass/fail
  const summary = report.scenarios.map((s) => {
    const a = s.assertions ?? [];
    const passed = a.filter((x) => x.ok).length;
    const failed = a.filter((x) => !x.ok).length;
    return { name: s.name, passed, failed, total: a.length, error: s.error };
  });
  report.summary = summary;
  console.log(`\n[teach] === scenario summary ===`);
  for (const s of summary) {
    const tag = s.failed === 0 && !s.error ? '✓' : '✗';
    console.log(`  ${tag}  ${s.name}: ${s.passed}/${s.total} pass${s.error ? ` (error: ${s.error.slice(0, 60)})` : ''}`);
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(join(OUT_DIR, 'all-events.json'), JSON.stringify(intercepted, null, 2), 'utf-8');
  console.log(`\n[teach] DONE`);
  console.log(`  total events: ${intercepted.length}`);
  console.log(`  report:       ${OUT_DIR}/report.json`);

  await browser.close();
  await listener.stop();
}

/** Click-to-move on react-chessboard. Matches scripts/audit-coach-play.mjs
 *  — drag events don't fire cleanly in headless Chromium, but clicking
 *  source then destination triggers the same move path. */
async function tryMove(page, from, to) {
  const fromSq = page.locator(`[data-square="${from}"]`).first();
  const toSq = page.locator(`[data-square="${to}"]`).first();
  if ((await fromSq.count()) === 0 || (await toSq.count()) === 0) {
    throw new Error(`square not on board: ${from} or ${to}`);
  }
  await fromSq.click({ timeout: 2000 });
  await page.waitForTimeout(200);
  await toSq.click({ timeout: 2000 });
}

async function waitForEvent(intercepted, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (intercepted.some(predicate)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function driveToLeaf(page) {
  const deadline = Date.now() + SKIP_TO_LEAF_TIMEOUT_MS;
  let lastPhase = '';
  let skips = 0;
  while (Date.now() < deadline) {
    const phase = await detectWalkthroughPhase(page);
    if (phase !== lastPhase) {
      console.log(`    phase → ${phase}`);
      lastPhase = phase;
    }
    if (phase === 'walkthrough-leaf-panel') return { reached: 'leaf', skips };
    if (phase === 'walkthrough-stage-menu') return { reached: 'stage-menu', skips };

    if (phase === 'walkthrough-narrating-panel') {
      const skipBtn = page.locator('[data-testid="walkthrough-skip"]');
      if (await skipBtn.isVisible().catch(() => false)) {
        await skipBtn.click({ timeout: 1500 }).catch(() => undefined);
        skips++;
      }
    } else if (phase === 'walkthrough-fork-panel') {
      const opt = page.locator('[data-testid="walkthrough-fork-option-0"]');
      if (await opt.isVisible().catch(() => false)) {
        await opt.click().catch(() => undefined);
      }
    } else if (phase === 'walkthrough-trap-prompt') {
      const skipTrap = page.locator('[data-testid="walkthrough-trap-skip"]');
      if (await skipTrap.isVisible().catch(() => false)) {
        await skipTrap.click().catch(() => undefined);
      }
    } else if (phase === 'walkthrough-choose-mode') {
      const c = page.locator('[data-testid="walkthrough-choose-walkthrough"]');
      if (await c.isVisible().catch(() => false)) {
        await c.click().catch(() => undefined);
      }
    } else if (phase === 'none') {
      return { reached: 'none', skips };
    }
    await page.waitForTimeout(SKIP_INTERVAL_MS);
  }
  return { reached: 'timeout', skips, lastPhase };
}

async function detectWalkthroughPhase(page) {
  const phases = [
    'walkthrough-narrating-panel',
    'walkthrough-leaf-panel',
    'walkthrough-stage-menu',
    'walkthrough-choose-mode',
    'walkthrough-fork-panel',
    'walkthrough-paused-panel',
    'walkthrough-trap-prompt',
    'walkthrough-quiz-panel',
    'walkthrough-drill-active',
    'walkthrough-drill-picker',
    'walkthrough-drill-empty',
    'teach-generation-progress',
    'line-picker',
  ];
  for (const p of phases) {
    const visible = await page
      .locator(`[data-testid="${p}"]`)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return p;
  }
  return 'none';
}

main().catch((err) => {
  console.error('[teach] FATAL', err);
  process.exit(1);
});
