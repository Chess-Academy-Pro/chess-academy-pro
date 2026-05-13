#!/usr/bin/env node
/**
 * Static audit of every Settings field: for each preference key
 * written somewhere under src/components/Settings/, find every read
 * site under src/ and classify the field as:
 *
 *   - ACTIVE  → has read sites outside the Settings panel itself
 *               (some piece of runtime code consumes it)
 *   - ORPHAN  → only written, never read → setting saves but
 *               changes nothing
 *   - LEGACY  → has read sites but UI doesn't expose it (we removed
 *               the control during the unified-narration cleanup
 *               but kept the field for migration)
 *
 * Plus a redundancy scan: groups of preference fields whose labels
 * point at the same conceptual lever.
 *
 * Output: audit-reports/settings-audit.md
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'audit-reports/settings-audit.md');

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(path, files);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      files.push(path);
    }
  }
  return files;
}

const ALL_FILES = walk(SRC);
const SETTINGS_FILES = ALL_FILES.filter((p) => p.includes('/Settings/'));
const NON_SETTINGS = ALL_FILES.filter((p) => !p.includes('/Settings/'));

// ── Pass 1: find every preference field written by Settings code ──
const writePattern = /(?:preferences\s*,\s*)(\w+)\s*:/g;
const writes = new Set();
for (const path of SETTINGS_FILES) {
  const src = readFileSync(path, 'utf-8');
  let m;
  while ((m = writePattern.exec(src)) !== null) {
    writes.add(m[1]);
  }
  // Also pick up bracket-key writes: `[key]: value`
  const bracketPattern = /preferences\s*,\s*\[(\w+)\]\s*:/g;
  while ((m = bracketPattern.exec(src)) !== null) {
    writes.add(m[1]);
  }
}

// Hand-list keys passed via `handleToggle` generic handlers (from
// SettingsPage). The static regex above misses them because they're
// referenced by string literal, not as object keys.
const additionalKeys = [
  'coachBlunderAlerts',
  'coachTacticAlerts',
  'coachPositionalTips',
  'coachMissedTacticTakeback',
  'coachReviewVoice',
  'highlightLastMove',
  'showLegalMoves',
  'showCoordinates',
  'pieceAnimationSpeed',
  'boardOrientation',
  'boardColor',
  'pieceSet',
  'soundEnabled',
  'showEvalBar',
  'showEngineLines',
  'moveQualityFlash',
  'showHints',
  'voiceEnabled',
  'moveMethod',
  'moveConfirmation',
  'autoPromoteQueen',
  'masterAllOff',
  // Piece-sound dials persisted via PieceSoundPanel
  'pieceSoundPitch',
  'pieceSoundTone',
  'pieceSoundWaveform',
  'pieceSoundLength',
  // Glow dials persisted via BoardGlowSettings
  'glowBrightness',
  'boardGlowColor',
  'whitePieceGlowColor',
  'blackPieceGlowColor',
  // Legacy fields hidden behind unified Coach Narration
  'coachVerbosity',
  'coachCommentaryVerbosity',
  'phaseNarrationVerbosity',
  'coachResponseLength',
];
for (const k of additionalKeys) writes.add(k);

const writeKeys = [...writes].sort();

// ── Pass 2: count read sites for each field outside Settings/ ─────
// Reads can take many shapes:
//   profile.preferences.X
//   preferences.X (in destructured contexts)
//   prefs.X
//   prefs?.X
//   .X (property access on any object — risky for false positives on
//      generic names like `key`, so we filter those out separately)
//   { X } destructure
function countReads(key) {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Property access on any of preferences / prefs / profile / state /
  // activeProfile / settings (the useSettings() hook return value).
  const propAccess = new RegExp(
    `(preferences|prefs|profile|state|activeProfile|cachedPrefs|defaultPreferences|settings|userSettings|raw)\\??\\.${safeKey}\\b`,
  );
  // Bracket access like preferences['X'].
  const bracketAccess = new RegExp(`preferences\\[['"]${safeKey}['"]\\]`);
  // Destructure from preferences.
  const destructure = new RegExp(`\\{[^{}]*\\b${safeKey}\\b[^{}]*\\}\\s*=\\s*(\\w+\\.)?(preferences|prefs|profile\\.preferences|activeProfile)`);
  let runtimeReads = 0;
  const sites = [];
  for (const path of NON_SETTINGS) {
    const src = readFileSync(path, 'utf-8');
    let lineNum = 0;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      lineNum++;
      if (propAccess.test(line) || bracketAccess.test(line)) {
        runtimeReads++;
        if (sites.length < 3) {
          sites.push(`${path.replace(ROOT + '/', '')}:${lineNum}`);
        }
      }
    }
    // Destructure detector — pattern can span 2 lines.
    const twoLineSrc = src;
    let m;
    const destructureRx = new RegExp(`\\{[^{}]*\\b${safeKey}\\b[^{}]*\\}\\s*=\\s*(?:\\w+\\.)?(?:preferences|prefs|profile\\.preferences|activeProfile)`, 'g');
    while ((m = destructureRx.exec(twoLineSrc)) !== null) {
      runtimeReads++;
      const lineNo = twoLineSrc.slice(0, m.index).split('\n').length;
      if (sites.length < 3) {
        sites.push(`${path.replace(ROOT + '/', '')}:${lineNo}`);
      }
    }
  }
  return { runtimeReads, sites };
}

// ── Pass 3: pull labels from Settings TSX for each field ──────────
function findLabelsForKey(key) {
  // Heuristic: search Settings TSX for label="..." within ~25 lines of
  // a usage of the key. Crude but fine for an audit.
  const labels = new Set();
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRx = new RegExp(`\\b${safeKey}\\b`);
  for (const path of SETTINGS_FILES) {
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!keyRx.test(lines[i])) continue;
      // Walk up to 12 lines either way for a label= near this usage.
      const lo = Math.max(0, i - 12);
      const hi = Math.min(lines.length, i + 12);
      for (let j = lo; j < hi; j++) {
        const m = lines[j].match(/label="([^"]+)"/);
        if (m) labels.add(m[1]);
      }
    }
  }
  return [...labels];
}

const report = [];
report.push('# Settings audit\n');
report.push(`Generated: ${new Date().toISOString()}\n`);
report.push(`Audit of every preference field written by Settings code, with read-site counts.\n`);
report.push(`Output of \`node scripts/audit-settings.mjs\`.\n\n`);

const rows = [];
for (const key of writeKeys) {
  const { runtimeReads, sites } = countReads(key);
  const labels = findLabelsForKey(key);
  rows.push({ key, runtimeReads, sites, labels });
}

const orphans = rows.filter((r) => r.runtimeReads === 0);
const active = rows.filter((r) => r.runtimeReads > 0);

report.push(`## Summary\n\n`);
report.push(`- **Total settings fields**: ${rows.length}\n`);
report.push(`- **Active** (runtime reads > 0): ${active.length}\n`);
report.push(`- **Orphan** (runtime reads = 0 — saves but does nothing): ${orphans.length}\n\n`);

if (orphans.length > 0) {
  report.push(`## ⚠️  Orphaned settings (write only, no runtime read)\n\n`);
  report.push('These pref fields are written by Settings UI but no runtime code outside Settings/ reads them. Either remove the UI or wire them up.\n\n');
  for (const r of orphans) {
    report.push(`- **\`${r.key}\`** — labels: ${r.labels.map(l => `"${l}"`).join(', ') || '(none found)'}\n`);
  }
  report.push('\n');
}

report.push(`## All settings, by read frequency\n\n`);
report.push(`| Field | Runtime reads | Labels | Example read site |\n`);
report.push(`|---|---|---|---|\n`);
rows.sort((a, b) => b.runtimeReads - a.runtimeReads);
for (const r of rows) {
  const status = r.runtimeReads === 0 ? '🔴 0' : r.runtimeReads <= 2 ? `🟡 ${r.runtimeReads}` : `🟢 ${r.runtimeReads}`;
  const labelsCol = r.labels.length > 0 ? r.labels.slice(0, 2).map(l => `"${l}"`).join(', ') : '—';
  const site = r.sites[0] ?? '—';
  report.push(`| \`${r.key}\` | ${status} | ${labelsCol} | ${site} |\n`);
}

// ── Redundancy candidates: fields whose labels share a keyword ────
report.push(`\n## Potential redundancy clusters (labels share a keyword)\n\n`);
const keywordIndex = new Map(); // keyword → [key, ...]
const STOPWORDS = new Set(['the','and','a','an','of','to','on','off','for','with','show','hide','enable','disable','set']);
for (const r of rows) {
  for (const label of r.labels) {
    for (const wordRaw of label.toLowerCase().split(/\W+/)) {
      const word = wordRaw.trim();
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      if (!keywordIndex.has(word)) keywordIndex.set(word, new Set());
      keywordIndex.get(word).add(r.key);
    }
  }
}
const redundancyClusters = [...keywordIndex.entries()]
  .filter(([_, keys]) => keys.size >= 2)
  .sort((a, b) => b[1].size - a[1].size);
if (redundancyClusters.length === 0) {
  report.push('_None found._\n');
} else {
  for (const [word, keys] of redundancyClusters.slice(0, 12)) {
    report.push(`- **"${word}"** appears in ${keys.size} fields: ${[...keys].map(k => `\`${k}\``).join(', ')}\n`);
  }
}

mkdirSync(join(ROOT, 'audit-reports'), { recursive: true });
writeFileSync(OUT, report.join(''));
console.log(`[settings-audit] wrote ${OUT}`);
console.log(`[settings-audit] ${rows.length} fields total — ${active.length} active, ${orphans.length} orphan`);
if (orphans.length > 0) {
  console.log('\nOrphans:');
  for (const r of orphans) {
    console.log(`  - ${r.key}`);
  }
}
