#!/usr/bin/env node
/**
 * audit-one-opening.mjs — deep per-entry analysis for one opening,
 * falling through to live Lichess Explorer when the local enriched
 * DB runs out of coverage.
 *
 * Drives the per-line cleanup pass: for one opening (e.g. pirc-defence),
 * walks every authored PGN (main + variations + traps + warnings)
 * ply-by-ply against the enriched DB; for any position past local
 * coverage, hits Lichess Explorer masters live. Reports the TRUE
 * first-divergence ply (or "fully master-validated") per entry,
 * with master alternatives at the divergence and the prose
 * explanation alongside so I can decide outcome (KEEP / KEEP+RARITY /
 * REPAIR / TRUNCATE / DELETE / DEMOTE).
 *
 * USAGE:
 *   node scripts/audit-one-opening.mjs pirc-defence
 *   node scripts/audit-one-opening.mjs pirc-defence --file=repertoire.json
 */
import { readFile } from 'node:fs/promises';
import { Chess } from 'chess.js';

const TOKEN = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
if (!TOKEN) {
  console.error('LICHESS_API_KEY env var required (see project memory for value)');
  process.exit(1);
}
const TRAP_MIN = 5;
const OTHER_MIN = 1;

const openingId = process.argv[2];
if (!openingId) {
  console.error('usage: node scripts/audit-one-opening.mjs <openingId> [--file=repertoire.json]');
  process.exit(1);
}
const fileArg = process.argv.find((a) => a.startsWith('--file='))?.split('=')[1];

const liveCache = new Map();
let lastFetch = 0;
async function liveExplorer(fen) {
  if (liveCache.has(fen)) return liveCache.get(fen);
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
  if (!resp.ok) {
    liveCache.set(fen, null);
    return null;
  }
  const data = await resp.json();
  const moves = (data.moves || []).map((m) => ({
    san: m.san,
    games: m.white + m.black + m.draws,
    rating: m.averageRating ?? null,
  }));
  liveCache.set(fen, moves);
  return moves;
}

function posFen(f) {
  return f.split(' ').slice(0, 4).join(' ');
}

const db = JSON.parse(await readFile('src/data/openings-lichess-extended.json', 'utf8'));
const positions = db.positions ?? {};
console.log('[audit-one] DB:', Object.keys(positions).length, 'positions');

// Load the opening's source data
async function loadEntries() {
  const entries = [];
  const candidates = fileArg
    ? [fileArg]
    : ['repertoire.json', 'pro-repertoires.json', 'gambits.json'];
  for (const file of candidates) {
    const raw = JSON.parse(await readFile(`src/data/${file}`, 'utf8'));
    const arr = file === 'pro-repertoires.json' ? raw.openings : raw;
    const o = arr.find((x) => (x.id ?? x.openingId) === openingId);
    if (!o) continue;
    entries.push({ source: file, opening: o });
    return { source: file, opening: o };
  }
  return null;
}

const found = await loadEntries();
if (!found) {
  console.error(`Opening "${openingId}" not found in any source file.`);
  process.exit(1);
}
const { source, opening } = found;
console.log('[audit-one] source:', source);
console.log('[audit-one] opening:', opening.name, '— student plays', opening.color);
console.log();

const studentChar = opening.color === 'white' ? 'w' : 'b';

async function auditEntry(role, name, pgn, explanation) {
  const threshold = (role === 'trap' || role === 'warning') ? TRAP_MIN : OTHER_MIN;
  const moves = pgn.split(' ').filter(Boolean);
  const chess = new Chess();
  let validatedPly = 0;
  let firstDivergence = null;
  let usedLichess = 0;

  for (let k = 0; k < moves.length; k++) {
    const fen = posFen(chess.fen());
    let cands = positions[fen];
    if (!cands) {
      cands = await liveExplorer(fen);
      usedLichess++;
    }
    const move = moves[k];
    if (!cands || cands.length === 0) {
      firstDivergence = {
        ply: k + 1,
        move,
        reason: 'POSITION_HAS_NO_MASTER_GAMES',
        alternatives: [],
      };
      break;
    }
    const match = cands.find((c) => c.san === move);
    if (!match) {
      firstDivergence = {
        ply: k + 1,
        move,
        reason: 'MOVE_NOT_IN_MASTERS',
        alternatives: cands.slice(0, 5).map((c) => `${c.san}(${c.games}g)`),
      };
      break;
    }
    if (match.games < threshold) {
      firstDivergence = {
        ply: k + 1,
        move,
        reason: `BELOW_THRESHOLD(${match.games}g need≥${threshold})`,
        alternatives: cands.slice(0, 5).filter((c) => c.games >= threshold).map((c) => `${c.san}(${c.games}g)`),
      };
      break;
    }
    validatedPly = k + 1;
    try {
      chess.move(move);
    } catch (err) {
      firstDivergence = { ply: k + 1, move, reason: 'CHESS_JS_ERROR: ' + (err?.message ?? err) };
      break;
    }
  }

  // Probe extension potential — what masters play AFTER the validated prefix
  let extensionCandidates = null;
  if (!firstDivergence) {
    const fen = posFen(chess.fen());
    let cands = positions[fen];
    if (!cands) {
      cands = await liveExplorer(fen);
      usedLichess++;
    }
    if (cands && cands.length > 0) {
      extensionCandidates = cands.slice(0, 5).map((c) => `${c.san}(${c.games}g)`);
    }
  }

  return {
    role,
    name,
    pgn,
    explanation,
    validatedPly,
    totalPly: moves.length,
    firstDivergence,
    extensionCandidates,
    usedLichess,
    finalFen: chess.fen(),
  };
}

// Collect entries
const list = [];
list.push({ role: 'main', name: opening.name, pgn: opening.pgn, explanation: opening.overview });
for (const v of opening.variations ?? []) list.push({ role: 'variation', name: v.name, pgn: v.pgn, explanation: v.explanation });
for (const t of opening.trapLines ?? []) list.push({ role: 'trap', name: t.name, pgn: t.pgn, explanation: t.explanation });
for (const w of opening.warningLines ?? []) list.push({ role: 'warning', name: w.name, pgn: w.pgn, explanation: w.explanation });

console.log('[audit-one] auditing', list.length, 'entries (live Lichess fallback enabled)\n');

const results = [];
for (const e of list) {
  const r = await auditEntry(e.role, e.name, e.pgn, e.explanation);
  results.push(r);
}

// Report
console.log('═══════════════════════════════════════════════════════');
console.log('AUDIT REPORT — ' + opening.name + ' (' + openingId + ')');
console.log('═══════════════════════════════════════════════════════\n');
for (const r of results) {
  console.log('━━━ [' + r.role + '] ' + r.name);
  console.log('  prose: ' + (r.explanation?.slice(0, 200) ?? '(none)') + (r.explanation?.length > 200 ? '…' : ''));
  if (r.firstDivergence) {
    console.log(`  ❌ DIVERGENCE at ply ${r.firstDivergence.ply}: "${r.firstDivergence.move}"`);
    console.log(`     reason: ${r.firstDivergence.reason}`);
    if (r.firstDivergence.alternatives?.length) {
      console.log(`     masters played: ${r.firstDivergence.alternatives.join(', ')}`);
    }
    console.log(`     validated prefix: ${r.validatedPly}/${r.totalPly} plies`);
    const action = r.validatedPly < 6 ? 'DELETE (prefix <6 plies)'
                 : r.firstDivergence.reason === 'BELOW_THRESHOLD' ? 'TRUNCATE or KEEP_WITH_RARITY_NOTE'
                 : 'REPAIR (splice master moves) or TRUNCATE';
    console.log(`     proposed: ${action}`);
  } else {
    console.log(`  ✓ FULLY VALIDATED ${r.validatedPly}/${r.totalPly} plies`);
    if (r.extensionCandidates?.length) {
      console.log(`     CAN EXTEND via: ${r.extensionCandidates.join(', ')}`);
    }
  }
  console.log(`  pgn: ${r.pgn}`);
  console.log();
}

console.log('━━━ Summary ━━━');
console.log(`  total: ${results.length}`);
console.log(`  fully validated: ${results.filter((r) => !r.firstDivergence).length}`);
console.log(`  flagged: ${results.filter((r) => r.firstDivergence).length}`);
console.log(`  live Lichess calls: ${results.reduce((s, r) => s + r.usedLichess, 0)}`);
