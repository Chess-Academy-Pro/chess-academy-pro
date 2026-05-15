#!/usr/bin/env node
/**
 * Audit-coach-chat — drives /coach/chat end-to-end against the
 * deployed app. Mirrors audit-coach-play.mjs / audit-coach-review.mjs.
 *
 * `CoachChatPage` has several deterministic fast-paths that fire
 * BEFORE the slow LLM round-trip:
 *   - detectNarrationToggle  → applyNarrationToggle + navigate(...)
 *   - READ_THIS_RE           → voiceService.speakForced
 *   - routeChatIntent        → fast-path routes (play-against,
 *                              walkthrough, weakest-opening, etc.)
 * This audit drives only deterministic paths so it stays under a
 * minute per run and doesn't depend on an LLM provider being up.
 *
 * Surfaces / behaviors exercised:
 *   Hub render + Coach Chat tile click → /coach/chat
 *   Page mounts with greeting + 6 starter chips + voice toggle
 *   Voice toggle click flips state (mute / unmute)
 *   Chip "What's my worst opening?" → weakest-opening fast-path
 *     · appends user + assistant message, no LLM call
 *     · stays on /coach/chat (no navigation)
 *   Chip "Walk me through the Sicilian" → walkthrough intent
 *     · navigates to /coach/session/walkthrough?subject=...
 *   ?q= URL param auto-sends on mount and clears itself from URL
 *
 * Usage:
 *   node scripts/audit-coach-chat.mjs
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-chat.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-coach-chat.mjs
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
const OUT_DIR = `audit-reports/coach-chat-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 3500;
const NAV_SETTLE_MS = 1500;
const HYDRATE_SETTLE_MS = 1500;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[coach-chat] base    = ${BASE_URL}`);
  console.log(`[coach-chat] outDir  = ${OUT_DIR}`);
  console.log(`[coach-chat] headed  = ${HEADED}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[coach-chat] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachChatBot/1.0 (chromium)',
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
    console.log(`\n[coach-chat] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

    const expectationResults = [];
    for (const exp of expectations) {
      let ok = false;
      let actual = '?';
      try {
        if (exp.kind === 'visible') {
          const count = await page.locator(exp.selector).count();
          const visible = count > 0
            ? await page.locator(exp.selector).first().isVisible().catch(() => false)
            : false;
          actual = visible ? 'visible' : `not-visible (count=${count})`;
          ok = visible;
        } else if (exp.kind === 'count-gte') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count >= exp.value;
        } else if (exp.kind === 'count-eq') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count === exp.value;
        } else if (exp.kind === 'url-matches') {
          actual = page.url();
          ok = exp.value.test(actual);
        } else if (exp.kind === 'url-not-matches') {
          actual = page.url();
          ok = !exp.value.test(actual);
        } else if (exp.kind === 'audit-present') {
          actual = kinds[exp.audit] ? 'present' : 'absent';
          ok = !!kinds[exp.audit];
        } else if (exp.kind === 'text-contains') {
          const text = await page.locator(exp.selector).first().textContent().catch(() => '');
          actual = (text ?? '').slice(0, 80);
          ok = (text ?? '').toLowerCase().includes(exp.value.toLowerCase());
        } else if (exp.kind === 'memory-history-gte') {
          // Read `coachMemory.v1` from Dexie's meta store and assert
          // `conversationHistory.length` is >= the threshold. Used to
          // verify fast-path turns mirror into the spine's conversation
          // memory (audit finding: pre-fix this was always 0 because
          // narration toggle / read-this / intent router all skipped
          // the memory write).
          const count = await page.evaluate(async () => {
            return new Promise((resolve) => {
              const req = indexedDB.open('ChessAcademyDB');
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('meta')) { resolve(0); return; }
                const tx = db.transaction('meta', 'readonly');
                const g = tx.objectStore('meta').get('coachMemory.v1');
                g.onsuccess = () => {
                  const val = g.result?.value;
                  try {
                    const parsed = val ? JSON.parse(val) : { conversationHistory: [] };
                    const hist = parsed?.conversationHistory ?? [];
                    resolve(hist.length);
                  } catch {
                    resolve(0);
                  }
                };
                g.onerror = () => resolve(0);
              };
              req.onerror = () => resolve(0);
            });
          });
          actual = String(count);
          ok = count >= exp.value;
        }
      } catch (err) {
        actual = `error: ${err.message}`;
      }
      const result = { ...exp, actual, ok };
      expectationResults.push(result);
      console.log(`  ${ok ? '✓' : '✗'} ${exp.label} → ${actual}`);
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

  // ── Boot ────────────────────────────────────────────────────────
  await record('boot-dashboard', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
  }, 5000);

  // ── /coach/chat direct nav ─────────────────────────────────────
  await record('coach-chat-direct', async () => {
    await page.goto(`${BASE_URL}/coach/chat`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-chat-page"]').waitFor({ timeout: 15000 });
    // Wait for the session-store hydrate() to settle so the greeting
    // surface (which is gated on chatMessages.length === 0) reflects
    // a clean state instead of leftover messages from a prior run.
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-chat-page"]', label: 'page root mounts' },
    { kind: 'visible', selector: '[data-testid="voice-toggle"]', label: 'voice toggle present' },
    { kind: 'visible', selector: '[data-testid="chat-input"]', label: 'chat input present' },
    { kind: 'visible', selector: '[data-testid="chat-text-input"]', label: 'text-input present' },
  ]);

  // ── Greeting + 6 starter chips ─────────────────────────────────
  // The greeting only renders when chatMessages.length === 0; if the
  // hydrate brought in a prior session, no chips. Clear the session
  // first so we start clean.
  await record('clear-session', async () => {
    await page.evaluate(async () => {
      // Wipe both coach session messages AND conversation memory so
      // each audit run starts from a known zero state. Without wiping
      // memory the memory-history-gte expectations under chip drives
      // would always trivially pass because of leftover entries from
      // prior runs / human use of the deployment.
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
    // Reload to re-mount with cleared state.
    await page.goto(`${BASE_URL}/coach/chat`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-chat-page"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, SHORT_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-greeting"]', label: 'greeting visible on empty session' },
    { kind: 'count-eq', selector: '[data-testid="coach-starter-chip"]', value: 6, label: '6 starter chips render' },
  ]);

  // ── Voice toggle click ─────────────────────────────────────────
  await record('voice-toggle-click', async () => {
    const toggle = page.locator('[data-testid="voice-toggle"]');
    await toggle.click();
    await page.waitForTimeout(300);
    await toggle.click(); // back to default
  }, NAV_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="voice-toggle"]', label: 'voice toggle still present after click' },
  ]);

  // ── Fast-path: "What's my worst opening?" chip ─────────────────
  // Hits WEAKEST_OPENING_RE inside routeChatIntent → returns
  // ackMessage with no LLM call and no navigation. Verifies the
  // deterministic Dexie-lookup intent path.
  await record('chip-worst-opening', async () => {
    const chip = page.locator('[data-testid="coach-starter-chip"]').filter({ hasText: /worst opening/i });
    if (await chip.count() === 0) throw new Error('worst-opening chip missing');
    await chip.first().click();
    await page.waitForTimeout(2500);
  }, NAV_SETTLE_MS, [
    { kind: 'url-not-matches', value: /\/coach\/session\//, label: 'no nav off /coach/chat' },
    { kind: 'count-gte', selector: '[data-testid="chat-message-user"]', value: 1, label: 'user message appended' },
    { kind: 'count-gte', selector: '[data-testid="chat-message-assistant"]', value: 1, label: 'assistant ack appended' },
    // Memory-mirror contract: fast-path turns must land in conversation
    // memory so the brain's next envelope reflects the turn.
    { kind: 'memory-history-gte', value: 2, label: 'memory store mirrors user + ack pair' },
  ]);

  // ── Fast-path: walkthrough intent ──────────────────────────────
  // Going through the chat input so we can use a phrase that hits
  // parseCoachIntent's walkthrough branch — "walk me through the
  // Sicilian" maps to a known opening so it navigates. Avoids
  // re-using the chip (a re-click on the same chip doesn't fire if
  // the textarea-disabled state hasn't reset).
  await record('walkthrough-intent', async () => {
    const input = page.locator('[data-testid="chat-text-input"]');
    await input.click();
    await input.fill('walk me through the Italian');
    await page.locator('[data-testid="chat-send-btn"]').click();
    // routeChatIntent navigates synchronously after the ack message
    // is appended; the destination is /coach/session/walkthrough.
    await page.waitForTimeout(3500);
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/session\/walkthrough/, label: 'routed to /coach/session/walkthrough' },
  ]);

  // ── Back to /coach/chat for the next probe ─────────────────────
  await record('back-to-chat', async () => {
    await page.goto(`${BASE_URL}/coach/chat`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-chat-page"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  });

  // ── ?q= URL-param auto-send ────────────────────────────────────
  // Reload with ?q=<weakest-opening text> and verify it (a) auto-
  // fires the handler, (b) appends a user message, (c) strips the
  // param from the URL.
  await record('q-param-autosend', async () => {
    await page.goto(`${BASE_URL}/coach/chat?q=What%27s%20my%20worst%20opening%3F`, {
      waitUntil: 'domcontentloaded',
      timeout: BOOT_TIMEOUT_MS,
    });
    await page.locator('[data-testid="coach-chat-page"]').waitFor({ timeout: 15000 });
    // autoSend fires inside an effect after hydrate completes; allow
    // a couple of seconds for the user + assistant pair to land.
    await page.waitForTimeout(3500);
  }, SHORT_SETTLE_MS, [
    { kind: 'url-not-matches', value: /[?&]q=/, label: '?q= stripped from URL after autosend' },
    { kind: 'count-gte', selector: '[data-testid="chat-message-user"]', value: 1, label: 'autosent user message rendered' },
    { kind: 'count-gte', selector: '[data-testid="chat-message-assistant"]', value: 1, label: 'assistant ack rendered' },
  ]);

  // ── Roll up + write report ─────────────────────────────────────
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
    `\n[coach-chat] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[coach-chat] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
    }
  } else {
    console.log(`[coach-chat] all expectations passed`);
  }
  console.log(`[coach-chat] report: ${OUT_DIR}/report.json`);

  await browser.close();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[coach-chat] fatal:', err);
  process.exit(1);
});
