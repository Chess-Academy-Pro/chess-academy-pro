import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Lightbulb, Play, SkipForward, Pause, ChevronLeft } from 'lucide-react';
import { Chess } from 'chess.js';
import { ChessBoard } from '../Board/ChessBoard';
import {
  buildTacticCreateQueue,
  updateContextDepth,
  resetContextDepth,
  getContextDepth,
} from '../../services/tacticCreateService';
import { gradeMistakePuzzle } from '../../services/mistakePuzzleService';
import { updatePuzzleRating } from '../../services/puzzleService';
import { tacticTypeLabel, tacticTypeIcon } from '../../services/tacticalProfileService';
import { voiceService } from '../../services/voiceService';
import { logAppAudit } from '../../services/appAuditor';
import {
  createIntro,
  createReplayNarration,
  createTransition,
  createCorrect,
  createIncorrect,
  createDepthIncrease,
} from '../../services/tacticNarrationService';
import { useAppStore } from '../../stores/appStore';
import { MistakePuzzleBoard } from '../Puzzles/MistakePuzzleBoard';
import type { TacticCreateItem, ReplayMove } from '../../services/tacticCreateService';
import type { TacticType } from '../../types';

type Phase = 'loading' | 'replay' | 'solving' | 'feedback' | 'summary';

// Replay speed in ms per move — starts slow, accelerates as more context is shown
const BASE_REPLAY_SPEED = 1000;
const FAST_REPLAY_SPEED = 600;
const SPEED_THRESHOLD = 15; // After this many moves, speed up

export function TacticCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);

  const filterTypes = (location.state as { filterTypes?: TacticType[] } | null)?.filterTypes;

  // Mount audit — observability for the tactics-tab audit stream
  // (mirrors the F1 fix from PR #504 on /weaknesses).
  useEffect(() => {
    void logAppAudit({
      kind: 'tactics-surface-event',
      category: 'subsystem',
      source: 'TacticCreatePage.mount',
      summary: 'tactic-create surface opened',
      details: filterTypes ? JSON.stringify({ filterTypes }) : undefined,
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [phase, setPhase] = useState<Phase>('loading');
  const [queue, setQueue] = useState<TacticCreateItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const [consecutiveSolves, setConsecutiveSolves] = useState(0);
  const [currentDepth, setCurrentDepth] = useState(8);

  // Replay state
  const [replayMoves, setReplayMoves] = useState<ReplayMove[]>([]);
  const [replayStep, setReplayStep] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayPaused, setReplayPaused] = useState(false);

  // Feedback after solve — shows whether depth will increase
  const [feedbackCorrect, setFeedbackCorrect] = useState(false);
  const [subtitle, setSubtitle] = useState('');

  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Warmup voice on mount, stop on unmount
  useEffect(() => {
    void voiceService.warmup();
    return () => { voiceService.stop(); };
  }, []);

  useEffect(() => {
    void loadQueue();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadQueue(): Promise<void> {
    setPhase('loading');
    const depth = await getContextDepth();
    setCurrentDepth(depth);
    const items = await buildTacticCreateQueue(10, filterTypes);
    if (items.length === 0) {
      setPhase('summary');
      return;
    }
    setQueue(items);
    setCurrentIndex(0);
    setSolved(0);
    setFailed(0);
    setConsecutiveSolves(0);
    prepareReplay(items[0]);
  }

  function prepareReplay(item: TacticCreateItem | undefined): void {
    if (!item) {
      setPhase('solving');
      return;
    }

    // Take the last contextDepth moves from the full replay
    const visibleMoves = item.replayMoves.slice(-item.contextDepth);
    setReplayMoves(visibleMoves);
    setReplayStep(0);
    setReplayPlaying(false);
    setReplayPaused(false);
    setSubtitle('');
    setPhase('replay');
  }

  // Auto-play replay moves with narration
  useEffect(() => {
    if (phase !== 'replay' || !replayPlaying || replayPaused || replayStep >= replayMoves.length) return;

    const speed = replayStep > SPEED_THRESHOLD ? FAST_REPLAY_SPEED : BASE_REPLAY_SPEED;
    const timer = setTimeout(() => {
      const nextStep = replayStep + 1;
      setReplayStep(nextStep);

      // Narrate notable moves during replay
      const move = replayMoves[replayStep];
      const narration = createReplayNarration(move.san, move.isWhite, replayStep, replayMoves.length);
      if (narration) {
        setSubtitle(narration);
        void voiceService.speak(narration);
      }
    }, speed);
    replayTimerRef.current = timer;

    return () => clearTimeout(timer);
  }, [phase, replayPlaying, replayPaused, replayStep, replayMoves]);

  // When replay finishes, narrate transition then move to solving
  useEffect(() => {
    if (phase === 'replay' && replayPlaying && !replayPaused && replayStep >= replayMoves.length) {
      const transition = createTransition();
      setSubtitle(transition);
      void voiceService.speak(transition);
      const timer = setTimeout(() => {
        setPhase('solving');
      }, 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [phase, replayPlaying, replayPaused, replayStep, replayMoves.length]);

  const handleStartReplay = useCallback((): void => {
    setReplayPlaying(true);
    // Narrate intro
    const item = queue.at(currentIndex);
    if (item) {
      const intro = createIntro(
        item.originalMistake.opponentName,
        item.originalMistake.openingName,
        item.contextDepth,
        item.replayMoves.length,
      );
      setSubtitle(intro);
      void voiceService.speak(intro);
    }
  }, [queue, currentIndex]);

  const handleTogglePause = useCallback((): void => {
    setReplayPaused((p) => !p);
  }, []);

  const handleSkipReplay = useCallback((): void => {
    if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
    voiceService.stop();
    setSubtitle('');
    setPhase('solving');
  }, []);

  const handleComplete = useCallback(async (correct: boolean): Promise<void> => {
    const item = queue.at(currentIndex);
    if (!item) return;

    const newStreak = correct ? consecutiveSolves + 1 : 0;
    setConsecutiveSolves(newStreak);
    setFeedbackCorrect(correct);

    if (correct) {
      setSolved((s) => s + 1);
      // Scale up context depth for next time
      const newDepth = await updateContextDepth(newStreak);
      setCurrentDepth(newDepth);
      // Narrate success + depth increase
      const msg = createCorrect(item.tacticType, newStreak);
      const depthMsg = newStreak > 1 ? ' ' + createDepthIncrease(newDepth) : '';
      setSubtitle(msg);
      void voiceService.speak(msg + depthMsg);
    } else {
      setFailed((f) => f + 1);
      // Reset context depth on failure — back to basics
      if (newStreak === 0 && consecutiveSolves > 0) {
        await resetContextDepth();
        setCurrentDepth(8);
      }
      // Narrate miss
      const msg = createIncorrect(item.tacticType);
      setSubtitle(msg);
      void voiceService.speak(msg);
    }

    // Grade the puzzle
    const grade = correct ? 'good' : 'again';
    await gradeMistakePuzzle(item.originalMistake.id, grade, correct);

    // Update puzzle rating
    if (activeProfile) {
      const newRating = updatePuzzleRating(activeProfile.puzzleRating, item.puzzle.rating, correct);
      setActiveProfile({ ...activeProfile, puzzleRating: newRating });
    }

    // Show feedback briefly, then advance
    setPhase('feedback');
    setTimeout(() => {
      const nextIndex = currentIndex + 1;
      if (nextIndex >= queue.length) {
        setPhase('summary');
      } else {
        setCurrentIndex(nextIndex);
        prepareReplay(queue[nextIndex]);
      }
    }, 2500);
  }, [queue, currentIndex, consecutiveSolves, activeProfile, setActiveProfile]);

  const handlePrev = useCallback((): void => {
    if (currentIndex <= 0) return;
    voiceService.stop();
    setSubtitle('');
    const prevIndex = currentIndex - 1;
    setCurrentIndex(prevIndex);
    prepareReplay(queue[prevIndex]);
  }, [currentIndex, queue]);

  const handleSkipPuzzle = useCallback((): void => {
    voiceService.stop();
    setSubtitle('');
    // Reset streak — a skip breaks the consecutive solve chain
    setConsecutiveSolves(0);
    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
      setPhase('summary');
    } else {
      setCurrentIndex(nextIndex);
      prepareReplay(queue[nextIndex]);
    }
  }, [currentIndex, queue]);

  const currentItem = queue.at(currentIndex);
  const total = solved + failed;

  // Current replay FEN
  const replayFen = replayStep > 0 && replayStep <= replayMoves.length
    ? replayMoves[replayStep - 1].fen
    : replayMoves.length > 0
      ? new Chess().fen()
      : '';

  const currentOrientation = currentItem?.originalMistake.playerColor === 'black' ? 'black' : 'white';

  // How much of the game is being replayed
  const replayDescription = currentItem
    ? currentItem.contextDepth >= currentItem.replayMoves.length
      ? 'Full game replay'
      : `Last ${currentItem.contextDepth} moves`
    : '';

  return (
    <div className="max-w-2xl mx-auto w-full p-4 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 flex flex-col gap-4 min-h-[80vh]">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => void navigate('/tactics')} className="p-2 rounded-lg hover:opacity-80" data-testid="back-btn">
          <ArrowLeft size={20} style={{ color: 'var(--color-text)' }} />
        </button>
        <Lightbulb size={24} style={{ color: '#a78bfa' }} />
        <div className="flex-1">
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>Create</h1>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Replay your game, then find the tactic
          </p>
        </div>
        {filterTypes && filterTypes.length > 0 && (
          <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'color-mix(in srgb, #a78bfa 15%, transparent)', color: '#a78bfa' }}>
            {filterTypes.map((t) => tacticTypeLabel(t)).join(', ')}
          </span>
        )}
      </div>

      {/* Loading */}
      {phase === 'loading' && (
        <div className="flex items-center justify-center flex-1" data-testid="loading">
          <div className="text-center">
            <p style={{ color: 'var(--color-text-muted)' }}>Building game replays...</p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Context depth: {currentDepth} moves
            </p>
          </div>
        </div>
      )}

      {/* Replay Phase — watch your game unfold */}
      {phase === 'replay' && currentItem && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col gap-4"
        >
          {/* Progress */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ background: '#a78bfa', width: `${Math.round((currentIndex / queue.length) * 100)}%` }}
              />
            </div>
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              {currentIndex + 1}/{queue.length}
            </span>
          </div>

          {/* Game info */}
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {replayPlaying && !replayPaused
                ? 'Your game is unfolding... stay alert'
                : replayPaused
                  ? 'Paused'
                  : 'Watch your game and find the tactic when it appears'}
            </p>
            <div className="flex items-center justify-center gap-3 mt-1">
              <span className="text-xs" style={{ color: '#a78bfa' }}>
                {replayDescription}
              </span>
              {currentItem.originalMistake.opponentName && (
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  vs {currentItem.originalMistake.opponentName}
                </span>
              )}
              {currentItem.originalMistake.openingName && (
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {currentItem.originalMistake.openingName}
                </span>
              )}
            </div>
          </div>

          {/* Board */}
          <div className="w-full md:max-w-[420px] mx-auto">
            <ChessBoard
              key={`replay-${currentIndex}-${replayStep}`}
              initialFen={replayFen}
              orientation={currentOrientation}
              interactive={false}
              showFlipButton
              showUndoButton={false}
              showResetButton={false}
            />
          </div>

          {/* Voice subtitle */}
          {subtitle && (
            <AnimatePresence mode="wait">
              <motion.div
                key={subtitle}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="text-center text-xs py-1.5 px-3 rounded-lg"
                style={{ color: '#a78bfa', background: 'color-mix(in srgb, #a78bfa 8%, transparent)' }}
                data-testid="narration-subtitle"
              >
                {subtitle}
              </motion.div>
            </AnimatePresence>
          )}

          {/* Replay move counter */}
          {replayPlaying && (
            <div className="flex items-center justify-center gap-2">
              <div
                className="h-1.5 flex-1 max-w-48 rounded-full overflow-hidden"
                style={{ background: 'var(--color-border)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    background: '#a78bfa',
                    width: `${Math.round((replayStep / replayMoves.length) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                {replayStep}/{replayMoves.length}
              </span>
            </div>
          )}

          {/* Move notation */}
          {replayPlaying && replayStep > 0 && (
            <div className="flex flex-wrap gap-1 justify-center max-h-16 overflow-y-auto">
              {replayMoves.slice(0, replayStep).map((m, i) => (
                <span
                  key={i}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: i === replayStep - 1 ? 'color-mix(in srgb, #a78bfa 20%, transparent)' : 'var(--color-surface)',
                    color: i === replayStep - 1 ? '#a78bfa' : 'var(--color-text)',
                    fontWeight: i === replayStep - 1 ? 600 : 400,
                  }}
                >
                  {m.isWhite ? `${m.moveNumber}.` : ''}{m.san}
                </span>
              ))}
            </div>
          )}

          {/* Controls */}
          <div className="flex justify-center gap-3">
            {!replayPlaying ? (
              <>
                <button
                  onClick={handleStartReplay}
                  className="px-6 py-3 rounded-xl font-semibold text-sm flex items-center gap-2"
                  style={{ background: '#a78bfa', color: 'var(--color-bg)' }}
                  data-testid="start-replay"
                >
                  <Play size={16} />
                  Replay Game
                </button>
                <button
                  onClick={handleSkipReplay}
                  className="px-6 py-3 rounded-xl font-semibold text-sm flex items-center gap-2 border"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  data-testid="skip-replay"
                >
                  <SkipForward size={16} />
                  Skip to Puzzle
                </button>
              </>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={handleTogglePause}
                  className="px-4 py-2 rounded-lg text-xs flex items-center gap-1.5 border"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  {replayPaused ? <Play size={12} /> : <Pause size={12} />}
                  {replayPaused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={handleSkipReplay}
                  className="px-4 py-2 rounded-lg text-xs flex items-center gap-1.5 border"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  <SkipForward size={12} />
                  Skip
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Solving Phase */}
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
            {/* Progress */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ background: '#a78bfa', width: `${Math.round((currentIndex / queue.length) * 100)}%` }}
                />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {currentIndex + 1}/{queue.length}
              </span>
            </div>

            {/* Challenge prompt — no tactic type hint! */}
            <div
              className="text-center py-2 px-4 rounded-lg text-sm font-medium"
              style={{
                color: '#a78bfa',
                background: 'color-mix(in srgb, #a78bfa 8%, transparent)',
              }}
            >
              A tactic is available. Can you find it?
            </div>

            {/* Board */}
            <MistakePuzzleBoard
              puzzle={currentItem.originalMistake}
              onComplete={(correct) => void handleComplete(correct)}
            />

            {/* Navigation buttons */}
            <div className="flex justify-center gap-3">
              {currentIndex > 0 && (
                <button
                  onClick={handlePrev}
                  className="px-4 py-3 rounded-xl font-semibold text-sm flex items-center gap-1.5 border"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  data-testid="prev-puzzle-btn"
                >
                  <ChevronLeft size={16} />
                  Prev
                </button>
              )}
              <button
                onClick={handleSkipPuzzle}
                className="px-4 py-3 rounded-xl font-semibold text-sm flex items-center gap-1.5 border"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                data-testid="skip-puzzle-btn"
              >
                Skip
                <SkipForward size={14} />
              </button>
            </div>

            {/* Session stats */}
            <div className="flex justify-center gap-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              <span style={{ color: 'var(--color-success)' }}>{solved} found</span>
              <span style={{ color: 'var(--color-error)' }}>{failed} missed</span>
              <span style={{ color: '#a78bfa' }}>Depth: {currentDepth}</span>
            </div>
          </motion.div>
        </AnimatePresence>
      )}

      {/* Feedback Phase — brief result before advancing */}
      {phase === 'feedback' && currentItem && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center flex-1 gap-4"
        >
          <div
            className="text-5xl"
          >
            {feedbackCorrect ? tacticTypeIcon(currentItem.tacticType) : '\u274C'}
          </div>
          <div className="text-center">
            <p className="text-lg font-bold" style={{ color: feedbackCorrect ? 'var(--color-success)' : 'var(--color-error)' }}>
              {feedbackCorrect ? 'Tactic Found!' : 'Missed It'}
            </p>
            <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {tacticTypeIcon(currentItem.tacticType)} {tacticTypeLabel(currentItem.tacticType)}
            </p>
            {feedbackCorrect && consecutiveSolves > 1 && (
              <p className="text-xs mt-2" style={{ color: '#a78bfa' }}>
                {consecutiveSolves} in a row — context depth increasing to {currentDepth} moves
              </p>
            )}
            {!feedbackCorrect && (
              <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                Context depth reset — rebuilding from shorter replays
              </p>
            )}
          </div>
        </motion.div>
      )}

      {/* Summary */}
      {phase === 'summary' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center flex-1 gap-6"
          data-testid="session-summary"
        >
          <Lightbulb size={40} style={{ color: '#a78bfa' }} />
          <div className="text-center">
            <h2 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>Session Complete</h2>
            {total > 0 ? (
              <>
                <p className="text-lg mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  {solved}/{total} tactics created ({Math.round((solved / total) * 100)}%)
                </p>
                <p className="text-sm mt-1" style={{ color: '#a78bfa' }}>
                  Context depth: {currentDepth} moves
                </p>
                {currentDepth >= 20 && (
                  <p className="text-xs mt-1" style={{ color: 'var(--color-success)' }}>
                    You&apos;re replaying deep game positions — impressive alertness!
                  </p>
                )}
              </>
            ) : (
              <>
              <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
                Import games to review your in-game mistakes and unlock Create mode.
              </p>
              <button
                onClick={() => void navigate('/games/import')}
                className="mt-4 px-5 py-2.5 rounded-xl font-semibold text-sm"
                style={{ background: '#a78bfa', color: 'var(--color-bg)' }}
              >
                Import Games
              </button>
              </>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => void loadQueue()}
              className="px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: '#a78bfa', color: 'var(--color-bg)' }}
              data-testid="play-again"
            >
              Play Again
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
