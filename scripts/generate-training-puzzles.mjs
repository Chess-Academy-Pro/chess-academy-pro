#!/usr/bin/env node
// scripts/generate-training-puzzles.mjs
// ----------------------------------------------------------------------
// Procedural generator for the sub-400 ELO kid training-wheel puzzle
// pool. Lichess bottoms out at rating 400; the kid starts at rating
// 100 (David's call). Without this pool the kid sees zero puzzles
// until he grinds his rating up to ~350 — bad UX, kid quits.
//
// Each puzzle is "take the hanging piece": the kid's white piece can
// capture an undefended black piece in one move. The capture must be
// the only legal capture (so there's no ambiguity), and the destination
// square must not be defended by any other black piece (so the
// capture is genuinely "free", not a trade). Per-piece counts target
// 50 puzzles per piece (K/Q/R/B/N/P) for a total of ~300.
//
// Ratings are assigned by piece-value heuristic:
//   - Taking a queen (highest value) is the easiest to spot → 100-200.
//   - Taking a rook → 150-250.
//   - Taking a bishop / knight (minor pieces) → 200-300.
//   - Taking a pawn → 300-400 (kid has to scan a busier board).
// Each puzzle gets jitter so the pool spans the band evenly.
//
// Deterministic via Mulberry32 PRNG keyed on the piece letter — same
// run, same output. Re-runs are idempotent (writes the same file).
// Output: src/data/training-puzzles.json.
//
// Run: node scripts/generate-training-puzzles.mjs
//   or: npm run data:generate-training

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(ROOT, 'src/data/training-puzzles.json');

// ─── PRNG ──────────────────────────────────────────────────────────────
// Mulberry32 — small fast PRNG, deterministic from a seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = 'abcdefgh';
const RANKS = '12345678';
function square(fileIdx, rankIdx) {
  return `${FILES[fileIdx]}${RANKS[rankIdx]}`;
}
function randSquare(rand) {
  return square(Math.floor(rand() * 8), Math.floor(rand() * 8));
}
function randInRange(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const PIECE_FEN = { K: 'K', Q: 'Q', R: 'R', B: 'B', N: 'N', P: 'P' };
const PIECE_LOWER = { K: 'k', Q: 'q', R: 'r', B: 'b', N: 'n', P: 'p' };

// Rating bands by which piece the kid is moving. Easier piece (bigger
// target value possible) → lower rating.
const RATING_BAND = {
  Q: [100, 200],  // queens taking free pieces — kid sees the giant arrow of attack
  R: [150, 250],  // rooks
  B: [200, 300],  // bishops
  N: [200, 300],  // knights — L-shape is intrinsically harder
  P: [300, 400],  // pawns — busier scan
  K: [250, 350],  // king captures adjacent piece — needs awareness of safety
};

// Theme tags so the kid filter can pick training puzzles by intent.
const TRAINING_THEMES = ['hangingPiece', 'oneMove', 'short', 'training'];

// ─── Position assembly ────────────────────────────────────────────────
// Builds a board state by placing pieces directly, then composes a FEN.
// We track piece positions in a map keyed by square name and color/type,
// then output the rank-by-rank notation chess.js expects.

function buildBoard(pieces) {
  // pieces: Array<{ square, color: 'w'|'b', type: 'k'|'q'|'r'|'b'|'n'|'p' }>
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const p of pieces) {
    const fileIdx = FILES.indexOf(p.square[0]);
    const rankIdx = RANKS.indexOf(p.square[1]);
    if (fileIdx < 0 || rankIdx < 0) return null;
    if (grid[rankIdx][fileIdx]) return null; // overlap
    const letter = p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase();
    grid[rankIdx][fileIdx] = letter;
  }
  // FEN rank 8 first, then 7, …
  const ranks = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (cell) {
        if (empty > 0) { row += empty; empty = 0; }
        row += cell;
      } else {
        empty += 1;
      }
    }
    if (empty > 0) row += empty;
    ranks.push(row);
  }
  return ranks.join('/') + ' w - - 0 1';
}

function chebyshev(a, b) {
  const af = FILES.indexOf(a[0]); const ar = RANKS.indexOf(a[1]);
  const bf = FILES.indexOf(b[0]); const br = RANKS.indexOf(b[1]);
  return Math.max(Math.abs(af - bf), Math.abs(ar - br));
}

// ─── Per-piece position generators ────────────────────────────────────

function tryGenerateCapturePosition(piece, rand) {
  // Place WK, BK, kid's white piece, black target. Validate via chess.js,
  // confirm the kid's piece can capture the target, and that the capture
  // square is undefended.
  const wk = randSquare(rand);
  let bk = randSquare(rand);
  let tries = 0;
  while ((wk === bk || chebyshev(wk, bk) < 2) && tries++ < 40) {
    bk = randSquare(rand);
  }
  if (chebyshev(wk, bk) < 2) return null;

  // Place kid's attacker (white).
  let attacker = randSquare(rand);
  tries = 0;
  while ((attacker === wk || attacker === bk) && tries++ < 40) {
    attacker = randSquare(rand);
  }
  if (attacker === wk || attacker === bk) return null;

  // Pawns can only live on ranks 2-7.
  if (piece === 'P') {
    const rIdx = RANKS.indexOf(attacker[1]);
    if (rIdx < 1 || rIdx > 6) return null;
  }
  // Kings (this case = piece K means the white king IS the attacker
  // and there's no separate WK). Skip K via this template — we generate
  // K-attacker puzzles in a dedicated sub-routine below.
  if (piece === 'K') return null;

  // Build a candidate board.
  const pieces = [
    { square: wk, color: 'w', type: 'k' },
    { square: bk, color: 'b', type: 'k' },
    { square: attacker, color: 'w', type: piece.toLowerCase() },
  ];

  // Choose a black target piece. Prefer higher-value targets so the
  // capture is dramatic and the kid clearly wins material.
  const targetTypes = ['q', 'r', 'b', 'n', 'p'];
  const targetType = targetTypes[Math.floor(rand() * targetTypes.length)];

  // Find an empty square that the attacker can reach.
  // Brute force: try a bunch of squares and ask chess.js if a capture move exists.
  const fenWithoutTarget = buildBoard(pieces);
  if (!fenWithoutTarget) return null;
  let chess;
  try {
    chess = new Chess(fenWithoutTarget);
  } catch {
    return null;
  }
  // Ensure side-to-move is not in check (FEN built fresh — should be fine).
  if (chess.inCheck()) return null;

  // Get all legal moves from the attacker square.
  const attackerMoves = chess.moves({ square: attacker, verbose: true });
  if (attackerMoves.length === 0) return null;

  // Try a target square: pick one of the attacker's destination squares
  // and place the target piece there. Then re-parse the FEN, validate,
  // and confirm the capture is the kid-puzzle answer.
  const candidateDests = attackerMoves
    .map(m => m.to)
    .filter(sq => sq !== wk && sq !== bk);
  if (candidateDests.length === 0) return null;
  const dest = candidateDests[Math.floor(rand() * candidateDests.length)];

  const withTarget = [...pieces, { square: dest, color: 'b', type: targetType }];
  const fen = buildBoard(withTarget);
  if (!fen) return null;

  let chess2;
  try {
    chess2 = new Chess(fen);
  } catch {
    return null;
  }
  if (chess2.inCheck()) return null;
  if (chess2.isGameOver()) return null;

  // Validate the capture exists and is the right piece.
  const captureMoves = chess2
    .moves({ square: attacker, verbose: true })
    .filter(m => m.captured === targetType && m.to === dest);
  if (captureMoves.length === 0) return null;
  const captureMove = captureMoves[0];
  if (captureMove.piece !== piece.toLowerCase()) return null;

  // Confirm the destination is UNDEFENDED — no black piece attacks
  // `dest` other than the target itself sitting on it. We probe by
  // letting chess.js list moves for black and checking if any moves
  // to `dest` exist (treating black's view).
  // Trick: build a hypothetical position where the attacker has been
  // removed — then ask black's moves. If anything attacks `dest`, it's
  // a defended capture (a trade), not "free".
  const piecesMinusAttacker = withTarget.filter(p => p.square !== attacker);
  const probeFen = buildBoard(piecesMinusAttacker)?.replace(' w ', ' b ');
  if (!probeFen) return null;
  let probe;
  try {
    probe = new Chess(probeFen);
  } catch {
    return null;
  }
  const blackMoves = probe.moves({ verbose: true });
  const defenders = blackMoves.filter(m => m.to === dest);
  if (defenders.length > 0) return null;

  // Finally: ensure the kid's attacker is itself reasonably safe after
  // capturing (no black recapture available). chess.js move() returns
  // a parsed move; play it and check black's responses to `dest`.
  const chess3 = new Chess(fen);
  chess3.move(captureMove.san);
  const blackResponses = chess3.moves({ verbose: true });
  const recaptureExists = blackResponses.some(m => m.to === dest);
  if (recaptureExists) return null;

  return {
    fen,
    captureMove,
  };
}

function tryGeneratePawnCapture(rand) {
  // Pawn template — pawns capture diagonally, but on an empty board their
  // legal moves are forward pushes (no captures), so the
  // tryGenerateCapturePosition path that probes attackerMoves first
  // finds no candidate destinations. Generate the pawn + target pair
  // directly: place pawn on rank 2-6, target on diagonal-forward square.
  const pawnFileIdx = randInRange(rand, 0, 7);
  // Pawn on rank 2-6 — keeps the capture target on rank 3-7 (no promotion).
  const pawnRankIdx = randInRange(rand, 1, 5);
  const pawnSquare = square(pawnFileIdx, pawnRankIdx);

  // Pick diagonal direction.
  const dir = rand() < 0.5 ? -1 : 1;
  const captureFileIdx = pawnFileIdx + dir;
  const captureRankIdx = pawnRankIdx + 1;
  if (captureFileIdx < 0 || captureFileIdx > 7) return null;
  const dest = square(captureFileIdx, captureRankIdx);

  // Kings — both well clear of the pawn + capture square.
  let wk = randSquare(rand);
  let tries = 0;
  while ((wk === pawnSquare || wk === dest || chebyshev(wk, pawnSquare) < 2)
    && tries++ < 40) wk = randSquare(rand);
  if (wk === pawnSquare || wk === dest) return null;

  let bk = randSquare(rand);
  tries = 0;
  while ((bk === pawnSquare || bk === dest || bk === wk
    || chebyshev(bk, wk) < 2 || chebyshev(bk, dest) < 2)
    && tries++ < 40) bk = randSquare(rand);
  if (chebyshev(bk, wk) < 2 || chebyshev(bk, dest) < 2) return null;

  // Pick a black target — anything but a king.
  const targetTypes = ['q', 'r', 'b', 'n', 'p'];
  const targetType = targetTypes[Math.floor(rand() * targetTypes.length)];

  const pieces = [
    { square: wk, color: 'w', type: 'k' },
    { square: bk, color: 'b', type: 'k' },
    { square: pawnSquare, color: 'w', type: 'p' },
    { square: dest, color: 'b', type: targetType },
  ];
  const fen = buildBoard(pieces);
  if (!fen) return null;
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (chess.inCheck() || chess.isGameOver()) return null;

  // Confirm the pawn capture exists.
  const pawnMoves = chess.moves({ square: pawnSquare, verbose: true });
  const cap = pawnMoves.find(m => m.to === dest && m.captured === targetType);
  if (!cap) return null;

  // Confirm dest is undefended by any other black piece (no recapture).
  const piecesMinusPawn = pieces.filter(p => p.square !== pawnSquare);
  const probeFen = buildBoard(piecesMinusPawn)?.replace(' w ', ' b ');
  if (!probeFen) return null;
  let probe;
  try {
    probe = new Chess(probeFen);
  } catch {
    return null;
  }
  const defenders = probe.moves({ verbose: true }).filter(m => m.to === dest);
  if (defenders.length > 0) return null;

  // Ensure black has no recapture after the pawn takes (game state may
  // still afford another piece's defense via discovered ray).
  const after = new Chess(fen);
  after.move(cap.san);
  const recapture = after.moves({ verbose: true }).some(m => m.to === dest);
  if (recapture) return null;

  return { fen, captureMove: cap };
}

function tryGenerateKingCapture(rand) {
  // K-piece template: white king captures an adjacent undefended black piece.
  // Place WK in a safe-ish square (not edge of board for simplicity).
  const wk = square(randInRange(rand, 1, 6), randInRange(rand, 1, 6));
  // Place target adjacent to WK.
  const targetTypes = ['q', 'r', 'b', 'n', 'p'];
  const targetType = targetTypes[Math.floor(rand() * targetTypes.length)];
  // Pick adjacent square.
  const dx = randInRange(rand, -1, 1);
  const dy = randInRange(rand, -1, 1);
  if (dx === 0 && dy === 0) return null;
  const f = FILES.indexOf(wk[0]) + dx;
  const r = RANKS.indexOf(wk[1]) + dy;
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  const dest = square(f, r);

  // BK far away so it doesn't defend.
  let bk = randSquare(rand);
  let tries = 0;
  while ((bk === wk || bk === dest || chebyshev(bk, wk) < 3 || chebyshev(bk, dest) < 2)
    && tries++ < 40) {
    bk = randSquare(rand);
  }
  if (chebyshev(bk, wk) < 3 || chebyshev(bk, dest) < 2) return null;

  const pieces = [
    { square: wk, color: 'w', type: 'k' },
    { square: bk, color: 'b', type: 'k' },
    { square: dest, color: 'b', type: targetType },
  ];
  const fen = buildBoard(pieces);
  if (!fen) return null;
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (chess.inCheck() || chess.isGameOver()) return null;
  const kingMoves = chess.moves({ square: wk, verbose: true });
  const cap = kingMoves.find(m => m.to === dest && m.captured === targetType);
  if (!cap) return null;
  return { fen, captureMove: cap };
}

// ─── Driver ────────────────────────────────────────────────────────────

const PER_PIECE_COUNT = 50;
const MAX_TRIES_PER_PUZZLE = 200;

function generateForPiece(piece, seed) {
  const rand = mulberry32(seed);
  const puzzles = [];
  let totalTries = 0;
  while (puzzles.length < PER_PIECE_COUNT && totalTries < PER_PIECE_COUNT * MAX_TRIES_PER_PUZZLE) {
    totalTries += 1;
    let generated;
    if (piece === 'K') {
      generated = tryGenerateKingCapture(rand);
    } else if (piece === 'P') {
      generated = tryGeneratePawnCapture(rand);
    } else {
      generated = tryGenerateCapturePosition(piece, rand);
    }
    if (!generated) continue;
    const { fen, captureMove } = generated;
    const [loRating, hiRating] = RATING_BAND[piece];
    const rating = randInRange(rand, loRating, hiRating);
    const id = `training-${piece}-${puzzles.length + 1}`;
    const uci = `${captureMove.from}${captureMove.to}${captureMove.promotion ?? ''}`;
    puzzles.push({
      id,
      fen,
      moves: uci,
      rating,
      themes: TRAINING_THEMES,
      openingTags: null,
      popularity: 100,
      nbPlays: 0,
      movingPiece: piece,
      source: 'training',
      // SRS fields default — match shape of Lichess puzzles in the same array.
      srsInterval: 0,
      srsEaseFactor: 2.5,
      srsRepetitions: 0,
      srsDueDate: '1970-01-01T00:00:00.000Z',
      srsLastReview: null,
      userRating: rating,
      attempts: 0,
      successes: 0,
    });
  }
  return puzzles;
}

const PIECE_SEEDS = { K: 1001, Q: 1002, R: 1003, B: 1004, N: 1005, P: 1006 };

function main() {
  const all = [];
  for (const piece of ['K', 'Q', 'R', 'B', 'N', 'P']) {
    const seed = PIECE_SEEDS[piece];
    const puzzles = generateForPiece(piece, seed);
    console.log(`[gen] ${piece}: ${puzzles.length} puzzles (seed=${seed})`);
    all.push(...puzzles);
  }
  writeFileSync(OUT_PATH, JSON.stringify(all, null, 2) + '\n');
  console.log(`[gen] total: ${all.length} puzzles → ${OUT_PATH}`);
  // Distribution sanity print.
  const byPiece = {};
  for (const p of all) byPiece[p.movingPiece] = (byPiece[p.movingPiece] ?? 0) + 1;
  console.log(`[gen] by piece:`, byPiece);
  const ratings = all.map(p => p.rating);
  ratings.sort((a, b) => a - b);
  console.log(`[gen] rating range: ${ratings[0]} – ${ratings[ratings.length - 1]}`);
}

main();
