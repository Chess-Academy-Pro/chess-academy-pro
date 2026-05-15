import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test/utils';
import { WalkthroughMode } from './WalkthroughMode';
import { buildOpeningRecord } from '../../test/factories';
import type { OpeningRecord } from '../../types';

 

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({ initialFen, orientation, interactive }: {
    initialFen?: string;
    orientation?: string;
    interactive?: boolean;
  }) => (
    <div
      data-testid="chess-board"
      data-fen={initialFen}
      data-orientation={orientation}
      data-interactive={String(interactive)}
    >
      Board
    </div>
  ),
}));

vi.mock('../Board/ControlledChessBoard', () => ({
  ControlledChessBoard: (props: Record<string, unknown>) => {
    const game = props.game as { fen?: string; boardOrientation?: string } | undefined;
    const interactive = props.interactive as boolean | undefined;
    return (
      <div
        data-testid="chess-board"
        data-fen={game?.fen ?? ''}
        data-orientation={game?.boardOrientation ?? 'white'}
        data-interactive={String(interactive ?? true)}
      >
        Board
      </div>
    );
  },
}));

vi.mock('../../hooks/useChessGame', () => ({
  useChessGame: (_initialFen?: string, initialOrientation: 'white' | 'black' = 'white') => ({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: 'w',
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
    makeMove: vi.fn().mockReturnValue(null),
    onDrop: vi.fn().mockReturnValue(null),
    onSquareClick: vi.fn().mockReturnValue(null),
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

vi.mock('../../hooks/usePieceSound', () => ({
  usePieceSound: () => ({
    playMoveSound: vi.fn(),
    playCelebration: vi.fn(),
    playEncouragement: vi.fn(),
  }),
}));

const mockSpeak = vi.fn();
const mockStop = vi.fn();
vi.mock('../../services/speechService', () => ({
  speechService: {
    speak: (...args: unknown[]): unknown => mockSpeak(...args),
    stop: (...args: unknown[]): unknown => mockStop(...args),
    setEnabled: vi.fn(),
    setRate: vi.fn(),
    warmupInGestureContext: vi.fn(),
  },
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockImplementation(async (text: string) => { mockSpeak(text, { rate: 1 }); }),
    speakFast: vi.fn().mockImplementation(async (text: string) => { mockSpeak(text, { rate: 1 }); }),
    stop: vi.fn().mockImplementation(() => { mockStop(); }),
    isPlaying: vi.fn().mockReturnValue(false),
    warmup: vi.fn().mockResolvedValue(undefined),
    prefetchAudio: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn(),
  },
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../services/stockfishEngine', () => ({
  stockfishEngine: {
    analyzePosition: vi.fn().mockResolvedValue({ evaluation: 30, isMate: false, mateIn: null }),
    init: vi.fn(),
    destroy: vi.fn(),
    onStatusChange: vi.fn(),
  },
}));

vi.mock('../../services/walkthroughLlmNarrator', () => ({
  // Default: return empty narrations so the enrichment path is a no-op and
  // the raw annotations from annotationService drive the test. Individual
  // tests can override via mockResolvedValueOnce.
  generateWalkthroughNarrations: vi.fn().mockResolvedValue({ narrations: [], fromCache: false }),
}));

vi.mock('../../services/annotationService', () => {
  const annotations = [
    {
      san: 'e4',
      annotation: 'White opens with the king pawn.',
      pawnStructure: 'E4 pawn center.',
      plans: ['Develop pieces quickly'],
    },
    {
      san: 'e5',
      annotation: 'Black mirrors the center.',
    },
    {
      san: 'Nf3',
      annotation: 'Knight develops to f3.',
      alternatives: ['Nc3 is also possible'],
    },
  ];
  return {
    loadAnnotations: vi.fn().mockResolvedValue(annotations),
    loadAnnotationsForPgn: vi.fn().mockResolvedValue(annotations),
    loadSubLineAnnotations: vi.fn().mockResolvedValue(null),
    clearAnnotationCache: vi.fn(),
    enhanceWithNarration: vi.fn().mockImplementation(async (ann: unknown) => ann),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const testOpening: OpeningRecord = buildOpeningRecord({
  id: 'walkthrough-test',
  name: 'Test Opening',
  pgn: 'e4 e5 Nf3',
  color: 'white',
  overview: 'A great opening for beginners.',
  variations: [
    { name: 'Variation A', pgn: 'e4 e5 Nc3', explanation: 'Alternative development' },
  ],
});

const onExit = vi.fn();

describe('WalkthroughMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders walkthrough mode with title and controls', async () => {
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    expect(screen.getByTestId('walkthrough-mode')).toBeInTheDocument();
    expect(screen.getByText('Walkthrough: Test Opening')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-play-pause')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-speed-toggle')).toBeInTheDocument();
  });

  it('shows overview at move 0', async () => {
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-overview')).toBeInTheDocument();
    });
    expect(screen.getByText('A great opening for beginners.')).toBeInTheDocument();
  });

  it('board is non-interactive', async () => {
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    const board = screen.getByTestId('chess-board');
    expect(board.dataset.interactive).toBe('false');
  });

  it('advances to next move on next button click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    // At move 0, show overview
    expect(screen.getByTestId('walkthrough-overview')).toBeInTheDocument();

    // Click next
    await user.click(screen.getByTestId('nav-next'));

    // Should show annotation for move 1 (e4)
    await waitFor(() => {
      expect(screen.getByTestId('annotation-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('annotation-move-label')).toHaveTextContent('1. e4');
    expect(screen.getByText('White opens with the king pawn.')).toBeInTheDocument();
  });

  it('navigates backward with prev button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    // Go forward to move 1
    await user.click(screen.getByTestId('nav-next'));
    await waitFor(() => {
      expect(screen.getByText('Move 1 / 3')).toBeInTheDocument();
    });

    // Go forward to move 2
    await user.click(screen.getByTestId('nav-next'));
    await waitFor(() => {
      expect(screen.getByText('Move 2 / 3')).toBeInTheDocument();
    });

    // Go back to move 1
    await user.click(screen.getByTestId('nav-prev'));
    await waitFor(() => {
      expect(screen.getByText('Move 1 / 3')).toBeInTheDocument();
    });

    // Annotation should show e4 (move at index 0)
    expect(screen.getByTestId('annotation-move-label')).toHaveTextContent('1. e4');
  });

  it('shows progress indicator', async () => {
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    expect(screen.getByText('Move 0 / 3')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-progress')).toBeInTheDocument();
  });

  it('calls onExit when back button clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    await user.click(screen.getByTestId('walkthrough-back'));
    expect(onExit).toHaveBeenCalled();
  });

  it('speaks annotation when advancing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    await user.click(screen.getByTestId('nav-next'));

    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledWith('White opens with the king pawn.', expect.objectContaining({ rate: expect.any(Number) as unknown }));
    });
  });

  it('cycles speed on toggle button tap', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    const btn = screen.getByTestId('walkthrough-speed-toggle');
    expect(btn).toHaveTextContent('Learn');

    await user.click(btn);
    expect(btn).toHaveTextContent('Study');

    await user.click(btn);
    expect(btn).toHaveTextContent('Review');

    await user.click(btn);
    expect(btn).toHaveTextContent('Drill');

    await user.click(btn);
    expect(btn).toHaveTextContent('Learn');
  });

  it('uses first/last buttons to jump to start/end', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<WalkthroughMode opening={testOpening} onExit={onExit} />);

    // Jump to last
    await user.click(screen.getByTestId('nav-last'));

    await waitFor(() => {
      expect(screen.getByText('Move 3 / 3')).toBeInTheDocument();
    });

    // Jump to first
    await user.click(screen.getByTestId('nav-first'));

    await waitFor(() => {
      expect(screen.getByText('Move 0 / 3')).toBeInTheDocument();
    });
  });

  it('renders variation walkthrough when variationIndex provided', async () => {
    render(
      <WalkthroughMode opening={testOpening} variationIndex={0} onExit={onExit} />,
    );

    expect(screen.getByText('Walkthrough: Variation A')).toBeInTheDocument();
  });

  it('renders custom line walkthrough', async () => {
    const customLine = { name: 'Custom Trap', pgn: 'e4 e5', explanation: 'A trap line' };
    render(
      <WalkthroughMode opening={testOpening} customLine={customLine} onExit={onExit} />,
    );

    expect(screen.getByText('Walkthrough: Custom Trap')).toBeInTheDocument();
  });
});
