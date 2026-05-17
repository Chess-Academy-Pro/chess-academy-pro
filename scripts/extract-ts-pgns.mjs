#!/usr/bin/env tsx
/**
 * extract-ts-pgns.mjs — pull PGN-shaped data out of TypeScript content
 * files into a JSON sidecar the audit pipeline can consume.
 *
 * Sources (all TS — can't be read by audit-pgn-vs-masters.mjs's plain
 * JSON loader):
 *   1. src/data/openingWalkthroughs/vienna.ts — hand-crafted Vienna
 *      WalkthroughTree (root→leaf paths = PGNs).
 *   2. src/data/guidedGames.ts — kid-mode tutorial games (each with
 *      startFen + moves[]).
 *
 * Output: audit-reports/ts-extracted-pgns.json with shape
 *   [{ source, role, name, openingId?, startFen?, pgn, color? }, ...]
 *
 * Run via tsx (TypeScript loader, no compile step):
 *   npx tsx scripts/extract-ts-pgns.mjs
 *
 * The audit script reads this JSON like any other source file.
 *
 * Endgame TS files (journeyChapters, fairyTaleChapters) are NOT
 * extracted here — they're endgame puzzles with tablebase reference,
 * different audit semantics.
 */
import { VIENNA_GAME } from '../src/data/openingWalkthroughs/vienna.ts';
import { GUIDED_GAMES } from '../src/data/guidedGames.ts';
import { writeFile, mkdir } from 'node:fs/promises';

await mkdir('audit-reports', { recursive: true });

const entries = [];

// ─── Walk the Vienna WalkthroughTree → flat root-to-leaf paths ─────
// Shape: WalkthroughTreeNode has children: WalkthroughTreeChild[];
// each WalkthroughTreeChild wraps a `node: WalkthroughTreeNode` plus
// optional `label`/`forkSubtitle` for branch tap-targets.
function walkNode(node, pathSans, branchPath) {
  const san = node.san;
  const nextPath = san ? [...pathSans, san] : pathSans;
  if (!node.children || node.children.length === 0) {
    if (nextPath.length > 0) {
      entries.push({
        source: 'openingWalkthroughs/vienna.ts',
        role: 'walkthrough-tree-path',
        openingId: 'vienna-game',
        name: branchPath.length ? branchPath.join(' → ') : 'Vienna trunk',
        pgn: nextPath.join(' '),
        color: 'white',
      });
    }
    return;
  }
  for (const child of node.children) {
    const childLabel = child.label;
    const nextBranch = childLabel ? [...branchPath, childLabel] : branchPath;
    walkNode(child.node, nextPath, nextBranch);
  }
}
walkNode(VIENNA_GAME.root, [], []);
const viennaTreeCount = entries.length;
console.log(`[extract] vienna.ts (tree paths): ${viennaTreeCount}`);

// Vienna also has 5 punish lessons each with setupMoves[] (the spine
// leading to the bad position) + punishment[] (the refutation).
// Concatenate setupMoves + punishment SANs to get a full PGN.
let viennaPunishCount = 0;
for (const p of VIENNA_GAME.punish ?? []) {
  const setup = p.setupMoves ?? [];
  // punishment can be either a single SAN string or an array
  const punSans = Array.isArray(p.punishment)
    ? p.punishment
    : (typeof p.punishment === 'string' ? [p.punishment] : []);
  const full = [...setup, ...punSans];
  if (full.length === 0) continue;
  entries.push({
    source: 'openingWalkthroughs/vienna.ts',
    role: 'vienna-punish',
    openingId: 'vienna-game',
    name: p.name,
    pgn: full.join(' '),
    color: 'white',
  });
  viennaPunishCount++;
}
console.log(`[extract] vienna.ts (punish lessons): ${viennaPunishCount}`);

// Drill lessons also have moves arrays
let viennaDrillCount = 0;
for (const d of VIENNA_GAME.drill ?? []) {
  const moves = (d.moves ?? d.line ?? []).map((m) => typeof m === 'string' ? m : m.san).filter(Boolean);
  if (moves.length === 0) continue;
  entries.push({
    source: 'openingWalkthroughs/vienna.ts',
    role: 'vienna-drill',
    openingId: 'vienna-game',
    name: d.name ?? d.title ?? '(drill)',
    pgn: moves.join(' '),
    color: 'white',
  });
  viennaDrillCount++;
}
console.log(`[extract] vienna.ts (drill lessons): ${viennaDrillCount}`);

// ─── GuidedGames: flat moves arrays starting from startFen ─────────
let guidedCount = 0;
for (const game of GUIDED_GAMES) {
  const moves = (game.moves ?? []).map((m) => m.san).filter(Boolean);
  if (moves.length === 0) continue;
  entries.push({
    source: 'guidedGames.ts',
    role: 'guided-game',
    openingId: game.id,
    name: game.title,
    startFen: game.startFen,
    pgn: moves.join(' '),
    color: game.playerColor === 'w' ? 'white' : 'black',
  });
  guidedCount++;
}
console.log(`[extract] guidedGames.ts: ${guidedCount} games`);

console.log(`[extract] total PGN entries extracted: ${entries.length}`);

await writeFile(
  'audit-reports/ts-extracted-pgns.json',
  JSON.stringify(entries, null, 2) + '\n',
);
console.log('[extract] wrote audit-reports/ts-extracted-pgns.json');
