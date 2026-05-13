#!/usr/bin/env node
/**
 * Drives the Settings UI in a headless browser and verifies that
 * behavior-critical settings actually take effect on downstream
 * surfaces. Pairs each setting change with a relevant action on a
 * runtime surface, intercepts the auditor's POSTs, and asserts the
 * expected event pattern (or absence) was emitted.
 *
 * Usage:
 *   node scripts/audit-settings-behavior.mjs              # against localhost
 *   AUDIT_SMOKE_URL=https://chess-academy-pro.vercel.app node scripts/audit-settings-behavior.mjs
 *
 * Output: stdout summary + audit-reports/settings-behavior-<iso>.json
 *
 * Each test case (TestSpec) has:
 *   - label:          short human description
 *   - prep:           async (page) => set the Settings field
 *   - exercise:       async (page) => take an action on a surface
 *   - assert:         (events) => { ok, why } — inspects captured POSTs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const STREAM_URL_PROD = 'https://chess-academy-pro.vercel.app/api/audit-stream';
const STREAM_URL_LOCAL = `${BASE_URL}/api/audit-stream`;

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
  });
  // Auditor pushes to prod /api/audit-stream when localStorage is set.
  // We don't care WHERE it tries to push — we intercept the POST body.
  await ctx.addInitScript(({ url, secret }) => {
    try {
      window.localStorage.setItem('auditStreamUrl', url);
      window.localStorage.setItem('auditStreamSecret', secret);
    } catch {
      /* ignore */
    }
  }, { url: STREAM_URL_PROD, secret: SECRET });

  const page = await ctx.newPage();

  const captured = [];
  page.on('request', (req) => {
    const u = req.url();
    if ((u === STREAM_URL_PROD || u === STREAM_URL_LOCAL) && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body && typeof body === 'object') captured.push(body);
      } catch {
        /* ignore */
      }
    }
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`); });

  // ── Helpers ─────────────────────────────────────────────────────
  async function openSettings() {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
    // Wait for either the settings page or the boot splash to give way.
    await page.locator('[data-testid="settings-page"]').waitFor({ timeout: 30_000 });
  }
  async function pickCoachTab() {
    await page.locator('[data-testid="tab-coach"]').click();
    await page.locator('[data-testid="coach-tab"]').waitFor({ timeout: 5000 });
  }
  async function pickBoardTab() {
    await page.locator('[data-testid="tab-board"]').click();
    await page.locator('[data-testid="board-tab"]').waitFor({ timeout: 5000 });
  }
  async function setCoachNarration(value) {
    await pickCoachTab();
    // The Coach Narration SelectRow lives inside the "Gameplay
    // Coaching" SettingsModalRow — open it first.
    const modalAlreadyOpen = await page.locator('[data-testid="gameplay-coaching-row-modal"]').count();
    if (modalAlreadyOpen === 0) {
      await page.locator('[data-testid="gameplay-coaching-row"]').click();
      await page.locator('[data-testid="gameplay-coaching-row-modal"]').waitFor({ timeout: 5000 });
    }
    await page.locator('[data-testid="coach-narration-select"]').selectOption(value);
    await page.waitForTimeout(400);
    // Close the modal so subsequent navigation doesn't get caught by it.
    await page.locator('[data-testid="gameplay-coaching-row-close"]').click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  async function snapshot() {
    return captured.length;
  }
  function eventsSince(idx) {
    return captured.slice(idx);
  }
  function eventsHaveKind(events, kind) {
    return events.some((e) => e.kind === kind);
  }

  // ── Test specs ──────────────────────────────────────────────────
  const tests = [
    {
      label: 'Coach Narration = "silent" → no voice-speak-invoked on /coach/teach Vienna walkthrough',
      run: async () => {
        await openSettings();
        await setCoachNarration('silent');
        const before = await snapshot();
        await page.goto(`${BASE_URL}/coach/teach?subject=Vienna%20Game`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);
        const events = eventsSince(before);
        const speaks = events.filter((e) => e.kind === 'voice-speak-invoked');
        return {
          ok: speaks.length === 0,
          why: `${speaks.length} voice-speak-invoked events; expected 0`,
          events,
        };
      },
    },
    {
      label: 'Coach Narration = "full" → voice-speak-invoked fires on /coach/teach Vienna',
      run: async () => {
        await openSettings();
        await setCoachNarration('full');
        const before = await snapshot();
        await page.goto(`${BASE_URL}/coach/teach?subject=Vienna%20Game`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);
        const events = eventsSince(before);
        const speaks = events.filter((e) => e.kind === 'voice-speak-invoked');
        return {
          ok: speaks.length > 0,
          why: `${speaks.length} voice-speak-invoked events; expected ≥1`,
          events,
        };
      },
    },
    {
      label: 'Coach Narration = "brief" → voice-speak-invoked fires (using shortText)',
      run: async () => {
        await openSettings();
        await setCoachNarration('brief');
        const before = await snapshot();
        await page.goto(`${BASE_URL}/coach/teach?subject=Vienna%20Game`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(8000);
        const events = eventsSince(before);
        const speaks = events.filter((e) => e.kind === 'voice-speak-invoked');
        return {
          ok: speaks.length > 0,
          why: `${speaks.length} voice-speak-invoked events; expected ≥1`,
          events,
        };
      },
    },
    {
      label: 'Settings page renders the unified Coach Narration row (no legacy verbosity controls)',
      run: async () => {
        await openSettings();
        await pickCoachTab();
        await page.locator('[data-testid="gameplay-coaching-row"]').click();
        await page.locator('[data-testid="gameplay-coaching-row-modal"]').waitFor({ timeout: 5000 });
        const hasUnified = await page.locator('[data-testid="coach-narration-select"]').count();
        const hasLegacyVerbosity = await page.locator('[data-testid="coach-verbosity-select"]').count();
        const hasLegacyCommentary = await page.locator('[data-testid="coach-commentary-verbosity-select"]').count();
        return {
          ok: hasUnified === 1 && hasLegacyVerbosity === 0 && hasLegacyCommentary === 0,
          why: `unified=${hasUnified}, legacyVerbosity=${hasLegacyVerbosity}, legacyCommentary=${hasLegacyCommentary}`,
          events: [],
        };
      },
    },
  ];

  // ── Execute ─────────────────────────────────────────────────────
  const results = [];
  for (const t of tests) {
    console.log(`\n[test] ${t.label}`);
    try {
      const r = await t.run();
      console.log(`  ${r.ok ? '✓ PASS' : '✗ FAIL'} — ${r.why}`);
      if (!r.ok && r.events && r.events.length > 0) {
        console.log('  Captured kinds: ', [...new Set(r.events.map((e) => e.kind))].join(', '));
      }
      results.push({ label: t.label, ok: r.ok, why: r.why, eventKinds: r.events ? [...new Set(r.events.map((e) => e.kind))] : [] });
    } catch (err) {
      console.log(`  ✗ ERROR — ${err.message}`);
      results.push({ label: t.label, ok: false, why: `error: ${err.message}` });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[summary] ${passed}/${results.length} passed`);
  if (consoleErrors.length > 0) {
    console.log(`[console-errors] ${consoleErrors.length}:`);
    consoleErrors.slice(0, 5).forEach((m) => console.log(`  ${m}`));
  }

  await mkdir('audit-reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(
    join('audit-reports', `settings-behavior-${stamp}.json`),
    JSON.stringify({ base: BASE_URL, results, consoleErrors, totalEvents: captured.length }, null, 2),
  );

  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[settings-behavior] fatal:', err);
  process.exit(1);
});
