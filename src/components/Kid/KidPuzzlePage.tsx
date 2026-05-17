import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { getKidPuzzles, seedPuzzles, recordAttempt } from '../../services/puzzleService';
import { DifficultyToggle } from '../Coach/DifficultyToggle';
import { PuzzleBoard } from '../Puzzles/PuzzleBoard';
import type { PuzzleOutcome } from '../Puzzles/PuzzleBoard';
import { useAppStore } from '../../stores/appStore';
import type { CoachDifficulty, PuzzleRecord } from '../../types';

type KidPuzzlePhase = 'select' | 'loading' | 'playing';

// Per non-negotiable #5, per-puzzle voice praise is banned —
// it tunes out within minutes. The on-screen overlay (⭐ correct
// / 💪 incorrect) carries the per-puzzle feedback. Voice fires
// only at session summary (handleDone → kidSpeak).

const DIFFICULTY_INFO: Record<CoachDifficulty, { emoji: string; label: string; description: string }> = {
  easy:   { emoji: '🌱', label: 'Beginner', description: 'Simple puzzles to get started' },
  medium: { emoji: '⭐', label: 'Explorer', description: 'A bit more tricky!' },
  hard:   { emoji: '🏆', label: 'Champion', description: 'Challenge yourself!' },
};

const BATCH_SIZE = 20;
const REFETCH_THRESHOLD = 5;
const AUTO_ADVANCE_DELAY = 2000;

export function KidPuzzlePage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);

  const [phase, setPhase] = useState<KidPuzzlePhase>('select');
  const [difficulty, setDifficulty] = useState<CoachDifficulty>('easy');
  const [puzzles, setPuzzles] = useState<PuzzleRecord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solvedCount, setSolvedCount] = useState(0);
  const [totalAttempted, setTotalAttempted] = useState(0);
  const [resultOverlay, setResultOverlay] = useState<'correct' | 'incorrect' | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const isFetchingRef = useRef(false);
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kidSpeak = useCallback((text: string): void => {
    if (!voiceOn) return;
    void voiceService.speak(text);
  }, [voiceOn]);

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  useEffect(() => {
    kidSpeak('Welcome to Puzzle Quest! Pick your level and start solving!');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup auto-advance timer and voice on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
      voiceService.stop();
    };
  }, []);

  const fetchMorePuzzles = useCallback(async (diff: CoachDifficulty): Promise<PuzzleRecord[]> => {
    if (isFetchingRef.current) return [];
    isFetchingRef.current = true;
    try {
      await seedPuzzles();
      const fetched = await getKidPuzzles(diff, BATCH_SIZE);
      return fetched;
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  const handleStart = useCallback(async (): Promise<void> => {
    setPhase('loading');
    const fetched = await fetchMorePuzzles(difficulty);
    if (fetched.length === 0) {
      kidSpeak('No puzzles available for this level. Try another!');
      setPhase('select');
      return;
    }
    setPuzzles(fetched);
    setCurrentIndex(0);
    setSolvedCount(0);
    setTotalAttempted(0);
    setResultOverlay(null);
    setPhase('playing');
    kidSpeak('Here is your first puzzle! Find the best move.');
  }, [difficulty, kidSpeak, fetchMorePuzzles]);

  const advanceToNext = useCallback((): void => {
    voiceService.stop();
    setResultOverlay(null);
    setCurrentIndex((prev) => prev + 1);
  }, []);

  // Fetch more puzzles when getting close to the end
  useEffect(() => {
    if (phase !== 'playing') return;
    const remaining = puzzles.length - currentIndex;
    if (remaining <= REFETCH_THRESHOLD && !isFetchingRef.current) {
      void fetchMorePuzzles(difficulty).then((newPuzzles) => {
        if (newPuzzles.length > 0) {
          setPuzzles((prev) => [...prev, ...newPuzzles]);
        }
      });
    }
  }, [currentIndex, puzzles.length, phase, difficulty, fetchMorePuzzles]);

  const handlePuzzleComplete = useCallback(({ correct }: PuzzleOutcome): void => {
    if (correct) setSolvedCount((c) => c + 1);
    setTotalAttempted((t) => t + 1);
    setResultOverlay(correct ? 'correct' : 'incorrect');

    // Record the attempt
    if (activeProfile) {
      const puzzle = puzzles[currentIndex];
      void recordAttempt(
        puzzle.id,
        correct,
        activeProfile.puzzleRating,
        correct ? 'good' : 'again',
      );
    }

    // Per-puzzle voice deliberately silent — see comment near the
    // (removed) CORRECT_MESSAGES / INCORRECT_MESSAGES arrays.
    voiceService.stop();

    // Auto-advance to next puzzle
    autoAdvanceTimerRef.current = setTimeout(() => {
      advanceToNext();
    }, AUTO_ADVANCE_DELAY);
  }, [puzzles, currentIndex, activeProfile, kidSpeak, advanceToNext]);

  const handleDone = useCallback((): void => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setPhase('select');
    setPuzzles([]);
    setCurrentIndex(0);
    setResultOverlay(null);
  }, []);

  const currentPuzzle = puzzles[currentIndex] as PuzzleRecord | undefined;
  const info = DIFFICULTY_INFO[difficulty];

  // Determine the user's color for the current puzzle (for display purposes)
  const userColor = currentPuzzle
    ? (currentPuzzle.fen.split(' ')[1] === 'w' ? 'black' : 'white')
    : 'white';

  return (
    <div
      className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="kid-puzzle-page"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Puzzle Quest 🧩</h2>
        </div>
        <button
          onClick={handleToggleVoice}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Select Phase */}
      {phase === 'select' && (
        <div className="flex flex-col gap-6 items-center">
          {/* Show stats if returning from a session */}
          {totalAttempted > 0 && (
            <div
              className="rounded-2xl p-6 border-2 text-center w-full max-w-md"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-accent)',
                boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
              }}
              data-testid="puzzle-session-stats"
            >
              <span className="text-4xl">🎉</span>
              <p className="text-lg font-bold mt-2">
                Solved {solvedCount} of {totalAttempted} puzzles!
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {solvedCount === totalAttempted
                  ? 'Perfect score! You are a puzzle champion!'
                  : solvedCount > totalAttempted / 2
                    ? 'Great job! Keep practicing!'
                    : 'Every puzzle makes you stronger!'}
              </p>
            </div>
          )}

          <div
            className="rounded-2xl p-6 border-2 text-center w-full max-w-md"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
            }}
          >
            <p className="text-2xl font-bold mb-4">Choose Your Level!</p>
            <DifficultyToggle value={difficulty} onChange={setDifficulty} />
            <div className="mt-4 text-center">
              <span className="text-3xl">{info.emoji}</span>
              <p className="font-semibold text-lg mt-1">{info.label}</p>
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                {info.description}
              </p>
            </div>
          </div>

          <button
            onClick={() => void handleStart()}
            className="px-8 py-3 rounded-xl text-lg font-bold transition-opacity hover:opacity-80"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
            }}
            data-testid="start-puzzle-btn"
          >
            Start Puzzles!
          </button>
        </div>
      )}

      {/* Loading Phase */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1">
          <p className="text-lg font-medium" data-testid="puzzle-loading">Loading puzzles...</p>
        </div>
      )}

      {/* Playing Phase */}
      {phase === 'playing' && currentPuzzle && (
        <div className="flex flex-col gap-4 relative">
          <div className="flex items-center justify-between" data-testid="puzzle-progress">
            <span className="text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Puzzle {totalAttempted + 1} · Playing as {userColor}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium" data-testid="puzzle-solved-count">
                Solved: {solvedCount}
              </span>
              <button
                onClick={handleDone}
                className="px-3 py-1 rounded-lg text-sm font-medium border transition-opacity hover:opacity-80"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-muted)',
                  background: 'var(--color-surface)',
                }}
                data-testid="done-btn"
              >
                Done
              </button>
            </div>
          </div>

          <PuzzleBoard
            puzzle={currentPuzzle}
            onComplete={handlePuzzleComplete}
          />

          {/* Result overlay */}
          {resultOverlay && (
            <div
              className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none"
              data-testid="puzzle-result-overlay"
            >
              <div
                className="rounded-2xl px-8 py-6 text-center shadow-lg"
                style={{
                  background: resultOverlay === 'correct'
                    ? 'rgba(34, 197, 94, 0.95)'
                    : 'rgba(239, 68, 68, 0.9)',
                  color: 'white',
                }}
              >
                <span className="text-4xl">
                  {resultOverlay === 'correct' ? '⭐' : '💪'}
                </span>
                <p className="text-xl font-bold mt-2" data-testid="puzzle-result-message">
                  {resultOverlay === 'correct' ? 'Correct!' : 'Good Try!'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* No more puzzles fallback */}
      {phase === 'playing' && !currentPuzzle && (
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg font-medium">No more puzzles at this level!</p>
          <button
            onClick={handleDone}
            className="px-6 py-3 rounded-xl font-bold transition-opacity hover:opacity-80"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
            }}
            data-testid="change-level-btn"
          >
            Choose Another Level
          </button>
        </div>
      )}
    </div>
  );
}
