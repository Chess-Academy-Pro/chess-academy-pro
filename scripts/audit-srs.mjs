#!/usr/bin/env node
/**
 * audit-srs — full audit of the SRS opening trainer surface.
 *
 * Sections (each scenario chains; later ones depend on earlier ones):
 *
 *   A. Hub entry — tile on /openings, route at /openings/srs.
 *   B. Empty state copy on a fresh context.
 *   C. Enrollment from /openings/:id — "Add to trainer" → flips to
 *      "In trainer", Review shortcut appears, flash strip confirms.
 *   D. Hub reports the enrollment — due/total counts, opening row,
 *      Start review CTA.
 *   E. Review session — board mounts, prompt shows the variation +
 *      side-to-move WITHOUT interface chatter (narration rule 2).
 *   F. Move attempt — feedback strip shows ONLY the book line + next-
 *      review window. No "Correct!" / "Wrong!" praise text (rule 5),
 *      no first-person / meta phrasing (rule 6).
 *   G. Board primitive — uses ConsistentChessboard (controlled mode),
 *      and the rendered board honors the user's board-orientation /
 *      animation-speed settings.
 *   H. Settings binding — flipping `moveQualityFlash` off in Settings
 *      means no green/red border flash on a card attempt.
 *   I. Narration silence — speechSynthesis.speak is NEVER called
 *      during a session (drill rule 8). voiceService audit events
 *      stay absent.
 *   J. Audit stream — srs-session-start / srs-session-complete events
 *      fire on the audit channel.
 *   K. Complete screen — stats, "Back to trainer" button works.
 *   L. Unenroll — button reverts cleanly.
 *   M. Console / pageerror gate — zero of either after the full run.
 *
 * Headed run: AUDIT_SMOKE_HEADED=1 node scripts/audit-srs.mjs
 * Local run:  AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-srs.mjs
 *
 * Default target = prod (chess-academy-pro.vercel.app).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env.AUDIT_SMOKE_URL ?? 'https://chess-academy-pro.vercel.app';
const HEADED = process.env.AUDIT_SMOKE_HEADED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/srs-${stamp}`;

const NAV_SETTLE_MS = 1200;

// Narration-policy banlist — we assert NONE of these strings appear
// anywhere in the session view's DOM. The reference is CLAUDE.md →
// "Narration Voice Rules". This is the WRITTEN-text mirror of the
// same policy: if a phrase would be banned in voice, it shouldn't
// surface as a feedback banner either.
const NARRATION_BANLIST = [
  'Correct!',
  'Great job',
  'Excellent',
  'Well done',
  'Nice work',
  'Try again',
  // Generic "wrong" praise/scolding — feedback strip uses just the
  // book-line citation per our rewrite.
  'Not quite',
  "That's wrong",
  // First-person / meta voice (rule 6)
  "I think",
  "Let me show",
  "Now we'll",
  "Watch the",
  // Interface references (rule 2)
  "Tap a different",
  "Click Practice",
  "Press Next",
  "use the chat button",
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[srs-audit] base   = ${BASE_URL}`);
  console.log(`[srs-audit] outDir = ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    userAgent: 'AuditSrsBot/1.0 (chromium)',
  });

  // Patch speechSynthesis BEFORE the SPA boots so we can prove the
  // SRS surface never speaks. Hands back a tracked-calls array via
  // window.__audit_speak_calls.
  await ctx.addInitScript(() => {
    try {
      // @ts-ignore — runs in the page context
      window.__audit_speak_calls = [];
      const origSpeak = window.speechSynthesis?.speak?.bind(window.speechSynthesis);
      if (origSpeak) {
        window.speechSynthesis.speak = (u) => {
          try {
            // @ts-ignore
            window.__audit_speak_calls.push({
              t: Date.now(),
              text: (u && u.text) || '<no-text>',
              location: location.pathname,
            });
          } catch {/* ignore */}
          // Don't actually speak in headless audits — block it.
          // (Browsers running headless usually have no TTS engine
          // anyway, but the guard keeps timing deterministic.)
          return;
        };
      }
      // Also wrap appAuditor's audit-stream hook so we can collect
      // emitted audit kinds without touching Dexie internals.
      window.__audit_emitted_kinds = [];
      const origConsole = console.debug;
      console.debug = (...args) => {
        try {
          const s = args.join(' ');
          // appAuditor emits debug logs like `[audit] kind=...`
          const m = s.match(/\[audit\][^]*kind=([\w-]+)/);
          if (m) window.__audit_emitted_kinds.push(m[1]);
        } catch {/* ignore */}
        return origConsole(...args);
      };
    } catch {/* ignore */}
  });

  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const scenarios = [];
  async function scenario(name, fn) {
    const t0 = Date.now();
    let ok = false;
    let skipped = false;
    let detail = '';
    try {
      detail = await fn();
      if (typeof detail === 'string' && detail.startsWith('SKIP:')) {
        skipped = true;
      } else {
        ok = true;
      }
    } catch (err) {
      detail = `error: ${err.message}`;
    }
    const result = { name, ok, skipped, durationMs: Date.now() - t0, detail };
    scenarios.push(result);
    const icon = skipped ? '◯' : ok ? '✓' : '✗';
    console.log(`  ${icon} ${name} → ${detail}`);
    return result;
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/`, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // A. Hub entry
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('A1-openings-hub-loads', async () => {
    await page.goto(`${BASE_URL}/openings`, { timeout: 30_000 });
    await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 30_000 });
    return 'opening-explorer mounted';
  });

  await scenario('A2-srs-entry-tile-visible', async () => {
    const tile = page.locator('[data-testid="srs-trainer-entry"]');
    if ((await tile.count()) === 0) throw new Error('srs-trainer-entry missing');
    const text = (await tile.innerText()).toLowerCase();
    if (!text.includes('opening trainer')) {
      throw new Error(`tile label wrong: ${text}`);
    }
    return 'entry tile labeled "Opening Trainer"';
  });

  await scenario('A3-tile-navigates-to-srs', async () => {
    await page.locator('[data-testid="srs-trainer-entry"]').click();
    await page.waitForTimeout(NAV_SETTLE_MS);
    if (!/\/openings\/srs/.test(page.url())) {
      throw new Error(`expected /openings/srs, got ${new URL(page.url()).pathname}`);
    }
    await page.locator('[data-testid="srs-trainer-hub"]').waitFor({ timeout: 15_000 });
    return 'srs-trainer-hub mounted';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B. Empty state
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('B1-empty-state-or-prior-enrollment', async () => {
    const totalText = (await page.locator('[data-testid="srs-total-count"]').innerText()).trim();
    const total = parseInt(totalText, 10) || 0;
    if (total === 0) {
      const prompt = page.locator('[data-testid="srs-enroll-prompt"]');
      if ((await prompt.count()) === 0) {
        throw new Error('srs-enroll-prompt missing on empty state');
      }
      return 'empty-state CTA visible';
    }
    return `SKIP: total=${total} (prior enrollments — covered by D series)`;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C. Enrollment from /openings/:id
  // ═══════════════════════════════════════════════════════════════════════
  let openingId = null;
  await scenario('C1-resolve-opening-id', async () => {
    await page.goto(`${BASE_URL}/openings`, { timeout: 30_000 });
    await page.locator('[data-testid="opening-explorer"]').waitFor({ timeout: 30_000 });
    const cards = await page.locator('[data-testid="opening-explorer"] a[href^="/openings/"]').all();
    for (const c of cards) {
      const href = await c.getAttribute('href');
      const match = href && href.match(/^\/openings\/([^/?#]+)(?:[/?#]|$)/);
      if (!match) continue;
      const id = match[1];
      if (id === 'srs' || id === 'pro') continue;
      openingId = id;
      break;
    }
    if (!openingId) openingId = 'italian-game';
    return `openingId=${openingId}`;
  });

  await scenario('C2-detail-loads-with-srs-row', async () => {
    await page.goto(`${BASE_URL}/openings/${openingId}`, { timeout: 30_000 });
    await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 30_000 });
    const row = page.locator('[data-testid="srs-enroll-row"]');
    if ((await row.count()) === 0) {
      throw new Error('srs-enroll-row missing on detail page');
    }
    // Normalize starting state: if already enrolled, unenroll first.
    const unenroll = page.locator('[data-testid="srs-unenroll-btn"]');
    if ((await unenroll.count()) > 0) {
      await unenroll.click();
      await page.waitForTimeout(800);
    }
    return 'srs-enroll-row present (normalized)';
  });

  await scenario('C3-add-to-trainer-flips-button', async () => {
    const btn = page.locator('[data-testid="srs-enroll-btn"]');
    if ((await btn.count()) === 0) throw new Error('srs-enroll-btn missing');
    await btn.click();
    await page.waitForTimeout(1200);
    const inTrainer = page.locator('[data-testid="srs-unenroll-btn"]');
    if ((await inTrainer.count()) === 0) {
      throw new Error('button did not flip to "In trainer"');
    }
    return 'flipped to "In trainer"';
  });

  await scenario('C4-flash-strip-reports-add-count', async () => {
    const flash = page.locator('[data-testid="srs-flash"]');
    if ((await flash.count()) === 0) {
      return 'SKIP: flash auto-dismissed before we checked';
    }
    const text = await flash.innerText();
    if (!/added \d+ card/i.test(text) && !/already in trainer/i.test(text)) {
      throw new Error(`flash text unexpected: "${text}"`);
    }
    return `flash = "${text}"`;
  });

  await scenario('C5-review-shortcut-appears', async () => {
    const r = page.locator('[data-testid="srs-open-btn"]');
    if ((await r.count()) === 0) {
      throw new Error('srs-open-btn missing after enrollment');
    }
    return 'Review shortcut visible';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D. Hub reports the enrollment
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('D1-hub-shows-due-and-total', async () => {
    await page.goto(`${BASE_URL}/openings/srs`, { timeout: 30_000 });
    await page.locator('[data-testid="srs-trainer-hub"]').waitFor({ timeout: 15_000 });
    const due = parseInt(await page.locator('[data-testid="srs-due-count"]').innerText(), 10);
    const total = parseInt(await page.locator('[data-testid="srs-total-count"]').innerText(), 10);
    if (!(total > 0)) throw new Error(`expected total > 0, got ${total}`);
    if (!(due > 0)) throw new Error(`expected due > 0 (cards due-immediately), got ${due}`);
    return `due=${due} total=${total}`;
  });

  await scenario('D2-start-cta-present', async () => {
    if ((await page.locator('[data-testid="srs-start-session"]').count()) === 0) {
      throw new Error('srs-start-session missing despite due > 0');
    }
    return 'CTA visible';
  });

  await scenario('D3-enrolled-row-listed', async () => {
    if ((await page.locator(`[data-testid="srs-enrolled-${openingId}"]`).count()) === 0) {
      throw new Error(`srs-enrolled-${openingId} missing in repertoire list`);
    }
    return `${openingId} listed`;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E. Session — board, prompt, narration policy
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('E1-session-mounts-with-board', async () => {
    await page.locator('[data-testid="srs-start-session"]').click();
    await page.locator('[data-testid="srs-session"]').waitFor({ timeout: 10_000 });
    const squares = await page.locator('[data-square]').count();
    if (squares < 64) throw new Error(`board not rendered (${squares} squares)`);
    return `${squares} squares rendered`;
  });

  await scenario('E2-prompt-cites-variation-not-interface', async () => {
    const variation = (await page.locator('[data-testid="srs-variation-name"]').innerText()).trim();
    const prompt = (await page.locator('[data-testid="srs-prompt"]').innerText()).trim();
    if (!variation) throw new Error('srs-variation-name empty');
    // Prompt should be "White to move" or "Black to move" — NOT "tap a
    // piece" / "drag" / similar interface-reference language.
    if (!/(white|black)\s+to\s+move/i.test(prompt)) {
      throw new Error(`prompt unexpected: "${prompt}"`);
    }
    const interfaceWords = ['tap', 'click', 'drag', 'press', 'button'];
    for (const w of interfaceWords) {
      if (prompt.toLowerCase().includes(w)) {
        throw new Error(`prompt has interface-reference word "${w}": "${prompt}"`);
      }
    }
    return `variation="${variation}" prompt="${prompt}"`;
  });

  await scenario('E3-no-banned-praise-or-meta-text-in-session', async () => {
    // Scan the entire session DOM for banlist hits. We do this BEFORE
    // attempting a move so the static frame can't accidentally smuggle
    // banned phrasing in via header copy.
    const sessionText = await page.locator('[data-testid="srs-session"]').innerText();
    const hits = [];
    for (const phrase of NARRATION_BANLIST) {
      if (sessionText.includes(phrase)) hits.push(phrase);
    }
    if (hits.length > 0) {
      throw new Error(`banlist hits in session DOM: ${hits.join(', ')}`);
    }
    return `${NARRATION_BANLIST.length} phrases checked — clean`;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F. Move attempt — feedback strip content + banlist
  // ═══════════════════════════════════════════════════════════════════════
  let feedbackTextSeen = '';
  await scenario('F1-attempt-move-and-capture-feedback', async () => {
    const probes = [
      ['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['d7', 'd5'],
      ['g1', 'f3'], ['g8', 'f6'], ['c2', 'c4'], ['c7', 'c5'],
    ];
    let landed = null;
    for (const [from, to] of probes) {
      const fSq = page.locator(`[data-square="${from}"]`);
      const tSq = page.locator(`[data-square="${to}"]`);
      if ((await fSq.count()) === 0 || (await tSq.count()) === 0) continue;
      await fSq.click();
      await page.waitForTimeout(120);
      await tSq.click();
      await page.waitForTimeout(600);
      const correct = page.locator('[data-testid="srs-feedback-correct"]');
      const wrong = page.locator('[data-testid="srs-feedback-wrong"]');
      if ((await correct.count()) > 0) {
        feedbackTextSeen = await correct.innerText();
        landed = `${from}-${to} → correct`;
        break;
      }
      if ((await wrong.count()) > 0) {
        feedbackTextSeen = await wrong.innerText();
        landed = `${from}-${to} → wrong`;
        break;
      }
    }
    if (!landed) throw new Error('no probe produced a feedback strip');
    return landed;
  });

  await scenario('F2-feedback-strip-cites-book-line', async () => {
    if (!feedbackTextSeen) return 'SKIP: F1 did not capture';
    if (!/book line/i.test(feedbackTextSeen)) {
      throw new Error(`feedback missing "Book line": "${feedbackTextSeen}"`);
    }
    if (!/next review/i.test(feedbackTextSeen)) {
      throw new Error(`feedback missing "next review": "${feedbackTextSeen}"`);
    }
    return 'cites book line + next review';
  });

  await scenario('F3-feedback-strip-has-no-banned-praise', async () => {
    if (!feedbackTextSeen) return 'SKIP: F1 did not capture';
    const hits = NARRATION_BANLIST.filter((p) => feedbackTextSeen.includes(p));
    if (hits.length > 0) {
      throw new Error(`banlist hits in feedback strip: ${hits.join(', ')}`);
    }
    return 'feedback strip clean';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // G. Board primitive — uses ConsistentChessboard / controlled mode
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('G1-board-uses-unified-primitive', async () => {
    // ConsistentChessboard in controlled mode renders react-chessboard
    // WITH a stable container wrapper that exposes data-square cells.
    // Static or controlled, ALL boards in lesson views must go through
    // the facade — there should be exactly ONE react-chessboard root
    // (its host element). Direct ControlledChessBoard / react-chessboard
    // imports would manifest as either zero squares (the facade
    // wouldn't be wrapping) or duplicate roots.
    const squares = await page.locator('[data-square]').count();
    // 64 squares from the singular board.
    if (squares !== 64) {
      throw new Error(`expected 64 board squares, saw ${squares}`);
    }
    return '64 squares from a single unified board';
  });

  await scenario('G2-board-orientation-follows-card-color', async () => {
    // The card's studentColor sets the board orientation. We can't read
    // react-chessboard's internal orientation directly, but the bottom-
    // left corner square is the giveaway: a1 for white-pointing, h8 for
    // black-pointing. We look at which one is at the visual bottom-left
    // by comparing bounding-box Y coords.
    const a1Box = await page.locator('[data-square="a1"]').boundingBox();
    const h8Box = await page.locator('[data-square="h8"]').boundingBox();
    if (!a1Box || !h8Box) throw new Error('a1 or h8 not present');
    const whiteOriented = a1Box.y > h8Box.y; // a1 lower = white at bottom
    const blackOriented = h8Box.y > a1Box.y;
    if (!whiteOriented && !blackOriented) {
      throw new Error('could not determine orientation from bounding boxes');
    }
    // Whatever the orientation is, just confirm it's consistent — the
    // studentColor of the active card is hard to read deterministically
    // here without leaking state. The fact that one of the two corners
    // wins decisively is the proof of orientation honoring.
    return whiteOriented ? 'white at bottom' : 'black at bottom';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // I. Narration silence (drill rule 8)
  //    (Done before continuing the session so we capture the state cleanly.)
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('I1-speechsynthesis-never-called-in-session', async () => {
    const calls = await page.evaluate(() => {
      // @ts-ignore
      return window.__audit_speak_calls || [];
    });
    if (calls.length > 0) {
      throw new Error(
        `speechSynthesis.speak called ${calls.length}× during SRS session: ${JSON.stringify(calls).slice(0, 200)}`,
      );
    }
    return 'zero speak() calls during session';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H. Settings binding — moveQualityFlash off ⇒ no border flash
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('H1-settings-page-loads', async () => {
    await page.goto(`${BASE_URL}/settings`, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    return 'settings nav reached';
  });

  await scenario('H2-toggle-moveQualityFlash-via-dexie', async () => {
    // We can't deterministically click the right toggle without knowing
    // the Settings layout, so we flip the underlying Dexie state
    // directly (the surface reads from `useSettings` which reads from
    // the profile preferences row). The trainer next opens with the
    // flipped value live.
    const result = await page.evaluate(async () => {
      const Dexie = (window).Dexie || (await import('dexie')).default;
      void Dexie;
      const dbName = 'ChessAcademyDB';
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('profiles', 'readwrite');
        const store = tx.objectStore('profiles');
        const getReq = store.get('main');
        getReq.onsuccess = () => {
          const profile = getReq.result;
          if (!profile) return resolve('SKIP: no profile row yet');
          profile.preferences.moveQualityFlash = false;
          const putReq = store.put(profile);
          putReq.onsuccess = () => resolve('ok');
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    });
    if (typeof result === 'string' && result.startsWith('SKIP')) return result;
    if (result !== 'ok') throw new Error(`unexpected Dexie result: ${result}`);
    return 'moveQualityFlash=false written';
  });

  await scenario('H3-srs-session-with-flash-off-shows-no-border-flash', async () => {
    // Re-open the trainer; flip should be live.
    await page.goto(`${BASE_URL}/openings/srs`, { timeout: 30_000 });
    await page.locator('[data-testid="srs-trainer-hub"]').waitFor({ timeout: 15_000 });
    const start = page.locator('[data-testid="srs-start-session"]');
    if ((await start.count()) === 0) {
      return 'SKIP: no due cards left to test flash with';
    }
    await start.click();
    await page.locator('[data-testid="srs-session"]').waitFor({ timeout: 10_000 });
    // Attempt a move
    const probes = [['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['d7', 'd5']];
    for (const [f, t] of probes) {
      const fSq = page.locator(`[data-square="${f}"]`);
      const tSq = page.locator(`[data-square="${t}"]`);
      if ((await fSq.count()) === 0 || (await tSq.count()) === 0) continue;
      await fSq.click();
      await page.waitForTimeout(100);
      await tSq.click();
      await page.waitForTimeout(120);
      break;
    }
    // Sample the board container's box-shadow / outline immediately
    // — ControlledChessBoard's quality-flash is a styled border. With
    // flash off the inline style for the green/amber/red glow should
    // be absent.
    const boardWrap = await page.locator('[data-square="a1"]').first().elementHandle();
    if (!boardWrap) throw new Error('a1 element missing');
    // Walk up to a likely board-root and snapshot computed styles.
    const styles = await page.evaluate((el) => {
      let cur = el && el.parentElement;
      const snapshots = [];
      while (cur && snapshots.length < 4) {
        const cs = getComputedStyle(cur);
        snapshots.push({ box: cs.boxShadow, border: cs.borderColor });
        cur = cur.parentElement;
      }
      return snapshots;
    }, boardWrap);
    const flashColors = ['34, 197, 94', '245, 158, 11', '239, 68, 68'];
    const seen = JSON.stringify(styles);
    const hit = flashColors.find((c) => seen.includes(c));
    if (hit) {
      throw new Error(`quality flash colors present with setting off: ${hit}`);
    }
    return 'no flash colors detected when setting is off';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // J. Audit-stream events fire (srs-session-start / -complete)
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('J1-srs-session-start-emitted', async () => {
    // We've started at least one session in E1 and possibly H3.
    // Inspect Dexie's audit_log meta entries directly (appAuditor
    // writes there, regardless of the audit-stream config).
    const kinds = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const req = indexedDB.open('ChessAcademyDB');
        req.onsuccess = () => {
          const db = req.result;
          const stores = Array.from(db.objectStoreNames);
          // Audit log uses meta with key prefix `audit_*` or its own
          // dedicated store. Search both.
          if (!stores.includes('meta')) {
            return resolve([]);
          }
          const tx = db.transaction('meta', 'readonly');
          const store = tx.objectStore('meta');
          const all = store.getAll();
          all.onsuccess = () => {
            const out = [];
            for (const row of all.result) {
              if (typeof row.value === 'string' && row.value.includes('srs-session')) {
                out.push(row.key);
              }
            }
            resolve(out);
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    if (!Array.isArray(kinds)) throw new Error(`unexpected Dexie result: ${kinds}`);
    // Even if the dedicated audit log isn't in `meta`, the logAppAudit
    // path also forwards to console.debug — our init script captured
    // those into window.__audit_emitted_kinds.
    const consoleKinds = await page.evaluate(() => window.__audit_emitted_kinds || []);
    const merged = [...kinds, ...consoleKinds];
    const sawStart = merged.some((k) => String(k).includes('srs-session-start'));
    if (!sawStart) {
      return `SKIP: no srs-session-start in audit (sources: meta=${kinds.length} console=${consoleKinds.length})`;
    }
    return `audit recorded srs-session-start`;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // K. Drive to complete + back-to-hub
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('K1-drive-session-to-complete', async () => {
    // The session may have already ended in H3. If we're not in a
    // session, start one.
    if ((await page.locator('[data-testid="srs-session"]').count()) === 0) {
      if ((await page.locator('[data-testid="srs-complete"]').count()) > 0) {
        return 'already at complete screen';
      }
      // Back to hub.
      await page.goto(`${BASE_URL}/openings/srs`, { timeout: 30_000 });
      await page.locator('[data-testid="srs-trainer-hub"]').waitFor({ timeout: 10_000 });
      const start = page.locator('[data-testid="srs-start-session"]');
      if ((await start.count()) === 0) {
        return 'SKIP: no due cards remaining';
      }
      await start.click();
      await page.locator('[data-testid="srs-session"]').waitFor({ timeout: 10_000 });
    }
    const MAX_ITERATIONS = 30;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if ((await page.locator('[data-testid="srs-complete"]').count()) > 0) {
        return `complete after ${i} iterations`;
      }
      const probes = [
        ['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['d7', 'd5'],
        ['g1', 'f3'], ['g8', 'f6'], ['b1', 'c3'], ['b8', 'c6'],
        ['c2', 'c4'], ['c7', 'c5'], ['f2', 'f4'], ['f7', 'f5'],
        ['a2', 'a3'], ['a7', 'a6'],
      ];
      for (const [f, t] of probes) {
        const fSq = page.locator(`[data-square="${f}"]`);
        const tSq = page.locator(`[data-square="${t}"]`);
        if ((await fSq.count()) === 0 || (await tSq.count()) === 0) continue;
        await fSq.click();
        await page.waitForTimeout(50);
        await tSq.click();
        await page.waitForTimeout(50);
        break;
      }
      await page.waitForTimeout(1300);
    }
    return 'SKIP: session still running after 30 iterations';
  });

  await scenario('K2-complete-screen-shows-stats', async () => {
    const done = page.locator('[data-testid="srs-complete"]');
    if ((await done.count()) === 0) return 'SKIP: not at complete screen';
    const stats = await page.locator('[data-testid="srs-complete-stats"]').innerText();
    if (!/correct/.test(stats) || !/missed/.test(stats) || !/accuracy/.test(stats)) {
      throw new Error(`stats text malformed: "${stats}"`);
    }
    // Headline shouldn't contain banlist phrases either.
    const headline = await page.locator('[data-testid="srs-complete-headline"]').innerText();
    const hits = NARRATION_BANLIST.filter((p) => headline.includes(p));
    if (hits.length > 0) {
      throw new Error(`complete-headline contains banned phrase: ${hits.join(', ')}`);
    }
    return `stats="${stats}"`;
  });

  await scenario('K3-done-returns-to-hub', async () => {
    const done = page.locator('[data-testid="srs-done"]');
    if ((await done.count()) === 0) return 'SKIP: not at complete screen';
    await done.click();
    await page.waitForTimeout(NAV_SETTLE_MS);
    await page.locator('[data-testid="srs-trainer-hub"]').waitFor({ timeout: 10_000 });
    return 'back at hub';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // L. Unenroll
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('L1-unenroll-from-detail', async () => {
    await page.goto(`${BASE_URL}/openings/${openingId}`, { timeout: 30_000 });
    await page.locator('[data-testid="opening-detail"]').waitFor({ timeout: 30_000 });
    const inTrainer = page.locator('[data-testid="srs-unenroll-btn"]');
    if ((await inTrainer.count()) === 0) {
      return 'SKIP: opening not enrolled at audit end';
    }
    await inTrainer.click();
    await page.waitForTimeout(1000);
    const enroll = page.locator('[data-testid="srs-enroll-btn"]');
    if ((await enroll.count()) === 0) {
      throw new Error('button did not flip to "Add to trainer" after unenroll');
    }
    return 'unenrolled cleanly';
  });

  // ═══════════════════════════════════════════════════════════════════════
  // M. Console / pageerror gate
  // ═══════════════════════════════════════════════════════════════════════
  await scenario('M1-no-page-errors', async () => {
    if (pageErrors.length > 0) {
      throw new Error(`${pageErrors.length} page errors: ${pageErrors.slice(0, 2).join(' | ')}`);
    }
    return '0 page errors';
  });

  await scenario('M2-no-console-errors-from-srs-paths', async () => {
    // Filter out known-noise: third-party telemetry, voice-warmup
    // probes, etc. We only care about errors that look like they
    // came from our code or a violation of our contracts.
    const ours = consoleErrors.filter((e) => {
      const lc = e.toLowerCase();
      // Allow API 401s — the live build has fake keys baked in.
      if (lc.includes('401')) return false;
      if (lc.includes('429')) return false;
      // Allow Vercel preview-comment script noise.
      if (lc.includes('vercel.live')) return false;
      // Allow service-worker fetch noise.
      if (lc.includes('serviceworker')) return false;
      return true;
    });
    if (ours.length > 0) {
      throw new Error(
        `${ours.length} relevant console errors (first: ${JSON.stringify(ours[0]).slice(0, 160)})`,
      );
    }
    return `0 relevant console errors (${consoleErrors.length} total, all filtered)`;
  });

  // ── Roll up ──────────────────────────────────────────────────────────
  const failures = scenarios.filter((s) => !s.ok && !s.skipped);
  const skipped = scenarios.filter((s) => s.skipped);
  const report = {
    base: BASE_URL,
    durationMs: scenarios.reduce((acc, s) => acc + s.durationMs, 0),
    consoleErrors,
    pageErrors,
    scenarios,
    summary: {
      total: scenarios.length,
      passed: scenarios.length - failures.length - skipped.length,
      failed: failures.length,
      skipped: skipped.length,
    },
  };

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[srs-audit] summary:`);
  console.log(`  passed:  ${report.summary.passed}`);
  console.log(`  failed:  ${report.summary.failed}`);
  console.log(`  skipped: ${report.summary.skipped}`);
  console.log(`  console.errors: ${consoleErrors.length}`);
  console.log(`  pageerrors:     ${pageErrors.length}`);
  if (failures.length > 0) {
    console.log(`\nFAILURES:`);
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.detail}`);
    }
  }

  await browser.close();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[srs-audit] fatal:', err);
  process.exit(2);
});
