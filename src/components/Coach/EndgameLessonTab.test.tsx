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

  it('lessons render correctly even when they have only one position', () => {
    // Some principles only have a single illustrative position. The
    // navigation should disable Prev/Next correctly when there's
    // only one to step through.
    const oneOff = getEndgamePrinciples().filter((p) => p.positions.length === 1);
    if (oneOff.length === 0) return;
    const target = oneOff[0];
    render(
      <EndgameLessonTab
        lessons={[target]}
        tabLabel="Test"
        tabSubtitle=""
      />,
    );
    fireEvent.click(screen.getByTestId(`endgame-lesson-${target.id}`));
    // Both Prev and Next should be disabled when there's only one position.
    const prevButton = screen.getByText('Prev').closest('button');
    const nextButton = screen.getByText('Next').closest('button');
    expect(prevButton?.disabled).toBe(true);
    expect(nextButton?.disabled).toBe(true);
  });

  it('navigates between positions when there are multiple', () => {
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
    expect(screen.getByText('1/' + multi.positions.length)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('2/' + multi.positions.length)).toBeInTheDocument();
  });
});
