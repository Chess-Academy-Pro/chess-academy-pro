#!/usr/bin/env node
/**
 * scripts/resolve-remaining-orphans.mjs
 *
 * For each remaining orphan annotation file, find the canonical
 * openings-lichess.json row whose PGN matches the annotation's SAN
 * sequence MOST CLOSELY (longest matching prefix). The PGN is truth
 * per CLAUDE.md — once we know the actual move sequence, the
 * canonical name follows from the DB. Renames the file + rewrites
 * the openingId field.
 *
 * Special-case: `pro-X-Y` files come from per-pro annotation
 * mappings (annotationService.ts:108) — the resolver strips the
 * `pro-` prefix at runtime. Leave those alone.
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function stripSan(s) {
  return (s ?? '').replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
}

const opens = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
const known = new Set();
for (const r of opens) { known.add(slugify(r.name)); known.add(slugify(`${r.eco}-${r.name}`)); }

// Index openings by their first 3 SAN tokens for fast lookup.
const opensByPrefix = new Map();
const opensWithPlies = [];
for (const r of opens) {
  try {
    const chess = new Chess();
    const sans = [];
    for (const san of r.pgn.trim().split(/\s+/).filter(Boolean)) {
      const m = chess.move(san);
      if (!m) break;
      sans.push(stripSan(m.san));
    }
    if (sans.length === 0) continue;
    opensWithPlies.push({ row: r, sans });
    const key = sans.slice(0, 3).join('|');
    if (!opensByPrefix.has(key)) opensByPrefix.set(key, []);
    opensByPrefix.get(key).push({ row: r, sans });
  } catch {}
}

function bestMatch(annSans) {
  const cleaned = annSans.map(stripSan);
  // Score every opening by length of common prefix; tie-breaker is
  // PGN length — prefer the longest, most-specific name when several
  // openings share the same prefix as the annotation.
  let best = null;
  for (const cand of opensWithPlies) {
    let i = 0;
    for (; i < Math.min(cand.sans.length, cleaned.length); i += 1) {
      if (cand.sans[i] !== cleaned[i]) break;
    }
    if (i === 0) continue;
    if (!best || i > best.matchLen || (i === best.matchLen && cand.sans.length > best.candSans)) {
      best = { row: cand.row, matchLen: i, candSans: cand.sans.length };
    }
  }
  return best;
}

const files = readdirSync(ANNOTATIONS_DIR).filter((f) => f.endsWith('.json'));
const renames = [];
const deletes = [];
const dupCheck = new Map(); // canonical slug → list of orphans aiming there

for (const file of files) {
  let ann;
  try { ann = JSON.parse(readFileSync(join(ANNOTATIONS_DIR, file), 'utf8')); } catch { continue; }
  if (!ann.openingId || known.has(ann.openingId)) continue;
  if (ann.openingId.startsWith('pro-')) continue; // per-pro files, leave alone

  const annSans = (ann.moveAnnotations ?? []).map((m) => m.san);
  if (annSans.length === 0) continue;
  const match = bestMatch(annSans);
  if (!match) continue;

  const canonical = slugify(match.row.name);
  renames.push({ file, openingId: ann.openingId, canonical, canonicalName: match.row.name, matchLen: match.matchLen, annLen: annSans.length });
  if (!dupCheck.has(canonical)) dupCheck.set(canonical, []);
  dupCheck.get(canonical).push(file);
}

// Apply.
for (const r of renames) {
  const oldPath = join(ANNOTATIONS_DIR, r.file);
  const newPath = join(ANNOTATIONS_DIR, `${r.canonical}.json`);
  if (!existsSync(oldPath)) continue;
  if (existsSync(newPath) && newPath !== oldPath) {
    // Collision with an already-canonical file. Keep the LONGER /
    // more annotated one, delete the other.
    const incoming = JSON.parse(readFileSync(oldPath, 'utf8'));
    const existing = JSON.parse(readFileSync(newPath, 'utf8'));
    const incomingScore = (incoming.moveAnnotations ?? []).reduce((s, m) => s + (m.annotation?.length ?? 0), 0);
    const existingScore = (existing.moveAnnotations ?? []).reduce((s, m) => s + (m.annotation?.length ?? 0), 0);
    if (incomingScore > existingScore) {
      // Replace existing with incoming.
      const survivor = JSON.parse(JSON.stringify(incoming));
      survivor.openingId = r.canonical;
      writeFileSync(newPath, JSON.stringify(survivor, null, 2) + '\n');
      unlinkSync(oldPath);
      console.log(`MERGE-WIN  ${r.file.padEnd(35)} → ${r.canonical} (replaced shorter existing; ${incomingScore} > ${existingScore})`);
    } else {
      // Existing wins — drop incoming.
      unlinkSync(oldPath);
      console.log(`DUP-DROP   ${r.file.padEnd(35)} → ${r.canonical} (existing more annotated; ${existingScore} >= ${incomingScore})`);
    }
    continue;
  }
  // Clean rename.
  const json = JSON.parse(readFileSync(oldPath, 'utf8'));
  json.openingId = r.canonical;
  writeFileSync(newPath, JSON.stringify(json, null, 2) + '\n');
  if (newPath !== oldPath) unlinkSync(oldPath);
  console.log(`RENAMED    ${r.file.padEnd(35)} → ${r.canonical} (matched ${r.matchLen}/${r.annLen} plies; "${r.canonicalName}")`);
}

console.log(`\nResolved ${renames.length} orphans.`);
