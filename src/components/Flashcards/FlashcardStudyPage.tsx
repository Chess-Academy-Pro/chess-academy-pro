import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChessBoard } from '../Board/ChessBoard';
import { SrsGradeButtons } from '../Puzzles/SrsGradeButtons';
import {
  getDueFlashcardCount,
  reviewFlashcard,
  generateAllRepertoireFlashcards,
  getFlashcardStats,
  getFlashcardsByMode,
} from '../../services/flashcardService';
import type { FlashcardStats, FlashcardMode } from '../../services/flashcardService';
import {
  ArrowLeft,
  Eye,
  SkipForward,
  Layers,
  CheckCircle,
  Shuffle,
  Heart,
  BookOpen,
  AlertTriangle,
  ShieldAlert,
  GitBranch,
  Target,
  Crosshair,
  Swords,
  Clock,
} from 'lucide-react';
import type { FlashcardRecord, SrsGrade } from '../../types';

// ─── Mode definitions ───────────────────────────────────────────────────────

interface ModeConfig {
  id: FlashcardMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const MODES: ModeConfig[] = [
  { id: 'due_review', label: 'Due Review', description: 'SRS-scheduled cards due today', icon: Clock },
  { id: 'random', label: 'Random Opening', description: 'Random cards from your repertoire', icon: Shuffle },
  { id: 'favorites', label: 'Favorites Review', description: 'Cards from favorited openings', icon: Heart },
  { id: 'previously_studied', label: 'Previously Studied', description: 'Openings you\'ve drilled before', icon: BookOpen },
  { id: 'traps', label: 'Traps & Pitfalls', description: 'Openings with known traps', icon: AlertTriangle },
  { id: 'warnings', label: 'Watch Out For', description: 'Openings with warnings', icon: ShieldAlert },
  { id: 'variations', label: 'Opening Variations', description: 'Variation-specific drill cards', icon: GitBranch },
  { id: 'weakest', label: 'Weakest Lines', description: 'Your lowest accuracy openings', icon: Target },
  { id: 'position_recognition', label: 'Position Recognition', description: 'Name the opening from the position', icon: Crosshair },
  { id: 'move_order', label: 'Move Order Traps', description: 'Trap lines from your repertoire', icon: Swords },
];

// ─── Component ──────────────────────────────────────────────────────────────

type Phase = 'modes' | 'loading' | 'reviewing' | 'revealed' | 'complete';

export function FlashcardStudyPage(): JSX.Element {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('modes');
  const [selectedMode, setSelectedMode] = useState<FlashcardMode | null>(null);
  const [cards, setCards] = useState<FlashcardRecord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [stats, setStats] = useState<FlashcardStats | null>(null);
  const [dueCount, setDueCount] = useState(0);

  // Load due count on mount for badge display
  useEffect(() => {
    async function init(): Promise<void> {
      await generateAllRepertoireFlashcards();
      const count = await getDueFlashcardCount();
      setDueCount(count);
    }
    void init();
  }, []);

  // Start a mode
  const handleSelectMode = useCallback(async (mode: FlashcardMode): Promise<void> => {
    setSelectedMode(mode);
    setPhase('loading');
    setCurrentIndex(0);
    setReviewed(0);

    const [modeCards, flashStats] = await Promise.all([
      getFlashcardsByMode(mode, 30),
      getFlashcardStats(),
    ]);

    setCards(modeCards);
    setStats(flashStats);
    setPhase(modeCards.length > 0 ? 'reviewing' : 'complete');
  }, []);

  const card = currentIndex < cards.length ? cards[currentIndex] : undefined;

  const handleReveal = useCallback((): void => {
    setPhase('revealed');
  }, []);

  const handleGrade = useCallback(
    async (grade: SrsGrade): Promise<void> => {
      if (!card) return;
      await reviewFlashcard(card.id, grade);
      setReviewed((prev) => prev + 1);

      const nextIndex = currentIndex + 1;
      if (nextIndex >= cards.length) {
        setPhase('complete');
      } else {
        setCurrentIndex(nextIndex);
        setPhase('reviewing');
      }
    },
    [card, currentIndex, cards.length],
  );

  const handleSkip = useCallback((): void => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= cards.length) {
      setPhase('complete');
    } else {
      setCurrentIndex(nextIndex);
      setPhase('reviewing');
    }
  }, [currentIndex, cards.length]);

  const handleBackToModes = useCallback((): void => {
    setPhase('modes');
    setSelectedMode(null);
    setCards([]);
    setCurrentIndex(0);
    setReviewed(0);
  }, []);

  // ─── Mode selector ──────────────────────────────────────────────────────

  if (phase === 'modes') {
    return (
      <div className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="flashcard-modes">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-theme-text">Flashcard Drills</h1>
            <p className="text-sm text-theme-text-muted mt-1">Choose a drill mode</p>
          </div>
          {dueCount > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-theme-accent/15 text-theme-accent" data-testid="due-badge">
              {dueCount} due
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {MODES.map((mode) => {
            const Icon = mode.icon;
            return (
              <button
                key={mode.id}
                onClick={() => void handleSelectMode(mode.id)}
                className="flex flex-col items-start gap-2 p-4 rounded-xl bg-theme-surface hover:bg-theme-border border border-theme-border transition-colors text-left"
                data-testid={`mode-${mode.id}`}
              >
                <Icon size={20} className="text-theme-accent" />
                <div>
                  <p className="text-sm font-semibold text-theme-text">{mode.label}</p>
                  <p className="text-[11px] text-theme-text-muted leading-tight mt-0.5">{mode.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Loading ─────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-theme-text-muted text-sm">Loading cards...</div>
      </div>
    );
  }

  // ─── Complete ────────────────────────────────────────────────────────────

  if (phase === 'complete') {
    const modeLabel = (selectedMode ? MODES.find((m) => m.id === selectedMode)?.label : '') ?? '';
    return (
      <div className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="flashcard-complete">
        <button
          onClick={handleBackToModes}
          className="flex items-center gap-1 text-sm text-theme-text-muted hover:text-theme-text transition-colors self-start"
          data-testid="back-to-modes"
        >
          <ArrowLeft size={14} />
          All Modes
        </button>
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center">
          <CheckCircle size={48} className="text-green-500" />
          <h2 className="text-xl font-bold text-theme-text">
            {cards.length === 0 ? 'No Cards Available' : 'Session Complete'}
          </h2>
          {/* Empty-state messaging with actionable guidance. The
              previous "Try another mode" text was misleading when the
              root cause was that the user had no repertoire openings
              set up — every mode would be empty. */}
          <p className="text-theme-text-muted text-sm max-w-md">
            {cards.length === 0
              ? (stats && stats.total === 0
                  ? 'Flashcards are built from the openings in your repertoire. Add openings to your repertoire first — the Openings tab has a star button on each opening.'
                  : `No ${modeLabel.toLowerCase()} cards right now. Try another mode, or come back later if you were looking for due cards.`)
              : `You reviewed ${reviewed} card${reviewed !== 1 ? 's' : ''}.${stats ? ` ${stats.total} cards total, ${stats.due} were due.` : ''}`
            }
          </p>
          <div className="flex gap-3 mt-4 flex-wrap justify-center">
            {cards.length === 0 && stats && stats.total === 0 ? (
              <button
                onClick={() => void navigate('/openings')}
                className="px-6 py-2 rounded-lg bg-theme-accent text-theme-bg font-semibold text-sm"
                data-testid="goto-openings"
              >
                Go to Openings
              </button>
            ) : (
              <button
                onClick={handleBackToModes}
                className="px-6 py-2 rounded-lg bg-theme-accent text-theme-bg font-semibold text-sm"
              >
                Try Another Mode
              </button>
            )}
            <button
              onClick={() => void navigate('/')}
              className="px-6 py-2 rounded-lg bg-theme-surface border border-theme-border text-theme-text font-semibold text-sm"
            >
              Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Drill view (reviewing / revealed) ──────────────────────────────────

  if (!card) return <></>;

  const typeLabel =
    card.type === 'name_opening'
      ? 'Name the Opening'
      : card.type === 'explain_idea'
        ? 'Key Ideas'
        : 'Best Move / Variation';

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" data-testid="flashcard-study">
      {/* Board panel (left on desktop) */}
      <div className="flex flex-col gap-4 lg:w-1/2">
        {/* Header */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleBackToModes}
            className="flex items-center gap-1 text-sm text-theme-text-muted hover:text-theme-text transition-colors"
            data-testid="back-to-modes-drill"
          >
            <ArrowLeft size={14} />
            Modes
          </button>
          <div className="flex items-center gap-2 text-sm text-theme-text-muted">
            <Layers size={14} />
            <span>
              {currentIndex + 1} / {cards.length}
            </span>
            <span className="ml-2">{reviewed} reviewed</span>
          </div>
        </div>

        {/* Board */}
        <div className="flex justify-center">
          <div className="w-full md:max-w-[420px]">
            <ChessBoard
              initialFen={card.questionFen}
              interactive={false}
              showFlipButton={false}
              showUndoButton={false}
              showResetButton={false}
            />
          </div>
        </div>
      </div>

      {/* Controls panel (right on desktop) */}
      <div className="flex flex-col gap-4 lg:w-1/2 lg:pt-10">
        {/* Card type badge */}
        <div className="flex justify-center lg:justify-start">
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-theme-accent/10 text-theme-accent border border-theme-accent/30">
            {typeLabel}
          </span>
        </div>

        {/* Question */}
        <div className="bg-theme-surface rounded-lg p-4 border border-theme-border">
          <p className="text-sm font-medium text-theme-text" data-testid="flashcard-question">
            {card.questionText}
          </p>
        </div>

        {/* Answer / Actions */}
        {phase === 'reviewing' ? (
          <div className="flex gap-3">
            <button
              onClick={handleReveal}
              className="flex-1 py-2.5 rounded-lg font-semibold text-sm bg-theme-accent text-theme-bg flex items-center justify-center gap-2"
              data-testid="reveal-btn"
            >
              <Eye size={16} />
              Reveal Answer
            </button>
            <button
              onClick={handleSkip}
              className="px-4 py-2.5 rounded-lg text-sm border border-theme-border text-theme-text-muted hover:bg-theme-surface transition-colors flex items-center gap-1"
              data-testid="skip-btn"
            >
              <SkipForward size={14} />
              Skip
            </button>
          </div>
        ) : (
          <>
            <div className="bg-theme-surface rounded-lg p-4 border border-theme-border" data-testid="flashcard-answer">
              {card.answerMove && (
                <div className="text-xs text-theme-accent font-mono mb-1">{card.answerMove}</div>
              )}
              <p className="text-sm text-theme-text leading-relaxed">{card.answerText}</p>
            </div>
            <SrsGradeButtons
              currentInterval={card.srsInterval}
              easeFactor={card.srsEaseFactor}
              repetitions={card.srsRepetitions}
              onGrade={(grade) => void handleGrade(grade)}
            />
          </>
        )}
      </div>
    </div>
  );
}
