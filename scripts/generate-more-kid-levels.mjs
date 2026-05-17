#!/usr/bin/env node
// scripts/generate-more-kid-levels.mjs
// ----------------------------------------------------------------------
// Procedurally generates additional medium / hard / expert levels for
// the piece-maze and piece-sweep sandboxes (Phase 7 expansion). Output
// is appended to src/data/pieceMazeLevels.ts and pieceSweepLevels.ts
// as additional level entries — preserving the existing 5 easy levels
// per piece and adding 5 medium (ids 6-10) per piece + game = +60
// total levels (30 maze + 30 sweep).
//
// Validation is in-script via BFS: every emitted level is solvable
// and its par equals the BFS min-moves.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = 'abcdefgh';

function fileIdx(s) { return FILES.indexOf(s[0]); }
function rankIdx(s) { return parseInt(s[1], 10) - 1; }
function sq(f, r) { return `${FILES[f]}${r + 1}`; }
function inBoard(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }

// ─── Movement rules (mirrors pieceMazeService.getPieceLegalMoves) ───
function slide(from, blocked, dirs, maxSteps = 7) {
  const out = [];
  let f = fileIdx(from), r = rankIdx(from);
  for (const [df, dr] of dirs) {
    let cf = f + df, cr = r + dr, steps = 0;
    while (inBoard(cf, cr) && steps < maxSteps) {
      const s = sq(cf, cr);
      if (blocked.has(s)) break;
      out.push(s);
      cf += df; cr += dr; steps += 1;
    }
  }
  return out;
}
const ROOK_DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

function knightLegal(from, blocked) {
  const out = [];
  const f = fileIdx(from), r = rankIdx(from);
  for (const [df, dr] of KNIGHT_DELTAS) {
    const cf = f + df, cr = r + dr;
    if (!inBoard(cf, cr)) continue;
    const s = sq(cf, cr);
    if (blocked.has(s)) continue;
    out.push(s);
  }
  return out;
}

function pawnMazeLegal(from, blocked) {
  const f = fileIdx(from), r = rankIdx(from);
  if (r >= 7) return [];
  const out = [];
  const one = sq(f, r + 1);
  if (!blocked.has(one)) {
    out.push(one);
    if (r === 1) {
      const two = sq(f, r + 2);
      if (!blocked.has(two)) out.push(two);
    }
  }
  return out;
}

function getMazeMoves(piece, from, blocked) {
  switch (piece) {
    case 'king':   return slide(from, blocked, QUEEN_DIRS, 1);
    case 'queen':  return slide(from, blocked, QUEEN_DIRS);
    case 'rook':   return slide(from, blocked, ROOK_DIRS);
    case 'bishop': return slide(from, blocked, BISHOP_DIRS);
    case 'knight': return knightLegal(from, blocked);
    case 'pawn':   return pawnMazeLegal(from, blocked);
  }
}

// Sweep rules — sliders stop on capture, pawns capture diagonally
function getSweepMoves(piece, from, obstacles, targets) {
  if (piece === 'pawn') {
    const f = fileIdx(from), r = rankIdx(from);
    if (r >= 7) return [];
    const out = [];
    for (const df of [-1, 1]) {
      const cf = f + df, cr = r + 1;
      if (!inBoard(cf, cr)) continue;
      const s = sq(cf, cr);
      if (obstacles.has(s)) continue;
      if (targets.has(s)) out.push(s);
    }
    const pushOne = sq(f, r + 1);
    if (!obstacles.has(pushOne) && !targets.has(pushOne)) out.push(pushOne);
    return out;
  }
  if (piece === 'king' || piece === 'knight') {
    return getMazeMoves(piece, from, obstacles).filter((s) => !obstacles.has(s));
  }
  const dirs = piece === 'rook' ? ROOK_DIRS : piece === 'bishop' ? BISHOP_DIRS : QUEEN_DIRS;
  const out = [];
  let f = fileIdx(from), r = rankIdx(from);
  for (const [df, dr] of dirs) {
    let cf = f + df, cr = r + dr;
    while (inBoard(cf, cr)) {
      const s = sq(cf, cr);
      if (obstacles.has(s)) break;
      out.push(s);
      if (targets.has(s)) break;
      cf += df; cr += dr;
    }
  }
  return out;
}

// ─── BFS solvers ─────────────────────────────────────────────────────
function bfsMazeMin(piece, start, target, obstacles) {
  const blocked = new Set(obstacles);
  if (blocked.has(start) || blocked.has(target)) return -1;
  const seen = new Map([[start, 0]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    const d = seen.get(cur);
    if (cur === target) return d;
    for (const nx of getMazeMoves(piece, cur, blocked)) {
      if (!seen.has(nx)) { seen.set(nx, d + 1); q.push(nx); }
    }
  }
  return -1;
}

function bfsSweepMin(piece, start, targets, obstacles) {
  const obsSet = new Set(obstacles);
  const startMask = (1 << targets.length) - 1;
  const seen = new Map();
  const key = (pos, mask) => `${pos}:${mask}`;
  seen.set(key(start, startMask), 0);
  const q = [[start, startMask]];
  while (q.length) {
    const [pos, mask] = q.shift();
    const d = seen.get(key(pos, mask));
    if (mask === 0) return d;
    const tSet = new Set();
    for (let i = 0; i < targets.length; i++) if (mask & (1 << i)) tSet.add(targets[i]);
    const moves = getSweepMoves(piece, pos, obsSet, tSet);
    for (const nx of moves) {
      let nextMask = mask;
      for (let i = 0; i < targets.length; i++) {
        if ((mask & (1 << i)) && targets[i] === nx) { nextMask &= ~(1 << i); break; }
      }
      const k = key(nx, nextMask);
      if (!seen.has(k)) { seen.set(k, d + 1); q.push([nx, nextMask]); }
    }
  }
  return -1;
}

// ─── PRNG ───────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randSq(rand) { return sq(Math.floor(rand() * 8), Math.floor(rand() * 8)); }
function pickN(rand, n, exclude) {
  const set = new Set(exclude);
  const out = [];
  let tries = 0;
  while (out.length < n && tries++ < 200) {
    const s = randSq(rand);
    if (!set.has(s)) { set.add(s); out.push(s); }
  }
  return out;
}

// ─── Generators per piece ───────────────────────────────────────────
// Each tries up to maxTries random configs at the given difficulty
// (obstacle count, target count) and keeps the first one that
// (a) is solvable and (b) has min-moves within [parMin, parMax].

const PIECE_LABEL_FOR_NAME = { king: 'King', queen: 'Queen', rook: 'Rook', bishop: 'Bishop', knight: 'Knight', pawn: 'Pawn' };

function genMazeLevel(piece, rand, obstacleCount, parMin, parMax) {
  for (let tries = 0; tries < 400; tries++) {
    const start = randSq(rand);
    let target;
    do { target = randSq(rand); } while (target === start);
    if (piece === 'pawn' && rankIdx(target) <= rankIdx(start)) continue;
    if (piece === 'pawn' && fileIdx(target) !== fileIdx(start)) continue;
    const obs = pickN(rand, obstacleCount, [start, target]);
    if (piece === 'pawn' && obs.some((s) => fileIdx(s) === fileIdx(start) && rankIdx(s) > rankIdx(start) && rankIdx(s) < rankIdx(target))) continue;
    const min = bfsMazeMin(piece, start, target, obs);
    if (min < 0) continue;
    if (min < parMin || min > parMax) continue;
    return { pieceStart: start, target, obstacles: obs, par: min };
  }
  return null;
}

function genSweepLevel(piece, rand, targetCount, obstacleCount, parMin, parMax) {
  for (let tries = 0; tries < 400; tries++) {
    const start = randSq(rand);
    if (piece === 'pawn') {
      const r0 = rankIdx(start);
      if (r0 < 1 || r0 > 5) continue;
    }
    const targets = pickN(rand, targetCount, [start]);
    if (targets.length < targetCount) continue;
    if (piece === 'pawn') {
      // Pawn captures need targets forward and diagonally — bias by
      // requiring all targets to be in rank > start rank.
      const r0 = rankIdx(start);
      if (!targets.every((t) => rankIdx(t) > r0)) continue;
    }
    const obs = pickN(rand, obstacleCount, [start, ...targets]);
    const min = bfsSweepMin(piece, start, targets, obs);
    if (min < 0) continue;
    if (min < parMin || min > parMax) continue;
    return { pieceStart: start, targets, obstacles: obs, par: min };
  }
  return null;
}

// ─── Output ─────────────────────────────────────────────────────────
const PIECES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];

// Each band: { obstacles, parMin, parMax } for maze, similar for sweep.
const MAZE_BANDS = [
  // Band 2 (levels 6-10) — Medium
  { obstacles: 4, parMin: 5, parMax: 10 },
];
const SWEEP_BANDS = [
  // Band 2 (levels 6-10) — 4-5 targets
  { targets: 4, obstacles: 1, parMin: 4, parMax: 9 },
];

const newMazeLevels = [];
const newSweepLevels = [];

let seed = 9000;
for (const piece of PIECES) {
  const rand = mulberry32(seed++);
  let added = 0;
  let nameIdx = 1;
  const seenStartTarget = new Set();
  while (added < 5) {
    const band = MAZE_BANDS[0];
    const lvl = genMazeLevel(piece, rand, band.obstacles, band.parMin, band.parMax);
    if (!lvl) { console.error('maze gen fail', piece, added); break; }
    const k = `${lvl.pieceStart}-${lvl.target}`;
    if (seenStartTarget.has(k)) continue;
    seenStartTarget.add(k);
    newMazeLevels.push({
      piece, id: 6 + added,
      name: `${PIECE_LABEL_FOR_NAME[piece]} Path ${added + 1}`,
      pieceStart: lvl.pieceStart, target: lvl.target, obstacles: lvl.obstacles, par: lvl.par,
    });
    added++; nameIdx++;
  }
}

for (const piece of PIECES) {
  const rand = mulberry32(seed++);
  let added = 0;
  const seenKeys = new Set();
  while (added < 5) {
    const band = SWEEP_BANDS[0];
    const lvl = genSweepLevel(piece, rand, band.targets, band.obstacles, band.parMin, band.parMax);
    if (!lvl) { console.error('sweep gen fail', piece, added); break; }
    const k = `${lvl.pieceStart}-${lvl.targets.sort().join(',')}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    newSweepLevels.push({
      piece, id: 6 + added,
      name: `${PIECE_LABEL_FOR_NAME[piece]} Hunt ${added + 1}`,
      pieceStart: lvl.pieceStart, targets: lvl.targets, obstacles: lvl.obstacles, par: lvl.par,
    });
    added++;
  }
}

console.log('generated:', newMazeLevels.length, 'maze +', newSweepLevels.length, 'sweep');

// Splice into the data files between the close-bracket of the array
// and the export helper.
function spliceInto(filePath, newEntries, kind) {
  let src = readFileSync(filePath, 'utf8');
  // Find the closing "];" of the main array.
  const idx = src.lastIndexOf('];');
  if (idx < 0) throw new Error(`no closing bracket in ${filePath}`);
  const insertion = newEntries.map((l) => {
    const obstacles = JSON.stringify(l.obstacles);
    if (kind === 'maze') {
      return `  {\n    piece: '${l.piece}', id: ${l.id}, name: '${l.name}',\n    pieceStart: '${l.pieceStart}', target: '${l.target}', obstacles: ${obstacles}, par: ${l.par},\n  },`;
    } else {
      const targets = JSON.stringify(l.targets);
      return `  {\n    piece: '${l.piece}', id: ${l.id}, name: '${l.name}',\n    pieceStart: '${l.pieceStart}', targets: ${targets}, obstacles: ${obstacles}, par: ${l.par},\n  },`;
    }
  }).join('\n');
  // Insert immediately before the closing "];"
  const updated = src.slice(0, idx) + '\n  // ── Phase 7c — band-2 (medium) levels, procedurally generated ──\n' + insertion + '\n' + src.slice(idx);
  writeFileSync(filePath, updated);
}

spliceInto(resolve(ROOT, 'src/data/pieceMazeLevels.ts'), newMazeLevels, 'maze');
spliceInto(resolve(ROOT, 'src/data/pieceSweepLevels.ts'), newSweepLevels, 'sweep');
console.log('appended ✓');
