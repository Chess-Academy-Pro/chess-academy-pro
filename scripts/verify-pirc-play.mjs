#!/usr/bin/env node
/**
 * verify-pirc-play.mjs — drive a Pirc Austrian Attack play session
 * against prod. Verify two specific contracts:
 *
 *   1. Once past the canonical opening line, the opponent's move
 *      source changes — `coach-opponent-move-source` audit should
 *      fire with `source=masters` for at least one move in the
 *      first 20 plies.
 *   2. The eval bar value updates between moves (or at least
 *      `opening-play-eval-updated` audits fire). No silent freeze.
 *
 * Captures console events + screenshots + final audit-stream pull.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const URL = 'https://chess-academy-pro.vercel.app/openings/pirc-defence';
const CHROMIUM_PATH = process.env.WATCH_CHROMIUM_PATH;
const SECRET = '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = 'https://chess-academy-pro.vercel.app/api/audit-stream';

const stamp = Date.now();
const OUT = `/tmp/pirc-verify-${stamp}`;
await mkdir(OUT, { recursive: true });
console.log(`[verify] out=${OUT}`);

const baselineMs = Date.now();
console.log(`[verify] baseline=${baselineMs}`);

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROMIUM_PATH,
  args: ['--window-size=1400,1000', '--window-position=100,80'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

const consoleLogs = [];
page.on('console', (m) => {
  const txt = m.text();
  consoleLogs.push({ type: m.type(), text: txt });
  if (m.type() === 'error') console.log(`  [console.error] ${txt}`);
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/00-loaded.png` });

// Try to find + click the "Austrian Attack" variation tile
console.log('[verify] looking for Austrian Attack tile...');
const austrian = page.getByText('Austrian Attack', { exact: false }).first();
if (await austrian.isVisible().catch(() => false)) {
  await austrian.click();
  console.log('[verify] clicked Austrian Attack');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-austrian-selected.png` });
} else {
  console.log('[verify] Austrian Attack tile not visible — proceeding with default flow');
}

// Look for a Play button
console.log('[verify] looking for Play button...');
const playBtns = ['Play vs Coach', 'Play', 'Practice', 'Start'];
for (const t of playBtns) {
  const b = page.getByRole('button', { name: new RegExp(`^${t}`, 'i') }).first();
  if (await b.isVisible().catch(() => false)) {
    await b.click();
    console.log(`[verify] clicked "${t}"`);
    await page.waitForTimeout(2500);
    break;
  }
}
await page.screenshot({ path: `${OUT}/02-play-mode.png` });

// Read the eval bar value from the DOM at each step
async function readEvalBar() {
  return await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="eval-bar"]');
    if (!bar) return null;
    const txt = bar.textContent ?? '';
    const data = bar.getAttribute('data-eval');
    return { text: txt.trim().slice(0, 50), dataEval: data };
  });
}

const evalSnapshots = [];
const initEval = await readEvalBar();
evalSnapshots.push({ ply: 0, ...initEval });
console.log(`[verify] initial eval bar: ${JSON.stringify(initEval)}`);

// Now play black's moves through the Pirc Austrian Attack
// Variation PGN: e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 ...
// White plays first (computer). Black's moves at indices 1,3,5,7,...
const BLACK_MOVES = [
  { from: 'd7', to: 'd6' },  // 1...d6
  { from: 'g8', to: 'f6' },  // 2...Nf6
  { from: 'g7', to: 'g6' },  // 3...g6
  { from: 'f8', to: 'g7' },  // 4...Bg7
  { from: 'e8', to: 'g8' },  // 5...O-O
  { from: 'b8', to: 'a6' },  // 6...Na6
  { from: 'c7', to: 'c5' },  // 7...c5
  { from: 'c8', to: 'g4' },  // 8...Bg4 (note: only legal after Nf3)
];

async function dragMove(from, to) {
  const fromSel = `[data-square="${from}"]`;
  const toSel = `[data-square="${to}"]`;
  try {
    const fromEl = await page.locator(fromSel).first();
    const toEl = await page.locator(toSel).first();
    if (!(await fromEl.isVisible({ timeout: 2000 }).catch(() => false))) return false;
    if (!(await toEl.isVisible({ timeout: 2000 }).catch(() => false))) return false;
    const fromBox = await fromEl.boundingBox();
    const toBox = await toEl.boundingBox();
    if (!fromBox || !toBox) return false;
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
    await page.mouse.up();
    return true;
  } catch (e) {
    console.log(`  [dragMove err] ${e.message}`);
    return false;
  }
}

console.log('[verify] starting move sequence...');
let plyPlayed = 0;
for (let i = 0; i < BLACK_MOVES.length; i++) {
  await page.waitForTimeout(2500); // wait for computer reply
  const m = BLACK_MOVES[i];
  console.log(`[verify] attempting move ${i + 1}: ${m.from}-${m.to}`);
  const ok = await dragMove(m.from, m.to);
  if (!ok) {
    console.log(`[verify] could not play move ${m.from}-${m.to} — stopping`);
    await page.screenshot({ path: `${OUT}/move-${String(i + 1).padStart(2, '0')}-FAILED.png` });
    break;
  }
  plyPlayed++;
  await page.waitForTimeout(1200);
  const snap = await readEvalBar();
  evalSnapshots.push({ ply: i * 2 + 2, ...snap });
  console.log(`  eval after move ${i + 1}: ${JSON.stringify(snap)}`);
  await page.screenshot({ path: `${OUT}/move-${String(i + 1).padStart(2, '0')}.png` });
}

console.log(`[verify] played ${plyPlayed} moves. Pulling audit stream...`);
await page.waitForTimeout(3000);

// Fetch audit-stream events from this play session
const resp = await fetch(`${STREAM_URL}?since=${baselineMs}`, {
  headers: { 'x-audit-secret': SECRET },
});
const audits = await resp.json();

// Filter to relevant events
const relevant = (audits.entries || []).filter((e) => {
  return /coach-opponent|opening-play|master-play/.test(e.kind);
});

console.log('\n=== AUDIT REPORT ===');
console.log(`Total events since baseline: ${audits.count} (storage: ${audits.storage})`);
console.log(`Relevant events: ${relevant.length}`);
console.log('');
for (const e of relevant) {
  const ts = new Date(e.timestamp).toISOString().slice(11, 19);
  console.log(`  [${ts}] ${e.kind} :: ${(e.summary || '').slice(0, 180)}`);
}

console.log('\n=== EVAL BAR PROGRESSION ===');
for (const s of evalSnapshots) {
  console.log(`  ply ${s.ply}: text="${s.text ?? '-'}" data-eval=${s.dataEval ?? '-'}`);
}

// Summary verdicts
const dbMoves = relevant.filter((e) => e.kind === 'coach-opponent-move-source' && /source=masters/.test(e.summary)).length;
const stockfishMoves = relevant.filter((e) => e.kind === 'coach-opponent-move-source' && /source=stockfish/.test(e.summary)).length;
const evalUpdates = relevant.filter((e) => e.kind === 'opening-play-eval-updated').length;
const evalDropped = relevant.filter((e) => e.kind === 'opening-play-eval-prefetch-dropped').length;
const evalErrors = relevant.filter((e) => e.kind === 'opening-play-eval-error').length;
const distinctEvals = new Set(evalSnapshots.map((s) => s.dataEval).filter(Boolean));

console.log('\n=== VERDICTS ===');
console.log(`Bug 1 (opponent uses DB): masters=${dbMoves}, stockfish=${stockfishMoves} ${dbMoves > 0 ? '✓' : '✗'}`);
console.log(`Bug 2 (eval bar moves): updates=${evalUpdates}, dropped=${evalDropped}, errors=${evalErrors}, distinct-values=${distinctEvals.size} ${distinctEvals.size > 1 ? '✓' : '✗'}`);

// Save report
await writeFile(`${OUT}/report.json`, JSON.stringify({
  baselineMs,
  plyPlayed,
  audits: relevant,
  evalSnapshots,
  consoleErrors: consoleLogs.filter((l) => l.type === 'error'),
  dbMoves,
  stockfishMoves,
  evalUpdates,
}, null, 2));

console.log(`\n=== Screenshots + report: ${OUT} ===`);
console.log('[verify] leaving browser open. Close it when done.');
await new Promise(() => {});
