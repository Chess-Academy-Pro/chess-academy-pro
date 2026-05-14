#!/usr/bin/env node
/**
 * scripts/dedupe-british-american.mjs
 *
 * Resolves the 10 British/American (and umlaut-stripped) duplicate
 * pairs surfaced by Wave 2a:
 *
 *   alekhine-defence ↔ alekhine-defense
 *   benoni-defence   ↔ benoni-defense
 *   birds-opening    ↔ bird-opening
 *   dutch-defence    ↔ dutch-defense
 *   grunfeld-defence ↔ gr-nfeld-defense   (Grünfeld)
 *   old-indian-defence ↔ old-indian-defense
 *   pirc-defence     ↔ pirc-defense
 *   reti-opening     ↔ r-ti-opening       (Réti)
 *   scandinavian-defence ↔ scandinavian-defense
 *   slav-defence     ↔ slav-defense
 *
 * Policy: keep whichever file has MORE annotated content (annotation
 * text length sum across moveAnnotations[]). If equal, prefer the
 * file whose openingId matches a row in openings-lichess.json. If
 * still tied, prefer the canonical (American / de-umlauted) form.
 * Rewrite the survivor's openingId + filename to the canonical
 * slug; delete the loser.
 */
import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const opens = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
const canonicalSlugs = new Set();
for (const r of opens) {
  canonicalSlugs.add(slugify(r.name));
  canonicalSlugs.add(slugify(`${r.eco}-${r.name}`));
}

const PAIRS = [
  ['alekhine-defence', 'alekhine-defense'],
  ['benoni-defence', 'benoni-defense'],
  ['birds-opening', 'bird-opening'],
  ['dutch-defence', 'dutch-defense'],
  ['grunfeld-defence', 'gr-nfeld-defense'],
  ['old-indian-defence', 'old-indian-defense'],
  ['pirc-defence', 'pirc-defense'],
  ['reti-opening', 'r-ti-opening'],
  ['scandinavian-defence', 'scandinavian-defense'],
  ['slav-defence', 'slav-defense'],
];

function readAnn(slug) {
  const path = join(ANNOTATIONS_DIR, `${slug}.json`);
  if (!existsSync(path)) return null;
  try {
    return { path, json: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return null;
  }
}

function score(ann) {
  if (!ann || !ann.json.moveAnnotations) return -1;
  let total = 0;
  for (const m of ann.json.moveAnnotations) {
    total += (m.annotation?.length ?? 0) + (m.shortNarration?.length ?? 0);
  }
  return total;
}

for (const [bSlug, aSlug] of PAIRS) {
  const b = readAnn(bSlug);
  const a = readAnn(aSlug);
  if (!b || !a) {
    console.log(`SKIP ${bSlug} / ${aSlug}: one or both files missing`);
    continue;
  }
  const bScore = score(b);
  const aScore = score(a);
  const aCanonical = canonicalSlugs.has(aSlug);
  const bCanonical = canonicalSlugs.has(bSlug);

  let winner;
  let reason;
  if (bScore > aScore && !aCanonical) {
    winner = b; reason = `British has more content (${bScore} vs ${aScore}) AND American not canonical`;
  } else if (aScore > bScore) {
    winner = a; reason = `American has more content (${aScore} vs ${bScore})`;
  } else if (aCanonical && !bCanonical) {
    winner = a; reason = `American is canonical, British is not`;
  } else if (bCanonical && !aCanonical) {
    winner = b; reason = `British is canonical (unusual), American is not`;
  } else {
    winner = a; reason = `tied — defaulting to American (${aScore})`;
  }

  // Canonical slug for survivor = whichever is in canonicalSlugs;
  // if both, prefer American form.
  const canonicalSlug = aCanonical ? aSlug : (bCanonical ? bSlug : aSlug);
  const canonicalPath = join(ANNOTATIONS_DIR, `${canonicalSlug}.json`);

  // Write winner's content under canonical slug + matching openingId.
  const survivor = JSON.parse(JSON.stringify(winner.json));
  survivor.openingId = canonicalSlug;
  writeFileSync(canonicalPath, JSON.stringify(survivor, null, 2) + '\n');

  // Remove the LOSER file (whichever isn't the winner). If the
  // winner WAS the canonical-slug file, we just overwrote it.
  // Otherwise remove the non-canonical file.
  for (const candidate of [b, a]) {
    if (!candidate) continue;
    if (candidate.path === canonicalPath) continue;
    if (existsSync(candidate.path)) unlinkSync(candidate.path);
  }

  console.log(`${bSlug.padEnd(28)} ↔ ${aSlug.padEnd(28)} → kept ${canonicalSlug} (${reason})`);
}
