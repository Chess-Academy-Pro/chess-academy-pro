import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { ImportGamesButton } from './ImportGamesButton';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('ImportGamesButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to /games/import on click', () => {
    render(<ImportGamesButton />);
    fireEvent.click(screen.getByTestId('import-games-cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/games/import');
  });

  it('renders compact variant by default', () => {
    render(<ImportGamesButton />);
    expect(screen.getByText('Import games')).toBeInTheDocument();
  });

  it('renders primary variant with the longer default label', () => {
    render(<ImportGamesButton variant="primary" />);
    expect(screen.getByText(/Import games from Lichess/i)).toBeInTheDocument();
  });

  it('respects label override', () => {
    render(<ImportGamesButton label="Bring in games" />);
    expect(screen.getByText('Bring in games')).toBeInTheDocument();
  });
});
