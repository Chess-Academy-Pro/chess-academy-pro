import { describe, it, expect, vi } from 'vitest';

// Mock the per-opening progress hooks so the row tests stay
// hermetic — RolodexCard renders the 8 row components and each one
// calls into the PLUMBING-01 hooks; without mocks they'd hit Dexie.
vi.mock('../../hooks/useOpeningProgress', () => ({
  useOpeningLinesProgress: () => ({ completed: 0, total: 0, loading: false }),
  useOpeningPuzzlesProgress: () => ({ count: 0, source: 'none' as const }),
  useOpeningTrapsProgress: () => ({ completed: 0, total: 0, loading: false }),
  useOpeningMistakesProgress: () => ({ completed: 0, total: 0, loading: false }),
  useOpeningWalkthroughProgress: () => ({ completed: 0, total: 0, loading: false }),
}));

import { render, screen, fireEvent } from '../../test/utils';
import { RolodexCard } from './RolodexCard';
import { ROLODEX_ROWS } from './rolodexRows';
import type { OpeningRecord } from '../../types';

function buildOpening(overrides: Partial<OpeningRecord> = {}): OpeningRecord {
  return {
    id: 'italian',
    eco: 'C50',
    name: 'Italian Game',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
    uci: 'e2e4 e7e5 g1f3 b8c6 f1c4',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    color: 'white',
    style: 'classical',
    isRepertoire: false,
    overview: null,
    keyIdeas: null,
    traps: null,
    warnings: null,
    variations: null,
    drillAccuracy: 0,
    drillAttempts: 0,
    lastStudied: null,
    woodpeckerReps: 0,
    woodpeckerSpeed: null,
    woodpeckerLastDate: null,
    isFavorite: true,
    ...overrides,
  } as OpeningRecord;
}

describe('RolodexCard — active state', () => {
  it('renders the opening name + ECO in the header', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard
        opening={buildOpening({ eco: 'C50', name: 'Italian Game' })}
        isActive
        onActivate={onActivate}
      />,
    );
    const header = screen.getByTestId('rolodex-card-header-italian');
    expect(header).toHaveTextContent('C50');
    expect(header).toHaveTextContent('Italian Game');
  });

  it('renders all 8 training rows in canonical order', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard opening={buildOpening()} isActive onActivate={onActivate} />,
    );
    // Each row exposes its own data-testid keyed by row.key
    for (const row of ROLODEX_ROWS) {
      const li = screen.getByTestId(`rolodex-row-${row.key}`);
      expect(li).toBeInTheDocument();
      expect(li).toHaveTextContent(row.label);
    }
    expect(ROLODEX_ROWS).toHaveLength(8);
  });

  it('does NOT render the tab button when active', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard opening={buildOpening()} isActive onActivate={onActivate} />,
    );
    expect(screen.queryByTestId('rolodex-card-tab-italian')).toBeNull();
  });
});

describe('RolodexCard — stacked (inactive) state', () => {
  it('renders the tab button with ECO + name and fires onActivate when tapped', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard
        opening={buildOpening({ eco: 'B10', name: 'Caro-Kann Defense', id: 'caro-kann' })}
        isActive={false}
        onActivate={onActivate}
      />,
    );
    const tab = screen.getByTestId('rolodex-card-tab-caro-kann');
    expect(tab).toHaveTextContent('B10');
    expect(tab).toHaveTextContent('Caro-Kann Defense');

    fireEvent.click(tab);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the row list or header when stacked', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard opening={buildOpening()} isActive={false} onActivate={onActivate} />,
    );
    expect(screen.queryByTestId('rolodex-card-header-italian')).toBeNull();
    expect(screen.queryByTestId('rolodex-card-rows-italian')).toBeNull();
  });

  it('uses an aria-label that names the opening so screen-readers describe the tap target', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCard
        opening={buildOpening({ name: 'Sicilian Defense', id: 'sicilian' })}
        isActive={false}
        onActivate={onActivate}
      />,
    );
    expect(
      screen.getByRole('button', { name: /Open Sicilian Defense card/i }),
    ).toBeInTheDocument();
  });
});
