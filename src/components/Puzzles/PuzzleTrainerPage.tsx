import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../../stores/appStore';
import { getPuzzlesForMode, recordAttempt, getPuzzleStats, seedPuzzles } from '../../services/puzzleService';
import type { PuzzleMode, PuzzleStats } from '../../services/puzzleService';
import type { PuzzleRecord } from '../../types';
import type { SrsGrade } from '../../types';
import { PuzzleModeSelector } from './PuzzleModeSelector';
import { PuzzleBoard } from './PuzzleBoard';
import type { PuzzleOutcome } from './PuzzleBoard';
import { SrsGradeButtons } from './SrsGradeButtons';
import { PuzzleTimer } from './PuzzleTimer';
import { PuzzleSessionStats } from './PuzzleSessionStats';
import { useSolveTimer } from '../../hooks/useSolveTimer';
import { voiceService } from '../../services/voiceService';
import { ArrowLeft, Brain, SkipForward } from 'lucide-react';
import { db } from '../../db/schema';
import { logAppAudit } from '../../services/appAuditor';

type SessionPhase = 'mode_select' | 'solving' | 'grading' | 'complete';

interface SessionState {
  mode: PuzzleMode;
  puzzles: PuzzleRecord[];
  currentIndex: number;
  solved: number;
  failed: number;
  streak: number;
  ratingChange: number;
  puzzleCorrect: boolean;
}

export function PuzzleTrainerPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const [phase, setPhase] = useState<SessionPhase>('mode_select');
  const [session, setSession] = useState<SessionState | null>(null);

  // Mount audit — F1-lineage observability fix for the tactics tab.
  useEffect(() => {
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'PuzzleTrainerPage.mount',
      summary: 'classic puzzle trainer opened (mode_select)',
    });
  }, []);
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerKey, setTimerKey] = useState(0);
  const { elapsed, reset: resetTimer } = useSolveTimer();

  const userRating = activeProfile?.puzzleRating ?? 1200;

  // Load stats on mount
  useEffect(() => {
    void seedPuzzles().then(() => getPuzzleStats()).then(setStats);
  }, []);

  const handleSelectMode = useCallback(async (mode: PuzzleMode): Promise<void> => {
    const puzzles = await getPuzzlesForMode(mode, userRating, 10);
    if (puzzles.length === 0) return;

    setSession({
      mode,
      puzzles,
      currentIndex: 0,
      solved: 0,
      failed: 0,
      streak: 0,
      ratingChange: 0,
      puzzleCorrect: false,
    });
    setPhase('solving');
    setTimerRunning(true);
    setTimerKey((k) => k + 1);
    resetTimer();
  }, [userRating, resetTimer]);

  const handlePuzzleComplete = useCallback(({ correct }: PuzzleOutcome): void => {
    if (!session) return;
    setTimerRunning(false);

    setSession((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        solved: prev.solved + (correct ? 1 : 0),
        failed: prev.failed + (correct ? 0 : 1),
        streak: correct ? prev.streak + 1 : 0,
        puzzleCorrect: correct,
      };
    });

    // For daily challenge mode, no SRS grading
    if (session.mode === 'daily_challenge') {
      setPhase('complete');
      return;
    }

    setPhase('grading');
  }, [session]);

  const handleTimeout = useCallback((): void => {
    handlePuzzleComplete({ correct: false, usedHint: false, hadRetry: false, showedSolution: false, solveTimeMs: 0 });
  }, [handlePuzzleComplete]);

  const handleGrade = useCallback(async (grade: SrsGrade): Promise<void> => {
    if (!session) return;

    if (session.currentIndex >= session.puzzles.length) return;
    const puzzle = session.puzzles[session.currentIndex];

    const result = await recordAttempt(
      puzzle.id,
      session.puzzleCorrect,
      userRating,
      grade,
    );

    if (result) {
      // Update profile rating in Zustand and DB
      if (activeProfile) {
        const updatedProfile = { ...activeProfile, puzzleRating: result.newUserRating };
        setActiveProfile(updatedProfile);
        void db.profiles.update(activeProfile.id, { puzzleRating: result.newUserRating });
      }

      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ratingChange: prev.ratingChange + result.ratingDelta,
        };
      });
    }

    // Move to next puzzle or end session
    voiceService.stop();
    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= session.puzzles.length) {
      setPhase('complete');
      void getPuzzleStats().then(setStats);
    } else {
      setSession((prev) => {
        if (!prev) return prev;
        return { ...prev, currentIndex: nextIndex, puzzleCorrect: false };
      });
      setPhase('solving');
      setTimerRunning(true);
      setTimerKey((k) => k + 1);
      resetTimer();
    }
  }, [session, userRating, activeProfile, setActiveProfile, resetTimer]);

  const handleSkip = useCallback((): void => {
    if (!session) return;
    voiceService.stop();

    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= session.puzzles.length) {
      setPhase('complete');
      void getPuzzleStats().then(setStats);
    } else {
      setSession((prev) => {
        if (!prev) return prev;
        return { ...prev, currentIndex: nextIndex, puzzleCorrect: false };
      });
      setPhase('solving');
      setTimerRunning(true);
      setTimerKey((k) => k + 1);
      resetTimer();
    }
  }, [session, resetTimer]);

  const handleBack = useCallback((): void => {
    voiceService.stop();
    setPhase('mode_select');
    setSession(null);
    setTimerRunning(false);
    void getPuzzleStats().then(setStats);
  }, []);

  const currentPuzzle = session?.puzzles[session.currentIndex];
  const modeConfig = session
    ? { timeLimit: session.mode === 'timed_blitz' ? 30 : null }
    : null;

  return (
    <div className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto" data-testid="puzzle-trainer">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        {phase !== 'mode_select' && (
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
            aria-label="Back to modes"
            data-testid="back-to-modes"
          >
            <ArrowLeft size={18} className="text-theme-text" />
          </button>
        )}
        <div className="flex items-center gap-2">
          <Brain size={24} className="text-theme-accent" />
          <h1 className="text-xl font-bold text-theme-text">Puzzle Trainer</h1>
        </div>
        <div className="flex-1" />
        <span className="text-sm text-theme-text-muted">Rating: {userRating}</span>
      </div>

      {/* Mode selection */}
      {phase === 'mode_select' && (
        <div className="space-y-4">
          {stats && (
            <div className="flex flex-wrap gap-4 text-sm text-theme-text-muted mb-2">
              <span>{stats.totalPuzzles} puzzles</span>
              <span>{stats.totalAttempted} attempted</span>
              {stats.totalAttempted > 0 && (
                <span>{Math.round(stats.overallAccuracy * 100)}% accuracy</span>
              )}
              <span>{stats.duePuzzles} due for review</span>
            </div>
          )}
          <PuzzleModeSelector onSelectMode={(mode) => void handleSelectMode(mode)} />
        </div>
      )}

      {/* Active puzzle */}
      {(phase === 'solving' || phase === 'grading') && session && currentPuzzle && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            {/* Timer for blitz mode */}
            {modeConfig?.timeLimit !== null && modeConfig?.timeLimit !== undefined && (
              <PuzzleTimer
                key={timerKey}
                duration={modeConfig.timeLimit}
                running={timerRunning && phase === 'solving'}
                onTimeout={handleTimeout}
              />
            )}

            {/* Board */}
            <PuzzleBoard
              puzzle={currentPuzzle}
              onComplete={handlePuzzleComplete}
              disabled={phase === 'grading'}
            />

            {/* SRS Grade buttons */}
            {phase === 'grading' && (
              <div className="space-y-2">
                <p className="text-xs text-theme-text-muted">How well did you know this?</p>
                <SrsGradeButtons
                  currentInterval={currentPuzzle.srsInterval}
                  easeFactor={currentPuzzle.srsEaseFactor}
                  repetitions={currentPuzzle.srsRepetitions}
                  onGrade={(grade) => void handleGrade(grade)}
                />
              </div>
            )}
          </div>

          {/* Right panel: session stats + info */}
          <div className="space-y-4">
            <div className="bg-theme-surface rounded-lg p-4">
              <h3 className="text-sm font-semibold text-theme-text mb-3">Session</h3>
              <PuzzleSessionStats
                solved={session.solved}
                failed={session.failed}
                streak={session.streak}
                ratingChange={session.ratingChange}
              />
              <div className="mt-3 text-xs text-theme-text-muted">
                Puzzle {session.currentIndex + 1} of {session.puzzles.length}
                {phase === 'solving' && elapsed > 0 && (
                  <span className="ml-2">({elapsed}s)</span>
                )}
              </div>
              {/* Progress bar */}
              <div className="mt-2 h-1.5 rounded-full bg-theme-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-theme-accent transition-all"
                  style={{ width: `${((session.currentIndex) / session.puzzles.length) * 100}%` }}
                />
              </div>
            </div>

            {/* Skip button */}
            {phase === 'solving' && (
              <button
                onClick={handleSkip}
                className="flex items-center gap-2 text-sm text-theme-text-muted hover:text-theme-text transition-colors"
                data-testid="skip-puzzle"
              >
                <SkipForward size={14} />
                Skip puzzle
              </button>
            )}
          </div>
        </div>
      )}

      {/* Session complete */}
      {phase === 'complete' && session && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4" data-testid="session-complete">
          <div className="text-4xl">
            {session.mode === 'daily_challenge' ? (session.puzzleCorrect ? '🎉' : '💪') : '🏆'}
          </div>
          <h2 className="text-xl font-bold text-theme-text">
            {session.mode === 'daily_challenge'
              ? (session.puzzleCorrect ? 'Daily Challenge Solved!' : 'Keep Practicing!')
              : 'Session Complete!'}
          </h2>
          {session.mode !== 'daily_challenge' && (
            <div className="flex gap-6 text-sm">
              <div className="text-center">
                <div className="text-2xl font-bold" style={{ color: 'var(--color-success)' }}>{session.solved}</div>
                <div className="text-theme-text-muted">Solved</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold" style={{ color: 'var(--color-error)' }}>{session.failed}</div>
                <div className="text-theme-text-muted">Failed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold" style={{ color: session.ratingChange >= 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                  {session.ratingChange >= 0 ? '+' : ''}{session.ratingChange}
                </div>
                <div className="text-theme-text-muted">Rating</div>
              </div>
            </div>
          )}
          <button
            onClick={handleBack}
            className="mt-4 px-6 py-2 rounded-lg bg-theme-accent text-white font-medium hover:opacity-90 transition-opacity"
            data-testid="back-to-modes-complete"
          >
            Back to Modes
          </button>
        </div>
      )}
    </div>
  );
}
