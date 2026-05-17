import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────
//
// Hooks → return canned values per test. The row file imports them
// at module load, so the mock must register before the `import`
// below.
const mocks = vi.hoisted(() => ({
  useOpeningLinesProgress: vi.fn(),
  useOpeningPuzzlesProgress: vi.fn(),
  useOpeningTrapsProgress: vi.fn(),
  useOpeningMistakesProgress: vi.fn(),
  useOpeningWalkthroughProgress: vi.fn(),
  requestPuzzlesFamilyFallbackVoice: vi.fn(),
  speakIfFree: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../hooks/useOpeningProgress', () => ({
  useOpeningLinesProgress: mocks.useOpeningLinesProgress,
  useOpeningPuzzlesProgress: mocks.useOpeningPuzzlesProgress,
  useOpeningTrapsProgress: mocks.useOpeningTrapsProgress,
  useOpeningMistakesProgress: mocks.useOpeningMistakesProgress,
  useOpeningWalkthroughProgress: mocks.useOpeningWalkthroughProgress,
}));

vi.mock('../../services/puzzlesFamilyFallbackNotify', () => ({
  requestPuzzlesFamilyFallbackVoice: mocks.requestPuzzlesFamilyFallbackVoice,
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: { speakIfFree: mocks.speakIfFree },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

import { render, screen, fireEvent } from '../../test/utils';
import {
  TheoryLinesRow,
  PuzzlesRow,
  GMGamesRow,
  TrapsRow,
  BlundersRow,
  WalkthroughRow,
  PracticeFromStartRow,
  PracticeMiddlegameRow,
} from './RolodexRow';
import type { OpeningRecord } from '../../types';

function buildOpening(overrides: Partial<OpeningRecord> = {}): OpeningRecord {
  return {
    id: 'italian',
    eco: 'C50',
    name: 'Italian Game',
    pgn: '',
    uci: '',
    fen: '',
    color: 'white',
    style: '',
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

beforeEach(() => {
  // Reset call history on every mock so cross-test assertions like
  // `not.toHaveBeenCalled()` see a clean spy.
  for (const m of Object.values(mocks)) {
    m.mockReset();
  }
  mocks.useOpeningLinesProgress.mockReturnValue({ completed: 0, total: 0, loading: false });
  mocks.useOpeningPuzzlesProgress.mockReturnValue({ count: 0, source: 'none' });
  mocks.useOpeningTrapsProgress.mockReturnValue({ completed: 0, total: 0, loading: false });
  mocks.useOpeningMistakesProgress.mockReturnValue({ completed: 0, total: 0, loading: false });
  mocks.useOpeningWalkthroughProgress.mockReturnValue({ completed: 0, total: 0, loading: false });
  mocks.requestPuzzlesFamilyFallbackVoice.mockResolvedValue(null);
  mocks.speakIfFree.mockResolvedValue(undefined);
});

describe('TheoryLinesRow', () => {
  it('renders X / Y count and navigates to /openings?opening=<name>', () => {
    mocks.useOpeningLinesProgress.mockReturnValue({ completed: 3, total: 8, loading: false });
    render(<TheoryLinesRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-count-theory-lines')).toHaveTextContent('3 / 8');
    fireEvent.click(screen.getByTestId('rolodex-row-tap-theory-lines'));
    expect(mocks.navigate).toHaveBeenCalledWith('/openings?opening=Italian%20Game');
  });

  it('renders an ellipsis while the hook is loading', () => {
    mocks.useOpeningLinesProgress.mockReturnValue({ completed: 0, total: 0, loading: true });
    render(<TheoryLinesRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-count-theory-lines')).toHaveTextContent('…');
  });
});

describe('PuzzlesRow — exact match', () => {
  it('renders count without chip and navigates to /tactics/drill', () => {
    mocks.useOpeningPuzzlesProgress.mockReturnValue({ count: 42, source: 'exact' });
    render(<PuzzlesRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-count-puzzles')).toHaveTextContent('42');
    expect(screen.queryByTestId('rolodex-row-chip-puzzles')).toBeNull();
    fireEvent.click(screen.getByTestId('rolodex-row-tap-puzzles'));
    expect(mocks.navigate).toHaveBeenCalledWith('/tactics/drill?opening=Italian%20Game');
    expect(mocks.requestPuzzlesFamilyFallbackVoice).not.toHaveBeenCalled();
  });
});

describe('PuzzlesRow — family fallback', () => {
  it('renders count + family chip + fires fire-and-forget voice', async () => {
    mocks.useOpeningPuzzlesProgress.mockReturnValue({
      count: 192,
      source: 'family',
      family: 'Italian Game',
    });
    mocks.requestPuzzlesFamilyFallbackVoice.mockResolvedValueOnce(
      'Italian family puzzles next — same ideas, broader practice.',
    );
    render(
      <PuzzlesRow
        opening={buildOpening({ name: 'Italian Game: Classical Variation' })}
      />,
    );
    expect(screen.getByTestId('rolodex-row-count-puzzles')).toHaveTextContent('192');
    expect(screen.getByTestId('rolodex-row-chip-puzzles')).toHaveTextContent(
      'Italian Game family',
    );
    fireEvent.click(screen.getByTestId('rolodex-row-tap-puzzles'));
    // Navigation happens IMMEDIATELY with the favorited name (not the family)
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/tactics/drill?opening=Italian%20Game%3A%20Classical%20Variation',
    );
    expect(mocks.requestPuzzlesFamilyFallbackVoice).toHaveBeenCalledWith({
      favoritedOpening: 'Italian Game: Classical Variation',
      family: 'Italian Game',
      count: 192,
    });
    // Voice plays once the brain answer resolves
    await vi.waitFor(() => {
      expect(mocks.speakIfFree).toHaveBeenCalledWith(
        'Italian family puzzles next — same ideas, broader practice.',
      );
    });
  });

  it('does NOT call voiceService when the brain answer is null', async () => {
    mocks.useOpeningPuzzlesProgress.mockReturnValue({
      count: 50,
      source: 'family',
      family: 'Italian Game',
    });
    mocks.requestPuzzlesFamilyFallbackVoice.mockResolvedValueOnce(null);
    render(<PuzzlesRow opening={buildOpening()} />);
    fireEvent.click(screen.getByTestId('rolodex-row-tap-puzzles'));
    await vi.waitFor(() => {
      expect(mocks.requestPuzzlesFamilyFallbackVoice).toHaveBeenCalled();
    });
    expect(mocks.speakIfFree).not.toHaveBeenCalled();
  });
});

describe('PuzzlesRow — no puzzles', () => {
  it('renders nudge copy and disables tap when source is none', () => {
    mocks.useOpeningPuzzlesProgress.mockReturnValue({ count: 0, source: 'none' });
    render(<PuzzlesRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-puzzles')).toHaveTextContent(
      'No puzzles tagged for this line yet',
    );
    expect(screen.queryByTestId('rolodex-row-tap-puzzles')).toBeNull();
  });
});

describe('GMGamesRow', () => {
  it('renders the — placeholder + nudge and navigates to /games?eco=', () => {
    render(<GMGamesRow opening={buildOpening({ eco: 'B10' })} />);
    expect(screen.getByTestId('rolodex-row-count-gm-games')).toHaveTextContent('—');
    expect(screen.getByTestId('rolodex-row-gm-games')).toHaveTextContent(
      'Game-by-game progress tracking coming soon',
    );
    fireEvent.click(screen.getByTestId('rolodex-row-tap-gm-games'));
    expect(mocks.navigate).toHaveBeenCalledWith('/games?eco=B10');
  });
});

describe('TrapsRow', () => {
  it('navigates to /tactics/opening-traps?opening=<name>', () => {
    mocks.useOpeningTrapsProgress.mockReturnValue({ completed: 0, total: 5, loading: false });
    render(<TrapsRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-count-traps')).toHaveTextContent('0 / 5');
    fireEvent.click(screen.getByTestId('rolodex-row-tap-traps'));
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/tactics/opening-traps?opening=Italian%20Game',
    );
  });
});

describe('BlundersRow', () => {
  it('renders nudge when total is 0 (no blunders recorded yet)', () => {
    mocks.useOpeningMistakesProgress.mockReturnValue({
      completed: 0,
      total: 0,
      loading: false,
    });
    render(<BlundersRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-blunders')).toHaveTextContent(
      'Play a game to unlock blunder review',
    );
  });

  it('omits nudge once blunders exist', () => {
    mocks.useOpeningMistakesProgress.mockReturnValue({
      completed: 2,
      total: 4,
      loading: false,
    });
    render(<BlundersRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-blunders')).not.toHaveTextContent(
      'Play a game to unlock',
    );
    expect(screen.getByTestId('rolodex-row-count-blunders')).toHaveTextContent('2 / 4');
  });
});

describe('WalkthroughRow', () => {
  it('navigates to /coach/teach?opening=<name>', () => {
    mocks.useOpeningWalkthroughProgress.mockReturnValue({
      completed: 3,
      total: 5,
      loading: false,
    });
    render(<WalkthroughRow opening={buildOpening()} />);
    expect(screen.getByTestId('rolodex-row-count-walkthrough')).toHaveTextContent('3 / 5');
    fireEvent.click(screen.getByTestId('rolodex-row-tap-walkthrough'));
    expect(mocks.navigate).toHaveBeenCalledWith('/coach/teach?opening=Italian%20Game');
  });
});

describe('PracticeFromStartRow', () => {
  it('navigates to /coach/play with mode=from-start', () => {
    render(<PracticeFromStartRow opening={buildOpening()} />);
    fireEvent.click(screen.getByTestId('rolodex-row-tap-practice-from-start'));
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/coach/play?opening=Italian%20Game&mode=from-start',
    );
  });
});

describe('PracticeMiddlegameRow', () => {
  it('navigates to /coach/play with mode=middlegame', () => {
    render(<PracticeMiddlegameRow opening={buildOpening()} />);
    fireEvent.click(screen.getByTestId('rolodex-row-tap-practice-middlegame'));
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/coach/play?opening=Italian%20Game&mode=middlegame',
    );
  });
});
