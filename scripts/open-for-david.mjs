#!/usr/bin/env node
/**
 * open-for-david.mjs — open headed Chromium pointed at prod so David
 * can drive while Claude watches the audit stream. No auto-clicking;
 * just an empty browser window on the openings hub.
 */
import { chromium } from 'playwright';

const URL = process.env.WATCH_URL ?? 'https://chess-academy-pro.vercel.app/openings';
const CHROMIUM_PATH = process.env.WATCH_CHROMIUM_PATH;

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROMIUM_PATH,
  args: ['--window-size=1400,1000', '--window-position=200,80'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

// Capture errors so we can report them
page.on('pageerror', (e) => console.log(`[ERROR] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
console.log(`[opened] ${URL}`);
console.log(`[opened] page is yours — close the window when done`);

// Keep alive until the browser is closed manually
await new Promise(() => {});
