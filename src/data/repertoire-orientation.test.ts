/**
 * Trap / warning orientation contract for src/data/repertoire.json.
 *
 * Mirrors pro-repertoires-orientation.test.ts but covers the larger,
 * older repertoire.json data source. Unlike pro-repertoires, this file
 * has no kind-classification sidecar — every trapLine is treated as
 * kind=trap (forced tactical material gain).
 *
 * The contract: every flagged entry must either
 *   (a) pass the audit (no flags), or
 *   (b) appear in repertoire-orientation-baseline.json's allowlist
 *       with at least the same flag categories it raised.
 *
 * The allowlist is a working baseline — it shrinks as phases of
 * docs/plans/2026-05-16-trap-orientation.md ship. Adding new flagged
 * entries (not already allowlisted) fails CI immediately.
 *
 * Hard-fail rule (no allowlist escape):
 *   • PGN_PARSE_ERROR — broken PGNs always fail.
 *
 * Everything else is allowlist-gated for now. Phase 5 deletes this
 * test's allowlist mechanism and the test becomes pure hard-fail.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import repertoireData from './repertoire.json';
import baselineData from './repertoire-orientation-baseline.json';
import openingsDb from './openings-lichess.json';

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

interface LineEntry {
  name: string;
  pgn: string;
}

interface RepertoireEntry {
  id: string;
  color: 'white' | 'black';
  trapLines?: LineEntry[];
  warningLines?: LineEntry[];
}

interface BaselineFile {
  description?: string;
  allowlist: Record<string, string[]>;
}

const repertoire = repertoireData as RepertoireEntry[];
const baseline = (baselineData as BaselineFile).allowlist;

// Build a Set of every PGN prefix that exists in the canonical
// openings DB. PGN_NOT_IN_DB fires when a trap line's first 6 plies
// can't be anchored anywhere in this set — i.e. the spine is invented.
const dbArr = openingsDb as Array<{ pgn?: string }>;
const dbPrefixSet = new Set<string>();
for (const e of dbArr) {
  if (!e?.pgn) continue;
  const moves = e.pgn.split(' ');
  for (let k = 1; k <= moves.length; k++) {
    dbPrefixSet.add(moves.slice(0, k).join(' '));
  }
}

function longestDbAnchorPly(pgn: string): number {
  const moves = pgn.split(' ');
  for (let k = moves.length; k >= 1; k--) {
    if (dbPrefixSet.has(moves.slice(0, k).join(' '))) return k;
  }
  return 0;
}

interface EvalResult {
  flags: string[];
  materialDelta: number;
  lastMoverIs: 'student' | 'opponent' | null;
  dbAnchorPly: number;
}

function evaluateLine(
  pgn: string,
  studentColor: 'white' | 'black',
  role: 'trap' | 'warning',
): EvalResult {
  const chess = new Chess();
  const flags: string[] = [];
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    flags.push(`PGN_PARSE_ERROR: ${msg.slice(0, 100)}`);
    return { flags, materialDelta: 0, lastMoverIs: null, dbAnchorPly: 0 };
  }
  const studentChar = studentColor === 'white' ? 'w' : 'b';
  const opponentChar = studentColor === 'white' ? 'b' : 'w';
  let studentMat = 0;
  let opponentMat = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUES[sq.type] ?? 0;
      if (sq.color === studentChar) studentMat += v;
      else opponentMat += v;
    }
  }
  const materialDelta = studentMat - opponentMat;
  const history = chess.history({ verbose: true });
  const lastMove = history[history.length - 1] ?? null;
  const lastMoverIs: 'student' | 'opponent' | null =
    lastMove?.color === studentChar
      ? 'student'
      : lastMove?.color === opponentChar
        ? 'opponent'
        : null;
  const isCheckmate = chess.isCheckmate();
  const sideToMove = chess.turn();
  const mateOn = isCheckmate
    ? sideToMove === studentChar
      ? 'student'
      : 'opponent'
    : null;
  const dbAnchorPly = longestDbAnchorPly(pgn);

  if (role === 'warning') {
    if (mateOn === 'opponent') {
      flags.push('TOOTHLESS_WARNING');
    } else if (materialDelta > 2) {
      flags.push('TOOTHLESS_WARNING');
    }
  } else if (mateOn === 'student') {
    flags.push('INVERTED_MATE');
  } else if (mateOn !== 'opponent') {
    if (materialDelta < -1) flags.push('INVERTED_MATERIAL');
    else if (materialDelta < 3) flags.push('WEAK_TRAP');
    if (lastMoverIs === 'opponent') flags.push('STUDENT_NOT_PUNISHER');
  }
  if (dbAnchorPly < 6) flags.push('PGN_NOT_IN_DB');

  return { flags: [...new Set(flags)], materialDelta, lastMoverIs, dbAnchorPly };
}

describe('repertoire.json trap/warning orientation contract', () => {
  it('every flagged entry is either resolved or on the allowlist', () => {
    const offenders: string[] = [];
    for (const op of repertoire) {
      const lines: Array<{ role: 'trap' | 'warning'; line: LineEntry }> = [
        ...(op.trapLines ?? []).map((l) => ({ role: 'trap' as const, line: l })),
        ...(op.warningLines ?? []).map((l) => ({ role: 'warning' as const, line: l })),
      ];
      for (const { role, line } of lines) {
        const key = `${op.id}::${role}::${line.name}`;
        const { flags } = evaluateLine(line.pgn, op.color, role);
        if (flags.length === 0) {
          // Resolved — must NOT still be on the allowlist (forces cleanup).
          if (baseline[key]) {
            offenders.push(`${key}: passes audit but still in allowlist — remove from baseline`);
          }
          continue;
        }
        const allowed = baseline[key];
        if (!allowed) {
          offenders.push(`${key}: NEW VIOLATION (${flags.join(', ')}) — not in allowlist`);
          continue;
        }
        const unallowed = flags.filter((f) => !allowed.includes(f));
        if (unallowed.length > 0) {
          offenders.push(
            `${key}: NEW CATEGORY (${unallowed.join(', ')}) on previously-allowlisted entry`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no PGN_PARSE_ERROR is ever allowed (hard fail, no allowlist escape)', () => {
    const broken: string[] = [];
    for (const op of repertoire) {
      const lines: Array<{ role: 'trap' | 'warning'; line: LineEntry }> = [
        ...(op.trapLines ?? []).map((l) => ({ role: 'trap' as const, line: l })),
        ...(op.warningLines ?? []).map((l) => ({ role: 'warning' as const, line: l })),
      ];
      for (const { role, line } of lines) {
        const { flags } = evaluateLine(line.pgn, op.color, role);
        if (flags.some((f) => f.startsWith('PGN_PARSE_ERROR'))) {
          broken.push(`${op.id}::${role}::${line.name}: ${flags.join(', ')}`);
        }
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });
});
