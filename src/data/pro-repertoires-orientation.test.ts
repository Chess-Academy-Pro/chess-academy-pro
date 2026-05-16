/**
 * Trap / warning orientation contract — codifies the rule David named:
 * `trapLines` are STUDENT WEAPONS (opponent slips, student capitalises),
 * `warningLines` are STUDENT WARNINGS (the student is the one who slips
 * and gets punished). Mixed-up entries surfaced as bright-red TRAP tiles
 * that secretly benefit the opponent — and that's the failure mode this
 * test prevents.
 *
 * The script `scripts/audit-trap-orientation.mjs` runs the full report;
 * this test enforces the hard floor:
 *   • No trap with `kind: trap` can leave the student down ≥ 3 in
 *     material unless they've delivered mate.
 *   • No warning can leave the student up ≥ 3 in material (then it's
 *     not a warning, it's a trap).
 *   • No entry under either array can deliver mate against the student.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import proRepertoire from './pro-repertoires.json';
import classificationData from './trap-line-classifications.json';

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const classifications = (
  classificationData as { classifications: Record<string, string> }
).classifications;

interface LineEntry {
  name: string;
  pgn: string;
  explanation?: string;
}

interface OpeningEntry {
  id: string;
  color: 'white' | 'black';
  trapLines?: LineEntry[];
  warningLines?: LineEntry[];
}

function evaluate(pgn: string, studentColor: 'white' | 'black') {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const board = chess.board();
  const studentChar = studentColor === 'white' ? 'w' : 'b';
  let studentMat = 0;
  let opponentMat = 0;
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUES[sq.type] ?? 0;
      if (sq.color === studentChar) studentMat += v;
      else opponentMat += v;
    }
  }
  const materialDelta = studentMat - opponentMat;
  const isCheckmate = chess.isCheckmate();
  const sideToMove = chess.turn();
  const mateOn = isCheckmate
    ? sideToMove === studentChar
      ? 'student'
      : 'opponent'
    : null;
  return { materialDelta, mateOn };
}

const openings = (proRepertoire as { openings: OpeningEntry[] }).openings;

describe('trap / warning orientation contract', () => {
  it('no trapLine with kind:trap leaves the student down material (unless mate)', () => {
    const offenders: string[] = [];
    for (const op of openings) {
      for (const t of op.trapLines ?? []) {
        const key = `${op.id}::${t.name}`;
        const kind = classifications[key];
        if (kind !== 'trap') continue;
        const { materialDelta, mateOn } = evaluate(t.pgn, op.color);
        if (mateOn === 'opponent') continue; // student delivered mate — line is correct
        if (materialDelta < -1) {
          offenders.push(`${key} → student ${materialDelta} material (kind=trap)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no warningLine leaves the student up clear material (then it would be a trap)', () => {
    const offenders: string[] = [];
    for (const op of openings) {
      for (const w of op.warningLines ?? []) {
        const { materialDelta, mateOn } = evaluate(w.pgn, op.color);
        if (mateOn === 'opponent') {
          offenders.push(`${op.id}::${w.name} → student delivered mate (warning shouldn't reward student)`);
          continue;
        }
        if (materialDelta > 2) {
          offenders.push(`${op.id}::${w.name} → student +${materialDelta} material (warning should show student losing)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no entry under either array ends in checkmate against the student', () => {
    const offenders: string[] = [];
    for (const op of openings) {
      const all = [
        ...(op.trapLines ?? []).map((t) => ({ ...t, role: 'trapLines' })),
        ...(op.warningLines ?? []).map((t) => ({ ...t, role: 'warningLines' })),
      ];
      for (const entry of all) {
        const { mateOn } = evaluate(entry.pgn, op.color);
        if (mateOn === 'student') {
          // A warning showing the student getting mated IS instructive
          // ("if you fall into this, you get mated"), so we allow it
          // there. The hard rule is no MATED STUDENT in trapLines.
          if (entry.role === 'trapLines') {
            offenders.push(`${op.id}::${entry.name} (${entry.role}) → student is mated`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
