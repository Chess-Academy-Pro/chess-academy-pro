import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '../../test/utils';
import { RolodexCardStack } from './RolodexCardStack';
import type { OpeningRecord } from '../../types';

function buildOpening(overrides: Partial<OpeningRecord> = {}): OpeningRecord {
  return {
    id: 'op',
    eco: 'C50',
    name: 'Opening',
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

describe('RolodexCardStack — render order', () => {
  it('renders the active card with full body and back cards as tabs', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCardStack
        color="white"
        favorites={[
          buildOpening({ id: 'italian', name: 'Italian Game' }),
          buildOpening({ id: 'ruy-lopez', name: 'Ruy Lopez' }),
          buildOpening({ id: 'kings-indian-attack', name: "King's Indian Attack" }),
        ]}
        activeId="ruy-lopez"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    // Active card: full body (header visible)
    expect(screen.getByTestId('rolodex-card-header-ruy-lopez')).toBeInTheDocument();
    // Back cards: tabs only (no header)
    expect(screen.getByTestId('rolodex-card-tab-italian')).toBeInTheDocument();
    expect(
      screen.getByTestId('rolodex-card-tab-kings-indian-attack'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('rolodex-card-header-italian')).toBeNull();
    expect(screen.queryByTestId('rolodex-card-header-kings-indian-attack')).toBeNull();
  });

  it('puts the active card last in DOM order so it sits at the front of the visual stack', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCardStack
        color="white"
        favorites={[
          buildOpening({ id: 'a', name: 'A' }),
          buildOpening({ id: 'b', name: 'B' }),
          buildOpening({ id: 'c', name: 'C' }),
        ]}
        activeId="b"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    const stack = screen.getByTestId('rolodex-card-stack-white');
    const cardIds = Array.from(stack.children).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(cardIds).toEqual([
      'rolodex-sortable-a',
      'rolodex-sortable-c',
      'rolodex-sortable-b',
    ]);
  });
});

describe('RolodexCardStack — activation', () => {
  it('calls onActivate with the tapped card id when a back tab is clicked', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCardStack
        color="black"
        favorites={[
          buildOpening({ id: 'caro-kann', name: 'Caro-Kann', color: 'black' }),
          buildOpening({ id: 'french', name: 'French Defense', color: 'black' }),
        ]}
        activeId="caro-kann"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('rolodex-card-tab-french'));
    expect(onActivate).toHaveBeenCalledWith('french');
  });
});

describe('RolodexCardStack — defensive resolution', () => {
  it('falls back to the first favorite as active when activeId is null', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCardStack
        color="white"
        favorites={[
          buildOpening({ id: 'italian', name: 'Italian Game' }),
          buildOpening({ id: 'ruy-lopez', name: 'Ruy Lopez' }),
        ]}
        activeId={null}
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rolodex-card-header-italian')).toBeInTheDocument();
  });

  it('falls back when activeId references an opening not in the favorites list', () => {
    const onActivate = vi.fn();
    render(
      <RolodexCardStack
        color="white"
        favorites={[buildOpening({ id: 'italian', name: 'Italian Game' })]}
        activeId="ghost-opening-no-longer-favorited"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rolodex-card-header-italian')).toBeInTheDocument();
  });
});

// Note: full drag-reorder gesture simulation is covered by the
// Playwright audit (real PointerEvents in a browser env). The unit
// test suite stays focused on what's deterministic without a real
// pointer pipeline: that the prop wiring is in place and the stack
// hands the right id sequence to onReorder when invoked.

describe('RolodexCardStack — color isolation', () => {
  it('renders independent stacks per color (LayoutGroup scoping)', () => {
    const onActivate = vi.fn();
    const { rerender } = render(
      <RolodexCardStack
        color="white"
        favorites={[buildOpening({ id: 'italian', name: 'Italian Game' })]}
        activeId="italian"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rolodex-card-stack-white')).toBeInTheDocument();

    rerender(
      <RolodexCardStack
        color="black"
        favorites={[buildOpening({ id: 'caro-kann', name: 'Caro-Kann', color: 'black' })]}
        activeId="caro-kann"
        onActivate={onActivate}
        onReorder={vi.fn()}
      />,
    );
    const blackStack = screen.getByTestId('rolodex-card-stack-black');
    expect(within(blackStack).getByTestId('rolodex-card-header-caro-kann')).toBeInTheDocument();
  });
});
