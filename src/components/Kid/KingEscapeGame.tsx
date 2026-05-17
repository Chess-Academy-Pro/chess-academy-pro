import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import { KING_ESCAPE_LEVELS } from '../../data/kingGameLevels';

type GamePhase = 'intro' | 'playing' | 'success' | 'complete';

export function KingEscapeGame(): JSX.Element {
  const navigate = useNavigate();

  const [levelIndex, setLevelIndex] = useState(0);
  const [phase, setPhase] = useState<GamePhase>('intro');
  const [boardKey, setBoardKey] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [levelsWon, setLevelsWon] = useState(0);

  const level = KING_ESCAPE_LEVELS[levelIndex];

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  useEffect(() => {
    if (phase === 'intro') {
      kidSpeak('King Escape! Your king is in check. Move it to safety!');
    }
  }, [phase, kidSpeak]);

  // Compute attacked squares and safe king moves for highlights
  const { dangerSquares, safeSquares } = useMemo(() => {
    const chess = new Chess(level.fen);
    const danger: string[] = [];
    const safe: string[] = [];

    // Get all squares attacked by black
    for (const f of 'abcdefgh') {
      for (let r = 1; r <= 8; r++) {
        const sq = `${f}${r}`;
        if (chess.isAttacked(sq as Square, 'b')) {
          danger.push(sq);
        }
      }
    }

    // Get legal king moves (= safe escape squares)
    const moves = chess.moves({ verbose: true });
    for (const move of moves) {
      safe.push(move.to);
    }

    return { dangerSquares: danger, safeSquares: safe };
  }, [level.fen]);

  // Build annotation highlights for the board
  const annotationHighlights = useMemo(() => {
    const highlights: Array<{ square: string; color: string }> = [];

    if (level.showDangerSquares) {
      for (const sq of dangerSquares) {
        highlights.push({ square: sq, color: 'rgba(239, 68, 68, 0.4)' });
      }
    }

    if (level.showSafeSquares) {
      for (const sq of safeSquares) {
        highlights.push({ square: sq, color: 'rgba(34, 197, 94, 0.5)' });
      }
    }

    return highlights.length > 0 ? highlights : undefined;
  }, [level, dangerSquares, safeSquares]);

  const handleMove = useCallback(
    (): void => {
      // Any legal move escapes check — chess.js only allows legal moves
      setLevelsWon((prev) => prev + 1);
      setPhase('success');
      kidSpeak('Great job! The king is safe!');
    },
    [kidSpeak],
  );

  const handleNextLevel = useCallback((): void => {
    if (levelIndex + 1 >= KING_ESCAPE_LEVELS.length) {
      setPhase('complete');
      kidSpeak(`Amazing! You completed all ${KING_ESCAPE_LEVELS.length} levels!`);
    } else {
      setLevelIndex((prev) => prev + 1);
      setBoardKey((prev) => prev + 1);
      setPhase('playing');
      kidSpeak(KING_ESCAPE_LEVELS[levelIndex + 1].description);
    }
  }, [levelIndex, kidSpeak]);

  const handleBegin = useCallback((): void => {
    setPhase('playing');
    kidSpeak(level.description);
  }, [level.description, kidSpeak]);

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
      className="flex flex-col flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)', background: 'var(--color-bg)' }}
      data-testid="king-escape-game"
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
            data-testid="escape-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-lg font-bold">King Escape</h2>
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
          data-testid="escape-voice-toggle"
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
              data-testid="escape-intro"
            >
              <span className="text-8xl">{'👑'}</span>
              <h1 className="text-2xl font-bold">King Escape</h1>
              <p className="text-lg leading-relaxed max-w-md" style={{ color: 'var(--color-text-muted)' }}>
                Your king is in check! Move it to a safe square where no enemy piece can attack it.
              </p>
              <button
                onClick={handleBegin}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="escape-begin-btn"
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
              data-testid="escape-playing"
            >
              <h3 className="text-xl font-bold">
                Level {level.level} of {KING_ESCAPE_LEVELS.length}
              </h3>
              <p
                className="text-base text-center max-w-md"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {level.description}
              </p>

              <div className="w-full md:max-w-[420px] mx-auto">
                <KidChessboard
                  key={boardKey}
                  initialFen={level.fen}
                  interactive={true}
                  onMove={handleMove}
                  annotationHighlights={annotationHighlights}
                />
              </div>
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
              data-testid="escape-success"
            >
              <span className="text-6xl">{'🎉'}</span>
              <h2 className="text-2xl font-bold">The King is Safe!</h2>
              <p style={{ color: 'var(--color-text-muted)' }}>
                Level {level.level} complete!
              </p>
              <button
                onClick={handleNextLevel}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="escape-next-btn"
              >
                {levelIndex + 1 >= KING_ESCAPE_LEVELS.length ? 'Finish!' : 'Next Level'}
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
              data-testid="escape-complete"
            >
              <h1 className="text-3xl font-bold">All Levels Complete!</h1>
              <StarDisplay earned={levelsWon} total={KING_ESCAPE_LEVELS.length} size="lg" />
              <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
                You saved the king {levelsWon} time{levelsWon !== 1 ? 's' : ''}!
              </p>
              <button
                onClick={handleBack}
                className="mt-4 px-8 py-3 rounded-xl font-bold text-lg"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="escape-done-btn"
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
