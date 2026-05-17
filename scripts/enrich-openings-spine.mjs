#!/usr/bin/env node
/**
 * enrich-openings-spine.mjs — companion to enrich-openings-db.mjs.
 *
 * The main enrichment script seeds BFS from each named opening's
 * TERMINAL position and walks +10 plies forward. That leaves a gap:
 * the spine positions BEFORE each opening's terminus (including the
 * standard chess starting position) are never queried. The audit
 * smoke test on 2026-05-16 surfaced this — every authored PGN
 * flagged at ply 1 because the starting FEN wasn't in the enriched DB.
 *
 * This script fills the gap. For every named opening in
 * openings-lichess.json:
 *   1. Replay its PGN through chess.js.
 *   2. At every intermediate ply (including ply 0 = starting position),
 *      record the position FEN.
 *   3. Dedupe across openings (heavy transposition overlap).
 *   4. Query Lichess Explorer masters for each unique position.
 *   5. Output to a separate file; merge with the main enrichment via
 *      merge-enriched-dbs.mjs.
 *
 * No BFS expansion here — just spine coverage. The main script
 * already handles +10-ply extension past each terminus.
 *
 * USAGE:
 *   node scripts/enrich-openings-spine.mjs
 *   LICHESS_DIRECT=1 LICHESS_API_KEY=... node scripts/enrich-openings-spine.mjs
 *
 * Output: src/data/openings-lichess-spine.json (intermediate; merge
 * with main output via merge-enriched-dbs.mjs).
 */
import { Chess } from 'chess.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const USE_DIRECT = process.env.LICHESS_DIRECT === '1';
const EXPLORER_BASE = USE_DIRECT
  ? 'https://explorer.lichess.ovh/masters'
  : 'https://chess-academy-pro.vercel.app/api/lichess-explorer?source=masters';

const ANON_THROTTLE_MS = 1100;
const AUTH_THROTTLE_MS = 250;
const token = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
const throttleMs = token ? AUTH_THROTTLE_MS : ANON_THROTTLE_MS;

const PROGRESS_SAVE_INTERVAL = 100;
const OUTPUT_PATH = 'src/data/openings-lichess-spine.json';
const PARTIAL_PATH = 'audit-reports/.enrich-spine-partial.json';

function positionFen(fullFen) {
  return fullFen.split(' ').slice(0, 4).join(' ');
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

async function main() {
  console.log(`[spine] auth: ${token ? 'YES (' + throttleMs + 'ms throttle)' : 'NO (anon, ' + throttleMs + 'ms throttle)'}`);
  await mkdir('audit-reports', { recursive: true });

  const raw = JSON.parse(await readFile('src/data/openings-lichess.json', 'utf8'));
  const openings = Array.isArray(raw) ? raw : Object.values(raw);
  console.log(`[spine] loaded ${openings.length} named openings`);

  // Collect every prefix FEN across every opening (including starting position).
  const STARTING_FEN = positionFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const seedFens = new Set([STARTING_FEN]);
  for (const o of openings) {
    if (!o.pgn) continue;
    const moves = o.pgn.split(' ').filter(Boolean);
    const chess = new Chess();
    seedFens.add(positionFen(chess.fen())); // starting position
    for (const san of moves) {
      try {
        chess.move(san);
      } catch {
        break;
      }
      seedFens.add(positionFen(chess.fen()));
    }
  }
  console.log(`[spine] ${seedFens.size} unique spine positions to query (heavy transposition dedup)`);

  const positions = {};
  let processed = 0;
  const startTime = Date.now();

  for (const posFen of seedFens) {
    processed++;
    let result;
    try {
      result = await explorerQuery(posFen);
    } catch (err) {
      console.error(`  [error] FEN ${posFen.slice(0, 40)}…: ${err.message}`);
      continue;
    }
    const moves = (result.moves ?? []).filter((m) => (m.white + m.black + m.draws) >= 1);
    if (moves.length === 0) continue;
    positions[posFen] = moves.map((m) => ({
      san: m.san,
      games: m.white + m.black + m.draws,
      rating: m.averageRating ?? null,
    }));

    if (processed % 25 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = seedFens.size - processed;
      const etaSec = remaining / rate;
      console.log(
        `  [progress] processed=${processed}/${seedFens.size} positions=${Object.keys(positions).length} | ${rate.toFixed(1)}/s | ETA ${(etaSec / 60).toFixed(1)}min`,
      );
    }

    if (processed % PROGRESS_SAVE_INTERVAL === 0) {
      await writeFile(PARTIAL_PATH, JSON.stringify({ positions }, null, 2));
    }
  }

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    kind: 'spine',
    sourceDb: 'src/data/openings-lichess.json',
    sourceUri: 'https://explorer.lichess.ovh/masters',
    stats: {
      seedOpenings: openings.length,
      uniqueSpineFens: seedFens.size,
      indexedPositions: Object.keys(positions).length,
      totalMovesIndexed: Object.values(positions).reduce((s, v) => s + v.length, 0),
    },
    positions,
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n');
  const size = (await readFile(OUTPUT_PATH)).length;
  const elapsed = (Date.now() - startTime) / 1000;
  console.log('\n═══ Spine pass done ═════════════════════════════════════');
  console.log(`Unique spine FENs:   ${seedFens.size}`);
  console.log(`Indexed positions:   ${Object.keys(positions).length}`);
  console.log(`Output:              ${OUTPUT_PATH}`);
  console.log(`Size:                ${(size / 1024).toFixed(1)} KB`);
  console.log(`Elapsed:             ${(elapsed / 60).toFixed(1)} min`);
  console.log('\nNext step: merge with main enrichment via merge-enriched-dbs.mjs');
}

main().catch((err) => {
  console.error('[spine] fatal:', err);
  process.exit(1);
});
