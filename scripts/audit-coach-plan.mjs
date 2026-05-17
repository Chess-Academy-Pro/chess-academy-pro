#!/usr/bin/env node
/**
 * Audit-coach-plan — drives /coach/plan (Training Plan rolodex)
 * end-to-end. Rewritten in WO-ROLODEX-UI-01 PR-2 when the rolodex
 * replaced the LLM-generated session-plan UI.
 *
 * Surfaces / behaviors exercised:
 *   - /coach/home → "Training Plan" tile → /coach/plan navigation
 *   - Empty state: zero favorites → per-color "Browse Openings" CTA
 *   - Card stack render: seed favorites via raw IndexedDB,
 *     reload, verify the active card body + back card tabs
 *   - Tab activation: tap a back card → it becomes active,
 *     `coach-memory-rolodex-active-card-set` audit fires
 *   - Mobile manila-folder default: folder for `lastActiveRolodexColor`
 *     reads as the selected tab on a 414px viewport
 *
 * Out of scope (later PRs):
 *   - Row deep-links (PR-3)
 *   - Drag-reorder (PR-4)
 *   - Star animation from /openings (PR-5)
 *
 * Default target = prod (chess-academy-pro.vercel.app). Override:
 *   AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-plan.mjs
 *   AUDIT_SMOKE_HEADED=1 node scripts/audit-coach-plan.mjs
 *
 * Seeding strategy: opens the `ChessAcademyDB` IndexedDB directly via
 * `indexedDB.open()` (no version arg — attaches to whatever Dexie just
 * opened during app boot, no schema upgrade triggered). Writes minimal
 * OpeningRecord rows with `isFavorite: true` for the rolodex to pick
 * up on the next route mount.
 */
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';
import { startAuditListener } from './audit-lib/audit-listener.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const PROD_SECRET =
  process.env.AUDIT_STREAM_SECRET ??
  '06fe5f2383534090df8b6ba11e79088eb665ec780175df4f032befc02a530782';
const USE_SIDECAR = BASE_URL.includes('localhost');
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/coach-plan-${stamp}`;

const BOOT_TIMEOUT_MS = 30_000;
// The rolodex auto-activate effect waits on three async steps after
// mount: coachMemoryStore.hydrate (Dexie read), getFavoriteOpenings
// (Dexie scan), then the effect itself runs. Pre-hydration audits
// queue until loadAuditStreamConfig resolves, and the POST adds
// another network hop. Local Vite dev observed ~4.5s end-to-end
// between reload and the audit POST landing in the listener, so the
// settle has to clear that window or events bleed into the next
// scenario's capture.
const HYDRATE_SETTLE_MS = 5000;
const NAV_SETTLE_MS = 2500;
const SHORT_SETTLE_MS = 2000;

/** Seed N opening records into Dexie's `openings` store with
 *  `isFavorite: true`. Runs in the page context — uses raw IDB
 *  (not Dexie's module API) so we don't need the app to expose its
 *  `db` instance to window. */
async function seedFavorites(page, openings) {
  await page.evaluate((rows) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('openings')) {
          db.close();
          reject(new Error('openings object store missing'));
          return;
        }
        const tx = db.transaction(['openings'], 'readwrite');
        const store = tx.objectStore('openings');
        for (const row of rows) {
          store.put(row);
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, openings);
}

/** Clear all openings (and the persisted coachMemory rolodex state)
 *  for a clean per-scenario baseline. */
async function resetRolodexState(page) {
  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const stores = ['openings'];
        if (db.objectStoreNames.contains('meta')) stores.push('meta');
        const tx = db.transaction(stores, 'readwrite');
        for (const name of stores) {
          tx.objectStore(name).clear();
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

function makeOpening({ id, name, color, eco }) {
  return {
    id,
    eco,
    name,
    pgn: '',
    uci: '',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    color,
    style: 'classical',
    isRepertoire: false,
    overview: null,
    keyIdeas: null,
    traps: null,
    warnings: null,
    variations: null,
    drillAccuracy: 0,
    drillAttempts: 0,
    lastStudied: null,
    woodpeckerReps: 0,
    woodpeckerSpeed: null,
    woodpeckerLastDate: null,
    isFavorite: true,
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[coach-plan] base    = ${BASE_URL}`);
  console.log(`[coach-plan] outDir  = ${OUT_DIR}`);
  console.log(`[coach-plan] headed  = ${HEADED}`);

  const listener = USE_SIDECAR ? await startAuditListener() : null;
  const STREAM_URL = listener?.url ?? `${BASE_URL}/api/audit-stream`;
  const SECRET = listener?.secret ?? PROD_SECRET;
  if (listener) console.log(`[coach-plan] listener = ${listener.url} (sidecar)`);

  const executablePath = await resolveChromiumExecutable(HEADED);
  if (executablePath) console.log(`[coach-plan] chromium = ${executablePath}`);
  const browser = await chromium.launch({ headless: !HEADED, executablePath });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditCoachPlanBot/2.0 (chromium, rolodex)',
  });

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

  const page = await ctx.newPage();

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
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 500)));

  const report = { base: BASE_URL, startedAt: stamp, surfaces: [] };

  async function record(name, action, settleMs = SHORT_SETTLE_MS, expectations = []) {
    const before = captured.length;
    const errsBefore = pageErrors.length;
    const consBefore = consoleErrors.length;
    const t0 = Date.now();
    let actionErr = null;
    try {
      await action();
      await page.waitForTimeout(settleMs);
    } catch (e) {
      actionErr = String(e?.message ?? e);
      console.log(`  [error] ${actionErr}`);
    }
    const screenshotPath = join(OUT_DIR, `${name}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {
      /* ignore */
    }
    const fresh = captured.slice(before);
    const kinds = fresh.reduce((acc, e) => {
      const k = String(e.kind ?? 'unknown');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const sortedKinds = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
    const url = page.url();
    console.log(`\n[coach-plan] ${name}  →  ${url}`);
    console.log(`  ${fresh.length} events, ${Date.now() - t0}ms`);
    for (const [kind, n] of sortedKinds.slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)} × ${kind}`);
    }
    const newConsole = consoleErrors.slice(consBefore);
    const newPage = pageErrors.slice(errsBefore);
    if (newConsole.length) console.log(`  console.errors: ${newConsole.length}`);
    if (newPage.length) console.log(`  pageerrors: ${newPage.length}`);

    const expectationResults = [];
    for (const exp of expectations) {
      let ok = false;
      let actual = '?';
      try {
        if (exp.kind === 'visible') {
          const count = await page.locator(exp.selector).count();
          const visible = count > 0
            ? await page.locator(exp.selector).first().isVisible().catch(() => false)
            : false;
          actual = visible ? 'visible' : `not-visible (count=${count})`;
          ok = visible;
        } else if (exp.kind === 'invisible') {
          const count = await page.locator(exp.selector).count();
          actual = `count=${count}`;
          ok = count === 0;
        } else if (exp.kind === 'count-gte') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count >= exp.value;
        } else if (exp.kind === 'count-eq') {
          const count = await page.locator(exp.selector).count();
          actual = String(count);
          ok = count === exp.value;
        } else if (exp.kind === 'url-matches') {
          actual = page.url();
          ok = exp.value.test(actual);
        } else if (exp.kind === 'audit-present') {
          actual = kinds[exp.audit] ? 'present' : 'absent';
          ok = !!kinds[exp.audit];
        } else if (exp.kind === 'audit-count-gte') {
          const n = kinds[exp.audit] ?? 0;
          actual = String(n);
          ok = n >= exp.value;
        } else if (exp.kind === 'attr-equals') {
          const v = await page.locator(exp.selector).first().getAttribute(exp.attr).catch(() => null);
          actual = String(v);
          ok = v === exp.value;
        }
      } catch (err) {
        actual = `error: ${err.message}`;
      }
      const result = { ...exp, actual, ok };
      expectationResults.push(result);
      console.log(`  ${ok ? '✓' : '✗'} ${exp.label} → ${actual}`);
    }

    report.surfaces.push({
      name,
      url,
      durationMs: Date.now() - t0,
      eventCount: fresh.length,
      kinds,
      screenshot: screenshotPath,
      consoleErrors: newConsole,
      pageErrors: newPage,
      sampleEvents: fresh.slice(0, 5),
      expectations: expectationResults,
      error: actionErr,
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────
  await record('boot-dashboard', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, 2000, [
    { kind: 'audit-present', audit: 'app-boot', label: 'app-boot audit fires' },
  ]);

  // Reset Dexie now that the schema is open from boot — guarantees a
  // clean per-run starting state for the rolodex tests.
  await resetRolodexState(page);

  // ── /coach/home + Training Plan tile present ─────────────────────
  await record('coach-home', async () => {
    await page.goto(`${BASE_URL}/coach/home`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
    await page.locator('[data-testid="coach-home-page"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'visible', selector: '[data-testid="coach-action-plan"]', label: 'Training Plan tile present' },
  ]);

  // ── Tile click → /coach/plan (rolodex page mounts) ───────────────
  await record('plan-tile-click', async () => {
    await page.locator('[data-testid="coach-action-plan"]').click();
    await page.waitForURL(/\/coach\/plan/, { timeout: 10_000 });
    await page.locator('[data-testid="training-plan-rolodex-page"]').waitFor({ timeout: 15_000 });
  }, NAV_SETTLE_MS, [
    { kind: 'url-matches', value: /\/coach\/plan/, label: 'navigated to /coach/plan' },
    { kind: 'visible', selector: '[data-testid="training-plan-rolodex-page"]', label: 'rolodex page root mounts' },
    { kind: 'visible', selector: '[data-testid="rolodex-folder-tabs"]', label: 'mobile folder tabs render' },
  ]);

  // ── Empty state: zero favorites → per-color Browse Openings CTA ──
  // Both panels (mobile-shown + desktop-hidden) render in the DOM, so
  // the empty-state testid appears twice. count-gte=1 is the strict
  // check; we don't pin a specific count to avoid coupling to the
  // dual-panel rendering pattern.
  await record('plan-empty-state', async () => {
    // No favorites have been seeded yet; the page should be in empty
    // state for both colors.
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'count-gte', selector: '[data-testid="rolodex-empty-state-white"]', value: 1, label: 'white empty state renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-empty-state-black"]', value: 1, label: 'black empty state renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-empty-cta-white"]', value: 1, label: 'white Browse Openings CTA renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-empty-cta-black"]', value: 1, label: 'black Browse Openings CTA renders' },
  ]);

  // ── Seed 1 white favorite, reload, verify single-card active state
  await record('plan-single-favorite', async () => {
    await seedFavorites(page, [
      makeOpening({ id: 'italian-game', name: 'Italian Game', color: 'white', eco: 'C50' }),
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="training-plan-rolodex-page"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-stack-white"]', value: 1, label: 'white stack renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-header-italian-game"]', value: 1, label: 'Italian Game card is active (header visible)' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-rows-italian-game"]', value: 1, label: 'active card body shows 8-row list' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-theory-lines"]', value: 1, label: 'Theory & Lines row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-puzzles"]', value: 1, label: 'Puzzles row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-gm-games"]', value: 1, label: 'GM Games row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-traps"]', value: 1, label: 'Traps row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-blunders"]', value: 1, label: 'Blunders row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-walkthrough"]', value: 1, label: 'Walkthrough row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-practice-from-start"]', value: 1, label: 'Practice from move 1 row present' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-practice-middlegame"]', value: 1, label: 'Practice middlegame row present' },
    // PR-3 contract: each row carries its own count element. Tracked
    // rows render "X / Y", placeholder rows render "—". Either way
    // the data-testid must exist so the audit catches regressions
    // where rows are present but counts disappear.
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-count-theory-lines"]', value: 1, label: 'Theory & Lines count element renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-count-puzzles"]', value: 1, label: 'Puzzles count element renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-count-walkthrough"]', value: 1, label: 'Walkthrough count element renders' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-row-count-gm-games"]', value: 1, label: 'GM Games count element renders (placeholder —)' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-empty-state-black"]', value: 1, label: 'black still empty (only seeded white)' },
    { kind: 'audit-present', audit: 'coach-memory-rolodex-active-card-set', label: 'first-favorite auto-activate audit fires' },
    // PR-4 reconciliation: the page's mount-time order pass adds the
    // newly-seeded favorite to userOrderedFavorites[white], firing
    // an order-set audit. Proves the reconcile wiring is live end-to-end.
    { kind: 'audit-present', audit: 'coach-memory-rolodex-order-set', label: 'reconcile fires rolodex-order-set audit' },
  ]);

  // ── Theory & Lines row tap → /openings?opening=<name> ────────────
  // One representative row-tap scenario to verify the PR-3 navigation
  // contract end-to-end. Each row's destination URL is unit-tested in
  // RolodexRow.test.tsx; the audit pins the integration.
  await record('plan-row-tap-navigation', async () => {
    await page.locator('[data-testid="rolodex-row-tap-theory-lines"]').first().click();
    await page.waitForURL(/\/openings/, { timeout: 10_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    // /openings auto-resolves `?opening=<name>` to the matched opening's
    // detail page (`/openings/<id>-<slug>`) — that's the desired UX
    // (skip the list, land on the opening). Either URL is acceptable;
    // both routes are part of the /openings surface.
    {
      kind: 'url-matches',
      value: /\/openings(\?opening=Italian|\/[a-z0-9-]*italian)/i,
      label: 'lands on /openings with the Italian Game in focus',
    },
  ]);

  // Navigate back to /coach/plan for the subsequent scenarios.
  await page.goto(`${BASE_URL}/coach/plan`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="training-plan-rolodex-page"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(HYDRATE_SETTLE_MS);

  // ── Seed multiple favorites; verify active card body + back tabs ─
  await record('plan-multi-favorite-stack', async () => {
    await seedFavorites(page, [
      makeOpening({ id: 'ruy-lopez', name: 'Ruy Lopez', color: 'white', eco: 'C60' }),
      makeOpening({ id: 'kings-indian-attack', name: "King's Indian Attack", color: 'white', eco: 'A07' }),
      makeOpening({ id: 'caro-kann', name: 'Caro-Kann Defense', color: 'black', eco: 'B10' }),
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="training-plan-rolodex-page"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-stack-white"]', value: 1, label: 'white stack renders with multiple favorites' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-stack-black"]', value: 1, label: 'black stack now renders too' },
    // Italian remains the active card from the prior scenario (active id persisted via coachMemoryStore)
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-header-italian-game"]', value: 1, label: 'Italian Game still active (persisted active id survived reload)' },
    // The two new white favorites should render as collapsed tabs
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-tab-ruy-lopez"]', value: 1, label: 'Ruy Lopez sits behind as collapsed tab' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-tab-kings-indian-attack"]', value: 1, label: "King's Indian Attack sits behind as collapsed tab" },
    // Caro-Kann is the only black favorite → it becomes active in its own column
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-header-caro-kann"]', value: 1, label: 'Caro-Kann active in the black column' },
  ]);

  // ── Tap a back card tab → it becomes active, audit fires ─────────
  await record('plan-tab-activation', async () => {
    // Pick the Ruy Lopez tab from whichever panel is hit by .first()
    // (mobile panel by default for a 414w viewport).
    await page.locator('[data-testid="rolodex-card-tab-ruy-lopez"]').first().click();
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-header-ruy-lopez"]', value: 1, label: 'Ruy Lopez is now the active card (header visible)' },
    { kind: 'count-gte', selector: '[data-testid="rolodex-card-tab-italian-game"]', value: 1, label: 'Italian Game demoted to back-card tab' },
    { kind: 'audit-present', audit: 'coach-memory-rolodex-active-card-set', label: 'active-card-set audit fires on tab activation' },
  ]);

  // ── Mobile folder default after activation (should be white) ─────
  await record('plan-mobile-folder-default', async () => {
    // The previous tab activation was on a white card, so
    // `lastActiveRolodexColor` is now 'white'. Reload to confirm
    // the default sticks across page mounts.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="training-plan-rolodex-page"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'attr-equals', selector: '[data-testid="rolodex-folder-tab-white"]', attr: 'aria-selected', value: 'true', label: 'white tab is aria-selected on reload' },
    { kind: 'attr-equals', selector: '[data-testid="rolodex-folder-tab-black"]', attr: 'aria-selected', value: 'false', label: 'black tab is NOT aria-selected on reload' },
  ]);

  // ── Tap the black folder tab → switch panel ──────────────────────
  await record('plan-mobile-folder-switch', async () => {
    await page.locator('[data-testid="rolodex-folder-tab-black"]').click();
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
  }, NAV_SETTLE_MS, [
    { kind: 'attr-equals', selector: '[data-testid="rolodex-folder-tab-black"]', attr: 'aria-selected', value: 'true', label: 'black tab becomes selected after click' },
    { kind: 'attr-equals', selector: '[data-testid="rolodex-folder-tab-white"]', attr: 'aria-selected', value: 'false', label: 'white tab is no longer selected' },
  ]);

  // ── Roll up + write report ──────────────────────────────────────
  report.totalEvents = captured.length;
  report.totalConsoleErrors = consoleErrors.length;
  report.totalPageErrors = pageErrors.length;
  report.allKindCounts = captured.reduce((acc, e) => {
    const k = String(e.kind ?? 'unknown');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const failedExpectations = report.surfaces.flatMap((s) =>
    (s.expectations ?? []).filter((e) => !e.ok).map((e) => ({ surface: s.name, ...e })),
  );

  if (listener) {
    const listenerEvents = listener.getCapturedEvents();
    report.listenerRoundTrip = {
      browserSidePOSTs: captured.length,
      listenerSideReceived: listenerEvents.length,
      mismatch: captured.length !== listenerEvents.length,
      kindCountsListener: listener.countByKind(),
      rolodexEventsFromListener: listener
        .eventsOfKind('coach-memory-rolodex-active-card-set')
        .slice(0, 10)
        .map((e) => ({ summary: e.summary, timestamp: e.timestamp })),
    };
    console.log(
      `[coach-plan] listener: browser-sent=${captured.length}  server-received=${listenerEvents.length}  ${report.listenerRoundTrip.mismatch ? '⚠ MISMATCH' : '✓ round-trip ok'}`,
    );
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n[coach-plan] done — ${captured.length} total events, ${consoleErrors.length} console.errors, ${pageErrors.length} pageerrors`,
  );
  if (failedExpectations.length > 0) {
    console.log(`[coach-plan] FAILED expectations: ${failedExpectations.length}`);
    for (const e of failedExpectations) {
      console.log(`  ✗ ${e.surface} → ${e.label}: ${e.actual}`);
    }
  } else {
    console.log(`[coach-plan] all expectations passed`);
  }
  console.log(`[coach-plan] report: ${OUT_DIR}/report.json`);

  await browser.close();
  if (listener) await listener.stop();
  process.exit(failedExpectations.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[coach-plan] fatal:', err);
  process.exit(1);
});
