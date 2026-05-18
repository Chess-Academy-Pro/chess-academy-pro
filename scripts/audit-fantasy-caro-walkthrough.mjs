#!/usr/bin/env node
/**
 * Post-deploy audit for commit 1aab2e39: Fantasy Variation vs Caro-Kann
 * walkthrough should narrate FANTASY-specific concepts (3.f3, fxe4
 * recapture, e4-d4 pawn duo) — NOT generic Caro-Kann Classical
 * theory (e.g. recommending Nxe4 recapture).
 *
 * Surface: /openings/pro/gothamchess/pro-gothamchess-fantasy-caro
 * Bundle expected: /assets/index-B_uxsfH9.js
 *
 * PASS heuristics (any of these in narration):
 *   - "f3" / "f-file" / "fxe4" / "Bc4" pointing at a2-g8 diagonal
 *   - "Fantasy" / "Gotham" / "Levy" / "Bronstein" / "Maroczy" / gambit
 *
 * FAIL heuristics:
 *   - Unconditional fallback string "Continuing this line:"
 *   - "Nxe4" or "knight takes" recommended as student move (Fantasy
 *     uses fxe4, not Nxe4)
 *   - Empty / whitespace-only narration
 *   - "Classical Caro" mentioned without an explicit Fantasy contrast
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
const TARGET = '/openings/pro/gothamchess/pro-gothamchess-fantasy-caro';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/fantasy-caro-walkthrough-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
// 14 plies × ~3 s/move + LLM enrich latency budget. We poll for the
// move-label changing so we don't have to depend on perfect timing.
const PER_MOVE_TIMEOUT_MS = 12_000;
const TOTAL_PLIES = 14;

const FAIL_PATTERNS = [
  { label: 'unconditional-fallback', re: /Continuing this line:/i },
  { label: 'recommends-Nxe4', re: /\bNxe4\b/ },
  { label: 'recommends-knight-takes', re: /\bknight\s+(?:takes|captur)\w*\s+(?:the\s+)?(?:e4|pawn)/i },
];
const PASS_PATTERNS = [
  { label: 'mentions-f3', re: /\b(?:f3|3\.f3)\b/ },
  { label: 'mentions-f-file', re: /\bf[-\s]?file\b/i },
  { label: 'mentions-fxe4', re: /\bfxe4\b/ },
  { label: 'mentions-Fantasy', re: /\bFantasy\b/ },
  { label: 'mentions-Bc4-diagonal', re: /\bBc4\b|\ba2[-–]g8\b/i },
  { label: 'mentions-pawn-duo', re: /\b(?:e4[-–]d4|d4[-–]e4|pawn\s+duo|big\s+center)/i },
  { label: 'mentions-Gotham-or-Levy', re: /\b(?:Gotham|Levy)\b/i },
  { label: 'mentions-Bronstein-or-Maroczy', re: /\b(?:Bronstein|Maroczy)\b/i },
  { label: 'mentions-gambit-style', re: /\bgambit\b/i },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[fantasy-caro] base=${BASE_URL} out=${OUT_DIR}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[fantasy-caro] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditFantasyCaroBot/1.0 (chromium)',
  });
  await ctx.addInitScript(({ url, secret }) => {
    try {
      window.localStorage.setItem('auditStreamUrl', url);
      window.localStorage.setItem('auditStreamSecret', secret);
    } catch {}
  }, { url: STREAM_URL, secret: SECRET });

  const page = await ctx.newPage();
  const captured = [];
  page.on('request', (req) => {
    if (req.url() === STREAM_URL && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body) captured.push(body);
      } catch {}
    }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500)); });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));

  // Capture bundle hash from the loaded HTML
  let bundleHash = 'unknown';
  page.on('response', (resp) => {
    const url = resp.url();
    const m = url.match(/\/assets\/(index-[A-Za-z0-9_]+\.js)/);
    if (m && bundleHash === 'unknown') bundleHash = m[1];
  });

  const report = {
    base: BASE_URL,
    target: TARGET,
    startedAt: stamp,
    bundleHash: null,
    narrations: [],
    failFlags: [],
    passFlags: [],
    walkthroughNarrationEmptyEvents: [],
    diagnostics: { consoleErrors: [], pageErrors: [], runtimeErrorEvents: [] },
  };

  console.log(`[fantasy-caro] booting at ${BASE_URL}/`);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  // Wait for the app shell to mount and the openings DB seed to start.
  await page.getByText('Chess Academy Pro', { exact: true }).first().waitFor({ timeout: BOOT_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(2500);

  // Visit /openings first so the Dexie openings store is seeded
  // before we navigate to a deep detail URL. Without this, the
  // detail page renders "Opening not found." because getOpeningById
  // races the seed write.
  console.log(`[fantasy-caro] warming openings DB via /openings`);
  await page.goto(`${BASE_URL}/openings`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 20_000 }).catch(() => {});
  // Click into Pro tab to ensure pro-repertoires are loaded into store
  await page.locator('[data-testid="tab-pro"]').click().catch(() => {});
  await page.waitForTimeout(2500);

  console.log(`[fantasy-caro] navigating to ${TARGET}`);
  await page.goto(`${BASE_URL}${TARGET}`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  // Poll: either the not-found copy appears, or the opening-detail
  // testid mounts. Bail with a clearer error if not-found.
  const detailReady = await Promise.race([
    page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 15_000 }).then(() => 'detail').catch(() => null),
    page.getByText('Opening not found.', { exact: true }).first().waitFor({ timeout: 15_000 }).then(() => 'not-found').catch(() => null),
  ]);
  console.log(`[fantasy-caro] detail state = ${detailReady}`);
  if (detailReady === 'not-found') {
    report.diagnostics.fatal = 'opening-id not resolvable in deployed openings DB';
    await page.screenshot({ path: join(OUT_DIR, '02-not-found.png'), fullPage: true }).catch(() => {});
    await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(`[fantasy-caro] FATAL: opening id resolved to not-found`);
    process.exit(3);
  }
  await page.waitForTimeout(2000);

  // Detect what surface we landed on. Some pro paths land on an
  // opening-detail (with walkthrough-btn) and some on pro-player-page.
  const urlAfter = page.url();
  console.log(`[fantasy-caro] landed at ${urlAfter}`);
  await page.screenshot({ path: join(OUT_DIR, '01-landing.png'), fullPage: true }).catch(() => {});

  // Try to find a "Walkthrough" / "Learn with Coach" entry control.
  // Order of preference: walkthrough-btn (opening-detail), then a
  // visible "Walkthrough" labelled button on a pro-player surface.
  const tryWalkthroughEntry = async () => {
    // 1) Standard opening-detail walkthrough button
    const wt = page.locator('[data-testid="walkthrough-btn"]').first();
    if (await wt.isVisible().catch(() => false)) {
      console.log('[fantasy-caro] clicking walkthrough-btn');
      await wt.click();
      return true;
    }
    // 2) Variation walkthrough tiles
    const varTid = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="variation-walkthrough-"]');
      return el?.getAttribute('data-testid') ?? null;
    });
    if (varTid) {
      console.log(`[fantasy-caro] clicking ${varTid}`);
      await page.locator(`[data-testid="${varTid}"]`).first().click();
      return true;
    }
    // 3) Buttons that look like walkthrough launch (text scan)
    const btn = page.getByRole('button', { name: /walkthrough|learn with coach|learn/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      console.log('[fantasy-caro] clicking text-labelled walkthrough/learn button');
      await btn.click();
      return true;
    }
    return false;
  };

  const launched = await tryWalkthroughEntry();
  if (!launched) {
    // Maybe the surface is itself a list — try to click the first opening card
    const firstCardTid = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-testid]'));
      const card = els.find((el) => /^opening-card-|^pro-line-/.test(el.getAttribute('data-testid') ?? ''));
      return card?.getAttribute('data-testid') ?? null;
    });
    if (firstCardTid) {
      console.log(`[fantasy-caro] clicking ${firstCardTid} to drill into an opening`);
      await page.locator(`[data-testid="${firstCardTid}"]`).first().click();
      await page.waitForTimeout(3000);
      await tryWalkthroughEntry();
    }
  }

  // Wait for walkthrough-mode to mount
  const mounted = await page.locator('[data-testid="walkthrough-mode"]')
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  if (!mounted) {
    console.log('[fantasy-caro] FATAL: walkthrough-mode did not mount');
    report.diagnostics.fatal = 'walkthrough-mode did not mount';
    await page.screenshot({ path: join(OUT_DIR, '02-no-walkthrough.png'), fullPage: true }).catch(() => {});
    await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(`[fantasy-caro] report at ${OUT_DIR}/report.json`);
    process.exit(2);
  }

  console.log('[fantasy-caro] walkthrough-mode mounted, settling for LLM enrich...');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: join(OUT_DIR, '03-walkthrough-ready.png'), fullPage: true }).catch(() => {});

  // Step through each move. We use the next-button (forward/skip)
  // rather than auto-play so timing is deterministic.
  const captureCurrent = async () => {
    // Move label and annotation text live in AnnotationCard.
    const label = await page.locator('[data-testid="annotation-move-label"]').first()
      .textContent({ timeout: 3000 }).catch(() => null);
    const text = await page.locator('[data-testid="annotation-text"]').first()
      .textContent({ timeout: 3000 }).catch(() => null);
    // Plans + alternatives carry pedagogy too
    const plans = await page.locator('[data-testid="annotation-plans"]')
      .textContent({ timeout: 1500 }).catch(() => null);
    const pawnStructure = await page.locator('[data-testid="annotation-pawn-structure"]')
      .textContent({ timeout: 1500 }).catch(() => null);
    return {
      label: (label ?? '').trim(),
      text: (text ?? '').trim(),
      plans: (plans ?? '').trim(),
      pawnStructure: (pawnStructure ?? '').trim(),
    };
  };

  // Look for the forward / next control. WalkthroughMode renders nav
  // buttons inside `controls`. Try the common testids; fall back to
  // ArrowRight key press which the strict-narration hook handles.
  const advance = async () => {
    const candidates = [
      '[data-testid="walkthrough-next"]',
      '[data-testid="walkthrough-forward"]',
      'button[aria-label*="Next" i]',
      'button[aria-label*="Forward" i]',
    ];
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    }
    // Last resort: keyboard
    await page.keyboard.press('ArrowRight');
    return true;
  };

  const seenLabels = new Set();
  // Try to capture the overview / move 0
  const initial = await captureCurrent();
  if (initial.label || initial.text) {
    report.narrations.push({ index: 0, ...initial });
    seenLabels.add(initial.label);
    console.log(`[fantasy-caro] move ${initial.label || '(overview)'} captured`);
  }

  for (let ply = 1; ply <= TOTAL_PLIES; ply++) {
    await advance();
    // Poll for the label to change
    const t0 = Date.now();
    let captured = null;
    while (Date.now() - t0 < PER_MOVE_TIMEOUT_MS) {
      await page.waitForTimeout(400);
      const snap = await captureCurrent();
      if (snap.label && !seenLabels.has(snap.label) && snap.text) {
        captured = snap;
        seenLabels.add(snap.label);
        break;
      }
    }
    if (!captured) {
      console.log(`[fantasy-caro] ply ${ply}: no new annotation captured (timeout)`);
      report.narrations.push({ index: ply, label: '(timeout)', text: '', plans: '', pawnStructure: '' });
      continue;
    }
    console.log(`[fantasy-caro] ply ${ply}: ${captured.label} — ${captured.text.slice(0, 80)}`);
    report.narrations.push({ index: ply, ...captured });
    if (ply % 4 === 0) {
      await page.screenshot({ path: join(OUT_DIR, `04-ply-${String(ply).padStart(2, '0')}.png`), fullPage: false }).catch(() => {});
    }
  }

  await page.screenshot({ path: join(OUT_DIR, '99-final.png'), fullPage: true }).catch(() => {});

  // ─── Classify each narration text against PASS / FAIL patterns ───
  for (const n of report.narrations) {
    const haystack = `${n.text} ${n.plans} ${n.pawnStructure}`;
    if (!n.text || /^\s*$/.test(n.text)) {
      report.failFlags.push({ ply: n.index, label: n.label, reason: 'empty-narration', snippet: '' });
      continue;
    }
    for (const fp of FAIL_PATTERNS) {
      if (fp.re.test(haystack)) {
        report.failFlags.push({ ply: n.index, label: n.label, reason: fp.label, snippet: n.text.slice(0, 200) });
      }
    }
    for (const pp of PASS_PATTERNS) {
      if (pp.re.test(haystack)) {
        report.passFlags.push({ ply: n.index, label: n.label, reason: pp.label, snippet: n.text.slice(0, 120) });
      }
    }
    // "Classical Caro" without an explicit Fantasy contrast in the SAME annotation
    if (/Classical\s+Caro/i.test(haystack) && !/Fantasy/i.test(haystack)) {
      report.failFlags.push({ ply: n.index, label: n.label, reason: 'classical-without-fantasy-contrast', snippet: n.text.slice(0, 200) });
    }
  }

  // ─── Pull the audit stream for walkthrough-narration-empty events ───
  // We already have captured (POSTed-from-browser) events. Also fetch
  // the server-side stream as a belt-and-braces step in case some
  // events were buffered.
  const sinceMs = Date.now() - 15 * 60 * 1000;
  try {
    const res = await fetch(`${STREAM_URL}?since=${sinceMs}`, {
      headers: { 'x-audit-secret': SECRET },
    });
    if (res.ok) {
      const data = await res.json();
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      report.walkthroughNarrationEmptyEvents = entries
        .filter((e) => String(e?.kind ?? '') === 'walkthrough-narration-empty')
        .map((e) => ({
          timestamp: e.timestamp,
          summary: e.summary ?? '',
          source: e.source ?? '',
          route: e.route ?? '',
          detail: e.detail ?? null,
        }));
      console.log(`[fantasy-caro] server stream: ${entries.length} events, ${report.walkthroughNarrationEmptyEvents.length} walkthrough-narration-empty`);
    } else {
      console.log(`[fantasy-caro] server stream fetch failed: ${res.status}`);
    }
  } catch (err) {
    console.log(`[fantasy-caro] server stream fetch error: ${String(err?.message ?? err)}`);
  }

  // Also surface in-browser captured events of the same kind
  const browserEmpties = captured.filter((e) => String(e?.kind ?? '') === 'walkthrough-narration-empty');
  report.walkthroughNarrationEmptyEvents = [
    ...report.walkthroughNarrationEmptyEvents,
    ...browserEmpties.map((e) => ({
      timestamp: e.timestamp ?? null,
      summary: e.summary ?? '',
      source: e.source ?? '',
      route: e.route ?? '',
      detail: e.detail ?? null,
      origin: 'browser-captured',
    })),
  ];

  report.bundleHash = bundleHash;
  report.diagnostics.consoleErrors = consoleErrors;
  report.diagnostics.pageErrors = pageErrors;
  report.diagnostics.runtimeErrorEvents = captured.filter((e) => {
    const k = String(e.kind ?? '').toLowerCase();
    return k === 'uncaught-error' || k === 'unhandled-rejection';
  });
  report.totalEventsCaptured = captured.length;

  // Verdict
  let verdict;
  if (!report.narrations.length) verdict = 'could-not-test';
  else if (report.failFlags.length === 0 && report.passFlags.length >= 3) verdict = 'fixed';
  else if (report.failFlags.length === 0) verdict = 'partially-fixed (no fails, weak fantasy signal)';
  else if (report.failFlags.length <= 2 && report.passFlags.length >= 3) verdict = 'partially-fixed';
  else verdict = 'still-broken';
  report.verdict = verdict;

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const md = [
    `# Fantasy Caro Walkthrough Audit — ${stamp}`,
    ``,
    `**Base:** ${BASE_URL}`,
    `**Target:** ${TARGET}`,
    `**Bundle:** ${bundleHash}`,
    `**Verdict:** ${verdict}`,
    ``,
    `## Counts`,
    `- Narrations captured: ${report.narrations.length}`,
    `- FAIL flags: ${report.failFlags.length}`,
    `- PASS flags: ${report.passFlags.length}`,
    `- walkthrough-narration-empty events: ${report.walkthroughNarrationEmptyEvents.length}`,
    `- console.errors: ${consoleErrors.length}`,
    `- page.errors: ${pageErrors.length}`,
    ``,
    `## Per-move narration`,
    ...report.narrations.flatMap((n) => [
      ``,
      `### ${n.label || `(ply ${n.index})`}`,
      ``,
      n.text ? `> ${n.text}` : `> _(empty)_`,
      n.plans ? `\n**Plans:** ${n.plans.slice(0, 200)}` : '',
      n.pawnStructure ? `\n**Pawn structure:** ${n.pawnStructure.slice(0, 200)}` : '',
    ]),
    ``,
    `## FAIL flags`,
    ...(report.failFlags.length
      ? report.failFlags.map((f) => `- **ply ${f.ply}** (${f.label}) — ${f.reason}: \`${f.snippet.slice(0, 160)}\``)
      : ['_None._']),
    ``,
    `## PASS flags`,
    ...(report.passFlags.length
      ? report.passFlags.slice(0, 20).map((f) => `- **ply ${f.ply}** (${f.label}) — ${f.reason}: \`${f.snippet.slice(0, 120)}\``)
      : ['_None._']),
    ``,
    `## walkthrough-narration-empty events`,
    ...(report.walkthroughNarrationEmptyEvents.length
      ? report.walkthroughNarrationEmptyEvents.map((e) => `- ${new Date(e.timestamp ?? 0).toISOString()} — ${e.summary} (${e.source})`)
      : ['_None — top-up path was satisfied._']),
  ];
  await writeFile(join(OUT_DIR, 'report.md'), md.filter(Boolean).join('\n'));

  console.log(`\n[fantasy-caro] DONE — verdict=${verdict}`);
  console.log(`[fantasy-caro] narrations=${report.narrations.length} fails=${report.failFlags.length} passes=${report.passFlags.length} empties=${report.walkthroughNarrationEmptyEvents.length}`);
  console.log(`[fantasy-caro] report at ${OUT_DIR}/report.json + report.md`);

  await browser.close();
}

main().catch((err) => { console.error('[fantasy-caro] fatal:', err); process.exit(1); });
