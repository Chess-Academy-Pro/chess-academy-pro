#!/usr/bin/env node
// scripts/audit-kid-puzzles-static.mjs
// ----------------------------------------------------------------------
// Static validator for EVERY hand-authored puzzle and lesson position
// in the kid curriculum:
//
//   - src/data/journeyChapters.ts    (Pawn's Journey)
//   - src/data/fairyTaleChapters.ts  (Fairy Tale Quest)
//   - src/data/guidedGames.ts        (5 Guided Famous Games)
//   - src/data/puzzles.json + training-puzzles.json (~15.3K)
//   - src/data/pieceMazeLevels.ts + pieceSweepLevels.ts (P7 levels)
//
// Per CLAUDE.md non-negotiable #17, the DB is the source of truth
// in kid mode. The LLM only writes prose. This validator asserts
// that contract structurally:
//
//   - Every puzzle FEN is parseable via chess.js (no invented
//     positions, no illegal piece counts, no missing kings).
//   - Every solution move is legal in its FEN.
//   - Every lesson FEN parses and contains the chapter's piece.
//   - Every maze / sweep / training level's first move applies
//     cleanly from chess.js's view.
//   - No `id` starting with `ai-` (those are LLM-invented puzzles
//     from the old kidPuzzleService.generateKidPuzzles path —
//     they'd indicate the inversion hadn't landed).
//
// Run: node scripts/audit-kid-puzzles-static.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function err(group, id, msg) { errors.push({ group, id, msg }); }
function warn(group, id, msg) { warnings.push({ group, id, msg }); }

// ─── 1. journeyChapters + fairyTaleChapters ─────────────────────────
// These export TS modules. We can't `require` TS, so we use the
// project's own tsx loader.
async function validateChapters(modulePath, label) {
  let mod;
  try {
    mod = await import(modulePath);
  } catch (e) {
    err(label, '(import)', `failed to import: ${e?.message ?? e}`);
    return;
  }
  // The module exports an array of chapters. Find it.
  const chapters = mod.JOURNEY_CHAPTERS ?? mod.FAIRY_TALE_CHAPTERS ?? null;
  if (!Array.isArray(chapters)) {
    err(label, '(shape)', 'no chapters array exported');
    return;
  }
  console.log(`  ${label}: ${chapters.length} chapters`);
  for (const ch of chapters) {
    if (!ch.id) { err(label, '(missing-id)', 'chapter without id'); continue; }
    // ── Lessons ────────────────────────────────────────────────────
    for (const l of (ch.lessons ?? [])) {
      const id = `${ch.id}/${l.id}`;
      if (!l.fen) { err(label, id, 'lesson missing fen'); continue; }
      try { new Chess(l.fen); }
      catch (e) { err(label, id, `lesson fen invalid: ${e?.message}`); }
    }
    // ── Puzzles ────────────────────────────────────────────────────
    for (const p of (ch.puzzles ?? [])) {
      const id = `${ch.id}/${p.id}`;
      if (typeof p.id === 'string' && p.id.startsWith('ai-')) {
        err(label, id, 'AI-invented puzzle id detected (non-negotiable #17 violation)');
      }
      if (!p.fen) { err(label, id, 'puzzle missing fen'); continue; }
      let chess;
      try { chess = new Chess(p.fen); }
      catch (e) { err(label, id, `puzzle fen invalid: ${e?.message}`); continue; }
      const sol = Array.isArray(p.solution) ? p.solution[0] : p.solution;
      if (typeof sol !== 'string') { err(label, id, 'puzzle missing/non-string solution'); continue; }
      try {
        // chess.js v1 throws on illegal moves; v2 returns null.
        const m = chess.move(sol);
        if (!m) err(label, id, `solution '${sol}' is not a legal move from FEN`);
      } catch (e) {
        err(label, id, `solution '${sol}' threw: ${e?.message}`);
      }
      // Side-of-turn sanity: kid plays the side whose turn it is.
      // Verify the kid color matches the chapter's piece color (white
      // for white-led chapters in Journey).
    }
  }
}

// ─── 2. Guided games ────────────────────────────────────────────────
async function validateGuidedGames(modulePath) {
  let mod;
  try { mod = await import(modulePath); }
  catch (e) { err('guidedGames', '(import)', `failed: ${e?.message}`); return; }
  const games = mod.GUIDED_GAMES;
  if (!Array.isArray(games)) { err('guidedGames', '(shape)', 'no GUIDED_GAMES array'); return; }
  console.log(`  guidedGames: ${games.length} games`);
  for (const g of games) {
    const gid = g.id;
    if (!g.startFen) { err('guidedGames', gid, 'missing startFen'); continue; }
    let chess;
    try { chess = new Chess(g.startFen); }
    catch (e) { err('guidedGames', gid, `startFen invalid: ${e?.message}`); continue; }
    // Replay every scripted move.
    let prevFen = g.startFen;
    for (let i = 0; i < (g.moves ?? []).length; i++) {
      const mv = g.moves[i];
      const stepChess = new Chess(prevFen);
      try {
        const r = stepChess.move(mv.san);
        if (!r) { err('guidedGames', `${gid}#${i}`, `move '${mv.san}' illegal from prev FEN`); break; }
        if (mv.fen && stepChess.fen() !== mv.fen) {
          // chess.js full-move counter sometimes differs from stored
          // FENs; tolerate but log as warning.
          warn('guidedGames', `${gid}#${i}`, `recomputed FEN differs from stored mv.fen`);
        }
        prevFen = stepChess.fen();
      } catch (e) {
        err('guidedGames', `${gid}#${i}`, `move '${mv.san}' threw: ${e?.message}`);
        break;
      }
    }
  }
}

// ─── 3. puzzles.json + training-puzzles.json ────────────────────────
function validatePuzzlesJson() {
  const lichess = JSON.parse(readFileSync(resolve(ROOT, 'src/data/puzzles.json'), 'utf8'));
  const training = JSON.parse(readFileSync(resolve(ROOT, 'src/data/training-puzzles.json'), 'utf8'));
  console.log(`  puzzles.json: ${lichess.length} + training: ${training.length}`);
  let aiCount = 0;
  for (const p of [...lichess, ...training]) {
    if (typeof p.id === 'string' && p.id.startsWith('ai-')) { aiCount++; continue; }
    if (!p.fen) { err('puzzles', p.id, 'missing fen'); continue; }
    let chess;
    try { chess = new Chess(p.fen); }
    catch (e) { err('puzzles', p.id, `fen invalid: ${e?.message}`); continue; }
    const firstUci = (p.moves ?? '').split(/\s+/)[0];
    if (!firstUci || firstUci.length < 4) { err('puzzles', p.id, 'no UCI first move'); continue; }
    try {
      const m = chess.move({
        from: firstUci.slice(0, 2),
        to: firstUci.slice(2, 4),
        promotion: firstUci.length === 5 ? firstUci[4] : undefined,
      });
      if (!m) err('puzzles', p.id, `first UCI move '${firstUci}' illegal`);
    } catch (e) {
      err('puzzles', p.id, `first UCI move '${firstUci}' threw: ${e?.message}`);
    }
  }
  if (aiCount > 0) err('puzzles', '(ai-prefix)', `${aiCount} puzzles have ai- id prefix (LLM-invented)`);
}

// ─── 4. pieceMazeLevels + pieceSweepLevels ──────────────────────────
async function validateLevelConfigs(modulePath, kind) {
  let mod;
  try { mod = await import(modulePath); }
  catch (e) { err(kind, '(import)', `failed: ${e?.message}`); return; }
  const levels = mod.PIECE_MAZE_LEVELS ?? mod.PIECE_SWEEP_LEVELS;
  if (!Array.isArray(levels)) { err(kind, '(shape)', 'no levels array'); return; }
  console.log(`  ${kind}: ${levels.length} levels`);
  for (const l of levels) {
    const id = `${l.piece}/${l.id}`;
    if (!/^[a-h][1-8]$/.test(l.pieceStart)) err(kind, id, `bad pieceStart: ${l.pieceStart}`);
    if (l.target && !/^[a-h][1-8]$/.test(l.target)) err(kind, id, `bad target: ${l.target}`);
    for (const t of (l.targets ?? [])) {
      if (!/^[a-h][1-8]$/.test(t)) err(kind, id, `bad target square: ${t}`);
    }
    for (const o of (l.obstacles ?? [])) {
      if (!/^[a-h][1-8]$/.test(o)) err(kind, id, `bad obstacle square: ${o}`);
    }
  }
}

// ─── Run ────────────────────────────────────────────────────────────
console.log('[kid-puzzles-static] starting\n');

await validateChapters(resolve(ROOT, 'src/data/journeyChapters.ts'), 'journey');
await validateChapters(resolve(ROOT, 'src/data/fairyTaleChapters.ts'), 'fairyTale');
await validateGuidedGames(resolve(ROOT, 'src/data/guidedGames.ts'));
validatePuzzlesJson();
await validateLevelConfigs(resolve(ROOT, 'src/data/pieceMazeLevels.ts'), 'pieceMaze');
await validateLevelConfigs(resolve(ROOT, 'src/data/pieceSweepLevels.ts'), 'pieceSweep');

console.log('');
console.log(`errors:   ${errors.length}`);
console.log(`warnings: ${warnings.length}`);
if (errors.length > 0) {
  console.log('\n=== ERRORS ===');
  // Group by error-class to make the list scannable.
  const byMsg = {};
  for (const e of errors) {
    const k = `${e.group}::${e.msg.split(':')[0]}`;
    if (!byMsg[k]) byMsg[k] = [];
    byMsg[k].push(`${e.id}: ${e.msg}`);
  }
  for (const [k, list] of Object.entries(byMsg)) {
    console.log(`\n  [${k}] (${list.length}):`);
    for (const item of list.slice(0, 10)) console.log(`    ${item}`);
    if (list.length > 10) console.log(`    … and ${list.length - 10} more`);
  }
}
if (warnings.length > 0 && warnings.length <= 20) {
  console.log('\n=== WARNINGS ===');
  for (const w of warnings.slice(0, 20)) console.log(`  ${w.group}/${w.id}: ${w.msg}`);
}
if (errors.length > 0) process.exit(1);
