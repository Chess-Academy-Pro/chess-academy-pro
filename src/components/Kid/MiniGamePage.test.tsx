import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { MiniGamePage } from './MiniGamePage';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({
    onMove,
    initialFen,
    interactive,
  }: {
    onMove?: (move: Record<string, unknown>) => void;
    initialFen?: string;
    interactive?: boolean;
  }) => (
    <div
      data-testid="mock-chessboard"
      data-fen={initialFen}
      data-interactive={String(interactive)}
    >
      <button
        data-testid="mock-move-btn"
        onClick={() =>
          onMove?.({
            from: 'e2',
            to: 'e4',
            san: 'e4',
            fen: '7k/pppppppp/8/8/4P3/8/PPPP1PPP/K7 b - e3 0 1',
            piece: 'p',
          })
        }
      >
        Move
      </button>
    </div>
  ),
}));

vi.mock('./StarDisplay', () => ({
  StarDisplay: ({ earned, total }: { earned: number; total: number }) => (
    <div data-testid="star-display">
      {earned}/{total}
    </div>
  ),
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}));

vi.mock('../../hooks/usePieceSound', () => ({
  usePieceSound: () => ({
    playMoveSound: vi.fn(),
    playCelebration: vi.fn(),
    playEncouragement: vi.fn(),
  }),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// ─── miniGameEngine mocks ───────────────────────────────────────────────────

const mockGetAiMove = vi.fn();
const mockCheckWin = vi.fn();
const mockComputeHighlights = vi
  .fn()
  .mockReturnValue({ dangerSquares: [], safeSquares: [] });
const mockGetHintArrows = vi.fn().mockReturnValue([]);
const mockComputeStars = vi.fn().mockReturnValue(3);
const mockGetTargetPawnSquare = vi.fn().mockReturnValue(null);

vi.mock('../../services/miniGameEngine', () => ({
  getAiMove: (...args: unknown[]): unknown => mockGetAiMove(...args),
  checkWinCondition: (...args: unknown[]): unknown => mockCheckWin(...args),
  computeHighlights: (...args: unknown[]): unknown =>
    mockComputeHighlights(...args),
  getHintArrows: (...args: unknown[]): unknown => mockGetHintArrows(...args),
  computeStars: (...args: unknown[]): unknown => mockComputeStars(...args),
  getTargetPawnSquare: (...args: unknown[]): unknown =>
    mockGetTargetPawnSquare(...args),
}));

// ─── miniGameService mocks ──────────────────────────────────────────────────

const mockGetProgress = vi.fn().mockResolvedValue(null);
const mockCompleteLevel = vi.fn().mockResolvedValue({ levels: {} });
const mockIsUnlocked = vi.fn().mockReturnValue(true);

vi.mock('../../services/miniGameService', () => ({
  getMiniGameProgress: (...args: unknown[]): unknown =>
    mockGetProgress(...args),
  completeMiniGameLevel: (...args: unknown[]): unknown =>
    mockCompleteLevel(...args),
  isLevelUnlocked: (...args: unknown[]): unknown => mockIsUnlocked(...args),
}));

// ─── react-router-dom mock ──────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ level: '1' }),
  };
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MiniGamePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProgress.mockResolvedValue(null);
    mockCompleteLevel.mockResolvedValue({ levels: {} });
    mockIsUnlocked.mockReturnValue(true);
    mockCheckWin.mockReturnValue(null);
    mockGetAiMove.mockReturnValue(null);
    mockComputeHighlights.mockReturnValue({
      dangerSquares: [],
      safeSquares: [],
    });
    mockGetHintArrows.mockReturnValue([]);
    mockComputeStars.mockReturnValue(3);
    mockGetTargetPawnSquare.mockReturnValue(null);
  });

  // 1. Renders intro phase with story text
  it('renders intro phase with story text', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    expect(screen.getByTestId('mini-game-intro')).toBeInTheDocument();
    expect(screen.getByText(/Your little pawns are all lined up/)).toBeInTheDocument();
    expect(screen.getByTestId('mini-game-start')).toBeInTheDocument();
  });

  // 2. Clicking "Start!" transitions to playing phase
  it('clicking Start transitions to playing phase', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    expect(screen.queryByTestId('mini-game-intro')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-chessboard')).toBeInTheDocument();
  });

  // 3. Board is rendered in playing phase
  it('renders the chess board in playing phase', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    const board = screen.getByTestId('mock-chessboard');
    expect(board).toBeInTheDocument();
    expect(board).toHaveAttribute('data-interactive', 'true');
  });

  // 4. voiceService.speak called with storyIntro on intro
  it('calls voiceService.speak with storyIntro on intro phase', async () => {
    const { voiceService } = await import('../../services/voiceService');

    render(<MiniGamePage gameId="pawn-wars" />);

    expect(voiceService.speak).toHaveBeenCalledWith(
      expect.stringContaining('Your little pawns are all lined up'),
    );
  });

  // 5. Hint button increments hint level
  it('hint button increments hint level', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    const hintBtn = screen.getByTestId('mini-game-hint');
    expect(hintBtn).toBeInTheDocument();

    // First click: hint level 0 -> 1
    fireEvent.click(hintBtn);
    expect(screen.getByText(/Hint \(1\/2\)/)).toBeInTheDocument();

    // Second click: hint level 1 -> 2
    fireEvent.click(hintBtn);
    expect(screen.getByText(/Hint \(2\/2\)/)).toBeInTheDocument();
  });

  // 6. Restart button resets the game
  it('restart button resets the game back to playing phase', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    // Use hint to change state
    fireEvent.click(screen.getByTestId('mini-game-hint'));
    expect(screen.getByText(/Hint \(1\/2\)/)).toBeInTheDocument();

    // Restart
    fireEvent.click(screen.getByTestId('mini-game-restart'));

    // Hint level resets — no "(X/2)" shown
    expect(screen.queryByText(/Hint \(1\/2\)/)).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-chessboard')).toBeInTheDocument();
  });

  // 7. Back button navigates to /kid/pawn-games
  it('back button navigates to /kid/pawn-games', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-back'));

    expect(mockNavigate).toHaveBeenCalledWith('/kid/pawn-games');
  });

  // 8. Shows locked screen when level is locked
  it('shows locked screen when level is locked', () => {
    mockIsUnlocked.mockReturnValue(false);

    render(<MiniGamePage gameId="pawn-wars" />);

    expect(screen.getByTestId('mini-game-locked')).toBeInTheDocument();
    expect(screen.getByText('Level Locked')).toBeInTheDocument();
    expect(screen.queryByTestId('mini-game-intro')).not.toBeInTheDocument();
  });

  // 9. Won phase shows star display
  it('won phase shows star display', async () => {
    mockCheckWin.mockReturnValue('w');
    mockComputeStars.mockReturnValue(2);

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-won')).toBeInTheDocument();
    });

    expect(screen.getByText('You Won!')).toBeInTheDocument();
    expect(screen.getByTestId('star-display')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  // 10. Won phase "Next Level" navigates correctly
  it('won phase Next Level navigates to next level', async () => {
    mockCheckWin.mockReturnValue('w');

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-next')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mini-game-next'));

    expect(mockNavigate).toHaveBeenCalledWith('/kid/pawn-games/pawn-wars/2');
  });

  // 11. Won phase "Play Again" restarts game
  it('won phase Play Again restarts the game', async () => {
    mockCheckWin.mockReturnValue('w');

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-replay')).toBeInTheDocument();
    });

    // Reset checkWin so the replayed game doesn't immediately win again
    mockCheckWin.mockReturnValue(null);

    fireEvent.click(screen.getByTestId('mini-game-replay'));

    // Should be back to playing phase with the board
    expect(screen.getByTestId('mock-chessboard')).toBeInTheDocument();
    expect(screen.queryByTestId('mini-game-won')).not.toBeInTheDocument();
  });

  // 12. Lost phase shows retry button
  it('lost phase shows retry button', async () => {
    mockCheckWin.mockReturnValue('b');

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-lost')).toBeInTheDocument();
    });

    expect(screen.getByText('You Lost!')).toBeInTheDocument();
    expect(screen.getByTestId('mini-game-retry')).toBeInTheDocument();
  });

  // 13. Lost phase retry resets game
  it('lost phase Try Again resets the game', async () => {
    mockCheckWin.mockReturnValue('b');

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-retry')).toBeInTheDocument();
    });

    mockCheckWin.mockReturnValue(null);

    fireEvent.click(screen.getByTestId('mini-game-retry'));

    expect(screen.getByTestId('mock-chessboard')).toBeInTheDocument();
    expect(screen.queryByTestId('mini-game-lost')).not.toBeInTheDocument();
  });

  // 14. voiceService.speak called on won phase
  it('calls voiceService.speak with storyWin on won phase', async () => {
    const { voiceService } = await import('../../services/voiceService');
    mockCheckWin.mockReturnValue('w');

    render(<MiniGamePage gameId="pawn-wars" />);

    // Clear the intro speak call
    vi.mocked(voiceService.speak).mockClear();

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-won')).toBeInTheDocument();
    });

    expect(voiceService.speak).toHaveBeenCalledWith(
      expect.stringContaining('Your pawn made it all the way across'),
    );
  });

  // 15. voiceService.speak called on lost phase
  it('calls voiceService.speak with storyLoss on lost phase', async () => {
    const { voiceService } = await import('../../services/voiceService');
    mockCheckWin.mockReturnValue('b');

    render(<MiniGamePage gameId="pawn-wars" />);

    vi.mocked(voiceService.speak).mockClear();

    fireEvent.click(screen.getByTestId('mini-game-start'));
    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('mini-game-lost')).toBeInTheDocument();
    });

    expect(voiceService.speak).toHaveBeenCalledWith(
      expect.stringContaining('the enemy pawn snuck through first'),
    );
  });

  // 16. Hint button is disabled when hint level reaches max (2)
  it('hint button is disabled after reaching max hint level', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    const hintBtn = screen.getByTestId('mini-game-hint');

    fireEvent.click(hintBtn);
    fireEvent.click(hintBtn);

    expect(hintBtn).toBeDisabled();
  });

  // 17. Shows level title and level number in header
  it('displays the level title and level number in header', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    expect(screen.getByText('Pawn Skirmish')).toBeInTheDocument();
    expect(screen.getByText('Level 1')).toBeInTheDocument();
  });

  // 18. Move count is displayed in playing phase
  it('displays move count in playing phase', () => {
    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByTestId('mini-game-start'));

    expect(screen.getByText('Moves: 0')).toBeInTheDocument();
  });

  // 19. Locked screen back button navigates to mini-games
  it('locked screen back button navigates to /kid/pawn-games', () => {
    mockIsUnlocked.mockReturnValue(false);

    render(<MiniGamePage gameId="pawn-wars" />);

    fireEvent.click(screen.getByText('Back to Mini-Games'));

    expect(mockNavigate).toHaveBeenCalledWith('/kid/pawn-games');
  });

  // 20. voiceService.stop is called when Start is clicked
  it('calls voiceService.stop when Start button is clicked', async () => {
    const { voiceService } = await import('../../services/voiceService');

    render(<MiniGamePage gameId="pawn-wars" />);

    vi.mocked(voiceService.stop).mockClear();

    fireEvent.click(screen.getByTestId('mini-game-start'));

    expect(voiceService.stop).toHaveBeenCalled();
  });
});
