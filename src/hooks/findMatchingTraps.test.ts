import { describe, it, expect } from 'vitest';
import { _findMatchingTraps } from './useTeachWalkthrough';
import type { PunishLesson } from '../types/walkthroughTree';

const baseLesson = (overrides: Partial<PunishLesson>): PunishLesson => ({
  name: 'test',
  setupMoves: [],
  inaccuracy: 'e5',
  whyBad: '',
  punishment: 'e4',
  whyPunish: '',
  distractors: [],
  ...overrides,
});

describe('useTeachWalkthrough — findMatchingTraps', () => {
  it('returns empty when no lessons', () => {
    expect(_findMatchingTraps(['e4'], [])).toEqual([]);
    expect(_findMatchingTraps(['e4'], undefined)).toEqual([]);
  });

  it('matches an LLM-emitted trap whose setupMoves equals the path exactly', () => {
    const lesson = baseLesson({ setupMoves: ['e4', 'e5', 'Nf3'] });
    expect(_findMatchingTraps(['e4', 'e5', 'Nf3'], [lesson])).toEqual([lesson]);
  });

  it('does NOT match when path is shorter than setupMoves', () => {
    const lesson = baseLesson({ setupMoves: ['e4', 'e5', 'Nf3'] });
    expect(_findMatchingTraps(['e4', 'e5'], [lesson])).toEqual([]);
  });

  it('does NOT match when path is longer than setupMoves', () => {
    const lesson = baseLesson({ setupMoves: ['e4', 'e5'] });
    expect(_findMatchingTraps(['e4', 'e5', 'Nf3'], [lesson])).toEqual([]);
  });

  it('SKIPS puzzle-DB-derived lessons (setupFen present) — production audit fix', () => {
    // Audit (build 3a27027): puzzle-DB-derived punishes set
    // setupMoves = canonical opening PGN for context display, but
    // the actual position is at setupFen (a mid-game puzzle FEN).
    // The lesson's inaccuracy SAN is legal only from setupFen, NOT
    // from the walkthrough's current FEN. Auto-narrating these as
    // trap-prompts during the walkthrough produced false positives
    // like "Hold on — a common mistake here is Rxe4" at positions
    // where Rxe4 is illegal.
    const puzzleLesson = baseLesson({
      setupMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'],
      setupFen: '5rk1/5p1p/8/8/Q7/8/5PPP/4R1K1 w - - 0 1',
      inaccuracy: 'Rxe4',
    });
    expect(_findMatchingTraps(
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'],
      [puzzleLesson],
    )).toEqual([]);
  });

  it('matches LLM lesson and skips puzzle lesson at the same path', () => {
    const llmLesson = baseLesson({
      setupMoves: ['e4', 'e5', 'Nf3'],
      inaccuracy: 'Bc5',
    });
    const puzzleLesson = baseLesson({
      setupMoves: ['e4', 'e5', 'Nf3'],
      setupFen: 'rnbqkbnr/ppp2ppp/8/3pp3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1',
      inaccuracy: 'Nxe5',
    });
    const matches = _findMatchingTraps(
      ['e4', 'e5', 'Nf3'],
      [llmLesson, puzzleLesson],
    );
    expect(matches).toEqual([llmLesson]);
  });
});
