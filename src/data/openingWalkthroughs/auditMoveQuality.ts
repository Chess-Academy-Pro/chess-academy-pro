/**
 * Stockfish-backed move quality audit for opening walkthrough trees.
 *
 * Runs Stockfish (depth 16, multiPV 5) on every non-leaf position
 * in every registered tree and flags any played move that isn't in
 * the engine's top 5 OR is more than 50 centipawns worse than the
 * best move. Catches the kind of mistake that chess.js legality
 * checks miss — like 4.Nf3 instead of 4.e5 in the Vienna Gambit
 * accepted line (both legal, but the move-order matters).
 *
 * NOT part of the regular test suite — too slow (~30-90s per tree).
 * Run via `npm run audit:openings` before shipping a new opening
 * (or after editing an existing one).
 *
 * Usage:
 *   npx tsx src/data/openingWalkthroughs/auditMoveQuality.ts
 *   npx tsx src/data/openingWalkthroughs/auditMoveQuality.ts vienna
 *   npx tsx src/data/openingWalkthroughs/auditMoveQuality.ts --depth 20
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Chess } from 'chess.js';
import { resolveWalkthroughTree, listAvailableWalkthroughs } from './index';
import type {
  WalkthroughTree,
  WalkthroughTreeNode,
} from '../../types/walkthroughTree';

interface EngineMove {
  /** SAN of the move. */
  san: string;
  /** Centipawn score from the side-to-move's POV. Positive = good
   *  for the side to move. Mate scores are flattened to ±100000. */
  cp: number;
}

interface AuditIssue {
  /** SAN path from root to the parent node where this move was played. */
  path: string[];
  /** The played SAN (the move that's flagged). */
  played: string;
  /** Stockfish's top moves at this position, sorted best-first. */
  top: EngineMove[];
  /** Severity of the issue. */
  severity: 'error' | 'warning';
  /** Human-readable explanation. */
  message: string;
}

/** Depth used for engine analysis. Higher = more accurate but slower.
 *  18 is the sweet spot for opening positions — catches subtle theory
 *  issues that depth 16 misses, without the diminishing returns of
 *  depth 20+. Beyond 24 is overkill for opening audits (mostly refines
 *  CP scores by ±10 points without changing best-move identity).
 *  Override with --depth N for ad-hoc deeper checks. */
const DEFAULT_DEPTH = 18;

/** A move is flagged ERROR if it loses more than this many cp vs best. */
const ERROR_CP_THRESHOLD = 100;

/** A move is flagged WARNING if it loses more than this many cp vs best. */
const WARNING_CP_THRESHOLD = 50;

/** How many top moves to ask Stockfish for. */
const MULTIPV = 5;

class StockfishEngine {
  private proc: ChildProcess;
  private buffer = '';

  constructor() {
    this.proc = spawn(
      'node',
      ['node_modules/stockfish/bin/stockfish-18-single.js'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
    });
    this.proc.stderr?.on('data', (_data: Buffer) => {
      // Engine occasionally writes warnings to stderr; ignore.
    });
  }

  async init(): Promise<void> {
    await this.send('uci');
    await this.waitFor('uciok');
    await this.send(`setoption name MultiPV value ${MULTIPV}`);
    await this.send('setoption name Hash value 64');
    await this.send('isready');
    await this.waitFor('readyok');
  }

  async analyze(fen: string, depth: number): Promise<EngineMove[]> {
    this.buffer = '';
    await this.send(`position fen ${fen}`);
    await this.send(`go depth ${depth}`);
    const output = await this.waitFor(/^bestmove/m, 60_000);

    // Parse multipv lines for the deepest depth that completed.
    // Stockfish prints info lines for each depth & multipv slot;
    // we want the LAST batch (deepest depth's multipv 1..N).
    const lines = output.split('\n');
    const byPv = new Map<number, EngineMove>();
    let maxDepthSeen = 0;
    for (const line of lines) {
      const m = line.match(
        /^info .*?\bdepth (\d+)\b(?:.*\bseldepth \d+)?(?:.*\bmultipv (\d+))?(?:.*\bscore (cp|mate) (-?\d+))?(?:.*\bpv (\S+))/,
      );
      if (!m) continue;
      const d = Number(m[1]);
      const pv = m[2] ? Number(m[2]) : 1;
      const scoreType = m[3];
      const score = m[4] ? Number(m[4]) : 0;
      const uci = m[5];
      if (!uci) continue;

      if (d > maxDepthSeen) {
        // New depth — clear the previous map.
        byPv.clear();
        maxDepthSeen = d;
      }
      if (d < maxDepthSeen) continue;

      // Convert UCI to SAN by replaying on a probe board.
      let san: string;
      try {
        const probe = new Chess(fen);
        const result = probe.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        san = result.san;
      } catch {
        continue;
      }
      const cp =
        scoreType === 'mate'
          ? score > 0
            ? 100000
            : -100000
          : score;
      byPv.set(pv, { san, cp });
    }

    const moves = [...byPv.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, mv]) => mv);
    return moves;
  }

  quit(): void {
    try {
      this.proc.stdin?.write('quit\n');
    } catch {
      // ignore
    }
    this.proc.kill();
  }

  private send(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc.stdin?.write(`${cmd}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async waitFor(
    needle: string | RegExp,
    timeoutMs = 30_000,
  ): Promise<string> {
    const start = this.buffer.length;
    const startTs = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        const recent = this.buffer.slice(start);
        const hit =
          typeof needle === 'string'
            ? recent.includes(needle)
            : needle.test(recent);
        if (hit) {
          resolve(recent);
          return;
        }
        if (Date.now() - startTs > timeoutMs) {
          reject(new Error(`waitFor timeout for ${needle.toString()}`));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }
}

function fenForPath(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

async function auditNode(
  node: WalkthroughTreeNode,
  pathSans: string[],
  engine: StockfishEngine,
  depth: number,
  issues: AuditIssue[],
): Promise<void> {
  // Need to evaluate the position AT THIS NODE — i.e. what white/black
  // chose AT this node's children. So we analyze fen-at-this-node and
  // check each child's SAN against the engine's top-N picks.
  if (node.children.length > 0) {
    const fen = fenForPath(pathSans);
    process.stdout.write('.');
    const top = await engine.analyze(fen, depth);
    for (const child of node.children) {
      const playedSan = child.node.san;
      if (!playedSan) continue;
      const idx = top.findIndex((m) => m.san === playedSan);
      if (idx < 0) {
        issues.push({
          path: [...pathSans, playedSan],
          played: playedSan,
          top,
          severity: 'error',
          message: `move "${playedSan}" not in Stockfish top ${MULTIPV}; top moves: ${top
            .map((m) => `${m.san}(${m.cp})`)
            .join(', ')}`,
        });
        continue;
      }
      const playedScore = top[idx].cp;
      const bestScore = top[0].cp;
      const diff = bestScore - playedScore;
      if (diff > ERROR_CP_THRESHOLD) {
        issues.push({
          path: [...pathSans, playedSan],
          played: playedSan,
          top,
          severity: 'error',
          message: `move "${playedSan}" is ${diff}cp worse than best; best is ${top[0].san} at ${bestScore}cp, played at ${playedScore}cp`,
        });
      } else if (diff > WARNING_CP_THRESHOLD) {
        issues.push({
          path: [...pathSans, playedSan],
          played: playedSan,
          top,
          severity: 'warning',
          message: `move "${playedSan}" is ${diff}cp worse than best (${top[0].san} ${bestScore}cp vs ${playedScore}cp)`,
        });
      }
    }
  }
  // Recurse.
  for (const child of node.children) {
    if (!child.node.san) continue;
    await auditNode(
      child.node,
      [...pathSans, child.node.san],
      engine,
      depth,
      issues,
    );
  }
}

async function auditTree(
  tree: WalkthroughTree,
  depth: number,
): Promise<AuditIssue[]> {
  const engine = new StockfishEngine();
  await engine.init();
  const issues: AuditIssue[] = [];
  try {
    await auditNode(tree.root, [], engine, depth, issues);
  } finally {
    engine.quit();
  }
  return issues;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let depth = DEFAULT_DEPTH;
  const trees: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--depth') {
      depth = Number(args[i + 1]);
      i += 1;
    } else {
      trees.push(args[i]);
    }
  }

  const targets =
    trees.length > 0
      ? trees
      : listAvailableWalkthroughs().map((w) => w.name);

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const name of targets) {
    const tree = resolveWalkthroughTree(name);
    if (!tree) {
       
      console.log(`Skipping "${name}" — no tree registered`);
      continue;
    }
     
    console.log(
      `\nAuditing ${tree.openingName} (${tree.eco}) at depth ${depth}…`,
    );
    const t0 = Date.now();
    const issues = await auditTree(tree, depth);
    const t1 = Date.now();
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;
     
    console.log(
      `\n  ${errors.length} errors, ${warnings.length} warnings (${((t1 - t0) / 1000).toFixed(1)}s)`,
    );
    for (const issue of issues) {
      const tag =
        issue.severity === 'error' ? 'ERROR' : 'warn ';
       
      console.log(`  [${tag}] ${issue.path.join(' ')}`);
       
      console.log(`           ${issue.message}`);
    }
  }

   
  console.log(
    `\n=== AUDIT COMPLETE: ${totalErrors} errors, ${totalWarnings} warnings ===`,
  );
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Audit failed:', err);
  process.exit(2);
});
