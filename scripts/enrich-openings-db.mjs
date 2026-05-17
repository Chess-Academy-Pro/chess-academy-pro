#!/usr/bin/env node
/**
 * enrich-openings-db.mjs — offline pipeline that populates
 * src/data/openings-lichess-extended.json with master-game-validated
 * continuations past each named opening's terminus.
 *
 * Architecture (David's decision 2026-05-16):
 * - Openings tab is offline / API-free at runtime.
 * - This script runs ONCE (or periodically) at build time, talks to
 *   Lichess Explorer's `masters` source, and bakes the result into
 *   a local JSON the app bundles.
 * - Audit + walkthroughs read the bundled JSON; no runtime API.
 *
 * Strategy:
 *   1. Load openings-lichess.json (3,641 named openings).
 *   2. For each opening, compute its terminal FEN by replaying its PGN.
 *   3. BFS expand each terminal FEN up to MAX_EXTENSION_PLY plies,
 *      keeping only moves played in >= MIN_MASTER_GAMES master games.
 *   4. Output: { positions: { [fen]: [{ san, games }] } } keyed by
 *      position-only FEN (no halfmove/fullmove for dedupe).
 *
 * USAGE:
 *   node scripts/enrich-openings-db.mjs                  # full run
 *   node scripts/enrich-openings-db.mjs --slice=italian  # one slice
 *   node scripts/enrich-openings-db.mjs --slice=italian,pirc,london  # multiple
 *   node scripts/enrich-openings-db.mjs --dry-run        # estimate size only
 *   LICHESS_API_KEY=xxx node scripts/enrich-openings-db.mjs  # auth'd, higher rate
 *
 * RATE LIMITS:
 *   Anonymous: ~1 req/sec (we self-throttle to 1100ms between calls)
 *   Authenticated: ~5 req/sec (we throttle to 250ms)
 *   Hitting 429 → exponential backoff, retry once.
 */
import { Chess } from 'chess.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Route through our prod Edge proxy by default — it has LICHESS_API_KEY
// in env vars so 401s on anonymous Explorer calls are handled upstream.
// Override with LICHESS_DIRECT=1 to hit explorer.lichess.ovh directly
// (only useful if you have a personal API key locally).
const USE_DIRECT = process.env.LICHESS_DIRECT === '1';
const EXPLORER_BASE = USE_DIRECT
  ? 'https://explorer.lichess.ovh/masters'
  : 'https://chess-academy-pro.vercel.app/api/lichess-explorer?source=masters';
const MAX_EXTENSION_PLY = 10;        // plies past each named opening
const MIN_MASTER_GAMES = 1;          // keep any move played in ≥1 master game
const ANON_THROTTLE_MS = 1100;       // 1 req/s budget
const AUTH_THROTTLE_MS = 250;        // 4 req/s budget when authed
const PROGRESS_SAVE_INTERVAL = 100;  // save partial output every N positions
const OUTPUT_PATH = 'src/data/openings-lichess-extended.json';

const args = new Set(process.argv.slice(2));
const sliceArg = process.argv.find((a) => a.startsWith('--slice='))?.slice(8);
const requestedSlices = sliceArg ? sliceArg.split(',').map((s) => s.trim().toLowerCase()) : null;
const dryRun = args.has('--dry-run');
const token = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
const throttleMs = token ? AUTH_THROTTLE_MS : ANON_THROTTLE_MS;

/** Convert full FEN to position-only FEN (drop halfmove + fullmove counts) for dedupe.
 *  Two PGNs that reach the same board state via different move orders
 *  share a position-only FEN even though their full FENs differ. */
function positionFen(fullFen) {
  const parts = fullFen.split(' ');
  // [board, sideToMove, castling, enPassant, halfmoveClock, fullmoveNumber]
  return parts.slice(0, 4).join(' ');
}

let lastFetch = 0;
async function explorerQuery(fen) {
  const wait = throttleMs - (Date.now() - lastFetch);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const url = `${EXPLORER_BASE}${EXPLORER_BASE.includes('?') ? '&' : '?'}fen=${encodeURIComponent(fen)}&topGames=0&moves=12`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let attempt = 0;
  for (;;) {
    attempt++;
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (resp.status === 429) {
      const backoff = Math.min(60_000, 2_000 * Math.pow(2, attempt));
      console.warn(`  [rate limit] 429 — backing off ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      if (attempt >= 5) throw new Error('429 after 5 retries');
      continue;
    }
    if (!resp.ok) {
      throw new Error(`Explorer ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    }
    return resp.json();
  }
}

async function loadOpenings() {
  const raw = JSON.parse(await readFile('src/data/openings-lichess.json', 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}

/** Filter openings to slice by ECO/name keyword. */
function selectOpenings(all, slices) {
  if (!slices) return all;
  const lowerSlices = slices.map((s) => s.toLowerCase());
  return all.filter((o) => {
    const n = (o.name || '').toLowerCase();
    return lowerSlices.some((s) => n.includes(s));
  });
}

async function main() {
  console.log(`[enrich] auth: ${token ? 'YES (' + throttleMs + 'ms throttle)' : 'NO (anon, ' + throttleMs + 'ms throttle)'}`);
  if (!token) console.log('[enrich] hint: export LICHESS_API_KEY=... for 4x faster runs');

  const allOpenings = await loadOpenings();
  const openings = selectOpenings(allOpenings, requestedSlices);
  console.log(`[enrich] selected ${openings.length} of ${allOpenings.length} openings`);
  if (requestedSlices) console.log(`[enrich] slice keywords: ${requestedSlices.join(', ')}`);
  console.log(`[enrich] max extension ply: ${MAX_EXTENSION_PLY}`);
  console.log(`[enrich] min master games per move: ${MIN_MASTER_GAMES}\n`);

  // Build queue of unique terminal FENs to expand from.
  const seedFens = new Map(); // posFen → { sourceOpening, depth }
  for (const o of openings) {
    if (!o.pgn) continue;
    const c = new Chess();
    try {
      c.loadPgn(o.pgn);
    } catch {
      continue;
    }
    const posFen = positionFen(c.fen());
    if (!seedFens.has(posFen)) {
      seedFens.set(posFen, { sourceOpening: o.name, sourcePgn: o.pgn });
    }
  }
  console.log(`[enrich] ${seedFens.size} unique seed FENs (deduped from ${openings.length} openings)`);

  if (dryRun) {
    console.log(`[enrich] DRY RUN — would query Explorer ~${seedFens.size}+ times (depends on branching)`);
    console.log(`[enrich] anon estimate: ${(seedFens.size * 1.1).toFixed(0)}s minimum (no extension yet)`);
    console.log('[enrich] exiting before any Explorer calls');
    return;
  }

  // BFS expansion. queue: array of [posFen, plyRemaining]
  const positions = {}; // posFen → [{ san, games }]
  const visited = new Set();
  const queue = [];
  for (const [posFen, _] of seedFens) {
    queue.push([posFen, MAX_EXTENSION_PLY]);
  }

  let processed = 0;
  let queueMaxObservedSize = queue.length;
  const startTime = Date.now();

  while (queue.length > 0) {
    const [posFen, plyRemaining] = queue.shift();
    if (visited.has(posFen)) continue;
    visited.add(posFen);
    processed++;
    if (queue.length > queueMaxObservedSize) queueMaxObservedSize = queue.length;

    // Reconstruct a chess.js instance at this position to compute children.
    // Lichess Explorer accepts FEN directly; we just need a working board
    // for applying the candidate moves to derive each child's FEN.
    let board;
    try {
      board = new Chess(posFen + ' 0 1'); // need to pad for chess.js to accept
    } catch {
      // some FENs may be invalid (en passant + castling weirdness); skip
      console.warn(`  [skip] invalid FEN: ${posFen}`);
      continue;
    }

    let result;
    try {
      result = await explorerQuery(posFen);
    } catch (err) {
      console.error(`  [error] FEN ${posFen.slice(0, 40)}…: ${err.message}`);
      continue;
    }

    const moves = (result.moves ?? []).filter(
      (m) => (m.white + m.black + m.draws) >= MIN_MASTER_GAMES,
    );
    if (moves.length === 0) continue;

    positions[posFen] = moves.map((m) => ({
      san: m.san,
      games: m.white + m.black + m.draws,
      rating: m.averageRating ?? null,
    }));

    if (plyRemaining > 0) {
      for (const m of moves) {
        // Apply move to derive child FEN
        const child = new Chess(board.fen());
        let moved;
        try {
          moved = child.move(m.san);
        } catch {
          continue;
        }
        if (!moved) continue;
        const childPos = positionFen(child.fen());
        if (!visited.has(childPos)) queue.push([childPos, plyRemaining - 1]);
      }
    }

    if (processed % 25 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = queue.length;
      const etaSec = remaining / rate;
      console.log(
        `  [progress] processed=${processed} positions=${Object.keys(positions).length} queue=${queue.length} (max ${queueMaxObservedSize}) | ${rate.toFixed(1)}/s | ETA ${(etaSec / 60).toFixed(1)}min`,
      );
    }

    if (processed % PROGRESS_SAVE_INTERVAL === 0) {
      await savePartial(positions);
    }
  }

  // Final save
  const sliceLabel = requestedSlices ? requestedSlices.join('+') : 'full';
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    slice: sliceLabel,
    sourceDb: 'src/data/openings-lichess.json',
    sourceUri: 'https://explorer.lichess.ovh/masters',
    policy: {
      maxExtensionPly: MAX_EXTENSION_PLY,
      minMasterGames: MIN_MASTER_GAMES,
      fenKey: 'position-only (board + sideToMove + castling + enPassant)',
    },
    stats: {
      seedOpenings: openings.length,
      seedFens: seedFens.size,
      uniquePositions: Object.keys(positions).length,
      totalMovesIndexed: Object.values(positions).reduce((s, v) => s + v.length, 0),
    },
    positions,
  };
  const outPath = requestedSlices
    ? OUTPUT_PATH.replace('.json', `-${sliceLabel}.json`)
    : OUTPUT_PATH;
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n');
  const fileSize = (await readFile(outPath)).length;
  const elapsed = (Date.now() - startTime) / 1000;

  console.log('\n═══ Done ═════════════════════════════════════════════════');
  console.log(`Seed openings:        ${openings.length}`);
  console.log(`Seed FENs (deduped):  ${seedFens.size}`);
  console.log(`Unique positions:     ${Object.keys(positions).length}`);
  console.log(`Total master moves:   ${out.stats.totalMovesIndexed}`);
  console.log(`Output file:          ${outPath}`);
  console.log(`File size:            ${(fileSize / 1024).toFixed(1)} KB (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Total elapsed:        ${(elapsed / 60).toFixed(1)} min`);
}

async function savePartial(positions) {
  await writeFile('audit-reports/.enrich-partial.json', JSON.stringify({ positions }, null, 2));
}

main().catch((err) => {
  console.error('[enrich] fatal:', err);
  process.exit(1);
});
