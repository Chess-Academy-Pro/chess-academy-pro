#!/usr/bin/env node
/**
 * classify-narrations.mjs
 * -----------------------
 * Walks every annotation file under src/data/annotations/ and classifies
 * each move-annotation's narration text into one of:
 *
 *   PRESERVE   — looks hand-curated; do not touch
 *   REGENERATE — bare, templated, or matches a known-junk phrase cluster
 *   REVIEW     — borderline; flagged for human eyes (we treat as PRESERVE
 *                 in the regen pass, log here for visibility)
 *
 * Inputs:  src/data/annotations/*.json
 *          audit-reports/structural.json  (for the 50 phrase clusters)
 * Output:  audit-reports/narration-classification.json
 *
 * Zero LLM cost.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const annotDir = join(repoRoot, 'src/data/annotations');
const outDir = join(repoRoot, 'audit-reports');
mkdirSync(outDir, { recursive: true });

// ── 1. Load the templated phrase clusters from the structural audit ──────
const structural = JSON.parse(
  readFileSync(join(repoRoot, 'audit-reports/structural.json'), 'utf8'),
);
const clusterPhrases = (structural.phraseClusters || []).map((c) => c.phrase);

// Hand-rolled generic stems that don't quite cluster but are still junk.
// Each is a lowercased substring; any annotation containing one is junk.
const GENERIC_STEMS = [
  'improves piece coordination and flexibility',
  'controls key diagonal squares and maintains active piece',
  'takes up a powerful position on the',
  'takes up an influential position on',
  'this pawn advance gains space',
  'stakes a claim in the center',
  'central pawns control space and restrict',
  'this exchange changes the balance',
  'this capture changes the character of the position',
  'improves piece placement heading into the critical phase',
  'rooks belong on open or semi-open',
  'reaches a powerful central outpost',
  'this is an important variation of',
  'understanding this line will strengthen your repertoire',
  "let's walk through the key ideas",
  'the position is roughly equal',
  'both sides have chances',
  'careful defense is needed',
];

// Known "marquee" indicators that flag a move as needing extra care:
// move 1 of an opening, named sacrifices, mating shots.
function isMarqueeMove(plyIndex, san, annotationText, openingId) {
  if (plyIndex === 0) return true;
  if (san.includes('#')) return true; // checkmate
  if (san.includes('Q') && san.includes('x')) return true; // queen capture/sac
  if (/sacrifice|brilliant|stunning|legendary/i.test(annotationText)) return true;
  return false;
}

// Personality markers — phrases that strongly suggest hand-curated voice.
const PERSONALITY_MARKERS = [
  /\b(fischer|carlsen|kasparov|magnus|capablanca|tal|alekhine|botvinnik|petrosian|karpov|nakamura|ding|gukesh|hikaru)\b/i,
  /\b(romantic|legendary|famous|infamous|brilliant|notorious|classical|hypermodern|theoretical)\b/i,
  /\b(yugoslav attack|maroczy bind|isolated queen pawn|iqp|breyer|berlin wall|stonewall|kings ?indian|hedgehog|catalan)\b/i,
  /\b(world championship|tournament|match|game between|legendary game)\b/i,
  /\bwas .{1,40} weapon\b/i, // "was Fischer's favorite weapon", etc.
  /\b\d{4}\b/, // any year reference
];

// ── 2. Normalize text for cluster-substring matching ─────────────────────
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── 3. Classify a single narration ───────────────────────────────────────
function classify(text, san, plyIndex, openingId) {
  const t = (text || '').trim();
  const len = t.length;
  const norm = normalize(t);

  // Bare / empty / just SAN
  if (len === 0) return { decision: 'REGENERATE', reason: 'empty' };
  if (len < 20) return { decision: 'REGENERATE', reason: `too-short (${len} chars)` };
  if (norm === normalize(san) || norm.length < 15) {
    return { decision: 'REGENERATE', reason: 'just-san-or-too-short' };
  }

  // Cluster match — top-50 templated junk
  for (const phrase of clusterPhrases) {
    if (phrase && norm.includes(phrase)) {
      return { decision: 'REGENERATE', reason: `cluster-match: "${phrase.slice(0, 40)}..."` };
    }
  }

  // Generic stem match
  for (const stem of GENERIC_STEMS) {
    if (norm.includes(stem)) {
      return { decision: 'REGENERATE', reason: `generic-stem: "${stem}"` };
    }
  }

  // Length-based heuristic
  const hasPersonality = PERSONALITY_MARKERS.some((re) => re.test(t));

  if (len > 150 && hasPersonality) {
    return { decision: 'PRESERVE', reason: 'long+personality' };
  }
  if (len > 200) {
    return { decision: 'PRESERVE', reason: 'very-long' };
  }
  if (len > 100 && hasPersonality) {
    return { decision: 'PRESERVE', reason: 'medium+personality' };
  }
  if (len < 80) {
    // short and no personality — likely templated even if not in cluster list
    return { decision: 'REGENERATE', reason: `short (${len} chars), no personality markers` };
  }

  // Borderline — 80-150 chars, no obvious personality. Treat as REVIEW
  // (preserved in regen pass but logged).
  return { decision: 'REVIEW', reason: 'borderline (80-150 chars, no personality)' };
}

// ── 4. Walk all annotation files ─────────────────────────────────────────
const files = readdirSync(annotDir).filter((f) => f.endsWith('.json'));
const perFile = [];
let totalEntries = 0;
let preserve = 0;
let regenerate = 0;
let review = 0;
let marqueeRegen = 0;

function classifyList(list, openingId, source, sublineName) {
  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const text = (a.narration || a.annotation || '').trim();
    const result = classify(text, a.san || '', i, openingId);
    const marquee = source === 'main' && isMarqueeMove(i, a.san || '', text, openingId);
    entries.push({
      ply: i,
      san: a.san,
      source,
      sublineName,
      currentText: text.slice(0, 80),
      currentLength: text.length,
      decision: result.decision,
      reason: result.reason,
      marquee,
    });
    totalEntries++;
    if (result.decision === 'PRESERVE') preserve++;
    else if (result.decision === 'REGENERATE') {
      regenerate++;
      if (marquee) marqueeRegen++;
    } else review++;
  }
  return entries;
}

for (const fname of files) {
  const openingId = fname.replace(/\.json$/, '');
  const data = JSON.parse(readFileSync(join(annotDir, fname), 'utf8'));
  const mainList = data.moveAnnotations || data.moveAnalyses || [];
  const entries = classifyList(mainList, openingId, 'main', null);

  // Walk sub-lines (variations, traps, warnings)
  const subLines = data.subLines || [];
  for (const sub of subLines) {
    const subList = sub.moveAnnotations || sub.moveAnalyses || [];
    const subEntries = classifyList(subList, openingId, `subline:${sub.type || 'variation'}`, sub.name);
    entries.push(...subEntries);
  }

  perFile.push({
    file: fname,
    openingId,
    moveCount: mainList.length,
    sublineCount: subLines.length,
    counts: {
      preserve: entries.filter((e) => e.decision === 'PRESERVE').length,
      regenerate: entries.filter((e) => e.decision === 'REGENERATE').length,
      review: entries.filter((e) => e.decision === 'REVIEW').length,
    },
    entries,
  });
}

// ── 5. Write output ──────────────────────────────────────────────────────
const out = {
  generatedAt: new Date().toISOString(),
  summary: {
    filesScanned: files.length,
    totalEntries,
    preserve,
    regenerate,
    review,
    marqueeRegen,
    regenPercent: ((regenerate / totalEntries) * 100).toFixed(1) + '%',
    estimatedDeepSeekTokensInput: regenerate * 80,
    estimatedDeepSeekTokensOutput: regenerate * 80,
    estimatedCostUSD: (
      (regenerate * 80 * 0.27 + regenerate * 80 * 1.1) /
      1_000_000
    ).toFixed(2),
  },
  perFile,
};
writeFileSync(
  join(outDir, 'narration-classification.json'),
  JSON.stringify(out, null, 2),
);

// ── 6. Print summary ─────────────────────────────────────────────────────
console.log(`\nClassified ${totalEntries} entries across ${files.length} files`);
console.log(`  PRESERVE:   ${preserve.toString().padStart(6)} (${((preserve / totalEntries) * 100).toFixed(1)}%)`);
console.log(`  REGENERATE: ${regenerate.toString().padStart(6)} (${out.summary.regenPercent})  [${marqueeRegen} marquee]`);
console.log(`  REVIEW:     ${review.toString().padStart(6)} (${((review / totalEntries) * 100).toFixed(1)}%)`);
console.log(`\nEstimated DeepSeek cost (without batching/caching): $${out.summary.estimatedCostUSD}`);
console.log(`\nOutput: audit-reports/narration-classification.json`);

// Top 10 files by regen count
const top = [...perFile].sort((a, b) => b.counts.regenerate - a.counts.regenerate).slice(0, 10);
console.log(`\nTop 10 files by regen count:`);
top.forEach((f) => {
  console.log(
    `  ${f.openingId.padEnd(50)} regen=${f.counts.regenerate.toString().padStart(3)} preserve=${f.counts.preserve.toString().padStart(3)} review=${f.counts.review.toString().padStart(3)}`,
  );
});
