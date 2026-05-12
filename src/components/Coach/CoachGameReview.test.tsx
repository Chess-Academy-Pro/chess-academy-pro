import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../test/utils';
import type { CoachGameMove, KeyMoment } from '../../types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    // useReviewPlayback was rewired to call speakForced (single-engine
    // Polly chain) — without it, every test that triggers narration
    // playback throws "speakForced is not a function".
    speakForced: vi.fn().mockResolvedValue(undefined),
    speakIfFree: vi.fn().mockResolvedValue(undefined),
    speakAlert: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getLastSpeakDiagnostic: vi.fn().mockReturnValue({
      text: '',
      tier: 'muted',
      pollyAttempted: false,
      pollyOk: null,
      pollyStatus: null,
      audioContextState: 'suspended',
      error: null,
      timestamp: 0,
    }),
  },
}));

vi.mock('../../services/coachGameEngine', () => ({
  getAdaptiveMove: vi.fn().mockResolvedValue({
    move: 'e7e5',
    analysis: {
      bestMove: 'e7e5',
      evaluation: -20,
      isMate: false,
      mateIn: null,
      depth: 10,
      topLines: [{ rank: 1, evaluation: -20, moves: ['e7e5'], mate: null }],
      nodesPerSecond: 1000000,
    },
  }),
}));

vi.mock('../../services/coachTemplates', () => ({
  getMoveCommentaryTemplate: vi.fn().mockReturnValue('Solid choice.'),
}));

vi.mock('../../services/stockfishEngine', () => ({
  stockfishEngine: {
    analyzePosition: vi.fn().mockResolvedValue({
      bestMove: 'e2e4',
      evaluation: 30,
      isMate: false,
      mateIn: null,
      depth: 12,
      topLines: [{ rank: 1, evaluation: 30, moves: ['e2e4'], mate: null }],
      nodesPerSecond: 1000000,
    }),
  },
}));

vi.mock('../../services/coachApi', () => ({
  getCoachCommentary: vi.fn().mockResolvedValue('AI generated commentary for this key moment.'),
  getCoachChatResponse: vi.fn().mockResolvedValue('The position is balanced with chances for both sides.'),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      coachReviewVoice: true,
      voiceEnabled: true,
      showHints: true,
      coachBlunderAlerts: true,
      coachTacticAlerts: true,
      coachPositionalTips: true,
      coachMissedTacticTakeback: true,
    },
    raw: null,
    updateSetting: vi.fn(),
    updateSettings: vi.fn(),
  }),
}));

vi.mock('../../services/coachFeatureService', () => ({
  generateNarrativeSummary: vi.fn().mockResolvedValue('This was a well-played game with some key moments.'),
  generateReviewNarrationSegments: vi.fn().mockResolvedValue({ intro: 'Let us review this game.', closing: 'That concludes the review.' }),
  // generateReviewNarration was added to CoachGameReview.tsx after
  // this mock was last updated; without it, every test that mounts
  // the component fails at module-eval ("No 'generateReviewNarration'
  // export is defined on the mock"). Returns the same ReviewNarration
  // shape the production code resolves to: intro + segments[] + closing.
  generateReviewNarration: vi.fn().mockResolvedValue({
    intro: 'Let us review this game.',
    segments: [],
    closing: 'That concludes the review.',
  }),
}));

vi.mock('../../services/coachPrompts', () => ({
  buildChessContextMessage: vi.fn().mockReturnValue('Position (FEN): test-fen'),
  POSITION_ANALYSIS_ADDITION: 'Test position analysis prompt',
  INTERACTIVE_REVIEW_ADDITION: 'Test interactive review prompt',
}));

vi.mock('./ChatInput', () => ({
  ChatInput: ({ onSend, disabled, placeholder }: {
    onSend: (text: string) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <div data-testid="chat-input" data-disabled={String(disabled ?? false)} data-placeholder={placeholder}>
      <button data-testid="mock-ask-send" onClick={() => onSend('Why is this position bad?')}>Send</button>
    </div>
  ),
}));

vi.mock('../../services/accuracyService', () => ({
  calculateAccuracy: vi.fn().mockReturnValue({ white: 72.5, black: 68.3, moveCount: 10 }),
  getClassificationCounts: vi.fn().mockReturnValue({
    brilliant: 1, great: 2, good: 4, book: 0,
    inaccuracy: 1, mistake: 1, blunder: 0,
  }),
  detectMisses: vi.fn().mockReturnValue(0),
  capEval: (evalCp: number) => {
    if (evalCp >= 20000) return 1500;
    if (evalCp <= -20000) return -1500;
    return evalCp;
  },
  cpLossToAccuracy: (cpLoss: number) => {
    const raw = 103.1668 * Math.exp(-0.009 * cpLoss) - 3.1668;
    return Math.max(0, Math.min(100, raw));
  },
  // ship-2: gamePhaseService now imports winPercent + accuracyFromWinDelta
  // (same algorithm as calculateAccuracy). Mock both so the transitive
  // import doesn't fail at module-eval time during CoachGameReview tests.
  winPercent: (evalCp: number) => {
    const capped = Math.max(-1500, Math.min(1500, evalCp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * capped)) - 1);
  },
  accuracyFromWinDelta: (delta: number) => {
    const d = Math.max(0, delta);
    const raw = 103.1668 * Math.exp(-0.04354 * d) - 3.1669;
    return Math.max(0, Math.min(100, raw));
  },
}));

vi.mock('../../services/boardUtils', () => ({
  getCapturedPieces: vi.fn().mockReturnValue({ white: [], black: [] }),
  getMaterialAdvantage: vi.fn().mockReturnValue(0),
  uciToArrow: vi.fn().mockReturnValue(null),
}));

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({ onMove, initialFen, interactive, arrows }: {
    onMove?: (r: unknown) => void;
    initialFen?: string;
    interactive?: boolean;
    arrows?: unknown[];
  }) => (
    <div data-testid="chess-board" data-fen={initialFen} data-interactive={String(interactive)} data-arrows={arrows?.length ?? 0}>
      {onMove && (
        <button data-testid="mock-board-move" onClick={() => onMove({ from: 'e2', to: 'e4', san: 'e4', fen: 'test-fen-after-move' })}>
          Mock Move
        </button>
      )}
    </div>
  ),
}));

// EvalGraph mock removed — the production component no longer renders
// the eval line graph in review mode (the vertical eval bar on the
// board side carries the same info). See coachGameReview commit.

vi.mock('./ReviewSummaryCard', () => ({
  ReviewSummaryCard: ({ onStartReview, onPlayAgain, onBackToCoach, result }: {
    onStartReview: () => void;
    onPlayAgain: () => void;
    onBackToCoach: () => void;
    result: string;
  }) => (
    <div data-testid="review-summary-card" data-result={result}>
      <button data-testid="start-review-btn" onClick={onStartReview}>Review Game</button>
      <button data-testid="summary-play-again-btn" onClick={onPlayAgain}>Play Again</button>
      <button data-testid="summary-back-btn" onClick={onBackToCoach}>Back to Coach</button>
    </div>
  ),
}));

vi.mock('./PlayerInfoBar', () => ({
  PlayerInfoBar: ({ name }: { name: string }) => (
    <div data-testid="player-info-bar">{name}</div>
  ),
}));

vi.mock('./MoveNavigationControls', () => ({
  MoveNavigationControls: ({ onFirst, onPrev, onNext, onLast, currentIndex, totalMoves }: {
    onFirst: () => void; onPrev: () => void; onNext: () => void; onLast: () => void;
    currentIndex: number; totalMoves: number;
  }) => (
    <div data-testid="move-nav-controls">
      <button data-testid="nav-first" onClick={onFirst} disabled={currentIndex <= -1}>First</button>
      <button data-testid="nav-prev" onClick={onPrev} disabled={currentIndex <= -1}>Prev</button>
      <button data-testid="nav-next" onClick={onNext} disabled={currentIndex >= totalMoves - 1}>Next</button>
      <button data-testid="nav-last" onClick={onLast} disabled={currentIndex >= totalMoves - 1}>Last</button>
    </div>
  ),
}));

vi.mock('./MoveListPanel', () => ({
  MoveListPanel: ({ currentMoveIndex, openingName }: { currentMoveIndex: number | null; openingName: string | null }) => (
    <div data-testid="move-list-panel" data-current-index={currentMoveIndex} data-opening={openingName ?? ''}>
      Move List
    </div>
  ),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// ─── Test Data ──────────────────────────────────────────────────────────────

const mockMoves: CoachGameMove[] = [
  { moveNumber: 1, san: 'e4', fen: 'fen-after-e4', isCoachMove: false, commentary: 'Good opening', evaluation: 30, classification: 'good', expanded: false, bestMove: null, bestMoveEval: null, preMoveEval: 0 },
  { moveNumber: 2, san: 'e5', fen: 'fen-after-e5', isCoachMove: true, commentary: '', evaluation: -20, classification: null, expanded: false, bestMove: null, bestMoveEval: null, preMoveEval: 30 },
  { moveNumber: 3, san: 'Nf3', fen: 'fen-after-nf3', isCoachMove: false, commentary: 'Developing knight', evaluation: 40, classification: 'good', expanded: false, bestMove: 'g1f3', bestMoveEval: 40, preMoveEval: 20 },
  { moveNumber: 4, san: 'Nc6', fen: 'fen-after-nc6', isCoachMove: true, commentary: '', evaluation: -15, classification: null, expanded: false, bestMove: null, bestMoveEval: null, preMoveEval: 40 },
];

const mockKeyMoments: KeyMoment[] = [
  { moveNumber: 1, fen: 'fen-after-e4', explanation: 'You missed a fork', type: 'blunder' },
  { moveNumber: 3, fen: 'fen-after-nf3', explanation: 'Excellent sacrifice', type: 'brilliant' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderReview(overrides?: {
  moves?: CoachGameMove[];
  keyMoments?: KeyMoment[];
  playerColor?: 'white' | 'black';
  result?: string;
  openingName?: string | null;
  onPlayAgain?: () => void;
  onBackToCoach?: () => void;
}): ReturnType<typeof render> {
  return render(
    <CoachGameReviewComponent
      moves={overrides?.moves ?? mockMoves}
      keyMoments={overrides?.keyMoments ?? mockKeyMoments}
      playerColor={overrides?.playerColor ?? 'white'}
      result={overrides?.result ?? 'win'}
      openingName={overrides?.openingName ?? 'Italian Game'}
      playerName="Player"
      playerRating={1420}
      opponentRating={1320}
      onPlayAgain={overrides?.onPlayAgain ?? vi.fn()}
      onBackToCoach={overrides?.onBackToCoach ?? vi.fn()}
    />,
  );
}

/** Render and click through the summary card into analysis mode */
function renderAnalysis(overrides?: Parameters<typeof renderReview>[0]): ReturnType<typeof render> {
  const result = renderReview(overrides);
  // Click "Review Game" to transition from summary to analysis phase
  // (this also activates auto-review; stop it so manual navigation tests work)
  fireEvent.click(screen.getByTestId('start-review-btn'));
  const stopBtn = screen.queryByTestId('auto-review-stop-btn');
  if (stopBtn) fireEvent.click(stopBtn);
  return result;
}

// We need a lazy import reference since vi.mock hoists above imports
let CoachGameReviewComponent: typeof import('./CoachGameReview').CoachGameReview;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CoachGameReview', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('./CoachGameReview');
    CoachGameReviewComponent = mod.CoachGameReview;
  });

  it('renders empty state when no moves', () => {
    renderReview({ moves: [] });

    const container = screen.getByTestId('coach-game-review');
    expect(container).toBeInTheDocument();
    expect(container).toHaveTextContent('No moves to review');
  });

  // ─── Summary Phase ─────────────────────────────────────────────────────────

  it('shows summary card first (not analysis)', () => {
    renderReview();

    expect(screen.getByTestId('review-summary-card')).toBeInTheDocument();
    expect(screen.queryByTestId('chess-board')).not.toBeInTheDocument();
  });

  it('summary card has Review Game, Play Again, and Back to Coach buttons', () => {
    renderReview();

    expect(screen.getByTestId('start-review-btn')).toHaveTextContent('Review Game');
    expect(screen.getByTestId('summary-play-again-btn')).toHaveTextContent('Play Again');
    expect(screen.getByTestId('summary-back-btn')).toHaveTextContent('Back to Coach');
  });

  it('summary card passes result', () => {
    renderReview({ result: 'loss' });

    expect(screen.getByTestId('review-summary-card')).toHaveAttribute('data-result', 'loss');
  });

  it('summary Play Again callback fires', () => {
    const onPlayAgain = vi.fn();
    renderReview({ onPlayAgain });

    fireEvent.click(screen.getByTestId('summary-play-again-btn'));
    expect(onPlayAgain).toHaveBeenCalledOnce();
  });

  it('summary Back to Coach callback fires', () => {
    const onBackToCoach = vi.fn();
    renderReview({ onBackToCoach });

    fireEvent.click(screen.getByTestId('summary-back-btn'));
    expect(onBackToCoach).toHaveBeenCalledOnce();
  });

  // ─── Analysis Phase (after clicking Review Game) ───────────────────────────
  //
  // The 21 tests below are it.skip'd. They drove the analysis-phase
  // layout via the "Review Game" button on the summary card. That
  // entire JSX branch was deleted in WO-COACH-UNIFY-01 cleanup
  // because walk-phase is now the only review surface (per user
  // architecture: "There should not be an analysis phase").
  //
  // The features these tests covered (Ask, AI commentary,
  // prev/next nav, what-if mode, move list) are reimplemented in
  // walk-phase. The tests need to be rewritten to drive walk-phase
  // instead — that's a focused follow-up commit. Keeping them
  // skipped (rather than deleted) so the named expectations are
  // visible while the rewrite is pending.

  it.skip('renders the review layout with all sections after clicking Review Game', () => {
    renderAnalysis();

    expect(screen.getByTestId('coach-game-review')).toBeInTheDocument();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(screen.getByTestId('move-list-panel')).toBeInTheDocument();
    expect(screen.getByTestId('move-nav-controls')).toBeInTheDocument();
  });

  it.skip('starts at beginning after clicking Review Game', () => {
    renderAnalysis();

    // After clicking Review Game, should be at starting position (index -1)
    expect(screen.getByTestId('chess-board')).toHaveAttribute(
      'data-fen',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
  });

  it.skip('shows player info bars', () => {
    renderAnalysis();

    const infoBars = screen.getAllByTestId('player-info-bar');
    expect(infoBars.length).toBe(2);
    expect(infoBars[0]).toHaveTextContent('Stockfish Bot');
    expect(infoBars[1]).toHaveTextContent('Player');
  });

  it.skip('passes opening name to MoveListPanel', () => {
    renderAnalysis({ openingName: 'Sicilian Defense' });

    expect(screen.getByTestId('move-list-panel')).toHaveAttribute('data-opening', 'Sicilian Defense');
  });

  it.skip('navigating with prev/next updates board position', () => {
    renderAnalysis();

    // Start at beginning (index -1), navigate forward
    fireEvent.click(screen.getByTestId('nav-next'));
    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-e4');

    fireEvent.click(screen.getByTestId('nav-next'));
    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-e5');

    // Click prev
    fireEvent.click(screen.getByTestId('nav-prev'));
    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-e4');
  });

  it.skip('navigating to first shows starting position', () => {
    renderAnalysis();

    // Go to last then back to first
    fireEvent.click(screen.getByTestId('nav-last'));
    fireEvent.click(screen.getByTestId('nav-first'));

    expect(screen.getByTestId('chess-board')).toHaveAttribute(
      'data-fen',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
  });

  it.skip('navigating to last shows final position', () => {
    renderAnalysis();

    fireEvent.click(screen.getByTestId('nav-last'));

    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-nc6');
  });

  it.skip('shows commentary for key moment moves', () => {
    renderAnalysis();

    // Navigate to move index 0 (moveNumber 1) which is a key moment
    fireEvent.click(screen.getByTestId('nav-next'));

    // Move 1 has key moment explanation 'You missed a fork'
    expect(screen.getByTestId('review-commentary')).toHaveTextContent('You missed a fork');
  });

  it.skip('shows play again and back to coach buttons in analysis', () => {
    renderAnalysis();

    expect(screen.getByTestId('play-again-btn')).toBeInTheDocument();
    expect(screen.getByTestId('play-again-btn')).toHaveTextContent('Play Again');
    expect(screen.getByTestId('back-to-coach-btn')).toBeInTheDocument();
    expect(screen.getByTestId('back-to-coach-btn')).toHaveTextContent('Back to Coach');
  });

  it.skip('onPlayAgain callback fires when clicked in analysis', () => {
    const onPlayAgain = vi.fn();
    renderAnalysis({ onPlayAgain });

    fireEvent.click(screen.getByTestId('play-again-btn'));
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });

  it.skip('onBackToCoach callback fires when clicked in analysis', () => {
    const onBackToCoach = vi.fn();
    renderAnalysis({ onBackToCoach });

    fireEvent.click(screen.getByTestId('back-to-coach-btn'));
    expect(onBackToCoach).toHaveBeenCalledTimes(1);
  });

  it('empty moves show play again and back to coach buttons', () => {
    const onPlayAgain = vi.fn();
    const onBackToCoach = vi.fn();
    renderReview({ moves: [], onPlayAgain, onBackToCoach });

    const playBtn = screen.getByText('Play Again');
    const backBtn = screen.getByText('Back to Coach');
    expect(playBtn).toBeInTheDocument();
    expect(backBtn).toBeInTheDocument();

    fireEvent.click(playBtn);
    expect(onPlayAgain).toHaveBeenCalledTimes(1);

    fireEvent.click(backBtn);
    expect(onBackToCoach).toHaveBeenCalledTimes(1);
  });

  it.skip('entering what-if mode shows banner and back-to-review button', async () => {
    renderAnalysis();

    // Initially no whatif banner
    expect(screen.queryByTestId('whatif-banner')).not.toBeInTheDocument();

    // Navigate to a move first, then make a board move
    fireEvent.click(screen.getByTestId('nav-last'));
    fireEvent.click(screen.getByTestId('mock-board-move'));

    await waitFor(() => {
      expect(screen.getByTestId('whatif-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('back-to-review-btn')).toBeInTheDocument();
    expect(screen.getByTestId('back-to-review-btn')).toHaveTextContent('Back to Review');
  });

  it.skip('what-if mode shows variation move list', async () => {
    renderAnalysis();

    fireEvent.click(screen.getByTestId('nav-last'));
    fireEvent.click(screen.getByTestId('mock-board-move'));

    await waitFor(() => {
      expect(screen.getByTestId('whatif-moves')).toBeInTheDocument();
    });
    expect(screen.getByTestId('whatif-moves')).toHaveTextContent('e4');
  });

  it.skip('back-to-review button returns to analysis mode', async () => {
    renderAnalysis();

    fireEvent.click(screen.getByTestId('nav-last'));
    fireEvent.click(screen.getByTestId('mock-board-move'));

    await waitFor(() => {
      expect(screen.getByTestId('whatif-banner')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('back-to-review-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('whatif-banner')).not.toBeInTheDocument();
    });

    expect(screen.getByTestId('move-nav-controls')).toBeInTheDocument();
  });

  it.skip('updates the board FEN when navigating forward (one ply per click)', () => {
    renderAnalysis();

    // Step back to start, then advance one ply at a time. Each click
    // should land exactly on the next ply's FEN — this is the
    // regression guard for the "moves 2 pieces at a time" bug.
    fireEvent.click(screen.getByTestId('nav-first'));
    fireEvent.click(screen.getByTestId('nav-next'));
    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-e4');
    fireEvent.click(screen.getByTestId('nav-next'));
    expect(screen.getByTestId('chess-board')).toHaveAttribute('data-fen', 'fen-after-e5');
  });

  // ─── AI Features ───────────────────────────────────────────────────────────

  it.skip('shows "Ask about this position" button', () => {
    renderAnalysis();

    expect(screen.getByTestId('ask-position-btn')).toBeInTheDocument();
    expect(screen.getByTestId('ask-position-btn')).toHaveTextContent('Ask about this position');
  });

  it.skip('expands ask panel when button is clicked', () => {
    renderAnalysis();

    expect(screen.queryByTestId('ask-position-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ask-position-btn'));

    expect(screen.getByTestId('ask-position-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it.skip('sends question to coach API and shows response', async () => {
    const { getCoachChatResponse } = await import('../../services/coachApi');
    renderAnalysis();

    fireEvent.click(screen.getByTestId('ask-position-btn'));
    fireEvent.click(screen.getByTestId('mock-ask-send'));

    await waitFor(() => {
      expect(getCoachChatResponse).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ask-response')).toBeInTheDocument();
    });
  });

  it.skip('loads AI commentary for key moment moves (blunder)', async () => {
    const { getCoachCommentary } = await import('../../services/coachApi');
    const blunderMoves: CoachGameMove[] = [
      { moveNumber: 1, san: 'e4', fen: 'fen-after-e4', isCoachMove: false, commentary: '', evaluation: 30, classification: 'blunder', expanded: false, bestMove: 'e2e4', bestMoveEval: 30, preMoveEval: 0 },
      { moveNumber: 2, san: 'e5', fen: 'fen-after-e5', isCoachMove: true, commentary: '', evaluation: -20, classification: null, expanded: false, bestMove: null, bestMoveEval: null, preMoveEval: 30 },
    ];

    renderAnalysis({ moves: blunderMoves });

    // Navigate to the blunder move (index 0)
    fireEvent.click(screen.getByTestId('nav-next'));

    await waitFor(() => {
      expect(getCoachCommentary).toHaveBeenCalledWith(
        'interactive_review',
        expect.objectContaining({ fen: 'fen-after-e4' }),
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('ai-commentary')).toBeInTheDocument();
    });
  });

  it.skip('loads AI commentary for ordinary good moves too', async () => {
    // Users wanted narration on every move, not only blunders/mistakes
    // (see CoachGameReview: the gating that used to skip "good" moves
    // was removed so every navigated move gets its own commentary).
    const { getCoachCommentary } = await import('../../services/coachApi');
    (getCoachCommentary as ReturnType<typeof vi.fn>).mockClear();

    renderAnalysis();

    // Navigate to move index 0 (classification: 'good')
    fireEvent.click(screen.getByTestId('nav-next'));

    await waitFor(() => {
      expect(getCoachCommentary).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ai-commentary')).toBeInTheDocument();
    });
  });

  it.skip('resets ask panel when navigating to different move', () => {
    renderAnalysis();

    // Navigate to a move first
    fireEvent.click(screen.getByTestId('nav-next'));

    // Expand ask panel
    fireEvent.click(screen.getByTestId('ask-position-btn'));
    expect(screen.getByTestId('ask-position-panel')).toBeInTheDocument();

    // Navigate to different move
    fireEvent.click(screen.getByTestId('nav-next'));

    // Ask panel should be collapsed
    expect(screen.queryByTestId('ask-position-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('ask-position-btn')).toBeInTheDocument();
  });
});
