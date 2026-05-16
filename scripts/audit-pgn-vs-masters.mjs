#!/usr/bin/env node
/**
 * audit-pgn-vs-masters.mjs — the real LLM-fabrication detector.
 *
 * Reads `src/data/openings-lichess-extended.json` (produced by
 * `enrich-openings-db.mjs`) and walks every authored PGN move-by-move:
 *
 *   1. At each position FEN, look up the enriched DB.
 *   2. Does the authored move appear in the master continuations?
 *   3. If yes (and game count >= role threshold), advance.
 *   4. If no, this is the first invented ply.
 *
 * Per-role thresholds (David's pick 2026-05-16):
 *   - main, variation: ≥1 master game required
 *   - trap, warning:   ≥5 master games (forced tactics need theoretical weight)
 *
 * The script doesn't change any data — it produces a structured
 * report that names every line + the exact ply where the LLM
 * started inventing. Phase N of the cleanup uses this report to
 * drive repairs.
 *
 * USAGE:
 *   node scripts/audit-pgn-vs-masters.mjs
 *   node scripts/audit-pgn-vs-masters.mjs --threshold-traps=10 --threshold-other=1
 */
import { Chess } from 'chess.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argTrap = args.find((a) => a.startsWith('--threshold-traps='));
const argOther = args.find((a) => a.startsWith('--threshold-other='));
const TRAP_MIN_GAMES = argTrap ? Number(argTrap.split('=')[1]) : 5;
const OTHER_MIN_GAMES = argOther ? Number(argOther.split('=')[1]) : 1;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/pgn-vs-masters-${stamp}`;

function positionFen(fullFen) {
  return fullFen.split(' ').slice(0, 4).join(' ');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let enriched;
  try {
    enriched = JSON.parse(await readFile('src/data/openings-lichess-extended.json', 'utf8'));
  } catch (err) {
    console.error('[audit-vs-masters] Could not read enriched DB at src/data/openings-lichess-extended.json');
    console.error('  Run `node scripts/enrich-openings-db.mjs` first.');
    process.exit(1);
  }
  const positions = enriched?.positions ?? {};
  if (Object.keys(positions).length === 0) {
    console.error('[audit-vs-masters] Enriched DB is empty. Run enrich-openings-db.mjs.');
    process.exit(1);
  }
  console.log(`[audit-vs-masters] enriched DB has ${Object.keys(positions).length} positions`);
  console.log(`[audit-vs-masters] thresholds: traps≥${TRAP_MIN_GAMES} games, others≥${OTHER_MIN_GAMES} games\n`);

  const sources = [
    { file: 'repertoire.json', shape: 'array' },
    { file: 'pro-repertoires.json', shape: 'object.openings' },
    { file: 'gambits.json', shape: 'array' },
    { file: 'model-games.json', shape: 'array', mainOnly: true },
  ];

  const entries = [];
  for (const { file, shape, mainOnly } of sources) {
    const raw = JSON.parse(await readFile(`src/data/${file}`, 'utf8'));
    const arr = shape === 'array' ? raw : raw.openings;
    for (const o of arr) {
      const openingId = o.id ?? o.openingId ?? o.name ?? '(no-id)';
      if (o.pgn) entries.push({ source: file, openingId, role: 'main', name: o.name ?? openingId, pgn: o.pgn, color: o.color });
      if (mainOnly) continue;
      for (const v of o.variations ?? []) {
        if (v.pgn) entries.push({ source: file, openingId, role: 'variation', name: v.name, pgn: v.pgn, color: o.color });
      }
      for (const t of o.trapLines ?? []) {
        if (t.pgn) entries.push({ source: file, openingId, role: 'trap', name: t.name, pgn: t.pgn, color: o.color });
      }
      for (const w of o.warningLines ?? []) {
        if (w.pgn) entries.push({ source: file, openingId, role: 'warning', name: w.name, pgn: w.pgn, color: o.color });
      }
    }
  }
  console.log(`[audit-vs-masters] auditing ${entries.length} PGNs across ${sources.length} files\n`);

  const results = [];
  for (const e of entries) {
    const threshold = (e.role === 'trap' || e.role === 'warning') ? TRAP_MIN_GAMES : OTHER_MIN_GAMES;
    const moves = e.pgn.split(' ').filter(Boolean);
    const chess = new Chess();
    let validatedPly = 0;
    let firstInvalidPly = null;
    let firstInvalidMove = null;
    let firstInvalidReason = null;
    let parseError = null;

    for (let k = 0; k < moves.length; k++) {
      const posFen = positionFen(chess.fen());
      const dbCandidates = positions[posFen];
      const authoredSan = moves[k];

      if (!dbCandidates) {
        // No coverage in enriched DB. Either we ran out of DB depth
        // or the position never appears in master play.
        firstInvalidPly = k + 1;
        firstInvalidMove = authoredSan;
        firstInvalidReason = 'POSITION_NOT_IN_ENRICHED_DB';
        break;
      }
      const match = dbCandidates.find((c) => c.san === authoredSan);
      if (!match) {
        firstInvalidPly = k + 1;
        firstInvalidMove = authoredSan;
        firstInvalidReason = 'MOVE_NOT_IN_MASTERS';
        break;
      }
      if (match.games < threshold) {
        firstInvalidPly = k + 1;
        firstInvalidMove = authoredSan;
        firstInvalidReason = `BELOW_THRESHOLD (${match.games} games, need ≥${threshold})`;
        break;
      }
      // Move is master-validated, advance the board.
      try {
        chess.move(authoredSan);
      } catch (err) {
        parseError = String(err?.message ?? err).slice(0, 100);
        firstInvalidPly = k + 1;
        firstInvalidMove = authoredSan;
        firstInvalidReason = `PARSE_ERROR: ${parseError}`;
        break;
      }
      validatedPly = k + 1;
    }

    const inventedSuffixLen = firstInvalidPly ? (moves.length - validatedPly) : 0;
    const fullyValidated = firstInvalidPly === null;

    // What master moves COULD have followed at the divergence point?
    let dbAlternatives = null;
    if (firstInvalidPly !== null && firstInvalidReason !== 'POSITION_NOT_IN_ENRICHED_DB') {
      const divergencePos = positionFen(chess.fen());
      const cands = positions[divergencePos] ?? [];
      dbAlternatives = cands
        .filter((c) => c.games >= threshold)
        .slice(0, 5)
        .map((c) => ({ san: c.san, games: c.games, rating: c.rating }));
    }

    results.push({
      source: e.source,
      openingId: e.openingId,
      role: e.role,
      name: e.name,
      pgn: e.pgn,
      pgnLength: moves.length,
      validatedPly,
      inventedSuffixLen,
      fullyValidated,
      firstInvalidPly,
      firstInvalidMove,
      firstInvalidReason,
      dbAlternatives,
      thresholdApplied: threshold,
    });
  }

  // ─── Summary ───────────────────────────────────────────────────
  const total = results.length;
  const clean = results.filter((r) => r.fullyValidated).length;
  const flagged = total - clean;
  const byReason = {};
  for (const r of results) {
    if (!r.firstInvalidReason) continue;
    const cat = r.firstInvalidReason.split(':')[0].split(' ')[0];
    byReason[cat] = (byReason[cat] ?? 0) + 1;
  }
  const bySource = {};
  for (const r of results) {
    bySource[r.source] = bySource[r.source] ?? { clean: 0, flagged: 0 };
    if (r.fullyValidated) bySource[r.source].clean++;
    else bySource[r.source].flagged++;
  }

  console.log('═══ Summary ═════════════════════════════════════════════════');
  console.log(`Total PGNs audited:           ${total}`);
  console.log(`Fully master-validated:       ${clean} (${(clean / total * 100).toFixed(1)}%)`);
  console.log(`Flagged with invented suffix: ${flagged} (${(flagged / total * 100).toFixed(1)}%)`);
  console.log('');
  console.log('By first-invalid reason:');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(32)} ${v}`);
  }
  console.log('');
  console.log('By source:');
  for (const [src, c] of Object.entries(bySource)) {
    console.log(`  ${src.padEnd(32)} clean=${c.clean.toString().padStart(4)}  flagged=${c.flagged.toString().padStart(4)}`);
  }
  console.log('');

  // Top fabricated lines (most invented plies)
  const fabricated = results.filter((r) => !r.fullyValidated).sort((a, b) => b.inventedSuffixLen - a.inventedSuffixLen);
  console.log(`─── Top 20 most-fabricated lines (longest invented suffix) ───`);
  for (const r of fabricated.slice(0, 20)) {
    console.log(`\n  • [${r.source}/${r.role}] ${r.openingId}::${r.name}`);
    console.log(`    validated ${r.validatedPly}/${r.pgnLength} plies; ${r.inventedSuffixLen} invented`);
    console.log(`    first bad move: ply ${r.firstInvalidPly} "${r.firstInvalidMove}" (${r.firstInvalidReason})`);
    if (r.dbAlternatives?.length) {
      const alts = r.dbAlternatives.map((a) => `${a.san}(${a.games}g)`).join(', ');
      console.log(`    masters played at that position: ${alts}`);
    }
  }

  await writeFile(
    join(OUT_DIR, 'report.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      enrichedDbStats: enriched?.stats,
      thresholds: { trap: TRAP_MIN_GAMES, other: OTHER_MIN_GAMES },
      summary: {
        total,
        fullyValidated: clean,
        flagged,
        byReason,
        bySource,
      },
      results,
    }, null, 2),
  );
  console.log(`\nReport: ${OUT_DIR}/report.json`);
}

main().catch((err) => {
  console.error('[audit-vs-masters] fatal:', err);
  process.exit(1);
});
