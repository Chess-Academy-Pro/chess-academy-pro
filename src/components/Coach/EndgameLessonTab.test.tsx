/**
 * EndgameLessonTab behavioral tests — locks in the lesson-view
 * contract (picker → narration + position → next/prev → exit).
 *
 * Renders against real lesson data so any drift in the catalog
 * shape (e.g., a position missing required fields) fires here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EndgameLessonTab } from './EndgameLessonTab';
import { getEndgamePrinciples, getPawnEndings } from '../../services/endgameLessonsService';

describe('EndgameLessonTab', () => {
  it('renders a tile per lesson in picker mode', () => {
    render(
      <EndgameLessonTab
        lessons={getEndgamePrinciples()}
        tabLabel="Endgame Principles"
        tabSubtitle="Test subtitle"
      />,
    );
    const principles = getEndgamePrinciples();
    for (const p of principles) {
      expect(screen.getByTestId(`endgame-lesson-${p.id}`)).toBeInTheDocument();
    }
  });

  it('shows tab label + subtitle in the picker header', () => {
    render(
      <EndgameLessonTab
        lessons={getEndgamePrinciples()}
        tabLabel="Endgame Principles"
        tabSubtitle="Master these and every endgame decision gets simpler."
      />,
    );
    expect(screen.getByText('Endgame Principles')).toBeInTheDocument();
    expect(screen.getByText(/Master these/)).toBeInTheDocument();
  });

  it('opens lesson view on tile click and shows narration', () => {
    render(
      <EndgameLessonTab
        lessons={getEndgamePrinciples()}
        tabLabel="Endgame Principles"
        tabSubtitle=""
      />,
    );
    fireEvent.click(screen.getByTestId('endgame-lesson-activate-the-king'));
    // Lesson narration panel renders on first position.
    expect(screen.getByText('The Lesson')).toBeInTheDocument();
    expect(screen.getByText(/Rule/)).toBeInTheDocument();
    // Position card title appears
    expect(screen.getByText(/Centralized king/i)).toBeInTheDocument();
  });

  it('opens to position 1 with Prev disabled', () => {
    // The total position count now equals keystones + DB-sourced
    // drills, so we lock the entry-state invariant (position 1,
    // Prev disabled) rather than the exact total.
    const target = getEndgamePrinciples()[0];
    render(
      <EndgameLessonTab
        lessons={[target]}
        tabLabel="Test"
        tabSubtitle=""
      />,
    );
    fireEvent.click(screen.getByTestId(`endgame-lesson-${target.id}`));
    const prevButton = screen.getByText('Prev').closest('button');
    expect(prevButton?.disabled).toBe(true);
    expect(screen.getByText(/^1\/\d+$/)).toBeInTheDocument();
  });

  it('navigates forward through positions', () => {
    const lessons = getPawnEndings();
    const multi = lessons.find((l) => l.positions.length > 1);
    if (!multi) return;
    render(
      <EndgameLessonTab
        lessons={[multi]}
        tabLabel="Test"
        tabSubtitle=""
      />,
    );
    fireEvent.click(screen.getByTestId(`endgame-lesson-${multi.id}`));
    // Counter format: "N/total" where total = keystones + drills.
    // We assert progression rather than exact total — the DB-driven
    // drill count can shift if puzzles.json or themes change.
    expect(screen.getByText(/^1\/\d+$/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText(/^2\/\d+$/)).toBeInTheDocument();
  });
});
