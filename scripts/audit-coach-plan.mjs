#!/usr/bin/env node
/**
 * Audit-coach-plan — drives /coach/plan (Training Plan tab) end-to-end
 * and verifies the full LLM + narration round-trip. Sits in the
 * Post-Deploy Audit matrix for any change that touches the plan
 * surface or its supporting spine.
 *
 * Surfaces / behaviors exercised:
 *   - /coach/home → "Training Plan" tile → /coach/plan navigation
 *   - Initial render: loading state, then plan blocks + explanation
 *   - Spine round-trip: ask-received → envelope-assembled →
 *     provider-called → answer-returned (plus model-selected pair
 *     for the Anthropic/DeepSeek fallback chain)
 *   - Voice narration: at least one coach-narration-spoken event
 *     fires from the explanation stream
 *   - Streaming narration sanity: same text shouldn't be spoken more
 *     than 3× in quick succession (regression guard for the duplicate
 *     "Alright" / sentence-loop bug seen in earlier prod audits)
 *   - Pushback round-trip: typing an adjustment fires a second spine
 *     turn and re-renders the plan
 *   - Back button returns to /coach
 *
 * Default target = prod (chess-academy-pro.vercel.app). Override:
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-plan.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-coach-plan.mjs
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { startAuditListener } from './audit-lib/audit-listener.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const PROD_SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
// Use the local sidecar listener when running against localhost — the
// browser POSTs go to a real handler we control, so we verify the
// full streaming round-trip (not just the outgoing body via
// page.on('request')). Against prod we still use the deployed
// /api/audit-stream endpoint.
const USE_SIDECAR = BASE_URL.includes('localhost');
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-plan-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const HYDRATE_SETTLE_MS = 1500;
const NAV_SETTLE_MS = 1500;
const SHORT_SETTLE_MS = 3500;
// Plan generation calls generateCoachSession (deterministic) plus a
// streaming spine ask for the explanation. End-to-end on prod runs
// 8-15s. Allow 30s before declaring a failure.
const PLAN_READY_TIMEOUT_MS = 30_000;
// The streaming spine response takes a few extra seconds after the
// start button surfaces before all narration sentences land.
const NARRATION_SETTLE_MS = 6000;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[coach-plan] base    = ${BASE_URL}`);
  console.log(`[coach-plan] outDir  = ${OUT_DIR}`);
  console.log(`[coach-plan] headed  = ${HEADED}`);

  // Stand up a sidecar /audit-stream listener when targeting localhost
  // so the browser's POSTs land on a real handler and we can verify
  // the round-trip (POST in → GET out). Against prod we point at the
  // deployed endpoint as before.
  const listener = USE_SIDECAR ? await startAuditListener() : null;
  const STREAM_URL = listener?.url ?? `${BASE_URL}/api/audit-stream`;
  const SECRET = listener?.secret ?? PROD_SECRET;
  if (listener) console.log(`[coach-plan] listener = ${listener.url} (sidecar)`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[coach-plan] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachPlanBot/1.0 (chromium)',
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
    console.log(`\n[coach-plan] ${name}  →  ${url}`);
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
        } else if (exp.kind === 'invisible') {
          const count = await page.locator(exp.selector).count();
          actual = `count=${count}`;
          ok = count === 0;
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
        } else if (exp.kind === 'audit-count-gte') {
          const n = kinds[exp.audit] ?? 0;
          actual = String(n);
          ok = n >= exp.value;
        } else if (exp.kind === 'text-contains') {
          const text = await page.locator(exp.selector).first().textContent().catch(() => '');
          actual = (text ?? '').slice(0, 80);
          ok = (text ?? '').toLowerCase().includes(exp.value.toLowerCase());
        } else if (exp.kind === 'text-length-gte') {
          const text = await page.locator(exp.selector).first().textContent().catch(() => '');
          actual = String((text ?? '').length);
          ok = (text ?? '').length >= exp.value;
        } else if (exp.kind === 'narration-duplicate-cap') {
          // Regression guard: count coach-narration-spoken events per
          // textPreview; fail if any text appears more than `value`
          // times in this surface's window. The streaming-speaker bug
          // surfaced as the same opener ("Alright.") narrated 5+ times
          // in a row as new chunks arrived — see audit logs from
          // 2026-05-15 (build 36b7472).
          const counts = new Map();
          for (const ev of fresh) {
            if (ev.kind !== 'coach-narration-spoken') continue;
            // Extract textPreview from the structured payload that
            // narration audits carry. Fall back to summary line for
            // older event shapes.
            let text = '';
            try {
              const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
              text = String(payload?.textPreview ?? ev.summary ?? '').slice(0, 60);
            } catch {
              text = String(ev.summary ?? '').slice(0, 60);
            }
            counts.set(text, (counts.get(text) ?? 0) + 1);
          }
          const offenders = [...counts.entries()].filter(([, n]) => n > exp.value);
          actual = offenders.length === 0
            ? `max=${Math.max(0, ...counts.values())}`
            : `over-cap: ${offenders.map(([t, n]) => `"${t.slice(0, 24)}"×${n}`).join(', ')}`;
          ok = offenders.length === 0;
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

  // ── Boot ─────────────────────────────────────────────────────────
  await record('boot-dashboard', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS });
  }, 4000, [
    { kind: 'audit-present', audit: 'app-boot', label: 'app-boot audit fires' },
  ]);

  // ── /coach/home ──────────────────────────────────────────────────
  await record('coach-home', async () => {
    await page.goto(`${BASE_URL}/coach/home`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-action-plan"]', label: 'Training Plan tile present' },
  ]);

  // ── Tile click → /coach/plan ─────────────────────────────────────
  await record('plan-tile-click', async () => {
    const tile = page.locator('[data-testid="coach-action-plan"]');
    await tile.click();
    await page.waitForURL(/\/coach\/plan/, { timeout: 10_000 });
    await page.locator('[data-testid="coach-session-plan-page"]').waitFor({ timeout: 15_000 });
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/plan/, label: 'navigated to /coach/plan' },
    { kind: 'visible', selector: '[data-testid="coach-session-plan-page"]', label: 'plan page root mounts' },
    { kind: 'audit-present', audit: 'coach-hub-tile-clicked', label: 'tile click audit fires' },
    { kind: 'audit-present', audit: 'route-changed', label: 'route change audit fires' },
  ]);

  // ── Plan generation + streaming explanation ──────────────────────
  // The spine round-trip emits the full envelope (ask-received,
  // envelope-assembled, provider-called, answer-returned) plus the
  // model-selected pair. Streaming narration drops one coach-
  // narration-spoken per sentence boundary.
  await record('plan-generation', async () => {
    // Wait for the Start Session button to surface — only renders
    // once plan generation has settled (loading flag flips off).
    await page.locator('[data-testid="start-session-btn"]').waitFor({ timeout: PLAN_READY_TIMEOUT_MS });
    // Give streaming narration a moment to drain after the button
    // appears so audit counts reflect the full session.
    await page.waitForTimeout(NARRATION_SETTLE_MS);
  }, 1500, [
    { kind: 'visible', selector: '[data-testid="start-session-btn"]', label: 'Start Session button rendered' },
    { kind: 'visible', selector: '[data-testid="plan-explanation"]', label: 'plan explanation text rendered' },
    { kind: 'text-length-gte', selector: '[data-testid="plan-explanation"]', value: 80, label: 'explanation has substantive content (>=80 chars)' },
    { kind: 'audit-present', audit: 'coach-brain-ask-received', label: 'spine: ask received' },
    { kind: 'audit-present', audit: 'coach-brain-envelope-assembled', label: 'spine: envelope assembled' },
    { kind: 'audit-present', audit: 'coach-brain-provider-called', label: 'spine: provider called' },
    { kind: 'audit-present', audit: 'coach-brain-answer-returned', label: 'spine: answer returned' },
    { kind: 'audit-present', audit: 'coach-llm-model-selected', label: 'model selection logged' },
    { kind: 'audit-present', audit: 'coach-narration-spoken', label: 'narration spoken at least once' },
    // Regression guard for the duplicate-narration streaming bug
    // (audit-driven finding 2026-05-15): same sentence narrated
    // 5+ times back-to-back when streaming chunks re-dispatch the
    // first sentence. Allow up to 3 same-text utterances to give
    // streamingSpeaker.add() de-dup some headroom.
    { kind: 'narration-duplicate-cap', value: 3, label: 'no sentence narrated more than 3× (streaming-dup guard)' },
  ]);

  // ── Pushback / adjustment round-trip ─────────────────────────────
  // The plan page hosts a ChatInput at the bottom; sending text
  // triggers handlePushback → generateCoachSession(text) → second
  // spine round-trip with the adjusted plan.
  await record('plan-pushback', async () => {
    const input = page.locator('[data-testid="chat-text-input"]');
    if ((await input.count()) === 0) throw new Error('chat-text-input missing on plan page');
    await input.click();
    await input.fill('shorter please, 20 minutes max');
    await page.locator('[data-testid="chat-send-btn"]').click();
    // Adjustment streams in over a few seconds; wait for narration
    // settle to land too.
    await page.waitForTimeout(PLAN_READY_TIMEOUT_MS / 2);
  }, NARRATION_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/plan/, label: 'stays on /coach/plan during adjust' },
    { kind: 'visible', selector: '[data-testid="start-session-btn"]', label: 'Start Session still rendered post-adjust' },
    { kind: 'audit-count-gte', audit: 'coach-brain-ask-received', value: 1, label: 'adjustment fires another spine turn' },
    { kind: 'audit-count-gte', audit: 'coach-brain-answer-returned', value: 1, label: 'adjustment receives an answer' },
  ]);

  // ── Back to /coach via header back button ────────────────────────
  // The plan page header has a chevron-left that navigates to
  // /coach (the hub). Verify it doesn't accidentally land somewhere
  // else.
  await record('plan-back-button', async () => {
    // Header back button is an unlabeled <button> with an
    // ArrowLeft icon — locate by its position in the header.
    const back = page.locator('[data-testid="coach-session-plan-page"] >> button').first();
    if ((await back.count()) === 0) throw new Error('header back button missing');
    await back.click();
    await page.waitForTimeout(800);
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach(\/home)?(\?|$|\/)/, label: 'lands on /coach or /coach/home' },
    { kind: 'url-not-matches', value: /\/coach\/plan/, label: 'no longer on /coach/plan' },
  ]);

  // ── Roll up + write report ──────────────────────────────────────
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

  // Round-trip check: when running with the sidecar listener, compare
  // browser-side intercepted POST bodies against what the listener
  // actually received and stored. Any divergence means a POST failed
  // server-side (network error, secret mismatch, malformed body)
  // even though the browser thought it sent.
  if (listener) {
    const listenerEvents = listener.getCapturedEvents();
    report.listenerRoundTrip = {
      browserSidePOSTs: captured.length,
      listenerSideReceived: listenerEvents.length,
      mismatch: captured.length !== listenerEvents.length,
      kindCountsListener: listener.countByKind(),
      narrationSampleFromListener: listener
        .eventsOfKind('coach-narration-spoken')
        .slice(0, 5)
        .map((e) => ({
          textPreview:
            (typeof e.payload === 'object' ? e.payload?.textPreview : null) ??
            String(e.summary ?? '').slice(0, 80),
          timestamp: e.timestamp,
        })),
    };
    console.log(
      `[coach-plan] listener: browser-sent=${captured.length}  server-received=${listenerEvents.length}  ${report.listenerRoundTrip.mismatch ? '⚠ MISMATCH' : '✓ round-trip ok'}`,
    );
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[coach-plan] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[coach-plan] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
    }
  } else {
    console.log(`[coach-plan] all expectations passed`);
  }
  console.log(`[coach-plan] report: ${OUT_DIR}/report.json`);

  await browser.close();
  if (listener) await listener.stop();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[coach-plan] fatal:', err);
  process.exit(1);
});
