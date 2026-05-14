#!/usr/bin/env node
/**
 * scripts/audit-curated-narrations.mjs
 *
 * Audits `src/data/opening-narrations.ts` against the canonical
 * Lichess DB (`src/data/openings-lichess.json`).
 *
 * For each curated entry we:
 *   1. Parse the entry's FEN — must load cleanly through chess.js.
 *   2. Find every Lichess DB entry whose `name` matches
 *      `openingName` (optionally with `variation` appended).
 *   3. Replay each candidate PGN; confirm the FEN matches the
 *      position immediately after `moveSan` in that PGN.
 *
 * Failure classes:
 *   - bad-fen                : FEN doesn't load.
 *   - move-not-in-canonical  : `moveSan` doesn't appear in any
 *                              candidate PGN for the named opening.
 *   - fen-mismatch           : `moveSan` is in the canonical PGN
 *                              but the FEN that follows it doesn't
 *                              match the curated FEN.
 *   - unknown-name           : Opening name doesn't resolve in the
 *                              Lichess DB.
 *
 * Voice-rule grep (interface references, acknowledgments) runs in
 * parallel — flagged but doesn't fail.
 *
 * Outputs JSON when `--json` is passed; otherwise pretty-prints.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const NARRATIONS_PATH = join(REPO, 'src/data/opening-narrations.ts');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');

const flagJson = process.argv.includes('--json');

// ─── Parse opening-narrations.ts ────────────────────────────────────
// The file is hand-curated TS with no exports beyond
// CURATED_NARRATIONS. Eval the array by stripping the type
// import + the `export const CURATED_NARRATIONS: …` prefix and
// passing the body through Function().

function parseCuratedNarrations() {
  const raw = readFileSync(NARRATIONS_PATH, 'utf8');
  // Strip the import + everything before `[`. The exported value
  // is a single array literal; the closing `;` is on its own line.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) {
    throw new Error('could not find array literal in opening-narrations.ts');
  }
  const literal = raw.slice(start, end + 1);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict";return (${literal});`)();
}

const curated = parseCuratedNarrations();
const opens = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));

// Group DB entries by `name` (the exact `openingName` field from
// the curated entries should appear here verbatim).
const byName = new Map();
for (const r of opens) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}

function fenAfterMove(pgn, targetSan) {
  // Replay pgn until we play targetSan, then return the fen just
  // after that move. If the move doesn't appear in pgn, return null.
  const chess = new Chess();
  const tokens = pgn.trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    try {
      const m = chess.move(t);
      if (!m) return null;
      // chess.js returns SAN without the `+`/`#` decoration in
      // `.san` only after computing legal moves — `.san` includes
      // it. Compare case-insensitively after stripping check/mate.
      const playedSan = m.san.replace(/[+#]/g, '');
      const wanted = targetSan.replace(/[+#]/g, '');
      if (playedSan === wanted) return chess.fen();
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeFen(fen) {
  // Drop the halfmove + fullmove counters when comparing — narration
  // FENs are sometimes written with rough counters that don't match
  // the literal replay exactly. The first four fields (placement,
  // side, castling, ep) are the structural identity.
  return fen.split(' ').slice(0, 4).join(' ');
}

// ─── Voice-rule grep ───────────────────────────────────────────────
const INTERFACE_PHRASES = [
  /\btap\b/i,
  /\bclick\b/i,
  /\bpress\b/i,
  /\bnext button\b/i,
  /\bbutton\b/i,
  /\bchat\b/i,
];
const ACKNOWLEDGMENT_PHRASES = [
  /^\s*great\b/i,
  /^\s*excellent\b/i,
  /^\s*correct\b/i,
  /^\s*well done\b/i,
];

const errors = [];
const voiceFlags = [];

for (const entry of curated) {
  const tag = entry.id;

  // 1) FEN sanity.
  try {
    const c = new Chess();
    c.load(entry.fen);
  } catch (e) {
    errors.push({
      cls: 'bad-fen',
      id: tag,
      detail: `FEN failed to load: ${e?.message ?? 'unknown'}`,
      fen: entry.fen,
    });
    continue;
  }

  // 2) Resolve canonical PGN candidates by name (+ optional variation
  //    appended with ', ').
  const lookups = [];
  if (entry.openingName) lookups.push(entry.openingName);
  if (entry.openingName && entry.variation) {
    lookups.push(`${entry.openingName}: ${entry.variation}`);
    lookups.push(`${entry.openingName}, ${entry.variation}`);
  }

  const candidates = [];
  for (const lookup of lookups) {
    // Exact match.
    if (byName.has(lookup)) {
      candidates.push(...byName.get(lookup));
    }
    // Prefix match (covers sub-variations whose canonical name
    // starts with the lookup string).
    for (const [name, rows] of byName.entries()) {
      if (name === lookup) continue;
      if (
        name.startsWith(`${lookup}: `) ||
        name.startsWith(`${lookup}, `) ||
        name === lookup
      ) {
        candidates.push(...rows);
      }
    }
  }

  if (candidates.length === 0) {
    errors.push({
      cls: 'unknown-name',
      id: tag,
      detail: `no DB entry matches openingName="${entry.openingName}" variation="${entry.variation ?? ''}"`,
    });
    continue;
  }

  // 3) Find a candidate whose PGN replays through moveSan and
  //    produces the curated FEN.
  let matched = false;
  let moveSeen = false;
  let bestMismatch = null;
  for (const cand of candidates) {
    const f = fenAfterMove(cand.pgn, entry.moveSan);
    if (f === null) continue;
    moveSeen = true;
    if (normalizeFen(f) === normalizeFen(entry.fen)) {
      matched = true;
      break;
    }
    if (!bestMismatch) bestMismatch = { name: cand.name, replayedFen: f };
  }

  if (!matched) {
    if (!moveSeen) {
      errors.push({
        cls: 'move-not-in-canonical',
        id: tag,
        detail: `moveSan="${entry.moveSan}" doesn't appear in any of ${candidates.length} candidate PGNs for "${entry.openingName}" / "${entry.variation ?? ''}"`,
      });
    } else {
      errors.push({
        cls: 'fen-mismatch',
        id: tag,
        detail: `replay of "${entry.moveSan}" in "${bestMismatch.name}" produces a different FEN`,
        expectedFen: entry.fen,
        replayedFen: bestMismatch.replayedFen,
      });
    }
  }

  // 4) Voice-rule grep — informational, not fatal.
  for (let i = 0; i < entry.narrations.length; i += 1) {
    const text = entry.narrations[i];
    for (const re of INTERFACE_PHRASES) {
      if (re.test(text)) {
        voiceFlags.push({
          id: tag,
          variant: i,
          kind: 'interface-reference',
          match: text.match(re)[0],
        });
      }
    }
    for (const re of ACKNOWLEDGMENT_PHRASES) {
      if (re.test(text)) {
        voiceFlags.push({
          id: tag,
          variant: i,
          kind: 'acknowledgment',
          match: text.match(re)[0],
        });
      }
    }
  }
}

const byClass = errors.reduce((acc, e) => {
  acc[e.cls] = (acc[e.cls] ?? 0) + 1;
  return acc;
}, {});

const report = {
  total: errors.length,
  byClass,
  voiceFlagCount: voiceFlags.length,
  errors,
  voiceFlags,
};

if (flagJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Curated narrations: ${curated.length} entries`);
  console.log(`Errors: ${errors.length}`);
  for (const [cls, count] of Object.entries(byClass)) {
    console.log(`  ${cls.padEnd(28)} ${count}`);
  }
  if (errors.length > 0) {
    console.log('\nFirst 20 errors:');
    for (const e of errors.slice(0, 20)) {
      console.log(`  [${e.cls}] ${e.id}: ${e.detail}`);
      if (e.expectedFen) {
        console.log(`    expected:  ${e.expectedFen}`);
        console.log(`    replayed:  ${e.replayedFen}`);
      }
    }
  }
  console.log(`\nVoice-rule flags: ${voiceFlags.length}`);
  for (const v of voiceFlags.slice(0, 20)) {
    console.log(`  [${v.kind}] ${v.id}#${v.variant}: "${v.match}"`);
  }
}

process.exit(errors.length > 0 ? 1 : 0);
