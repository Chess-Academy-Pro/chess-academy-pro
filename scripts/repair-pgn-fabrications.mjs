#!/usr/bin/env node
/**
 * repair-pgn-fabrications.mjs — mechanically repair LLM-invented PGN
 * suffixes by splicing in master-game continuations from the enriched DB.
 *
 * Consumes:
 *   audit-reports/pgn-vs-masters-<latest>/report.json
 *   public/data/openings-masters-db.json
 *
 * For each flagged entry:
 *   1. Keep the validated prefix (validatedPly plies — these are
 *      already master-anchored).
 *   2. From the divergence position, greedily extend by picking the
 *      most-popular master move that meets the role's threshold, up
 *      to the line's original length (so we don't accidentally
 *      shorten — David's rule: don't shorten if we don't have to).
 *   3. If we hit a position with no master continuations, truncate.
 *
 * Default DRY-RUN. Pass --apply to actually mutate the data files.
 *
 * USAGE:
 *   node scripts/repair-pgn-fabrications.mjs           # dry-run, show diffs
 *   node scripts/repair-pgn-fabrications.mjs --apply   # rewrite the data files
 *   node scripts/repair-pgn-fabrications.mjs --only=repertoire.json,gambits.json
 */
import { Chess } from 'chess.js';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const ONLY_SOURCES = onlyArg ? new Set(onlyArg.split(',')) : null;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `audit-reports/repair-fabrications-${stamp}`;

function positionFen(fullFen) {
  return fullFen.split(' ').slice(0, 4).join(' ');
}

async function findLatestReport() {
  const dirs = (await readdir('audit-reports/'))
    .filter((d) => d.startsWith('pgn-vs-masters-'))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    throw new Error('No pgn-vs-masters report found. Run audit-pgn-vs-masters.mjs first.');
  }
  return `audit-reports/${dirs[0]}/report.json`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const reportPath = await findLatestReport();
  console.log(`[repair] reading audit: ${reportPath}`);
  const audit = JSON.parse(await readFile(reportPath, 'utf8'));
  const enriched = JSON.parse(
    await readFile('public/data/openings-masters-db.json', 'utf8'),
  );
  const positions = enriched.positions ?? {};

  const flagged = audit.results.filter((r) => !r.fullyValidated);
  console.log(`[repair] ${flagged.length} flagged entries to consider`);
  if (ONLY_SOURCES) {
    console.log(`[repair] limiting to sources: ${[...ONLY_SOURCES].join(', ')}`);
  }
  console.log(`[repair] mode: ${APPLY ? 'APPLY (will rewrite JSON files)' : 'DRY-RUN'}`);
  console.log('');

  const proposals = [];
  for (const r of flagged) {
    if (ONLY_SOURCES && !ONLY_SOURCES.has(r.source)) continue;

    const moves = r.pgn.split(' ').filter(Boolean);
    const validatedPrefix = moves.slice(0, r.validatedPly);
    const targetLength = moves.length;
    const threshold = r.thresholdApplied;

    // Reconstruct chess.js board at divergence point
    const chess = new Chess();
    for (const m of validatedPrefix) chess.move(m);

    // Greedy extension from masters
    const repairedSuffix = [];
    let truncatedReason = null;
    while (validatedPrefix.length + repairedSuffix.length < targetLength) {
      const posFen = positionFen(chess.fen());
      const cands = positions[posFen];
      if (!cands) {
        truncatedReason = 'NO_DB_COVERAGE';
        break;
      }
      const eligible = cands.filter((c) => c.games >= threshold);
      if (eligible.length === 0) {
        truncatedReason = `NO_MOVE_MEETS_THRESHOLD (${threshold} games)`;
        break;
      }
      // Pick the most-played master move
      const top = eligible.sort((a, b) => b.games - a.games)[0];
      let moved;
      try {
        moved = chess.move(top.san);
      } catch {
        truncatedReason = `CHESS_JS_REJECTED ${top.san}`;
        break;
      }
      if (!moved) {
        truncatedReason = `CHESS_JS_NULL ${top.san}`;
        break;
      }
      repairedSuffix.push(top.san);
    }

    const repairedPgn = [...validatedPrefix, ...repairedSuffix].join(' ');
    const repairedLength = validatedPrefix.length + repairedSuffix.length;
    const stillShortBy = targetLength - repairedLength;

    proposals.push({
      source: r.source,
      openingId: r.openingId,
      role: r.role,
      name: r.name,
      original: r.pgn,
      repaired: repairedPgn,
      validatedPly: r.validatedPly,
      originalLength: moves.length,
      repairedLength,
      stillShortBy,
      truncatedReason,
      firstInvalidMove: r.firstInvalidMove,
      thresholdApplied: threshold,
    });
  }

  // ─── Print diff summary ────────────────────────────────────────
  const byOutcome = {
    fully_restored: 0,
    extended_but_short: 0,
    only_truncated: 0,
  };
  for (const p of proposals) {
    if (p.repairedLength === p.originalLength) byOutcome.fully_restored++;
    else if (p.repairedLength > p.validatedPly) byOutcome.extended_but_short++;
    else byOutcome.only_truncated++;
  }

  console.log('═══ Proposed repairs ═══════════════════════════════════════');
  console.log(`Total considered:           ${proposals.length}`);
  console.log(`Fully restored (same len):  ${byOutcome.fully_restored}`);
  console.log(`Extended but shorter:       ${byOutcome.extended_but_short}`);
  console.log(`Only truncated to validated: ${byOutcome.only_truncated}`);
  console.log('');

  // Show some examples
  console.log('─── Sample proposals (first 10) ─────────────────────────────');
  for (const p of proposals.slice(0, 10)) {
    console.log(`\n  • [${p.source}/${p.role}] ${p.openingId}::${p.name}`);
    console.log(`    bad move at ply ${p.validatedPly + 1}: "${p.firstInvalidMove}"`);
    console.log(`    BEFORE (${p.originalLength}p): ${p.original}`);
    console.log(`    AFTER  (${p.repairedLength}p): ${p.repaired}${p.truncatedReason ? ' [truncated: ' + p.truncatedReason + ']' : ''}`);
  }

  // Save the proposals as a diff plan
  await writeFile(join(OUT_DIR, 'proposals.json'), JSON.stringify(proposals, null, 2));
  console.log(`\nFull proposal list: ${OUT_DIR}/proposals.json`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to mutate the data files.');
    return;
  }

  // ─── Apply mode: rewrite the source JSON files ─────────────────
  console.log('\n[apply] writing changes to data files...');
  const byFile = new Map();
  for (const p of proposals) {
    if (!byFile.has(p.source)) byFile.set(p.source, []);
    byFile.get(p.source).push(p);
  }

  for (const [file, edits] of byFile) {
    const path = `src/data/${file}`;
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const isObject = file === 'pro-repertoires.json';
    const arr = isObject ? raw.openings : raw;
    let writeCount = 0;
    for (const e of edits) {
      const opening = arr.find((o) => (o.id ?? o.openingId ?? o.name) === e.openingId);
      if (!opening) {
        console.warn(`  [skip] could not find opening ${e.openingId} in ${file}`);
        continue;
      }
      if (e.role === 'main') {
        opening.pgn = e.repaired;
        writeCount++;
      } else if (e.role === 'variation') {
        const v = (opening.variations ?? []).find((v) => v.name === e.name);
        if (v) { v.pgn = e.repaired; writeCount++; }
      } else if (e.role === 'trap') {
        const t = (opening.trapLines ?? []).find((t) => t.name === e.name);
        if (t) { t.pgn = e.repaired; writeCount++; }
      } else if (e.role === 'warning') {
        const w = (opening.warningLines ?? []).find((w) => w.name === e.name);
        if (w) { w.pgn = e.repaired; writeCount++; }
      }
    }
    await writeFile(path, JSON.stringify(raw, null, 2) + '\n');
    console.log(`  [apply] ${file}: ${writeCount} PGNs rewritten`);
  }
  console.log('\nDone. Re-run audit-pgn-vs-masters.mjs to verify the new state is clean.');
}

main().catch((err) => {
  console.error('[repair] fatal:', err);
  process.exit(1);
});
