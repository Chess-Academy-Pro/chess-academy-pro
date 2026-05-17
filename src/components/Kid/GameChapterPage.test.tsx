import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render as rtlRender, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { GameChapterPage } from './GameChapterPage';

// API-leak guard (WO-TEST-CLEANUP-01 Part A) — intercepts modern
// brain entry point + all 6 network-wrapping coachApi exports.
// Spread-original-override preserves type exports / constants /
// helpers; only the network calls are replaced with vi.fn() resolves.
vi.mock('../../coach/coachService', () => ({
  coachService: {
    ask: vi.fn().mockResolvedValue({ text: '', toolCallIds: [], provider: 'deepseek' }),
  },
}));
vi.mock('../../services/coachApi', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../services/coachApi')>();
  return {
    ...orig,
    getCoachCommentary: vi.fn().mockResolvedValue(''),
    getCoachChatResponse: vi.fn().mockResolvedValue(''),
    getCoachStructuredResponse: vi.fn().mockResolvedValue({}),
    getKidLlmResponse: vi.fn().mockResolvedValue(''),
    callAnthropicWithTool: vi.fn().mockResolvedValue({}),
    callDeepseekWithTool: vi.fn().mockResolvedValue({}),
  };
});
import { useAppStore } from '../../stores/appStore';
import { buildUserProfile } from '../../test/factories';
import type { KidGameConfig, JourneyChapter } from '../../types';

// ─── Test Data ──────────────────────────────────────────────────────────────

const testChapter: JourneyChapter = {
  id: 'pawn',
  title: 'The Brave Pawn',
  subtitle: 'Learn pawn moves',
  icon: '\u265F',
  storyIntro: 'Once upon a time there was a brave pawn.',
  storyOutro: 'The pawn completed its journey!',
  requiredPuzzleScore: 1,
  lessons: [
    {
      id: 'pawn-1',
      title: 'First Steps',
      story: 'Pawns move forward.',
      fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
      highlightSquares: ['e3', 'e4'],
      instruction: 'The pawn can move forward.',
    },
  ],
  puzzles: [
    {
      id: 'pawn-p1',
      fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
      solution: ['e4'],
      hint: 'Move the pawn two squares!',
      successMessage: 'Great job!',
    },
  ],
};

const testConfig: KidGameConfig = {
  gameId: 'pawns-journey',
  title: 'Test Game',
  icon: '\uD83D\uDDFA\uFE0F',
  routePrefix: '/kid/test',
  chapters: [testChapter],
  chapterOrder: ['pawn', 'rook'],
};

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({ onMove, initialFen }: { onMove?: (move: unknown) => void; initialFen?: string }) => (
    <div data-testid="chess-board" data-fen={initialFen}>
      <button data-testid="mock-move-btn" onClick={() => onMove?.({ from: 'e2', to: 'e4', san: 'e4', fen: '4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1' })}>
        Move
      </button>
      <button data-testid="mock-wrong-move-btn" onClick={() => onMove?.({ from: 'd2', to: 'd4', san: 'd4', fen: '4k3/8/8/8/3P4/8/8/4K3 b - d3 0 1' })}>
        Wrong Move
      </button>
    </div>
  ),
}));

vi.mock('../Board/ControlledChessBoard', () => ({
  ControlledChessBoard: (props: Record<string, unknown>) => {
    const game = props.game as { fen?: string; boardOrientation?: string } | undefined;
    const onMove = props.onMove as ((move: unknown) => void) | undefined;
    return (
      <div data-testid="chess-board" data-fen={game?.fen ?? ''}>
        <button data-testid="mock-move-btn" onClick={() => onMove?.({ from: 'e2', to: 'e4', san: 'e4', fen: '4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1' })}>
          Move
        </button>
        <button data-testid="mock-wrong-move-btn" onClick={() => onMove?.({ from: 'd2', to: 'd4', san: 'd4', fen: '4k3/8/8/8/3P4/8/8/4K3 b - d3 0 1' })}>
          Wrong Move
        </button>
      </div>
    );
  },
}));

vi.mock('../../hooks/useChessGame', () => ({
  useChessGame: (_initialFen?: string, initialOrientation: 'white' | 'black' = 'white') => ({
    fen: _initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    position: _initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
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

vi.mock('./StarDisplay', () => ({
  StarDisplay: ({ earned, total }: { earned: number; total: number }) => (
    <div data-testid="star-display">
      {earned}/{total}
    </div>
  ),
}));

vi.mock('../Coach/GameChatPanel', () => ({
  GameChatPanel: vi.fn(() => <div data-testid="game-chat-panel">Chat</div>),
}));

vi.mock('../../hooks/useResizableDivider', () => ({
  useResizableDivider: () => ({
    chatPercent: 60,
    rightColumnRef: { current: null },
    dividerProps: {
      onPointerDown: vi.fn(),
    },
  }),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../services/journeyService', () => ({
  getGameProgress: vi.fn(),
  initGameProgress: vi.fn(),
  completeGameLesson: vi.fn(),
  recordGamePuzzleAttempt: vi.fn(),
  completeGameChapter: vi.fn(),
  getChapterProgress: vi.fn(),
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: { speak: vi.fn().mockResolvedValue(undefined), stop: vi.fn() },
}));

vi.mock('../../services/kidPuzzleService', () => ({
  getKidPuzzles: vi.fn().mockResolvedValue([
    { id: 'db-pawn-1', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', solution: ['e4'], hint: 'Move the pawn two squares!', successMessage: 'Great job!' },
  ]),
  generateKidPuzzles: vi.fn().mockResolvedValue([
    { id: 'gen-pawn-1', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', solution: ['e4'], hint: 'Move the pawn two squares!', successMessage: 'Great job!' },
  ]),
}));

vi.mock('../../services/stockfishEngine', () => ({
  stockfishEngine: {
    analyzePosition: vi.fn().mockResolvedValue({
      evaluation: 0,
      bestMove: 'e2e4',
      isMate: false,
      topLines: [],
    }),
  },
}));

vi.mock('../../services/themeService', () => ({
  applyTheme: vi.fn(),
  getThemeById: vi.fn().mockReturnValue({ id: 'kid-mode', name: 'Kid Mode', colors: {} }),
}));

vi.mock('../../hooks/usePieceSound', () => ({
  usePieceSound: () => ({
    playMoveSound: vi.fn(),
    playCelebration: vi.fn(),
    playEncouragement: vi.fn(),
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderChapterPage(): ReturnType<typeof rtlRender> {
  return rtlRender(
    <MemoryRouter initialEntries={['/kid/test/pawn']}>
      <MotionConfig transition={{ duration: 0 }}>
        <Routes>
          <Route
            path="/kid/test/:chapterId"
            element={<GameChapterPage config={testConfig} />}
          />
        </Routes>
      </MotionConfig>
    </MemoryRouter>,
  );
}

const defaultProgress = {
  chapters: {},
  currentChapterId: 'pawn' as const,
  startedAt: new Date().toISOString(),
  completedAt: null,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GameChapterPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useAppStore.getState().reset();
    useAppStore.getState().setActiveProfile(buildUserProfile({ isKidMode: true }));

    const {
      getGameProgress,
      initGameProgress,
      completeGameLesson,
      recordGamePuzzleAttempt,
      completeGameChapter,
      getChapterProgress,
    } = await import('../../services/journeyService');

    vi.mocked(getGameProgress).mockResolvedValue(null);
    vi.mocked(initGameProgress).mockResolvedValue({ ...defaultProgress });
    vi.mocked(completeGameLesson).mockResolvedValue({ ...defaultProgress });
    vi.mocked(recordGamePuzzleAttempt).mockResolvedValue({ ...defaultProgress });
    vi.mocked(completeGameChapter).mockResolvedValue({
      ...defaultProgress,
      currentChapterId: 'rook',
    });
    vi.mocked(getChapterProgress).mockReturnValue({
      chapterId: 'pawn',
      lessonsCompleted: 0,
      puzzlesCompleted: 0,
      puzzlesCorrect: 0,
      completed: false,
      bestScore: 0,
      completedAt: null,
    });
  });

  it('renders intro phase initially with storyIntro text', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-intro')).toBeInTheDocument();
    });

    const titles = screen.getAllByText('The Brave Pawn');
    expect(titles.length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText('Once upon a time there was a brave pawn.'),
    ).toBeInTheDocument();
  });

  it('Begin button transitions to lesson phase', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-lesson')).toBeInTheDocument();
    });
  });

  it('lesson phase shows lesson title, story, and instruction', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-lesson')).toBeInTheDocument();
    });

    expect(screen.getByText('First Steps')).toBeInTheDocument();
    expect(screen.getByText('Pawns move forward.')).toBeInTheDocument();
    expect(screen.getByText('The pawn can move forward.')).toBeInTheDocument();
  });

  it('lesson phase shows chess board with correct FEN', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    });

    expect(screen.getByTestId('chess-board')).toHaveAttribute(
      'data-fen',
      '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
    );
  });

  it('Next button advances through lessons to puzzle phase', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-next-btn')).toBeInTheDocument();
    });

    // With only 1 lesson, clicking Next should go to puzzle phase
    fireEvent.click(screen.getByTestId('chapter-next-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-puzzle')).toBeInTheDocument();
    });
  });

  it('puzzle phase shows puzzle counter and chat panel', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-next-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-next-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-puzzle')).toBeInTheDocument();
    });

    expect(screen.getByText('Puzzle 1 of 1')).toBeInTheDocument();
  });

  it('hint button advances through hint levels and reveals nudge text', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-next-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-next-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('hint-button')).toBeInTheDocument();
    });

    // No hint text before clicking
    expect(screen.queryByTestId('chapter-hint-text')).not.toBeInTheDocument();

    // Click 1: level 0→1 (arrows only, no text yet). Wrap in `act` so
    // React flushes the synchronous tier bump AND the async IIFE inside
    // requestHint (the post-await setHintState that lands nudgeText)
    // before the next assertion fires. The previous synchronous
    // fireEvent.click pattern raced the disable-on-isAnalyzing render
    // and blocked click 2; mirroring PracticeMode's `await act` flow.
    await act(async () => {
      fireEvent.click(screen.getByTestId('hint-button'));
    });
    expect(screen.getByTestId('hint-button')).toHaveAttribute('data-level', '1');

    // Click 2: level 1→2 (nudge text appears)
    await act(async () => {
      fireEvent.click(screen.getByTestId('hint-button'));
    });
    expect(screen.getByTestId('hint-button')).toHaveAttribute('data-level', '2');
    expect(screen.getByTestId('chapter-hint-text')).toBeInTheDocument();
  });

  it('correct puzzle move shows success feedback', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-next-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-next-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-puzzle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mock-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('puzzle-feedback')).toBeInTheDocument();
    });

    expect(screen.getByText('Correct!')).toBeInTheDocument();
  });

  it('wrong puzzle move shows try again feedback', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-next-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-next-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-puzzle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mock-wrong-move-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('puzzle-feedback')).toBeInTheDocument();
    });

    expect(screen.getByText('Try again!')).toBeInTheDocument();
  });

  it('back button is rendered in intro phase', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-back-btn')).toBeInTheDocument();
    });
  });

  it('voice toggle is rendered in intro phase', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-voice-toggle')).toBeInTheDocument();
    });
  });

  it('voice toggle is rendered in lesson phase (via header)', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('chapter-voice-toggle')).toBeInTheDocument();
    });
  });

  it('lesson phase renders progress dots', async () => {
    renderChapterPage();

    await waitFor(() => {
      expect(screen.getByTestId('chapter-begin-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('chapter-begin-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('lesson-dots')).toBeInTheDocument();
    });
  });
});
