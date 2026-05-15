import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import { KING_MARCH_LEVELS } from '../../data/kingGameLevels';
import type { MoveResult } from '../../hooks/useChessGame';

type GamePhase = 'intro' | 'playing' | 'success' | 'complete';

export function KingMarchGame(): JSX.Element {
  const navigate = useNavigate();

  const [levelIndex, setLevelIndex] = useState(0);
  const [phase, setPhase] = useState<GamePhase>('intro');
  const [currentFen, setCurrentFen] = useState(KING_MARCH_LEVELS[0].fen);
  const [boardKey, setBoardKey] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [levelsWon, setLevelsWon] = useState(0);
  const [moveCount, setMoveCount] = useState(0);
  const [feedback, setFeedback] = useState<'blocked' | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const level = KING_MARCH_LEVELS[levelIndex];

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    };
  }, []);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  useEffect(() => {
    if (phase === 'intro') {
      kidSpeak('King March! Walk your king from e1 all the way to e8. Avoid the danger zones!');
    }
  }, [phase, kidSpeak]);

  // Compute attacked squares for highlights
  const { dangerSquares, safeKingMoves } = useMemo(() => {
    const chess = new Chess(currentFen);
    const danger: string[] = [];
    const safeMoves: string[] = [];

    for (const f of 'abcdefgh') {
      for (let r = 1; r <= 8; r++) {
        const sq = `${f}${r}`;
        if (chess.isAttacked(sq as Square, 'b')) {
          danger.push(sq);
        }
      }
    }

    // Get non-capture king moves as safe squares
    const moves = chess.moves({ verbose: true });
    for (const move of moves) {
      if (!move.captured) {
        safeMoves.push(move.to);
      }
    }

    return { dangerSquares: danger, safeKingMoves: safeMoves };
  }, [currentFen]);

  // Build annotation highlights
  const annotationHighlights = useMemo(() => {
    const highlights: Array<{ square: string; color: string }> = [];

    if (level.showDangerSquares) {
      for (const sq of dangerSquares) {
        highlights.push({ square: sq, color: 'rgba(239, 68, 68, 0.4)' });
      }
    }

    if (level.showSafeSquares) {
      for (const sq of safeKingMoves) {
        highlights.push({ square: sq, color: 'rgba(34, 197, 94, 0.5)' });
      }
    }

    // Always highlight the goal square with gold
    highlights.push({ square: level.goalSquare, color: 'rgba(234, 179, 8, 0.6)' });

    return highlights;
  }, [level, dangerSquares, safeKingMoves]);

  const handleMove = useCallback(
    (move: MoveResult): void => {
      // Reject captures — king shouldn't take enemy pieces in this game
      const chessBefore = new Chess(currentFen);
      const piece = chessBefore.get(move.to as 'a1');
      if (piece && piece.color === 'b') {
        // This was a capture — reject and reset
        setFeedback('blocked');
        kidSpeak('You cannot capture pieces in this game! Go around them.');
        feedbackTimeoutRef.current = setTimeout(() => {
          setFeedback(null);
          setBoardKey((prev) => prev + 1);
        }, 1200);
        return;
      }

      setMoveCount((prev) => prev + 1);

      // Check if king reached the goal
      if (move.to === level.goalSquare) {
        setLevelsWon((prev) => prev + 1);
        setPhase('success');
        kidSpeak('The king made it! Well done!');
        return;
      }

      // Continue: flip turn back to white and update board
      const chessAfter = new Chess(move.fen);
      let newFen = chessAfter.fen();
      const parts = newFen.split(' ');
      parts[1] = 'w';
      parts[3] = '-';
      newFen = parts.join(' ');

      setCurrentFen(newFen);
      setBoardKey((prev) => prev + 1);
    },
    [currentFen, level.goalSquare, kidSpeak],
  );

  const handleNextLevel = useCallback((): void => {
    if (levelIndex + 1 >= KING_MARCH_LEVELS.length) {
      setPhase('complete');
      kidSpeak(`Incredible! You completed all ${KING_MARCH_LEVELS.length} levels!`);
    } else {
      const nextLevel = KING_MARCH_LEVELS[levelIndex + 1];
      setLevelIndex((prev) => prev + 1);
      setCurrentFen(nextLevel.fen);
      setMoveCount(0);
      setBoardKey((prev) => prev + 1);
      setPhase('playing');
      kidSpeak(nextLevel.description);
    }
  }, [levelIndex, kidSpeak]);

  const handleBegin = useCallback((): void => {
    setCurrentFen(level.fen);
    setMoveCount(0);
    setPhase('playing');
    kidSpeak(level.description);
  }, [level, kidSpeak]);

  const handleRestart = useCallback((): void => {
    setCurrentFen(level.fen);
    setMoveCount(0);
    setBoardKey((prev) => prev + 1);
    kidSpeak('Starting over! Try again.');
  }, [level.fen, kidSpeak]);

  const handleBack = useCallback((): void => {
    voiceService.stop();
    void navigate('/kid');
  }, [navigate]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) voiceService.stop();
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }}
      data-testid="king-march-game"
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between p-4 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-bg)' }}
            data-testid="march-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold">King March</h2>
        </div>
        <button
          onClick={handleVoiceToggle}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="march-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <div className="flex-1 p-6">
        <AnimatePresence mode="wait">
          {/* Intro */}
          {phase === 'intro' && (
            <motion.div
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-6 text-center"
              data-testid="march-intro"
            >
              <span className="text-8xl">{'🏰'}</span>
              <h1 className="text-2xl font-bold">King March</h1>
              <p className="text-lg leading-relaxed max-w-md" style={{ color: 'var(--color-text-muted)' }}>
                Guide your king from e1 to e8 through a minefield of enemy attacks.
                The enemy pieces do not move — navigate around their danger zones!
              </p>
              <button
                onClick={handleBegin}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="march-begin-btn"
              >
                Begin!
              </button>
            </motion.div>
          )}

          {/* Playing */}
          {phase === 'playing' && (
            <motion.div
              key={`level-${levelIndex}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-5"
              data-testid="march-playing"
            >
              <h3 className="text-xl font-bold">
                Level {level.level} of {KING_MARCH_LEVELS.length}
              </h3>
              <p
                className="text-base text-center max-w-md"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {level.description}
              </p>

              <div className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
                Moves: {moveCount}
              </div>

              <div className="w-full md:max-w-[420px] mx-auto relative">
                <KidChessboard
                  key={boardKey}
                  initialFen={currentFen}
                  interactive={true}
                  onMove={handleMove}
                  annotationHighlights={annotationHighlights}
                />
                {/* Goal marker overlay on e8 */}
                <div
                  className="absolute pointer-events-none"
                  style={{
                    // e8 = file 4 (0-indexed), rank 0 from top (rank 8)
                    left: `${(4 / 8) * 100}%`,
                    top: '0%',
                    width: `${100 / 8}%`,
                    height: `${100 / 8}%`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.5rem',
                  }}
                  data-testid="march-goal-marker"
                >
                  {'👑'}
                </div>
              </div>

              {feedback === 'blocked' && (
                <div
                  className="px-4 py-2 rounded-lg font-bold text-center"
                  style={{ background: 'var(--color-error)', color: 'var(--color-bg)' }}
                  data-testid="march-feedback"
                >
                  Go around the pieces!
                </div>
              )}

              <button
                onClick={handleRestart}
                className="px-6 py-2 rounded-lg text-sm font-medium border"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-muted)',
                }}
                data-testid="march-restart-btn"
              >
                Restart Level
              </button>
            </motion.div>
          )}

          {/* Level success */}
          {phase === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="flex flex-col items-center gap-6 text-center"
              data-testid="march-success"
            >
              <span className="text-6xl">{'🎉'}</span>
              <h2 className="text-2xl font-bold">The King Made It!</h2>
              <p style={{ color: 'var(--color-text-muted)' }}>
                Level {level.level} complete in {moveCount} moves!
              </p>
              <button
                onClick={handleNextLevel}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="march-next-btn"
              >
                {levelIndex + 1 >= KING_MARCH_LEVELS.length ? 'Finish!' : 'Next Level'}
              </button>
            </motion.div>
          )}

          {/* Complete */}
          {phase === 'complete' && (
            <motion.div
              key="complete"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="flex flex-col items-center gap-6 text-center"
              data-testid="march-complete"
            >
              <h1 className="text-3xl font-bold">All Levels Complete!</h1>
              <StarDisplay earned={levelsWon} total={KING_MARCH_LEVELS.length} size="lg" />
              <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
                You marched the king through {levelsWon} level{levelsWon !== 1 ? 's' : ''}!
              </p>
              <button
                onClick={handleBack}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="march-done-btn"
              >
                Back to Games
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
