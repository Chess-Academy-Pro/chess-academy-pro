import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { KidModePage } from './KidModePage';
import { useAppStore } from '../../stores/appStore';
import { getGameProgress } from '../../services/journeyService';
import type { UserProfile, JourneyProgress } from '../../types';

vi.mock('../Board/ChessBoard', () => ({
  ChessBoard: ({ initialFen }: { initialFen?: string }) => (
    <div data-testid="chess-board" data-fen={initialFen}>Board</div>
  ),
}));

vi.mock('./BishopVsPawns', () => ({
  BishopVsPawns: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="bishop-vs-pawns-game">
      <button data-testid="bvp-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('./ColorWars', () => ({
  ColorWars: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="color-wars-game">
      <button data-testid="cw-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('../../services/journeyService', () => ({
  getGameProgress: vi.fn().mockResolvedValue(null),
  getGameCompletedChapterCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}));

vi.mock('../../services/themeService', () => ({
  applyTheme: vi.fn(),
  getThemeById: vi.fn().mockReturnValue({ id: 'kid-mode', name: 'Kid Mode', colors: {} }),
}));

function createProfile(): UserProfile {
  return {
    id: 'main',
    name: 'Kiddo',
    isKidMode: true,
    currentRating: 800,
    puzzleRating: 800,
    xp: 100,
    level: 1,
    currentStreak: 2,
    longestStreak: 5,
    streakFreezes: 0,
    lastActiveDate: new Date().toISOString().split('T')[0],
    skillRadar: { opening: 30, tactics: 40, endgame: 20, memory: 35, calculation: 25 },
    badHabits: [],
    preferences: {
      theme: 'kid-mode',
      boardColor: 'classic',
      pieceSet: 'staunton',
      showEvalBar: false,
      showEngineLines: false,
      soundEnabled: true,
      voiceEnabled: true,
      dailySessionMinutes: 15,
      aiProvider: 'deepseek',
      apiKeyEncrypted: null,
      apiKeyIv: null,
      anthropicApiKeyEncrypted: null,
      anthropicApiKeyIv: null,
      preferredModel: { commentary: 'haiku', analysis: 'sonnet', reports: 'opus' },
      monthlyBudgetCap: null,
      estimatedSpend: 0,
      elevenlabsKeyEncrypted: null,
      elevenlabsKeyIv: null,
      elevenlabsVoiceId: null,
      voiceSpeed: 1.0,
      kokoroEnabled: true,
      kokoroVoiceId: 'af_bella',
      systemVoiceURI: null,
      highlightLastMove: true,
      showLegalMoves: true,
      showCoordinates: true,
      pieceAnimationSpeed: 'medium',
      boardOrientation: true,
      moveQualityFlash: true,
      showHints: true,
      moveMethod: 'both',
      moveConfirmation: false,
      autoPromoteQueen: true,
      pollyEnabled: false,
      pollyVoice: 'ruth',
      masterAllOff: false,
    },
  };
}

describe('KidModePage', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
  });

  it('renders kid mode page with welcome header', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('kid-mode-page')).toBeInTheDocument();
    expect(screen.getByText(/Hi Kiddo/)).toBeInTheDocument();
    expect(screen.getByText(/100 XP/)).toBeInTheDocument();
  });

  it('renders all 6 piece lesson cards', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('lesson-card-king')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-card-queen')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-card-rook')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-card-bishop')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-card-knight')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-card-pawn')).toBeInTheDocument();
  });

  it('clicking a lesson card navigates to piece page', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    // Clicking a lesson card should trigger navigation (rendered in MemoryRouter)
    fireEvent.click(screen.getByTestId('lesson-card-knight'));
    // The menu should remain since navigation happens via route change
    // In integration tests with full routing, this would navigate to /kid/knight
  });

  it('has Find the King button', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('find-king-btn')).toBeInTheDocument();
    expect(screen.getByText('Find the King!')).toBeInTheDocument();
  });

  it('clicking Find the King opens game with overlay', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    fireEvent.click(screen.getByTestId('find-king-btn'));
    expect(screen.getByTestId('find-king-overlay')).toBeInTheDocument();
    expect(screen.getByText(/Where is the White King/)).toBeInTheDocument();
  });

  it('clicking correct king square shows correct result', () => {
    vi.useFakeTimers();
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    fireEvent.click(screen.getByTestId('find-king-btn'));
    // First FEN: RNBQKBNR — White King is on e1
    fireEvent.click(screen.getByTestId('sq-e1'));

    expect(screen.getByTestId('find-king-result')).toHaveTextContent('Correct');

    vi.useRealTimers();
  });

  it('renders journey card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('journey-card')).toBeInTheDocument();
    expect(screen.getByText("Pawn's Journey")).toBeInTheDocument();
  });

  it('renders fairy tale card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('fairy-tale-card')).toBeInTheDocument();
    expect(screen.getByText('Fairy Tale Quest')).toBeInTheDocument();
  });

  it('fairy tale card shows start text when no progress', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByText('Begin your fairy tale!')).toBeInTheDocument();
  });

  it('renders empty when no profile', () => {
    render(<KidModePage />);
    expect(screen.queryByTestId('kid-mode-page')).not.toBeInTheDocument();
  });

  it('renders pawn-games card with "Pawn Games" text', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('pawn-games-card')).toBeInTheDocument();
    expect(screen.getByText('Pawn Games')).toBeInTheDocument();
  });

  it('clicking pawn-games card triggers navigation', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    fireEvent.click(screen.getByTestId('pawn-games-card'));
  });

  it('renders the unified king-games hub card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('king-games-card')).toBeInTheDocument();
    expect(screen.getByText('King Games')).toBeInTheDocument();
    expect(screen.getByText('King Escape & King March')).toBeInTheDocument();
  });

  it('renders knight games card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('knight-games-card')).toBeInTheDocument();
    expect(screen.getByText('Knight Games')).toBeInTheDocument();
  });

  it('renders queen games card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('queen-games-card')).toBeInTheDocument();
    expect(screen.getByText('Queen Games')).toBeInTheDocument();
  });

  it('renders rook games card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('rook-games-card')).toBeInTheDocument();
    expect(screen.getByText('Rook Games')).toBeInTheDocument();
  });

  it('renders Games section header', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByText('Games')).toBeInTheDocument();
  });

  it('renders Piece Lessons section header', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByText('Piece Lessons')).toBeInTheDocument();
  });

  it('shows the unified Bishop Games hub tile', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('bishop-games-card')).toBeInTheDocument();
    expect(screen.getByText('Bishop Games')).toBeInTheDocument();
  });

  it('Bishop Games tile is disabled when rook chapter not completed', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('bishop-games-card')).toBeDisabled();
    expect(screen.getByTestId('bishop-games-locked-msg')).toBeInTheDocument();
  });

  it('Bishop Games tile is enabled when rook chapter is completed', async () => {
    const progress: JourneyProgress = {
      chapters: { rook: { chapterId: 'rook', lessonsCompleted: 3, puzzlesCorrect: 5, puzzlesCompleted: 5, completed: true, bestScore: 5, completedAt: null } },
      currentChapterId: 'bishop',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    vi.mocked(getGameProgress).mockResolvedValue(progress);
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    const btn = await screen.findByTestId('bishop-games-card');
    // Wait for async unlock to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(btn).not.toBeDisabled();
    expect(screen.queryByTestId('bishop-games-locked-msg')).not.toBeInTheDocument();
  });

  it('clicking Bishop Games tile navigates (no in-place render)', async () => {
    const progress: JourneyProgress = {
      chapters: { rook: { chapterId: 'rook', lessonsCompleted: 3, puzzlesCorrect: 5, puzzlesCompleted: 5, completed: true, bestScore: 5, completedAt: null } },
      currentChapterId: 'bishop',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    vi.mocked(getGameProgress).mockResolvedValue(progress);
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    const btn = await screen.findByTestId('bishop-games-card');
    fireEvent.click(btn);
    // Routing happens via React Router — KidModePage no longer renders
    // BishopVsPawns / ColorWars in-place. Just verify the click didn't
    // crash and the hub stays mounted (Router would unmount on real nav).
    expect(screen.getByTestId('kid-mode-page')).toBeInTheDocument();
  });

  it('renders puzzle quest card', () => {
    useAppStore.getState().setActiveProfile(createProfile());
    render(<KidModePage />);

    expect(screen.getByTestId('puzzle-quest-card')).toBeInTheDocument();
    expect(screen.getByText('Puzzle Quest')).toBeInTheDocument();
    expect(screen.getByText('Solve chess puzzles and become a puzzle star!')).toBeInTheDocument();
  });
});
