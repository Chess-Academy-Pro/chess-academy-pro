import { describe, it, expect, vi, beforeEach } from 'vitest';

const auditCalls: { kind: string; summary: string }[] = [];
vi.mock('../../services/appAuditor', () => ({
  logAppAudit: vi.fn((entry: { kind: string; summary: string }) => {
    auditCalls.push({ kind: entry.kind, summary: entry.summary });
    return Promise.resolve();
  }),
}));

const mockGetFavoriteOpenings = vi.fn();
vi.mock('../../services/openingService', () => ({
  getFavoriteOpenings: () => mockGetFavoriteOpenings(),
}));

import { render, screen, waitFor, within } from '../../test/utils';
import { TrainingPlanRolodexPage } from './TrainingPlanRolodexPage';
import {
  useCoachMemoryStore,
  __resetCoachMemoryStoreForTests,
} from '../../stores/coachMemoryStore';
import type { OpeningRecord } from '../../types';

function buildOpening(overrides: Partial<OpeningRecord> = {}): OpeningRecord {
  return {
    id: 'op-' + Math.random().toString(36).slice(2, 8),
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

beforeEach(() => {
  auditCalls.length = 0;
  __resetCoachMemoryStoreForTests();
  mockGetFavoriteOpenings.mockReset();
});

// JSDOM renders both the mobile (`md:hidden`) and desktop
// (`hidden md:grid`) panels at all times (CSS `display: none`
// doesn't suppress markup). Scope queries with `within(column)`
// to disambiguate when the same data-testid appears in both
// panels.
function getDesktopWhiteColumn(): HTMLElement {
  return screen.getByTestId('rolodex-white-column');
}
function getDesktopBlackColumn(): HTMLElement {
  return screen.getByTestId('rolodex-black-column');
}

describe('TrainingPlanRolodexPage — cold load with zero favorites', () => {
  it('renders the empty state for both colors', async () => {
    mockGetFavoriteOpenings.mockResolvedValueOnce([]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(
        within(getDesktopWhiteColumn()).getByTestId('rolodex-empty-state-white'),
      ).toBeInTheDocument();
    });
    expect(
      within(getDesktopBlackColumn()).getByTestId('rolodex-empty-state-black'),
    ).toBeInTheDocument();

    // Each empty state offers its own Browse Openings CTA so a user
    // can act from whichever column they're looking at.
    expect(
      within(getDesktopWhiteColumn()).getByTestId('rolodex-empty-cta-white'),
    ).toBeInTheDocument();
    expect(
      within(getDesktopBlackColumn()).getByTestId('rolodex-empty-cta-black'),
    ).toBeInTheDocument();
  });

  it('does NOT fire setActiveOpeningCard for empty colors', async () => {
    mockGetFavoriteOpenings.mockResolvedValueOnce([]);
    render(<TrainingPlanRolodexPage />);
    await waitFor(() => {
      expect(
        within(getDesktopWhiteColumn()).getByTestId('rolodex-empty-state-white'),
      ).toBeInTheDocument();
    });
    // No favorites → resolver returns null for both colors, which
    // matches the default persisted state (null). The effect should
    // see no diff and skip the setter, so no audit fires.
    expect(
      auditCalls.some((c) => c.kind === 'coach-memory-rolodex-active-card-set'),
    ).toBe(false);
  });
});

describe('TrainingPlanRolodexPage — cold load with one White favorite', () => {
  it('renders the White stack placeholder with the favorite name and an empty Black state', async () => {
    mockGetFavoriteOpenings.mockResolvedValueOnce([
      buildOpening({ id: 'italian', name: 'Italian Game', color: 'white' }),
    ]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(
        within(getDesktopWhiteColumn()).getByTestId('rolodex-stack-placeholder-white'),
      ).toBeInTheDocument();
    });
    expect(
      within(getDesktopWhiteColumn()).getByTestId('rolodex-active-card-name-white'),
    ).toHaveTextContent('Italian Game');
    expect(
      within(getDesktopBlackColumn()).getByTestId('rolodex-empty-state-black'),
    ).toBeInTheDocument();
  });

  it('auto-activates the first favorite and persists to the memory store', async () => {
    mockGetFavoriteOpenings.mockResolvedValueOnce([
      buildOpening({ id: 'italian', name: 'Italian Game', color: 'white' }),
    ]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(useCoachMemoryStore.getState().activeOpeningCardId.white).toBe('italian');
    });
    expect(useCoachMemoryStore.getState().lastActiveRolodexColor).toBe('white');
    expect(
      auditCalls.some((c) => c.kind === 'coach-memory-rolodex-active-card-set'),
    ).toBe(true);
  });
});

describe('TrainingPlanRolodexPage — cold load with multiple favorites in both colors', () => {
  it('renders a placeholder stack per color and respects the persisted active id when valid', async () => {
    // Seed memory store with a persisted active id BEFORE mount so
    // the page reads it on first render.
    useCoachMemoryStore.getState().setActiveOpeningCard('white', 'kings-indian-attack');
    auditCalls.length = 0; // discard the seed audit

    mockGetFavoriteOpenings.mockResolvedValueOnce([
      buildOpening({ id: 'italian', name: 'Italian Game', color: 'white' }),
      buildOpening({ id: 'kings-indian-attack', name: "King's Indian Attack", color: 'white' }),
      buildOpening({ id: 'caro-kann', name: 'Caro-Kann Defense', color: 'black' }),
    ]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(
        within(getDesktopWhiteColumn()).getByTestId('rolodex-stack-placeholder-white'),
      ).toBeInTheDocument();
    });
    // Persisted KIA id is still in the favorites list, so the
    // resolver should keep it active rather than reverting to the
    // first favorite (Italian).
    expect(
      within(getDesktopWhiteColumn()).getByTestId('rolodex-active-card-name-white'),
    ).toHaveTextContent("King's Indian Attack");
    expect(
      within(getDesktopBlackColumn()).getByTestId('rolodex-active-card-name-black'),
    ).toHaveTextContent('Caro-Kann Defense');
  });

  it('falls back to the first favorite when persisted active id is stale (opening unfavorited elsewhere)', async () => {
    useCoachMemoryStore.getState().setActiveOpeningCard('white', 'opening-no-longer-favorited');
    auditCalls.length = 0;

    mockGetFavoriteOpenings.mockResolvedValueOnce([
      buildOpening({ id: 'italian', name: 'Italian Game', color: 'white' }),
      buildOpening({ id: 'ruy-lopez', name: 'Ruy Lopez', color: 'white' }),
    ]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(
        within(getDesktopWhiteColumn()).getByTestId('rolodex-active-card-name-white'),
      ).toHaveTextContent('Italian Game');
    });
    // The stale persisted id was overwritten with the resolved fallback.
    await waitFor(() => {
      expect(useCoachMemoryStore.getState().activeOpeningCardId.white).toBe('italian');
    });
  });
});

describe('TrainingPlanRolodexPage — mobile folder default', () => {
  it('defaults the mobile tab to the persisted lastActiveRolodexColor', async () => {
    useCoachMemoryStore.setState({ lastActiveRolodexColor: 'black' });
    mockGetFavoriteOpenings.mockResolvedValueOnce([]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(screen.getByTestId('rolodex-folder-tab-black')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(screen.getByTestId('rolodex-folder-tab-white')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it("defaults the mobile tab to White when there's no rolodex history yet", async () => {
    mockGetFavoriteOpenings.mockResolvedValueOnce([]);
    render(<TrainingPlanRolodexPage />);

    await waitFor(() => {
      expect(screen.getByTestId('rolodex-folder-tab-white')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });
});
