#!/usr/bin/env node
/**
 * scripts/audit-openings-narration.mjs
 *
 * Scans every annotations/*.json file against its canonical PGN from
 * openings-lichess.json and emits a categorized report of conflicts.
 *
 * Does NOT auto-fix. Per David's 2026-05-14 guidance, the auditor
 * surfaces the discrepancy and the operator decides which side
 * (narration vs PGN) is wrong — the prior 163-error pass (#497)
 * assumed narration was wrong by default, but this round we make
 * no such assumption.
 *
 * Error classes produced:
 *   - san-mismatch: annotation's `san` doesn't match the PGN's ply
 *   - illegal-san: annotation's `san` can't be played at that ply
 *   - piece-on-square-mismatch: narration text says "<piece> on <sq>"
 *     but the FEN at that ply has a different piece (or empty)
 *   - side-to-move-mismatch: narration says "White/Black plays X" but
 *     the side-to-move in the FEN is the opposite
 *   - annotation-length-drift: moveAnnotations.length != PGN ply count
 *   - opening-id-pgn-drift: the file's openingId doesn't resolve to a
 *     row in openings-lichess.json
 *   - unparseable: PGN won't replay through chess.js, or JSON is bad
 *
 * Usage:
 *   node scripts/audit-openings-narration.mjs
 *   node scripts/audit-openings-narration.mjs --json > report.json
 *
 * Exit codes: 0 = no errors, 1 = errors found, 2 = scan crashed.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');

// slugify matches src/services/dataLoader.ts:81 — id = slugify(`${eco}-${name}`).
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const PIECE_NAMES = {
  king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P',
};
const SQUARE_RE = /\b([a-h][1-8])\b/g;
// Match phrases like "the knight on f3", "Black's bishop on c5",
// "the pawn on e4". Case-insensitive. We extract piece + square.
// This is intentionally conservative — false positives waste an
// operator's eyeballing time; we'd rather miss a few than flood
// the report.
const PIECE_ON_SQUARE_RE =
  /\b(king|queen|rook|bishop|knight|pawn)s?\s+(?:is\s+|sits\s+|sat\s+|stands\s+|stood\s+|are\s+|on|at)\s*(?:on\s+)?([a-h][1-8])\b/gi;

const SIDE_PLAYS_RE = /\b(white|black)\s+(?:plays?|moves?|develops?|pushes?|castles?|captures?)\s+([A-Za-z][a-zA-Z0-9+#=]*)/g;

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

function loadOpeningsById() {
  const raw = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
  // Multiple openings can share the same slug — Lichess assigns the
  // same name to different PGN sequences (e.g. "Barnes Opening:
  // Gedult Gambit" has two variants). Store the FULL LIST per slug
  // so the auditor can pick whichever variant the annotation file
  // actually matches.
  const byId = new Map();
  for (const row of raw) {
    const fullId = slugify(`${row.eco}-${row.name}`);
    const nameOnlyId = slugify(row.name);
    if (!byId.has(fullId)) byId.set(fullId, []);
    if (!byId.has(nameOnlyId)) byId.set(nameOnlyId, []);
    byId.get(fullId).push(row);
    byId.get(nameOnlyId).push(row);
  }
  return byId;
}

/** Pick the opening variant whose PGN best matches the annotation's
 *  SAN sequence. Returns the variant + its plies. When multiple
 *  variants tie (or there's only one), returns the first. */
function pickBestVariant(variants, ann) {
  if (variants.length === 1) {
    return { row: variants[0], plies: replayPgn(variants[0].pgn) };
  }
  let best = null;
  for (const row of variants) {
    let plies;
    try {
      plies = replayPgn(row.pgn);
    } catch {
      continue;
    }
    // Score: number of consecutive matching SANs starting from ply 1.
    let matches = 0;
    for (let i = 0; i < Math.min(plies.length, ann.moveAnnotations.length); i += 1) {
      const claimSan = stripSan(ann.moveAnnotations[i].san ?? '');
      const truthSan = stripSan(plies[i].san);
      if (claimSan === truthSan) matches += 1;
      else break;
    }
    if (!best || matches > best.matches) best = { row, plies, matches };
  }
  return best ? { row: best.row, plies: best.plies } : null;
}

/** Replay a SAN-only PGN body, return per-ply { san, fenBefore, fenAfter,
 *  sideToMove ('w'|'b') }. Throws on first illegal move. */
function replayPgn(pgn) {
  const chess = new Chess();
  const moves = pgn.trim().split(/\s+/).filter(Boolean);
  const plies = [];
  for (const san of moves) {
    const fenBefore = chess.fen();
    const sideToMove = chess.turn();
    const result = chess.move(san);
    if (!result) throw new Error(`illegal SAN "${san}" at ply ${plies.length + 1}`);
    plies.push({
      san: result.san,
      fenBefore,
      fenAfter: chess.fen(),
      sideToMove,
    });
  }
  return plies;
}

/** Given a FEN, return a square→piece map ("f3" → "wN", "e5" → "bP"). */
function fenToPieceMap(fen) {
  const placement = fen.split(' ')[0];
  const ranks = placement.split('/');
  const map = {};
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toUpperCase();
        const sq = `${String.fromCharCode(97 + file)}${rank}`;
        map[sq] = `${color}${type}`;
        file += 1;
      }
    }
  }
  return map;
}

/** Strip SAN annotations ("+#!?") + promotion suffix for comparison. */
function stripSan(san) {
  return san.replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
}

function auditAnnotation(filename, openingId, ann, plies) {
  const errors = [];
  const pushErr = (e) => errors.push({ file: filename, openingId, ...e });

  // annotation-length-drift — split into OVERFLOW vs SHORTFALL.
  // Per 2026-05-14 conversation: shortfall (fewer annotations than
  // PGN plies) is allowed — the unannotated plies just don't get
  // narration. Overflow (more annotations than plies) is a real bug
  // because the surplus annotations describe positions that don't
  // exist in the PGN.
  if (ann.moveAnnotations.length > plies.length) {
    pushErr({
      class: 'annotation-overflow',
      claim: `${ann.moveAnnotations.length} moveAnnotations`,
      pgnTruth: `${plies.length} plies — surplus ${ann.moveAnnotations.length - plies.length} describes nonexistent positions`,
    });
  } else if (ann.moveAnnotations.length < plies.length) {
    // Shortfall — info only, not flagged as error.
  }

  for (let i = 0; i < ann.moveAnnotations.length; i += 1) {
    const entry = ann.moveAnnotations[i];
    const ply = plies[i];
    if (!ply) break; // length-drift already reported

    // san-mismatch
    const claimSan = stripSan(entry.san ?? '');
    const truthSan = stripSan(ply.san);
    if (claimSan !== truthSan) {
      pushErr({
        class: 'san-mismatch',
        plyIndex: i,
        claim: `annotation.san="${entry.san}"`,
        pgnTruth: `PGN ply ${i + 1} is ${ply.san}`,
      });
      // No point checking text claims when SAN itself is off.
      continue;
    }

    // Narration text claims — checked against fenAfter (the position
    // the narration is describing; usually "after this move ...").
    const pieceMap = fenToPieceMap(ply.fenAfter);
    const sideToMove = ply.sideToMove; // BEFORE the move was played

    for (const field of ['annotation', 'shortNarration']) {
      const text = entry[field];
      if (!text || typeof text !== 'string') continue;

      // piece-on-square-mismatch
      const pieceMatches = [...text.matchAll(PIECE_ON_SQUARE_RE)];
      for (const m of pieceMatches) {
        const pieceName = m[1].toLowerCase();
        const sq = m[2].toLowerCase();
        const expectedType = PIECE_NAMES[pieceName];
        const actual = pieceMap[sq];
        if (!actual) {
          pushErr({
            class: 'piece-on-square-mismatch',
            plyIndex: i,
            field,
            claim: `${pieceName} on ${sq}`,
            pgnTruth: `${sq} is empty after ${ply.san}`,
            snippet: text.slice(Math.max(0, m.index - 30), m.index + 50),
          });
        } else if (actual[1] !== expectedType) {
          pushErr({
            class: 'piece-on-square-mismatch',
            plyIndex: i,
            field,
            claim: `${pieceName} on ${sq}`,
            pgnTruth: `${sq} actually has ${actual} after ${ply.san}`,
            snippet: text.slice(Math.max(0, m.index - 30), m.index + 50),
          });
        }
      }

      // side-to-move-mismatch (only for "White plays X" / "Black plays X"
      // phrasing where X is verifiable against the PGN at this ply).
      const sideMatches = [...text.matchAll(SIDE_PLAYS_RE)];
      for (const sm of sideMatches) {
        const claimedSide = sm[1].toLowerCase(); // 'white' | 'black'
        const claimedSan = stripSan(sm[2]);
        // Only fail when claimedSan === the ply's actual SAN AND the
        // claimedSide is wrong. Otherwise the phrase may refer to a
        // DIFFERENT ply ("Black will respond with Nf6") which we
        // can't verify here.
        if (claimedSan !== truthSan) continue;
        const actualSide = sideToMove === 'w' ? 'white' : 'black';
        if (claimedSide !== actualSide) {
          pushErr({
            class: 'side-to-move-mismatch',
            plyIndex: i,
            field,
            claim: `${claimedSide} plays ${claimedSan}`,
            pgnTruth: `ply ${i + 1} is ${actualSide}'s move`,
            snippet: text.slice(Math.max(0, sm.index - 20), sm.index + 60),
          });
        }
      }
    }
  }

  return errors;
}

function main() {
  const byId = loadOpeningsById();
  const files = readdirSync(ANNOTATIONS_DIR).filter((f) => f.endsWith('.json'));
  const errors = [];
  let scanned = 0;
  let unparseable = 0;
  let idDrift = 0;

  for (const file of files) {
    const filepath = join(ANNOTATIONS_DIR, file);
    let ann;
    try {
      ann = JSON.parse(readFileSync(filepath, 'utf8'));
    } catch (e) {
      errors.push({
        file, openingId: null,
        class: 'unparseable',
        claim: 'JSON parse failed',
        pgnTruth: e.message,
      });
      unparseable += 1;
      continue;
    }

    const variants = byId.get(ann.openingId);
    if (!variants || variants.length === 0) {
      // pro-* annotation files are runtime-resolved by
      // annotationService.ts's resolveAnnotationId (strips pro-<player>-
      // prefix + maps the suffix via PRO_SUFFIX_TO_BASE). They're
      // not standalone DB entries; skip rather than flagging as
      // orphan drift.
      if (ann.openingId.startsWith('pro-')) continue;
      errors.push({
        file, openingId: ann.openingId,
        class: 'opening-id-pgn-drift',
        claim: `openingId "${ann.openingId}" referenced`,
        pgnTruth: 'no matching row in openings-lichess.json',
      });
      idDrift += 1;
      continue;
    }

    let pick;
    try {
      pick = pickBestVariant(variants, ann);
    } catch (e) {
      errors.push({
        file, openingId: ann.openingId,
        class: 'unparseable',
        claim: 'opening PGN replay failed',
        pgnTruth: e.message,
      });
      unparseable += 1;
      continue;
    }
    if (!pick) {
      errors.push({
        file, openingId: ann.openingId,
        class: 'unparseable',
        claim: 'no variant has a replayable PGN',
        pgnTruth: variants.map(v => v.pgn).join(' || '),
      });
      unparseable += 1;
      continue;
    }

    errors.push(...auditAnnotation(file, ann.openingId, ann, pick.plies));
    scanned += 1;
  }

  // Tally by class.
  const byClass = {};
  for (const err of errors) {
    byClass[err.class] = (byClass[err.class] ?? 0) + 1;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ scanned, totalErrors: errors.length, byClass, errors }, null, 2));
  } else {
    console.log(`Scanned: ${scanned} annotation files (${files.length} candidates, ${unparseable} unparseable, ${idDrift} id-drift)`);
    console.log(`Total errors: ${errors.length}`);
    console.log(`By class:`);
    for (const [cls, count] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cls.padEnd(30)} ${count}`);
    }
    if (errors.length > 0 && errors.length <= 12) {
      console.log(`\nSample errors:`);
      for (const e of errors.slice(0, 12)) {
        console.log(`  [${e.class}] ${e.file}`);
        if (e.snippet) console.log(`    "${e.snippet.replace(/\s+/g, ' ').trim()}"`);
        console.log(`    claim: ${e.claim}`);
        console.log(`    truth: ${e.pgnTruth}`);
      }
    }
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

try {
  main();
} catch (e) {
  console.error('Auditor crashed:', e);
  process.exitCode = 2;
}
