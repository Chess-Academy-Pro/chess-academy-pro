#!/usr/bin/env node
/**
 * screenshot-pirc.mjs — open prod, navigate to the Pirc Austrian Attack
 * variation, walk through every ply, screenshot each step. Surface
 * anything that looks visually broken (hanging pieces, illegal-looking
 * captures, missing narration, etc.).
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const URL = 'https://chess-academy-pro.vercel.app/openings/pirc-defence';
const CHROMIUM_PATH = process.env.WATCH_CHROMIUM_PATH;
const OUT = `/tmp/pirc-screenshots-${Date.now()}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROMIUM_PATH,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

const consoleErrs = [];
page.on('pageerror', (e) => consoleErrs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(`console.error: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Screenshot 1 — page loaded, opening detail visible
await page.screenshot({ path: `${OUT}/00-loaded.png`, fullPage: false });

// Find a tile / button that selects the "Austrian Attack" variation
const austrianTile = page.getByText('Austrian Attack', { exact: false }).first();
if (await austrianTile.isVisible().catch(() => false)) {
  await austrianTile.click({ trial: false }).catch(() => {});
  console.log('Clicked Austrian Attack tile');
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: `${OUT}/01-austrian-selected.png` });

// Try to click a Start / Watch / Play button if there is one
const startBtns = ['Start', 'Watch', 'Play walkthrough', 'Begin', 'Walkthrough', 'Replay'];
for (const t of startBtns) {
  const b = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
  if (await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    console.log(`Clicked "${t}"`);
    await page.waitForTimeout(1500);
    break;
  }
}
await page.screenshot({ path: `${OUT}/02-walkthrough-started.png` });

// Now step through plies — try every reasonable "next" selector
let advanced = 0;
const NEXT_SELECTORS = [
  '[data-testid="walkthrough-next"]',
  'button[aria-label*="next" i]',
  'button[aria-label*="forward" i]',
  'button[title*="next" i]',
];
for (let i = 0; i < 30; i++) {
  let clicked = false;
  for (const sel of NEXT_SELECTORS) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
      await btn.click().catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // Try a button with chevron-right or → text
    const arrow = page.locator('button:has-text("→"), button:has-text("Next")').first();
    if (await arrow.isVisible().catch(() => false)) {
      await arrow.click().catch(() => {});
      clicked = true;
    }
  }
  if (!clicked) break;
  advanced++;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/ply-${String(i + 1).padStart(2, '0')}.png` });
}

console.log(`Advanced ${advanced} plies`);
console.log(`Screenshots: ${OUT}`);
console.log(`Errors: ${consoleErrs.length}`);
for (const err of consoleErrs.slice(0, 20)) console.log(`  ${err}`);

await browser.close();
