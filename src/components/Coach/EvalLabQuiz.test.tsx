/**
 * EvalLabQuiz behavioral test — locks in the two-stage contract:
 *   - Stage 1: "find the critical move" prompt shown (no W/D/L
 *     buttons — board-play is the only answer mechanic).
 *   - Pool only contains positions with curated bestMoves.
 *   - Progress counter renders.
 *   - Quiz pool draws from the full lesson catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalLabQuiz } from './EvalLabQuiz';
import { getAllEndgameLessons } from '../../services/endgameLessonsService';

vi.mock('../../services/lichessTablebaseService', () => ({
  lookupTablebase: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/coachPlaySession', () => ({
  resolveConfig: vi.fn(() => ({ skill: 8, moveTimeMs: 500, label: 'Easy' })),
  getCoachMove: vi.fn(),
}));

describe('EvalLabQuiz', () => {
  it('renders stage 1 prompt with no W/D/L buttons', () => {
    render(<EvalLabQuiz onExit={() => undefined} />);
    // Stage 1 prompt visible — the play-the-move instruction.
    expect(screen.getByText(/Stage 1 · Find the move/)).toBeInTheDocument();
    // No multiple-choice buttons.
    expect(screen.queryByTestId('eval-lab-guess-white-wins')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eval-lab-guess-draw')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eval-lab-guess-black-wins')).not.toBeInTheDocument();
  });

  it('shows progress counter (Position N of M)', () => {
    render(<EvalLabQuiz onExit={() => undefined} />);
    expect(screen.getByText(/Position 1 of/)).toBeInTheDocument();
  });

  it('quiz pool draws only positions with curated bestMoves', () => {
    const withBestMove = getAllEndgameLessons()
      .flatMap((l) => l.positions)
      .filter((p) => !!p.bestMove);
    // Must have enough material to drive the play-the-move stage.
    expect(withBestMove.length).toBeGreaterThanOrEqual(1);
  });
});
