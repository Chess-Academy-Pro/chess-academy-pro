// Detect what move happened between two FEN strings without needing the
// move history. Used by static-mode ConsistentChessboard so a board that
// is fed positions from an external source (endgame playout, kid games,
// model-game viewer) can still play the right piece sound and highlight
// the last move — same chrome the controlled-mode board gets for free.
//
// Returns null when:
//   - either FEN is not a string (e.g., piece-position map mode),
//   - the two FENs are identical,
//   - the delta doesn't look like a legal chess move (position reset).

import { Chess } from 'chess.js';
import type { SoundType } from '../services/soundService';

export interface DetectedMove {
  from: string;
  to: string;
  sound: SoundType;
}

type SquareMap = Record<string, string>;

function parseSquares(fen: string): SquareMap {
  const placement = fen.split(' ')[0];
  if (!placement) return {};
  const ranks = placement.split('/');
  if (ranks.length !== 8) return {};
  const result: SquareMap = {};
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        f += Number(ch);
        continue;
      }
      if (f > 7) return {};
      const square = `${String.fromCharCode(97 + f)}${8 - r}`;
      result[square] = ch;
      f++;
    }
    if (f !== 8) return {};
  }
  return result;
}

function isKing(piece: string | undefined): boolean {
  return piece === 'K' || piece === 'k';
}

function isPawn(piece: string | undefined): boolean {
  return piece === 'P' || piece === 'p';
}

export function detectMoveFromFen(
  prev: string | null | undefined,
  next: string | null | undefined,
): DetectedMove | null {
  if (!prev || !next || prev === next) return null;
  const a = parseSquares(prev);
  const b = parseSquares(next);
  if (Object.keys(a).length === 0 || Object.keys(b).length === 0) return null;

  const fromSquares: string[] = [];
  const toSquares: string[] = [];
  const allSquares = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const sq of allSquares) {
    if (a[sq] === b[sq]) continue;
    if (a[sq] && !b[sq]) fromSquares.push(sq);
    else if (!a[sq] && b[sq]) toSquares.push(sq);
    else toSquares.push(sq);
  }

  const inCheckOnNext = ((): boolean => {
    try {
      return new Chess(next).inCheck();
    } catch {
      return false;
    }
  })();

  if (fromSquares.length === 1 && toSquares.length === 1) {
    const from = fromSquares[0];
    const to = toSquares[0];
    const captured = a[to];
    let sound: SoundType = captured ? 'capture' : 'move';
    if (inCheckOnNext) sound = 'check';
    return { from, to, sound };
  }

  if (fromSquares.length === 2 && toSquares.length === 2) {
    let kingFrom: string | null = null;
    let kingTo: string | null = null;
    for (const sq of fromSquares) {
      if (isKing(a[sq])) kingFrom = sq;
    }
    for (const sq of toSquares) {
      if (isKing(b[sq])) kingTo = sq;
    }
    if (kingFrom && kingTo) {
      return {
        from: kingFrom,
        to: kingTo,
        sound: inCheckOnNext ? 'check' : 'castle',
      };
    }
  }

  if (fromSquares.length === 2 && toSquares.length === 1) {
    const to = toSquares[0];
    const arrivingFrom = fromSquares.find(
      (sq) => sq[0] !== to[0] && isPawn(a[sq]),
    );
    if (arrivingFrom) {
      return {
        from: arrivingFrom,
        to,
        sound: inCheckOnNext ? 'check' : 'capture',
      };
    }
  }

  return null;
}
