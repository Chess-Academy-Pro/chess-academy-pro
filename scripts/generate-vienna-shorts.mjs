#!/usr/bin/env node
/**
 * Adds `shortIdea` / `shortText` / `shortWhyBad` / `shortWhyPunish` /
 * `shortIntro` sibling fields to every long-form narration string in
 * `src/data/openingWalkthroughs/vienna.ts`. Generates shorts via
 * DeepSeek (same prompt as `generate-short-narrations.mjs` for tone
 * consistency) and injects them as TypeScript field-pairs with
 * matching indentation, preserving the surrounding source layout.
 *
 * Usage:
 *   node scripts/generate-vienna-shorts.mjs            # sample preview (20)
 *   node scripts/generate-vienna-shorts.mjs --write    # full pass + write file
 *
 * Why a separate script (vs. the JSON generator): vienna.ts is
 * TypeScript with hand-written narration. The same fields exist
 * (idea, text, whyBad, whyPunish) but they're embedded in TS object
 * literals, not JSON. This scanner is context-aware so it shortens
 * narration text but NOT ConceptCheckChoice.text (same key name,
 * different purpose). Disambiguation: stack-tracked array context.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'src/data/openingWalkthroughs/vienna.ts');

const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const sampleArg = args.find((a) => a.startsWith('--sample='));
const SAMPLE_SIZE = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : 20;
const concurrentArg = args.find((a) => a.startsWith('--concurrent='));
const CONCURRENT = concurrentArg ? parseInt(concurrentArg.split('=')[1], 10) : 8;

function loadEnvLocal() {
  const path = join(ROOT, '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const API_KEY = process.env.VITE_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('FATAL: VITE_DEEPSEEK_API_KEY missing from env / .env.local');
  process.exit(1);
}
const client = new OpenAI({ apiKey: API_KEY, baseURL: 'https://api.deepseek.com' });

const SYSTEM_PROMPT = `You compress a chess coach's narration into a single brief spoken sentence for an audio "Brief" mode.

REQUIREMENTS:
- Output ONE sentence, MAX 28 words.
- PRESERVE the key chess idea: the tactical pattern, evaluation, threat, or what's at stake.
- The compressed sentence must let the listener act on the same chess understanding the full version conveys.
- DROP: historical context, narrator coaching tone ("now you know", "this is why pros play..."), setup-only sentences when the punchline is elsewhere, second-person commands ("try", "back up").
- KEEP: piece names, key squares, move notation, threat keywords (hangs, wins, mate, fork, pin, skewer, sacrifice, refutes, trades, drops), positional verdicts (bishop pair, doubled pawns, weak king, etc.).
- Match the original voice — terse, direct, matter-of-fact.
- NO emojis. NO questions. NO "let's...". NO greetings.

Return ONLY the compressed sentence — no preamble, no quotes, no explanation.`;

async function compress(narration) {
  const resp = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: narration },
    ],
    max_tokens: 80,
    temperature: 0.3,
  });
  return resp.choices[0]?.message?.content?.trim() ?? '';
}

/**
 * Scan vienna.ts and return a list of { line, indent, key, value, end }
 * describing every shortenable field found. Tracks open-array context
 * so `text:` inside `narration:` is shortened but `text:` inside
 * `choices:` (ConceptCheckChoice) is skipped.
 *
 * `value` is the full string literal text (without the surrounding
 * quotes). `end` is the line index of the last line the string spans
 * — the line we'll inject the `short*` sibling AFTER (with trailing
 * comma already on the original's last line if present).
 */
function scanShortenableFields(src) {
  const lines = src.split('\n');
  const fields = [];

  /** stack of context names: 'narration' / 'concepts' / 'choices' / 'punish' / 'followup' / 'other' */
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Open / close array contexts ──────────────────────────
    const opensArray = line.match(/(\b\w+)\s*:\s*\[\s*$/);
    if (opensArray) {
      stack.push(opensArray[1]);
    }
    // A line that contains ONLY a closing `],` or `]` pops the most recent array.
    if (/^\s*\]\s*,?\s*$/.test(line)) {
      stack.pop();
    }

    // ── Detect a shortenable field on this line ──────────────
    // Match `KEY:` (possibly nothing after, possibly `"..."`).
    const fieldMatch = line.match(/^(\s+)(intro|idea|text|whyBad|whyPunish):\s*(.*)$/);
    if (!fieldMatch) continue;

    const indent = fieldMatch[1];
    const key = fieldMatch[2];
    const after = fieldMatch[3];

    // Skip if context disqualifies this field.
    const ctx = stack[stack.length - 1];
    if (key === 'text') {
      // Only shorten `text:` inside a narration array.
      if (ctx !== 'narration') continue;
    } else if (key === 'idea') {
      // Skip if inside a choices array (defensive; shouldn't happen).
      if (ctx === 'choices') continue;
    } else if (key === 'whyBad' || key === 'whyPunish') {
      // Should only ever be inside a punish entry; allow either way.
    } else if (key === 'intro') {
      // Allow at any level; vienna has exactly one (WalkthroughTree top).
    }

    // ── Extract the string value (may span multiple lines) ───
    const extracted = extractStringStarting(lines, i, after);
    if (!extracted) continue;

    fields.push({
      line: i,
      indent,
      key,
      value: extracted.value,
      endLine: extracted.endLine,
    });

    // Skip past consumed lines to avoid re-scanning.
    i = extracted.endLine;
  }

  return fields;
}

/**
 * Starting from `startLine` after the `key:` prefix on that line
 * (already captured in `firstLineAfter`), find the contiguous
 * double-quoted string literal. Handles:
 *
 *   key: "single line",
 *   key:
 *     "value on next line",
 *   key:
 *     "first part " +
 *     "second part",
 *
 * Returns { value, endLine } — `value` is the concatenated string
 * content (without quotes), `endLine` is the index of the last line
 * consumed.
 */
function extractStringStarting(lines, startLine, firstLineAfter) {
  let lineIdx = startLine;
  let cursor = firstLineAfter;
  const parts = [];

  while (lineIdx < lines.length) {
    cursor = cursor.trimStart();
    if (cursor.startsWith('"')) {
      const stringResult = readQuotedString(cursor);
      if (!stringResult) return null;
      parts.push(stringResult.value);
      cursor = stringResult.rest.trimStart();
      // If the rest of the line is `+` (string concat), keep reading next line.
      if (cursor === '+') {
        lineIdx++;
        cursor = lines[lineIdx] ?? '';
        continue;
      }
      // Otherwise we're done; current line is endLine.
      return { value: parts.join(''), endLine: lineIdx };
    }
    if (cursor.length === 0) {
      // Continuation — value starts on next line.
      lineIdx++;
      cursor = lines[lineIdx] ?? '';
      continue;
    }
    // Anything else (e.g. `[`, `{`) means this field doesn't hold a
    // string — bail.
    return null;
  }
  return null;
}

function readQuotedString(text) {
  if (!text.startsWith('"')) return null;
  let i = 1;
  const buf = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      const esc = next === 'n' ? '\n' : next === 't' ? '\t' : next;
      buf.push(esc);
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: buf.join(''), rest: text.slice(i + 1).trim() };
    }
    buf.push(ch);
    i++;
  }
  return null;
}

function escapeForDoubleQuotedTs(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function injectShorts(src, fieldsWithShorts) {
  const lines = src.split('\n');
  // Process in reverse line order so earlier line indices stay valid.
  const sorted = [...fieldsWithShorts].sort((a, b) => b.endLine - a.endLine);
  for (const f of sorted) {
    const shortKey =
      f.key === 'intro' ? 'shortIntro'
      : f.key === 'idea' ? 'shortIdea'
      : f.key === 'text' ? 'shortText'
      : f.key === 'whyBad' ? 'shortWhyBad'
      : f.key === 'whyPunish' ? 'shortWhyPunish'
      : null;
    if (!shortKey) continue;
    const escaped = escapeForDoubleQuotedTs(f.short);
    const newLine = `${f.indent}${shortKey}: "${escaped}",`;
    lines.splice(f.endLine + 1, 0, newLine);
  }
  return lines.join('\n');
}

async function runWithLimit(items, limit, worker) {
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const src = await readFile(TARGET, 'utf-8');
  const fields = scanShortenableFields(src);
  console.log(`[vienna] found ${fields.length} shortenable fields`);
  const counts = fields.reduce((acc, f) => {
    acc[f.key] = (acc[f.key] ?? 0) + 1;
    return acc;
  }, {});
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k}: ${n}`);

  const targets = writeMode ? fields : fields.slice(0, SAMPLE_SIZE);
  console.log(`\n[vienna] generating shorts for ${targets.length} fields (concurrent=${CONCURRENT})\n`);

  const t0 = Date.now();
  let errors = 0;
  await runWithLimit(targets, CONCURRENT, async (f) => {
    try {
      f.short = await compress(f.value);
      if (!f.short || f.short.length === 0) {
        errors++;
        return;
      }
      if (!writeMode) {
        console.log(`  [${f.key}] L${f.line + 1} (${f.value.length}c → ${f.short.length}c)`);
        console.log(`    FULL : ${f.value.slice(0, 200)}${f.value.length > 200 ? '…' : ''}`);
        console.log(`    SHORT: ${f.short}\n`);
      }
    } catch (err) {
      errors++;
      console.log(`  ERR L${f.line + 1} (${f.key}): ${err.message}`);
    }
  });

  console.log(`[vienna] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${errors} errors`);

  if (writeMode) {
    const valid = targets.filter((f) => f.short && f.short.length > 0);
    const written = injectShorts(src, valid);
    await writeFile(TARGET, written);
    console.log(`[vienna] wrote ${valid.length} short fields to ${TARGET}`);
  } else {
    console.log(`[vienna] sample done — re-run with --write to apply to all ${fields.length} fields.`);
  }
}

main().catch((err) => {
  console.error('[vienna] fatal:', err);
  process.exit(1);
});
