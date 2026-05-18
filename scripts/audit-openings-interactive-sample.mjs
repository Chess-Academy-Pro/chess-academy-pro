#!/usr/bin/env node
/**
 * Openings-tab INTERACTIVE audit (scoped).
 *
 * Companion to `audit-openings-deep-walkthrough.mjs`. Where the
 * deep-walk audit covers BREADTH (every subline, narration-only),
 * this script covers DEPTH (smaller sample, actual interaction with
 * the board + stage transitions). Strictly scoped to the openings
 * tab — no coach hub, no kid, no tactics, no weaknesses.
 *
 * Per subline:
 *   1. Navigate to /openings/<openingId>, mount detail page.
 *   2. Click the walkthrough launcher, walk ALL plies, capture
 *      annotation card.
 *   3. Exit walkthrough, click Practice (`practice-btn`).
 *   4. In Practice mode: drag the EXPECTED move's piece from source
 *      to destination square. Verify correct-flash OR wrong-flash.
 *   5. If correct, advance through 2-3 more plies.
 *   6. Exit Practice.
 *   7. Click Learn / Play if those entry points exist on the detail
 *      page, just verify they mount.
 *
 * Sample size: ~30 sublines spanning major opening families and
 * subline TYPES (main / variation / trap / warning). Target runtime
 * ~2-3 hours.
 *
 * Output: audit-reports/openings-interactive-<iso>/report.json + .md
 */

import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { Chess } from 'chess.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const SETTLE_AFTER_MOUNT_MS = 1500;
const PER_PLY_TIMEOUT_MS = 2500;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = process.env.AUDIT_OUT_DIR ?? `audit-reports/openings-interactive-${stamp}`;
const REPORT_PATH = join(OUT_DIR, 'report.json');
const SUMMARY_PATH = join(OUT_DIR, 'report.md');

// ─── Sample selection ──────────────────────────────────────────────

const SAMPLE_SUBLINES = [
  // ─── Pro repertoire mains ────────────────────────────────────────
  { openingId: 'pro-naroditsky-scotch', sublineType: 'main', sublineIndex: null },
  { openingId: 'pro-hikaru-najdorf',    sublineType: 'main', sublineIndex: null },
  { openingId: 'pro-carlsen-catalan',   sublineType: 'main', sublineIndex: null },
  { openingId: 'pro-caruana-ruy-lopez', sublineType: 'main', sublineIndex: null },
  { openingId: 'pro-firouzja-vienna',   sublineType: 'main', sublineIndex: null },
  // ─── Pro repertoire variations ───────────────────────────────────
  { openingId: 'pro-naroditsky-scotch', sublineType: 'variation', sublineIndex: 0 },
  { openingId: 'pro-hikaru-najdorf',    sublineType: 'variation', sublineIndex: 1 },
  { openingId: 'pro-naroditsky-alapin', sublineType: 'variation', sublineIndex: 0 },
  { openingId: 'pro-gothamchess-london',sublineType: 'variation', sublineIndex: 0 },
  { openingId: 'pro-naroditsky-vienna', sublineType: 'variation', sublineIndex: 5 },
  // ─── Pro trap lines ──────────────────────────────────────────────
  { openingId: 'pro-naroditsky-alapin', sublineType: 'trap', sublineIndex: 0 },
  { openingId: 'pro-gothamchess-italian', sublineType: 'trap', sublineIndex: 0 },
  { openingId: 'pro-carlsen-catalan',   sublineType: 'trap', sublineIndex: 0 },
  { openingId: 'pro-gothamchess-scandinavian', sublineType: 'trap', sublineIndex: 0 },
  // ─── Pro warning lines ──────────────────────────────────────────
  { openingId: 'pro-naroditsky-vienna', sublineType: 'warning', sublineIndex: 0 },
  // ─── Repertoire mains ────────────────────────────────────────────
  { openingId: 'italian-game',          sublineType: 'main', sublineIndex: null },
  { openingId: 'sicilian-najdorf',      sublineType: 'main', sublineIndex: null },
  { openingId: 'ruy-lopez',             sublineType: 'main', sublineIndex: null },
  { openingId: 'caro-kann',             sublineType: 'main', sublineIndex: null },
  { openingId: 'kings-gambit',          sublineType: 'main', sublineIndex: null },
  // ─── Repertoire variations ───────────────────────────────────────
  { openingId: 'italian-game',          sublineType: 'variation', sublineIndex: 0 },
  { openingId: 'sicilian-najdorf',      sublineType: 'variation', sublineIndex: 0 },
  { openingId: 'caro-kann',             sublineType: 'variation', sublineIndex: 4 },
  // ─── Repertoire traps ────────────────────────────────────────────
  { openingId: 'italian-game',          sublineType: 'trap', sublineIndex: 0 },
  { openingId: 'kings-gambit',          sublineType: 'trap', sublineIndex: 0 },
  { openingId: 'sicilian-najdorf',      sublineType: 'trap', sublineIndex: 0 },
  // ─── Repertoire warnings ─────────────────────────────────────────
  { openingId: 'italian-game',          sublineType: 'warning', sublineIndex: 0 },
  { openingId: 'caro-kann',             sublineType: 'warning', sublineIndex: 0 },
];

// ─── Helpers ────────────────────────────────────────────────────────

function pgnToSans(pgn) {
  const tokens = pgn.trim().split(/\s+/).filter(Boolean);
  const c = new Chess();
  const out = [];
  for (const tok of tokens) {
    try {
      const m = c.move(tok);
      out.push({ san: m.san, from: m.from, to: m.to });
    } catch {
      break;
    }
  }
  return out;
}

async function loadSubline(item) {
  const pro = JSON.parse(await readFile('./src/data/pro-repertoires.json', 'utf-8'));
  const rep = JSON.parse(await readFile('./src/data/repertoire.json', 'utf-8'));
  const repList = Array.isArray(rep) ? rep : Object.values(rep);
  const allOpenings = [...pro.openings, ...repList];
  const op = allOpenings.find((o) => o.id === item.openingId);
  if (!op) return null;
  let pgn = null, name = null;
  if (item.sublineType === 'main') {
    pgn = op.pgn; name = op.name;
  } else {
    const arr = item.sublineType === 'variation' ? op.variations
              : item.sublineType === 'trap' ? op.trapLines
              : item.sublineType === 'warning' ? op.warningLines
              : null;
    const sl = arr?.[item.sublineIndex];
    if (sl) { pgn = sl.pgn; name = sl.name; }
  }
  if (!pgn) return null;
  return { ...item, openingName: op.name, sublineName: name, pgn };
}

// ─── Stage interactions ────────────────────────────────────────────

async function captureWalkthroughCard(page) {
  return await page.evaluate(() => {
    const labelEl = document.querySelector('[data-testid="annotation-move-label"]');
    const textEl = document.querySelector('[data-testid="annotation-text"]');
    return {
      label: (labelEl?.textContent ?? '').trim(),
      text: (textEl?.textContent ?? '').trim(),
    };
  }).catch(() => ({ label: '', text: '' }));
}

async function clickNext(page) {
  for (const sel of ['[data-testid="nav-next"]', 'button[aria-label*="Next" i]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
  }
  await page.keyboard.press('ArrowRight').catch(() => {});
  return true;
}

async function dragPieceMove(page, from, to) {
  // react-chessboard squares use data-square="<a-h><1-8>".
  // We use real mouse events so the drag triggers the same way a
  // user's would.
  const source = page.locator(`[data-square="${from}"]`).first();
  const target = page.locator(`[data-square="${to}"]`).first();
  if (!(await source.isVisible().catch(() => false))) return { ok: false, error: 'source-square-not-visible' };
  if (!(await target.isVisible().catch(() => false))) return { ok: false, error: 'target-square-not-visible' };
  try {
    const sBox = await source.boundingBox();
    const tBox = await target.boundingBox();
    if (!sBox || !tBox) return { ok: false, error: 'no-bounding-box' };
    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    const tx = tBox.x + tBox.width / 2;
    const ty = tBox.y + tBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ─── Main run loop ─────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[interactive] base=${BASE_URL} out=${OUT_DIR}`);
  console.log(`[interactive] sample size: ${SAMPLE_SUBLINES.length}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[interactive] chromium = ${executablePath}`);

  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditInteractiveBot/1.0 (chromium)',
  });
  const page = await ctx.newPage();
  const allEvents = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/audit-stream') && req.method() === 'POST') {
      try { const body = req.postDataJSON?.(); if (body) allEvents.push({ at: Date.now(), ...body }); } catch {}
    }
  });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 250)); });
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message.slice(0, 300)));

  // Boot: warm openings seed.
  console.log('[interactive] booting & seeding openings DB');
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.goto(`${BASE_URL}/openings`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  const seedOk = await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
  if (!seedOk) {
    console.log('[interactive] FATAL: openings seed did not complete');
    await browser.close();
    process.exit(2);
  }
  console.log('[interactive] seed done — entering sample loop');

  const results = [];

  for (let i = 0; i < SAMPLE_SUBLINES.length; i++) {
    const item = SAMPLE_SUBLINES[i];
    const loaded = await loadSubline(item);
    if (!loaded) {
      console.log(`[${i + 1}/${SAMPLE_SUBLINES.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'} — SKIPPED (no data)`);
      results.push({ ...item, error: 'no-data' });
      continue;
    }

    const expectedSans = pgnToSans(loaded.pgn).slice(0, 20);
    const result = {
      i: i + 1,
      ...loaded,
      walkthrough: { mounted: false, plies: [] },
      practice: { mounted: false, attempts: [] },
      runtime: { errors: [] },
    };
    const eventsBefore = allEvents.length;

    try {
      // 1. Navigate to detail page.
      await page.goto(`${BASE_URL}/openings/${loaded.openingId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const detail = await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 12_000 }).then(() => true).catch(() => false);
      if (!detail) {
        result.runtime.errors.push('detail-page-did-not-mount');
        results.push(result);
        await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, sample: SAMPLE_SUBLINES.length, results }, null, 2));
        console.log(`[${i + 1}/${SAMPLE_SUBLINES.length}] ${loaded.openingId}/${loaded.sublineType}-${loaded.sublineIndex ?? 'main'} — DETAIL_FAIL`);
        continue;
      }

      // 2. Find launcher for this subline.
      const launcherSel = {
        main: '[data-testid="walkthrough-btn"]',
        variation: `[data-testid="variation-walkthrough-${item.sublineIndex}"]`,
        trap: `[data-testid="trap-walkthrough-${item.sublineIndex}"]`,
        warning: `[data-testid="warning-walkthrough-${item.sublineIndex}"]`,
      }[item.sublineType];

      const launcher = page.locator(launcherSel).first();
      if (!(await launcher.isVisible().catch(() => false))) {
        await launcher.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      }
      const launched = await launcher.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (!launched) {
        result.runtime.errors.push(`launcher-${launcherSel}-not-clickable`);
        results.push(result);
        await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, sample: SAMPLE_SUBLINES.length, results }, null, 2));
        console.log(`[${i + 1}/${SAMPLE_SUBLINES.length}] ${loaded.openingId}/${loaded.sublineType}-${loaded.sublineIndex ?? 'main'} — LAUNCHER_FAIL`);
        continue;
      }

      // 3. Walkthrough — walk to end, capture each ply.
      const wtMounted = await page.locator('[data-testid="walkthrough-mode"]').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
      result.walkthrough.mounted = wtMounted;
      if (wtMounted) {
        await page.waitForTimeout(SETTLE_AFTER_MOUNT_MS);
        let lastLabel = '';
        for (let p = 1; p <= expectedSans.length; p++) {
          await clickNext(page);
          const t0 = Date.now();
          let snap = null;
          while (Date.now() - t0 < PER_PLY_TIMEOUT_MS) {
            await page.waitForTimeout(120);
            const s = await captureWalkthroughCard(page);
            if (s.label && s.label !== lastLabel) { snap = s; lastLabel = s.label; break; }
          }
          if (!snap) snap = await captureWalkthroughCard(page);
          result.walkthrough.plies.push({ ply: p, expectedSan: expectedSans[p - 1].san, label: snap.label, text: snap.text.slice(0, 220) });
        }
        // Exit walkthrough.
        const exitBtn = page.locator('[data-testid="walkthrough-back"]').first();
        if (await exitBtn.isVisible().catch(() => false)) {
          await exitBtn.click({ timeout: 2_000 }).catch(() => {});
        }
      }

      // 4. Practice mode — interactive board.
      await page.waitForTimeout(800);
      const practiceBtnVis = await page.locator('[data-testid="practice-btn"]').first().isVisible().catch(() => false);
      if (!practiceBtnVis) {
        result.practice.error = 'practice-btn-not-visible';
      } else {
        // Practice button on detail page handles MAIN line. Variation /
        // trap / warning practice buttons are different.
        const practiceSel = {
          main: '[data-testid="practice-btn"]',
          variation: `[data-testid="variation-practice-${item.sublineIndex}"]`,
          trap: `[data-testid="trap-practice-${item.sublineIndex}"]`,
          warning: `[data-testid="warning-practice-${item.sublineIndex}"]`,
        }[item.sublineType];
        const pBtn = page.locator(practiceSel).first();
        if (!(await pBtn.isVisible().catch(() => false))) {
          await pBtn.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
        }
        const pClicked = await pBtn.click({ timeout: 5_000 }).then(() => true).catch(() => false);
        if (!pClicked) {
          result.practice.error = `practice-button-${practiceSel}-not-clickable`;
        } else {
          const pMounted = await page.locator('[data-testid="practice-mode"]').waitFor({ timeout: 12_000 }).then(() => true).catch(() => false);
          result.practice.mounted = pMounted;
          if (pMounted) {
            await page.waitForTimeout(1500);

            // Try the first 3 student-side moves. Practice expects
            // the STUDENT (opening.color) to play the first move
            // on a white-side opening; otherwise the opponent's
            // automated move happens first then the student moves.
            // We trial-and-error here: figure out whose turn it is
            // (via page.evaluate on a `chess.turn()` accessor isn't
            // available, so we sniff the test ID `practice-prompt`).
            for (let mvAttempt = 0; mvAttempt < 3 && mvAttempt < expectedSans.length; mvAttempt++) {
              const expected = expectedSans[mvAttempt];
              const drag = await dragPieceMove(page, expected.from, expected.to);
              await page.waitForTimeout(800);
              // Check for correct/wrong flash.
              const correct = await page.locator('[data-testid="correct-flash"]').first().isVisible().catch(() => false);
              const wrong = await page.locator('[data-testid="wrong-flash"]').first().isVisible().catch(() => false);
              result.practice.attempts.push({
                index: mvAttempt,
                expectedSan: expected.san,
                expectedFrom: expected.from,
                expectedTo: expected.to,
                dragOk: drag.ok,
                dragError: drag.error,
                correct,
                wrong,
              });
              if (!drag.ok || (!correct && !wrong)) break;
              if (wrong) break;
              await page.waitForTimeout(1000); // wait for opponent reply
            }
            // Exit practice
            const exitP = page.locator('[data-testid="practice-back"]').first();
            if (await exitP.isVisible().catch(() => false)) {
              await exitP.click({ timeout: 2_000 }).catch(() => {});
            } else {
              await page.locator('[data-testid="practice-exit"]').first().click({ timeout: 2_000 }).catch(() => {});
            }
          }
        }
      }

      // Capture audit events from this subline run
      result.audit = {
        eventCount: allEvents.length - eventsBefore,
        narrationEmpty: allEvents.slice(eventsBefore).filter((e) => e.kind === 'walkthrough-narration-empty').length,
        runtimeErrors: allEvents.slice(eventsBefore).filter((e) => e.kind === 'uncaught-error' || e.kind === 'unhandled-rejection').length,
      };
    } catch (err) {
      result.runtime.errors.push(String(err?.message ?? err).slice(0, 300));
    }

    results.push(result);
    await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, sample: SAMPLE_SUBLINES.length, results }, null, 2));

    const wtOk = result.walkthrough.mounted;
    const pOk = result.practice.mounted;
    const goodMoves = result.practice.attempts.filter((a) => a.correct).length;
    const badMoves = result.practice.attempts.filter((a) => a.wrong).length;
    console.log(
      `[${i + 1}/${SAMPLE_SUBLINES.length}] ${loaded.openingId}/${loaded.sublineType}-${loaded.sublineIndex ?? 'main'}` +
      ` wt=${wtOk ? 'ok' : 'X'} (${result.walkthrough.plies.length} plies)` +
      ` practice=${pOk ? 'ok' : 'X'} ${goodMoves}✓ ${badMoves}✗` +
      ` (${(loaded.sublineName || '').slice(0, 40)})`,
    );
  }

  // Summary
  const wtPass = results.filter((r) => r.walkthrough?.mounted).length;
  const pracPass = results.filter((r) => r.practice?.mounted).length;
  const goodDrags = results.reduce((n, r) => n + (r.practice?.attempts?.filter((a) => a.correct).length || 0), 0);
  const badDrags = results.reduce((n, r) => n + (r.practice?.attempts?.filter((a) => a.wrong).length || 0), 0);
  const lines = [
    `# Openings Interactive Audit — ${new Date().toISOString()}`,
    ``,
    `**Sample size:** ${results.length}`,
    `**Walkthrough mount success:** ${wtPass}/${results.length}`,
    `**Practice mount success:** ${pracPass}/${results.length}`,
    `**Drag attempts:** ${goodDrags} ✓, ${badDrags} ✗`,
    ``,
    `## Per-subline results`,
    ...results.map((r) => {
      const moves = r.practice?.attempts?.map((a) => {
        const result = a.correct ? '✓' : a.wrong ? '✗' : '?';
        return `${a.expectedSan}${result}`;
      }).join(' ') || '(no attempts)';
      const errs = r.runtime?.errors?.length ? ` [errors: ${r.runtime.errors.join('; ')}]` : '';
      return `- **${r.openingId}/${r.sublineType}-${r.sublineIndex ?? 'main'}** (${r.sublineName || '?'}): wt=${r.walkthrough?.mounted ? 'ok' : 'fail'} prac=${r.practice?.mounted ? 'ok' : (r.practice?.error || 'fail')} moves=${moves}${errs}`;
    }),
    ``,
    `## Total audit events captured: ${allEvents.length}`,
    `## Console errors: ${consoleErrors.length}`,
  ];
  await writeFile(SUMMARY_PATH, lines.join('\n'));

  console.log(`\n[interactive] DONE`);
  console.log(`[interactive] walkthrough mounted: ${wtPass}/${results.length}`);
  console.log(`[interactive] practice mounted: ${pracPass}/${results.length}`);
  console.log(`[interactive] correct drags: ${goodDrags}, wrong: ${badDrags}`);
  console.log(`[interactive] report at ${REPORT_PATH}`);

  await browser.close();
}

main().catch((err) => { console.error('[interactive] fatal:', err); process.exit(1); });
