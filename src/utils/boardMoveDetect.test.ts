import { describe, it, expect } from 'vitest';
import { detectMoveFromFen } from './boardMoveDetect';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('detectMoveFromFen', () => {
  it('returns null when either input is missing', () => {
    expect(detectMoveFromFen(null, START)).toBeNull();
    expect(detectMoveFromFen(START, null)).toBeNull();
    expect(detectMoveFromFen('', START)).toBeNull();
  });

  it('returns null when positions are identical', () => {
    expect(detectMoveFromFen(START, START)).toBeNull();
  });

  it('detects a quiet pawn move', () => {
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(detectMoveFromFen(START, after)).toEqual({
      from: 'e2',
      to: 'e4',
      sound: 'move',
    });
  });

  it('detects a capture', () => {
    const before = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const after = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    expect(detectMoveFromFen(before, after)).toEqual({
      from: 'e4',
      to: 'd5',
      sound: 'capture',
    });
  });

  it('detects a check', () => {
    const before = '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1';
    const after = '4k3/4R3/8/8/8/8/8/4K3 b - - 1 1';
    expect(detectMoveFromFen(before, after)).toEqual({
      from: 'e2',
      to: 'e7',
      sound: 'check',
    });
  });

  it('detects kingside castling', () => {
    const before = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5';
    const after = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 b kq - 5 5';
    expect(detectMoveFromFen(before, after)).toEqual({
      from: 'e1',
      to: 'g1',
      sound: 'castle',
    });
  });

  it('detects queenside castling', () => {
    const before = 'r3kbnr/pppqpppp/2np4/8/8/2NP4/PPPQPPPP/R3KBNR w KQkq - 4 5';
    const after = 'r3kbnr/pppqpppp/2np4/8/8/2NP4/PPPQPPPP/2KR1BNR b kq - 5 5';
    expect(detectMoveFromFen(before, after)).toEqual({
      from: 'e1',
      to: 'c1',
      sound: 'castle',
    });
  });

  it('detects en passant as a capture', () => {
    const before = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    const after = 'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3';
    const result = detectMoveFromFen(before, after);
    expect(result).toEqual({ from: 'e5', to: 'f6', sound: 'capture' });
  });

  it('returns null for an external position reset (many pieces moved)', () => {
    const other = '8/8/8/4k3/8/8/8/4K3 w - - 0 1';
    expect(detectMoveFromFen(START, other)).toBeNull();
  });

  it('handles a quiet promotion as a regular move', () => {
    const before = '8/P7/8/8/8/1k6/8/4K3 w - - 0 1';
    const after = 'Q7/8/8/8/8/1k6/8/4K3 b - - 0 1';
    expect(detectMoveFromFen(before, after)).toEqual({
      from: 'a7',
      to: 'a8',
      sound: 'move',
    });
  });

  it('handles a malformed FEN gracefully', () => {
    expect(detectMoveFromFen('not-a-fen', START)).toBeNull();
    expect(detectMoveFromFen(START, 'not-a-fen')).toBeNull();
  });
});
