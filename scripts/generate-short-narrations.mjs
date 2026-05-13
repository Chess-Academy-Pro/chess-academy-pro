#!/usr/bin/env node
/**
 * Compresses each hand-written `narration` / `annotation` in
 * src/data/annotations/*.json down to a one-sentence `shortNarration`
 * via DeepSeek. Sample mode by default — picks 20 narrations across
 * length buckets and prints a before/after preview to stdout, no
 * writes. Pass `--write` to apply to every annotation in every file.
 *
 * Usage:
 *   node scripts/generate-short-narrations.mjs                  # 20-sample preview
 *   node scripts/generate-short-narrations.mjs --write          # full pass + commit
 *   node scripts/generate-short-narrations.mjs --sample=50      # bigger sample preview
 *   node scripts/generate-short-narrations.mjs --file=vienna-gambit.json --write
 *
 * Cost: ~$1–3 total for the full pass at ~200 input + 30 output
 * tokens per call against deepseek-chat. Sample mode is < $0.01.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';

const ROOT = process.cwd();
const ANNOT_DIR = join(ROOT, 'src/data/annotations');

const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const sampleArg = args.find((a) => a.startsWith('--sample='));
const SAMPLE_SIZE = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : 20;
const fileFilter = args.find((a) => a.startsWith('--file='))?.split('=')[1];
const concurrentArg = args.find((a) => a.startsWith('--concurrent='));
const CONCURRENT = concurrentArg ? parseInt(concurrentArg.split('=')[1], 10) : 8;

// Load .env.local manually (no dotenv dep)
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

const FEW_SHOT = [
  {
    role: 'user',
    content:
      "Black thinks the knight on g4 is 'active' — eyeing f2, supporting a future Qh4+ check. But Black missed a critical fact: when the f-pawn left f2 (way back on move 3), the d1-queen got an open diagonal pointing right at the kingside. d1 → e2 → f3 → g4 — every square empty. The knight on g4 is just a piece sitting at the end of that diagonal with NO defender. The 'active retreat' is actually an active hang.",
  },
  {
    role: 'assistant',
    content:
      "Black's 'active' knight on g4 hangs to the queen along the now-open d1–g4 diagonal.",
  },
  {
    role: 'user',
    content:
      "Material is even — you traded the bishop for the pawn, then Black recovered the knight with the d5 fork. Black walked out with the bishop pair (a small long-term plus). We've now reached the typical center fork trick middlegame: opposite-side castled kings (white short, black long), Black's bishop pair vs White's piece coordination.",
  },
  {
    role: 'assistant',
    content:
      'Material is even but Black has the bishop pair after the d5 fork — opposite-side castled kings, play breaks open around d4.',
  },
  {
    role: 'user',
    content: '1.e4 — White claims the center and opens lines for the queen and bishop.',
  },
  {
    role: 'assistant',
    content: '1.e4 claims the center and opens lines for the queen and bishop.',
  },
];

async function compress(narration) {
  const resp = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...FEW_SHOT,
      { role: 'user', content: narration },
    ],
    max_tokens: 80,
    temperature: 0.3,
  });
  return resp.choices[0]?.message?.content?.trim() ?? '';
}

function collectNarrations(doc, filename) {
  const items = [];
  const walk = (arr, parentPath) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (!a || typeof a !== 'object') continue;
      const fullText = a.narration ?? a.annotation ?? '';
      if (fullText && typeof fullText === 'string' && fullText.trim().length > 0) {
        items.push({
          file: filename,
          path: [...parentPath, i],
          san: a.san,
          fullText,
          hasShort: typeof a.shortNarration === 'string' && a.shortNarration.trim().length > 0,
        });
      }
    }
  };
  walk(doc.moveAnnotations, ['moveAnnotations']);
  if (Array.isArray(doc.subLines)) {
    for (let s = 0; s < doc.subLines.length; s++) {
      const sub = doc.subLines[s];
      if (sub && Array.isArray(sub.moveAnnotations)) {
        walk(sub.moveAnnotations, ['subLines', s, 'moveAnnotations']);
      }
    }
  }
  return items;
}

function listAnnotationFiles() {
  const files = readdirSync(ANNOT_DIR).filter((n) => n.endsWith('.json'));
  return fileFilter ? files.filter((f) => f === fileFilter) : files;
}

function pickSample(allItems, n) {
  // Stratify by length so the preview spans the actual distribution.
  const buckets = {
    short: allItems.filter((x) => x.fullText.length < 200),
    medium: allItems.filter((x) => x.fullText.length >= 200 && x.fullText.length < 450),
    long: allItems.filter((x) => x.fullText.length >= 450 && x.fullText.length < 700),
    xlong: allItems.filter((x) => x.fullText.length >= 700),
  };
  const perBucket = Math.ceil(n / 4);
  const out = [];
  for (const key of Object.keys(buckets)) {
    const b = buckets[key];
    // Deterministic pseudo-random: pick evenly spaced indices.
    const step = Math.max(1, Math.floor(b.length / perBucket));
    for (let i = 0; i < b.length && out.length < (Object.keys(buckets).indexOf(key) + 1) * perBucket; i += step) {
      out.push({ bucket: key, ...b[i] });
    }
  }
  return out.slice(0, n);
}

function setByPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

function getByPath(obj, path) {
  let cur = obj;
  for (const k of path) cur = cur[k];
  return cur;
}

async function loadAllItems() {
  const files = listAnnotationFiles();
  const all = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(await readFile(join(ANNOT_DIR, f), 'utf-8'));
      all.push(...collectNarrations(doc, f));
    } catch {
      /* skip bad json */
    }
  }
  return all;
}

async function runSample() {
  const all = await loadAllItems();
  const sample = pickSample(
    all.filter((x) => !x.hasShort),
    SAMPLE_SIZE,
  );
  console.log(`[sample] catalog=${all.length} narrations across ${listAnnotationFiles().length} files`);
  console.log(`[sample] previewing ${sample.length} compressions\n`);
  for (let i = 0; i < sample.length; i++) {
    const item = sample[i];
    process.stdout.write(`[${i + 1}/${sample.length}] ${item.file} ${item.san ?? ''} (${item.bucket}, ${item.fullText.length}c) ... `);
    try {
      const short = await compress(item.fullText);
      console.log(`${short.length}c`);
      console.log(`  FULL : ${item.fullText.slice(0, 240)}${item.fullText.length > 240 ? '…' : ''}`);
      console.log(`  SHORT: ${short}`);
      console.log();
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }
  console.log('\n[sample] done — review the SHORT entries above and tell me if quality is right.');
  console.log('[sample] re-run with --write to apply to every annotation across all files.');
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

async function runWrite() {
  const files = listAnnotationFiles();
  console.log(`[write] processing ${files.length} files (concurrent=${CONCURRENT})`);
  const t0 = Date.now();
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let filesDone = 0;
  for (const f of files) {
    const path = join(ANNOT_DIR, f);
    let doc;
    try {
      doc = JSON.parse(await readFile(path, 'utf-8'));
    } catch (err) {
      console.log(`  ${f}: SKIP (bad json: ${err.message})`);
      continue;
    }
    const items = collectNarrations(doc, f);
    if (items.length === 0) {
      filesDone++;
      continue;
    }
    const todo = items.filter((x) => !x.hasShort);
    const skipped = items.length - todo.length;
    let wrote = 0;
    let errs = 0;
    await runWithLimit(todo, CONCURRENT, async (item) => {
      try {
        const short = await compress(item.fullText);
        if (!short || short.length === 0) {
          errs++;
          return;
        }
        const parent = getByPath(doc, item.path.slice(0, -1));
        parent[item.path[item.path.length - 1]].shortNarration = short;
        wrote++;
      } catch (err) {
        errs++;
        if (errs <= 3) console.log(`    ERR ${item.san ?? '?'}: ${err.message}`);
      }
    });
    if (wrote > 0) {
      await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
    }
    filesDone++;
    const pct = ((filesDone / files.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  [${pct}% ${elapsed}s] ${f}: +${wrote} shorts (${skipped} preexisting, ${errs} errors)`);
    totalWritten += wrote;
    totalSkipped += skipped;
    totalErrors += errs;
  }
  console.log(
    `\n[write] done in ${((Date.now() - t0) / 60000).toFixed(1)} min — wrote ${totalWritten}, skipped ${totalSkipped} (already had shorts), errors ${totalErrors}`,
  );
}

if (writeMode) {
  await runWrite();
} else {
  await runSample();
}
