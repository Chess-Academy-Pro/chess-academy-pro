#!/usr/bin/env node
/**
 * open-with-audit.mjs — open headed Chromium pointed at prod with
 * audit-stream PRE-ENABLED via localStorage. David drives in the
 * window; Claude polls the stream and surfaces events.
 *
 * Audit-stream config lives at:
 *   localStorage['auditStreamUrl']    = '<URL>/api/audit-stream'
 *   localStorage['auditStreamSecret'] = '<SECRET>'
 *
 * The app's appAuditor reads these on boot (legacy fallback for
 * pre-Dexie installs) so every logAppAudit POSTs to the stream.
 */
import { chromium } from 'playwright';

const URL = 'https://chess-academy-pro.vercel.app/openings';
const CHROMIUM_PATH = process.env.WATCH_CHROMIUM_PATH;
const SECRET = '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const STREAM_URL = 'https://chess-academy-pro.vercel.app/api/audit-stream';

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROMIUM_PATH,
  args: ['--window-size=1400,1000', '--window-position=200,80'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
});

// Pre-inject audit-stream config BEFORE any page load
await ctx.addInitScript(({ url, secret }) => {
  try {
    window.localStorage.setItem('auditStreamUrl', url);
    window.localStorage.setItem('auditStreamSecret', secret);
  } catch {
    // localStorage unavailable in some contexts
  }
}, { url: STREAM_URL, secret: SECRET });

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`[ERROR] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
console.log(`[opened] ${URL}`);
console.log(`[opened] audit-stream pre-configured (localStorage flushed)`);
console.log(`[opened] Drive in the window. Claude watches the stream.`);

await new Promise(() => {});
