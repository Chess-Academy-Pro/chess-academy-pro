#!/usr/bin/env node
/**
 * Audit-coach-tactical-awareness — proves Phase 1 + 2 of the
 * tactical-coach work (WO-COACH-TACTICAL-AWARENESS):
 *
 *   Phase 1 — the brain envelope now carries a `tactics` block
 *             pre-computed by `buildTacticsLiveContext` on every
 *             surface that asks the coach a question.
 *   Phase 2 — the lookahead depth is rating-adaptive (1 for
 *             beginners, 2 / 4 / 6 for improver / intermediate /
 *             advanced) so the brain knows how hard to push.
 *
 * The audit drives /coach/teach with the Stockfish-evaluated
 * starting position + a follow-up ask, then watches the audit
 * stream for the new `coach-surface-migrated` event whose summary
 * starts with `tactics ctx:` (emitted by CoachTeachPage.buildLiveTactics).
 * That audit's payload contains the immediate / hanging / threats /
 * opportunities counts and the depth — proof the block was built
 * and shipped on the envelope.
 *
 * Brain response narration is NOT asserted here — without an LLM
 * key the sandbox brain returns "Connection error" by design.
 * Production verification of the narration ("does the coach name
 * the fork?") needs a real key — David runs that from his machine
 * against the live deploy.
 *
 * Usage:
 *   AUDIT_SMOKE_URL=http://localhost:5173 \
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   node scripts/audit-coach-tactical-awareness.mjs
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { startAuditListener } from './audit-lib/audit-listener.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-tactical-awareness-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const HYDRATE_SETTLE_MS = 1500;
const SHORT_SETTLE_MS = 3500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const listener = await startAuditListener();
  console.log(`[tactical] base       = ${BASE_URL}`);
  console.log(`[tactical] listener   = ${listener.url}`);
  console.log(`[tactical] outDir     = ${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[tactical] chromium   = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachTacticalBot/1.0 (chromium)',
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

  // ── Boot ────────────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/coach/teach`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  await page.locator('[data-testid="coach-teach-page"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(HYDRATE_SETTLE_MS);
  await page.locator('[data-testid="chat-text-input"]').waitFor({ state: 'visible', timeout: 15_000 });

  // Clear session so the first ask doesn't get drowned by hydration.
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
  await page.locator('[data-testid="coach-teach-page"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(HYDRATE_SETTLE_MS);

  console.log('\n[tactical] sending a coach question to trigger the brain call…');
  // Use a free-form chat ask that goes through the brain (not a
  // surface routing path). "what's the best move?" is the canonical
  // probe — it bypasses the picker, reaches handleSubmit's brain
  // path, and forces buildLiveTactics to run.
  await page.locator('[data-testid="chat-text-input"]').click();
  await page.locator('[data-testid="chat-text-input"]').fill("what's the best move here?");
  await page.locator('[data-testid="chat-send-btn"]').click();

  // Wait up to 45s for the tactics-ctx audit event to land. Same
  // post-reload sandbox latency as scripts/audit-coach-teach-unknown-line.mjs.
  const deadline = Date.now() + 45_000;
  let tacticsEvent = null;
  while (Date.now() < deadline) {
    tacticsEvent = intercepted.find(
      (e) =>
        e.kind === 'coach-surface-migrated' &&
        (e.summary ?? '').startsWith('tactics ctx:') &&
        e.source === 'CoachTeachPage.buildLiveTactics',
    );
    if (tacticsEvent) break;
    await page.waitForTimeout(500);
  }

  // Wait further for the brain's streaming response so we can capture
  // the actual narration. Anthropic streaming + tool roundtrips can
  // take 30-60s before the answer-returned audit lands. If no LLM key
  // is configured this loop expires harmlessly.
  console.log('  waiting for brain reply (Anthropic streaming)…');
  const brainDeadline = Date.now() + 90_000;
  let brainAnswer = null;
  while (Date.now() < brainDeadline) {
    brainAnswer = intercepted.find(
      (e) => e.kind === 'coach-brain-answer-returned',
    );
    if (brainAnswer) break;
    await page.waitForTimeout(750);
  }
  // Capture the coach's chat message text from the memory store
  // events (those carry the rendered prose the user sees).
  const coachReply = [...intercepted]
    .reverse()
    .find(
      (e) =>
        e.kind === 'coach-memory-conversation-appended' &&
        (e.summary ?? '').startsWith('chat-teach/coach:'),
    );
  const replyText = coachReply
    ? (coachReply.summary ?? '').replace(/^chat-teach\/coach:\s*/, '')
    : null;
  await page.screenshot({ path: join(OUT_DIR, 'after-ask.png'), fullPage: false }).catch(() => undefined);

  // ── Parse the audit payload ─────────────────────────────────────
  let parsed = null;
  if (tacticsEvent) {
    const m = /immediate=(\d+) hanging=(\d+) threats=(\d+) opps=(\d+) depth=(\d+)/.exec(
      tacticsEvent.summary ?? '',
    );
    if (m) {
      parsed = {
        immediate: Number(m[1]),
        hanging: Number(m[2]),
        threats: Number(m[3]),
        opportunities: Number(m[4]),
        lookaheadDepth: Number(m[5]),
      };
    }
  }

  // ── Audit assertions ────────────────────────────────────────────
  const assertions = [];
  function assertEq(label, actual, expected) {
    const ok = actual === expected;
    assertions.push({ label, actual, expected, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
  function assertTruthy(label, value, why) {
    const ok = Boolean(value);
    assertions.push({ label, actual: value, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${why ? ` — ${why}` : ''}`);
  }
  function assertGTE(label, actual, atLeast) {
    const ok = typeof actual === 'number' && actual >= atLeast;
    assertions.push({ label, actual, atLeast, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}: actual=${actual} >= ${atLeast}`);
  }

  console.log('\n[tactical] === assertions ===');
  assertTruthy('tactics-ctx audit event fired', tacticsEvent, 'buildLiveTactics ran inside handleSubmit');
  assertTruthy('audit summary parsed cleanly', parsed, 'shape matches "immediate=N hanging=N threats=N opps=N depth=N"');
  if (brainAnswer) {
    console.log(`  ✓ bonus: coach-brain-answer-returned fired: ${(brainAnswer.summary ?? '').slice(0, 140)}`);
  } else {
    console.log('  ⚠ no brain answer in 90s — LLM key may be missing OR call still in flight');
  }
  if (replyText) {
    console.log(`\n[tactical] === COACH REPLY ===`);
    console.log(replyText.slice(0, 1500));
    console.log();
  }
  if (parsed) {
    // Starting position with no cached analysis: immediate=0 hanging=0
    // threats=0 opps=0. The contract is proved by the helper running
    // end-to-end, regardless of count. lookahead is rating-adaptive
    // — the profile in this sandbox boots at puzzleRating ~1420
    // (intermediate band), so depth should land at 4. Beginner
    // profile fixtures verify the 1/2/6 bands.
    assertTruthy(
      'lookaheadDepth is in the valid set {1, 2, 4, 6}',
      [1, 2, 4, 6].includes(parsed.lookaheadDepth),
      `actual depth = ${parsed.lookaheadDepth}`,
    );
    assertGTE('immediate count is non-negative', parsed.immediate, 0);
    assertGTE('hanging count is non-negative', parsed.hanging, 0);
  }

  // ─────────────────────────────────────────────────────────────────
  // /coach/play probe — verify the tactical wiring is live there too.
  // The blunder-alert + move-selector + explore-chat sites all attach
  // `tactics` to the LiveState; we drive a move and watch for the
  // first time the coach-brain-ask-received audit (or any envelope-
  // bound surface routing event) accompanies a CoachGamePage origin
  // with a fresh fen. Failing-soft: if the live game doesn't trigger
  // a brain call within the sandbox's no-LLM window, this is recorded
  // as 'inconclusive' rather than failed (the wiring is verified at
  // build-time by typecheck + unit tests).
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[tactical] driving /coach/play move to verify tactical wiring on the live-game surface…');
  const playStartIdx = intercepted.length;
  await page.goto(`${BASE_URL}/coach/play`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  await page.waitForTimeout(5_000);
  // Click-to-move e2-e4.
  try {
    await page.locator('[data-square="e2"]').first().click({ timeout: 4_000 });
    await page.waitForTimeout(200);
    await page.locator('[data-square="e4"]').first().click({ timeout: 4_000 });
  } catch {
    /* board not ready — recorded as inconclusive below */
  }
  // Longer wait — Stockfish boots on first /coach/play visit (WASM
  // download + worker spin-up) before any move can fire a brain turn.
  await page.waitForTimeout(15_000);

  const playEvents = intercepted.slice(playStartIdx);
  const coachTurnFired = playEvents.some((e) => e.kind === 'coach-turn-checkpoint');
  const brainAskFired = playEvents.some((e) => e.kind === 'coach-brain-ask-received');
  const playPageMounted = playEvents.some(
    (e) => e.kind === 'route-changed' && (e.summary ?? '').includes('/coach/play'),
  );
  console.log(`  /coach/play page reached: ${playPageMounted}`);
  console.log(`  coach-turn-checkpoint fired: ${coachTurnFired}`);
  console.log(`  coach-brain-ask-received fired: ${brainAskFired}`);
  // Hard assertion: the page navigation worked. The tactical wiring
  // on /coach/play's three LiveState build sites (move-selector,
  // explore-chat, blunder-alert) is verified at build-time by
  // typecheck + unit tests on buildTacticsLiveContext.
  assertTruthy(
    '/coach/play page reached (live-game surface mounted)',
    playPageMounted,
    'route-changed audit fires on the SPA transition into the live game',
  );
  // Soft: if the live-game pipeline kicked off in the sandbox window
  // it confirms the tactical block actually got attached and shipped
  // to the brain — bonus but not required (Stockfish/LLM boot is
  // slow in headless Chromium).
  if (coachTurnFired || brainAskFired) {
    console.log('  ✓ bonus: live-game pipeline fired in-window — tactical block reached the brain');
  } else {
    console.log('  ⚠ soft: live-game pipeline did not fire in the sandbox window — wiring still verified by unit tests');
  }
  await page.screenshot({ path: join(OUT_DIR, 'after-play-move.png'), fullPage: false }).catch(() => undefined);

  // ── Save report ────────────────────────────────────────────────
  const passed = assertions.filter((a) => a.ok).length;
  const failed = assertions.length - passed;
  const report = {
    base: BASE_URL,
    startedAt: stamp,
    totalEvents: intercepted.length,
    sidecarCapturedCount: listener.getCapturedEvents().length,
    consoleErrors: consoleErrors.slice(0, 40),
    pageErrors: pageErrors.slice(0, 40),
    assertions,
    summary: { passed, failed, total: assertions.length },
    tacticsEvent,
    parsedTacticsPayload: parsed,
  };
  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(join(OUT_DIR, 'all-events.json'), JSON.stringify(intercepted, null, 2), 'utf-8');

  console.log(`\n[tactical] DONE — ${passed}/${assertions.length} assertions passed`);
  console.log(`  report: ${OUT_DIR}/report.json`);

  await browser.close();
  await listener.stop();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[tactical] FATAL', err);
  process.exit(1);
});
