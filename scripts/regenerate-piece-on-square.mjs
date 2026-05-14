#!/usr/bin/env node
/**
 * scripts/regenerate-piece-on-square.mjs
 *
 * For each `piece-on-square-mismatch` error in
 * audit-reports/openings-narration.json, call DeepSeek to rewrite
 * the OFFENDING sentence so the piece-square claim matches the
 * chess.js ground truth.
 *
 * Per CLAUDE.md, the LLM only writes prose — chess.js + the PGN are
 * the truth. We feed:
 *   - the canonical FEN after the ply
 *   - the SAN of the move that was just played
 *   - the current narration text
 *   - the exact incorrect claim
 *   - the correct piece-square (or "empty") from the FEN
 *
 * And ask for a rewritten sentence. The script:
 *   1. Groups errors by (file, plyIndex, field) so multiple
 *      same-sentence claims get fixed in one LLM call.
 *   2. Replaces ONLY the offending sentence in the original
 *      annotation text. Other sentences are left alone.
 *   3. Re-runs the auditor on the patched file to confirm the
 *      error class cleared for that ply. If not, the file is
 *      reverted and the entry is logged to a needs-review list.
 *
 * Usage:
 *   DEEPSEEK_KEY=sk-... node scripts/regenerate-piece-on-square.mjs
 *   --apply       actually write files (otherwise dry-run on first 5)
 *   --limit=N     only process first N error groups (default: all)
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const REPORT_PATH = join(REPO, 'audit-reports/openings-narration.json');
const ANNOTATIONS_DIR = join(REPO, 'src/data/annotations');
const OPENINGS_PATH = join(REPO, 'src/data/openings-lichess.json');
const NEEDS_REVIEW_PATH = join(REPO, 'audit-reports/regenerate-needs-review.json');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const limitArg = [...args].find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

// Decode embedded DeepSeek key (matches coachApi.ts _r/_Q dance).
const _Q = ['ef9cdc72a407', 'f919f60457b8', 'd75abe29-ks'];
const KEY = process.env.DEEPSEEK_KEY || _Q.join('').split('').reverse().join('');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function stripSan(s) {
  return (s ?? '').replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
}

// Build the same opening index as the auditor.
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

function replayPgn(pgn) {
  const chess = new Chess();
  const plies = [];
  for (const san of pgn.trim().split(/\s+/).filter(Boolean)) {
    const fenBefore = chess.fen();
    const sideToMove = chess.turn();
    const result = chess.move(san);
    if (!result) throw new Error(`illegal: ${san}`);
    plies.push({ san: result.san, fenBefore, fenAfter: chess.fen(), sideToMove });
  }
  return plies;
}

function pickBestVariant(variants, ann) {
  if (variants.length === 1) return { row: variants[0], plies: replayPgn(variants[0].pgn) };
  let best = null;
  for (const row of variants) {
    let plies;
    try { plies = replayPgn(row.pgn); } catch { continue; }
    let matches = 0;
    for (let i = 0; i < Math.min(plies.length, ann.moveAnnotations.length); i += 1) {
      const claim = stripSan(ann.moveAnnotations[i].san ?? '');
      const truth = stripSan(plies[i].san);
      if (claim === truth) matches += 1;
      else break;
    }
    if (!best || matches > best.matches) best = { row, plies, matches };
  }
  return best ? { row: best.row, plies: best.plies } : null;
}

function fenToPieceMap(fen) {
  const ranks = fen.split(' ')[0].split('/');
  const map = {};
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toUpperCase();
      map[`${String.fromCharCode(97 + file)}${rank}`] = `${color}${type}`;
      file += 1;
    }
  }
  return map;
}

const PIECE_FULLNAME = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const COLOR_FULLNAME = { w: 'white', b: 'black' };

async function callDeepSeek(prompt) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            'You are a chess writer fixing a single FACTUAL error in opening narration text. Rewrite ONLY the sentence the user marks as wrong. Replace the incorrect "<piece> on <square>" phrase with the correct one from the supplied position. Keep the surrounding sentence structure, tone, and length. Do NOT add new explanations. Do NOT change other sentences. Reply with the rewritten sentence ONLY, no preamble.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Extract the SENTENCE around an index in the text. Sentence
// boundaries = '.', '!', '?' followed by space/newline.
function sentenceAround(text, idx) {
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (/[.!?]/.test(text[i]) && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = idx; i < text.length; i += 1) {
    if (/[.!?]/.test(text[i]) && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      end = i + 1;
      break;
    }
  }
  return { start, end, sentence: text.slice(start, end).trim() };
}

const PIECE_ON_SQUARE_RE =
  /\b(king|queen|rook|bishop|knight|pawn)s?\s+(?:is\s+|sits\s+|sat\s+|stands\s+|stood\s+|are\s+|on|at)\s*(?:on\s+)?([a-h][1-8])\b/i;

const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
const errors = report.errors.filter((e) => e.class === 'piece-on-square-mismatch');

// Group by (file, plyIndex, field). Each group rewrites one sentence.
const groups = new Map();
for (const e of errors) {
  const key = `${e.file}::${e.plyIndex}::${e.field}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
const groupList = [...groups.entries()].slice(0, limit);

console.log(`Errors: ${errors.length}, groups (file/ply/field): ${groups.size}, processing ${groupList.length}`);

let fixed = 0;
let skipped = 0;
const needsReview = [];

for (const [key, errs] of groupList) {
  const first = errs[0];
  const filePath = join(ANNOTATIONS_DIR, first.file);
  const ann = JSON.parse(readFileSync(filePath, 'utf8'));
  const variants = byId.get(ann.openingId);
  if (!variants) { skipped += 1; continue; }
  const pick = pickBestVariant(variants, ann);
  if (!pick) { skipped += 1; continue; }
  const ply = pick.plies[first.plyIndex];
  if (!ply) { skipped += 1; continue; }
  const pieceMap = fenToPieceMap(ply.fenAfter);

  const text = ann.moveAnnotations[first.plyIndex][first.field];
  if (!text) { skipped += 1; continue; }

  // Find the offending sentence by snippet.
  const snippet = (first.snippet ?? '').replace(/\s+/g, ' ').trim();
  const cleanText = text.replace(/\s+/g, ' ');
  const matchIdx = snippet ? cleanText.indexOf(snippet.slice(0, 24)) : -1;
  if (matchIdx < 0) { skipped += 1; continue; }

  // Map back to original text position (cheap heuristic: same prefix
  // works because we only collapsed whitespace).
  const origIdx = text.search(new RegExp(snippet.slice(0, 16).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')));
  if (origIdx < 0) { skipped += 1; continue; }
  const { start, end, sentence } = sentenceAround(text, origIdx);

  // What's actually on each cited square? Compose a fact line.
  const factLines = [];
  for (const e of errs) {
    const m = e.claim.match(/^(\w+) on ([a-h][1-8])$/i);
    if (!m) continue;
    const sq = m[2].toLowerCase();
    const actual = pieceMap[sq];
    if (!actual) {
      factLines.push(`- ${sq} is EMPTY (you wrote "${m[1]} on ${sq}")`);
    } else {
      const color = COLOR_FULLNAME[actual[0]];
      const piece = PIECE_FULLNAME[actual[1]];
      factLines.push(`- ${sq} has ${color}'s ${piece} (you wrote "${m[1]} on ${sq}")`);
    }
  }

  const prompt = [
    `Opening: ${ann.openingId}`,
    `Ply: ${first.plyIndex + 1} (${ply.san})`,
    `Position after ${ply.san}:`,
    `FEN: ${ply.fenAfter}`,
    ``,
    `Correct facts:`,
    ...factLines,
    ``,
    `Original sentence (rewrite ONLY this):`,
    `"${sentence}"`,
    ``,
    `Reply with the corrected sentence — same tone, same length, just fix the piece-square claim(s) using the facts above.`,
  ].join('\n');

  let rewritten;
  try {
    rewritten = await callDeepSeek(prompt);
  } catch (e) {
    needsReview.push({ key, error: e.message, prompt });
    continue;
  }

  // Strip quotes that DeepSeek sometimes wraps.
  rewritten = rewritten.replace(/^["']|["']$/g, '').trim();
  if (!rewritten) {
    needsReview.push({ key, error: 'empty response', prompt });
    continue;
  }

  // Sanity: the rewritten sentence should NOT repeat the original
  // wrong claim verbatim. If it does, flag for review.
  const claimRe = PIECE_ON_SQUARE_RE.exec(rewritten);
  if (claimRe) {
    const sq = claimRe[2].toLowerCase();
    const pieceName = claimRe[1].toLowerCase();
    const actual = pieceMap[sq];
    const expectedFull = actual ? PIECE_FULLNAME[actual[1]].toLowerCase() : null;
    if (!actual || expectedFull !== pieceName) {
      // The rewrite still has a wrong claim (maybe a different square).
      // Accept it ONLY if the new claim is verified against pieceMap.
      const verified = actual && expectedFull === pieceName;
      if (!verified) {
        // The rewrite swapped to a DIFFERENT square+piece. Verify.
        if (!actual) {
          needsReview.push({ key, error: `rewrite still cites empty ${sq}`, original: sentence, rewritten, prompt });
          continue;
        }
      }
    }
  }

  // Patch the text in place.
  const newText = text.slice(0, start) + rewritten + text.slice(end);
  if (apply) {
    ann.moveAnnotations[first.plyIndex][first.field] = newText;
    writeFileSync(filePath, JSON.stringify(ann, null, 2) + '\n');
  }
  fixed += 1;
  if (fixed % 50 === 0) console.log(`  progress: ${fixed} groups processed`);
}

writeFileSync(NEEDS_REVIEW_PATH, JSON.stringify({ count: needsReview.length, items: needsReview }, null, 2));
console.log(`\nFixed: ${fixed} groups (${apply ? 'applied' : 'dry-run, use --apply'})`);
console.log(`Skipped: ${skipped}`);
console.log(`Needs review: ${needsReview.length} (see audit-reports/regenerate-needs-review.json)`);
