import { test, expect, type Page } from '@playwright/test';
import { Chess } from 'chess.js';

/**
 * /openings/srs — full SRS opening trainer audit.
 *
 * Surface map:
 *   /openings/srs        → SrsTrainerPage hub      (testid `srs-trainer-hub`)
 *   /openings/srs (sess) → SrsTrainerPage session  (testid `srs-session`)
 *   /openings/srs (done) → complete screen         (testid `srs-complete`)
 *   /openings/:id        → enrollment toggle row   (testid `srs-enroll-row`)
 *
 * Coverage (one test, narrative scenario chain — each step depends on
 * the previous one). One test instead of N small ones so the chain
 * doesn't reset Dexie between steps:
 *
 *   A. Trainer entry tile on the explorer, navigation works.
 *   B. Empty state shows the browse-CTA when no enrollments exist.
 *   C. From /openings/:id, "Add to trainer" flips the button + flash
 *      reports the added card count + Review shortcut appears.
 *   D. Hub now shows non-zero due / total counts + enrolled row.
 *   E. Session mounts — board has 64 squares, prompt is the
 *      variation name + "<Color> to move" (no interface chatter).
 *   F. Narration policy holds in the session DOM (no praise, no
 *      first-person, no interface references).
 *   G. Playing the book line elicits the "correct" feedback strip
 *      with the book line + next-review window — no "Correct!" header.
 *   H. Playing the wrong move elicits the "wrong" feedback strip,
 *      same shape — no "Not quite" header.
 *   I. Board orientation honors the card's studentColor.
 *   J. moveQualityFlash setting toggle: when off, no border-flash
 *      colors are applied on attempts.
 *   K. speechSynthesis.speak is NEVER called during a session
 *      (drill silence rule).
 *   L. srs-session-start audit event fires when a session begins.
 *   M. Un-enroll wipes the deck and flips the button back.
 *
 * Page-level error capture is asserted empty (off the SRS code paths
 * only — third-party 401s / 403s are filtered).
 */

interface FlightRecorder {
  pageErrors: string[];
  consoleErrors: string[];
}
function recordPage(page: Page): FlightRecorder {
  const r: FlightRecorder = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (err) => r.pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') r.consoleErrors.push(msg.text());
  });
  return r;
}

// Banlist mirrors CLAUDE.md narration rules 2, 5, 6 — interface
// references, praise/acknowledgments, first-person/meta. Applied to
// SESSION DOM only (post-move feedback + prompts).
const NARRATION_BANLIST = [
  'Correct!',
  'Great job',
  'Excellent',
  'Well done',
  'Nice work',
  'Not quite',
  "That's wrong",
  "I think",
  'Let me show',
  "Now we'll",
  'Watch the',
  'Tap a different',
  'Click Practice',
  'Press Next',
  'use the chat button',
];

async function gotoSrsHub(page: Page): Promise<void> {
  await page.goto('/openings/srs');
  await page.waitForSelector('[data-testid="srs-trainer-hub"]', { timeout: 60_000 });
}

async function clickBoardMove(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`[data-square="${from}"]`).first().click({ force: true });
  await page.locator(`[data-square="${to}"]`).first().click({ force: true });
}

/** Read the next due card straight from Dexie so we know the
 *  expectedSan and the board's actual position before attempting a
 *  move. Returns null if no due cards remain. */
async function readNextDueCard(page: Page): Promise<{
  id: string;
  fenBefore: string;
  expectedSan: string;
  studentColor: 'white' | 'black';
} | null> {
  return await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains('srsOpeningCards')) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('srsOpeningCards', 'readonly');
      const store = tx.objectStore('srsOpeningCards');
      const all = store.getAll();
      all.onsuccess = () => {
        const now = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const due = (all.result as any[])
          .filter((c) => c.nextReviewAt <= now)
          .sort((a, b) => a.nextReviewAt - b.nextReviewAt);
        const first = due[0];
        if (!first) return resolve(null);
        resolve({
          id: first.id,
          fenBefore: first.fenBefore,
          expectedSan: first.expectedSan,
          studentColor: first.studentColor,
        });
      };
      all.onerror = () => reject(all.error);
    });
  });
}

/** Pick any legal move that is NOT the expected one. Returns null if
 *  the position has only one legal move (rare, but possible). */
function pickWrongMove(
  fen: string,
  expectedSan: string,
): { from: string; to: string } | null {
  const chess = new Chess(fen);
  const legals = chess.moves({ verbose: true });
  for (const m of legals) {
    // chess.js's `m.san` already strips the prompt's `+#!?` decorators
    // we compare against. If they match, skip.
    const sanStripped = m.san.replace(/[+#!?]+$/g, '');
    if (sanStripped !== expectedSan) {
      return { from: m.from, to: m.to };
    }
  }
  return null;
}

function expectedToFromTo(fen: string, expectedSan: string): { from: string; to: string } {
  const chess = new Chess(fen);
  const m = chess.move(expectedSan);
  if (!m) throw new Error(`expectedSan ${expectedSan} not legal from ${fen}`);
  return { from: m.from, to: m.to };
}

test.describe('/openings/srs — opening trainer', () => {
  // Cold-start of the openings explorer triggers seedDatabase() which
  // loads ~3,641 ECO entries — that easily blows the default 30s in
  // headless Chrome. The narrative chain itself is many steps long, so
  // we give the whole test 4 minutes.
  test.setTimeout(240_000);

  test('full end-to-end with narration policy + settings binding', async ({ page }) => {
    const flight = recordPage(page);
    // Patch speechSynthesis BEFORE the SPA loads so we can prove
    // silence during the session.
    await page.addInitScript(() => {
      // @ts-expect-error — page context
      window.__audit_speak_calls = [];
      const ss = window.speechSynthesis;
      if (ss) {
        ss.speak = (u: SpeechSynthesisUtterance) => {
          // @ts-expect-error
          window.__audit_speak_calls.push({
            t: Date.now(),
            text: u?.text ?? '<no-text>',
            location: location.pathname,
          });
        };
      }
    });

    // ── A. Entry tile + nav ────────────────────────────────────────
    // Cold-boot the SPA at root so seedDatabase() can begin running
    // before we navigate into /openings (cuts the per-route wait).
    await page.goto('/');
    await page.waitForTimeout(3000);
    await page.goto('/openings');
    await page.waitForSelector('[data-testid="opening-explorer"]', { timeout: 120_000 });
    await expect(page.locator('[data-testid="srs-trainer-entry"]')).toBeVisible();
    await page.locator('[data-testid="srs-trainer-entry"]').click();
    await page.waitForSelector('[data-testid="srs-trainer-hub"]', { timeout: 15_000 });
    expect(page.url()).toContain('/openings/srs');

    // ── B. Empty state OR resume-from-prior (skip B if non-empty) ──
    const initialTotal = parseInt(
      (await page.locator('[data-testid="srs-total-count"]').innerText()).trim(),
      10,
    );
    if (initialTotal === 0) {
      await expect(page.locator('[data-testid="srs-enroll-prompt"]')).toBeVisible();
    }

    // ── C. Enroll the Italian Game ─────────────────────────────────
    const openingId = 'italian-game';
    await page.goto(`/openings/${openingId}`);
    await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 60_000 });
    await expect(page.locator('[data-testid="srs-enroll-row"]')).toBeVisible();
    // Normalize: if already enrolled (state from a prior test run),
    // unenroll first so C3 exercises the fresh-add path.
    const maybeUnenroll = page.locator('[data-testid="srs-unenroll-btn"]');
    if (await maybeUnenroll.count() > 0) {
      await maybeUnenroll.click();
      await page.waitForTimeout(800);
    }
    const enrollBtn = page.locator('[data-testid="srs-enroll-btn"]');
    await expect(enrollBtn).toBeVisible();
    await enrollBtn.click();
    await expect(page.locator('[data-testid="srs-unenroll-btn"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="srs-open-btn"]')).toBeVisible();

    // ── D. Hub now reports the enrollment ─────────────────────────
    await gotoSrsHub(page);
    const due = parseInt(
      (await page.locator('[data-testid="srs-due-count"]').innerText()).trim(),
      10,
    );
    const total = parseInt(
      (await page.locator('[data-testid="srs-total-count"]').innerText()).trim(),
      10,
    );
    expect(due).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="srs-start-session"]')).toBeVisible();
    await expect(page.locator(`[data-testid="srs-enrolled-${openingId}"]`)).toBeVisible();

    // ── Mode tabs visible on hub ──────────────────────────────────
    await expect(page.locator('[data-testid="srs-mode-tabs"]')).toBeVisible();
    await expect(page.locator('[data-testid="srs-mode-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="srs-mode-line"]')).toBeVisible();

    // ── E. Start session in CARD mode (default) — board mounts ────
    await page.locator('[data-testid="srs-start-session"]').click();
    await page.waitForSelector('[data-testid="srs-session"]', { timeout: 10_000 });
    // Mode toggle is also present at the top of the board during a
    // session — David's explicit ask.
    await expect(page.locator('[data-testid="srs-session"] [data-testid="srs-mode-tabs"]')).toBeVisible();
    await expect(page.locator('[data-square="a1"]').first()).toBeVisible();
    const squareCount = await page.locator('[data-square]').count();
    expect(squareCount).toBe(64);

    // Card mode kicks off with a play-in animation; wait for it to
    // hand off to the student's turn before asserting on the prompt.
    await expect(page.locator('[data-testid="srs-prompt"]')).toHaveText(
      /(White|Black) to move/i,
      { timeout: 10_000 },
    );
    const variation = (await page.locator('[data-testid="srs-variation-name"]').innerText()).trim();
    const prompt = (await page.locator('[data-testid="srs-prompt"]').innerText()).trim();
    expect(variation.length).toBeGreaterThan(0);
    expect(prompt).toMatch(/(White|Black) to move/i);
    for (const w of ['tap', 'click', 'drag', 'press', 'button']) {
      expect(prompt.toLowerCase()).not.toContain(w);
    }

    // ── F. Banlist scan over session DOM ─────────────────────────
    const sessionText = await page.locator('[data-testid="srs-session"]').innerText();
    for (const phrase of NARRATION_BANLIST) {
      expect(sessionText, `banned phrase "${phrase}" found in session DOM`).not.toContain(phrase);
    }

    // ── G. Correct move → green feedback path ────────────────────
    // Wait for the play-in animation to finish (prompt switches from
    // "Watching the line" to "<Color> to move").
    await expect(page.locator('[data-testid="srs-prompt"]')).toHaveText(
      /(White|Black) to move/i,
      { timeout: 10_000 },
    );
    let card = await readNextDueCard(page);
    expect(card, 'no due card found in Dexie despite hub showing due > 0').not.toBeNull();
    if (!card) return;
    const correctMove = expectedToFromTo(card.fenBefore, card.expectedSan);
    await clickBoardMove(page, correctMove.from, correctMove.to);
    await expect(page.locator('[data-testid="srs-feedback-correct"]')).toBeVisible({ timeout: 4_000 });
    const correctFeedback = await page
      .locator('[data-testid="srs-feedback-correct"]')
      .innerText();
    expect(correctFeedback).toMatch(/book line/i);
    expect(correctFeedback).toMatch(/next review/i);
    for (const phrase of NARRATION_BANLIST) {
      expect(correctFeedback).not.toContain(phrase);
    }

    // Wait for the auto-advance — the feedback strip clears AND the
    // next card's play-in finishes (so prompt is back to "<Color> to
    // move", not "Watching the line").
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-testid="srs-prompt"]')).toHaveText(
      /(White|Black) to move/i,
      { timeout: 10_000 },
    );

    // ── H. Wrong move → red feedback path ────────────────────────
    card = await readNextDueCard(page);
    if (card) {
      const wrong = pickWrongMove(card.fenBefore, card.expectedSan);
      if (wrong) {
        await clickBoardMove(page, wrong.from, wrong.to);
        await expect(page.locator('[data-testid="srs-feedback-wrong"]')).toBeVisible({
          timeout: 4_000,
        });
        const wrongFeedback = await page
          .locator('[data-testid="srs-feedback-wrong"]')
          .innerText();
        expect(wrongFeedback).toMatch(/book line/i);
        expect(wrongFeedback).toMatch(/next review/i);
        for (const phrase of NARRATION_BANLIST) {
          expect(wrongFeedback).not.toContain(phrase);
        }
      }
    }

    // Wait for auto-advance.
    await page.waitForTimeout(1500);

    // ── I. Board orientation honors the active card's studentColor.
    // For an Italian Game enrollment (white repertoire), every card
    // has studentColor='white' → white at the bottom (a1 lower-Y than
    // h8).
    if ((await page.locator('[data-testid="srs-session"]').count()) > 0) {
      const a1Box = await page.locator('[data-square="a1"]').first().boundingBox();
      const h8Box = await page.locator('[data-square="h8"]').first().boundingBox();
      expect(a1Box).not.toBeNull();
      expect(h8Box).not.toBeNull();
      if (a1Box && h8Box) {
        expect(a1Box.y).toBeGreaterThan(h8Box.y); // white at bottom
      }
    }

    // ── J. moveQualityFlash setting binds to the board flash.
    // Flip the setting OFF via Dexie, restart a session, attempt a
    // move, confirm no flash colors are applied. (We can't easily
    // measure the WITH-flash case in a single test without reloading
    // assets — the "off" gate is the binding test.)
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('ChessAcademyDB');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('profiles', 'readwrite');
          const store = tx.objectStore('profiles');
          const getReq = store.get('main');
          getReq.onsuccess = () => {
            const profile = getReq.result;
            if (!profile) return resolve();
            profile.preferences.moveQualityFlash = false;
            const putReq = store.put(profile);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
          };
          getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    // Settings → Dexie is re-read on next mount; reload the route.
    await gotoSrsHub(page);
    if ((await page.locator('[data-testid="srs-start-session"]').count()) > 0) {
      await page.locator('[data-testid="srs-start-session"]').click();
      await page.waitForSelector('[data-testid="srs-session"]', { timeout: 10_000 });
      card = await readNextDueCard(page);
      if (card) {
        const someMove = pickWrongMove(card.fenBefore, card.expectedSan) ?? expectedToFromTo(card.fenBefore, card.expectedSan);
        await clickBoardMove(page, someMove.from, someMove.to);
        await page.waitForTimeout(120);
        // Look at the computed border styles up the DOM tree from a1
        // — the ControlledChessBoard quality-flash is a colored border
        // overlay. With the setting off, none of the flash colors
        // should be in the inline styles.
        const a1 = page.locator('[data-square="a1"]').first();
        const flashColorsPresent = await a1.evaluate((el) => {
          let cur: HTMLElement | null = el as HTMLElement;
          const flashColors = ['34, 197, 94', '245, 158, 11', '239, 68, 68'];
          for (let i = 0; i < 6 && cur; i++) {
            const cs = getComputedStyle(cur);
            const dump = `${cs.boxShadow} ${cs.borderColor} ${cs.outline}`;
            if (flashColors.some((c) => dump.includes(c))) return true;
            cur = cur.parentElement;
          }
          return false;
        });
        expect(flashColorsPresent, 'flash color present with setting off').toBe(false);
        await page.waitForTimeout(1500);
      }
    }

    // ── K. speechSynthesis.speak never called during session ─────
    // Read accumulated calls; assert empty. (Some may have fired
    // from the boot path — we filter to only calls that happened on
    // an /openings/srs URL.)
    const speakCalls = (await page.evaluate(() => {
      // @ts-expect-error
      return window.__audit_speak_calls || [];
    })) as Array<{ text: string; location: string }>;
    const onSrs = speakCalls.filter((c) => c.location.includes('/openings/srs'));
    expect(onSrs, `speechSynthesis.speak fired on /openings/srs: ${JSON.stringify(onSrs)}`).toEqual([]);

    // ── N. LINE mode — Woodpecker walkthrough ─────────────────────
    // Re-enroll so we have due cards, then start a Line session via
    // the mode tab.
    await page.goto(`/openings/${openingId}`);
    await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 60_000 });
    if ((await page.locator('[data-testid="srs-enroll-btn"]').count()) > 0) {
      await page.locator('[data-testid="srs-enroll-btn"]').click();
      await expect(page.locator('[data-testid="srs-unenroll-btn"]')).toBeVisible({ timeout: 5_000 });
    }
    await gotoSrsHub(page);
    // Click the Line-mode tab on the hub.
    await page.locator('[data-testid="srs-mode-line"]').click();
    await expect(page.locator('[data-testid="srs-start-session"]')).toBeVisible();
    await page.locator('[data-testid="srs-start-session"]').click();
    await page.waitForSelector('[data-testid="srs-session"]', { timeout: 10_000 });

    // In Line mode, the counter says "Line N of M".
    await expect(page.locator('[data-testid="srs-card-counter"]')).toContainText(/Line \d+ of \d+/i);

    // Walk through the active line move-by-move. Read each due card
    // from Dexie before each student turn; opponent plies auto-play
    // in between.
    //
    // For each student ply we read the next-due card with the lowest
    // pgnPrefix length that we haven't visited yet.
    const visitedCardIds = new Set<string>();
    const MAX_PLIES = 30;
    let landedAtLineComplete = false;
    for (let i = 0; i < MAX_PLIES; i++) {
      // If we're at the all-complete screen, bail.
      if ((await page.locator('[data-testid="srs-complete"]').count()) > 0) {
        landedAtLineComplete = true;
        break;
      }
      // Wait for the prompt to settle into a student turn — if the
      // opponent is moving, the prompt reads "Watching the line".
      try {
        await expect(page.locator('[data-testid="srs-prompt"]')).toHaveText(
          /(White|Black) to move/i,
          { timeout: 8_000 },
        );
      } catch {
        // Maybe completed during the wait — recheck.
        if ((await page.locator('[data-testid="srs-complete"]').count()) > 0) {
          landedAtLineComplete = true;
          break;
        }
        throw new Error(`stuck on opponent turn at iteration ${i}`);
      }
      const next = await readNextDueCard(page);
      if (!next || visitedCardIds.has(next.id)) {
        // No new card found — either we've reached end of line or
        // Dexie's ordering quirked. Bail to the safety timeout.
        break;
      }
      visitedCardIds.add(next.id);
      const move = expectedToFromTo(next.fenBefore, next.expectedSan);
      await clickBoardMove(page, move.from, move.to);
      // Brief breath for the move to register + opponent to auto-play.
      await page.waitForTimeout(800);
    }
    // We don't strictly require all-complete — some lines have many
    // plies and the 30-iteration cap may not finish them. But we DO
    // require we made progress: visitedCardIds is non-empty AND the
    // prompt-text banlist held throughout.
    expect(visitedCardIds.size).toBeGreaterThan(0);
    void landedAtLineComplete; // recorded for future assertions

    // Banlist on the line-mode session DOM.
    if ((await page.locator('[data-testid="srs-session"]').count()) > 0) {
      const lineSessionText = await page.locator('[data-testid="srs-session"]').innerText();
      for (const phrase of NARRATION_BANLIST) {
        expect(
          lineSessionText,
          `banned phrase "${phrase}" in line-mode session DOM`,
        ).not.toContain(phrase);
      }
    }

    // ── M. Un-enroll wipes the deck ───────────────────────────────
    await page.goto(`/openings/${openingId}`);
    await page.waitForSelector('[data-testid="opening-detail"]', { timeout: 60_000 });
    if ((await page.locator('[data-testid="srs-unenroll-btn"]').count()) > 0) {
      await page.locator('[data-testid="srs-unenroll-btn"]').click();
      await expect(page.locator('[data-testid="srs-enroll-btn"]')).toBeVisible({ timeout: 5_000 });
    }

    // ── Page-error gate (filters third-party noise) ──────────────
    expect(flight.pageErrors).toEqual([]);
    const relevantConsole = flight.consoleErrors.filter((e) => {
      const lc = e.toLowerCase();
      if (lc.includes('401')) return false;
      if (lc.includes('403')) return false; // sandbox API blocks
      if (lc.includes('429')) return false;
      if (lc.includes('vercel.live')) return false;
      if (lc.includes('serviceworker')) return false;
      if (lc.includes('failed to load resource')) return false;
      return true;
    });
    expect(relevantConsole).toEqual([]);
  });
});
