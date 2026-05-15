import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeX, Play, SkipForward } from 'lucide-react';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import { GUIDED_GAMES } from '../../data/guidedGames';
import type { GuidedMove } from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';

type GamePhase = 'intro' | 'playing' | 'complete';

const AUTO_PLAY_DELAY_MS = 1200;
const WRONG_MOVE_DISPLAY_MS = 1800;
const CELEBRATION_MESSAGES = [
  'Great move!',
  'Perfect!',
  'You got it!',
  'Excellent!',
  'Well done!',
];

export function GuidedGamePage(): JSX.Element {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();

  const game = GUIDED_GAMES.find((g) => g.id === gameId);

  const [phase, setPhase] = useState<GamePhase>('intro');
  const [moveIndex, setMoveIndex] = useState(-1);
  const [boardFen, setBoardFen] = useState(game?.startFen ?? 'start');
  const [boardKey, setBoardKey] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [wrongText, setWrongText] = useState('');
  const [starsEarned, setStarsEarned] = useState(0);
  const [celebrationText, setCelebrationText] = useState('');
  const [narrationText, setNarrationText] = useState('');
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [wrongAttempts, setWrongAttempts] = useState(0);

  const autoPlayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chessRef = useRef(new Chess(game?.startFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (autoPlayTimeoutRef.current) clearTimeout(autoPlayTimeoutRef.current);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      voiceService.stop();
    };
  }, []);

  const totalMilestones = game?.moves.filter((m) => m.isMilestone).length ?? 0;

  const kidSpeak = useCallback((text: string): void => {
    if (voiceOn) {
      void voiceService.speak(text);
    }
  }, [voiceOn]);

  const handleToggleVoice = useCallback((): void => {
    setVoiceOn((prev) => {
      if (prev) voiceService.stop();
      return !prev;
    });
  }, []);

  // Get the current move to play (next move after moveIndex)
  const currentMoveIdx = moveIndex + 1;
  const currentMove: GuidedMove | undefined = game?.moves[currentMoveIdx];
  const isPlayerTurn = currentMove ? !currentMove.autoPlay : false;

  // Get highlight arrows for hint display
  const getHintArrows = useCallback((): Array<{ startSquare: string; endSquare: string; color: string }> => {
    if (!currentMove || !isPlayerTurn || wrongAttempts < 1) return [];
    // After 1 wrong attempt, show a green arrow hint
    try {
      const chess = new Chess(boardFen);
      const result = chess.move(currentMove.san);
      return [{ startSquare: result.from, endSquare: result.to, color: 'rgba(34, 197, 94, 0.7)' }];
    } catch {
      // Position may not accept the move — no hint arrow
    }
    return [];
  }, [currentMove, isPlayerTurn, wrongAttempts, boardFen]);

  // Auto-play opponent moves
  const playAutoMove = useCallback((idx: number): void => {
    if (!game) return;
    const moves = game.moves;
    if (idx < 0 || idx >= moves.length) return;
    const move = moves[idx];

    setIsAutoPlaying(true);

    autoPlayTimeoutRef.current = setTimeout(() => {
      // Apply the move
      try {
        chessRef.current.move(move.san);
      } catch {
        // Position might be out of sync, reset
        chessRef.current = new Chess(move.fen);
      }

      setBoardFen(move.fen);
      setBoardKey((k) => k + 1);
      setMoveIndex(idx);
      setWrongAttempts(0);

      if (move.narration) {
        setNarrationText(move.narration);
        kidSpeak(move.narration);
      }

      if (move.isMilestone) {
        setStarsEarned((s) => s + 1);
      }

      setIsAutoPlaying(false);

      // Check if next move is also auto-play
      const nextIdx = idx + 1;
      if (nextIdx < moves.length && moves[nextIdx].autoPlay) {
        playAutoMove(nextIdx);
      }

      // Check if game is complete
      if (nextIdx >= moves.length) {
        autoPlayTimeoutRef.current = setTimeout(() => {
          setPhase('complete');
          kidSpeak(game.storyOutro);
          setNarrationText(game.storyOutro);
        }, 800);
      }
    }, AUTO_PLAY_DELAY_MS);
  }, [game, kidSpeak]);

  // Start the game
  const handleStartGame = useCallback((): void => {
    if (!game) return;
    setPhase('playing');
    chessRef.current = new Chess(game.startFen);
    setBoardFen(game.startFen);
    setBoardKey((k) => k + 1);
    setMoveIndex(-1);
    setStarsEarned(0);
    setWrongAttempts(0);

    // If first move is auto-play, play it
    if (game.moves[0]?.autoPlay) {
      const firstNarration = game.moves[0].narration;
      if (firstNarration) {
        setNarrationText(firstNarration);
        kidSpeak(firstNarration);
      }
      playAutoMove(0);
    } else {
      const firstNarration = game.moves[0]?.narration;
      if (firstNarration) {
        setNarrationText(firstNarration);
        kidSpeak(firstNarration);
      }
    }
  }, [game, kidSpeak, playAutoMove]);

  // Handle player move
  const handlePlayerMove = useCallback((moveResult: MoveResult): void => {
    if (!game || !currentMove || currentMove.autoPlay || isAutoPlaying) return;

    const expectedSan = currentMove.san;
    const playerSan = moveResult.san;

    // Normalize: strip + and # for comparison, then compare
    const normalize = (s: string): string => s.replace(/[+#]/g, '');
    const isCorrect = normalize(playerSan) === normalize(expectedSan);

    if (isCorrect) {
      // Correct move!
      setFeedback('correct');
      const celebration = CELEBRATION_MESSAGES[Math.floor(Math.random() * CELEBRATION_MESSAGES.length)];
      setCelebrationText(celebration);
      setWrongAttempts(0);

      // Update board state
      try {
        chessRef.current = new Chess(currentMove.fen);
      } catch {
        // fallback
      }
      setBoardFen(currentMove.fen);
      setMoveIndex(currentMoveIdx);

      if (currentMove.isMilestone) {
        setStarsEarned((s) => s + 1);
        kidSpeak(`${celebration} You earned a star!`);
      } else {
        kidSpeak(celebration);
      }

      feedbackTimeoutRef.current = setTimeout(() => {
        setFeedback(null);
        setCelebrationText('');

        // Show narration for the move just played if it has one
        if (currentMove.narration) {
          setNarrationText(currentMove.narration);
        }

        // Check if game complete
        const nextIdx = currentMoveIdx + 1;
        if (nextIdx >= game.moves.length) {
          autoPlayTimeoutRef.current = setTimeout(() => {
            setPhase('complete');
            kidSpeak(game.storyOutro);
            setNarrationText(game.storyOutro);
          }, 600);
          return;
        }

        // If next move is auto-play, play it
        if (game.moves[nextIdx].autoPlay) {
          playAutoMove(nextIdx);
        } else if (game.moves[nextIdx].narration) {
          setNarrationText(game.moves[nextIdx].narration);
          kidSpeak(game.moves[nextIdx].narration);
        }
      }, 1000);
    } else {
      // Wrong move
      setFeedback('wrong');
      setWrongAttempts((w) => w + 1);
      const responseText = currentMove.wrongMoveResponse ?? 'Not quite — try again!';
      setWrongText(responseText);
      kidSpeak(responseText);

      // Reset the board to before this move
      setBoardKey((k) => k + 1);

      feedbackTimeoutRef.current = setTimeout(() => {
        setFeedback(null);
        setWrongText('');
      }, WRONG_MOVE_DISPLAY_MS);
    }
  }, [game, currentMove, currentMoveIdx, isAutoPlaying, kidSpeak, playAutoMove]);

  // Handle replay
  const handleReplay = useCallback((): void => {
    if (!game) return;
    setPhase('intro');
    setMoveIndex(-1);
    setBoardFen(game.startFen);
    setBoardKey((k) => k + 1);
    setStarsEarned(0);
    setFeedback(null);
    setNarrationText('');
    setWrongAttempts(0);
  }, [game]);

  if (!game) {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <p className="text-lg font-bold">Game not found</p>
        <button
          onClick={() => void navigate('/kid/play-games')}
          className="px-4 py-2 rounded-lg font-bold"
          style={{ background: 'var(--color-accent)', color: 'white' }}
        >
          Back to Games
        </button>
      </div>
    );
  }

  const boardOrientation = game.playerColor === 'w' ? 'white' : 'black';
  const progressPercent = game.moves.length > 0
    ? Math.round(((moveIndex + 1) / game.moves.length) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-4 p-4 max-w-lg mx-auto" data-testid="guided-game-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { voiceService.stop(); void navigate('/kid/play-games'); }}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="guided-game-back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold truncate">{game.title}</h2>
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
          data-testid="guided-game-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* ─── Intro Phase ──────────────────────────────────────────────── */}
      {phase === 'intro' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-5"
        >
          <div className="text-6xl">{game.difficulty === 1 ? '🌱' : game.difficulty === 2 ? '⭐' : '🏆'}</div>
          <h3 className="text-2xl font-bold text-center">{game.title}</h3>
          <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
            {game.description}
          </p>
          <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            <span>~{game.estimatedMinutes} min</span>
            <span>You play as {game.playerColor === 'w' ? 'White' : 'Black'}</span>
          </div>

          <div
            className="rounded-2xl p-5 border-2 text-center max-w-sm"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.1)',
            }}
          >
            <p className="text-base leading-relaxed">{game.storyIntro}</p>
          </div>

          <button
            onClick={handleStartGame}
            className="px-8 py-3 rounded-xl font-bold text-lg flex items-center gap-2 hover:opacity-90 transition-opacity"
            style={{ background: 'var(--color-accent)', color: 'white' }}
            data-testid="guided-game-start"
          >
            <Play size={20} fill="white" />
            Play!
          </button>
        </motion.div>
      )}

      {/* ─── Playing Phase ────────────────────────────────────────────── */}
      {phase === 'playing' && (
        <>
          {/* Progress bar */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'var(--color-secondary)' }}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: 'var(--color-accent)' }}
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 0.4 }}
              />
            </div>
            <span className="text-sm font-medium whitespace-nowrap" style={{ color: 'var(--color-text-muted)' }}>
              {moveIndex + 1}/{game.moves.length}
            </span>
            <StarDisplay earned={starsEarned} total={totalMilestones} size="sm" />
          </div>

          {/* Narration box */}
          <AnimatePresence mode="wait">
            {narrationText && (
              <motion.div
                key={narrationText}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="rounded-xl p-4 border-2 text-center"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-accent)',
                  boxShadow: '0 2px 12px rgba(0, 0, 0, 0.08)',
                }}
                data-testid="guided-game-narration"
              >
                <p className="text-sm leading-relaxed font-medium">{narrationText}</p>
                {currentMove?.teachingConcept && (
                  <span
                    className="inline-block mt-2 px-3 py-1 rounded-full text-xs font-bold"
                    style={{ background: 'var(--color-accent)', color: 'white' }}
                  >
                    {currentMove.teachingConcept}
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Feedback overlays */}
          <AnimatePresence>
            {feedback === 'correct' && (
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                className="text-center text-2xl font-bold"
                style={{ color: 'var(--color-accent)' }}
                data-testid="guided-game-correct"
              >
                {celebrationText}
              </motion.div>
            )}
            {feedback === 'wrong' && (
              <motion.div
                initial={{ x: -10 }}
                animate={{ x: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-xl p-3 text-center text-sm font-medium"
                style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fca5a5' }}
                data-testid="guided-game-wrong"
              >
                {wrongText}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chess board */}
          <div className="w-full md:max-w-[420px] mx-auto">
            <KidChessboard
              key={boardKey}
              initialFen={boardFen}
              orientation={boardOrientation}
              interactive={isPlayerTurn && !isAutoPlaying && feedback !== 'correct'}
              onMove={handlePlayerMove}
              arrows={getHintArrows()}
              annotationHighlights={
                currentMove?.highlightSquares?.map((sq) => ({
                  square: sq,
                  color: 'rgba(245, 158, 11, 0.4)',
                })) ?? []
              }
            />
          </div>

          {/* Turn indicator */}
          <div className="text-center text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>
            {isAutoPlaying ? (
              <span className="flex items-center justify-center gap-2">
                <SkipForward size={14} className="animate-pulse" />
                Opponent is moving...
              </span>
            ) : isPlayerTurn ? (
              'Your turn — make a move!'
            ) : (
              'Watch and learn!'
            )}
          </div>
        </>
      )}

      {/* ─── Complete Phase ───────────────────────────────────────────── */}
      {phase === 'complete' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-5 py-4"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.2 }}
            className="text-7xl"
          >
            🎉
          </motion.div>
          <h3 className="text-2xl font-bold text-center">Game Complete!</h3>

          <StarDisplay earned={starsEarned} total={totalMilestones} size="lg" />

          <div
            className="rounded-2xl p-5 border-2 text-center max-w-sm"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.1)',
            }}
          >
            <p className="text-base leading-relaxed">{game.storyOutro}</p>
          </div>

          <div className="flex gap-3 mt-2">
            <button
              onClick={handleReplay}
              className="px-6 py-3 rounded-xl font-bold border-2 hover:opacity-80 transition-opacity"
              style={{ borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }}
              data-testid="guided-game-replay"
            >
              Play Again
            </button>
            <button
              onClick={() => void navigate('/kid/play-games')}
              className="px-6 py-3 rounded-xl font-bold hover:opacity-90 transition-opacity"
              style={{ background: 'var(--color-accent)', color: 'white' }}
              data-testid="guided-game-next"
            >
              More Games
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
