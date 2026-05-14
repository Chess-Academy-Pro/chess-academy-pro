#!/usr/bin/env node
/**
 * scripts/match-orphan-opening-ids.mjs
 *
 * For each annotation file whose openingId doesn't resolve to a row
 * in openings-lichess.json, find the BEST fuzzy match by normalized
 * name comparison. Emits a JSON manifest the operator can review:
 *
 *   audit-reports/orphan-rename-map.json — { [oldId]: { suggested,
 *     score, candidates: [...], pgn-truth: ... } }
 *
 * Scoring:
 *   - Identical after normalization (defence→defense, apostrophe
 *     strip, double-hyphen collapse, etc.) → score 100.
 *   - Lev distance ≤ 2 chars → 80–95.
 *   - Same root word (first 2 tokens match) → 60–70.
 *   - Otherwise → null (truly orphan, may need deletion).
 *
 * No file changes. The operator decides what to apply.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');
const REPORT_DIR = join(REPO, 'audit-reports');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Normalize for comparison: strip British→American, collapse plurals,
 *  drop possessives, etc. Returns a canonical token string. */
function normalize(slug) {
  return slug
    .replace(/defence/g, 'defense')
    .replace(/centre/g, 'center')
    .replace(/colour/g, 'color')
    .replace(/-s-/g, '-') // collapse old possessive form
    .replace(/-?the-?/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function score(orphan, candidate) {
  const a = normalize(orphan);
  const b = normalize(candidate);
  if (a === b) return 100;
  const d = levenshtein(a, b);
  if (d <= 2) return 95 - d * 5;
  if (d <= 4) return 85 - d * 3;
  // Prefix-3-tokens match (handles word-reordering / extra suffix)
  const aTokens = a.split('-').slice(0, 3).join('-');
  const bTokens = b.split('-').slice(0, 3).join('-');
  if (aTokens && aTokens === bTokens) return 65;
  return 0;
}

function loadCandidates() {
  const rows = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
  return rows.map((r) => ({
    nameSlug: slugify(r.name),
    fullSlug: slugify(`${r.eco}-${r.name}`),
    name: r.name,
    eco: r.eco,
    pgn: r.pgn,
  }));
}

function listOrphans() {
  const rows = JSON.parse(readFileSync(OPENINGS_PATH, 'utf8'));
  const knownIds = new Set();
  for (const r of rows) {
    knownIds.add(slugify(r.name));
    knownIds.add(slugify(`${r.eco}-${r.name}`));
  }
  const files = readdirSync(ANNOTATIONS_DIR).filter((f) => f.endsWith('.json'));
  const orphans = [];
  for (const file of files) {
    try {
      const ann = JSON.parse(readFileSync(join(ANNOTATIONS_DIR, file), 'utf8'));
      if (ann.openingId && !knownIds.has(ann.openingId)) {
        orphans.push({ file, openingId: ann.openingId, plyCount: ann.moveAnnotations?.length ?? 0 });
      }
    } catch {
      /* skip unparseable */
    }
  }
  return orphans;
}

function main() {
  const candidates = loadCandidates();
  const orphans = listOrphans();
  const report = [];
  let high = 0; let medium = 0; let none = 0;

  for (const orphan of orphans) {
    let best = { score: 0, candidate: null };
    const top = [];
    for (const c of candidates) {
      const s = Math.max(score(orphan.openingId, c.nameSlug), score(orphan.openingId, c.fullSlug));
      if (s > 0) top.push({ s, c });
      if (s > best.score) best = { score: s, candidate: c };
    }
    top.sort((a, b) => b.s - a.s);
    const verdict =
      best.score >= 90 ? 'high-confidence' :
      best.score >= 60 ? 'review-candidate' :
      'no-match';
    if (verdict === 'high-confidence') high += 1;
    else if (verdict === 'review-candidate') medium += 1;
    else none += 1;
    report.push({
      orphanId: orphan.openingId,
      file: orphan.file,
      verdict,
      bestScore: best.score,
      suggested: best.candidate ? best.candidate.nameSlug : null,
      suggestedName: best.candidate ? best.candidate.name : null,
      candidates: top.slice(0, 3).map((t) => ({
        score: t.s, nameSlug: t.c.nameSlug, name: t.c.name, eco: t.c.eco,
      })),
    });
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    join(REPORT_DIR, 'orphan-rename-map.json'),
    JSON.stringify({ totals: { high, medium, none, total: orphans.length }, report }, null, 2),
  );
  console.log(`Orphans: ${orphans.length}`);
  console.log(`  high-confidence (auto-rename safe): ${high}`);
  console.log(`  review-candidate (operator decides): ${medium}`);
  console.log(`  no-match (likely delete):           ${none}`);
}

main();
