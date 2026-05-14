import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Target, Gamepad2, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { voiceService } from '../../services/voiceService';
import { useAppStore } from '../../stores/appStore';
import { buildWeaknessPuzzleQueue } from '../../services/weaknessPuzzleService';
import { recordAttempt, updatePuzzleRating } from '../../services/puzzleService';
import { gradeMistakePuzzle } from '../../services/mistakePuzzleService';
import { PuzzleBoard } from './PuzzleBoard';
import type { PuzzleOutcome } from './PuzzleBoard';
import { MistakePuzzleBoard } from './MistakePuzzleBoard';
import type { WeaknessPuzzleItem } from '../../services/weaknessPuzzleService';
import { logAppAudit } from '../../services/appAuditor';

type Phase = 'loading' | 'solving' | 'summary';

const QUEUE_SIZE = 20;

export function WeaknessPuzzlePage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);

  const [phase, setPhase] = useState<Phase>('loading');
  const [queue, setQueue] = useState<WeaknessPuzzleItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const [mistakeCount, setMistakeCount] = useState(0);
  const [themeCount, setThemeCount] = useState(0);
  const completedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    void loadQueue();
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'WeaknessPuzzlePage.mount',
      summary: 'weakness-puzzle queue opened',
    });
  }, []);

  async function loadQueue(): Promise<void> {
    setPhase('loading');
    const items = await buildWeaknessPuzzleQueue(QUEUE_SIZE);
    if (items.length === 0) {
      setPhase('summary');
      return;
    }
    setQueue(items);
    setCurrentIndex(0);
    setSolved(0);
    setFailed(0);
    setMistakeCount(0);
    setThemeCount(0);
    completedRef.current = new Set();
    setPhase('solving');
  }

  const handleComplete = useCallback(async (correct: boolean): Promise<void> => {
    const item = queue.at(currentIndex);
    if (!item) return;

    // Only count the first completion of each puzzle
    if (completedRef.current.has(currentIndex)) return;
    completedRef.current.add(currentIndex);

    // Update stats
    if (correct) {
      setSolved((s) => s + 1);
    } else {
      setFailed((f) => f + 1);
    }
    if (item.source === 'mistake') {
      setMistakeCount((c) => c + 1);
    } else {
      setThemeCount((c) => c + 1);
    }

    // Grade the puzzle
    const grade = correct ? 'good' : 'again';
    if (item.source === 'mistake' && item.originalMistake) {
      await gradeMistakePuzzle(item.originalMistake.id, grade, correct);
    } else {
      await recordAttempt(item.puzzle.id, correct, activeProfile?.puzzleRating ?? 1200, grade);
    }

    // Update puzzle rating
    if (activeProfile) {
      const newRating = updatePuzzleRating(
        activeProfile.puzzleRating,
        item.puzzle.rating,
        correct,
      );
      const updated = { ...activeProfile, puzzleRating: newRating };
      setActiveProfile(updated);
    }
    // No auto-advance — user navigates with arrows
  }, [queue, currentIndex, activeProfile, setActiveProfile]);

  const goNext = useCallback((): void => {
    voiceService.stop();
    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
      setPhase('summary');
    } else {
      setCurrentIndex(nextIndex);
    }
  }, [currentIndex, queue.length]);

  const goPrev = useCallback((): void => {
    if (currentIndex > 0) {
      voiceService.stop();
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const currentItem = queue.at(currentIndex);
  const total = solved + failed;

  return (
    <div className="max-w-2xl mx-auto w-full p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-4 min-h-[80vh]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void navigate('/tactics')}
          className="p-2 rounded-lg hover:opacity-80"
          data-testid="back-btn"
        >
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <Target size={24} style={{ color: 'var(--color-error)' }} />
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>Weakness Puzzles</h1>
      </div>

      {/* Loading */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1" data-testid="loading">
          <p style={{ color: 'var(--color-text-muted)' }}>Building your weakness queue...</p>
        </div>
      )}

      {/* Solving */}
      {phase === 'solving' && currentItem && (
        <AnimatePresence mode="wait">
          <motion.div
            key={currentItem.puzzle.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col gap-4"
          >
            {/* Progress bar */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    background: 'var(--color-accent)',
                    width: `${Math.round(((currentIndex) / queue.length) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {currentIndex + 1}/{queue.length}
              </span>
            </div>

            {/* Source badge */}
            <div className="flex items-center gap-2">
              {currentItem.source === 'mistake' ? (
                <span
                  className="text-xs px-2 py-1 rounded-full font-medium"
                  style={{ background: 'color-mix(in srgb, var(--color-warning) 15%, transparent)', color: 'var(--color-warning)' }}
                >
                  From Your Game
                </span>
              ) : (
                <span
                  className="text-xs px-2 py-1 rounded-full font-medium"
                  style={{ background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)', color: 'var(--color-accent)' }}
                >
                  Tactical Theme
                </span>
              )}
              {currentItem.originalMistake?.openingName && (
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {currentItem.originalMistake.openingName}
                </span>
              )}
            </div>

            {/* Board */}
            {currentItem.source === 'mistake' && currentItem.originalMistake ? (
              <MistakePuzzleBoard
                puzzle={currentItem.originalMistake}
                onComplete={(correct) => void handleComplete(correct)}
              />
            ) : (
              <PuzzleBoard
                puzzle={currentItem.puzzle}
                onComplete={(outcome: PuzzleOutcome) => void handleComplete(outcome.correct)}
              />
            )}

            {/* Navigation arrows */}
            <div className="flex items-center justify-center gap-6 py-1" data-testid="puzzle-nav">
              <button
                onClick={goPrev}
                disabled={currentIndex === 0}
                className="p-2 rounded-lg border transition-opacity disabled:opacity-30"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                data-testid="nav-prev"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {currentIndex + 1} / {queue.length}
              </span>
              <button
                onClick={goNext}
                className="p-2 rounded-lg border transition-opacity"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                data-testid="nav-next"
              >
                <ChevronRight size={20} />
              </button>
            </div>

            {/* Session stats */}
            <div className="flex justify-center gap-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              <span style={{ color: 'var(--color-success)' }}>{solved} solved</span>
              <span style={{ color: 'var(--color-error)' }}>{failed} missed</span>
            </div>
          </motion.div>
        </AnimatePresence>
      )}

      {/* Summary */}
      {phase === 'summary' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center flex-1 gap-6"
          data-testid="session-summary"
        >
          <div className="text-center">
            <h2 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>
              Session Complete
            </h2>
            {total > 0 ? (
              <>
                <p className="text-lg mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  {solved}/{total} puzzles solved ({total > 0 ? Math.round((solved / total) * 100) : 0}%)
                </p>
                <div className="flex justify-center gap-6 mt-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  <div className="flex items-center gap-1">
                    <Gamepad2 size={14} style={{ color: 'var(--color-warning)' }} />
                    <span>{mistakeCount} game mistakes</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Target size={14} style={{ color: 'var(--color-accent)' }} />
                    <span>{themeCount} tactical puzzles</span>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
                No weakness puzzles available yet. Import and analyze some games first!
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => void loadQueue()}
              className="px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="play-again"
            >
              Play Again
            </button>
            <button
              onClick={() => void navigate('/tactics')}
              className="px-6 py-3 rounded-xl font-semibold text-sm border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              data-testid="back-to-report"
            >
              Back to Report
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
