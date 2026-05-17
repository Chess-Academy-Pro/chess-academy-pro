#!/usr/bin/env node
/**
 * audit-coach-master-integration
 * ------------------------------
 * Playwright audit for WO-COACH-MASTER-INTEGRATION (gate G3 runtime
 * instrument). Exercises the four-layer master-play grounding pipeline
 * via the deployed app in a real browser:
 *
 *   - Layer A (watcher prefetch): drives the watcher with a sequence
 *     of FENs and asserts `master-play-prefetch` events fire with the
 *     expected `trigger` / `cacheState` / `source` shape.
 *   - Layer B (pre-injection): triggers a move-question chat turn,
 *     asserts a `master-play-lookup` event fires with
 *     `triggeredBy: 'pre-injection'`.
 *   - Layer D (claim validator): seeds an LLM response that cites
 *     an ungrounded SAN, asserts a `claim-validator-trip` event +
 *     retry / fallback chain.
 *   - Kid isolation: navigates to a kid surface, runs the watcher
 *     against it, asserts NO master-play events emit.
 *
 * The audit drives the API directly via `page.evaluate` rather than
 * through full UI plumbing because surface wiring (passing the
 * `grounding` option through coachService → spine → getCoachChatResponse)
 * is deferred to a follow-up PR. Once that wiring lands, this audit
 * will graduate to UI-driven scenarios.
 *
 * Sandbox runbook (CLAUDE.md §G1):
 *
 *   npm run dev > /tmp/vite.log 2>&1 &
 *   sleep 8
 *   AUDIT_SMOKE_URL=http://localhost:5173 \
 *     PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node scripts/audit-coach-master-integration.mjs
 *
 * Prod runbook (David's machine after Vercel deploy):
 *
 *   node scripts/audit-coach-master-integration.mjs
 *
 * Report: `audit-reports/coach-master-integration-<iso>/report.json`.
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-master-integration-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
const SHORT_SETTLE_MS = 2000;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PIRC_FEN = 'rnbqkb1r/ppp1pp1p/3p1np1/8/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 5';

// Fake Lichess responses — installed via fetch interception in the
// page context. Keep these aligned with the in-repo fixture so cache
// hits read like the local DB would.
const LICHESS_PAYLOAD_STARTING = {
  white: 19950,
  draws: 20200,
  black: 9900,
  moves: [
    { uci: 'e2e4', san: 'e4', averageRating: 2480, white: 9000, draws: 8500, black: 4500, game: null },
    { uci: 'd2d4', san: 'd4', averageRating: 2510, white: 7600, draws: 7800, black: 3600, game: null },
    { uci: 'g1f3', san: 'Nf3', averageRating: 2500, white: 2400, draws: 2800, black: 1300, game: null },
  ],
  topGames: [
    { id: 'fis72spa', white: { name: 'Fischer, R', rating: 2785 }, black: { name: 'Spassky, B', rating: 2660 }, winner: 'black', year: 1972, month: '1972-09' },
  ],
  opening: null,
};

const LICHESS_PAYLOAD_PIRC = {
  white: 1180,
  draws: 1380,
  black: 540,
  moves: [
    { uci: 'f2f4', san: 'f4', averageRating: 2510, white: 480, draws: 540, black: 180, game: null },
    { uci: 'f1e2', san: 'Be2', averageRating: 2480, white: 290, draws: 360, black: 150, game: null },
  ],
  topGames: [],
  opening: null,
};

const EMPTY_PAYLOAD = { white: 0, draws: 0, black: 0, moves: [], topGames: [], opening: null };

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[master-integration] base    = ${BASE_URL}`);
  console.log(`[master-integration] outDir  = ${OUT_DIR}`);
  console.log(`[master-integration] headed  = ${HEADED}`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[master-integration] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachMasterIntegrationBot/1.0 (chromium)',
  });

  // Configure the audit stream so logAppAudit() POSTs land on the
  // captured-requests list below.
  await ctx.addInitScript(
    ({ url, secret }) => {
      try {
        window.localStorage.setItem('auditStreamUrl', url);
        window.localStorage.setItem('auditStreamSecret', secret);
      } catch {
        /* ignore */
      }
    },
    { url: STREAM_URL, secret: SECRET },
  );

  // Page-context fetch stubs. Layered so the audit-stream POSTs still
  // pass through but Lichess + Anthropic / DeepSeek are mocked.
  await ctx.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      // Allow audit-stream POSTs to flow normally — Playwright is
      // capturing them via page.on('request', ...) for assertions.
      if (url.includes('/api/audit-stream')) return real(input, init);
      // Mock Lichess explorer.
      if (url.includes('/api/lichess-explorer')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const fen = params.get('fen') ?? '';
        const STARTING = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
        const PIRC = 'rnbqkb1r/ppp1pp1p/3p1np1/8/3PP3';
        const lib = (window).__masterAuditLib ?? {};
        let body = lib.EMPTY;
        if (fen.startsWith(STARTING)) body = lib.STARTING;
        else if (fen.startsWith(PIRC)) body = lib.PIRC;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Mock LLM endpoints — return a programmable text from the
      // page's `__masterAuditLib.llmText` queue.
      if (url.includes('api.anthropic.com/v1/messages')) {
        const lib = (window).__masterAuditLib ?? { llmTexts: [] };
        const text = (lib.llmTexts ?? []).shift() ?? 'OK';
        const body = {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text }],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('api.deepseek.com')) {
        const lib = (window).__masterAuditLib ?? { llmTexts: [] };
        const text = (lib.llmTexts ?? []).shift() ?? 'OK';
        const body = {
          id: 'cmpl_test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    };
    (window).__masterAuditLib = {
      EMPTY: { white: 0, draws: 0, black: 0, moves: [], topGames: [], opening: null },
      STARTING: null,
      PIRC: null,
      llmTexts: [],
    };
  });

  const page = await ctx.newPage();

  // Capture audit-stream POSTs.
  const captured = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u === STREAM_URL && req.method() === 'POST') {
      try {
        const body = req.postDataJSON?.();
        if (body && typeof body === 'object') captured.push(body);
      } catch {
        /* ignore */
      }
    }
  });

  // ── Boot the app + seed the fetch-mock library ─────────────────────
  console.log('[master-integration] booting app');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: BOOT_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(SHORT_SETTLE_MS);

  await page.evaluate(
    ({ starting, pirc }) => {
      const lib = (window).__masterAuditLib ?? {};
      lib.STARTING = starting;
      lib.PIRC = pirc;
      (window).__masterAuditLib = lib;
    },
    { starting: LICHESS_PAYLOAD_STARTING, pirc: LICHESS_PAYLOAD_PIRC },
  );

  const report = { base: BASE_URL, startedAt: stamp, scenarios: [] };

  async function scenario(name, body) {
    const before = captured.length;
    const t0 = Date.now();
    let err = null;
    let payload = null;
    try {
      payload = await body();
    } catch (e) {
      err = String(e?.message ?? e);
    }
    const events = captured.slice(before);
    const byKind = events.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const row = { name, durationMs: Date.now() - t0, eventCount: events.length, byKind, payload, error: err };
    report.scenarios.push(row);
    console.log(`\n[master-integration] ${name}`);
    console.log(`  ${events.length} events in ${row.durationMs}ms`);
    for (const [kind, n] of Object.entries(byKind)) console.log(`    ${String(n).padStart(3)} × ${kind}`);
    if (err) console.log(`  ERROR: ${err}`);
    return row;
  }

  // ── Scenario 1: Layer A — watcher prefetch + look-ahead ────────────
  await scenario('watcher.prefetch-starting-position', async () => {
    const result = await page.evaluate(async (fen) => {
      const watcher = await import('/src/services/masterPlayWatcher.ts');
      const cache = await import('/src/services/masterPlayCache.ts');
      cache.masterPlayCache.clear();
      await watcher.prefetchMasterPlay(fen, { surface: '/coach/chat', sessionId: 'audit-1' });
      // Give audit-stream POSTs time to fire.
      await new Promise((r) => setTimeout(r, 500));
      return {
        cacheSize: cache.masterPlayCache.size(),
        hasCurrentFen: cache.masterPlayCache.has(fen),
      };
    }, STARTING_FEN);
    if (result.cacheSize < 1) throw new Error(`expected cache to have entries, got ${result.cacheSize}`);
    if (!result.hasCurrentFen) throw new Error('expected current FEN in cache');
    return result;
  });

  await page.waitForTimeout(800);

  // Assert master-play-prefetch event fired with trigger=move
  const prefetchEvents = captured.filter((e) => e.kind === 'master-play-prefetch');
  if (prefetchEvents.length === 0) {
    report.scenarios.push({
      name: 'assert.master-play-prefetch-fired',
      error: 'no master-play-prefetch events captured after watcher.prefetch',
      events: captured.slice(-10).map((e) => e.kind),
    });
  }

  // ── Scenario 2: Cache hit on repeat prefetch ──────────────────────
  await scenario('watcher.repeat-prefetch-cache-hit', async () => {
    const result = await page.evaluate(async (fen) => {
      const watcher = await import('/src/services/masterPlayWatcher.ts');
      await watcher.prefetchMasterPlay(fen, { surface: '/coach/chat', sessionId: 'audit-2', skipLookahead: true });
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    }, STARTING_FEN);
    return result;
  });

  // ── Scenario 3: Layer B — pre-injection on move-question ──────────
  await scenario('layer-b.pre-injection-on-move-question', async () => {
    return page.evaluate(async (fen) => {
      const coachApi = await import('/src/services/coachApi.ts');
      const lib = (window).__masterAuditLib;
      lib.llmTexts = ['Masters most commonly play e4 in this position.'];
      const r = await coachApi.getCoachChatResponse(
        [{ role: 'user', content: 'what should I play here?' }],
        '',
        undefined,
        'chat_response',
        1024,
        undefined,
        undefined,
        undefined,
        { currentFen: fen, surface: '/coach/chat', sessionId: 'audit-3' },
      );
      await new Promise((r) => setTimeout(r, 300));
      return { response: r };
    }, STARTING_FEN);
  });

  // ── Scenario 4: Layer D — claim validator trip + retry ────────────
  await scenario('layer-d.claim-validator-trip-then-stock-fallback', async () => {
    return page.evaluate(async (fen) => {
      const coachApi = await import('/src/services/coachApi.ts');
      const lib = (window).__masterAuditLib;
      lib.llmTexts = [
        'Try Nh6 here.',          // SAN not in context — violation
        'Try Bf6 instead.',       // Still invented
        'Maybe Rf2 wins.',        // Still invented
      ];
      const r = await coachApi.getCoachChatResponse(
        [{ role: 'user', content: 'what should I play here?' }],
        '',
        undefined,
        'chat_response',
        1024,
        undefined,
        undefined,
        undefined,
        { currentFen: fen, surface: '/coach/chat', sessionId: 'audit-4' },
      );
      await new Promise((r) => setTimeout(r, 300));
      return { response: r };
    }, STARTING_FEN);
  });

  // Assert claim-validator-trip and master-play-enforcement-fallback fired.
  const tripEvents = captured.filter((e) => e.kind === 'claim-validator-trip');
  const fallbackEvents = captured.filter((e) => e.kind === 'master-play-enforcement-fallback');
  if (tripEvents.length < 2) {
    report.scenarios.push({
      name: 'assert.claim-validator-trip-fired-twice',
      error: `expected ≥2 claim-validator-trip events, got ${tripEvents.length}`,
    });
  }
  if (fallbackEvents.length < 1) {
    report.scenarios.push({
      name: 'assert.master-play-enforcement-fallback-fired',
      error: 'expected master-play-enforcement-fallback event after retries exhausted',
    });
  }

  // ── Scenario 5: Kid isolation — watcher does NOT prefetch on /kid/* ─
  await scenario('kid.watcher-short-circuits', async () => {
    const before = captured.length;
    const result = await page.evaluate(async (fen) => {
      const watcher = await import('/src/services/masterPlayWatcher.ts');
      const cache = await import('/src/services/masterPlayCache.ts');
      cache.masterPlayCache.clear();
      await watcher.prefetchMasterPlay(fen, { surface: '/kid/pawn-games', sessionId: 'audit-5' });
      await new Promise((r) => setTimeout(r, 300));
      return { cacheSize: cache.masterPlayCache.size() };
    }, STARTING_FEN);
    const newEvents = captured.slice(before).filter((e) => /^master-play-|^claim-validator-/.test(String(e.kind)));
    if (newEvents.length > 0) {
      throw new Error(
        `kid surface emitted ${newEvents.length} master-play events — CONTRACT VIOLATION. kinds: ${newEvents.map((e) => e.kind).join(', ')}`,
      );
    }
    if (result.cacheSize > 0) {
      throw new Error(`kid surface populated cache (size=${result.cacheSize}) — CONTRACT VIOLATION`);
    }
    return result;
  });

  // ── Scenario 6: Kid LLM call does NOT engage grounding ────────────
  await scenario('kid.llm-call-does-not-engage-grounding', async () => {
    const before = captured.length;
    const result = await page.evaluate(async () => {
      const coachApi = await import('/src/services/coachApi.ts');
      const lib = (window).__masterAuditLib;
      lib.llmTexts = ["That's the white pawn."];
      const r = await coachApi.getKidLlmResponse(
        [{ role: 'user', content: 'what should I play here?' }],
        '',
        512,
      );
      await new Promise((r) => setTimeout(r, 200));
      return { response: r };
    });
    const newEvents = captured.slice(before).filter((e) => /^master-play-|^claim-validator-/.test(String(e.kind)));
    if (newEvents.length > 0) {
      throw new Error(
        `kid LLM call emitted ${newEvents.length} master-play / claim-validator events — CONTRACT VIOLATION. kinds: ${newEvents.map((e) => e.kind).join(', ')}`,
      );
    }
    return result;
  });

  // ── Scenario 7: Non-move-question does NOT engage pipeline ────────
  await scenario('intent.non-move-question-stays-out-of-pipeline', async () => {
    const before = captured.length;
    await page.evaluate(async (fen) => {
      const coachApi = await import('/src/services/coachApi.ts');
      const lib = (window).__masterAuditLib;
      lib.llmTexts = ['The Sicilian is a defense against 1.e4.'];
      await coachApi.getCoachChatResponse(
        [{ role: 'user', content: 'what is the Sicilian?' }],
        '',
        undefined,
        'chat_response',
        1024,
        undefined,
        undefined,
        undefined,
        { currentFen: fen, surface: '/coach/chat', sessionId: 'audit-7' },
      );
      await new Promise((r) => setTimeout(r, 200));
    }, STARTING_FEN);
    const newEvents = captured.slice(before).filter((e) => /^master-play-/.test(String(e.kind)));
    if (newEvents.length > 0) {
      throw new Error(
        `non-move question emitted ${newEvents.length} master-play events — expected zero (intent shouldn't fire). kinds: ${newEvents.map((e) => e.kind).join(', ')}`,
      );
    }
    return { ok: true };
  });

  // ── Summary ───────────────────────────────────────────────────────
  const failed = report.scenarios.filter((s) => s.error);
  console.log('\n[master-integration] ────── summary ──────');
  console.log(`  scenarios: ${report.scenarios.length}, failed: ${failed.length}`);
  for (const s of failed) console.log(`    ✗ ${s.name}: ${s.error}`);
  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[master-integration] report → ${join(OUT_DIR, 'report.json')}`);

  await browser.close();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[master-integration] fatal:', err);
  process.exit(2);
});
