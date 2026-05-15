import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ArrowLeft, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChessBoard } from '../Board/ChessBoard';
import { StarDisplay } from './StarDisplay';
import { usePieceSound } from '../../hooks/usePieceSound';
import { voiceService } from '../../services/voiceService';
import { BISHOP_VS_PAWNS_LEVELS } from '../../data/bishopGameLevels';
import {
  positionToFen,
  getBishopMoves,
  advancePawns,
  checkPawnPromotion,
  countBlackPawns,
  findPieceSquares,
  getPromotionRankSquares,
} from '../../utils/bishopGameUtils';
import type { BishopGamePhase } from '../../types';

interface BishopVsPawnsProps {
  onBack: () => void;
}

export function BishopVsPawns({ onBack }: BishopVsPawnsProps): JSX.Element {
  const [phase, setPhase] = useState<BishopGamePhase>('menu');
  const [currentLevel, setCurrentLevel] = useState(0);
  const [pieces, setPieces] = useState<Record<string, string>>({});
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [movesPlayed, setMovesPlayed] = useState(0);
  const [levelsCompleted, setLevelsCompleted] = useState<Set<number>>(new Set());
  const [voiceOn, setVoiceOn] = useState(true);
  const [boardKey, setBoardKey] = useState(0);
  const [animating, setAnimating] = useState(false);

  const { playMoveSound, playCelebration, playEncouragement } = usePieceSound();
  const advanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (advanceTimeoutRef.current) clearTimeout(advanceTimeoutRef.current);
    };
  }, []);

  const kidSpeak = useCallback((text: string): void => {
    if (!voiceOn) return;
    void voiceService.speak(text);
  }, [voiceOn]);

  const levelConfig = BISHOP_VS_PAWNS_LEVELS[currentLevel];

  const initLevel = useCallback((levelIdx: number): void => {
    const config = BISHOP_VS_PAWNS_LEVELS[levelIdx];
    const initial: Record<string, string> = {};
    initial[config.bishopStart] = 'B';
    for (const sq of config.pawnSquares) {
      initial[sq] = 'p';
    }
    setPieces(initial);
    setSelectedSquare(null);
    setLegalMoves([]);
    setMovesPlayed(0);
    setAnimating(false);
    setBoardKey((k) => k + 1);
    setPhase('playing');
    setCurrentLevel(levelIdx);
  }, []);

  const fen = useMemo(() => positionToFen(pieces), [pieces]);

  const promotionSquares = useMemo(() => getPromotionRankSquares(), []);

  const handleSquareClick = useCallback((square: string): void => {
    if (phase !== 'playing' || animating) return;

    const piece = pieces[square];

    // If clicking the bishop, select it and show legal moves
    if (piece === 'B') {
      const moves = getBishopMoves(square, pieces);
      setSelectedSquare(square);
      setLegalMoves(moves);
      return;
    }

    // If a bishop is selected and this is a legal move, execute it
    if (selectedSquare && legalMoves.includes(square)) {
      const isCapture = pieces[square] === 'p';
      const { [selectedSquare]: _removed, ...remaining } = pieces;
      const newPieces: Record<string, string> = { ...remaining, [square]: 'B' };

      setPieces(newPieces);
      setSelectedSquare(null);
      setLegalMoves([]);
      setMovesPlayed((m) => m + 1);
      setAnimating(true);

      playMoveSound(isCapture ? 'Bxe4' : 'Be4');

      // Check if all pawns captured (win)
      if (countBlackPawns(newPieces) === 0) {
        setAnimating(false);
        setPhase('won');
        setLevelsCompleted((prev) => new Set([...prev, currentLevel]));
        playCelebration();
        kidSpeak('Amazing! You caught all the pawns!');
        return;
      }

      // Advance pawns after a short delay
      advanceTimeoutRef.current = setTimeout(() => {
        const advanced = advancePawns(newPieces);
        setPieces(advanced);
        setBoardKey((k) => k + 1);
        setAnimating(false);

        // Check if any pawn reached promotion (loss)
        if (checkPawnPromotion(advanced)) {
          setPhase('lost');
          playEncouragement();
          kidSpeak('Oh no, a pawn got through! Try again!');
        }
      }, 400);
      return;
    }

    // Clear selection if clicking elsewhere
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [phase, animating, pieces, selectedSquare, legalMoves, currentLevel, playMoveSound, playCelebration, playEncouragement, kidSpeak]);

  const handleVoiceToggle = useCallback((): void => {
    if (voiceOn) voiceService.stop();
    setVoiceOn((v) => !v);
  }, [voiceOn]);

  const handleRetry = useCallback((): void => {
    initLevel(currentLevel);
    kidSpeak('Try again! You can do it!');
  }, [currentLevel, initLevel, kidSpeak]);

  const handleNextLevel = useCallback((): void => {
    const next = currentLevel + 1;
    if (next < BISHOP_VS_PAWNS_LEVELS.length) {
      initLevel(next);
      kidSpeak(BISHOP_VS_PAWNS_LEVELS[next].description);
    } else {
      setPhase('menu');
      kidSpeak('You completed all levels! Amazing!');
    }
  }, [currentLevel, initLevel, kidSpeak]);

  // Build highlight styles for overlay squares
  const getSquareClass = useCallback((sq: string): string => {
    const classes: string[] = ['w-full', 'h-full'];

    if (selectedSquare === sq) {
      classes.push('bg-yellow-400/50');
    } else if (legalMoves.includes(sq) && levelConfig.showBishopMoves) {
      classes.push(pieces[sq] === 'p' ? 'bg-red-400/40' : 'bg-green-400/30');
    } else if (levelConfig.showThreatenedSquares && promotionSquares.includes(sq)) {
      classes.push('bg-red-500/25');
    } else {
      classes.push('opacity-0 hover:opacity-20 hover:bg-white');
    }

    return classes.join(' ');
  }, [selectedSquare, legalMoves, levelConfig, pieces, promotionSquares]);

  const pawnsRemaining = useMemo(() => countBlackPawns(pieces), [pieces]);
  const bishopSquares = useMemo(() => findPieceSquares(pieces, 'B'), [pieces]);

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="bishop-vs-pawns"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { voiceService.stop(); if (phase === 'playing') { setPhase('menu'); } else { onBack(); } }}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            data-testid="bvp-back-btn"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Bishop vs. Pawns</h2>
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
          data-testid="bvp-voice-toggle"
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
            data-testid="bvp-menu"
          >
            <p className="text-center" style={{ color: 'var(--color-text-muted)' }}>
              Capture all the pawns before they reach the back rank!
            </p>
            {BISHOP_VS_PAWNS_LEVELS.map((level, idx) => {
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
                  data-testid={`bvp-level-${level.level}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-bold">Level {level.level}</span>
                      <span className="text-sm ml-2" style={{ color: 'var(--color-text-muted)' }}>
                        {level.pawnSquares.length} pawns
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
            data-testid="bvp-playing"
          >
            <div className="flex items-center gap-4 text-sm font-medium">
              <span>Level {levelConfig.level}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                Pawns: {pawnsRemaining}
              </span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                Moves: {movesPlayed}
              </span>
            </div>

            {!selectedSquare && bishopSquares.length > 0 && (
              <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
                Tap the bishop to select it!
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
                data-testid="bvp-overlay"
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
                      data-testid={`bvp-sq-${sq}`}
                    />
                  );
                })}
              </div>
            </div>

            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
              data-testid="bvp-retry-btn"
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
            data-testid="bvp-won"
          >
            <h2 className="text-2xl font-bold">Level Complete!</h2>
            <StarDisplay earned={1} total={1} size="lg" />
            <p style={{ color: 'var(--color-text-muted)' }}>
              You caught all the pawns in {movesPlayed} moves!
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPhase('menu')}
                className="px-6 py-3 rounded-xl font-bold"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
                data-testid="bvp-back-to-menu"
              >
                Levels
              </button>
              {currentLevel < BISHOP_VS_PAWNS_LEVELS.length - 1 && (
                <button
                  onClick={handleNextLevel}
                  className="px-6 py-3 rounded-xl font-bold"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                  data-testid="bvp-next-level"
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
            data-testid="bvp-lost"
          >
            <h2 className="text-2xl font-bold">A pawn got through!</h2>
            <p style={{ color: 'var(--color-text-muted)' }}>
              A pawn reached the back rank. Try to catch them all next time!
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
                data-testid="bvp-retry-lost"
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
