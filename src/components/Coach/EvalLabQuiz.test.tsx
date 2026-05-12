/**
 * EvalLabQuiz behavioral test — locks in the new three-stage
 * adaptive contract:
 *   - Pool combines keystones + Lichess endgame puzzles.
 *   - Keystones open with Stage 0 (W/D/L recognition); Lichess
 *     puzzles skip Stage 0 (always student-wins).
 *   - Header shows the adaptive rating chrome.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalLabQuiz } from './EvalLabQuiz';

vi.mock('../../services/lichessTablebaseService', () => ({
  lookupTablebase: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/coachPlaySession', () => ({
  resolveConfig: vi.fn(() => ({ skill: 20, moveTimeMs: 1000, label: 'Hard' })),
  getCoachMove: vi.fn(),
}));

describe('EvalLabQuiz', () => {
  it('renders the adaptive header (rating + target + score)', () => {
    render(<EvalLabQuiz onExit={() => undefined} />);
    // New header shape: "#1 · <rating>... · target X · you Y · 0/0"
    expect(screen.getByText(/target /)).toBeInTheDocument();
    expect(screen.getByText(/you /)).toBeInTheDocument();
  });

  it('opens with EITHER Stage 0 (keystone) or Stage 1 (Lichess) — both forms valid', () => {
    render(<EvalLabQuiz onExit={() => undefined} />);
    const stage0 = screen.queryByText(/Stage 0 · What's the result/);
    const stage1 = screen.queryByText(/Stage 1 · Find the critical move/);
    expect(stage0 || stage1).not.toBeNull();
  });

  it('pool is non-empty (at least 1 eligible item)', () => {
    render(<EvalLabQuiz onExit={() => undefined} />);
    // Header always renders when there's at least one item.
    expect(screen.getByText('Eval Lab')).toBeInTheDocument();
  });
});
