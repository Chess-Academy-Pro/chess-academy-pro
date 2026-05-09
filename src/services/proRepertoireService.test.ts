import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { findTrapTilesForCanonicalLine } from './proRepertoireService';
import { buildTrapWalkthroughTreeFromPgn } from './openingGenerator';

describe('findTrapTilesForCanonicalLine', () => {
  it('surfaces curated traps for the Italian Game bare line', () => {
    // Italian Game's canonical bare PGN is `e4 e5 Nf3 Nc6 Bc4`. The
    // pro-repertoire catalog carries Italian-family traps (Caruana's
    // Italian, Firouzja's Italian, etc.) whose PGN starts with this
    // prefix. The student should see at least one when typing
    // "Italian Game" in the line picker.
    const traps = findTrapTilesForCanonicalLine('e4 e5 Nf3 Nc6 Bc4');
    expect(traps.length).toBeGreaterThan(0);
    for (const t of traps) {
      expect(t.pgn.startsWith('e4 e5 Nf3 Nc6 Bc4')).toBe(true);
      expect(t.trapName.length).toBeGreaterThan(0);
      expect(t.parentOpeningName.length).toBeGreaterThan(0);
      expect(t.explanation.length).toBeGreaterThan(0);
    }
  });

  it('returns [] when no curated traps fall under the canonical line', () => {
    // A bare line nobody has trapLines for. Use a real but obscure
    // line to avoid false positives.
    const traps = findTrapTilesForCanonicalLine('a3 a6 a4 a5');
    expect(traps).toEqual([]);
  });

  it('returns [] for empty / whitespace input', () => {
    expect(findTrapTilesForCanonicalLine('')).toEqual([]);
    expect(findTrapTilesForCanonicalLine('   ')).toEqual([]);
  });

  it('returns [] for too-shallow canonical PGNs (King\'s Pawn Game / Queen\'s Pawn Game etc.)', () => {
    // Production audit (build cca83fb): user typed a family-level
    // parent like "King's Pawn Game" (canonical PGN = `e4`) and the
    // picker drowned in 30+ red TRAP tiles from every B/C-code
    // opening that starts with 1.e4. A 1-3 ply prefix is shared by
    // hundreds of unrelated openings — the prefix match is
    // meaningless that shallow. User: "for real tho, we can't have
    // this." Lock the threshold so it can't regress.
    expect(findTrapTilesForCanonicalLine('e4')).toEqual([]);
    expect(findTrapTilesForCanonicalLine('d4')).toEqual([]);
    expect(findTrapTilesForCanonicalLine('e4 c5')).toEqual([]);
    expect(findTrapTilesForCanonicalLine('e4 e5 Nf3')).toEqual([]);
  });

  it('caps trap tiles at the picker maximum even when many curated traps qualify', () => {
    // Italian Game (5-ply canonical) has 5+ curated trap lines
    // across multiple pro repertoires (Caruana, Firouzja). Without
    // the cap the picker would surface them all and squeeze out the
    // variation tiles. Cap should clip to a single-screen-friendly
    // count.
    const traps = findTrapTilesForCanonicalLine('e4 e5 Nf3 Nc6 Bc4');
    expect(traps.length).toBeGreaterThan(0);
    expect(traps.length).toBeLessThanOrEqual(4);
  });
});

describe('buildTrapWalkthroughTreeFromPgn', () => {
  it('builds a single-spine tree from a legal trap PGN', () => {
    const tree = buildTrapWalkthroughTreeFromPgn({
      trapName: 'Qh4 Blunder Trap',
      parentOpeningName: 'Scotch Game (Naroditsky)',
      eco: 'C45',
      pgn: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Qh4 Nb5',
      explanation:
        'Black goes for Qh4, walking into Nb5 — the knight forks the queen and c7.',
    });
    expect(tree).not.toBeNull();
    if (!tree) return;
    expect(tree.openingName).toBe('Trap: Qh4 Blunder Trap');
    expect(tree.eco).toBe('C45');
    expect(tree.intro).toContain('Qh4 Blunder Trap');
    expect(tree.intro).toContain('Scotch Game (Naroditsky)');
    // Walk the spine — should be 9 plies deep, single-child nodes.
    let count = 0;
    let node = tree.root;
    while (node.children.length > 0) {
      expect(node.children.length).toBe(1);
      node = node.children[0].node;
      count += 1;
    }
    expect(count).toBe(9);
  });

  it('returns null for an illegal trap PGN', () => {
    // Kxe2 is illegal at this position (king on e1, no capture
    // possible) — the builder must reject the line rather than
    // silently truncate or crash.
    const tree = buildTrapWalkthroughTreeFromPgn({
      trapName: 'Bogus',
      parentOpeningName: 'Whatever',
      eco: 'A00',
      pgn: 'e4 e5 Kxe2',
      explanation: 'noop',
    });
    expect(tree).toBeNull();
  });

  it('every curated trap line builds a legal walkthrough tree', () => {
    // Whole-catalog regression: if any pro-repertoire trap PGN ever
    // becomes illegal (e.g. typo introduced), this fires.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const data = require('../data/pro-repertoires.json') as {
      openings: Array<{
        eco: string;
        name: string;
        trapLines?: Array<{ name: string; pgn: string; explanation: string }>;
      }>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const failures: string[] = [];
    for (const op of data.openings) {
      if (!op.trapLines) continue;
      for (const t of op.trapLines) {
        const tree = buildTrapWalkthroughTreeFromPgn({
          trapName: t.name,
          parentOpeningName: op.name,
          eco: op.eco,
          pgn: t.pgn,
          explanation: t.explanation,
        });
        if (!tree) {
          failures.push(`${op.name} / ${t.name}: tree builder returned null`);
          continue;
        }
        // Replay the spine to confirm chess.js accepts every move.
        const c = new Chess();
        let node = tree.root;
        try {
          while (node.children.length > 0) {
            node = node.children[0].node;
            if (node.san) c.move(node.san);
          }
        } catch (err) {
          failures.push(`${op.name} / ${t.name}: replay threw: ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
