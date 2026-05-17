import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { TacticSetupBoard } from './TacticSetupBoard';
import { buildSetupPuzzle, resetFactoryCounter } from '../../test/factories';

// API-leak guard (WO-TEST-CLEANUP-01 Part A) — intercepts modern
// brain entry point + all 6 network-wrapping coachApi exports.
vi.mock('../../coach/coachService', () => ({
  coachService: {
    // Non-empty text so `hintState.nudgeText` populates and the
    // `hint-nudge` conditional render fires for the hint-level-2
    // assertion. Distinctive prefix is greppable in any future
    // debugging — if this string shows up in production logs,
    // the brain path was unmocked when it shouldn't have been.
    ask: vi.fn().mockResolvedValue({
      text: '[TEST MOCK] hint nudge text',
      toolCallIds: [],
      provider: 'deepseek',
    }),
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

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSpeak = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: (...args: unknown[]): Promise<void> => mockSpeak(...args) as Promise<void>,
    stop: (): void => { mockStop(); },
    warmup: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../services/tacticNarrationService', () => ({
  setupIntro: (): string => 'Find the setup move.',
  setupCorrectPrep: (remaining: number): string => `${remaining} more to go.`,
  setupRevealComplete: (): string => 'Tactic revealed!',
  setupIncorrect: (): string => 'Not quite right.',
}));

vi.mock('../../services/tacticalProfileService', () => ({
  tacticTypeLabel: (t: string): string => t.replace(/_/g, ' '),
  tacticTypeIcon: (): string => '',
}));

// Mock useSettings to control showHints
const mockSettings = { showHints: true };
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ settings: mockSettings, updateSetting: vi.fn() }),
}));

describe('TacticSetupBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFactoryCounter();
    mockSettings.showHints = true;
  });

  it('renders the board with status message', () => {
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    expect(screen.getByTestId('setup-board')).toBeInTheDocument();
    expect(screen.getByText('Find the preparatory move')).toBeInTheDocument();
  });

  it('shows hint button when showHints is enabled', () => {
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    expect(screen.getByTestId('setup-hint-area')).toBeInTheDocument();
    expect(screen.getByTestId('hint-button')).toBeInTheDocument();
    expect(screen.getByTestId('hint-button')).toHaveTextContent('Get a Hint');
  });

  it('hides hint button when showHints is disabled', () => {
    mockSettings.showHints = false;
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    expect(screen.queryByTestId('setup-hint-area')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hint-button')).not.toBeInTheDocument();
  });

  it('advances hint level when hint button is clicked', async () => {
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    const hintButton = screen.getByTestId('hint-button');
    expect(hintButton).toHaveAttribute('data-level', '0');

    fireEvent.click(hintButton);

    await waitFor(() => {
      expect(screen.getByTestId('hint-button')).toHaveAttribute('data-level', '1');
    });
  });

  it('shows nudge text at hint level 2', async () => {
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    const hintButton = screen.getByTestId('hint-button');

    // Level 0 → 1 (arrows). requestHint kicks off an async brain call
    // that flips isAnalyzing=true one microtask later; the button has
    // `disabled={isAnalyzing}` so a back-to-back click would be a
    // no-op. Wait for both the level bump AND isAnalyzing to settle.
    fireEvent.click(hintButton);
    await waitFor(() => {
      expect(screen.getByTestId('hint-button')).toHaveAttribute('data-level', '1');
      expect(screen.getByTestId('hint-button')).not.toBeDisabled();
    });

    // Level 1 → 2 (nudge)
    fireEvent.click(hintButton);
    await waitFor(() => {
      expect(screen.getByTestId('hint-button')).toHaveAttribute('data-level', '2');
    });

    // Nudge text should appear
    expect(screen.getByTestId('hint-nudge')).toBeInTheDocument();
  });

  it('speaks intro narration on mount', () => {
    const puzzle = buildSetupPuzzle();
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    expect(mockSpeak).toHaveBeenCalledWith('Find the setup move.');
  });

  it('shows move indicator for player turn', () => {
    const puzzle = buildSetupPuzzle({ difficulty: 1 });
    render(<TacticSetupBoard puzzle={puzzle} onComplete={vi.fn()} />);

    expect(screen.getByText(/Your turn — find the prep move/)).toBeInTheDocument();
  });
});
