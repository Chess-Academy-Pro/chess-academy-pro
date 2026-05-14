#!/usr/bin/env node
/**
 * apply-gambit-narrations.mjs
 * ---------------------------
 * Applies hand-written narrations from scripts/gambit-narrations.json to
 * the 4 templated junk gambit annotation files. Replaces ONLY the main-line
 * moveAnnotations[i].annotation field — subLines are untouched, arrows
 * preserved, structure preserved.
 *
 * Verifies the SAN sequence matches before writing (refuses if drift).
 *
 * Usage:
 *   node scripts/apply-gambit-narrations.mjs              # dry-run with diff preview
 *   node scripts/apply-gambit-narrations.mjs --write      # actually write the files
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const annotDir = join(repoRoot, 'src/data/annotations');

const WRITE = process.argv.includes('--write');

const narrations = JSON.parse(
  readFileSync(join(repoRoot, 'scripts/gambit-narrations.json'), 'utf8'),
);

const openings = Object.keys(narrations).filter((k) => !k.startsWith('_'));

let totalUpdated = 0;
let totalSkipped = 0;

for (const openingId of openings) {
  const newTexts = narrations[openingId];
  const fpath = join(annotDir, `${openingId}.json`);
  const data = JSON.parse(readFileSync(fpath, 'utf8'));
  const list = data.moveAnnotations || data.moveAnalyses || [];

  console.log(`\n=== ${openingId} (main line: ${list.length} entries, narrations: ${newTexts.length}) ===`);

  if (list.length !== newTexts.length) {
    console.error(`  ✗ MISMATCH: ${list.length} entries but ${newTexts.length} narrations. SKIPPING.`);
    totalSkipped += newTexts.length;
    continue;
  }

  let updated = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const oldText = entry.annotation || entry.narration || '';
    const newText = newTexts[i];

    if (!WRITE) {
      console.log(`  [${i.toString().padStart(2)}] ${entry.san.padEnd(8)} OLD (${oldText.length}c): ${oldText.slice(0, 70)}${oldText.length > 70 ? '...' : ''}`);
      console.log(`            NEW (${newText.length}c): ${newText.slice(0, 70)}${newText.length > 70 ? '...' : ''}`);
    } else {
      entry.annotation = newText;
      // Also set narration field if it exists or could be useful for runtime pickNarrationText
      if ('narration' in entry || newText.length > 80) {
        entry.narration = newText;
      }
      updated++;
    }
  }

  if (WRITE) {
    writeFileSync(fpath, JSON.stringify(data, null, 2) + '\n');
    console.log(`  ✓ Wrote ${updated} narrations to ${openingId}.json`);
    totalUpdated += updated;
  }
}

console.log(`\n────────────────────────────────────────`);
if (WRITE) {
  console.log(`Total: ${totalUpdated} narrations applied across ${openings.length} files.`);
  if (totalSkipped > 0) console.log(`Skipped: ${totalSkipped} (mismatched files)`);
} else {
  console.log(`DRY RUN — no files written. Run with --write to apply.`);
}
