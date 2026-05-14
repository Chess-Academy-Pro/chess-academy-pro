#!/usr/bin/env node
/**
 * scripts/apply-orphan-renames.mjs
 *
 * Reads audit-reports/orphan-rename-map.json (produced by
 * match-orphan-opening-ids.mjs) and applies the renames marked
 * `high-confidence` or `review-candidate`. Each rename:
 *
 *   1. Moves the annotation file to its canonical filename (the
 *      suggested-slug + '.json').
 *   2. Rewrites the file's `openingId` field to the canonical slug.
 *
 * `no-match` orphans are left in place — those need a human call.
 *
 * Usage:
 *   node scripts/apply-orphan-renames.mjs            # dry-run
 *   node scripts/apply-orphan-renames.mjs --apply    # actually rename
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const REPORT_PATH = join(REPO, 'audit-reports/orphan-rename-map.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');

const apply = process.argv.includes('--apply');

const { report } = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
const toRename = report.filter(
  (r) => r.verdict === 'high-confidence' || r.verdict === 'review-candidate',
);

let done = 0;
let skipped = 0;
let collisions = 0;

for (const entry of toRename) {
  const oldPath = join(ANNOTATIONS_DIR, entry.file);
  const newFile = `${entry.suggested}.json`;
  const newPath = join(ANNOTATIONS_DIR, newFile);

  if (!existsSync(oldPath)) {
    console.warn(`SKIP (missing): ${entry.file}`);
    skipped += 1;
    continue;
  }

  if (existsSync(newPath) && newPath !== oldPath) {
    // The canonical filename already exists — collision. Either
    // the file was already migrated, or there's a duplicate. Leave
    // alone and flag.
    console.warn(`SKIP (collision with existing ${newFile}): ${entry.file}`);
    collisions += 1;
    continue;
  }

  if (!apply) {
    console.log(`DRY: ${entry.file.padEnd(60)} → ${newFile}`);
    done += 1;
    continue;
  }

  // Read, update openingId, write to new path, remove old.
  const json = JSON.parse(readFileSync(oldPath, 'utf8'));
  json.openingId = entry.suggested;
  writeFileSync(newPath, JSON.stringify(json, null, 2) + '\n');
  if (newPath !== oldPath) {
    // Use renameSync as a safety: if writeFileSync succeeded we want
    // to remove the old path; using unlinkSync to be explicit.
    const fs = await import('fs');
    fs.unlinkSync(oldPath);
  }
  done += 1;
}

console.log('');
console.log(`Planned: ${toRename.length}`);
console.log(`${apply ? 'Applied' : 'Would apply'}: ${done}`);
console.log(`Skipped (missing): ${skipped}`);
console.log(`Skipped (collision): ${collisions}`);
if (!apply) console.log('\nRe-run with --apply to commit changes.');
