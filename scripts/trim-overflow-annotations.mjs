#!/usr/bin/env node
/**
 * scripts/trim-overflow-annotations.mjs
 *
 * Annotation files with MORE moveAnnotations than the canonical PGN
 * has plies describe positions that don't exist. Per CLAUDE.md
 * ("we don't invent sub-variations"), the surplus is invalid.
 * Trim moveAnnotations down to PGN ply count.
 *
 * Reads the audit report, finds class='annotation-overflow', truncates.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const REPORT_PATH = join(REPO, 'audit-reports/openings-narration.json');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const opens = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
const byId = new Map();
for (const r of opens) {
  const fullId = slugify(`${r.eco}-${r.name}`);
  const nameId = slugify(r.name);
  if (!byId.has(fullId)) byId.set(fullId, []);
  if (!byId.has(nameId)) byId.set(nameId, []);
  byId.get(fullId).push(r);
  byId.get(nameId).push(r);
}

function plyCount(pgn) {
  const c = new Chess();
  let plies = 0;
  for (const san of pgn.trim().split(/\s+/).filter(Boolean)) {
    if (!c.move(san)) break;
    plies += 1;
  }
  return plies;
}

const { errors } = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
const overflows = errors.filter((e) => e.class === 'annotation-overflow');
let trimmed = 0;

for (const err of overflows) {
  const filePath = join(ANNOTATIONS_DIR, err.file);
  const ann = JSON.parse(readFileSync(filePath, 'utf8'));
  const variants = byId.get(ann.openingId) ?? [];
  // Pick variant whose ply count is closest to (but <=) the
  // annotation count — same disambiguation as the auditor.
  let bestPlies = 0;
  let bestMatches = -1;
  for (const v of variants) {
    let p;
    try { p = plyCount(v.pgn); } catch { continue; }
    // Re-replay to count matching prefix SANs.
    const c = new Chess();
    let matches = 0;
    const sans = v.pgn.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < Math.min(sans.length, ann.moveAnnotations.length); i += 1) {
      const res = c.move(sans[i]);
      if (!res) break;
      const claim = (ann.moveAnnotations[i].san ?? '').replace(/[+#!?]+$/, '');
      if (res.san.replace(/[+#!?]+$/, '') === claim) matches += 1;
      else break;
    }
    if (matches > bestMatches) { bestMatches = matches; bestPlies = p; }
  }
  if (bestPlies <= 0) continue;
  if (ann.moveAnnotations.length <= bestPlies) continue;
  const surplus = ann.moveAnnotations.length - bestPlies;
  ann.moveAnnotations = ann.moveAnnotations.slice(0, bestPlies);
  writeFileSync(filePath, JSON.stringify(ann, null, 2) + '\n');
  console.log(`TRIMMED ${surplus} from ${err.file} (${ann.moveAnnotations.length} kept, matches canonical ${bestPlies}-ply PGN)`);
  trimmed += 1;
}
console.log(`\nTotal trimmed: ${trimmed} files`);
