import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '../../test/utils';
import { CoachGamePage } from './CoachGamePage';
import { useAppStore } from '../../stores/appStore';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { voiceService } from '../../services/voiceService';
import { buildUserProfile } from '../../test/factories';

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    speakForced: vi.fn().mockResolvedValue(undefined),
    speakForcedPollyOnly: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}));

vi.mock('../../services/voiceInputService', () => ({
  voiceInputService: {
    isSupported: vi.fn().mockReturnValue(false),
    startListening: vi.fn().mockReturnValue(false),
    stopListening: vi.fn(),
    onResult: vi.fn(),
  },
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
    queueAnalysis: vi.fn().mockResolvedValue({
      bestMove: 'e2e4',
      evaluation: 30,
      isMate: false,
      mateIn: null,
      depth: 16,
      topLines: [{ rank: 1, evaluation: 30, moves: ['e2e4'], mate: null }],
      nodesPerSecond: 1000000,
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../services/coachGameEngine', () => ({
  // Post-tightening (WO-BRAIN-04): the move-selector no longer calls
  // getAdaptiveMove or tryOpeningBookMove — the brain owns the move
  // via coachService.ask. getRandomLegalMove is the safety fallback
  // when the brain emits no play_move.
  getTargetStrength: vi.fn().mockReturnValue(1320),
  getRandomLegalMove: vi.fn().mockReturnValue('e7e5'),
}));

vi.mock('../../coach/coachService', () => ({
  // Render-only tests don't reach the move-selector path, but the
  // module import has to resolve. Default ask is a no-op.
  coachService: {
    ask: vi.fn().mockResolvedValue({
      text: '',
      toolCallIds: [],
      provider: 'deepseek',
    }),
  },
}));

vi.mock('../../services/coachApi', () => ({
  getCoachCommentary: vi.fn().mockResolvedValue('Good move!'),
  getCoachChatResponse: vi.fn().mockResolvedValue('Sure, I can help with that position.'),
}));

vi.mock('../../services/coachTemplates', () => ({
  getScenarioTemplate: vi.fn().mockReturnValue('Sure, take it back.'),
  getMoveCommentaryTemplate: vi.fn().mockReturnValue('Solid choice.'),
}));

vi.mock('../../services/coachPrompts', () => ({
  EXPLORE_REACTION_ADDITION: 'Test explore reaction prompt',
  SYSTEM_PROMPT: 'Test system prompt',
  buildChessContextMessage: vi.fn().mockReturnValue('test context'),
  // LIVE-COACH-01 system-prompt additions consumed by useLiveCoach.
  // Render-only tests don't exercise these branches, but the module
  // import has to resolve.
  LIVE_COACH_GREAT_MOVE_ADDITION: 'great move',
  LIVE_COACH_MISSED_TACTIC_ADDITION: 'missed tactic',
  LIVE_COACH_OPPONENT_BLUNDER_ADDITION: 'opp blunder',
  LIVE_COACH_EVAL_SWING_WRONG_ADDITION: 'eval swing',
  LIVE_COACH_RECOVERY_ADDITION: 'recovery',
}));

vi.mock('../../services/openingDetectionService', () => ({
  detectOpening: vi.fn().mockReturnValue(null),
  getOpeningMoves: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/boardUtils', () => ({
  getCapturedPieces: vi.fn().mockReturnValue({ white: [], black: [] }),
  getMaterialAdvantage: vi.fn().mockReturnValue(0),
}));

vi.mock('../../services/accuracyService', () => ({
  calculateAccuracy: vi.fn().mockReturnValue({ white: 85, black: 78, moveCount: 20 }),
  getClassificationCounts: vi.fn().mockReturnValue({
    brilliant: 0, great: 2, good: 8, book: 0, inaccuracy: 1, mistake: 0, blunder: 0,
  }),
  capEval: (evalCp: number) => {
    if (evalCp >= 20000) return 1500;
    if (evalCp <= -20000) return -1500;
    return evalCp;
  },
  cpLossToAccuracy: (cpLoss: number) => {
    const raw = 103.1668 * Math.exp(-0.009 * cpLoss) - 3.1668;
    return Math.max(0, Math.min(100, raw));
  },
}));

vi.mock('../../services/gamePhaseService', () => ({
  getPhaseBreakdown: vi.fn().mockReturnValue([
    { phase: 'opening', accuracy: 90, moveCount: 5, mistakes: 0 },
    { phase: 'middlegame', accuracy: 80, moveCount: 10, mistakes: 1 },
    { phase: 'endgame', accuracy: 85, moveCount: 5, mistakes: 0 },
  ]),
}));

vi.mock('../../services/missedTacticService', () => ({
  detectMissedTactics: vi.fn().mockReturnValue([]),
}));

vi.mock('../../services/coachFeatureService', () => ({
  detectBadHabitsFromGame: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockProfile = buildUserProfile({
  id: 'main',
  name: 'Player',
  currentRating: 1420,
  puzzleRating: 1400,
  xp: 500,
  level: 3,
});

describe('CoachGamePage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAppStore.setState({
      activeProfile: mockProfile,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the game page', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('coach-game-page')).toBeInTheDocument();
  }, 10000);

  it('shows Stockfish Bot in header', () => {
    render(<CoachGamePage />);
    expect(screen.getByText('vs Stockfish Bot')).toBeInTheDocument();
  });

  it('shows target ELO', () => {
    render(<CoachGamePage />);
    expect(screen.getByText(/1320 ELO/)).toBeInTheDocument();
  });

  it('renders hint button immediately (no pregame delay)', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('hint-button')).toBeInTheDocument();
  });

  it('renders takeback button', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('takeback-btn')).toBeInTheDocument();
  });

  it('renders the game chat panel', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('game-chat-panel')).toBeInTheDocument();
  });

  it('renders the chess board', () => {
    render(<CoachGamePage />);
    const page = screen.getByTestId('coach-game-page');
    expect(page).toBeInTheDocument();
  });

  it('hint button displays Get a Hint text at level 0', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('hint-button')).toHaveTextContent('Get a Hint');
  });

  it('takeback button is disabled when no moves have been made', () => {
    render(<CoachGamePage />);
    const takebackBtn = screen.getByTestId('takeback-btn');
    expect(takebackBtn).toBeDisabled();
  });

  it('chat panel shows placeholder text', () => {
    render(<CoachGamePage />);
    expect(screen.getByPlaceholderText(/Ask your coach/)).toBeInTheDocument();
  });

  it('chat panel shows Game Chat header', () => {
    render(<CoachGamePage />);
    expect(screen.getByText('Game Chat')).toBeInTheDocument();
  });

  it('uses two-column layout', () => {
    render(<CoachGamePage />);
    const page = screen.getByTestId('coach-game-page');
    expect(page.className).toContain('md:flex-row');
  });

  // ─── Board Annotation Tests ─────────────────────────────────────────────────

  it('does not show temporary position banner initially', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('temp-position-banner')).not.toBeInTheDocument();
  });

  it('does not show back-to-game button initially', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('back-to-game-btn')).not.toBeInTheDocument();
  });

  it('renders panel divider for resizable chat/moves split', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('panel-divider')).toBeInTheDocument();
  });

  it('renders coach tips toggle button', () => {
    render(<CoachGamePage />);
    expect(screen.getByTestId('coach-tips-toggle')).toBeInTheDocument();
  });

  it('includes gameover in CoachGameStatus type for intermediate game-over state', () => {
    // Verify the gameover status is a valid state that can be set
    // This tests that the type system supports the intermediate gameover state
    const status: import('../../types').CoachGameStatus = 'gameover';
    expect(status).toBe('gameover');
  });

  // ─── Show Mode Step Navigation Tests ────────────────────────────────────────

  it('does not show step navigation when no tip bubble is present', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('show-step-nav')).not.toBeInTheDocument();
  });

  it('does not show explore button when no tip bubble is present', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('explore-from-here-btn')).not.toBeInTheDocument();
  });

  it('does not show coach tip bubble initially', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('coach-tip-bubble')).not.toBeInTheDocument();
  });

  it('does not show explore messages area initially', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('explore-messages')).not.toBeInTheDocument();
  });

  it('does not show explore engine eval initially', () => {
    render(<CoachGamePage />);
    expect(screen.queryByTestId('explore-engine-eval')).not.toBeInTheDocument();
  });

  // ─── Rolodex entry beat — WO-ROLODEX-PLUMBING-01 item 1 ─────────────────────
  // The entry beat is the rolodex's "the coach knows what you tapped" signal.
  // Wires `intendedOpening` (set by the rolodex URL deep-link) through to
  // `voiceService.speakForced` AND the chat-mirror inject path. These tests
  // pin both boundaries so a regression in the voice channel (e.g.
  // useNarration → speakForced wire-up breaking) is caught at the unit-test
  // level, since the e2e audit assertion only verifies the chat-mirror
  // (voice routing in headless Chromium is too fragile to gate on).
  describe('rolodex entry beat', () => {
    beforeEach(() => {
      // Reset between tests so guard refs don't carry over.
      useCoachMemoryStore.setState({ intendedOpening: null });
      vi.mocked(voiceService.speakForced).mockClear();
    });

    /** Helper — flush React effects + queued timers under fake timers.
     *  useNarration's speakNow runs inside a useEffect dispatched by
     *  the React scheduler, which queues via microtasks + timers. */
    async function flushEntryBeat(): Promise<void> {
      // Drain pending microtasks (React effect scheduling).
      await vi.advanceTimersByTimeAsync(0);
      // Drain timers (useNarration's dedup window + any setTimeout
      // chains inside the speak path mocks).
      await vi.advanceTimersByTimeAsync(100);
    }

    it('fires voiceService.speakForced when intent was captured from URL', async () => {
      useCoachMemoryStore.setState({
        intendedOpening: {
          name: 'Italian Game',
          color: 'white',
          setAt: Date.now(),
          capturedFromSurface: 'url-or-resume',
        },
      });
      render(<CoachGamePage />);
      await flushEntryBeat();
      // useNarration's dedup window may suppress the first speak if
      // the test infra fires multiple effects within 6s of fake time;
      // also drain longer to be sure.
      await vi.advanceTimersByTimeAsync(7000);
      const calls = vi.mocked(voiceService.speakForced).mock.calls;
      const entryBeatCall = calls.find(
        (args) => typeof args[0] === 'string' && /^Italian Game as White\./.test(args[0]),
      );
      // Diagnostic: dump store state + all speakForced calls if assertion fails
      const storeState = useCoachMemoryStore.getState().intendedOpening;
      expect(
        entryBeatCall,
        `speakForced calls: ${JSON.stringify(calls.map((c) => c[0]))}; storeState: ${JSON.stringify(storeState)}`,
      ).toBeDefined();
    });

    it('formats the spoken text with the side label matching intendedOpening.color', async () => {
      useCoachMemoryStore.setState({
        intendedOpening: {
          name: 'Caro-Kann Defense',
          color: 'black',
          setAt: Date.now(),
          capturedFromSurface: 'url-or-resume',
        },
      });
      render(<CoachGamePage />);
      await flushEntryBeat();
      const calls = vi.mocked(voiceService.speakForced).mock.calls;
      const entryBeat = calls.find(
        (args) => typeof args[0] === 'string' && /^Caro-Kann Defense as Black\./.test(args[0]),
      );
      expect(entryBeat).toBeDefined();
    });

    it('does NOT fire when intent was captured from chat (not URL)', async () => {
      useCoachMemoryStore.setState({
        intendedOpening: {
          name: 'Italian Game',
          color: 'white',
          setAt: Date.now(),
          capturedFromSurface: 'in-game-chat',
        },
      });
      render(<CoachGamePage />);
      await flushEntryBeat();
      const italianCalls = vi
        .mocked(voiceService.speakForced)
        .mock.calls.filter((args) => typeof args[0] === 'string' && /italian game/i.test(args[0]));
      expect(italianCalls).toHaveLength(0);
    });

    it('does NOT fire when no intent is set', async () => {
      // intendedOpening is null per the beforeEach reset
      render(<CoachGamePage />);
      await flushEntryBeat();
      const italianCalls = vi
        .mocked(voiceService.speakForced)
        .mock.calls.filter((args) => typeof args[0] === 'string' && /italian game/i.test(args[0]));
      expect(italianCalls).toHaveLength(0);
    });
  });
});
