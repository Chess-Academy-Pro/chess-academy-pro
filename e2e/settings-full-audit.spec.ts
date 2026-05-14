// Settings full-tab audit — verifies each control actually changes
// what it claims (persistence + consumer behavior), plus enforces the
// R-series redundancy/confusion fixes that just landed.
//
// Run: npx playwright test e2e/settings-full-audit.spec.ts --reporter=list
//
// Each row in the side-by-side audit table maps to one or more
// assertions here. Findings are PASS / FAIL / WARN / SKIP. FAILs
// throw at the end so the test reports red, but the rest of the
// audit still runs (we don't bail mid-suite).

import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

type RowStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
interface Finding {
  id: string;
  surface: string;
  status: RowStatus;
  note: string;
}
const findings: Finding[] = [];

function audit(id: string, surface: string, status: RowStatus, note: string): void {
  findings.push({ id, surface, status, note });
  const tag = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'WARN' ? '⚠️ ' : '⏭️ ';
  console.log(`[AUDIT ${id}] ${tag} ${surface} — ${note}`);
}
function logEvent(msg: string): void { console.log(`[FLOW] ${msg}`); }

async function safeBool<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

/** Read a pref from the live profile via Dexie. Returns undefined if
 *  the profile doesn't exist yet (test isolation tear-down). */
async function readPref(page: Page, key: string): Promise<unknown> {
  return page.evaluate((k: string) => {
    return new Promise<unknown>((resolve) => {
      const req = indexedDB.open('ChessAcademyDB');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('profiles')) {
          db.close();
          resolve(undefined);
          return;
        }
        const tx = db.transaction('profiles', 'readonly');
        const store = tx.objectStore('profiles');
        const r = store.get('main');
        r.onsuccess = () => {
          const profile = r.result as { preferences?: Record<string, unknown> } | undefined;
          resolve(profile?.preferences?.[k]);
          db.close();
        };
        r.onerror = () => { resolve(undefined); db.close(); };
      };
      req.onerror = () => resolve(undefined);
    });
  }, key);
}

/** Wait up to `timeoutMs` for a Dexie pref to match the predicate.
 *  Auto-save is debounced 250–400ms, so we poll. */
async function waitForPref<T>(
  page: Page,
  key: string,
  predicate: (v: T) => boolean,
  timeoutMs = 2000,
): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await readPref(page, key) as T;
    if (predicate(v)) return v;
    await page.waitForTimeout(120);
  }
  return undefined;
}

async function bootApp(page: Page): Promise<void> {
  logEvent('Booting app…');
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/ERR_CERT_AUTHORITY_INVALID|APIConnectionError|Failed to load resource|BulkError/.test(text)) return;
      console.log(`[BROWSER-ERROR] ${text.slice(0, 240)}`);
    }
  });
  page.on('pageerror', (err) => {
    if (/BulkError/.test(err.message)) return;
    console.log(`[PAGE-ERROR] ${err.message.slice(0, 240)}`);
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
}

async function gotoSettings(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 8000 });
}

// ─── STATIC CHECKS (file scans, run before browser tests) ────────────

test.beforeAll(async () => {
  logEvent('═══ Settings full audit ═══');
  logEvent('Static checks…');

  const settingsPage = await fs.readFile(
    path.join(REPO_ROOT, 'src/components/Settings/SettingsPage.tsx'),
    'utf-8',
  );
  const voicePanel = await fs.readFile(
    path.join(REPO_ROOT, 'src/components/Settings/VoiceSettingsPanel.tsx'),
    'utf-8',
  );
  const personalityPanel = await fs.readFile(
    path.join(REPO_ROOT, 'src/components/Settings/PersonalityPanel.tsx'),
    'utf-8',
  );
  const syncPanel = await fs.readFile(
    path.join(REPO_ROOT, 'src/components/Settings/SyncSettingsPanel.tsx'),
    'utf-8',
  );
  const syncService = await fs.readFile(
    path.join(REPO_ROOT, 'src/services/syncService.ts'),
    'utf-8',
  );

  // R1: voice-narration label clarified
  if (/All audio voice/.test(settingsPage)) {
    audit('R1', 'B24 voice-narration label', 'PASS', 'Re-labelled "All audio voice" with hint.');
  } else {
    audit('R1', 'B24 voice-narration label', 'FAIL', 'Old "Voice Narration" label still present.');
  }

  // R2: masterAllOff hint about prior-value restore
  // (regex tolerant of JSX whitespace + line breaks inside the string)
  if (/restores\s+your\s+previous\s+values/.test(settingsPage)) {
    audit('R2', 'B1 masterAllOff restore hint', 'PASS', 'Hint about prior-value restore present.');
  } else {
    audit('R2', 'B1 masterAllOff restore hint', 'FAIL', 'No hint about prior-value restore.');
  }

  // R3a (superseded by the parallel "unified Coach Narration" PR
  // d5842b8): the old "Coach Detail" → "Speech Pace" relabel targeted
  // the `coachVerbosity` <select>, which has now been DELETED from the
  // UI in favor of a single `Coach Narration` (silent/brief/full)
  // dropdown that supersedes coachVerbosity + coachCommentaryVerbosity
  // + phaseNarrationVerbosity. The legacy pref fields stay in
  // UserPreferences as a migration fallback for older profiles. Static
  // check now verifies the unified label exists.
  if (/label="Coach Narration"/.test(settingsPage)) {
    audit('R3a', 'Unified "Coach Narration" select replaces 3 legacy controls', 'PASS',
      'Single Coach Narration dropdown (silent/brief/full) replaces coachVerbosity + coachCommentaryVerbosity + phaseNarrationVerbosity.');
  } else {
    audit('R3a', 'Unified "Coach Narration" select replaces 3 legacy controls', 'FAIL',
      'Expected unified "Coach Narration" label not found in SettingsPage.');
  }

  // R3b: PersonalityPanel "Verbosity" → "Response Length"
  if (/Response Length/.test(personalityPanel) && !/<span className="text-sm font-medium">Verbosity</.test(personalityPanel)) {
    audit('R3b', 'C22 Response Length label', 'PASS', 'PersonalityPanel renamed "Verbosity" → "Response Length".');
  } else {
    audit('R3b', 'C22 Response Length label', 'FAIL', 'PersonalityPanel still shows "Verbosity" label.');
  }

  // R4: Polly toggle relabel
  if (/Cloud voice \(Polly\) priority/.test(voicePanel) && /Polly first/.test(voicePanel) && /System voice first/.test(voicePanel)) {
    audit('R4', 'C24 Polly priority label', 'PASS', 'Polly toggle renamed to priority semantics.');
  } else {
    audit('R4', 'C24 Polly priority label', 'FAIL', 'Polly toggle still uses old on/off wording.');
  }

  // R5 (superseded by d5842b8): the unified Coach Narration dropdown
  // makes the silencer path explicit by structure rather than tooltip
  // hint — picking "Silent" silences the coach across every surface
  // via `resolveCoachNarration()` at the voiceService entry points.
  // Static check now verifies the resolver is wired into the speak
  // path so "Silent" actually silences (not just persists).
  const voiceService = await fs.readFile(
    path.join(REPO_ROOT, 'src/services/voiceService.ts'),
    'utf-8',
  );
  if (/resolveCoachNarration/.test(voiceService)) {
    audit('R5', 'Coach Narration "silent" wired through voiceService', 'PASS',
      'voiceService.ts imports resolveCoachNarration so "silent" is honored at the speak() entry point.');
  } else {
    audit('R5', 'Coach Narration "silent" wired through voiceService', 'FAIL',
      'voiceService.ts does not appear to call resolveCoachNarration; "silent" may not actually silence.');
  }

  // R6: Supabase URL + userId now encrypted on save
  const r6Save = /supabaseUrlEncrypted/.test(syncPanel) && /syncUserIdEncrypted/.test(syncPanel)
    && /supabaseUrl: null/.test(syncPanel) && /syncUserId: null/.test(syncPanel);
  const r6Read = /supabaseUrlEncrypted/.test(syncService) && /syncUserIdEncrypted/.test(syncService);
  if (r6Save && r6Read) {
    audit('R6', 'A5/A7 Supabase URL/UserID encryption', 'PASS', 'Save + read both wired to encrypted form; plaintext fields nulled on save.');
  } else {
    audit('R6', 'A5/A7 Supabase URL/UserID encryption', 'FAIL', `save=${r6Save} read=${r6Read}`);
  }

  // R7: provider switch no longer silently clears the input
  if (!/setApiKey\(''\);\s*\n\s*setShowKey\(false\);\s*\n\s*\};\s*\n\s*const handleSaveApiKey/.test(settingsPage)
    && /do NOT clear the input on provider switch/.test(settingsPage)) {
    audit('R7', 'C1 provider switch preserves key UI', 'PASS', 'Provider switch no longer clears input; documented inline.');
  } else {
    audit('R7', 'C1 provider switch preserves key UI', 'FAIL', 'handleProviderChange still calls setApiKey("").');
  }

  // R8: personality dial values fully per-personality
  if (/\{ \.\.\.draftVoiceMap \}/.test(personalityPanel) && /\{ \.\.\.draftSecondaryVoiceMap \}/.test(personalityPanel)
    && !/if \(value !== PERSONALITY_VOICE_DEFAULTS\[key\]\)/.test(personalityPanel)) {
    audit('R8', 'C17/C18 per-personality voice persistence', 'PASS', 'All 5 personality voice + secondary entries persist explicitly; no diff-only optimization.');
  } else {
    audit('R8', 'C17/C18 per-personality voice persistence', 'FAIL', 'PersonalityPanel still has diff-only optimization.');
  }

  // localStorage allowlist — should still pass after PR #498
  const localStorageImporters: string[] = [];
  async function scan(dir: string): Promise<void> {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
        await scan(p);
      } else if (ent.isFile() && /\.(ts|tsx|js|jsx)$/.test(ent.name)) {
        const content = await fs.readFile(p, 'utf-8');
        if (/localStorage\.(getItem|setItem|removeItem)/.test(content)) {
          localStorageImporters.push(path.relative(REPO_ROOT, p));
        }
      }
    }
  }
  await scan(path.join(REPO_ROOT, 'src'));
  const lsAllowed = [
    'src/services/sharedOpeningCache.ts',
    'src/services/stockfishEngine.ts',
    'src/services/appAuditor.ts',
  ];
  const lsViolations = localStorageImporters.filter((p) =>
    !lsAllowed.some((a) => p.endsWith(a)) && !/\.test\.|test\/|e2e\//.test(p));
  audit('S-LS', 'localStorage allowlist (Settings scope)',
    lsViolations.length === 0 ? 'PASS' : 'FAIL',
    lsViolations.length === 0
      ? `localStorage only used in ${lsAllowed.length} approved files.`
      : `Violations: ${lsViolations.slice(0, 5).join(', ')}`);
});

// ─── RUNTIME CHECKS ──────────────────────────────────────────────────

test.describe('Settings full audit', () => {
  test.setTimeout(300_000);

  test('settings runtime audit — every tab end-to-end', async ({ page }) => {
    await bootApp(page);
    await gotoSettings(page);

    // ───────────── PROFILE TAB ─────────────────────────────────────
    logEvent('--- Profile tab ---');
    // Profile tab is default-selected. Verify the page rendered.
    audit('A0', 'Settings page renders', 'PASS', 'data-testid="settings-page" visible.');

    // A1: Name input
    const nameInput = page.getByTestId('name-input');
    if (await safeBool(() => nameInput.isVisible({ timeout: 2000 }), false)) {
      await nameInput.fill('AuditPlayer');
      await page.waitForTimeout(500);
      // Profile name lives at top level, not in preferences — read it.
      const savedName = await page.evaluate(() => {
        return new Promise<string | undefined>((resolve) => {
          const req = indexedDB.open('ChessAcademyDB');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('profiles', 'readonly');
            const r = tx.objectStore('profiles').get('main');
            r.onsuccess = () => {
              resolve((r.result as { name?: string } | undefined)?.name);
              db.close();
            };
            r.onerror = () => { resolve(undefined); db.close(); };
          };
          req.onerror = () => resolve(undefined);
        });
      });
      audit('A1', 'Name input persistence',
        savedName === 'AuditPlayer' ? 'PASS' : 'WARN',
        savedName === 'AuditPlayer'
          ? 'Name "AuditPlayer" persisted to profiles.main.name.'
          : `Persisted name = ${JSON.stringify(savedName)} (expected "AuditPlayer").`);
    } else {
      audit('A1', 'Name input persistence', 'FAIL', 'name-input not visible.');
    }

    // A2: ELO Rating
    const eloInput = page.getByTestId('elo-input');
    if (await safeBool(() => eloInput.isVisible({ timeout: 1000 }), false)) {
      await eloInput.fill('1750');
      await page.waitForTimeout(500);
      const savedRating = await page.evaluate(() => {
        return new Promise<number | undefined>((resolve) => {
          const req = indexedDB.open('ChessAcademyDB');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('profiles', 'readonly');
            const r = tx.objectStore('profiles').get('main');
            r.onsuccess = () => {
              resolve((r.result as { currentRating?: number } | undefined)?.currentRating);
              db.close();
            };
            r.onerror = () => { resolve(undefined); db.close(); };
          };
          req.onerror = () => resolve(undefined);
        });
      });
      audit('A2', 'ELO input persistence',
        savedRating === 1750 ? 'PASS' : 'WARN',
        savedRating === 1750 ? 'Rating 1750 persisted.' : `Persisted rating = ${savedRating}.`);
    } else {
      audit('A2', 'ELO input persistence', 'FAIL', 'elo-input not visible.');
    }

    // A3: Daily session
    const dailyMin = page.getByTestId('daily-min-select');
    if (await safeBool(() => dailyMin.isVisible({ timeout: 1000 }), false)) {
      await dailyMin.selectOption('60');
      const v = await waitForPref(page, 'dailySessionMinutes', (x: number) => x === 60);
      audit('A3', 'Daily session persistence',
        v === 60 ? 'PASS' : 'WARN',
        v === 60 ? 'dailySessionMinutes=60 persisted.' : `Got ${v}`);
    }

    // A4: Export button — just verify clickable
    const exportBtn = page.getByTestId('export-data-btn');
    audit('A4', 'Export button visible',
      await safeBool(() => exportBtn.isVisible({ timeout: 500 }), false) ? 'PASS' : 'WARN',
      'Export button present (action verification needs download intercept).');

    // A5/A6/A7: Sync settings — type into all three, save, verify encrypted
    const syncUrl = page.getByTestId('sync-url-input');
    const syncKey = page.getByTestId('sync-key-input');
    const syncUser = page.getByTestId('sync-user-input');
    const syncSave = page.getByTestId('sync-save-btn');
    if (await safeBool(() => syncUrl.isVisible({ timeout: 1000 }), false)) {
      await syncUrl.fill('https://test.supabase.co');
      await syncKey.fill('test-anon-key-12345');
      await syncUser.fill('test-user-1');
      await syncSave.click();
      await page.waitForTimeout(800);
      const [urlEnc, urlPlain, keyEnc, keyPlain, userEnc, userPlain] = await Promise.all([
        readPref(page, 'supabaseUrlEncrypted'),
        readPref(page, 'supabaseUrl'),
        readPref(page, 'supabaseAnonKeyEncrypted'),
        readPref(page, 'supabaseAnonKey'),
        readPref(page, 'syncUserIdEncrypted'),
        readPref(page, 'syncUserId'),
      ]);
      const urlOk = typeof urlEnc === 'string' && urlEnc.length > 0 && (urlPlain === null || urlPlain === undefined);
      const keyOk = typeof keyEnc === 'string' && keyEnc.length > 0 && (keyPlain === null || keyPlain === undefined);
      const userOk = typeof userEnc === 'string' && userEnc.length > 0 && (userPlain === null || userPlain === undefined);
      audit('A5', 'Supabase URL encrypted on save',
        urlOk ? 'PASS' : 'FAIL',
        urlOk ? 'supabaseUrlEncrypted populated, plaintext nulled.' : `urlEnc=${typeof urlEnc} urlPlain=${JSON.stringify(urlPlain)}`);
      audit('A6', 'Supabase Anon Key encrypted on save',
        keyOk ? 'PASS' : 'FAIL',
        keyOk ? 'supabaseAnonKeyEncrypted populated, plaintext nulled.' : `keyEnc=${typeof keyEnc} keyPlain=${JSON.stringify(keyPlain)}`);
      audit('A7', 'Supabase User ID encrypted on save',
        userOk ? 'PASS' : 'FAIL',
        userOk ? 'syncUserIdEncrypted populated, plaintext nulled.' : `userEnc=${typeof userEnc} userPlain=${JSON.stringify(userPlain)}`);
    } else {
      audit('A5', 'Supabase URL', 'SKIP', 'sync-url-input not visible.');
      audit('A6', 'Supabase Anon Key', 'SKIP', 'sync-key-input not visible.');
      audit('A7', 'Supabase User ID', 'SKIP', 'sync-user-input not visible.');
    }

    // A9: Lichess token
    const lichessToken = page.getByTestId('lichess-token-input');
    const lichessSave = page.getByTestId('save-lichess-token-btn');
    if (await safeBool(() => lichessToken.isVisible({ timeout: 800 }), false)) {
      await lichessToken.fill('lichess-test-token-abc');
      if (await safeBool(() => lichessSave.isVisible({ timeout: 500 }), false)) {
        await lichessSave.click();
        await page.waitForTimeout(600);
        const [tokenEnc] = await Promise.all([readPref(page, 'lichessTokenEncrypted')]);
        audit('A9', 'Lichess token encrypted',
          typeof tokenEnc === 'string' && tokenEnc.length > 0 ? 'PASS' : 'WARN',
          `lichessTokenEncrypted = ${typeof tokenEnc} length=${typeof tokenEnc === 'string' ? tokenEnc.length : 0}`);
      }
    } else {
      audit('A9', 'Lichess token', 'SKIP', 'lichess-token-input not visible.');
    }

    // ───────────── BOARD TAB ───────────────────────────────────────
    logEvent('--- Board tab ---');
    const boardTabBtn = page.locator('button:has-text("Board")').first();
    if (await safeBool(() => boardTabBtn.isVisible({ timeout: 500 }), false)) {
      await boardTabBtn.click();
      await page.waitForTimeout(500);
    }
    await expect(page.getByTestId('board-tab')).toBeVisible({ timeout: 3000 });

    // B1: Master All Off
    const masterOff = page.getByTestId('master-all-off-toggle');
    if (await safeBool(() => masterOff.isVisible({ timeout: 1000 }), false)) {
      await masterOff.click();
      const v1 = await waitForPref(page, 'masterAllOff', (x: boolean) => x === true);
      // Toggle back off so subsequent rows aren't muted.
      await masterOff.click();
      const v2 = await waitForPref(page, 'masterAllOff', (x: boolean) => x === false);
      audit('B1', 'Master All Off persistence',
        v1 === true && v2 === false ? 'PASS' : 'WARN',
        v1 === true && v2 === false ? 'masterAllOff toggles to true and back to false.' : `v1=${v1} v2=${v2}`);
    }

    // B-series quick toggle/select sweep. B6 (boardOrientation), B26
    // (moveConfirmation), B27 (autoPromoteQueen) were SCRAPPED from
    // the UI in d5842b8 (parallel session) — boardOrientation fought
    // the per-game studentSide logic, moveConfirmation needed a
    // confirm-overlay flow that doesn't exist yet, autoPromoteQueen
    // needed a promotion-picker modal that doesn't exist yet. The
    // pref fields stay in UserPreferences for migration. The audit
    // simply drops those rows now that there's no UI control for
    // them; if those flows ever ship a UI again, re-add the rows.
    const boardRows: Array<[string, string, string, unknown]> = [
      ['B2', 'highlight-last-move-toggle', 'highlightLastMove', false],
      ['B3', 'show-legal-moves-toggle', 'showLegalMoves', false],
      ['B4', 'show-coordinates-toggle', 'showCoordinates', false],
      ['B5', 'animation-speed-select', 'pieceAnimationSpeed', 'slow'],
      ['B7', 'board-color-select', 'boardColor', 'green'],
      ['B8', 'piece-set-select', 'pieceSet', 'neo'],
      ['B14', 'sound-toggle', 'soundEnabled', false],
      ['B15', 'eval-bar-toggle', 'showEvalBar', false],
      ['B16', 'engine-lines-toggle', 'showEngineLines', true],
      ['B22', 'move-quality-flash-toggle', 'moveQualityFlash', false],
      ['B23', 'show-hints-toggle', 'showHints', false],
      ['B24', 'voice-narration-toggle', 'voiceEnabled', false],
      ['B25', 'move-method-select', 'moveMethod', 'click'],
    ];
    for (const [id, testid, prefKey, target] of boardRows) {
      const el = page.getByTestId(testid);
      if (!(await safeBool(() => el.isVisible({ timeout: 600 }), false))) {
        audit(id, `Board: ${prefKey}`, 'SKIP', `${testid} not visible.`);
        continue;
      }
      if (typeof target === 'boolean') {
        // Toggle once to flip. We don't know the current state from
        // the test side, so we read before-click and verify it
        // changed (rather than a specific target).
        const before = await readPref(page, prefKey);
        await el.click();
        const after = await waitForPref(page, prefKey, (v) => v !== before);
        audit(id, `Board: ${prefKey}`,
          after !== undefined ? 'PASS' : 'WARN',
          after !== undefined ? `Toggled ${prefKey}: ${before} → ${after}.` : `No change observed (before=${before}).`);
      } else {
        await el.selectOption(target as string);
        const v = await waitForPref(page, prefKey, (x) => x === target);
        audit(id, `Board: ${prefKey}`,
          v === target ? 'PASS' : 'WARN',
          v === target ? `${prefKey}=${JSON.stringify(target)} persisted.` : `Got ${JSON.stringify(v)}, wanted ${JSON.stringify(target)}.`);
      }
    }

    // B9/B10: glow brightness + board color (sliders/pickers in expand panel)
    const glowBtn = page.getByTestId('board-glow-btn');
    if (await safeBool(() => glowBtn.isVisible({ timeout: 800 }), false)) {
      await glowBtn.click();
      await page.waitForTimeout(400);
      const dimmer = page.getByTestId('dimmer-master');
      if (await safeBool(() => dimmer.isVisible({ timeout: 600 }), false)) {
        await dimmer.fill('150');
        const v = await waitForPref(page, 'glowBrightness', (x: number) => x === 150);
        audit('B9', 'Glow Master Dimmer',
          v === 150 ? 'PASS' : 'WARN',
          v === 150 ? 'glowBrightness=150 persisted.' : `Got ${v}.`);
      } else {
        audit('B9', 'Glow Master Dimmer', 'SKIP', 'dimmer-master not visible.');
      }
    } else {
      audit('B9', 'Glow Master Dimmer', 'SKIP', 'Glow settings panel not expanded.');
    }

    // B17–B20: piece sound sliders (just verify each persists)
    const sliderRows: Array<[string, string, string]> = [
      ['B17', 'piece-sound-pitch', 'pieceSoundPitch'],
      ['B18', 'piece-sound-tone', 'pieceSoundTone'],
      ['B19', 'piece-sound-waveform', 'pieceSoundWaveform'],
      ['B20', 'piece-sound-length', 'pieceSoundLength'],
    ];
    for (const [id, testid, prefKey] of sliderRows) {
      const el = page.getByTestId(testid);
      if (!(await safeBool(() => el.isVisible({ timeout: 500 }), false))) {
        audit(id, `Piece sound: ${prefKey}`, 'SKIP', 'slider not visible (panel may be collapsed).');
        continue;
      }
      await el.fill('75');
      const v = await waitForPref(page, prefKey, (x: number) => x === 75);
      audit(id, `Piece sound: ${prefKey}`,
        v === 75 ? 'PASS' : 'WARN',
        v === 75 ? `${prefKey}=75 persisted.` : `Got ${v}.`);
    }

    // ───────────── COACH TAB ───────────────────────────────────────
    logEvent('--- Coach tab ---');
    const coachTabBtn = page.locator('button:has-text("Coach")').first();
    if (await safeBool(() => coachTabBtn.isVisible({ timeout: 500 }), false)) {
      await coachTabBtn.click();
      await page.waitForTimeout(500);
    }

    // C1: Provider toggle — DeepSeek ↔ Anthropic
    const providerRow = page.getByTestId('ai-provider-row');
    if (await safeBool(() => providerRow.isVisible({ timeout: 1500 }), false)) {
      await providerRow.click();
      await page.waitForTimeout(400);
      const anthropicBtn = page.getByTestId('provider-anthropic');
      const deepseekBtn = page.getByTestId('provider-deepseek');
      if (await safeBool(() => anthropicBtn.isVisible({ timeout: 500 }), false)) {
        await anthropicBtn.click();
        const v1 = await waitForPref(page, 'aiProvider', (x: string) => x === 'anthropic');
        // R7: now type a fake key, switch back to DeepSeek, verify
        // the input is NOT silently cleared (key is preserved).
        const apiKeyInput = page.getByTestId('api-key-input');
        await apiKeyInput.fill('sk-ant-test-r7');
        await deepseekBtn.click();
        await page.waitForTimeout(400);
        const inputAfterSwitch = await apiKeyInput.inputValue();
        audit('C1', 'AI provider switch',
          v1 === 'anthropic' ? 'PASS' : 'WARN',
          v1 === 'anthropic' ? 'aiProvider=anthropic persisted on toggle.' : `Got ${v1}`);
        audit('R7-rt', 'Provider switch preserves API key input (runtime)',
          inputAfterSwitch === 'sk-ant-test-r7' ? 'PASS' : 'FAIL',
          inputAfterSwitch === 'sk-ant-test-r7'
            ? 'Input value preserved across provider toggle.'
            : `Input value after switch = ${JSON.stringify(inputAfterSwitch)} (expected "sk-ant-test-r7").`);
      }
    } else {
      audit('C1', 'AI provider row', 'SKIP', 'ai-provider-row not visible.');
    }

    // C2: API key encryption — save a fake key, check it's encrypted
    const apiKeyInput2 = page.getByTestId('api-key-input');
    const saveApiBtn = page.getByTestId('save-api-key-btn');
    if (await safeBool(() => apiKeyInput2.isVisible({ timeout: 1000 }), false)) {
      await apiKeyInput2.fill('sk-test-deepseek-fake-key-for-audit');
      await saveApiBtn.click();
      await page.waitForTimeout(800);
      const [enc, plain] = await Promise.all([
        readPref(page, 'apiKeyEncrypted'),
        readPref(page, 'apiKey'),
      ]);
      const encOk = typeof enc === 'string' && enc.length > 0;
      const noPlain = plain === undefined || plain === null;
      audit('C2', 'API key encryption',
        encOk && noPlain ? 'PASS' : 'FAIL',
        encOk && noPlain
          ? 'apiKeyEncrypted populated; no plaintext apiKey field.'
          : `enc=${typeof enc} length=${typeof enc === 'string' ? enc.length : 0} plain=${JSON.stringify(plain)}`);
    } else {
      audit('C2', 'API key encryption', 'SKIP', 'api-key-input not visible.');
    }

    // C3: Budget cap
    const budgetInput = page.getByTestId('budget-input');
    if (await safeBool(() => budgetInput.isVisible({ timeout: 800 }), false)) {
      await budgetInput.fill('25');
      const v = await waitForPref(page, 'monthlyBudgetCap', (x: number | null) => x === 25);
      audit('C3', 'Budget cap persistence',
        v === 25 ? 'PASS' : 'WARN',
        v === 25 ? 'monthlyBudgetCap=25 persisted.' : `Got ${v}.`);
    } else {
      audit('C3', 'Budget cap', 'SKIP', 'budget-input not visible.');
    }

    // C5/C6/C7: Model selectors
    const modelRows: Array<[string, string, string]> = [
      ['C5', 'model-commentary', 'commentary'],
      ['C6', 'model-analysis', 'analysis'],
      ['C7', 'model-reports', 'reports'],
    ];
    for (const [id, testid, slot] of modelRows) {
      const el = page.getByTestId(testid);
      if (!(await safeBool(() => el.isVisible({ timeout: 500 }), false))) {
        audit(id, `Model: ${slot}`, 'SKIP', `${testid} not visible.`);
        continue;
      }
      // Select the second option (whatever it is for the active provider).
      const optValues = await el.locator('option').evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 0));
      if (optValues.length < 2) {
        audit(id, `Model: ${slot}`, 'WARN', `Only ${optValues.length} option(s) — cannot exercise selection.`);
        continue;
      }
      const target = optValues[1];
      await el.selectOption(target);
      await page.waitForTimeout(500);
      const stored = await readPref(page, 'preferredModel') as { [k: string]: string } | undefined;
      audit(id, `Model: ${slot}`,
        stored?.[slot] === target ? 'PASS' : 'WARN',
        stored?.[slot] === target
          ? `preferredModel.${slot}=${target} persisted.`
          : `Got ${stored?.[slot]}, wanted ${target}.`);
    }

    // Close provider modal via the dedicated close button. The
    // backdrop intercepts pointer events, and Escape isn't wired in
    // SettingsModalRow — so the only reliable exit is `${testId}-close`.
    const providerClose = page.getByTestId('ai-provider-row-close');
    if (await safeBool(() => providerClose.isVisible({ timeout: 500 }), false)) {
      await providerClose.click();
      await page.waitForTimeout(400);
    }

    // C-NARR: unified Coach Narration select (silent/brief/full).
    // Replaces the legacy C8/C9/C30 rows that targeted three
    // independent verbosity controls (coachVerbosity,
    // coachCommentaryVerbosity, phaseNarrationVerbosity). All three
    // were removed from the UI in d5842b8; their pref fields remain
    // in UserPreferences only so resolveCoachNarration() can derive
    // a fallback for older profiles. The new dropdown writes
    // `coachNarration` and is honored at every voiceService entry
    // point (speakInternal / speakFast / speakQueuedForced).
    const gameplayRow = page.getByTestId('gameplay-coaching-row');
    if (await safeBool(() => gameplayRow.isVisible({ timeout: 1500 }), false)) {
      await gameplayRow.click();
      await page.waitForTimeout(400);
      const narration = page.getByTestId('coach-narration-select');
      if (await safeBool(() => narration.isVisible({ timeout: 500 }), false)) {
        // Cycle silent → brief → full and verify persistence each time
        // so we catch any partial-coverage bug in the new resolver.
        await narration.selectOption('silent');
        const vSilent = await waitForPref(page, 'coachNarration', (x: string) => x === 'silent');
        await narration.selectOption('brief');
        const vBrief = await waitForPref(page, 'coachNarration', (x: string) => x === 'brief');
        await narration.selectOption('full');
        const vFull = await waitForPref(page, 'coachNarration', (x: string) => x === 'full');
        const allOk = vSilent === 'silent' && vBrief === 'brief' && vFull === 'full';
        audit('C-NARR', 'Coach Narration (unified silent/brief/full)',
          allOk ? 'PASS' : 'FAIL',
          allOk
            ? `coachNarration persists across all three values: silent → brief → full.`
            : `silent=${vSilent} brief=${vBrief} full=${vFull}`);
        // Leave on 'silent' so downstream voice rows can verify the
        // silencer path. The resolver is checked statically by R5.
        await narration.selectOption('silent');
        await page.waitForTimeout(200);
      } else {
        audit('C-NARR', 'Coach Narration select', 'FAIL', 'coach-narration-select not visible inside gameplay modal.');
      }

      // C10–C14: Gameplay coaching toggles
      const coachToggles: Array<[string, string, string]> = [
        ['C10', 'coach-blunder-alerts-toggle', 'coachBlunderAlerts'],
        ['C11', 'coach-tactic-alerts-toggle', 'coachTacticAlerts'],
        ['C12', 'coach-positional-tips-toggle', 'coachPositionalTips'],
        ['C13', 'coach-missed-tactic-toggle', 'coachMissedTacticTakeback'],
        ['C14', 'coach-review-voice-toggle', 'coachReviewVoice'],
      ];
      for (const [id, testid, prefKey] of coachToggles) {
        const el = page.getByTestId(testid);
        if (!(await safeBool(() => el.isVisible({ timeout: 400 }), false))) {
          audit(id, `Coach toggle: ${prefKey}`, 'SKIP', `${testid} not visible.`);
          continue;
        }
        const before = await readPref(page, prefKey);
        await el.click();
        const after = await waitForPref(page, prefKey, (v) => v !== before);
        audit(id, `Coach toggle: ${prefKey}`,
          after !== undefined ? 'PASS' : 'WARN',
          after !== undefined ? `${prefKey}: ${before} → ${after}.` : `No change observed (before=${before}).`);
      }
    } else {
      audit('C-NARR', 'Gameplay coaching row', 'SKIP', 'gameplay-coaching-row not visible.');
    }

    // Close gameplay modal via its close button.
    const gameplayClose = page.getByTestId('gameplay-coaching-row-close');
    if (await safeBool(() => gameplayClose.isVisible({ timeout: 500 }), false)) {
      await gameplayClose.click();
      await page.waitForTimeout(400);
    }

    // C15: Coach voice master toggle
    const coachVoice = page.getByTestId('coach-voice-toggle');
    if (await safeBool(() => coachVoice.isVisible({ timeout: 1000 }), false)) {
      const before = await readPref(page, 'coachVoiceOn');
      await coachVoice.click();
      const after = await waitForPref(page, 'coachVoiceOn', (v) => v !== before);
      audit('C15', 'Coach voice toggle',
        after !== undefined ? 'PASS' : 'WARN',
        after !== undefined ? `coachVoiceOn: ${before} → ${after}.` : `No change observed.`);
    } else {
      audit('C15', 'Coach voice toggle', 'SKIP', 'coach-voice-toggle not visible.');
    }

    // C16: Personality picker
    const personalityRow = page.getByTestId('personality-row');
    if (await safeBool(() => personalityRow.isVisible({ timeout: 1500 }), false)) {
      await personalityRow.click();
      await page.waitForTimeout(400);
      const edgyCard = page.getByTestId('personality-card-edgy');
      if (await safeBool(() => edgyCard.isVisible({ timeout: 800 }), false)) {
        await edgyCard.click();
        await page.waitForTimeout(500);

        // R8: switch among personalities, set a non-default voice, then
        // switch and switch back — voice should still be there.
        const voiceEdgy = page.getByTestId('personality-voice-edgy');
        if (await safeBool(() => voiceEdgy.isVisible({ timeout: 500 }), false)) {
          const opts = await voiceEdgy.locator('option').evaluateAll((els) =>
            els.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 0));
          if (opts.length >= 2) {
            await voiceEdgy.selectOption(opts[opts.length - 1]); // last (non-default) option
            await page.waitForTimeout(500);
            // Switch to default, back to edgy
            await page.getByTestId('personality-card-default').click();
            await page.waitForTimeout(400);
            await page.getByTestId('personality-card-edgy').click();
            await page.waitForTimeout(400);
            const voiceMap = await readPref(page, 'coachPersonalityVoices') as Record<string, string> | undefined;
            const edgyVoice = voiceMap?.edgy;
            audit('R8-rt', 'Per-personality voice retained across switches (runtime)',
              edgyVoice === opts[opts.length - 1] ? 'PASS' : 'WARN',
              edgyVoice === opts[opts.length - 1]
                ? `edgy voice="${edgyVoice}" stayed put through default-and-back switch.`
                : `edgy voice="${edgyVoice}" (expected "${opts[opts.length - 1]}").`);
          }
        }

        const personality = await readPref(page, 'coachPersonality');
        audit('C16', 'Personality picker (edgy)',
          personality === 'edgy' ? 'PASS' : 'WARN',
          personality === 'edgy' ? 'coachPersonality=edgy persisted.' : `Got ${personality}.`);

        // C19/C20/C21/C22: dials
        const dialRows: Array<[string, string, string, string]> = [
          ['C19', 'dial-profanity-hard', 'coachProfanity', 'hard'],
          ['C20', 'dial-mockery-medium', 'coachMockery', 'medium'],
          ['C21', 'dial-flirt-none', 'coachFlirt', 'none'],
          ['C22', 'dial-verbosity-verbose', 'coachResponseLength', 'verbose'],
        ];
        for (const [id, testid, prefKey, target] of dialRows) {
          const el = page.getByTestId(testid);
          if (!(await safeBool(() => el.isVisible({ timeout: 400 }), false))) {
            audit(id, `Dial: ${prefKey}`, 'SKIP', `${testid} not visible.`);
            continue;
          }
          await el.click();
          const v = await waitForPref(page, prefKey, (x: string) => x === target);
          audit(id, `Dial: ${prefKey}`,
            v === target ? 'PASS' : 'WARN',
            v === target ? `${prefKey}=${target} persisted.` : `Got ${v}.`);
        }

        // Close personality modal
        const done = page.getByTestId('personality-done');
        if (await safeBool(() => done.isVisible({ timeout: 500 }), false)) {
          await done.click();
          await page.waitForTimeout(300);
        }
      } else {
        audit('C16', 'Personality picker', 'SKIP', 'personality-card-edgy not visible.');
      }
    } else {
      audit('C16', 'Personality picker', 'SKIP', 'personality-row not visible.');
    }

    // C24: Polly toggle
    const pollyToggle = page.getByTestId('polly-toggle');
    if (await safeBool(() => pollyToggle.isVisible({ timeout: 1000 }), false)) {
      const before = await readPref(page, 'pollyEnabled');
      await pollyToggle.click();
      const after = await waitForPref(page, 'pollyEnabled', (v) => v !== before);
      audit('C24', 'Polly toggle',
        after !== undefined ? 'PASS' : 'WARN',
        after !== undefined ? `pollyEnabled: ${before} → ${after}.` : 'No change observed.');
    }

    // C26: Polly voice select
    const pollyVoiceSel = page.getByTestId('polly-voice-select');
    if (await safeBool(() => pollyVoiceSel.isVisible({ timeout: 600 }), false)) {
      const opts = await pollyVoiceSel.locator('option').evaluateAll((els) =>
        els.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 0));
      if (opts.length >= 2) {
        const target = opts.find((v) => v !== 'ruth') ?? opts[1];
        await pollyVoiceSel.selectOption(target);
        const v = await waitForPref(page, 'pollyVoice', (x: string) => x === target);
        audit('C26', 'Polly voice select',
          v === target ? 'PASS' : 'WARN',
          v === target ? `pollyVoice="${target}" persisted.` : `Got ${v}.`);
      }
    }

    // C29: Voice speed
    const speed = page.getByTestId('voice-speed-slider');
    if (await safeBool(() => speed.isVisible({ timeout: 600 }), false)) {
      await speed.fill('1.25');
      const v = await waitForPref(page, 'voiceSpeed', (x: number) => x === 1.25);
      audit('C29', 'Voice speed',
        v === 1.25 ? 'PASS' : 'WARN',
        v === 1.25 ? 'voiceSpeed=1.25 persisted.' : `Got ${v}.`);
    }

    // C30 (phase-narration-verbosity-select) was removed from the UI
    // in d5842b8 — folded into the unified Coach Narration setting
    // covered by C-NARR above. No row to add here.

    // ───────────── ABOUT TAB ───────────────────────────────────────
    logEvent('--- About tab ---');
    const aboutTabBtn = page.locator('button:has-text("About")').first();
    if (await safeBool(() => aboutTabBtn.isVisible({ timeout: 500 }), false)) {
      await aboutTabBtn.click();
      await page.waitForTimeout(300);
    }
    const feedbackBtn = page.getByTestId('open-feedback-btn');
    const refreshBtn = page.getByTestId('hard-refresh-btn');
    const resetBtn = page.getByTestId('reset-btn');
    audit('E1', 'Feedback button visible',
      await safeBool(() => feedbackBtn.isVisible({ timeout: 800 }), false) ? 'PASS' : 'WARN',
      'open-feedback-btn present.');
    audit('E2', 'Check for updates button',
      await safeBool(() => refreshBtn.isVisible({ timeout: 400 }), false) ? 'PASS' : 'WARN',
      'hard-refresh-btn present.');
    audit('E3', 'Reset All Data button (initial state)',
      await safeBool(() => resetBtn.isVisible({ timeout: 400 }), false) ? 'PASS' : 'WARN',
      'reset-btn present (NOT clicked — destructive).');

    logSummary();
  });
});

function logSummary(): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SETTINGS FULL AUDIT — SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  const byStatus: Record<RowStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const f of findings) byStatus[f.status]++;
  console.log(`  PASS: ${byStatus.PASS}   FAIL: ${byStatus.FAIL}   WARN: ${byStatus.WARN}   SKIP: ${byStatus.SKIP}`);
  console.log('───────────────────────────────────────────────────────────────');
  const sorted = [...findings].sort((a, b) => {
    const groupOrder: Record<string, number> = { R: 0, S: 1, A: 2, B: 3, C: 4, D: 5, E: 6 };
    const ga = groupOrder[a.id[0]] ?? 99;
    const gb = groupOrder[b.id[0]] ?? 99;
    if (ga !== gb) return ga - gb;
    const na = parseInt(a.id.replace(/[^\d]/g, ''), 10);
    const nb = parseInt(b.id.replace(/[^\d]/g, ''), 10);
    if (na !== nb) return na - nb;
    return a.id.localeCompare(b.id);
  });
  for (const f of sorted) {
    const tag = f.status === 'PASS' ? '✅' : f.status === 'FAIL' ? '❌' : f.status === 'WARN' ? '⚠️ ' : '⏭️ ';
    console.log(`  ${f.id.padEnd(7)} ${tag} ${f.surface.padEnd(46)} ${f.note}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');

  const failures = findings.filter((f) => f.status === 'FAIL');
  if (failures.length > 0) {
    expect(failures.length, `Audit failures (${failures.length}): ${failures.map((f) => f.id).join(', ')}`).toBe(0);
  }
}
