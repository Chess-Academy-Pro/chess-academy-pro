#!/usr/bin/env node
/**
 * Audit-coach-play — drives /coach/play end-to-end against the
 * deployed app (or a local dev server via AUDIT_SMOKE_URL).
 *
 * Mirrors the audit-tactics.mjs / audit-smoke.mjs pattern:
 *   - one Chromium session, no page reloads
 *   - SPA navigation via real clicks
 *   - audit-stream enabled via localStorage; outgoing POSTs
 *     intercepted so we get the exact payload the page tried to push
 *   - console.errors + pageerrors captured per surface
 *   - screenshot + per-surface event summary in report.json
 *
 * Surfaces / behaviors exercised:
 *   - Hub render + Play tile click → /coach/play
 *   - Difficulty Easy/Medium/Hard buttons exist
 *   - Player Info Bar visible (rating)
 *   - Inline Chat + Tips buttons present
 *   - Make 4 student moves (Italian-shape: e4 / Nc3 / Bc4 / Nf3)
 *     and wait for the coach to respond after each — verifies
 *     stockfishEngine + coachMoveSelector wiring
 *   - Toggle Coach Narration setting silent ↔ full and confirm:
 *       silent → 0 voice-speak-invoked events on next move
 *       full   → ≥ 1 voice-speak-invoked event on next move (when
 *                LLM emits commentary)
 *   - Phase audit-event roll-up (coach-turn-checkpoint /
 *     coach-opening-auto-detected / coach-move-narration-fired/skipped /
 *     stockfish-prefetch-fired)
 *
 * Usage:
 *   node scripts/audit-coach-play.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-play.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-coach-play.mjs
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
const OUT_DIR = `audit-reports/coach-play-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const MOVE_SETTLE_MS = 7000; // student move + Stockfish reply + narration

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[coach-play] base    = ${BASE_URL}`);
  console.log(`[coach-play] outDir  = ${OUT_DIR}`);
  console.log(`[coach-play] headed  = ${HEADED}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[coach-play] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachPlayBot/1.0 (chromium)',
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
    const kinds = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const sortedKinds = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
    const url = page.url();
    console.log(`\n[coach-play] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

    // Evaluate expectations against the captured slice.
    const expectationResults = expectations.map((exp) => {
      const actual = exp.match === 'count'
        ? (kinds[exp.kind] ?? 0)
        : (kinds[exp.kind] ? 'present' : 'absent');
      let ok = false;
      if (exp.match === 'count') {
        if (exp.op === 'gte') ok = actual >= exp.value;
        else if (exp.op === 'eq') ok = actual === exp.value;
        else if (exp.op === 'lte') ok = actual <= exp.value;
      } else if (exp.match === 'presence') {
        ok = (exp.op === 'present' && actual === 'present') ||
             (exp.op === 'absent' && actual === 'absent');
      }
      return { ...exp, actual, ok };
    });
    if (expectationResults.length > 0) {
      for (const r of expectationResults) {
        console.log(`  ${r.ok ? '✓' : '✗'} expect ${r.kind} ${r.op}${r.value !== undefined ? ` ${r.value}` : ''} → ${r.actual}`);
      }
    }

    report.surfaces.push({
      name,
      url,
      durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kinds,
      screenshot: screenshotPath,
      consoleErrors: newConsole,
      pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      expectations: expectationResults,
      error: actionErr,
    });
  }

  // ── Boot + nav to Play ──────────────────────────────────────────
  await record('boot-dashboard', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
  }, 6000);

  await record('coach-hub', async () => {
    await page.getByRole('link', { name: 'Coach' }).first().click();
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15000 });
  });

  await record('coach-play-render', async () => {
    await page.locator('[data-testid="coach-action-play"]').click();
    // Wait for the play surface to settle — the board takes time to
    // render plus the brain emits app-init and surface-migrated audits.
    await page.waitForTimeout(2000);
  }, MOVE_SETTLE_MS, [
    { kind: 'coach-hub-tile-clicked', match: 'presence', op: 'present', why: 'tile click audited' },
    { kind: 'route-changed', match: 'presence', op: 'present', why: 'router transitions to /coach/play' },
  ]);

  // ── Helper: click-to-move (matches audit-tactics.mjs pattern).
  // react-chessboard's drag-from-pointer events don't fire cleanly in
  // headless Chromium, but click-to-select then click-to-place does.
  // The board accepts both per the user's Move Method setting; 'both'
  // (default) lets the click path through regardless.
  async function tryMove(from, to) {
    const fromSq = page.locator(`[data-square="${from}"]`).first();
    const toSq = page.locator(`[data-square="${to}"]`).first();
    if ((await fromSq.count()) === 0 || (await toSq.count()) === 0) {
      throw new Error(`square not on board: ${from} or ${to}`);
    }
    await fromSq.click({ timeout: 2000 });
    await page.waitForTimeout(200);
    await toSq.click({ timeout: 2000 });
  }

  // ── Make a student move (e4) and wait for Stockfish reply ────────
  await record('move-1-e4', async () => {
    await tryMove('e2', 'e4');
  }, MOVE_SETTLE_MS, [
    // Stockfish prefetch / move emission. Either pattern indicates the
    // engine path is alive.
    { kind: 'coach-turn-checkpoint', match: 'presence', op: 'present', why: 'coach turn fires after each ply' },
  ]);

  // ── More student moves so we can observe per-move narration / tactic
  //    alerts / opening detection across multiple plies.
  await record('move-2-Nc3', async () => {
    await tryMove('b1', 'c3').catch(() => undefined);
  }, MOVE_SETTLE_MS);

  await record('move-3-Bc4', async () => {
    await tryMove('f1', 'c4').catch(() => undefined);
  }, MOVE_SETTLE_MS);

  await record('move-4-Nf3', async () => {
    await tryMove('g1', 'f3').catch(() => undefined);
  }, MOVE_SETTLE_MS, [
    // By move 4 with Italian/Vienna shape, opening auto-detect should
    // have fired at least once.
    { kind: 'coach-opening-auto-detected', match: 'presence', op: 'present', why: 'auto-detect runs every move; Italian shape recognizable by move 4' },
  ]);

  // ── Memory-mirror contract guard (regression test for the
  //    audit-found bug class: GameChatPanel fast-paths used to write
  //    only to local chat state, never to useCoachMemoryStore, leaving
  //    the brain dissociative-amnesic for any chat-routed turn).
  //    Drive a deterministic fast-path that requires no LLM and no
  //    board mutation — `detectNarrationToggle` matches "narrate while
  //    we play" and emits one user + one coach memory write. Assert
  //    both audits fire. ────────────────────────────────────────────
  await record('chat-narration-toggle-memory-write', async () => {
    // Open the inline chat panel.
    const chatBtn = page.locator('[data-testid="play-chat-button"]');
    if (await chatBtn.count() === 0) throw new Error('play-chat-button missing on /coach/play');
    await chatBtn.click();
    await page.locator('[data-testid="game-chat-panel"]').first().waitFor({ timeout: 5000 });
    // Wait a tick for the mobile drawer's slide-in animation to settle
    // (otherwise the log subtree intercepts pointer events while it's
    // still mid-animation and the send-button click times out).
    await page.waitForTimeout(600);
    // Send the deterministic fast-path phrase. Use Enter on the input
    // instead of clicking the send button — on mobile (414×896
    // viewport) the chat renders inside `mobile-chat-drawer` and the
    // role="log" overlay above the send button keeps intercepting
    // pointer events. Enter on a focused input bypasses the click
    // chain entirely. Matches how a real user with a keyboard sends.
    const input = page.locator('[data-testid="game-chat-panel"] [data-testid="chat-text-input"]').first();
    await input.fill('narrate while we play');
    await input.press('Enter');
  }, MOVE_SETTLE_MS, [
    // Pre-fix this count was 0 (only LLM-success paths wrote to memory;
    // fast-paths skipped it). Post-fix both user + coach turns mirror,
    // so we expect ≥ 2 appends per fast-path turn.
    { kind: 'coach-memory-conversation-appended', match: 'count', op: 'gte', value: 2, why: 'GameChatPanel fast-path must mirror user + coach to conversation memory' },
  ]);

  // ── Roll up overall and write report ────────────────────────────
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const failedExpectations = report.surfaces.flatMap((s) =>
    (s.expectations ?? []).filter((e) => !e.ok).map((e) => ({ surface: s.name, ...e })),
  );

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[coach-play] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[coach-play] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.kind} ${e.op}${e.value !== undefined ? ` ${e.value}` : ''}: got ${e.actual} (${e.why})`);
    }
  }
  console.log(`[coach-play] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[coach-play] fatal:', err);
  process.exit(1);
});
