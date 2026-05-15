import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ArrowLeft, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChessBoard } from '../Board/ChessBoard';
import { PuzzleTimer } from '../Puzzles/PuzzleTimer';
import { StarDisplay } from './StarDisplay';
import { usePieceSound } from '../../hooks/usePieceSound';
import { voiceService } from '../../services/voiceService';
import { COLOR_WARS_LEVELS } from '../../data/bishopGameLevels';
import {
  positionToFen,
  getBishopMoves,
  countEnemyPieces,
  findPieceSquares,
  isLightSquare,
} from '../../utils/bishopGameUtils';
import type { BishopGamePhase } from '../../types';

interface ColorWarsProps {
  onBack: () => void;
}

export function ColorWars({ onBack }: ColorWarsProps): JSX.Element {
  const [phase, setPhase] = useState<BishopGamePhase>('menu');
  const [currentLevel, setCurrentLevel] = useState(0);
  const [pieces, setPieces] = useState<Record<string, string>>({});
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [captureCount, setCaptureCount] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerKey, setTimerKey] = useState(0);
  const [levelsCompleted, setLevelsCompleted] = useState<Set<number>>(new Set());
  const [starsEarned, setStarsEarned] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [boardKey, setBoardKey] = useState(0);
  const [totalEnemies, setTotalEnemies] = useState(0);

  const timerStartRef = useRef<number>(0);
  const { playMoveSound, playCelebration, playEncouragement } = usePieceSound();

  // Track elapsed time for star calculation
  const elapsedRef = useRef(0);
  useEffect(() => {
    if (!timerRunning) return;
    timerStartRef.current = Date.now();
    const interval = setInterval(() => {
      elapsedRef.current = (Date.now() - timerStartRef.current) / 1000;
    }, 200);
    return () => clearInterval(interval);
  }, [timerRunning]);

  const kidSpeak = useCallback((text: string): void => {
    if (!voiceOn) return;
    void voiceService.speak(text);
  }, [voiceOn]);

  const levelConfig = COLOR_WARS_LEVELS[currentLevel];

  const initLevel = useCallback((levelIdx: number): void => {
    const config = COLOR_WARS_LEVELS[levelIdx];
    const initial: Record<string, string> = {};
    initial[config.lightBishopStart] = 'B';
    initial[config.darkBishopStart] = 'B';
    for (const ep of config.enemyPieces) {
      initial[ep.square] = ep.piece;
    }
    setPieces(initial);
    setSelectedSquare(null);
    setLegalMoves([]);
    setCaptureCount(0);
    setTotalEnemies(config.enemyPieces.length);
    setTimerRunning(true);
    setTimerKey((k) => k + 1);
    setBoardKey((k) => k + 1);
    elapsedRef.current = 0;
    setPhase('playing');
    setCurrentLevel(levelIdx);
  }, []);

  const fen = useMemo(() => positionToFen(pieces), [pieces]);

  const handleTimeout = useCallback((): void => {
    setTimerRunning(false);
    setPhase('lost');
    playEncouragement();
    kidSpeak('Time is up! Try again — you can be faster!');
  }, [playEncouragement, kidSpeak]);

  const calculateStars = useCallback((elapsed: number, duration: number): number => {
    const fraction = elapsed / duration;
    if (fraction <= 0.5) return 3;
    if (fraction <= 0.75) return 2;
    return 1;
  }, []);

  const handleSquareClick = useCallback((square: string): void => {
    if (phase !== 'playing') return;

    const piece = pieces[square];

    // Clicking a white bishop — select it
    if (piece === 'B') {
      const moves = getBishopMoves(square, pieces);
      setSelectedSquare(square);
      setLegalMoves(moves);
      return;
    }

    // If a bishop is selected and this is a legal move, execute it
    if (selectedSquare && legalMoves.includes(square)) {
      const isCapture = Object.hasOwn(pieces, square) && pieces[square] !== 'B';
      const { [selectedSquare]: _removed, ...remaining } = pieces;
      const newPieces: Record<string, string> = { ...remaining, [square]: 'B' };

      setPieces(newPieces);
      setSelectedSquare(null);
      setLegalMoves([]);
      setBoardKey((k) => k + 1);

      playMoveSound(isCapture ? 'Bxe4' : 'Be4');

      if (isCapture) {
        const newCount = captureCount + 1;
        setCaptureCount(newCount);

        // Check if all enemies captured
        if (countEnemyPieces(newPieces) === 0) {
          setTimerRunning(false);
          const stars = calculateStars(elapsedRef.current, levelConfig.timerSeconds);
          setStarsEarned(stars);
          setLevelsCompleted((prev) => new Set([...prev, currentLevel]));
          setPhase('won');
          playCelebration();
          kidSpeak(
            stars === 3
              ? 'Perfect! Lightning fast!'
              : stars === 2
                ? 'Great job! You cleared the board!'
                : 'You did it! Try again for more stars!',
          );
        }
      }
      return;
    }

    // Clear selection
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [phase, pieces, selectedSquare, legalMoves, captureCount, currentLevel, levelConfig, playMoveSound, playCelebration, kidSpeak, calculateStars]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) voiceService.stop();
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  const handleRetry = useCallback((): void => {
    initLevel(currentLevel);
    kidSpeak('Try again! Be quick!');
  }, [currentLevel, initLevel, kidSpeak]);

  const handleNextLevel = useCallback((): void => {
    const next = currentLevel + 1;
    if (next < COLOR_WARS_LEVELS.length) {
      initLevel(next);
      kidSpeak(COLOR_WARS_LEVELS[next].description);
    } else {
      setPhase('menu');
      kidSpeak('You completed all Color Wars levels!');
    }
  }, [currentLevel, initLevel, kidSpeak]);

  // Build highlight styles for overlay squares
  const getSquareClass = useCallback((sq: string): string => {
    const classes: string[] = ['w-full', 'h-full'];

    if (selectedSquare === sq) {
      classes.push('bg-yellow-400/50');
    } else if (legalMoves.includes(sq) && levelConfig.showBishopMoves) {
      const isEnemy = pieces[sq] && pieces[sq] !== 'B';
      classes.push(isEnemy ? 'bg-red-400/40' : 'bg-green-400/30');
    } else if (levelConfig.showEnemyGlow && pieces[sq] && pieces[sq] !== 'B') {
      // Glow enemy pieces with color matching which bishop can capture them
      classes.push(isLightSquare(sq) ? 'bg-amber-300/30' : 'bg-purple-400/30');
    } else {
      classes.push('opacity-0 hover:opacity-20 hover:bg-white');
    }

    return classes.join(' ');
  }, [selectedSquare, legalMoves, levelConfig, pieces]);

  const bishopSquares = useMemo(() => findPieceSquares(pieces, 'B'), [pieces]);

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="color-wars"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { voiceService.stop(); setTimerRunning(false); if (phase === 'playing') { setPhase('menu'); } else { onBack(); } }}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="cw-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Color Wars</h2>
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
          data-testid="cw-voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {/* ── Level Select Menu ───────────────────────────────────── */}
        {phase === 'menu' && (
          <motion.div
            key="menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-4 items-center"
            data-testid="cw-menu"
          >
            <p className="text-center" style={{ color: 'var(--color-text-muted)' }}>
              Use both bishops to capture all enemies before time runs out!
            </p>
            {COLOR_WARS_LEVELS.map((level, idx) => {
              const locked = idx > 0 && !levelsCompleted.has(idx - 1);
              const completed = levelsCompleted.has(idx);
              return (
                <button
                  key={level.level}
                  onClick={() => { if (!locked) { initLevel(idx); kidSpeak(level.description); } }}
                  disabled={locked}
                  className={`w-full max-w-sm rounded-xl p-4 border-2 text-left transition-opacity ${
                    locked ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
                  }`}
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: completed ? 'var(--color-accent)' : 'var(--color-border)',
                  }}
                  data-testid={`cw-level-${level.level}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-bold">Level {level.level}</span>
                      <span className="text-sm ml-2" style={{ color: 'var(--color-text-muted)' }}>
                        {level.enemyPieces.length} targets &middot; {level.timerSeconds}s
                      </span>
                    </div>
                    {completed && <span className="text-lg">&#11088;</span>}
                    {locked && <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Locked</span>}
                  </div>
                  <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
                    {level.description}
                  </p>
                </button>
              );
            })}
          </motion.div>
        )}

        {/* ── Playing Phase ───────────────────────────────────────── */}
        {phase === 'playing' && (
          <motion.div
            key="playing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center gap-3"
            data-testid="cw-playing"
          >
            <div className="w-full max-w-sm">
              <PuzzleTimer
                key={timerKey}
                duration={levelConfig.timerSeconds}
                running={timerRunning}
                onTimeout={handleTimeout}
              />
            </div>

            <div className="flex items-center gap-4 text-sm font-medium">
              <span>Level {levelConfig.level}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                Captured: {captureCount}/{totalEnemies}
              </span>
            </div>

            {!selectedSquare && bishopSquares.length > 0 && (
              <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
                Tap either bishop to select it!
              </p>
            )}
            {selectedSquare && (
              <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
                Tap a highlighted square to move!
              </p>
            )}

            <div className="w-full md:max-w-[420px] mx-auto relative">
              <ChessBoard
                key={boardKey}
                initialFen={fen}
                interactive={false}
                showFlipButton={false}
                showUndoButton={false}
                showResetButton={false}
              />
              {/* Clickable overlay grid */}
              <div
                className="absolute inset-0 grid grid-cols-8 grid-rows-8"
                data-testid="cw-overlay"
              >
                {Array.from({ length: 64 }).map((_, i) => {
                  const file = String.fromCharCode(97 + (i % 8));
                  const rank = 8 - Math.floor(i / 8);
                  const sq = `${file}${rank}`;
                  return (
                    <button
                      key={sq}
                      onClick={() => handleSquareClick(sq)}
                      className={getSquareClass(sq)}
                      data-testid={`cw-sq-${sq}`}
                    />
                  );
                })}
              </div>
            </div>

            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
              data-testid="cw-retry-btn"
            >
              <RotateCcw size={14} /> Restart
            </button>
          </motion.div>
        )}

        {/* ── Won Phase ───────────────────────────────────────────── */}
        {phase === 'won' && (
          <motion.div
            key="won"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
            className="flex flex-col items-center gap-6 text-center"
            data-testid="cw-won"
          >
            <h2 className="text-2xl font-bold">Level Complete!</h2>
            <StarDisplay earned={starsEarned} total={3} size="lg" />
            <p style={{ color: 'var(--color-text-muted)' }}>
              You captured all {totalEnemies} enemies!
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPhase('menu')}
                className="px-6 py-3 rounded-xl font-bold"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
                data-testid="cw-back-to-menu"
              >
                Levels
              </button>
              {currentLevel < COLOR_WARS_LEVELS.length - 1 && (
                <button
                  onClick={handleNextLevel}
                  className="px-6 py-3 rounded-xl font-bold"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                  data-testid="cw-next-level"
                >
                  Next Level
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Lost Phase ──────────────────────────────────────────── */}
        {phase === 'lost' && (
          <motion.div
            key="lost"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
            className="flex flex-col items-center gap-6 text-center"
            data-testid="cw-lost"
          >
            <h2 className="text-2xl font-bold">Time's Up!</h2>
            <p style={{ color: 'var(--color-text-muted)' }}>
              You captured {captureCount} of {totalEnemies} enemies. Try to be faster!
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPhase('menu')}
                className="px-6 py-3 rounded-xl font-bold"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
              >
                Levels
              </button>
              <button
                onClick={handleRetry}
                className="px-6 py-3 rounded-xl font-bold"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="cw-retry-lost"
              >
                Try Again
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
