import { describe, it, expect } from 'vitest';
import drawnPatterns from './drawn-patterns.json';
import endgamePrinciples from './endgame-principles.json';
import matingPatterns from './mating-patterns.json';
import pawnEndings from './pawn-endings.json';
import rookEndings from './rook-endings.json';
import type { EndgameLesson, EndgameLessonPosition } from '../types/endgameLesson';

// David's rule for endgame lessons (CLAUDE.md):
// "User should always be playing the winning side."
//
// useEndgamePlayout derives `studentSide` from the FEN's side-to-move,
// so any position where the FEN says 'b to move' but the lesson result
// is 'white-wins' puts the student on the losing side — exactly the
// bug David flagged in Photo 2 of the endgame UX audit.
//
// This test guards every lesson source file. If a curation edit
// reintroduces the bug, CI fails before it reaches David.
const SOURCES: { name: string; data: EndgameLesson[] }[] = [
  { name: 'drawn-patterns', data: drawnPatterns as EndgameLesson[] },
  { name: 'endgame-principles', data: endgamePrinciples as EndgameLesson[] },
  { name: 'mating-patterns', data: matingPatterns as EndgameLesson[] },
  { name: 'pawn-endings', data: pawnEndings as EndgameLesson[] },
  { name: 'rook-endings', data: rookEndings as EndgameLesson[] },
];

function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

function expectedSide(result: EndgameLessonPosition['result']): 'w' | 'b' | null {
  if (result === 'white-wins') return 'w';
  if (result === 'black-wins') return 'b';
  return null; // drawn — either side may be to move; defender can be student
}

describe('endgame data: student always plays the winning side', () => {
  for (const { name, data } of SOURCES) {
    const cases: { lesson: string; pos: EndgameLessonPosition; expected: 'w' | 'b' }[] = [];
    for (const lesson of data) {
      const positions = (lesson.positions ?? (lesson as unknown as { lessonPositions?: EndgameLessonPosition[] }).lessonPositions ?? []);
      for (const pos of positions) {
        const expected = expectedSide(pos.result);
        if (!expected) continue;
        cases.push({ lesson: lesson.id, pos, expected });
      }
    }
    if (cases.length === 0) continue;
    describe(name, () => {
      for (const { lesson, pos, expected } of cases) {
        const actual = sideToMove(pos.fen);
        it(`${lesson} :: "${pos.title}" — ${pos.result} ⇒ ${expected} to move`, () => {
          expect(actual, `FEN "${pos.fen}" has ${actual} to move but result is ${pos.result}`).toBe(expected);
        });
      }
    });
  }
});
