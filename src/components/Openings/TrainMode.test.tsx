import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { render } from '../../test/utils';
import { TrainMode } from './TrainMode';
import { buildOpeningRecord } from '../../test/factories';
import type { OpeningRecord, OpeningVariation } from '../../types';

 

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({ initialFen, orientation, interactive, onMove, highlightSquares }: {
    initialFen?: string;
    orientation?: string;
    interactive?: boolean;
    onMove?: (result: { from: string; to: string; san: string; fen: string }) => void;
    highlightSquares?: { from: string; to: string } | null;
  }) => (
    <div
      data-testid="chess-board"
      data-fen={initialFen}
      data-orientation={orientation}
      data-interactive={String(interactive)}
      data-highlight={highlightSquares ? `${highlightSquares.from}-${highlightSquares.to}` : ''}
    >
      Board
      {interactive && onMove && (
        <>
          <button
            data-testid="make-correct-move"
            onClick={() => onMove({ from: 'e2', to: 'e4', san: 'e4', fen: '' })}
          >
            Correct
          </button>
          <button
            data-testid="make-wrong-move"
            onClick={() => onMove({ from: 'a2', to: 'a3', san: 'a3', fen: '' })}
          >
            Wrong
          </button>
        </>
      )}
    </div>
  ),
}));

vi.mock('../Board/ControlledChessBoard', () => ({
  ControlledChessBoard: (props: Record<string, unknown>) => {
    const game = props.game as { fen?: string; boardOrientation?: string } | undefined;
    const interactive = props.interactive as boolean | undefined;
    const onMove = props.onMove as ((result: { from: string; to: string; san: string; fen: string }) => void) | undefined;
    const highlightSquares = props.highlightSquares as { from: string; to: string } | null | undefined;
    return (
      <div
        data-testid="chess-board"
        data-fen={game?.fen ?? ''}
        data-orientation={game?.boardOrientation ?? 'white'}
        data-interactive={String(interactive ?? true)}
        data-highlight={highlightSquares ? `${highlightSquares.from}-${highlightSquares.to}` : ''}
      >
        Board
        {interactive && onMove && (
          <>
            <button
              data-testid="make-correct-move"
              onClick={() => onMove({ from: 'e2', to: 'e4', san: 'e4', fen: '' })}
            >
              Correct
            </button>
            <button
              data-testid="make-wrong-move"
              onClick={() => onMove({ from: 'a2', to: 'a3', san: 'a3', fen: '' })}
            >
              Wrong
            </button>
          </>
        )}
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

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    speakFast: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
    warmup: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn(),
  },
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// ─── Test Data ───────────────────────────────────────────────────────────────

const trapLines: OpeningVariation[] = [
  { name: 'Trap Alpha', pgn: 'e4 e5 Nc3', explanation: 'Pin the knight for a fork' },
  { name: 'Trap Beta', pgn: 'e4 e5 Bc4', explanation: 'Bishops gambit setup' },
];

const testOpening: OpeningRecord = buildOpeningRecord({
  id: 'train-test',
  name: 'Vienna Game',
  pgn: 'e4 e5 Nc3',
  color: 'white',
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderTrain(
  overrides: {
    opening?: OpeningRecord;
    lines?: OpeningVariation[];
    sectionLabel?: string;
    onExit?: ReturnType<typeof vi.fn<() => void>>;
  } = {},
): { onExit: ReturnType<typeof vi.fn<() => void>> } {
  const onExit = overrides.onExit ?? vi.fn<() => void>();

  render(
    <TrainMode
      opening={overrides.opening ?? testOpening}
      lines={overrides.lines ?? trapLines}
      sectionLabel={overrides.sectionLabel ?? 'Traps & Pitfalls'}
      onExit={onExit}
    />,
  );

  return { onExit };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TrainMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders the train-mode container', () => {
      renderTrain();
      expect(screen.getByTestId('train-mode')).toBeInTheDocument();
    });

    it('renders the chess board', () => {
      renderTrain();
      expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    });

    it('shows the current line name in the header', () => {
      renderTrain();
      expect(screen.getByText(/Train: Trap Alpha/)).toBeInTheDocument();
    });

    it('shows section label and line counter', () => {
      renderTrain();
      expect(screen.getByText(/Traps & Pitfalls/)).toBeInTheDocument();
      expect(screen.getByText(/Line 1 \/ 2/)).toBeInTheDocument();
    });

    it('shows progress bar', () => {
      renderTrain();
      expect(screen.getByTestId('train-progress')).toBeInTheDocument();
    });

    it('shows move counter', () => {
      renderTrain();
      expect(screen.getByText(/Move 0 \/ 3/)).toBeInTheDocument();
    });

    it('shows "What\'s the best move?" prompt on player turn', () => {
      renderTrain();
      expect(screen.getByTestId('train-prompt')).toBeInTheDocument();
      expect(screen.getByTestId('train-prompt')).toHaveTextContent("What's the best move?");
    });

    it('uses correct board orientation', () => {
      renderTrain();
      expect(screen.getByTestId('chess-board')).toHaveAttribute('data-orientation', 'white');
    });

    it('uses black orientation for black opening', () => {
      const blackOpening = buildOpeningRecord({ id: 'black-train', color: 'black', pgn: 'e4 c5' });
      renderTrain({ opening: blackOpening });
      expect(screen.getByTestId('chess-board')).toHaveAttribute('data-orientation', 'black');
    });
  });

  describe('back button', () => {
    it('calls onExit when back button is clicked', () => {
      const { onExit } = renderTrain();
      screen.getByTestId('train-back').click();
      expect(onExit).toHaveBeenCalledOnce();
    });
  });

  describe('correct move', () => {
    it('shows green flash after correct move', async () => {
      renderTrain();

      const correctBtn = screen.getByTestId('make-correct-move');
      await act(async () => { correctBtn.click(); });

      await waitFor(() => {
        expect(screen.getByTestId('correct-flash')).toBeInTheDocument();
      });
    });

    it('advances move index after correct move', async () => {
      renderTrain();

      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      // After correct move, opponent auto-plays after 500ms
      await act(async () => { vi.advanceTimersByTime(600); });

      await waitFor(() => {
        expect(screen.getByText(/Move [2-3] \/ 3/)).toBeInTheDocument();
      });
    });
  });

  describe('wrong move', () => {
    it('shows error card with reset message', async () => {
      renderTrain();

      await act(async () => {
        screen.getByTestId('make-wrong-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('wrong-flash')).toBeInTheDocument();
        expect(screen.getByTestId('explanation-card')).toBeInTheDocument();
      });
    });

    it('shows undo button on wrong move', async () => {
      renderTrain();

      await act(async () => {
        screen.getByTestId('make-wrong-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
      });
    });

    it('undo resets to start of line and shows hint', async () => {
      renderTrain();

      // Make wrong move
      await act(async () => {
        screen.getByTestId('make-wrong-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
      });

      // Click undo
      await act(async () => {
        screen.getByTestId('undo-btn').click();
      });

      // After undo, board should be interactive again (back at move 0)
      await waitFor(() => {
        expect(screen.getByTestId('chess-board')).toHaveAttribute('data-interactive', 'true');
      });

      // Should show hint with explanation text
      await waitFor(() => {
        expect(screen.getByText(/Pin the knight for a fork/)).toBeInTheDocument();
      });
    });
  });

  describe('line navigation', () => {
    it('next line button is present and advances to next line', async () => {
      renderTrain();

      const nextBtn = screen.getByLabelText('Next line');
      expect(nextBtn).toBeInTheDocument();

      await act(async () => { nextBtn.click(); });

      // Should now show Trap Beta
      expect(screen.getByText(/Train: Trap Beta/)).toBeInTheDocument();
      expect(screen.getByText(/Line 2 \/ 2/)).toBeInTheDocument();
    });

    it('previous line button navigates back', async () => {
      renderTrain();

      // Go to line 2
      await act(async () => {
        screen.getByLabelText('Next line').click();
      });
      expect(screen.getByText(/Trap Beta/)).toBeInTheDocument();

      // Go back to line 1
      await act(async () => {
        screen.getByLabelText('Previous line').click();
      });
      expect(screen.getByText(/Trap Alpha/)).toBeInTheDocument();
    });

    it('previous line button is disabled on first line', () => {
      renderTrain();
      expect(screen.getByLabelText('Previous line')).toBeDisabled();
    });

    it('next line button is disabled on last line', async () => {
      renderTrain();
      await act(async () => {
        screen.getByLabelText('Next line').click();
      });
      expect(screen.getByLabelText('Next line')).toBeDisabled();
    });
  });

  describe('line completion', () => {
    it('shows completion screen with line name when all moves played', async () => {
      // Use a 1-move line (white plays e4) so we can complete it with our mock
      const shortLines: OpeningVariation[] = [
        { name: 'Quick Trap', pgn: 'e4', explanation: 'One move trap' },
      ];

      renderTrain({ lines: shortLines });

      // Play the single correct move (e2->e4)
      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-complete')).toBeInTheDocument();
        expect(screen.getByText('Quick Trap')).toBeInTheDocument();
      });
    });

    it('shows retry and done buttons on completion of last line', async () => {
      const shortLines: OpeningVariation[] = [
        { name: 'Quick Trap', pgn: 'e4', explanation: 'One move trap' },
      ];

      renderTrain({ lines: shortLines });

      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-retry')).toBeInTheDocument();
        expect(screen.getByTestId('train-exit')).toBeInTheDocument();
      });
    });

    it('shows next line button when more lines remain', async () => {
      const twoLines: OpeningVariation[] = [
        { name: 'Line A', pgn: 'e4', explanation: 'First trap' },
        { name: 'Line B', pgn: 'e4', explanation: 'Second trap' },
      ];

      renderTrain({ lines: twoLines });

      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-next')).toBeInTheDocument();
      });
    });

    it('retry button restarts the current line', async () => {
      const shortLines: OpeningVariation[] = [
        { name: 'Quick Trap', pgn: 'e4', explanation: 'One move trap' },
      ];

      renderTrain({ lines: shortLines });

      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-retry')).toBeInTheDocument();
      });

      await act(async () => {
        screen.getByTestId('train-retry').click();
      });

      // Should be back on the board, not the completion screen
      await waitFor(() => {
        expect(screen.getByTestId('train-mode')).toBeInTheDocument();
      });
    });

    it('done button calls onExit', async () => {
      const shortLines: OpeningVariation[] = [
        { name: 'Quick Trap', pgn: 'e4', explanation: 'One move trap' },
      ];

      const { onExit } = renderTrain({ lines: shortLines });

      await act(async () => {
        screen.getByTestId('make-correct-move').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-exit')).toBeInTheDocument();
      });

      await act(async () => {
        screen.getByTestId('train-exit').click();
      });

      expect(onExit).toHaveBeenCalledOnce();
    });
  });
});
