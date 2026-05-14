#!/usr/bin/env node
/**
 * Probe the "Show the opening" flow on /tactics/opening-traps for a
 * French Defense puzzle — capture timestamps + screenshots so we can
 * see what David sees when he says "runs most then jumps to puzzle
 * layout".
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const SECRET = '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = `${BASE_URL}/api/audit-stream`;
const OUT_DIR = `audit-reports/probe-show-opening-${new Date().toISOString().replace(/[:.]/g, '-')}`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(
    ({ url, secret }) => {
      try {
        window.localStorage.setItem('auditStreamUrl', url);
        window.localStorage.setItem('auditStreamSecret', secret);
      } catch {}
    },
    { url: STREAM_URL, secret: SECRET },
  );
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERR:', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('PAGEERR:', e.message));

  // Helper to read board state
  async function readPieces() {
    return await page.evaluate(() => {
      const squares = document.querySelectorAll('[data-square]');
      const pieces = {};
      for (const sq of squares) {
        const square = sq.getAttribute('data-square');
        const piece = sq.querySelector('[data-piece]');
        if (piece && square) pieces[square] = piece.getAttribute('data-piece');
      }
      return pieces;
    });
  }
  function diff(before, after) {
    const changed = [];
    const all = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const sq of all) {
      if (before[sq] !== after[sq]) changed.push({ sq, was: before[sq] ?? null, now: after[sq] ?? null });
    }
    return changed;
  }

  console.log('[probe] booting…');
  await page.goto(`${BASE_URL}/tactics/opening-traps`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('[data-testid="opening-blunders-page"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Click first phase (default opening), find French family
  console.log('[probe] looking for French family tile…');
  const families = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="opening-blunder-family-"]'))
      .map((el) => el.getAttribute('data-testid')),
  );
  console.log('  families:', families.slice(0, 10));
  const french = families.find((f) => f && /french/i.test(f));
  if (!french) {
    console.log('  no French family tile found — falling back to first');
  }
  const familyTid = french ?? families[0];
  console.log(`  picking ${familyTid}`);
  await page.locator(`[data-testid="${familyTid}"]`).click();
  await page.waitForTimeout(1500);

  // Pick first color
  const firstColor = page.locator('[data-testid^="opening-blunder-color-"]').first();
  if (await firstColor.isVisible().catch(() => false)) {
    await firstColor.click();
    await page.waitForTimeout(1500);
  }

  // Pick first puzzle
  const puzzleTids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="opening-blunder-"]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((tid) =>
        tid &&
        !tid.startsWith('opening-blunder-phase-') &&
        !tid.startsWith('opening-blunder-family-') &&
        !tid.startsWith('opening-blunder-color-') &&
        tid !== 'opening-blunder-play-out' &&
        tid !== 'opening-blunder-show-opening' &&
        tid !== 'opening-blunder-hint' &&
        tid !== 'opening-blunder-reveal' &&
        tid !== 'opening-blunder-next' &&
        tid !== 'opening-blunders-page',
      ),
  );
  console.log('  puzzles visible:', puzzleTids.length);
  if (puzzleTids.length === 0) { console.log('  no puzzles found'); await browser.close(); return; }
  const pickTid = puzzleTids[0];
  console.log(`  picking ${pickTid}`);
  await page.locator(`[data-testid="${pickTid}"]`).click();
  await page.waitForTimeout(3000);

  await page.screenshot({ path: `${OUT_DIR}/00-puzzle-loaded.png` });
  const piecesAtStart = await readPieces();
  console.log(`[probe] pieces at puzzle start: ${Object.keys(piecesAtStart).length} occupied squares`);

  // Click "Show the opening"
  const showBtn = page.locator('[data-testid="opening-blunder-show-opening"]');
  if (!(await showBtn.isVisible().catch(() => false))) {
    console.log('[probe] "Show the opening" button not visible — abort');
    await browser.close();
    return;
  }
  console.log('[probe] clicking Show the opening');
  const t0 = Date.now();
  await showBtn.click();

  // Sample board every 800ms for 30 seconds OR until walkthrough ends
  let lastPieces = piecesAtStart;
  let plyChangeCount = 0;
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(700);
    const elapsed = Date.now() - t0;
    const pieces = await readPieces();
    const changed = diff(lastPieces, pieces);
    const status = await page.evaluate(() => {
      // Try to read walkthroughActive flag indirectly by looking for "Showing the opening · ply X/Y" text
      const text = document.body.textContent ?? '';
      const m = text.match(/Showing the opening.*?ply (\d+)\/(\d+)/i);
      return m ? { ply: Number(m[1]), total: Number(m[2]) } : null;
    });
    if (changed.length > 0) {
      plyChangeCount++;
      console.log(`  t=${elapsed}ms changes=${changed.length} ply=${status ? `${status.ply}/${status.total}` : 'n/a'} sample=${changed.slice(0, 2).map((c) => `${c.sq}:${c.was || '_'}->${c.now || '_'}`).join(' ')}`);
    } else {
      console.log(`  t=${elapsed}ms (no change) ply=${status ? `${status.ply}/${status.total}` : 'n/a'}`);
    }
    if (i % 4 === 0) {
      await page.screenshot({ path: `${OUT_DIR}/${String(i).padStart(2, '0')}-t${elapsed}ms.png` });
    }
    lastPieces = pieces;
    if (status && status.ply >= status.total) {
      console.log(`  walkthrough reached ${status.ply}/${status.total} — capturing final state`);
      await page.waitForTimeout(2000);
      const finalPieces = await readPieces();
      const finalDiff = diff(pieces, finalPieces);
      if (finalDiff.length > 0) {
        console.log(`  POST-WALKTHROUGH JUMP detected: ${finalDiff.length} squares changed after walkthrough ended`);
        for (const c of finalDiff.slice(0, 10)) console.log(`    ${c.sq}: ${c.was || '_'} -> ${c.now || '_'}`);
      } else {
        console.log(`  post-walkthrough state matches end-of-animation — no jump`);
      }
      await page.screenshot({ path: `${OUT_DIR}/99-final.png` });
      break;
    }
  }

  console.log(`[probe] done. ply changes captured: ${plyChangeCount}`);
  console.log(`[probe] artifacts in ${OUT_DIR}/`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
