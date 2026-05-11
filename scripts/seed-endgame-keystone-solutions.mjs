#!/usr/bin/env node
/**
 * seed-endgame-keystone-solutions
 * --------------------------------
 * Backfills `solution[]` (and `bestMove` when missing) on the
 * hand-authored endgame keystone positions by running local
 * Stockfish at depth 25 and recording the principal variation
 * (capped at ~12 plies).
 *
 * Architectural contract: positions and moves come from a DB.
 * Here the "DB" is Stockfish at depth 25 — mathematically rigorous
 * for the ≤7-piece tablebase positions in our catalog, and
 * within-an-engine-skill-tier for the larger ones. Every move is
 * replay-checked via chess.js before being written.
 *
 * Skips:
 *   - Positions that already have a `solution[]`.
 *   - Positions with `auditSkip` (documented engine-eval exemptions).
 *
 * Usage:
 *   node scripts/seed-endgame-keystone-solutions.mjs            # full sweep
 *   node scripts/seed-endgame-keystone-solutions.mjs --depth=20 # shallower
 *   node scripts/seed-endgame-keystone-solutions.mjs --max-plies=10
 *   node scripts/seed-endgame-keystone-solutions.mjs --dry-run  # print only
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'src/data');

const CATALOGS = [
  'endgame-principles.json',
  'pawn-endings.json',
  'drawn-patterns.json',
  'rook-endings.json',
];

function parseArg(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const v = arg.split('=')[1];
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : v;
}
const DEPTH = parseArg('depth', 25);
const MAX_PLIES = parseArg('max-plies', 12);
const DRY_RUN = process.argv.includes('--dry-run');

class Stockfish {
  constructor() {
    this.proc = spawn(
      'node',
      ['node_modules/stockfish/bin/stockfish-18-lite-single.js'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.buffer = '';
    this.proc.stdout.on('data', (d) => {
      this.buffer += d.toString();
    });
    this.proc.stderr.on('data', () => {});
  }
  send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }
  async waitFor(re, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (re.test(this.buffer)) return this.buffer;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Stockfish timeout waiting for ${re}`);
  }
  async init() {
    this.send('uci');
    await this.waitFor(/^uciok/m);
    this.send('setoption name Hash value 64');
    this.send('isready');
    await this.waitFor(/^readyok/m);
  }
  /** Compute the principal variation at the given depth. Returns
   *  a space-separated UCI string (e.g. "b8c7 a2f2 b7b8q"). */
  async pv(fen, depth) {
    this.buffer = '';
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    await this.waitFor(/^bestmove/m, 120_000);
    const lines = this.buffer.split('\n');
    let bestPv = '';
    let maxDepth = 0;
    for (const line of lines) {
      const dm = line.match(/^info .*?\bdepth (\d+)\b/);
      if (!dm) continue;
      const d = Number(dm[1]);
      if (d < maxDepth) continue;
      const pvm = line.match(/\bpv\s+(.+?)$/);
      if (!pvm) continue;
      maxDepth = d;
      bestPv = pvm[1].trim();
    }
    return bestPv;
  }
  quit() {
    this.send('quit');
    this.proc.kill();
  }
}

/** Convert a UCI PV string to a SAN array, replay-checked against
 *  chess.js. Returns null when the conversion fails (illegal move,
 *  malformed PV). */
function uciToSanArray(startFen, uciPv) {
  const chess = new Chess(startFen);
  const sans = [];
  const ucis = uciPv.split(/\s+/).filter(Boolean);
  for (const uci of ucis) {
    if (uci.length < 4) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length >= 5 ? uci[4] : undefined;
    try {
      const m = chess.move({ from, to, promotion });
      sans.push(m.san);
    } catch {
      return null;
    }
  }
  return sans;
}

async function main() {
  const sf = new Stockfish();
  await sf.init();
  console.log(`Stockfish ready. Depth=${DEPTH}, max-plies=${MAX_PLIES}, dry-run=${DRY_RUN}`);

  let totalScanned = 0;
  let totalUpdated = 0;
  for (const catalogFile of CATALOGS) {
    const fp = path.join(DATA, catalogFile);
    const lessons = JSON.parse(fs.readFileSync(fp, 'utf8'));
    let dirty = false;
    for (const lesson of lessons) {
      for (const pos of lesson.positions) {
        totalScanned += 1;
        if (pos.solution && pos.solution.length > 0) continue;
        if (pos.auditSkip) {
          console.log(`  SKIP (auditSkip): ${lesson.id} - ${pos.title}`);
          continue;
        }
        const pv = await sf.pv(pos.fen, DEPTH);
        if (!pv) {
          console.log(`  NO-PV: ${lesson.id} - ${pos.title}`);
          continue;
        }
        const sans = uciToSanArray(pos.fen, pv);
        if (!sans || sans.length === 0) {
          console.log(`  PARSE-FAIL: ${lesson.id} - ${pos.title}`);
          continue;
        }
        const trimmed = sans.slice(0, MAX_PLIES);
        // Skip if the very first move is the only one we got AND
        // bestMove already covers it — no value-add.
        if (trimmed.length === 1 && pos.bestMove && pos.bestMove === trimmed[0]) {
          console.log(`  ALREADY-COVERED: ${lesson.id} - ${pos.title}`);
          continue;
        }
        pos.solution = trimmed;
        if (!pos.bestMove) pos.bestMove = trimmed[0];
        dirty = true;
        totalUpdated += 1;
        console.log(
          `  + ${lesson.id} - ${pos.title}: ${trimmed.length} plies (${trimmed.slice(0, 5).join(' ')}${trimmed.length > 5 ? ' …' : ''})`,
        );
      }
    }
    if (dirty && !DRY_RUN) {
      fs.writeFileSync(fp, JSON.stringify(lessons, null, 2) + '\n');
      console.log(`  → wrote ${catalogFile}`);
    } else if (dirty) {
      console.log(`  (dry-run, would write ${catalogFile})`);
    }
  }
  sf.quit();
  console.log(`\nDone. Scanned ${totalScanned}, updated ${totalUpdated}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
