#!/usr/bin/env node
// scripts/tag-puzzle-moving-piece.mjs
// ----------------------------------------------------------------------
// One-shot tagger for src/data/puzzles.json. Adds a `movingPiece` field
// to every puzzle record (K/Q/R/B/N/P) by applying the puzzle's first
// UCI move via chess.js and reading the piece letter off the resulting
// move object.
//
// Required by the kid section's per-piece puzzle filter — Lichess's
// `moves` field is UCI (e.g. "f3g4"), not SAN, so we can't derive the
// piece by looking at the first character of the move string.
//
// Idempotent: re-running on a file that already has movingPiece skips
// untouched entries. Logs any entry where the UCI move can't be
// applied (would indicate a bad FEN/move pair in source data).
//
// Run with:  node scripts/tag-puzzle-moving-piece.mjs
// (Or via npm script — see package.json once added.)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUZZLES_PATH = resolve(ROOT, 'src/data/puzzles.json');

const PIECE_MAP = {
  p: 'P',
  n: 'N',
  b: 'B',
  r: 'R',
  q: 'Q',
  k: 'K',
};

function tagPuzzle(puzzle) {
  if (typeof puzzle.movingPiece === 'string') {
    return { tagged: false, error: null };
  }
  const moves = String(puzzle.moves ?? '').trim();
  if (!moves) {
    return { tagged: false, error: 'no moves' };
  }
  const firstUci = moves.split(/\s+/)[0];
  if (!firstUci || firstUci.length < 4) {
    return { tagged: false, error: `bad uci: ${firstUci}` };
  }
  try {
    const chess = new Chess(puzzle.fen);
    const move = chess.move({
      from: firstUci.slice(0, 2),
      to: firstUci.slice(2, 4),
      promotion: firstUci.length === 5 ? firstUci[4] : undefined,
    });
    if (!move) {
      return { tagged: false, error: 'chess.js rejected move' };
    }
    const piece = PIECE_MAP[move.piece];
    if (!piece) {
      return { tagged: false, error: `unknown piece: ${move.piece}` };
    }
    puzzle.movingPiece = piece;
    return { tagged: true, error: null };
  } catch (err) {
    return { tagged: false, error: err.message || String(err) };
  }
}

function main() {
  const raw = readFileSync(PUZZLES_PATH, 'utf8');
  const puzzles = JSON.parse(raw);
  if (!Array.isArray(puzzles)) {
    throw new Error('puzzles.json is not an array');
  }
  const total = puzzles.length;
  let tagged = 0;
  let skipped = 0;
  const errors = [];
  const pieceCounts = { K: 0, Q: 0, R: 0, B: 0, N: 0, P: 0 };
  for (const p of puzzles) {
    const result = tagPuzzle(p);
    if (result.tagged) {
      tagged += 1;
      pieceCounts[p.movingPiece] += 1;
    } else if (result.error) {
      errors.push({ id: p.id, error: result.error });
    } else {
      skipped += 1;
      if (p.movingPiece) pieceCounts[p.movingPiece] += 1;
    }
  }
  // Pretty-print: 2-space indent, sorted top-level keys not needed since
  // we preserve the array order and just append a new field.
  writeFileSync(PUZZLES_PATH, JSON.stringify(puzzles, null, 2) + '\n');
  console.log(`[tag-puzzle-moving-piece] total: ${total}`);
  console.log(`  newly tagged: ${tagged}`);
  console.log(`  already had movingPiece: ${skipped}`);
  console.log(`  errors: ${errors.length}`);
  console.log(`  by piece:`, pieceCounts);
  if (errors.length > 0 && errors.length <= 20) {
    console.log(`  first errors:`);
    for (const e of errors.slice(0, 20)) console.log(`    ${e.id}: ${e.error}`);
  }
  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
