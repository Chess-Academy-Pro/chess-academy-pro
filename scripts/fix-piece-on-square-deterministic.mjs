#!/usr/bin/env node
/**
 * scripts/fix-piece-on-square-deterministic.mjs
 *
 * For each `piece-on-square-mismatch` error where the cited square
 * has a DIFFERENT piece (not empty), apply a deterministic word
 * swap — "pawn on d5" → "knight on d5" when d5 actually has a
 * knight. No LLM needed; the FEN is the truth, the swap is
 * unambiguous.
 *
 * Cases where the cited square is EMPTY are deferred to a
 * separate LLM pass (the rewrite needs judgment — the narration
 * may be projecting a future move). Those are written to
 * audit-reports/piece-on-square-empty-square-needs-llm.json.
 *
 * Usage:
 *   node scripts/fix-piece-on-square-deterministic.mjs           # dry-run
 *   node scripts/fix-piece-on-square-deterministic.mjs --apply
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const REPORT_PATH = join(REPO, 'audit-reports/openings-narration.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const NEEDS_LLM_PATH = join(REPO, 'audit-reports/piece-on-square-empty-square-needs-llm.json');

const apply = process.argv.includes('--apply');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function stripSan(s) {
  return (s ?? '').replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
}

const opens = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
const byId = new Map();
for (const r of opens) {
  const fullId = slugify(`${r.eco}-${r.name}`);
  const nameId = slugify(r.name);
  if (!byId.has(fullId)) byId.set(fullId, []);
  if (!byId.has(nameId)) byId.set(nameId, []);
  byId.get(fullId).push(r);
  byId.get(nameId).push(r);
}

function replayPgn(pgn) {
  const chess = new Chess();
  const plies = [];
  for (const san of pgn.trim().split(/\s+/).filter(Boolean)) {
    const fenBefore = chess.fen();
    const sideToMove = chess.turn();
    const result = chess.move(san);
    if (!result) throw new Error(`illegal: ${san}`);
    plies.push({ san: result.san, fenBefore, fenAfter: chess.fen(), sideToMove });
  }
  return plies;
}

function pickBestVariant(variants, ann) {
  if (variants.length === 1) return { plies: replayPgn(variants[0].pgn) };
  let best = null;
  for (const row of variants) {
    let plies;
    try { plies = replayPgn(row.pgn); } catch { continue; }
    let matches = 0;
    for (let i = 0; i < Math.min(plies.length, ann.moveAnnotations.length); i += 1) {
      const claim = stripSan(ann.moveAnnotations[i].san ?? '');
      const truth = stripSan(plies[i].san);
      if (claim === truth) matches += 1;
      else break;
    }
    if (!best || matches > best.matches) best = { plies, matches };
  }
  return best ? { plies: best.plies } : null;
}

function fenToPieceMap(fen) {
  const ranks = fen.split(' ')[0].split('/');
  const map = {};
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toUpperCase();
      map[`${String.fromCharCode(97 + file)}${rank}`] = `${color}${type}`;
      file += 1;
    }
  }
  return map;
}

const PIECE_FULLNAME = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
// Match "the king on f3", "Black's bishop on c5", "the pawn on e4", and
// variants like "knight is on f3" / "knight sits on f3". We capture
// the piece word and the square.
const PIECE_ON_SQUARE_RE_G =
  /\b(king|queen|rook|bishop|knight|pawn)(s)?(\s+(?:is\s+|sits\s+|sat\s+|stands\s+|stood\s+|are\s+))?(\s+on\s+|\s+at\s+|\s+)([a-h][1-8])\b/gi;

const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
const errors = report.errors.filter((e) => e.class === 'piece-on-square-mismatch');

// Group by file → ply → field so we patch every claim in one pass.
const filesToFix = new Map();
for (const e of errors) {
  if (!filesToFix.has(e.file)) filesToFix.set(e.file, []);
  filesToFix.get(e.file).push(e);
}

let determFixed = 0;
let emptySquare = 0;
let skipped = 0;
const needsLlm = [];

for (const [file, errs] of filesToFix) {
  const filePath = join(ANNOTATIONS_DIR, file);
  const ann = JSON.parse(readFileSync(filePath, 'utf8'));
  const variants = byId.get(ann.openingId);
  if (!variants) { skipped += errs.length; continue; }
  const pick = pickBestVariant(variants, ann);
  if (!pick) { skipped += errs.length; continue; }

  let fileChanged = false;

  for (const err of errs) {
    const ply = pick.plies[err.plyIndex];
    if (!ply) { skipped += 1; continue; }
    const pieceMap = fenToPieceMap(ply.fenAfter);
    const m = (err.claim ?? '').match(/^(\w+) on ([a-h][1-8])$/i);
    if (!m) { skipped += 1; continue; }
    const wrongPiece = m[1].toLowerCase();
    const sq = m[2].toLowerCase();
    const actual = pieceMap[sq];

    if (!actual) {
      // Square is empty — needs LLM judgment for rephrase. Defer.
      emptySquare += 1;
      needsLlm.push({ file, plyIndex: err.plyIndex, field: err.field, claim: err.claim, snippet: err.snippet, pgnTruth: err.pgnTruth });
      continue;
    }

    // Deterministic swap: replace the wrong piece name (in the
    // matching "<piece> on <sq>" phrase) with the correct one.
    const correctPiece = PIECE_FULLNAME[actual[1]].toLowerCase();
    if (correctPiece === wrongPiece) {
      // Already correct — maybe a duplicate report or text wording
      // variant the auditor didn't catch. Skip.
      skipped += 1;
      continue;
    }

    const text = ann.moveAnnotations[err.plyIndex]?.[err.field];
    if (typeof text !== 'string') { skipped += 1; continue; }

    // Replace the FIRST occurrence of "<wrongPiece> [optional 'is/sits/...']
    // [optional 'on/at'] <sq>" in the text. We don't blanket-replace
    // because the same piece word might appear elsewhere legitimately.
    let replacedAt = -1;
    let patched = text.replace(PIECE_ON_SQUARE_RE_G, (match, piece, plural, verb, sep, square, offset) => {
      if (replacedAt !== -1) return match; // only swap first occurrence
      if (piece.toLowerCase() !== wrongPiece) return match;
      if (square.toLowerCase() !== sq) return match;
      replacedAt = offset;
      // Preserve original case (capital → Capital, lower → lower).
      const out = piece[0] === piece[0].toUpperCase()
        ? correctPiece[0].toUpperCase() + correctPiece.slice(1)
        : correctPiece;
      return out + (plural ?? '') + (verb ?? '') + (sep ?? '') + square;
    });
    if (replacedAt === -1) {
      // Couldn't find the phrase — maybe word boundary mismatch.
      // Defer to LLM.
      needsLlm.push({ file, plyIndex: err.plyIndex, field: err.field, claim: err.claim, snippet: err.snippet, pgnTruth: err.pgnTruth, reason: 'phrase-not-found-for-swap' });
      skipped += 1;
      continue;
    }
    ann.moveAnnotations[err.plyIndex][err.field] = patched;
    fileChanged = true;
    determFixed += 1;
  }

  if (fileChanged && apply) {
    writeFileSync(filePath, JSON.stringify(ann, null, 2) + '\n');
  }
}

writeFileSync(NEEDS_LLM_PATH, JSON.stringify({ count: needsLlm.length, items: needsLlm }, null, 2));
console.log(`Deterministically fixed: ${determFixed} ${apply ? '(applied)' : '(dry-run)'}`);
console.log(`Empty-square (LLM needed): ${emptySquare}`);
console.log(`Skipped: ${skipped}`);
console.log(`LLM-needed batch: audit-reports/piece-on-square-empty-square-needs-llm.json (${needsLlm.length} items)`);
