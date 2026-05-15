import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionConfig } from 'framer-motion';
import { MiddlegamePlanStudy } from './MiddlegamePlanStudy';
import { buildMiddlegamePlan } from '../../test/factories';

vi.mock('../Board/ControlledChessBoard', () => ({
  ControlledChessBoard: (props: Record<string, unknown>) => {
    const game = props.game as { fen?: string; boardOrientation?: string } | undefined;
    return (
      <div
        data-testid="chess-board"
        data-fen={game?.fen ?? ''}
        data-interactive={props.interactive === true ? 'true' : 'false'}
      >
        Board
      </div>
    );
  },
}));

vi.mock('../../hooks/useChessGame', () => ({
  useChessGame: (initialFen?: string, initialOrientation: 'white' | 'black' = 'white') => ({
    fen: initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    position: initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: 'w' as const,
    inCheck: false,
    isCheck: false,
    checkSquare: null,
    isGameOver: false,
    isCheckmate: false,
    isStalemate: false,
    isDraw: false,
    lastMove: null,
    history: [],
    selectedSquare: null,
    legalMoves: [],
    boardOrientation: initialOrientation,
    makeMove: vi.fn(),
    onDrop: vi.fn(),
    onSquareClick: vi.fn(),
    flipBoard: vi.fn(),
    setOrientation: vi.fn(),
    undoMove: vi.fn(),
    resetGame: vi.fn(),
    clearSelection: vi.fn(),
    getLegalMoves: vi.fn().mockReturnValue([]),
    getPiece: vi.fn().mockReturnValue(null),
    reset: vi.fn(),
    loadFen: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
  sanitizeForTTS: (text: string) => text,
}));

function renderStudy(
  overrides?: Partial<Parameters<typeof MiddlegamePlanStudy>[0]>,
): ReturnType<typeof render> {
  const plan = buildMiddlegamePlan({
    title: 'Central Push',
    overview: 'White plays d4 to open the center.',
    pawnBreaks: [
      { move: 'd3-d4', explanation: 'Opens the center for White.', fen: 'start-fen' },
      { move: 'f2-f4', explanation: 'Kingside expansion.', fen: 'start-fen-2' },
    ],
    pieceManeuvers: [
      { piece: 'Knight', route: 'Nd2-f1-g3', explanation: 'Reroutes to kingside.' },
    ],
    strategicThemes: ['Control d5', 'Minority attack'],
    endgameTransitions: ['Trade into bishop endgame'],
  });

  return render(
    <MotionConfig transition={{ duration: 0 }}>
      <MiddlegamePlanStudy
        plan={plan}
        boardOrientation="white"
        onExit={vi.fn()}
        {...overrides}
      />
    </MotionConfig>,
  );
}

describe('MiddlegamePlanStudy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the plan title and overview', () => {
    renderStudy();
    expect(screen.getByText('Central Push')).toBeInTheDocument();
    expect(screen.getByTestId('plan-overview')).toBeInTheDocument();
    expect(screen.getByText('White plays d4 to open the center.')).toBeInTheDocument();
  });

  it('renders the board using ControlledChessBoard', () => {
    renderStudy();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
  });

  it('shows pawn breaks when tab is clicked', async () => {
    renderStudy();
    await userEvent.click(screen.getByTestId('plan-tab-pawnBreaks'));
    expect(screen.getByTestId('plan-pawn-breaks')).toBeInTheDocument();
    expect(screen.getByText('d3-d4')).toBeInTheDocument();
    expect(screen.getByText('Opens the center for White.')).toBeInTheDocument();
  });

  it('navigates between pawn breaks', async () => {
    renderStudy();
    await userEvent.click(screen.getByTestId('plan-tab-pawnBreaks'));
    expect(screen.getByText('d3-d4')).toBeInTheDocument();

    const nextBtn = screen.getByLabelText('Next break');
    await userEvent.click(nextBtn);
    expect(screen.getByText('f2-f4')).toBeInTheDocument();

    const prevBtn = screen.getByLabelText('Previous break');
    await userEvent.click(prevBtn);
    expect(screen.getByText('d3-d4')).toBeInTheDocument();
  });

  it('shows piece maneuvers when tab is clicked', async () => {
    renderStudy();
    await userEvent.click(screen.getByTestId('plan-tab-maneuvers'));
    expect(screen.getByTestId('plan-maneuvers')).toBeInTheDocument();
    expect(screen.getByText('Knight')).toBeInTheDocument();
    expect(screen.getByText('Nd2-f1-g3')).toBeInTheDocument();
  });

  it('shows strategic themes when tab is clicked', async () => {
    renderStudy();
    await userEvent.click(screen.getByTestId('plan-tab-themes'));
    expect(screen.getByTestId('plan-themes')).toBeInTheDocument();
    expect(screen.getByText('Control d5')).toBeInTheDocument();
    expect(screen.getByText('Minority attack')).toBeInTheDocument();
  });

  it('shows endgame transitions when tab is clicked', async () => {
    renderStudy();
    await userEvent.click(screen.getByTestId('plan-tab-endgames'));
    expect(screen.getByTestId('plan-endgames')).toBeInTheDocument();
    expect(screen.getByText('Trade into bishop endgame')).toBeInTheDocument();
  });

  it('calls onExit when back button is clicked', async () => {
    const onExit = vi.fn();
    renderStudy({ onExit });
    await userEvent.click(screen.getByTestId('plan-study-back'));
    expect(onExit).toHaveBeenCalled();
  });

  it('shows Practice This Plan button', () => {
    renderStudy();
    expect(screen.getByTestId('start-practice-btn')).toBeInTheDocument();
    expect(screen.getByText('Practice This Plan')).toBeInTheDocument();
  });

  it('shows narration toggle button', () => {
    renderStudy();
    expect(screen.getByTestId('narration-toggle')).toBeInTheDocument();
    expect(screen.getByLabelText('Read aloud')).toBeInTheDocument();
  });

  it('calls voiceService.speak when narration is toggled on', async () => {
    const { voiceService } = await import('../../services/voiceService');
    renderStudy();
    await userEvent.click(screen.getByTestId('narration-toggle'));
    expect(voiceService.speak).toHaveBeenCalledWith(
      expect.stringContaining('White plays d4'),
    );
  });

  it('calls voiceService.stop when narration is toggled off', async () => {
    const { voiceService } = await import('../../services/voiceService');
    renderStudy();
    // Toggle on
    await userEvent.click(screen.getByTestId('narration-toggle'));
    // Toggle off
    await userEvent.click(screen.getByTestId('narration-toggle'));
    expect(voiceService.stop).toHaveBeenCalled();
  });

  it('always shows bottom bar with practice button', () => {
    renderStudy();
    expect(screen.getByTestId('plan-bottom-bar')).toBeInTheDocument();
    expect(screen.getByTestId('start-practice-btn')).toBeInTheDocument();
  });

  it('has a scrollable content area', () => {
    renderStudy();
    const scrollArea = screen.getByTestId('plan-content-scroll');
    expect(scrollArea).toBeInTheDocument();
    expect(scrollArea.className).toContain('overflow-y-auto');
  });
});
