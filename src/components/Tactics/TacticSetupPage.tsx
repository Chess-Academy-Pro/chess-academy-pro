import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Wrench, ChevronRight, ChevronLeft } from 'lucide-react';
import { buildSetupPuzzleQueue, gradeSetupPuzzle } from '../../services/tacticSetupService';
import { tacticTypeLabel, tacticTypeIcon } from '../../services/tacticalProfileService';
import { TacticSetupBoard } from './TacticSetupBoard';
import { logAppAudit } from '../../services/appAuditor';
import type { SetupPuzzle, SetupPuzzleDifficulty } from '../../types';

type Phase = 'select' | 'loading' | 'solving' | 'summary';

const DIFFICULTIES: Array<{ value: SetupPuzzleDifficulty; label: string; description: string }> = [
  { value: 1, label: 'Beginner', description: '1 prep move before the tactic' },
  { value: 2, label: 'Intermediate', description: '2 prep moves — deeper planning' },
  { value: 3, label: 'Advanced', description: '3 prep moves — the first looks quiet' },
];

export function TacticSetupPage(): JSX.Element {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('select');
  const [difficulty, setDifficulty] = useState<SetupPuzzleDifficulty>(1);
  const [queue, setQueue] = useState<SetupPuzzle[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const completedRef = useRef<Set<number>>(new Set());

  const handleSelectDifficulty = useCallback(async (d: SetupPuzzleDifficulty): Promise<void> => {
    setDifficulty(d);
    setPhase('loading');
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'TacticSetupPage.difficulty-selected',
      summary: `setup-trainer started at difficulty=${d}`,
    });
    const puzzles = await buildSetupPuzzleQueue(10, d);
    if (puzzles.length === 0) {
      setQueue([]);
      setPhase('summary');
      return;
    }
    setQueue(puzzles);
    setCurrentIndex(0);
    setSolved(0);
    setFailed(0);
    completedRef.current = new Set();
    setPhase('solving');
  }, []);

  const handleComplete = useCallback(async (correct: boolean): Promise<void> => {
    const puzzle = queue.at(currentIndex);
    if (!puzzle) return;

    // Only count the first completion of each puzzle
    if (completedRef.current.has(currentIndex)) return;
    completedRef.current.add(currentIndex);

    if (correct) setSolved((s) => s + 1);
    else setFailed((f) => f + 1);

    const grade = correct ? 'good' : 'again';
    await gradeSetupPuzzle(puzzle.id, grade, correct);
    // No auto-advance — user navigates with arrows
  }, [queue, currentIndex]);

  const goNext = useCallback((): void => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
      setPhase('summary');
    } else {
      setCurrentIndex(nextIndex);
    }
  }, [currentIndex, queue.length]);

  const goPrev = useCallback((): void => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const currentPuzzle = queue.at(currentIndex);
  const total = solved + failed;

  return (
    <div className="max-w-2xl mx-auto w-full p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-4 min-h-[80vh]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => void navigate('/tactics')} className="p-2 rounded-lg hover:opacity-80" data-testid="back-btn">
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <Wrench size={24} style={{ color: 'var(--color-success)' }} />
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>Setup Trainer</h1>
      </div>

      {/* Difficulty Select */}
      {phase === 'select' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-4">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Find the quiet preparatory moves that make the tactic inevitable.
            Not &ldquo;find the fork&rdquo; — &ldquo;engineer the fork.&rdquo;
          </p>
          <div className="flex flex-col gap-3">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.value}
                onClick={() => void handleSelectDifficulty(d.value)}
                className="w-full rounded-xl border p-4 text-left transition-all hover:opacity-90 flex items-center gap-4"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-success) 30%, var(--color-border))',
                  background: 'var(--color-surface)',
                }}
                data-testid={`difficulty-${d.value}`}
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--color-success) 15%, transparent)', color: 'var(--color-success)' }}
                >
                  {d.value}
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{d.label}</h3>
                  <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{d.description}</p>
                </div>
                <ChevronRight size={16} style={{ color: 'var(--color-success)' }} />
              </button>
            ))}
          </div>
        </motion.div>
      )}

      {/* Loading */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1" data-testid="loading">
          <p style={{ color: 'var(--color-text-muted)' }}>Generating setup puzzles...</p>
        </div>
      )}

      {/* Solving */}
      {phase === 'solving' && currentPuzzle && (
        <AnimatePresence mode="wait">
          <motion.div
            key={currentPuzzle.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col gap-4"
          >
            {/* Progress */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                <div className="h-full rounded-full transition-all" style={{ background: 'var(--color-accent)', width: `${Math.round((currentIndex / queue.length) * 100)}%` }} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>{currentIndex + 1}/{queue.length}</span>
            </div>

            {/* Badge */}
            <div className="flex items-center gap-2">
              <span className="text-sm">{tacticTypeIcon(currentPuzzle.tacticType)}</span>
              <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: 'color-mix(in srgb, var(--color-success) 15%, transparent)', color: 'var(--color-success)' }}>
                Setup: {tacticTypeLabel(currentPuzzle.tacticType)}
              </span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {difficulty === 1 ? '1 prep move' : `${difficulty} prep moves`}
              </span>
            </div>

            {/* Board */}
            <TacticSetupBoard
              puzzle={currentPuzzle}
              onComplete={(correct) => void handleComplete(correct)}
            />

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

            {/* Stats */}
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
          <Wrench size={40} style={{ color: 'var(--color-success)' }} />
          <div className="text-center">
            <h2 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>Setup Training Complete</h2>
            {total > 0 ? (
              <p className="text-lg mt-2" style={{ color: 'var(--color-text-muted)' }}>
                {solved}/{total} setups found ({Math.round((solved / total) * 100)}%)
              </p>
            ) : (
              <>
              <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
                Import games to review your in-game mistakes and unlock setup training.
              </p>
              <button
                onClick={() => void navigate('/games/import')}
                className="mt-4 px-5 py-2.5 rounded-xl font-semibold text-sm"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              >
                Import Games
              </button>
              </>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setPhase('select')}
              className="px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="play-again"
            >
              Train Again
            </button>
            <button
              onClick={() => void navigate('/tactics')}
              className="px-6 py-3 rounded-xl font-semibold text-sm border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              Back to Tactics
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
