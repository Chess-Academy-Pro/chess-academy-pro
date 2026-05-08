import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import proRepertoire from './pro-repertoires.json';

interface ProOpeningEntry {
  id: string;
  playerId: string;
  name: string;
  pgn: string;
  variations?: { name: string; pgn: string }[];
  trapLines?: { name: string; pgn: string }[];
  warningLines?: { name: string; pgn: string }[];
}

function validatePgn(pgn: string): Chess {
  const chess = new Chess();
  const moves = pgn.trim().split(/\s+/);
  for (let i = 0; i < moves.length; i++) {
    try {
      chess.move(moves[i]);
    } catch {
      throw new Error(`Illegal move "${moves[i]}" at half-move ${i + 1} in: ${pgn}`);
    }
  }
  return chess;
}

const entries = proRepertoire.openings as ProOpeningEntry[];

describe('Pro Repertoire PGN Legality', () => {
  describe.each(entries)('$name ($id)', (entry) => {
    it('main line is legal', () => {
      expect(() => validatePgn(entry.pgn)).not.toThrow();
    });

    if (entry.variations) {
      it.each(entry.variations)('variation "$name" is legal', (variation) => {
        expect(() => validatePgn(variation.pgn)).not.toThrow();
      });
    }

    if (entry.trapLines) {
      it.each(entry.trapLines)('trap line "$name" is legal', (line) => {
        expect(() => validatePgn(line.pgn)).not.toThrow();
      });
    }

    if (entry.warningLines) {
      it.each(entry.warningLines)('warning line "$name" is legal', (line) => {
        expect(() => validatePgn(line.pgn)).not.toThrow();
      });
    }
  });

  it('has all 14 players', () => {
    expect(proRepertoire.players).toHaveLength(14);
  });

  it('has 79 openings total', () => {
    expect(proRepertoire.openings).toHaveLength(80);
  });

  it('every opening has a valid playerId', () => {
    const playerIds = new Set(proRepertoire.players.map((p) => p.id));
    for (const opening of entries) {
      expect(playerIds.has(opening.playerId)).toBe(true);
    }
  });

  it('every player has at least 3 openings', () => {
    const counts: Record<string, number> = {};
    for (const opening of entries) {
      counts[opening.playerId] = (counts[opening.playerId] ?? 0) + 1;
    }
    for (const player of proRepertoire.players) {
      expect(counts[player.id]).toBeGreaterThanOrEqual(3);
    }
  });

  it('every opening id starts with pro-', () => {
    for (const opening of entries) {
      expect(opening.id).toMatch(/^pro-/);
    }
  });
});

describe('Pro Repertoire Trap Line Quality', () => {
  it('no opening has duplicate trap-line names', () => {
    const dupes: string[] = [];
    for (const op of entries) {
      if (!op.trapLines) continue;
      const seen = new Map<string, number>();
      for (const t of op.trapLines) {
        seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
      }
      for (const [name, count] of seen) {
        if (count > 1) dupes.push(`${op.id}: "${name}" appears ${count} times`);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every trap line is at least 6 plies long', () => {
    // A trap by definition has setup → bait → spring → win-material.
    // Six plies (3 full moves per side) is the minimum credible
    // length; anything shorter is a tactical motif, not a trap line.
    const offenders: string[] = [];
    for (const op of entries) {
      if (!op.trapLines) continue;
      for (const t of op.trapLines) {
        const tPlies = t.pgn.trim().split(/\s+/).filter(Boolean).length;
        if (tPlies < 6) {
          offenders.push(`${op.id} / ${t.name}: only ${tPlies} plies`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every trap line shares a legal opening prefix with the main line or a variation', () => {
    // A trap line is meant to live INSIDE the opening's tree. If its
    // first 2 plies don't agree with the main line OR any variation,
    // it's filed under the wrong opening. (We compare 2 plies — the
    // ECO root — rather than the full main pgn so deviations don't
    // false-flag legitimate sub-variations.)
    const offenders: string[] = [];
    for (const op of entries) {
      if (!op.trapLines) continue;
      const acceptablePrefixes = new Set<string>();
      const mainTokens = op.pgn.trim().split(/\s+/).filter(Boolean);
      acceptablePrefixes.add(mainTokens.slice(0, 2).join(' '));
      for (const v of op.variations ?? []) {
        const vTokens = v.pgn.trim().split(/\s+/).filter(Boolean);
        acceptablePrefixes.add(vTokens.slice(0, 2).join(' '));
      }
      for (const t of op.trapLines) {
        const trapPrefix = t.pgn.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
        if (!acceptablePrefixes.has(trapPrefix)) {
          offenders.push(`${op.id} / ${t.name}: trap prefix "${trapPrefix}" not in opening's tree`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
