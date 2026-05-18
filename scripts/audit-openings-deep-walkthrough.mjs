#!/usr/bin/env node
/**
 * Deep walkthrough audit — sit down and play through every opening's
 * sublines (variations, trap lines, warning lines) move-by-move via
 * Playwright. For each ply: capture the on-screen annotation card,
 * the played SAN, and any audit-stream events fired during the walk.
 * Classify against a suite of heuristics that flag the bug classes
 * caught in the 2026-05-18 audit:
 *
 *   - card-empty            — `annotation-card-empty` testid renders
 *                             (resolver returned null + no synth).
 *   - text-empty            — `annotation-text` rendered but empty.
 *   - continuing-this-line  — synth placeholder reached the card
 *                             (resolver couldn't find a usable entry).
 *   - generic-templated     — text matches `isGenericAnnotationText`
 *                             (the LLM enricher never replaced the
 *                             stub).
 *   - color-mismatch        — move label says "10. d5" (White's
 *                             move) but the narration begins
 *                             "Black plays…" or vice versa. This is
 *                             the David-screenshotted class — fixed
 *                             in PR #593 but worth verifying.
 *   - san-not-mentioned     — the SAN that was just played doesn't
 *                             appear ANYWHERE in the annotation text
 *                             (soft heuristic; sometimes correct
 *                             because the narration talks about a
 *                             theme rather than the move).
 *   - bare-san-voice        — synth-stub voice event captured (the
 *                             text was bare SAN). Should be zero
 *                             after PR #593.
 *
 * Drives off `src/data/pro-repertoires.json` (82 openings) and
 * `src/data/repertoire.json` (40 openings); walks main + variations
 * + trapLines + warningLines on each. ~940 total sublines, ~15-25s
 * each → 4-7 hours overnight.
 *
 * Resumability: writes `report.json` after every subline. If
 * AUDIT_RESUME=1 and the file exists, the script skips already-
 * audited sublines and appends. Set AUDIT_SCOPE=pro|repertoire|all
 * (default all) to restrict.
 *
 * Output: `audit-reports/openings-deep-walkthrough-<iso>/report.json`
 * and `report.md` (human-readable summary).
 */

import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'http://localhost:5173';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const SCOPE = (process.env.AUDIT_SCOPE ?? 'all').toLowerCase();
const PER_PLY_TIMEOUT_MS = 2500;
const PER_PLY_POLL_MS = 120;
const SETTLE_AFTER_MOUNT_MS = 800;
const MAX_PLIES_PER_LINE = 30;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = process.env.AUDIT_OUT_DIR ?? `audit-reports/openings-deep-walkthrough-${stamp}`;
const REPORT_PATH = join(OUT_DIR, 'report.json');
const SUMMARY_PATH = join(OUT_DIR, 'report.md');

// ─── Data loading ──────────────────────────────────────────────────

const proRepFile = JSON.parse(await readFile('./src/data/pro-repertoires.json', 'utf-8'));
const repFile = JSON.parse(await readFile('./src/data/repertoire.json', 'utf-8'));
const proOpenings = proRepFile.openings ?? [];
const repertoireOpenings = Array.isArray(repFile) ? repFile : Object.values(repFile);

function openingToQueueItems(op, source) {
  const items = [];
  // Main line
  if (op.pgn) {
    items.push({
      source,
      openingId: op.id,
      openingName: op.name,
      eco: op.eco,
      sublineType: 'main',
      sublineIndex: null,
      sublineName: op.name,
      pgn: op.pgn,
    });
  }
  for (let i = 0; i < (op.variations ?? []).length; i++) {
    const v = op.variations[i];
    if (!v.pgn) continue;
    items.push({
      source,
      openingId: op.id,
      openingName: op.name,
      eco: op.eco,
      sublineType: 'variation',
      sublineIndex: i,
      sublineName: v.name ?? `Variation ${i}`,
      pgn: v.pgn,
    });
  }
  for (let i = 0; i < (op.trapLines ?? []).length; i++) {
    const t = op.trapLines[i];
    if (!t.pgn) continue;
    items.push({
      source,
      openingId: op.id,
      openingName: op.name,
      eco: op.eco,
      sublineType: 'trap',
      sublineIndex: i,
      sublineName: t.name ?? `Trap ${i}`,
      pgn: t.pgn,
    });
  }
  for (let i = 0; i < (op.warningLines ?? []).length; i++) {
    const w = op.warningLines[i];
    if (!w.pgn) continue;
    items.push({
      source,
      openingId: op.id,
      openingName: op.name,
      eco: op.eco,
      sublineType: 'warning',
      sublineIndex: i,
      sublineName: w.name ?? `Warning ${i}`,
      pgn: w.pgn,
    });
  }
  return items;
}

function buildQueue() {
  const items = [];
  if (SCOPE === 'all' || SCOPE === 'pro') {
    for (const op of proOpenings) items.push(...openingToQueueItems(op, 'pro'));
  }
  if (SCOPE === 'all' || SCOPE === 'repertoire') {
    for (const op of repertoireOpenings) items.push(...openingToQueueItems(op, 'repertoire'));
  }
  return items;
}

// ─── Heuristics ────────────────────────────────────────────────────

// Same pattern set as src/services/walkthroughNarration.ts —
// duplicated here so the script is self-contained and doesn't pull
// the bundle's TS via a runtime import. Update both when patterns
// drift.
const GENERIC_PATTERNS = [
  /\bposition is heading toward the critical moment\b/i,
  /\bposition is becoming uncomfortable\b/i,
  /\bcareful defense is needed\b/i,
  /\bposition is roughly (equal|balanced)\b/i,
  /\bboth sides have chances\b/i,
  /\bThe position is sharp and requires precise play from this point forward\b/i,
  /\bThe key moment is approaching\b/i,
  /\bThe critical moment is approaching\b/i,
  /\bcritical moment in the trap\b/i,
  /\bcritical moment in the opening( battle)?\b/i,
  /\bThis is a critical moment where precise play is essential\b/i,
  /\bDevelopment with purpose\b/i,
  /\bCentral pawns control space\b/i,
  /\bGaining space here creates potential targets\b/i,
  /\bA thematic move in this position\b/i,
  /\bThis exchange changes the balance\b/i,
  /\bopponent may not see what'?s coming\b/i,
  /\bThis move looks reasonable but allows the trap to unfold\b/i,
  /\bThis looks natural,? but it walks into the trap\b/i,
  /\bthe trap is being set\b/i,
  /\bWatch out\s*[—–-]\s*a mistake here would be very costly\b/i,
  /^\s*Be alert\.?\s*$/i,
  /\bThis is the position you must avoid\b/i,
  /\bThe damage is done\b/i,
  /\bThis is the uncomfortable position that results from this line\b/i,
  /\bNow that you'?ve seen it, you'?ll know to avoid the pitfall\b/i,
  /\bThis is the move that causes all the trouble\b/i,
  /\bMemorize this pattern\b/i,
  /\bThe trap is complete\b/i,
  /\bRemember this pattern\s*[—–-]\s*your opponents will fall for it\b/i,
  /\bThe trap is sprung\b/i,
  /\bNow the trap is revealed\b/i,
  /\bThe opponent is in serious trouble\b/i,
  /\bThis is where the trap begins\b/i,
  /\bThe next two moves are the key sequence\b/i,
  /^\s*(?:White|Black)\s+plays\s+[A-Za-z][\w+#=!?-]*\.?\s*$/i,
  /^\s*\d+\.+\s*(?:\.\.\.\s*)?[NBRQK]?[a-h]?[1-8]?[x-]?[a-h][1-8](?:=[NBRQ])?[+#!?]*\s*$/,
  /^\s*[NBRQK]?[a-h]?[1-8]?[x-]?[a-h][1-8](?:=[NBRQ])?[+#!?]*\s*$/,
  /^\s*O-O(?:-O)?[+#!?]*\s*$/,
  /\bimproving piece coordination and maintaining pressure\b/i,
];

function isGenericText(text) {
  if (!text) return false;
  return GENERIC_PATTERNS.some((re) => re.test(text.trim()));
}

// Parse "10. d5" / "10...d5" → { moveNumber: 10, color: 'white' | 'black', san: 'd5' }
function parseMoveLabel(label) {
  if (!label) return null;
  const trimmed = label.trim();
  const whiteMatch = trimmed.match(/^(\d+)\.\s*([A-Za-z0-9+#=!?-]+)\s*$/);
  if (whiteMatch) {
    return { moveNumber: Number(whiteMatch[1]), color: 'white', san: whiteMatch[2] };
  }
  const blackMatch = trimmed.match(/^(\d+)\.{3}\s*([A-Za-z0-9+#=!?-]+)\s*$/);
  if (blackMatch) {
    return { moveNumber: Number(blackMatch[1]), color: 'black', san: blackMatch[2] };
  }
  return null;
}

function classifyAnnotation(snap, expectedSan) {
  const flags = [];
  const text = snap.text ?? '';

  if (snap.cardEmpty) flags.push({ kind: 'card-empty' });
  if (!text.trim()) flags.push({ kind: 'text-empty' });
  if (/^Continuing this line:/i.test(text.trim())) {
    flags.push({ kind: 'continuing-this-line', text: text.slice(0, 120) });
  }
  if (text && isGenericText(text)) {
    flags.push({ kind: 'generic-templated', text: text.slice(0, 120) });
  }

  // Color-mismatch heuristic
  const parsed = parseMoveLabel(snap.label);
  if (parsed && text) {
    const first50 = text.slice(0, 50);
    const mentionsWhite = /\b(?:White|white)\s+(?:plays|pushes|develops|captures|takes|moves|attacks|defends|opens|recaptures|sidesteps|aims|advances|reroutes|threatens|forces|exchanges|trades|castles|prepares|targets|maintains|delivers|sacrifices|strikes|retreats|brings)/i.test(first50);
    const mentionsBlack = /\b(?:Black|black)\s+(?:plays|pushes|develops|captures|takes|moves|attacks|defends|opens|recaptures|sidesteps|aims|advances|reroutes|threatens|forces|exchanges|trades|castles|prepares|targets|maintains|delivers|sacrifices|strikes|retreats|brings)/i.test(first50);
    if (parsed.color === 'white' && mentionsBlack && !mentionsWhite) {
      flags.push({ kind: 'color-mismatch', label: snap.label, text: text.slice(0, 150) });
    } else if (parsed.color === 'black' && mentionsWhite && !mentionsBlack) {
      flags.push({ kind: 'color-mismatch', label: snap.label, text: text.slice(0, 150) });
    }
  }

  // SAN-not-mentioned (soft signal)
  if (expectedSan && text && !text.includes(expectedSan)) {
    // Strip move-decoration chars before mentioning
    const stripped = expectedSan.replace(/[+#!?]/g, '');
    if (!text.includes(stripped)) {
      flags.push({ kind: 'san-not-mentioned', expected: expectedSan, text: text.slice(0, 120) });
    }
  }

  return flags;
}

// ─── Resume support ────────────────────────────────────────────────

async function loadResume() {
  if (process.env.AUDIT_RESUME !== '1') return null;
  if (!existsSync(REPORT_PATH)) return null;
  try {
    const raw = await readFile(REPORT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const queue = buildQueue();
  console.log(`[deep-walk] base=${BASE_URL}`);
  console.log(`[deep-walk] scope=${SCOPE}`);
  console.log(`[deep-walk] queue=${queue.length} sublines`);
  console.log(`[deep-walk] out=${OUT_DIR}`);

  const prev = await loadResume();
  // Only count successful runs as "done" so resume retries any
  // subline that errored on the prior attempt.
  const done = new Set(
    (prev?.results ?? [])
      .filter((r) => !r.runtime?.error && (r.pliesCaptured ?? 0) > 0)
      .map((r) => `${r.openingId}::${r.sublineType}::${r.sublineIndex ?? 'main'}`),
  );
  const results = (prev?.results ?? []).filter(
    (r) => !r.runtime?.error && (r.pliesCaptured ?? 0) > 0,
  );
  console.log(`[deep-walk] resume: ${done.size} already done, retrying any errored`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[deep-walk] chromium = ${executablePath}`);

  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditDeepWalkBot/1.0 (chromium)',
  });

  const page = await ctx.newPage();
  const allEvents = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/audit-stream') && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body) allEvents.push({ at: Date.now(), ...body });
      } catch {}
    }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 300)));

  // Boot at the dashboard to warm up the Dexie openings DB seed.
  console.log(`[deep-walk] booting at ${BASE_URL}/`);
  const tBoot = Date.now();
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => { console.log('boot goto / threw:', e.message); });
  console.log(`[deep-walk] / loaded in ${Date.now() - tBoot}ms`);
  await page.waitForTimeout(1500);
  // Visit /openings to flush the seed. The first visit on a fresh
  // browser context spends ~30-45s in `seedDatabase()` because it
  // parses 3641 ECO PGNs through chess.js to compute FEN/UCI. Subsequent
  // navigations (after Dexie marks `__seeded__`) skip this. The
  // openings-explorer testid only mounts AFTER seeding completes.
  const tOpenings = Date.now();
  await page.goto(`${BASE_URL}/openings`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => { console.log('boot goto /openings threw:', e.message); });
  console.log(`[deep-walk] /openings goto done at +${Date.now() - tOpenings}ms — waiting for seed (up to 90s)`);
  const tExplorer = Date.now();
  const explorerOk = await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
  console.log(`[deep-walk] opening-explorer ready: ${explorerOk} after ${Date.now() - tExplorer}ms`);
  if (!explorerOk) {
    console.log('[deep-walk] FATAL: openings explorer never mounted — seedDatabase may have errored. Aborting.');
    await page.screenshot({ path: join(OUT_DIR, '00-boot-fail.png'), fullPage: true }).catch(() => {});
    await browser.close();
    process.exit(2);
  }
  await page.waitForTimeout(1500);
  console.log(`[deep-walk] boot total: ${Date.now() - tBoot}ms — entering loop`);

  let i = 0;
  for (const item of queue) {
    i++;
    const key = `${item.openingId}::${item.sublineType}::${item.sublineIndex ?? 'main'}`;
    if (done.has(key)) {
      continue;
    }

    const expectedSans = item.pgn.trim().split(/\s+/).filter(Boolean).slice(0, MAX_PLIES_PER_LINE);
    const result = {
      key,
      i,
      ...item,
      pliesExpected: expectedSans.length,
      pliesCaptured: 0,
      moves: [],
      flags: [],
      runtime: { error: null },
      startedAt: new Date().toISOString(),
    };
    const eventCountBefore = allEvents.length;

    try {
      // Navigate to the opening detail page.
      const detailUrl = `${BASE_URL}/openings/${item.openingId}`;
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const detail = await Promise.race([
        page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 12_000 }).then(() => 'ok').catch(() => null),
        page.getByText('Opening not found.', { exact: true }).first().waitFor({ timeout: 12_000 }).then(() => 'not-found').catch(() => null),
      ]);
      if (detail !== 'ok') {
        result.runtime.error = `detail page state: ${detail}`;
        result.flags.push({ kind: 'detail-not-loaded' });
        results.push(result);
        await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, scope: SCOPE, results }, null, 2));
        console.log(`[${i}/${queue.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'} — DETAIL_NOT_LOADED`);
        continue;
      }

      // Click the right launcher.
      let launcherSel;
      switch (item.sublineType) {
        case 'main':     launcherSel = '[data-testid="walkthrough-btn"]'; break;
        case 'variation': launcherSel = `[data-testid="variation-walkthrough-${item.sublineIndex}"]`; break;
        case 'trap':     launcherSel = `[data-testid="trap-walkthrough-${item.sublineIndex}"]`; break;
        case 'warning':  launcherSel = `[data-testid="warning-walkthrough-${item.sublineIndex}"]`; break;
        default:         launcherSel = '[data-testid="walkthrough-btn"]';
      }

      // Scroll launcher into view if needed (variations/trap/warning tiles
      // live further down the page).
      const launcher = page.locator(launcherSel).first();
      const launcherVisible = await launcher.isVisible().catch(() => false);
      if (!launcherVisible) {
        await launcher.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      }
      const clicked = await launcher.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (!clicked) {
        result.runtime.error = `launcher ${launcherSel} not clickable`;
        result.flags.push({ kind: 'launcher-not-found' });
        results.push(result);
        await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, scope: SCOPE, results }, null, 2));
        console.log(`[${i}/${queue.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'} — LAUNCHER_NOT_FOUND`);
        continue;
      }

      const mounted = await page.locator('[data-testid="walkthrough-mode"]').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
      if (!mounted) {
        result.runtime.error = 'walkthrough-mode did not mount';
        result.flags.push({ kind: 'walkthrough-not-mounted' });
        results.push(result);
        await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, scope: SCOPE, results }, null, 2));
        console.log(`[${i}/${queue.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'} — NOT_MOUNTED`);
        continue;
      }

      // Settle so the LLM enricher has a chance to fill in narration.
      await page.waitForTimeout(SETTLE_AFTER_MOUNT_MS);

      // Walk each ply via the Next nav. Heavy use of short locator
      // timeouts here because we poll up to ~20 times per ply — a
      // 2s default-timeout textContent multiplied by N polls would
      // make each subline run for minutes. Use page.evaluate to grab
      // everything in a single synchronous DOM read.
      const captureCurrent = async () => {
        return await page.evaluate(() => {
          const $ = (sel) => document.querySelector(sel);
          const card = $('[data-testid="annotation-card-empty"]');
          const overview = $('[data-testid="walkthrough-overview"]');
          const labelEl = $('[data-testid="annotation-move-label"]');
          const textEl = $('[data-testid="annotation-text"]');
          return {
            cardEmpty: Boolean(card),
            overview: Boolean(overview),
            label: (labelEl?.textContent ?? '').trim(),
            text: (textEl?.textContent ?? '').trim(),
          };
        }).catch(() => ({ cardEmpty: false, overview: false, label: '', text: '' }));
      };
      const advance = async () => {
        for (const sel of [
          '[data-testid="nav-next"]',
          '[data-testid="walkthrough-next"]',
          'button[aria-label*="Next" i]',
        ]) {
          const el = page.locator(sel).first();
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 1500 }).catch(() => {});
            return true;
          }
        }
        await page.keyboard.press('ArrowRight').catch(() => {});
        return true;
      };

      let lastLabel = '';
      for (let ply = 1; ply <= expectedSans.length; ply++) {
        await advance();
        const t0 = Date.now();
        let snap = null;
        while (Date.now() - t0 < PER_PLY_TIMEOUT_MS) {
          await page.waitForTimeout(PER_PLY_POLL_MS);
          const s = await captureCurrent();
          if (s.label && s.label !== lastLabel) { snap = s; lastLabel = s.label; break; }
          if (s.cardEmpty && !s.overview) { snap = s; break; }
        }
        if (!snap) {
          snap = await captureCurrent();
        }
        const expectedSan = expectedSans[ply - 1];
        const flags = classifyAnnotation(snap, expectedSan);
        result.moves.push({
          ply,
          expectedSan,
          label: snap.label,
          text: snap.text.slice(0, 240),
          cardEmpty: snap.cardEmpty,
          flags,
        });
        for (const f of flags) result.flags.push({ ply, ...f });
        result.pliesCaptured++;
      }

      // Walkthrough-narration-empty events fired DURING this subline's walk.
      const sublineEvents = allEvents.slice(eventCountBefore);
      result.narrationEmptyEventCount = sublineEvents.filter(
        (e) => e.kind === 'walkthrough-narration-empty',
      ).length;

      // Exit the walkthrough.
      const exitBtn = page.locator('[data-testid="walkthrough-back"]').first();
      if (await exitBtn.isVisible().catch(() => false)) {
        await exitBtn.click({ timeout: 2000 }).catch(() => {});
      }
    } catch (err) {
      result.runtime.error = String(err?.message ?? err);
      console.log(`[${i}/${queue.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'} — ERROR: ${result.runtime.error}`);
    }

    result.finishedAt = new Date().toISOString();
    results.push(result);
    done.add(key);

    // Incremental save.
    await writeFile(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE_URL, scope: SCOPE, results }, null, 2));

    const failCount = result.flags.filter((f) =>
      ['card-empty', 'text-empty', 'continuing-this-line', 'generic-templated', 'color-mismatch'].includes(f.kind),
    ).length;
    console.log(
      `[${i}/${queue.length}] ${item.openingId}/${item.sublineType}-${item.sublineIndex ?? 'main'}` +
      ` plies=${result.pliesCaptured}/${result.pliesExpected}` +
      ` flags=${failCount}` +
      ` empties=${result.narrationEmptyEventCount ?? 0}` +
      ` (${item.sublineName.slice(0, 40)})`,
    );
  }

  // ─── Build summary ────────────────────────────────────────────────
  const summary = summarize(results);
  await writeFile(SUMMARY_PATH, summary);
  console.log(`\n[deep-walk] DONE`);
  console.log(`[deep-walk] sublines audited: ${results.length}`);
  console.log(`[deep-walk] total flags: ${results.reduce((n, r) => n + r.flags.length, 0)}`);
  console.log(`[deep-walk] report at ${REPORT_PATH}`);
  console.log(`[deep-walk] summary at ${SUMMARY_PATH}`);

  await browser.close();
}

function summarize(results) {
  const flagCounts = {};
  const offenders = {};
  for (const r of results) {
    for (const f of r.flags) {
      flagCounts[f.kind] = (flagCounts[f.kind] ?? 0) + 1;
      offenders[f.kind] = offenders[f.kind] ?? [];
      if (offenders[f.kind].length < 30) {
        offenders[f.kind].push({
          opening: r.openingName,
          openingId: r.openingId,
          subline: `${r.sublineType}-${r.sublineIndex ?? 'main'}`,
          sublineName: r.sublineName,
          ply: f.ply,
          detail: f,
        });
      }
    }
  }
  const lines = [
    `# Openings Deep Walkthrough Audit — ${new Date().toISOString()}`,
    ``,
    `**Sublines audited:** ${results.length}`,
    `**Total flags:** ${Object.values(flagCounts).reduce((a, b) => a + b, 0)}`,
    ``,
    `## Flag counts by kind`,
    ``,
    ...Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- **${k}**: ${n}`),
    ``,
    `## Top offenders per kind`,
  ];
  for (const [kind, list] of Object.entries(offenders)) {
    lines.push(``);
    lines.push(`### ${kind} (${flagCounts[kind]} total — showing up to 30)`);
    lines.push(``);
    for (const o of list) {
      const ply = o.ply ? `ply ${o.ply}` : '';
      const txt = o.detail.text ? `\`${(o.detail.text ?? '').slice(0, 120)}\`` : '';
      lines.push(`- **${o.opening}** › ${o.subline} (${o.sublineName.slice(0, 40)}) ${ply} ${txt}`);
    }
  }
  return lines.join('\n');
}

main().catch((err) => { console.error('[deep-walk] fatal:', err); process.exit(1); });
