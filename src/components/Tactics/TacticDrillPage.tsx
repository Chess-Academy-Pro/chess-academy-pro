import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Swords, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  getPuzzleForThemeAtRating,
  calculateRatingDelta,
  applyTimeBonus,
  THEME_MAP,
} from '../../services/puzzleService';
import { useAppStore } from '../../stores/appStore';
import { PuzzleBoard } from '../Puzzles/PuzzleBoard';
import type { PuzzleOutcome } from '../Puzzles/PuzzleBoard';
import type { PuzzleRecord } from '../../types';
import { db } from '../../db/schema';
import { logAppAudit } from '../../services/appAuditor';

type Phase = 'loading' | 'solving' | 'summary';

const DRILL_SIZE = 10;

/** Aggressive adaptive ramping — find the player's ceiling in 10 puzzles. */
const CLEAN_FAST_BONUS = 100;   // Clean solve < 20s
const CLEAN_SOLVE_BONUS = 75;   // Clean solve (any time)
const ASSISTED_SOLVE_BONUS = 30; // Solved with hint or retry
const FAIL_PENALTY = -50;        // Failed puzzle

interface DrillResult {
  puzzleRating: number;
  correct: boolean;
  solveTimeMs: number;
}

export function TacticDrillPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const setGlobalBoardContext = useAppStore((s) => s.setGlobalBoardContext);

  const filterThemes = (location.state as { filterThemes?: string[] } | null)?.filterThemes;
  const filterTypes = (location.state as { filterTypes?: string[] } | null)?.filterTypes;
  const themes = filterThemes ?? filterTypes ?? ['fork'];

  // Resolve theme labels to Lichess tags
  const lichessThemes = themes.flatMap((t) => {
    const mapped = THEME_MAP[t];
    return mapped ?? [t];
  });

  const [phase, setPhase] = useState<Phase>('loading');
  const [puzzleHistory, setPuzzleHistory] = useState<PuzzleRecord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const [sessionRating, setSessionRating] = useState(
    activeProfile?.puzzleRating ?? activeProfile?.currentRating ?? 1200,
  );
  const [ratingDelta, setRatingDelta] = useState<number | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const completedRef = useRef<Set<number>>(new Set());
  const resultsRef = useRef<DrillResult[]>([]);

  const currentPuzzle = puzzleHistory[currentIndex] ?? null;
  const themeLabel = themes.length === 1
    ? themes[0].replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim()
    : 'Mixed';

  // Clear board context on unmount
  useEffect(() => {
    return () => { setGlobalBoardContext(null); };
  }, [setGlobalBoardContext]);

  /** Fetch the next puzzle at the current adaptive rating. */
  const fetchNextPuzzle = useCallback(async (targetRating: number): Promise<PuzzleRecord | null> => {
    return getPuzzleForThemeAtRating(lichessThemes, targetRating, seenIdsRef.current);
  }, [lichessThemes]);

  /** Start or restart a drill session. */
  const startSession = useCallback(async (): Promise<void> => {
    setPhase('loading');
    const startRating = activeProfile?.puzzleRating ?? activeProfile?.currentRating ?? 1200;
    setSessionRating(startRating);
    seenIdsRef.current = new Set();
    completedRef.current = new Set();
    resultsRef.current = [];
    setSolved(0);
    setFailed(0);
    setRatingDelta(null);
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'TacticDrillPage.session-start',
      summary: `drill started at rating ${startRating} themes=[${lichessThemes.slice(0, 4).join(',')}]`,
      details: JSON.stringify({ startRating, themes: lichessThemes }),
    });

    const puzzle = await getPuzzleForThemeAtRating(lichessThemes, startRating, seenIdsRef.current);
    if (!puzzle) {
      setPhase('summary');
      return;
    }
    seenIdsRef.current.add(puzzle.id);
    setPuzzleHistory([puzzle]);
    setCurrentIndex(0);
    setPhase('solving');
  }, [lichessThemes, activeProfile]);

  useEffect(() => {
    void startSession();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Handle puzzle completion — update adaptive rating and fetch next. */
  const handlePuzzleComplete = useCallback((outcome: PuzzleOutcome): void => {
    if (completedRef.current.has(currentIndex)) return;
    completedRef.current.add(currentIndex);

    const puzzle = puzzleHistory[currentIndex];
    if (!puzzle) return;

    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'TacticDrillPage.puzzle-graded',
      summary: `puzzle ${currentIndex + 1}/${DRILL_SIZE} ${outcome.correct ? 'solved' : 'failed'} in ${outcome.solveTimeMs}ms`,
      details: JSON.stringify({
        puzzleId: puzzle.id,
        correct: outcome.correct,
        solveTimeMs: outcome.solveTimeMs,
        usedHint: outcome.usedHint,
        hadRetry: outcome.hadRetry,
      }),
    });

    // Determine adaptive rating bump
    const isClean = outcome.correct && !outcome.usedHint && !outcome.hadRetry && !outcome.showedSolution;
    const isFast = outcome.solveTimeMs < 20_000;
    let ratingBump: number;
    if (outcome.correct) {
      if (isClean && isFast) {
        ratingBump = CLEAN_FAST_BONUS;
      } else if (isClean) {
        ratingBump = CLEAN_SOLVE_BONUS;
      } else {
        ratingBump = ASSISTED_SOLVE_BONUS;
      }
      setSolved((s) => s + 1);
    } else {
      ratingBump = FAIL_PENALTY;
      setFailed((f) => f + 1);
    }

    const newSessionRating = Math.max(400, sessionRating + ratingBump);
    setSessionRating(newSessionRating);

    // Apply Elo with time bonus to the player's persistent puzzle rating
    const eloDelta = calculateRatingDelta(
      activeProfile?.puzzleRating ?? 1200,
      puzzle.rating,
      outcome.correct,
    );
    const adjustedDelta = outcome.correct
      ? applyTimeBonus(eloDelta, outcome.solveTimeMs)
      : eloDelta;
    setRatingDelta(adjustedDelta);

    if (activeProfile) {
      const newPuzzleRating = Math.max(100, (activeProfile.puzzleRating ?? 1200) + adjustedDelta);
      const updated = { ...activeProfile, puzzleRating: newPuzzleRating };
      setActiveProfile(updated);
      void db.profiles.update(activeProfile.id, { puzzleRating: newPuzzleRating });
    }

    resultsRef.current.push({
      puzzleRating: puzzle.rating,
      correct: outcome.correct,
      solveTimeMs: outcome.solveTimeMs,
    });

    // Pre-fetch next puzzle if we haven't reached the drill size
    if (resultsRef.current.length < DRILL_SIZE) {
      void fetchNextPuzzle(newSessionRating).then((next) => {
        if (next) {
          seenIdsRef.current.add(next.id);
          setPuzzleHistory((prev) => [...prev, next]);
        }
      });
    }
  }, [currentIndex, puzzleHistory, sessionRating, activeProfile, setActiveProfile, fetchNextPuzzle]);

  const goNext = useCallback((): void => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= DRILL_SIZE || nextIndex >= puzzleHistory.length) {
      // Check if we need to wait for the next puzzle to load
      if (nextIndex < DRILL_SIZE && nextIndex >= puzzleHistory.length) {
        // Puzzle still loading — fetch and navigate when ready
        setPhase('loading');
        void fetchNextPuzzle(sessionRating).then((puzzle) => {
          if (puzzle) {
            seenIdsRef.current.add(puzzle.id);
            setPuzzleHistory((prev) => [...prev, puzzle]);
            setCurrentIndex(nextIndex);
            setPhase('solving');
          } else {
            setPhase('summary');
          }
        });
        return;
      }
      if (nextIndex >= DRILL_SIZE) {
        setPhase('summary');
        return;
      }
    }
    setCurrentIndex(nextIndex);
  }, [currentIndex, puzzleHistory.length, sessionRating, fetchNextPuzzle]);

  const goPrev = useCallback((): void => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  const totalCompleted = solved + failed;

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="tactic-drill-page"
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <button onClick={() => void navigate('/tactics')} className="p-2 rounded-lg hover:opacity-80" data-testid="back-btn">
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <Swords size={22} style={{ color: 'var(--color-warning)' }} />
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text)' }}>
          Drill: {themeLabel}
        </h1>
        {phase === 'solving' && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Target: {sessionRating}
            </span>
            {ratingDelta !== null && (
              <span className={`text-xs font-bold ${ratingDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {ratingDelta >= 0 ? '+' : ''}{ratingDelta}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Loading */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1">
          <p style={{ color: 'var(--color-text-muted)' }}>Loading puzzle...</p>
        </div>
      )}

      {/* Solving */}
      {phase === 'solving' && currentPuzzle && (
        <div className="flex-1">
          <PuzzleBoard
            key={currentPuzzle.id}
            puzzle={currentPuzzle}
            onComplete={handlePuzzleComplete}
          />

          {/* Navigation arrows */}
          <div className="flex items-center justify-center gap-6 py-3" data-testid="puzzle-nav">
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
              {currentIndex + 1} / {DRILL_SIZE}
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

          {/* Session stats bar */}
          <div className="flex justify-center gap-6 text-sm py-2" style={{ color: 'var(--color-text-muted)' }}>
            <span style={{ color: 'var(--color-success)' }}>{solved} solved</span>
            <span style={{ color: 'var(--color-error)' }}>{failed} missed</span>
            <span>Puzzle: {currentPuzzle.rating}</span>
          </div>
        </div>
      )}

      {/* Summary */}
      {phase === 'summary' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center flex-1 gap-6"
          data-testid="session-summary"
        >
          <Swords size={40} style={{ color: 'var(--color-warning)' }} />
          <div className="text-center">
            <h2 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>Drill Complete</h2>
            {totalCompleted > 0 ? (
              <>
                <p className="text-lg mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  {solved}/{totalCompleted} tactics found ({Math.round((solved / totalCompleted) * 100)}%)
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
                  Peak difficulty: {Math.max(...resultsRef.current.map((r) => r.puzzleRating))}
                </p>
              </>
            ) : (
              <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
                No puzzles found for this theme. Try a different category.
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => void startSession()}
              className="px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="play-again"
            >
              Drill Again
            </button>
            <button
              onClick={() => void navigate('/tactics/profile')}
              className="px-6 py-3 rounded-xl font-semibold text-sm border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              View Profile
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
