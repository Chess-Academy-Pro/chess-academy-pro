#!/usr/bin/env node
/**
 * watch-openings.mjs — open prod in a headed Chromium and drive
 * through several of the cleaned-up openings while taking
 * screenshots. David watches; I narrate.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const URL = process.env.WATCH_URL ?? 'https://chess-academy-pro.vercel.app';
const CHROMIUM_PATH = process.env.WATCH_CHROMIUM_PATH;
const OUT = `/tmp/openings-watch-${Date.now()}`;
await mkdir(OUT, { recursive: true });
console.log(`[watch] out=${OUT}`);

const browser = await chromium.launch({
  headless: false,
  slowMo: 250, // slow each action so David can see what's happening
  executablePath: CHROMIUM_PATH,
  args: ['--window-size=1280,900', '--window-position=200,100'],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2, // crisp screenshots
});
const page = await ctx.newPage();

// Capture every uncaught error + console error
const errs = [];
page.on('pageerror', (e) => {
  errs.push({ kind: 'pageerror', msg: e.message });
  console.log(`[ERROR] ${e.message}`);
});
page.on('console', (m) => {
  if (m.type() === 'error') {
    errs.push({ kind: 'console.error', msg: m.text() });
    console.log(`[console.error] ${m.text()}`);
  }
});

async function pause(ms) {
  await page.waitForTimeout(ms);
}

async function shot(label) {
  const path = `${OUT}/${String(stepCounter++).padStart(3, '0')}-${label}.png`;
  await page.screenshot({ path });
  console.log(`  📸 ${path}`);
}

let stepCounter = 0;

async function visit(openingId, label, plies = 16) {
  console.log(`\n━━━ ${label} (${openingId}) ━━━`);
  await page.goto(`${URL}/openings/${openingId}`, { waitUntil: 'domcontentloaded' });
  await pause(2500); // let walkthrough load
  await shot(`${openingId}-loaded`);

  // Try to click a "Play" / "Start walkthrough" or use the auto-advance.
  // First check if there's a chessboard rendered.
  const hasBoard = await page.locator('[data-testid="chessboard"], .chess-board, [class*="chess-board"]').first().isVisible().catch(() => false);
  console.log(`  board visible: ${hasBoard}`);

  // Look for any "Start" / "Play walkthrough" / "Watch" button
  const startBtn = page.locator('button:has-text("Start"), button:has-text("Play"), button:has-text("Watch"), button:has-text("Walkthrough"), button:has-text("Begin")').first();
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click().catch(() => {});
    console.log(`  clicked start`);
    await pause(2000);
  }

  // Find the "Next" / advance button and click it N times
  let advanced = 0;
  for (let i = 0; i < plies; i++) {
    const nextBtn = page.locator('button[aria-label*="next" i], button:has-text("Next"), [data-testid="walkthrough-next"]').first();
    const visible = await nextBtn.isVisible().catch(() => false);
    if (!visible) break;
    await nextBtn.click().catch(() => {});
    advanced++;
    await pause(700);
    if (i === 5 || i === 11 || i === plies - 1) await shot(`${openingId}-ply-${i + 1}`);
  }
  console.log(`  advanced ${advanced} plies`);

  // Final position screenshot
  await shot(`${openingId}-final`);
}

try {
  // Tour the cleaned openings — pick a mix
  await visit('pirc-defence', 'Pirc Defence (the bug that started it all)', 14);
  await visit('vienna-game', 'Vienna Game', 14);
  await visit('italian-game', 'Italian Game', 14);
  await visit('sicilian-najdorf', 'Sicilian Najdorf', 14);
  await visit('four-knights-game', 'Four Knights (Fishing Pole trap was here)', 14);
  await visit('frankenstein-dracula', 'Frankenstein-Dracula (truncated)', 12);
  await visit('budapest-gambit', 'Budapest Gambit (1 line deleted)', 12);
  await visit('benoni-defence', 'Benoni Defence (d4 system, extended)', 14);
} catch (e) {
  console.log(`[fatal] ${e.message}`);
}

console.log(`\n━━━ Summary ━━━`);
console.log(`  errors captured: ${errs.length}`);
errs.forEach((e) => console.log(`    [${e.kind}] ${e.msg}`));
console.log(`  screenshots: ${OUT}`);
console.log(`\nLeaving browser open. Close it when done.`);
await pause(60_000_000); // stay open
await browser.close();
