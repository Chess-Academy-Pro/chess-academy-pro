#!/usr/bin/env node
/**
 * merge-enriched-dbs.mjs — union two enriched-DB outputs into one.
 *
 * Reads:
 *   src/data/openings-lichess-extended.json  (main BFS-expansion run)
 *   src/data/openings-lichess-spine.json     (spine-positions run)
 *
 * Writes:
 *   src/data/openings-lichess-extended.json  (replaced with merged)
 *
 * If a position appears in both, the entry with more total master games
 * wins (more authoritative). If counts are equal, the longer move list
 * wins. Identical positions just dedupe.
 *
 * USAGE:
 *   node scripts/merge-enriched-dbs.mjs
 *   node scripts/merge-enriched-dbs.mjs --dry-run   # report only
 */
import { readFile, writeFile, rename } from 'node:fs/promises';

const DRY_RUN = process.argv.includes('--dry-run');

function totalGames(moves) {
  return moves.reduce((s, m) => s + (m.games ?? 0), 0);
}

async function main() {
  const main = JSON.parse(await readFile('src/data/openings-lichess-extended.json', 'utf8'));
  const spine = JSON.parse(await readFile('src/data/openings-lichess-spine.json', 'utf8'));

  const mainPos = main.positions ?? {};
  const spinePos = spine.positions ?? {};
  console.log(`[merge] main:  ${Object.keys(mainPos).length} positions`);
  console.log(`[merge] spine: ${Object.keys(spinePos).length} positions`);

  const merged = { ...mainPos };
  let conflictMainWon = 0;
  let conflictSpineWon = 0;
  let spineNew = 0;

  for (const [fen, spineMoves] of Object.entries(spinePos)) {
    if (!merged[fen]) {
      merged[fen] = spineMoves;
      spineNew++;
      continue;
    }
    const mainGames = totalGames(merged[fen]);
    const spineGames = totalGames(spineMoves);
    if (spineGames > mainGames) {
      merged[fen] = spineMoves;
      conflictSpineWon++;
    } else if (spineGames === mainGames && spineMoves.length > merged[fen].length) {
      merged[fen] = spineMoves;
      conflictSpineWon++;
    } else {
      conflictMainWon++;
    }
  }

  console.log(`[merge] spine-only NEW: ${spineNew}`);
  console.log(`[merge] conflicts won by main:  ${conflictMainWon}`);
  console.log(`[merge] conflicts won by spine: ${conflictSpineWon}`);
  console.log(`[merge] merged total: ${Object.keys(merged).length} positions`);

  if (DRY_RUN) {
    console.log('\nDry-run only. Re-run without --dry-run to write merged DB.');
    return;
  }

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    kind: 'merged',
    sources: [
      { kind: 'main-bfs-extension', stats: main.stats },
      { kind: 'spine', stats: spine.stats },
    ],
    stats: {
      mergedPositions: Object.keys(merged).length,
      spineNew,
      conflictMainWon,
      conflictSpineWon,
      totalMovesIndexed: Object.values(merged).reduce((s, v) => s + v.length, 0),
    },
    positions: merged,
  };

  // Atomic: write to .tmp then rename
  const TMP = 'src/data/openings-lichess-extended.json.tmp';
  await writeFile(TMP, JSON.stringify(out, null, 2) + '\n');
  await rename(TMP, 'src/data/openings-lichess-extended.json');
  const size = (await readFile('src/data/openings-lichess-extended.json')).length;
  console.log(`\nMerged DB written. Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('Re-run audit-pgn-vs-masters.mjs against the merged DB.');
}

main().catch((err) => {
  console.error('[merge] fatal:', err);
  process.exit(1);
});
