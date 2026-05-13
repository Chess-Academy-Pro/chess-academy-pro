import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Play,
  Pause,
  SkipForward,
  CheckCircle,
  XCircle,
  RotateCcw,
  ArrowLeft,
} from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { usePieceSound } from '../../hooks/usePieceSound';
import { useBoardGlow } from '../../hooks/useBoardGlow';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { BOARD_DEMO_ANIMATION_MS } from '../../hooks/useBoardTheme';
import type { PlayableMiddlegameLine, AnnotationArrow } from '../../types';
import type { PieceDropHandlerArgs, SquareHandlerArgs } from 'react-chessboard';

interface PlayableLinePlayerProps {
  line: PlayableMiddlegameLine;
  boardOrientation: 'white' | 'black';
  onComplete: () => void;
  onExit: () => void;
}

type Phase = 'demo' | 'memory';

function arrowsToBoard(
  arrows: AnnotationArrow[] | undefined,
): Array<{ startSquare: string; endSquare: string; color: string }> {
  if (!arrows || arrows.length === 0) return [];
  return arrows.map((a) => ({
    startSquare: a.from,
    endSquare: a.to,
    color: a.color ?? 'rgba(0, 128, 0, 0.8)',
  }));
}

export function PlayableLinePlayer({
  line,
  boardOrientation,
  onComplete,
  onExit,
}: PlayableLinePlayerProps): JSX.Element {
  const { playMoveSound, playCelebration, playEncouragement } = usePieceSound();

  // Phase state
  const [phase, setPhase] = useState<Phase>('demo');

  // Demonstration phase state
  const [demoMoveIndex, setDemoMoveIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(true);
  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Memory phase state
  const [memoryMoveIndex, setMemoryMoveIndex] = useState(0);
  const [showCorrectFlash, setShowCorrectFlash] = useState(false);
  const [showWrongFlash, setShowWrongFlash] = useState(false);
  const [shakeBoard, setShakeBoard] = useState(false);
  const [memoryComplete, setMemoryComplete] = useState(false);

  // Chess instance for memory phase move validation + position tracking
  const chessRef = useRef<Chess>(new Chess(line.fen));
  const [memoryFen, setMemoryFen] = useState(line.fen);

  // Selected square + legal moves for click-to-move in memory phase
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);

  // Compute demonstration FEN at a given move index
  const demoFenAtIndex = useCallback(
    (idx: number): string => {
      const chess = new Chess(line.fen);
      for (let i = 0; i <= idx && i < line.moves.length; i++) {
        try {
          chess.move(line.moves[i]);
        } catch {
          break;
        }
      }
      return chess.fen();
    },
    [line.fen, line.moves],
  );

  const demoFen = useMemo((): string => {
    if (demoMoveIndex < 0) return line.fen;
    return demoFenAtIndex(demoMoveIndex);
  }, [demoMoveIndex, demoFenAtIndex, line.fen]);

  const currentDemoArrows = useMemo((): Array<{ startSquare: string; endSquare: string; color: string }> => {
    if (demoMoveIndex < 0 || demoMoveIndex >= line.arrows.length) return [];
    return arrowsToBoard(line.arrows[demoMoveIndex]);
  }, [demoMoveIndex, line.arrows]);

  const currentAnnotation = useMemo((): string => {
    if (phase === 'demo') {
      if (demoMoveIndex < 0 || demoMoveIndex >= line.annotations.length) return '';
      return line.annotations[demoMoveIndex];
    }
    return '';
  }, [phase, demoMoveIndex, line.annotations]);

  // Pre-warm voice service + prefetch audio for all annotations
  useEffect(() => {
    void voiceService.warmup();
    if (line.annotations.length > 0) {
      void voiceService.prefetchAudio(line.annotations);
    }
  }, [line.annotations]);

  // ─── Demonstration Phase: Auto-play logic ────────────────────────────────

  useEffect(() => {
    if (phase !== 'demo') return;
    if (!isPlaying) return;

    const delay = demoMoveIndex < 0 ? 1000 : 2000;

    autoPlayTimerRef.current = setTimeout(() => {
      const nextIndex = demoMoveIndex + 1;
      if (nextIndex >= line.moves.length) {
        // Demo complete, stop
        setIsPlaying(false);
        return;
      }
      setDemoMoveIndex(nextIndex);
    }, delay);

    return () => {
      if (autoPlayTimerRef.current !== null) {
        clearTimeout(autoPlayTimerRef.current);
        autoPlayTimerRef.current = null;
      }
    };
  }, [phase, isPlaying, demoMoveIndex, line.moves.length]);

  // Voice narration for demo moves
  useEffect(() => {
    if (phase !== 'demo') return;
    if (demoMoveIndex < 0) return;
    if (demoMoveIndex >= line.annotations.length) return;

    const annotation = line.annotations[demoMoveIndex];
    if (annotation) {
      void voiceService.speak(annotation);
    }
  }, [phase, demoMoveIndex, line.annotations]);

  // Play piece sound during demo
  useEffect(() => {
    if (phase !== 'demo') return;
    if (demoMoveIndex < 0 || demoMoveIndex >= line.moves.length) return;
    playMoveSound(line.moves[demoMoveIndex]);
  }, [phase, demoMoveIndex, line.moves, playMoveSound]);

  const togglePlayPause = useCallback((): void => {
    setIsPlaying((prev) => !prev);
  }, []);

  const skipToMemory = useCallback((): void => {
    voiceService.stop();
    if (autoPlayTimerRef.current !== null) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
    setIsPlaying(false);
    setPhase('memory');
    // Reset board to starting position
    chessRef.current = new Chess(line.fen);
    setMemoryFen(line.fen);
    setMemoryMoveIndex(0);
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [line.fen]);

  // ─── Memory Phase: Move handling ─────────────────────────────────────────

  // Parse expected moves into from/to/san
  const expectedMoves = useMemo((): Array<{ from: string; to: string; san: string }> => {
    const chess = new Chess(line.fen);
    const result: Array<{ from: string; to: string; san: string }> = [];
    for (const san of line.moves) {
      try {
        const move = chess.move(san);
        result.push({ from: move.from, to: move.to, san: move.san });
      } catch {
        break;
      }
    }
    return result;
  }, [line.fen, line.moves]);

  const clearSelection = useCallback((): void => {
    setSelectedSquare(null);
    setLegalMoves([]);
  }, []);

  const handleMemoryMoveResult = useCallback(
    (from: string, to: string): void => {
      if (phase !== 'memory') return;
      if (memoryMoveIndex >= expectedMoves.length) return;
      if (showWrongFlash || showCorrectFlash) return;

      const expected = expectedMoves[memoryMoveIndex];

      if (from === expected.from && to === expected.to) {
        // Correct move - apply it to chess instance
        try {
          const moveResult = chessRef.current.move({ from: from as Square, to: to as Square, promotion: 'q' });
          setMemoryFen(chessRef.current.fen());
          playMoveSound(moveResult.san);
        } catch {
          // Fallback: try with expected SAN
          try {
            chessRef.current.move(expected.san);
            setMemoryFen(chessRef.current.fen());
            playMoveSound(expected.san);
          } catch {
            return;
          }
        }

        setShowCorrectFlash(true);
        clearSelection();

        const nextIndex = memoryMoveIndex + 1;

        setTimeout(() => {
          setShowCorrectFlash(false);

          if (nextIndex >= expectedMoves.length) {
            // All moves completed
            setMemoryMoveIndex(nextIndex);
            setMemoryComplete(true);
            playCelebration();
            void voiceService.speak('Excellent! You remembered the entire line.');
            onComplete();
            return;
          }

          setMemoryMoveIndex(nextIndex);
        }, 400);
      } else {
        // Wrong move - do not apply to chess, show error
        setShowWrongFlash(true);
        setShakeBoard(true);
        playEncouragement();
        clearSelection();

        setTimeout(() => {
          setShowWrongFlash(false);
          setShakeBoard(false);
        }, 1200);
      }
    },
    [phase, memoryMoveIndex, expectedMoves, showWrongFlash, showCorrectFlash, playMoveSound, playCelebration, playEncouragement, clearSelection, onComplete],
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (phase !== 'memory' || !targetSquare) {
        clearSelection();
        return false;
      }
      handleMemoryMoveResult(sourceSquare, targetSquare);
      return false; // We manage position ourselves
    },
    [phase, handleMemoryMoveResult, clearSelection],
  );

  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (phase !== 'memory') return;
      if (showWrongFlash || showCorrectFlash) return;

      // Clicking selected square deselects
      if (selectedSquare === square) {
        clearSelection();
        return;
      }

      // If a legal move destination is clicked, execute
      if (selectedSquare !== null && legalMoves.includes(square)) {
        handleMemoryMoveResult(selectedSquare, square);
        return;
      }

      // Select a new square
      const moves = chessRef.current.moves({ square: square as Square, verbose: true });
      const destinations = [...new Set(moves.map((m) => m.to))];
      if (destinations.length > 0) {
        setSelectedSquare(square);
        setLegalMoves(destinations);
      } else {
        clearSelection();
      }
    },
    [phase, selectedSquare, legalMoves, showWrongFlash, showCorrectFlash, handleMemoryMoveResult, clearSelection],
  );

  // Board square overlays for memory phase selection / legal-move hints.
  // The base glow is applied automatically by ConsistentChessboard — we only
  // contribute the selection and legal-move highlights here.
  const { mergeGlow } = useBoardGlow();
  const memorySquareStyles = useMemo((): Record<string, React.CSSProperties> => {
    if (phase !== 'memory') return {};
    const styles: Record<string, React.CSSProperties> = {};

    if (selectedSquare) {
      styles[selectedSquare] = {
        background: 'rgba(0, 229, 255, 0.35)',
        boxShadow: mergeGlow('inset 0 0 8px rgba(0, 229, 255, 0.4)'),
      };
    }

    for (const sq of legalMoves) {
      const piece = chessRef.current.get(sq as Square);
      styles[sq] = piece
        ? {
            background:
              'radial-gradient(circle, rgba(0,0,0,0) 60%, rgba(0, 229, 255, 0.3) 60%, rgba(0, 229, 255, 0.3) 80%, rgba(0,0,0,0) 80%)',
            cursor: 'pointer',
          }
        : {
            background: 'radial-gradient(circle, rgba(0, 229, 255, 0.3) 25%, transparent 25%)',
            cursor: 'pointer',
          };
    }

    return styles;
  }, [phase, selectedSquare, legalMoves, mergeGlow]);

  const handleRetryMemory = useCallback((): void => {
    chessRef.current = new Chess(line.fen);
    setMemoryFen(line.fen);
    setMemoryMoveIndex(0);
    setShowCorrectFlash(false);
    setShowWrongFlash(false);
    setShakeBoard(false);
    setMemoryComplete(false);
    clearSelection();
    voiceService.stop();
  }, [line.fen, clearSelection]);

  const handleReplayDemo = useCallback((): void => {
    voiceService.stop();
    setPhase('demo');
    setDemoMoveIndex(-1);
    setIsPlaying(true);
    setMemoryComplete(false);
  }, []);

  const memoryProgress = expectedMoves.length > 0
    ? Math.round((memoryMoveIndex / expectedMoves.length) * 100)
    : 0;

  // ─── Memory Complete Screen ──────────────────────────────────────────────

  if (memoryComplete) {
    return (
      <div className="flex flex-col flex-1 p-4 items-center justify-center" data-testid="line-player-complete">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/20 mb-4">
              <CheckCircle size={32} className="text-green-500" />
            </div>
            <h2 className="text-xl font-bold text-theme-text">Line Mastered!</h2>
            <p className="text-sm text-theme-text-muted mt-1">{line.title}</p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleRetryMemory}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold hover:opacity-90 transition-opacity"
              data-testid="line-retry"
            >
              <RotateCcw size={16} />
              Again
            </button>
            <button
              onClick={onExit}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-surface border border-theme-border text-theme-text font-semibold hover:bg-theme-border transition-colors"
              data-testid="line-exit"
            >
              <ArrowLeft size={16} />
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Demonstration Phase Render ──────────────────────────────────────────

  if (phase === 'demo') {
    return (
      <div className="flex flex-col flex-1 overflow-hidden" data-testid="line-player-demo">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
          <div className="flex items-center gap-3">
            <button
              onClick={onExit}
              className="p-1.5 rounded-lg hover:bg-theme-surface"
              data-testid="line-player-back"
            >
              <ArrowLeft size={16} className="text-theme-text" />
            </button>
            <div>
              <p className="text-sm font-semibold text-theme-text">{line.title}</p>
              <p className="text-xs text-theme-text-muted">Watch &amp; Learn</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={togglePlayPause}
              className="p-2 rounded-lg bg-theme-surface hover:bg-theme-border transition-colors"
              aria-label={isPlaying ? 'Pause' : 'Play'}
              data-testid="demo-play-pause"
            >
              {isPlaying ? (
                <Pause size={16} className="text-theme-text" />
              ) : (
                <Play size={16} className="text-theme-text" />
              )}
            </button>
            <button
              onClick={skipToMemory}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-accent text-white text-xs font-medium hover:opacity-90 transition-opacity"
              data-testid="skip-to-memory"
            >
              <SkipForward size={14} />
              Practice
            </button>
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-4 pt-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-theme-text-muted uppercase font-medium">
              Move {Math.max(0, demoMoveIndex + 1)} / {line.moves.length}
            </span>
          </div>
          <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-theme-accent rounded-full"
              animate={{ width: `${line.moves.length > 0 ? Math.round(((demoMoveIndex + 1) / line.moves.length) * 100) : 0}%` }}
              transition={{ duration: 0.3 }}
              data-testid="demo-progress"
            />
          </div>
        </div>

        {/* Board */}
        <div className="flex-1 flex flex-col items-center justify-start pt-2 px-2 py-2">
          <div className="w-full md:max-w-[420px]">
            <ConsistentChessboard
              fen={demoFen}
              boardOrientation={boardOrientation}
              arrows={currentDemoArrows}
              animationDurationInMs={BOARD_DEMO_ANIMATION_MS}
              enableMoveSound={false}
            />
          </div>
        </div>

        {/* Annotation text */}
        <div className="px-4 pb-4 min-h-[60px]">
          <AnimatePresence mode="wait">
            {currentAnnotation && (
              <motion.div
                key={demoMoveIndex}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl bg-theme-surface/90 border border-white/15 p-3"
                data-testid="demo-annotation"
              >
                <p className="text-sm text-theme-text leading-relaxed">{currentAnnotation}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  // ─── Memory Phase Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 overflow-hidden" data-testid="line-player-memory">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
        <div className="flex items-center gap-3">
          <button
            onClick={onExit}
            className="p-1.5 rounded-lg hover:bg-theme-surface"
            data-testid="line-player-back"
          >
            <ArrowLeft size={16} className="text-theme-text" />
          </button>
          <div>
            <p className="text-sm font-semibold text-theme-text">{line.title}</p>
            <p className="text-xs text-theme-text-muted">Your Turn — Replay from Memory</p>
          </div>
        </div>
        <button
          onClick={handleReplayDemo}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-surface hover:bg-theme-border text-theme-text-muted text-xs font-medium transition-colors"
          data-testid="replay-demo"
        >
          <RotateCcw size={14} />
          Watch Again
        </button>
      </div>

      {/* Progress bar */}
      <div className="px-4 pt-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-theme-text-muted uppercase font-medium">
            Move {memoryMoveIndex} / {expectedMoves.length}
          </span>
        </div>
        <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-green-500 rounded-full"
            animate={{ width: `${memoryProgress}%` }}
            transition={{ duration: 0.3 }}
            data-testid="memory-progress"
          />
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 flex flex-col items-center justify-start pt-2 px-2 py-2">
        <div className="w-full md:max-w-[420px]">
          <ConsistentChessboard
            fen={memoryFen}
            boardOrientation={boardOrientation}
            interactive={!showWrongFlash && !showCorrectFlash}
            squareStyles={memorySquareStyles}
            onPieceDrop={handlePieceDrop}
            onSquareClick={handleSquareClick}
            enableMoveSound={false}
            className={shakeBoard ? 'animate-[boardFlashError_400ms]' : ''}
            overlay={
              <>
                <AnimatePresence>
                  {showCorrectFlash && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="absolute inset-0 flex items-center justify-center pointer-events-none"
                      data-testid="correct-flash"
                    >
                      <div className="w-12 h-12 rounded-full bg-green-500/30 flex items-center justify-center">
                        <CheckCircle size={28} className="text-green-500" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {showWrongFlash && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="absolute inset-0 flex items-center justify-center pointer-events-none"
                      data-testid="wrong-flash"
                    >
                      <div className="w-12 h-12 rounded-full bg-red-500/30 flex items-center justify-center">
                        <XCircle size={28} className="text-red-500" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            }
          />
        </div>
      </div>

      {/* Bottom hint area */}
      <div className="px-4 pb-4 min-h-[60px]">
        {showWrongFlash && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-red-500/10 border border-red-500/30 p-3"
            data-testid="wrong-hint"
          >
            <p className="text-sm text-red-400 font-medium">
              Not quite — try to remember the correct move.
            </p>
          </motion.div>
        )}
        {!showWrongFlash && !showCorrectFlash && memoryMoveIndex < expectedMoves.length && (
          <div className="rounded-2xl bg-theme-surface/90 border border-white/15 p-3">
            <p className="text-sm text-theme-text-muted">
              Play move {memoryMoveIndex + 1} of {expectedMoves.length} from memory.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
