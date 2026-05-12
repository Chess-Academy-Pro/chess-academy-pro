import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CalculationTab } from './CalculationTab';

describe('CalculationTab', () => {
  it('renders the picker with all 6 skill tiles', () => {
    render(<CalculationTab onExit={() => undefined} />);
    expect(screen.getByTestId('calculation-skill-find-the-mate')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-skill-quiet-move')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-skill-forcing-sequence')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-skill-defensive-calc')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-skill-race-calculation')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-skill-tactical-pattern')).toBeInTheDocument();
  });

  it('shows Calculation header text', () => {
    render(<CalculationTab onExit={() => undefined} />);
    expect(screen.getByText('Calculation')).toBeInTheDocument();
  });

  it('opens the rationale screen when a skill tile is clicked', () => {
    render(<CalculationTab onExit={() => undefined} />);
    fireEvent.click(screen.getByTestId('calculation-skill-quiet-move'));
    expect(screen.getByText('Why this matters')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-start-drill')).toBeInTheDocument();
  });

  it('opens the adaptive drill from the rationale screen', () => {
    render(<CalculationTab onExit={() => undefined} />);
    fireEvent.click(screen.getByTestId('calculation-skill-find-the-mate'));
    fireEvent.click(screen.getByTestId('calculation-start-drill'));
    // Adaptive drill UI surfaces Skip + Next buttons (no more
    // pre-rolled "Puzzle 1 of 5" — it's an infinite stream).
    expect(screen.getByTestId('calculation-skip')).toBeInTheDocument();
    expect(screen.getByTestId('calculation-next')).toBeInTheDocument();
  });

  it('shows skill rationale text when on the rationale screen', () => {
    render(<CalculationTab onExit={() => undefined} />);
    fireEvent.click(screen.getByTestId('calculation-skill-find-the-mate'));
    // Rationale mentions "mate"
    expect(screen.getByText(/mate is the cleanest calculation/i)).toBeInTheDocument();
  });
});
