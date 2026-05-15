import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Lightbulb, RotateCcw } from 'lucide-react';
import { Chess } from 'chess.js';
import { ChessBoard } from '../Board/ChessBoard';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import {
  getAiMove,
  checkWinCondition,
  computeHighlights,
  getHintArrows,
  computeStars,
  getTargetPawnSquare,
} from '../../services/miniGameEngine';
import {
  completeMiniGameLevel,
  getMiniGameProgress,
  isLevelUnlocked,
} from '../../services/miniGameService';
import { PAWN_WARS_LEVELS } from '../../data/pawnWarsConfig';
import { BLOCKER_LEVELS } from '../../data/blockerConfig';
import type {
  MiniGameId,
  MiniGamePhase,
  MiniGameLevelConfig,
  MiniGameProgress,
} from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';

interface MiniGamePageProps {
  gameId: MiniGameId;
}

function getLevels(gameId: MiniGameId): MiniGameLevelConfig[] {
  return gameId === 'pawn-wars' ? PAWN_WARS_LEVELS : BLOCKER_LEVELS;
}

const AI_DELAY_MS = 400;

export function MiniGamePage({ gameId }: MiniGamePageProps): JSX.Element {
  const { level: levelParam } = useParams<{ level: string }>();
  const navigate = useNavigate();
  const levelNum = parseInt(levelParam ?? '1', 10) as 1 | 2 | 3;

  const levels = useMemo(() => getLevels(gameId), [gameId]);
  const config = useMemo(
    () => levels.find((l) => l.level === levelNum) ?? levels[0],
    [levels, levelNum],
  );

  // Authoritative game state
  const gameRef = useRef(new Chess(config.startFen));
  const [currentFen, setCurrentFen] = useState(config.startFen);
  const [phase, setPhase] = useState<MiniGamePhase>('intro');
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [hintLevel, setHintLevel] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [moveCount, setMoveCount] = useState(0);
  const [stars, setStars] = useState(0);
  const [progress, setProgress] = useState<MiniGameProgress | null>(null);

  // Load progress to check if level is unlocked
  useEffect(() => {
    void getMiniGameProgress(gameId).then((p) => setProgress(p));
  }, [gameId]);

  // Reset game when config changes
  useEffect(() => {
    gameRef.current = new Chess(config.startFen);
    setCurrentFen(config.startFen);
    setPhase('intro');
    setIsAiTurn(false);
    setHintLevel(0);
    setHintsUsed(0);
    setMoveCount(0);
    setStars(0);
  }, [config]);

  // Voice narration for phase transitions
  useEffect(() => {
    if (phase === 'intro') {
      void voiceService.speak(config.storyIntro);
    } else if (phase === 'won') {
      void voiceService.speak(config.storyWin);
    } else if (phase === 'lost') {
      void voiceService.speak(config.storyLoss);
    }
  }, [phase, config]);

  // Compute board highlights
  const highlights = useMemo(
    () => computeHighlights(currentFen, config.playerColor, config.highlightMode),
    [currentFen, config.playerColor, config.highlightMode],
  );

  const annotationHighlights = useMemo(() => {
    const result: Array<{ square: string; color: string }> = [];
    for (const sq of highlights.dangerSquares) {
      result.push({ square: sq, color: 'rgba(239, 68, 68, 0.4)' });
    }
    for (const sq of highlights.safeSquares) {
      result.push({ square: sq, color: 'rgba(34, 197, 94, 0.4)' });
    }
    // Target pawn marker for Blocker
    if (config.showTargetPawn && gameId === 'blocker') {
      const aiColor = config.playerColor === 'w' ? 'b' : 'w';
      const targetSq = getTargetPawnSquare(
        currentFen,
        aiColor,
        config.aiConfig.targetPawnFile,
      );
      if (targetSq) {
        result.push({ square: targetSq, color: 'rgba(251, 191, 36, 0.6)' });
      }
    }
    return result;
  }, [highlights, config, currentFen, gameId]);

  // Hint arrows
  const arrows = useMemo(
    () =>
      phase === 'playing'
        ? getHintArrows(currentFen, config.playerColor, hintLevel)
        : [],
    [currentFen, config.playerColor, hintLevel, phase],
  );

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleStart = useCallback((): void => {
    voiceService.stop();
    setPhase('playing');
  }, []);

  const handleRestart = useCallback((): void => {
    voiceService.stop();
    gameRef.current = new Chess(config.startFen);
    setCurrentFen(config.startFen);
    setPhase('playing');
    setIsAiTurn(false);
    setHintLevel(0);
    setHintsUsed(0);
    setMoveCount(0);
    setStars(0);
  }, [config]);

  const handleNextLevel = useCallback((): void => {
    if (levelNum < 3) {
      void navigate(`/kid/mini-games/${gameId}/${levelNum + 1}`);
    } else {
      void navigate('/kid/mini-games');
    }
  }, [navigate, gameId, levelNum]);

  const handleBack = useCallback((): void => {
    voiceService.stop();
    void navigate('/kid/mini-games');
  }, [navigate]);

  const handleHint = useCallback((): void => {
    if (phase !== 'playing' || isAiTurn) return;
    const newLevel = Math.min(hintLevel + 1, 2);
    setHintLevel(newLevel);
    if (newLevel === 1) {
      setHintsUsed((h) => h + 1);
      void voiceService.speak('Watch out for the enemy pawns!');
    } else if (newLevel === 2) {
      setHintsUsed((h) => h + 1);
      void voiceService.speak('Try moving this pawn forward!');
    }
  }, [phase, isAiTurn, hintLevel]);

  // AI turn execution
  const executeAiTurn = useCallback((): void => {
    const aiMove = getAiMove(
      gameRef.current.fen(),
      config.aiConfig,
      gameId,
    );

    if (!aiMove) {
      // AI has no pawn moves → player wins
      const earned = computeStars(hintsUsed, Math.max(0, moveCount - 8), config.level);
      setStars(earned);
      setPhase('won');
      void completeMiniGameLevel(gameId, config.level, earned, hintsUsed);
      return;
    }

    const from = aiMove.slice(0, 2);
    const to = aiMove.slice(2, 4);
    const promotion = aiMove.length > 4 ? aiMove[4] : undefined;

    try {
      const aiColor = gameRef.current.turn();
      const result = gameRef.current.move({ from, to, promotion });

      const newFen = gameRef.current.fen();
      setCurrentFen(newFen);

      const winner = checkWinCondition(newFen, result.san, aiColor);
      if (winner) {
        if (winner === config.playerColor) {
          const earned = computeStars(hintsUsed, Math.max(0, moveCount - 8), config.level);
          setStars(earned);
          setPhase('won');
          void completeMiniGameLevel(gameId, config.level, earned, hintsUsed);
        } else {
          setPhase('lost');
        }
        setIsAiTurn(false);
        return;
      }
    } catch {
      // Invalid move from AI — skip turn
    }

    setIsAiTurn(false);
    setHintLevel(0);
  }, [config, gameId, hintsUsed, moveCount]);

  const handlePlayerMove = useCallback(
    (move: MoveResult): void => {
      if (phase !== 'playing' || isAiTurn) return;

      // Apply the same move to our authoritative game instance
      try {
        const playerColor = gameRef.current.turn();
        const result = gameRef.current.move({
          from: move.from,
          to: move.to,
          promotion: 'q',
        });

        const newFen = gameRef.current.fen();
        setCurrentFen(newFen);
        setMoveCount((c) => c + 1);

        // Check win
        const winner = checkWinCondition(newFen, result.san, playerColor);
        if (winner) {
          if (winner === config.playerColor) {
            const earned = computeStars(
              hintsUsed,
              Math.max(0, moveCount + 1 - 8),
              config.level,
            );
            setStars(earned);
            setPhase('won');
            void completeMiniGameLevel(gameId, config.level, earned, hintsUsed);
          } else {
            setPhase('lost');
          }
          return;
        }

        // AI turn
        setIsAiTurn(true);
        setTimeout(() => {
          executeAiTurn();
        }, AI_DELAY_MS);
      } catch {
        // Move failed on our chess instance — board may be out of sync
      }
    },
    [phase, isAiTurn, config, gameId, hintsUsed, moveCount, executeAiTurn],
  );

  // ─── Locked level guard ─────────────────────────────────────────────────────

  if (!isLevelUnlocked(progress, levelNum)) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 p-6 flex-1"
        style={{ color: 'var(--color-text)' }}
        data-testid="mini-game-locked"
      >
        <p className="text-xl font-bold">Level Locked</p>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Complete Level {levelNum - 1} first!
        </p>
        <button
          onClick={handleBack}
          className="px-4 py-2 rounded-lg font-semibold"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Back to Mini-Games
        </button>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col gap-2 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-4"
      style={{ color: 'var(--color-text)' }}
      data-testid="mini-game-page"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleBack}
          className="p-2 rounded-lg hover:opacity-80"
          style={{ background: 'var(--color-surface)' }}
          data-testid="mini-game-back"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-lg font-bold flex-1">{config.title}</h2>
        <span className="text-sm font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Level {config.level}
        </span>
      </div>

      {/* Intro phase */}
      {phase === 'intro' && (
        <div className="flex flex-col items-center gap-4" data-testid="mini-game-intro">
          <div
            className="rounded-2xl p-5 border-2 text-center max-w-md"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
            }}
          >
            <p className="text-base leading-relaxed">{config.storyIntro}</p>
          </div>
          <button
            onClick={handleStart}
            className="px-6 py-3 rounded-xl font-bold text-lg"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            data-testid="mini-game-start"
          >
            Start!
          </button>
        </div>
      )}

      {/* Playing phase */}
      {phase === 'playing' && (
        <>
          <div className="w-full md:max-w-[420px] mx-auto">
            <ChessBoard
              initialFen={currentFen}
              interactive={!isAiTurn}
              showFlipButton={false}
              showUndoButton={false}
              showResetButton={false}
              showEvalBar={false}
              onMove={handlePlayerMove}
              annotationHighlights={annotationHighlights}
              arrows={arrows}
            />
          </div>

          {/* Controls — compact row directly under board */}
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={handleHint}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg font-semibold text-xs"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
              }}
              disabled={isAiTurn || hintLevel >= 2}
              data-testid="mini-game-hint"
            >
              <Lightbulb size={14} />
              Hint {hintLevel > 0 ? `(${hintLevel}/2)` : ''}
            </button>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg font-semibold text-xs"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
              }}
              data-testid="mini-game-restart"
            >
              <RotateCcw size={14} />
              Restart
            </button>
            <span className="text-xs ml-1" style={{ color: 'var(--color-text-muted)' }}>
              {isAiTurn ? 'Thinking...' : `Moves: ${moveCount}`}
            </span>
          </div>
        </>
      )}

      {/* Won phase */}
      {phase === 'won' && (
        <div
          className="flex flex-col items-center gap-4"
          data-testid="mini-game-won"
        >
          <p className="text-2xl font-bold">You Won!</p>
          <StarDisplay earned={stars} total={3} size="lg" />
          <div
            className="rounded-2xl p-5 border-2 text-center max-w-md"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
            }}
          >
            <p className="text-base leading-relaxed">{config.storyWin}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleRestart}
              className="px-5 py-2.5 rounded-xl font-semibold"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
              }}
              data-testid="mini-game-replay"
            >
              Play Again
            </button>
            <button
              onClick={handleNextLevel}
              className="px-5 py-2.5 rounded-xl font-bold"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="mini-game-next"
            >
              {levelNum < 3 ? 'Next Level' : 'Back to Games'}
            </button>
          </div>
        </div>
      )}

      {/* Lost phase */}
      {phase === 'lost' && (
        <div
          className="flex flex-col items-center gap-4"
          data-testid="mini-game-lost"
        >
          <p className="text-2xl font-bold">You Lost!</p>
          <div
            className="rounded-2xl p-5 border-2 text-center max-w-md"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
            }}
          >
            <p className="text-base leading-relaxed">{config.storyLoss}</p>
          </div>
          <button
            onClick={handleRestart}
            className="px-6 py-3 rounded-xl font-bold text-lg"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            data-testid="mini-game-retry"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
