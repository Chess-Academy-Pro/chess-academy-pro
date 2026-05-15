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
  buildClearerPieceMap,
  getRookLegalMoves,
  isAlignedWithAny,
  calculateStars,
  completeClearerLevel,
} from '../../services/rookGameService';
import { ROW_CLEARER_LEVELS } from '../../data/rowClearerLevels';
import type { SquareHandlerArgs } from 'react-chessboard';

type GamePhase = 'playing' | 'won';

interface GameSnapshot {
  rooks: string[];
  enemies: string[];
  selectedRook: string | null;
}

export function RowClearerPage(): JSX.Element {
  const { level: levelParam } = useParams<{ level: string }>();
  const navigate = useNavigate();
  const levelId = parseInt(levelParam ?? '1', 10);
  const level = ROW_CLEARER_LEVELS.find((l) => l.id === levelId);

  const [rooks, setRooks] = useState<string[]>(level?.rooks ?? ['a1']);
  const [enemies, setEnemies] = useState<string[]>(level?.enemies ?? []);
  const [selectedRook, setSelectedRook] = useState<string | null>(
    level && level.rooks.length === 1 ? level.rooks[0] : null,
  );
  const [moveCount, setMoveCount] = useState(0);
  const [phase, setPhase] = useState<GamePhase>('playing');
  const [voiceOn, setVoiceOn] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [history, setHistory] = useState<GameSnapshot[]>([]);
  const hasSpoken = useRef(false);
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);


  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  // Cleanup
  useEffect(() => {
    return () => {
      if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);
    };
  }, []);

  // Welcome speech
  useEffect(() => {
    if (!hasSpoken.current && level) {
      hasSpoken.current = true;
      kidSpeak(`Row Clearer: ${level.name}! Capture all the pawns!`);
    }
  }, [level, kidSpeak]);

  // Navigate away if level not found
  useEffect(() => {
    if (!level) {
      void navigate('/kid/rook-games');
    }
  }, [level, navigate]);

  const rookSet = useMemo(() => new Set(rooks), [rooks]);
  const enemySet = useMemo(() => new Set(enemies), [enemies]);

  // Blocked squares = other rooks (can't move through your own pieces)
  const blockedForRook = useCallback(
    (rookPos: string): Set<string> => {
      const blocked = new Set<string>();
      for (const r of rooks) {
        if (r !== rookPos) blocked.add(r);
      }
      return blocked;
    },
    [rooks],
  );

  // Legal moves for the selected rook
  const legalMoves = useMemo(() => {
    if (!selectedRook || phase !== 'playing') return [];
    return getRookLegalMoves(selectedRook, blockedForRook(selectedRook), enemySet);
  }, [selectedRook, blockedForRook, enemySet, phase]);

  const legalMoveSet = useMemo(() => new Set(legalMoves), [legalMoves]);

  // Build FEN
  const fen = useMemo(
    () => buildFen(buildClearerPieceMap(rooks, enemies)),
    [rooks, enemies],
  );

  // Square styles
  const squareStyles = useMemo((): Record<string, React.CSSProperties> => {
    if (!level) return {};
    const styles: Record<string, React.CSSProperties> = {};

    // Highlight capturable pieces
    if (level.highlightCaptures && phase === 'playing') {
      for (const enemy of enemies) {
        styles[enemy] = {
          boxShadow: 'inset 0 0 10px 3px rgba(239,68,68,0.6)',
        };
      }
    }

    // Selected rook highlight
    if (selectedRook && phase === 'playing') {
      styles[selectedRook] = {
        ...styles[selectedRook],
        background: 'rgba(255, 255, 0, 0.5)',
      };
    }

    // Legal move dots
    if (level.highlightLegalMoves && selectedRook && phase === 'playing') {
      for (const sq of legalMoves) {
        const isCapture = enemySet.has(sq);
        if (isCapture) {
          styles[sq] = {
            ...styles[sq],
            background:
              'radial-gradient(circle, rgba(239,68,68,0.4) 60%, transparent 60%)',
            cursor: 'pointer',
          };
        } else {
          styles[sq] = {
            background: 'radial-gradient(circle, rgba(59,130,246,0.25) 25%, transparent 25%)',
            cursor: 'pointer',
          };
        }
      }
    }

    return styles;
  }, [level, enemies, selectedRook, legalMoves, enemySet, phase]);

  // Handle square click
  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (phase !== 'playing' || !level) return;

      // If clicking a rook, select it
      if (rookSet.has(square)) {
        setSelectedRook(square);
        return;
      }

      // If no rook selected, ignore
      if (!selectedRook) return;

      // If not a legal move, ignore
      if (!legalMoveSet.has(square)) return;

      // Save snapshot for undo
      setHistory((prev) => [...prev, { rooks: [...rooks], enemies: [...enemies], selectedRook }]);

      // Move the rook
      const isCapture = enemySet.has(square);
      const newRooks = rooks.map((r) => (r === selectedRook ? square : r));
      const newEnemies = isCapture ? enemies.filter((e) => e !== square) : enemies;

      setRooks(newRooks);
      setEnemies(newEnemies);
      setSelectedRook(square);
      setMoveCount((m) => m + 1);

      // "Efficient!" feedback
      if (isCapture && newEnemies.length > 0 && isAlignedWithAny(square, newEnemies)) {
        setFeedback('Efficient!');
        if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);
        feedbackTimeout.current = setTimeout(() => setFeedback(null), 1200);
      }

      // Check win
      if (newEnemies.length === 0) {
        const totalMoves = moveCount + 1;
        setPhase('won');
        void completeClearerLevel(level.id, totalMoves, level.par);
        const stars = calculateStars(totalMoves, level.par);
        if (stars === 3) {
          kidSpeak('Perfect! All cleared with minimum moves!');
        } else if (stars === 2) {
          kidSpeak('Well done! All pawns captured!');
        } else {
          kidSpeak('Nice! Try again for fewer moves.');
        }
      }
    },
    [phase, level, rookSet, selectedRook, legalMoveSet, rooks, enemies, enemySet, moveCount, kidSpeak],
  );

  // Undo
  const handleUndo = useCallback((): void => {
    if (history.length === 0 || phase !== 'playing') return;
    const prev = history[history.length - 1];
    setRooks(prev.rooks);
    setEnemies(prev.enemies);
    setSelectedRook(prev.selectedRook);
    setMoveCount((m) => m - 1);
    setHistory((h) => h.slice(0, -1));
  }, [history, phase]);

  // Reset
  const handleReset = useCallback((): void => {
    if (!level) return;
    setRooks([...level.rooks]);
    setEnemies([...level.enemies]);
    setSelectedRook(level.rooks.length === 1 ? level.rooks[0] : null);
    setMoveCount(0);
    setPhase('playing');
    setHistory([]);
    setFeedback(null);
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
  const capturedCount = level.enemies.length - enemies.length;

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }}
      data-testid="row-clearer-page"
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
            data-testid="clearer-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold">Row Clearer: {level.name}</h2>
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
          data-testid="clearer-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Game area */}
      <div className="flex-1 p-4 flex flex-col items-center gap-4">
        {/* Counters */}
        <div
          className="flex items-center gap-4 text-sm font-medium"
          data-testid="clearer-counters"
        >
          <span>Moves: {moveCount}</span>
          <span>Captured: {capturedCount}/{level.enemies.length}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>Par: {level.par}</span>
        </div>

        {/* Efficient! feedback */}
        <AnimatePresence>
          {feedback && (
            <motion.div
              key="feedback"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="px-4 py-1 rounded-lg font-bold text-sm"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="clearer-feedback"
            >
              {feedback}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Board */}
        <BoardVoiceOverlay fen={fen} className="w-full md:max-w-[420px] mx-auto">
          <ConsistentChessboard
            fen={fen}
            boardOrientation="white"
            squareStyles={squareStyles}
            onSquareClick={handleSquareClick}
          />
        </BoardVoiceOverlay>

        {/* Multi-rook instruction */}
        {level.rooks.length > 1 && phase === 'playing' && (
          <p
            className="text-xs text-center"
            style={{ color: 'var(--color-text-muted)' }}
            data-testid="clearer-rook-hint"
          >
            Click a rook to select it, then click where to move
          </p>
        )}

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
              data-testid="clearer-undo-btn"
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
              data-testid="clearer-reset-btn"
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
              data-testid="clearer-win-screen"
            >
              <h2 className="text-2xl font-bold">All Clear!</h2>
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
                  data-testid="clearer-retry-btn"
                >
                  Try Again
                </button>
                <button
                  onClick={handleBack}
                  className="px-6 py-2 rounded-xl font-bold"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                  data-testid="clearer-continue-btn"
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
