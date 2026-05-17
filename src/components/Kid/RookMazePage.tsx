import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { BoardVoiceOverlay } from '../Board/BoardVoiceOverlay';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import {
  buildFen,
  buildMazePieceMap,
  getRookLegalMoves,
  calculateStars,
  completeMazeLevel,
} from '../../services/rookGameService';
import { ROOK_MAZE_LEVELS } from '../../data/rookMazeLevels';
import type { SquareHandlerArgs } from 'react-chessboard';

type GamePhase = 'playing' | 'won';

interface MoveHistoryEntry {
  rookPos: string;
}

export function RookMazePage(): JSX.Element {
  const { level: levelParam } = useParams<{ level: string }>();
  const navigate = useNavigate();
  const levelId = parseInt(levelParam ?? '1', 10);
  const level = ROOK_MAZE_LEVELS.find((l) => l.id === levelId);

  const [rookPos, setRookPos] = useState(level?.rookStart ?? 'a1');
  const [moveCount, setMoveCount] = useState(0);
  const [phase, setPhase] = useState<GamePhase>('playing');
  const [voiceOn, setVoiceOn] = useState(true);
  const [history, setHistory] = useState<MoveHistoryEntry[]>([]);
  const hasSpoken = useRef(false);


  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  // Welcome speech
  useEffect(() => {
    if (!hasSpoken.current && level) {
      hasSpoken.current = true;
      kidSpeak(`Rook Maze: ${level.name}! Guide the rook to the treasure square!`);
    }
  }, [level, kidSpeak]);

  // Navigate away if level not found
  useEffect(() => {
    if (!level) {
      void navigate('/kid/rook-games');
    }
  }, [level, navigate]);

  // Compute blocked set (obstacles)
  const blockedSet = useMemo(
    () => new Set(level?.obstacles ?? []),
    [level?.obstacles],
  );

  // Compute legal moves for current rook position
  const legalMoves = useMemo(
    () => (phase === 'playing' ? getRookLegalMoves(rookPos, blockedSet) : []),
    [rookPos, blockedSet, phase],
  );

  const legalMoveSet = useMemo(() => new Set(legalMoves), [legalMoves]);

  // Build the FEN position
  const fen = useMemo(() => {
    if (!level) return '8/8/8/8/8/8/8/8 w - - 0 1';
    return buildFen(buildMazePieceMap(rookPos, level.obstacles));
  }, [rookPos, level]);

  // Build square styles
  const squareStyles = useMemo((): Record<string, React.CSSProperties> => {
    if (!level) return {};
    const styles: Record<string, React.CSSProperties> = {};

    // Target square glow
    if (level.highlightTarget) {
      styles[level.target] = {
        background: 'radial-gradient(circle, rgba(34,197,94,0.7) 40%, rgba(34,197,94,0.3) 100%)',
        boxShadow: 'inset 0 0 12px 4px rgba(34,197,94,0.5)',
      };
    }

    // Legal move highlights
    if (level.highlightLegalMoves && phase === 'playing') {
      for (const sq of legalMoves) {
        if (sq === level.target && level.highlightTarget) continue;
        styles[sq] = {
          background: 'radial-gradient(circle, rgba(59,130,246,0.25) 25%, transparent 25%)',
          cursor: 'pointer',
        };
      }
    }

    // Rook highlight (selected)
    if (phase === 'playing') {
      styles[rookPos] = {
        ...styles[rookPos],
        background: 'rgba(255, 255, 0, 0.5)',
      };
    }

    return styles;
  }, [level, legalMoves, rookPos, phase]);

  // Handle square click
  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (phase !== 'playing' || !level) return;

      if (!legalMoveSet.has(square)) return;

      // Save history for undo
      setHistory((prev) => [...prev, { rookPos }]);
      setRookPos(square);
      setMoveCount((prev) => prev + 1);

      // Check win
      if (square === level.target) {
        const totalMoves = moveCount + 1;
        setPhase('won');
        void completeMazeLevel(level.id, totalMoves, level.par);
        const stars = calculateStars(totalMoves, level.par);
        if (stars === 3) {
          kidSpeak('Amazing! Perfect score!');
        } else if (stars === 2) {
          kidSpeak('Great job! You made it!');
        } else {
          kidSpeak('You made it! Try again for fewer moves.');
        }
      }
    },
    [phase, level, legalMoveSet, rookPos, moveCount, kidSpeak],
  );

  // Undo last move
  const handleUndo = useCallback((): void => {
    if (history.length === 0 || phase !== 'playing') return;
    const prev = history[history.length - 1];
    setRookPos(prev.rookPos);
    setMoveCount((m) => m - 1);
    setHistory((h) => h.slice(0, -1));
  }, [history, phase]);

  // Reset level
  const handleReset = useCallback((): void => {
    if (!level) return;
    setRookPos(level.rookStart);
    setMoveCount(0);
    setPhase('playing');
    setHistory([]);
  }, [level]);

  const handleBack = useCallback((): void => {
    void navigate('/kid/rook-games');
  }, [navigate]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) voiceService.stop();
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  if (!level) return <div />;

  const stars = phase === 'won' ? calculateStars(moveCount, level.par) : 0;

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }}
      data-testid="rook-maze-page"
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
            data-testid="maze-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold">Rook Maze: {level.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleVoiceToggle}
            className="p-2 rounded-lg border transition-colors"
            style={{
              background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
            }}
            aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
            data-testid="maze-voice-toggle"
          >
            {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
      </div>

      {/* Game area */}
      <div className="flex-1 p-4 flex flex-col items-center gap-4">
        {/* Move counter */}
        <div
          className="flex items-center gap-4 text-sm font-medium"
          data-testid="maze-move-counter"
        >
          <span>Moves: {moveCount}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>Par: {level.par}</span>
        </div>

        {/* Board */}
        <BoardVoiceOverlay fen={fen} className="w-full md:max-w-[420px] mx-auto">
          <ConsistentChessboard
            fen={fen}
            boardOrientation="white"
            squareStyles={squareStyles}
            onSquareClick={handleSquareClick}
          />
        </BoardVoiceOverlay>

        {/* Controls */}
        {phase === 'playing' && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleUndo}
              disabled={history.length === 0}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-opacity"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                opacity: history.length === 0 ? 0.4 : 1,
              }}
              data-testid="maze-undo-btn"
            >
              <RotateCcw size={14} />
              Undo
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
              }}
              data-testid="maze-reset-btn"
            >
              Reset
            </button>
          </div>
        )}

        {/* Win screen */}
        <AnimatePresence>
          {phase === 'won' && (
            <motion.div
              key="win"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="flex flex-col items-center gap-4 text-center mt-4"
              data-testid="maze-win-screen"
            >
              <h2 className="text-2xl font-bold">Maze Complete!</h2>
              <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
                {moveCount} moves (par: {level.par})
              </p>
              <StarDisplay earned={stars} total={3} size="lg" />
              <div className="flex gap-3 mt-2">
                <button
                  onClick={handleReset}
                  className="px-6 py-2 rounded-xl font-bold border"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: 'var(--color-border)',
                  }}
                  data-testid="maze-retry-btn"
                >
                  Try Again
                </button>
                <button
                  onClick={handleBack}
                  className="px-6 py-2 rounded-xl font-bold"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                  data-testid="maze-continue-btn"
                >
                  Continue
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
