#!/usr/bin/env node
/**
 * extend-openings-from-lichess
 * ----------------------------
 *
 * Mines the Lichess Opening Explorer to deepen every entry in
 * `src/data/openings-lichess.json` to a target ply count, writing
 * the result to `src/data/openings-lichess-extended.json`.
 *
 * For each canonical entry whose PGN is shorter than TARGET_PLIES,
 * we:
 *   1. Replay the canonical PGN to get the leaf FEN
 *   2. Query the Lichess Explorer at that FEN for top-played moves
 *   3. Take the most-played move whose total games ≥ POPULARITY_FLOOR
 *   4. Append, advance the chess.js board, repeat until depth or floor
 *   5. Write the result back as `{ eco, name, pgn: extendedPgn }`
 *
 * Output shape matches the canonical file exactly, so the runtime
 * can simply concatenate both arrays — see openingDetectionService.
 *
 * Resumable: skips entries already present in the extended file, so
 * killing/restarting the script picks up where it left off. Writes
 * to disk after every BATCH_FLUSH_INTERVAL entries so a partial run
 * still produces useful output.
 *
 * Usage:
 *   node scripts/extend-openings-from-lichess.mjs
 *   node scripts/extend-openings-from-lichess.mjs --target=30
 *   node scripts/extend-openings-from-lichess.mjs --floor=500
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CANONICAL_PATH = path.join(ROOT, 'src/data/openings-lichess.json');
const EXTENDED_PATH = path.join(ROOT, 'src/data/openings-lichess-extended.json');

// ─── Tuning ──────────────────────────────────────────────────────
/** Stop extending an entry when its total ply count reaches this.
 *  User: "I want at least 15-20 moves in each line getting the user
 *  into the early middle game." 30 plies = 15 full moves; 40 plies =
 *  20. Default 36 lands inside that band. Override with --target=N. */
const DEFAULT_TARGET_PLIES = 36;

/** Stop walking when the most-popular continuation at a position has
 *  fewer than this many total games. Below this we're past the
 *  serious-theory cliff; the line drifts into noise. */
const DEFAULT_POPULARITY_FLOOR = 500;

/** Polite pause between Lichess Explorer requests (ms). Public API
 *  allows ~5 req/sec; we run at ~3 req/sec to leave headroom. */
const REQUEST_INTERVAL_MS = 350;

/** Persist progress after every N new extensions. Smaller = more
 *  resilient to interruption; larger = fewer disk syncs. */
const BATCH_FLUSH_INTERVAL = 10;

// ─── CLI args ────────────────────────────────────────────────────
function parseArg(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const v = Number.parseInt(arg.split('=')[1], 10);
  return Number.isFinite(v) ? v : fallback;
}
const TARGET_PLIES = parseArg('target', DEFAULT_TARGET_PLIES);
const POPULARITY_FLOOR = parseArg('floor', DEFAULT_POPULARITY_FLOOR);

// ─── Lichess Explorer client ─────────────────────────────────────
async function fetchExplorer(fen) {
  const url = new URL('https://explorer.lichess.ovh/lichess');
  url.searchParams.set('variant', 'standard');
  url.searchParams.set('fen', fen);
  url.searchParams.set('moves', '6');
  url.searchParams.set('speeds', 'rapid,classical');
  url.searchParams.set('ratings', '1800,2000,2200,2500');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'chess-academy-pro/extend-openings (single user app)' },
      });
      if (res.status === 429) {
        const wait = (attempt + 1) * 5000;
        console.warn(`  rate-limited; waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        console.warn(`  HTTP ${res.status} on ${fen.slice(0, 30)}…`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`  fetch failed (attempt ${attempt + 1}): ${err?.message}`);
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Mining loop ─────────────────────────────────────────────────
async function extendEntry(entry) {
  const moves = entry.pgn.split(/\s+/).filter(Boolean);
  const chess = new Chess();
  for (const m of moves) {
    try {
      chess.move(m);
    } catch {
      console.warn(`  skip ${entry.name}: illegal canonical move "${m}"`);
      return null;
    }
  }
  const extension = [];
  while (moves.length + extension.length < TARGET_PLIES) {
    await sleep(REQUEST_INTERVAL_MS);
    const resp = await fetchExplorer(chess.fen());
    if (!resp || !Array.isArray(resp.moves)) break;
    const sorted = resp.moves
      .map((m) => ({ ...m, total: (m.white ?? 0) + (m.draws ?? 0) + (m.black ?? 0) }))
      .sort((a, b) => b.total - a.total);
    const top = sorted[0];
    if (!top || top.total < POPULARITY_FLOOR) break;
    try {
      chess.move(top.san);
    } catch {
      // Lichess SAN didn't apply — corrupt response or chess.js
      // disagrees. Stop here rather than fabricate.
      break;
    }
    extension.push(top.san);
  }
  if (extension.length === 0) return null;
  return { eco: entry.eco, name: entry.name, pgn: [...moves, ...extension].join(' ') };
}

// ─── Main ─────────────────────────────────────────────────────────
function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`failed to read ${p}: ${err?.message}`);
    return fallback;
  }
}

function saveExtended(extended) {
  fs.writeFileSync(EXTENDED_PATH, JSON.stringify(extended, null, 2) + '\n');
}

async function main() {
  console.log(`target=${TARGET_PLIES} plies, floor=${POPULARITY_FLOOR} games`);
  const canonical = loadJson(CANONICAL_PATH, []);
  const extended = loadJson(EXTENDED_PATH, []);
  console.log(`canonical entries: ${canonical.length}`);
  console.log(`extended entries already on disk: ${extended.length}`);
  // Build a key index for resume-skip. Key by eco + name + canonical
  // length — if we've already extended this entry to ≥TARGET_PLIES,
  // skip it; if a previous run left it shorter than TARGET_PLIES we
  // can re-attempt it.
  const extendedByKey = new Map();
  for (const e of extended) {
    extendedByKey.set(`${e.eco}/${e.name}`, e);
  }

  // Sort canonical entries: shorter first (most extension benefit),
  // then by name for stable ordering.
  const work = canonical
    .filter((e) => {
      const plies = e.pgn.split(/\s+/).filter(Boolean).length;
      if (plies >= TARGET_PLIES) return false;  // already deep enough
      const existing = extendedByKey.get(`${e.eco}/${e.name}`);
      if (existing) {
        const exPlies = existing.pgn.split(/\s+/).filter(Boolean).length;
        if (exPlies >= TARGET_PLIES) return false;  // already extended
      }
      return true;
    })
    .sort((a, b) => a.pgn.length - b.pgn.length);

  console.log(`entries needing extension: ${work.length}`);
  let processed = 0;
  let extendedCount = 0;
  let lastFlush = 0;

  for (const entry of work) {
    processed += 1;
    const result = await extendEntry(entry);
    if (result) {
      extendedByKey.set(`${result.eco}/${result.name}`, result);
      extendedCount += 1;
      const newPlies = result.pgn.split(/\s+/).filter(Boolean).length;
      const oldPlies = entry.pgn.split(/\s+/).filter(Boolean).length;
      console.log(`[${processed}/${work.length}] ${entry.name}: ${oldPlies}→${newPlies} plies`);
    } else {
      console.log(`[${processed}/${work.length}] ${entry.name}: no extension found`);
    }
    if (extendedCount - lastFlush >= BATCH_FLUSH_INTERVAL) {
      saveExtended(Array.from(extendedByKey.values()));
      lastFlush = extendedCount;
      console.log(`  flushed ${extendedByKey.size} extended entries to disk`);
    }
  }

  saveExtended(Array.from(extendedByKey.values()));
  console.log(`done. ${extendedByKey.size} entries in ${EXTENDED_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
