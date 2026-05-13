#!/usr/bin/env node
/**
 * fix-piece-on-square.mjs
 * -----------------------
 * One-shot data-quality cleanup driven by
 * `audit-reports/featured-narrations.json` — fixes the 195
 * piece-on-square narration errors surfaced by the existing
 * featured-narrations audit.
 *
 * Each finding has the shape:
 *
 *     {
 *       source:        'rep-subline' | 'rep-main' | 'pro-subline' |
 *                      'pro-main' | 'pro-overview' | 'pro-variation' |
 *                      'repertoire-variation',
 *       openingId:     'italian-game',
 *       sublineName:   'Italian: Hungarian Defense',
 *       moveIndex:     12,
 *       san:           'dxe5',
 *       text:          'Black captures the knight on e5. …',
 *       flag: {
 *         kind:    'piece-on-square',
 *         detail:  'claims knight on e5, board holds a p',  // or 'square is empty'
 *         excerpt: 'the knight on e5'
 *       }
 *     }
 *
 * Fix strategy:
 *   1. Match the exact `flag.excerpt` substring in `text`.
 *   2. If `flag.detail` says "board holds a X" → swap the wrong piece
 *      word in the excerpt with the canonical word for X.
 *   3. If `flag.detail` says "square is empty" → strip the false
 *      "the X on Y" phrase entirely (the narration is referencing
 *      a piece that isn't there at all).
 *   4. Write the corrected text back to the originating file.
 *
 * The mate-claim finding (sicilian-dragon Yugoslav Attack) is NOT
 * touched here — on inspection it's a false positive: the narration
 * describes the opening's character ("race to deliver checkmate
 * first defines every tempo") rather than asserting the current
 * position is mate. The audit's `\bcheckmate\b` regex is overzealous
 * for descriptive prose.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const auditPath = join(repoRoot, 'audit-reports/featured-narrations.json');

const PIECE_WORDS = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PIECE_WORD_PATTERN = /(pawn|knight|bishop|rook|queen|king)/i;

/** Resolve the file path that owns a given `openingId`. Mirrors
 *  `resolveAnnotationFile` in `audit-featured-narrations.mjs`:
 *  try direct, then strip `pro-<player>-` prefix. */
function resolveAnnotationFile(openingId) {
  const direct = join(repoRoot, 'src/data/annotations', `${openingId}.json`);
  try {
    readFileSync(direct, 'utf-8');
    return direct;
  } catch { /* fall through */ }
  const m = /^pro-[a-z]+-(.+)$/.exec(openingId);
  if (m) {
    const bare = join(repoRoot, 'src/data/annotations', `${m[1]}.json`);
    try {
      readFileSync(bare, 'utf-8');
      return bare;
    } catch { /* fall through */ }
  }
  return null;
}

/** Apply the piece-on-square correction to a narration string.
 *  Returns the corrected string, or null if no change should be made
 *  (e.g. the excerpt no longer appears in the text — data drifted
 *  since the audit). */
function correctText(text, excerpt, detail) {
  if (typeof text !== 'string' || !text.includes(excerpt)) return null;

  // "square is empty" → strip the false reference entirely.
  if (/square is empty/i.test(detail)) {
    return stripFalseReference(text, excerpt);
  }

  // "board holds a X" → substitute the right piece word.
  const m = /board holds a ([pnbrqk])\b/.exec(detail);
  if (!m) return null;
  const correctPiece = PIECE_WORDS[m[1]];
  if (!correctPiece) return null;

  // Find the wrong piece word in the excerpt and swap it.
  const wrongMatch = PIECE_WORD_PATTERN.exec(excerpt);
  if (!wrongMatch) return null;
  const wrongWord = wrongMatch[1];
  const fixedExcerpt = excerpt.replace(
    wrongMatch[0],
    matchCase(wrongWord, correctPiece),
  );
  if (fixedExcerpt === excerpt) return null;
  // Replace ONLY the first occurrence to avoid clobbering distinct
  // mentions of the same phrase elsewhere in the prose.
  return text.replace(excerpt, fixedExcerpt);
}

function matchCase(reference, target) {
  if (reference[0] === reference[0].toUpperCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target;
}

/** Strip a false "the X on Y" / "A X on Y" phrase from prose.
 *  When the named square is empty, the cleanest rewrite is to remove
 *  the bad reference and patch the surrounding grammar.
 *
 *  Heuristics:
 *  - "captures the knight on e5" → "captures on e5"
 *  - "A knight on f5 controls …" → "A piece on f5 controls …"
 *    (the sentence is non-trivial without the reference; rewriting
 *    to "piece" preserves grammar without making a false claim)
 *  - "Black's knight on c6 …" → drop the whole noun phrase if the
 *    sentence still parses, otherwise replace piece with "piece". */
function stripFalseReference(text, excerpt) {
  // captures the X on YZ → captures on YZ
  const capturesRe = /\b(captur(?:es?|ing))\s+the\s+\w+\s+on\s+([a-h][1-8])\b/i;
  const capMatch = capturesRe.exec(excerpt);
  if (capMatch) {
    const fixed = excerpt.replace(capturesRe, '$1 on $2');
    return text.replace(excerpt, fixed);
  }
  // Generic: replace the wrong piece word with "piece".
  const m = PIECE_WORD_PATTERN.exec(excerpt);
  if (m) {
    const fixed = excerpt.replace(m[0], matchCase(m[1], 'piece'));
    return text.replace(excerpt, fixed);
  }
  return null;
}

// ─── Per-source application ──────────────────────────────────────────

function applyToAnnotationFile(filePath, finding, isSubline) {
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  let ann = null;
  if (isSubline) {
    const sl = (data.subLines ?? []).find((s) => (s.name ?? null) === finding.sublineName);
    if (!sl) return { changed: false, reason: `subline "${finding.sublineName}" not found` };
    ann = (sl.moveAnnotations ?? [])[finding.moveIndex];
  } else {
    ann = (data.moveAnnotations ?? [])[finding.moveIndex];
  }
  if (!ann) return { changed: false, reason: 'annotation node not found' };
  const orig = typeof ann.annotation === 'string' ? ann.annotation : '';
  const fixed = correctText(orig, finding.flag.excerpt, finding.flag.detail);
  if (!fixed || fixed === orig) {
    return { changed: false, reason: 'excerpt no longer present or no fix produced' };
  }
  ann.annotation = fixed;
  // Preserve the original indent (2-space, trailing newline).
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return { changed: true, before: orig, after: fixed };
}

function applyToRepertoireVariation(finding) {
  const filePath = join(repoRoot, 'src/data/repertoire.json');
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const op = data.find((o) => o.id === finding.openingId);
  if (!op) return { changed: false, reason: `opening ${finding.openingId} not in repertoire` };
  const v = (op.variations ?? []).find((vv) => (vv.name ?? null) === finding.sublineName);
  if (!v) return { changed: false, reason: `variation "${finding.sublineName}" not found` };
  const orig = typeof v.explanation === 'string' ? v.explanation : '';
  const fixed = correctText(orig, finding.flag.excerpt, finding.flag.detail);
  if (!fixed || fixed === orig) return { changed: false, reason: 'no fix produced' };
  v.explanation = fixed;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return { changed: true, before: orig, after: fixed };
}

function applyToProJson(finding) {
  const filePath = join(repoRoot, 'src/data/pro-repertoires.json');
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const op = (data.openings ?? []).find((o) => o.id === finding.openingId);
  if (!op) return { changed: false, reason: `pro opening ${finding.openingId} not found` };
  if (finding.source === 'pro-overview') {
    const orig = typeof op.overview === 'string' ? op.overview : '';
    const fixed = correctText(orig, finding.flag.excerpt, finding.flag.detail);
    if (!fixed || fixed === orig) return { changed: false, reason: 'no fix produced' };
    op.overview = fixed;
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return { changed: true, before: orig, after: fixed };
  }
  if (finding.source === 'pro-variation') {
    const v = (op.variations ?? []).find((vv) => (vv.name ?? null) === finding.sublineName);
    if (!v) return { changed: false, reason: `pro variation "${finding.sublineName}" not found` };
    const orig = typeof v.explanation === 'string' ? v.explanation : '';
    const fixed = correctText(orig, finding.flag.excerpt, finding.flag.detail);
    if (!fixed || fixed === orig) return { changed: false, reason: 'no fix produced' };
    v.explanation = fixed;
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return { changed: true, before: orig, after: fixed };
  }
  return { changed: false, reason: `unhandled pro source ${finding.source}` };
}

// ─── Main ────────────────────────────────────────────────────────────

const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
const pieceFindings = (audit.findings ?? []).filter(
  (f) => f.flag?.kind === 'piece-on-square',
);
console.log(`[fix-piece-on-square] processing ${pieceFindings.length} findings…`);

const stats = { applied: 0, skipped: 0, errors: 0 };
const skipReasons = new Map();
const samples = { applied: [], skipped: [] };

for (const f of pieceFindings) {
  try {
    let result;
    switch (f.source) {
      case 'rep-main':
      case 'pro-main': {
        const fp = resolveAnnotationFile(f.openingId);
        if (!fp) { result = { changed: false, reason: 'annotation file not resolved' }; break; }
        result = applyToAnnotationFile(fp, f, false);
        break;
      }
      case 'rep-subline':
      case 'pro-subline': {
        const fp = resolveAnnotationFile(f.openingId);
        if (!fp) { result = { changed: false, reason: 'annotation file not resolved' }; break; }
        result = applyToAnnotationFile(fp, f, true);
        break;
      }
      case 'repertoire-variation':
        result = applyToRepertoireVariation(f);
        break;
      case 'pro-overview':
      case 'pro-variation':
        result = applyToProJson(f);
        break;
      default:
        result = { changed: false, reason: `unknown source ${f.source}` };
    }
    if (result.changed) {
      stats.applied++;
      if (samples.applied.length < 5) {
        samples.applied.push({
          file: `${f.source} / ${f.openingId} / ${f.sublineName ?? '(main)'} / move ${f.moveIndex} / ${f.san}`,
          before: result.before.slice(0, 120),
          after: result.after.slice(0, 120),
        });
      }
    } else {
      stats.skipped++;
      skipReasons.set(result.reason, (skipReasons.get(result.reason) ?? 0) + 1);
      if (samples.skipped.length < 5) {
        samples.skipped.push({ source: f.source, opening: f.openingId, reason: result.reason });
      }
    }
  } catch (err) {
    stats.errors++;
    console.error(`[fix-piece-on-square] ${f.openingId} / ${f.sublineName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('');
console.log('=== fix-piece-on-square summary ===');
console.log(`  applied: ${stats.applied}`);
console.log(`  skipped: ${stats.skipped}`);
console.log(`  errors:  ${stats.errors}`);
if (skipReasons.size > 0) {
  console.log('  Skip reasons:');
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count}× ${reason}`);
  }
}
console.log('  Sample applied fixes:');
for (const s of samples.applied) {
  console.log(`    ${s.file}`);
  console.log(`      before: "${s.before}…"`);
  console.log(`      after:  "${s.after}…"`);
}
if (samples.skipped.length > 0) {
  console.log('  Sample skipped:');
  for (const s of samples.skipped) {
    console.log(`    ${s.source} ${s.opening} — ${s.reason}`);
  }
}
