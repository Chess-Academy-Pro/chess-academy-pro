#!/usr/bin/env node
/**
 * build-replacement-line.mjs — given an original PGN, a truncation
 * ply, and a target depth, produce a new PGN by keeping the original
 * prefix [0..truncateAtPly] and extending with master-played moves
 * from there.
 *
 * Used during the per-line cleanup pass to construct REPAIR /
 * TRUNCATE+EXTEND results.
 *
 * USAGE:
 *   node scripts/build-replacement-line.mjs \
 *     --pgn "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 O-O c5" \
 *     --target 24 \
 *     --role variation
 *
 * The truncation point is just the END of the --pgn input. To repair
 * a fabricated suffix, pass --pgn as the validated prefix only.
 *
 * --target = max plies in the output (caps extension); pass Infinity
 *   for no cap (main pgns).
 * --role = trap|warning|main|variation — sets the master-game
 *   threshold per CLAUDE.md (trap=5+, others=1+).
 */
import { Chess } from 'chess.js';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : null;
}
const pgn = arg('pgn') ?? '';
const target = Number(arg('target') ?? '20');
const role = arg('role') ?? 'variation';
if (!pgn) {
  console.error('--pgn required');
  process.exit(1);
}
const TRAP_MIN = 5;
const OTHER_MIN = 1;
const threshold = (role === 'trap' || role === 'warning') ? TRAP_MIN : OTHER_MIN;

const TOKEN = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
if (!TOKEN) {
  console.error('LICHESS_API_KEY env var required (see project memory for value)');
  process.exit(1);
}

let lastFetch = 0;
async function explorer(fen) {
  const wait = 250 - (Date.now() - lastFetch);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const url = 'https://explorer.lichess.ovh/masters?topGames=0&moves=12&fen=' + encodeURIComponent(fen);
  const resp = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/json',
      'User-Agent': 'ChessAcademyPro-audit (dyahnke@gmail.com)',
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data.moves || []).map((m) => ({ san: m.san, games: m.white + m.black + m.draws, rating: m.averageRating ?? null }));
}

function posFen(f) { return f.split(' ').slice(0, 4).join(' '); }

// Load local DB for free hits
const db = JSON.parse(await readFile('src/data/openings-lichess-extended.json', 'utf8'));
const positions = db.positions ?? {};

const chess = new Chess();
const moves = pgn.split(' ').filter(Boolean);
for (const m of moves) chess.move(m);

const result = [...moves];
let live = 0;
while (result.length < target) {
  const fen = posFen(chess.fen());
  let cands = positions[fen];
  if (!cands) {
    cands = await explorer(fen);
    live++;
  }
  if (!cands || cands.length === 0) {
    console.log(`# stopped at ply ${result.length}: no master games from this position`);
    break;
  }
  const eligible = cands.filter((c) => c.games >= threshold);
  if (eligible.length === 0) {
    console.log(`# stopped at ply ${result.length}: no move meets threshold (need ≥${threshold} games); cands: ${cands.slice(0, 3).map((c) => `${c.san}(${c.games}g)`).join(', ')}`);
    break;
  }
  // Top by games; tie-break by higher rating
  eligible.sort((a, b) => (b.games - a.games) || ((b.rating ?? 0) - (a.rating ?? 0)));
  const top = eligible[0];
  try {
    chess.move(top.san);
  } catch {
    console.log(`# stopped at ply ${result.length}: chess.js refused "${top.san}"`);
    break;
  }
  result.push(top.san);
}
console.log('# live Lichess calls:', live);
console.log('# new PGN length:', result.length);
console.log();
console.log(result.join(' '));
