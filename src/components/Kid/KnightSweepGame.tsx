import { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { BoardVoiceOverlay } from '../Board/BoardVoiceOverlay';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { getKnightMoves } from '../../utils/knightMoves';
import { KNIGHT_SWEEP_LEVELS } from '../../data/knightGameLevels';
import type { SquareHandlerArgs } from 'react-chessboard';

type GameState = 'levelSelect' | 'playing' | 'won';

export function KnightSweepGame(): JSX.Element {
  const navigate = useNavigate();

  const [gameState, setGameState] = useState<GameState>('levelSelect');
  const [currentLevelIdx, setCurrentLevelIdx] = useState(0);
  const [knightSquare, setKnightSquare] = useState('d4');
  const [remainingEnemies, setRemainingEnemies] = useState<
    Array<{ square: string; piece: string }>
  >([]);
  const [moveCount, setMoveCount] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [efficientPopup, setEfficientPopup] = useState(false);
  const efficientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const level = KNIGHT_SWEEP_LEVELS[currentLevelIdx];

  const enemySquareSet = useMemo(
    () => new Set(remainingEnemies.map((e) => e.square)),
    [remainingEnemies],
  );

  const knightMoves = useMemo(
    () => (gameState === 'playing' ? getKnightMoves(knightSquare) : []),
    [knightSquare, gameState],
  );

  const position = useMemo((): Record<string, { pieceType: string }> => {
    const pos: Record<string, { pieceType: string }> = {};
    pos[knightSquare] = { pieceType: 'wN' };
    for (const enemy of remainingEnemies) {
      pos[enemy.square] = { pieceType: enemy.piece };
    }
    return pos;
  }, [knightSquare, remainingEnemies]);

  const squareStyles = useMemo((): Record<string, React.CSSProperties> => {
    const styles: Record<string, React.CSSProperties> = {};

    // Knight square highlight
    if (gameState === 'playing') {
      styles[knightSquare] = {
        background: 'rgba(59, 130, 246, 0.4)',
      };
    }

    // Enemy glow
    if (level.showEnemyGlow) {
      for (const enemy of remainingEnemies) {
        styles[enemy.square] = {
          background:
            'radial-gradient(circle, rgba(239, 68, 68, 0.6) 40%, rgba(239, 68, 68, 0.2) 100%)',
          boxShadow: 'inset 0 0 12px rgba(239, 68, 68, 0.4)',
        };
      }
    }

    // Valid move highlights
    if (level.showValidMoveHighlights && gameState === 'playing') {
      for (const sq of knightMoves) {
        if (enemySquareSet.has(sq)) {
          styles[sq] = {
            ...styles[sq],
            boxShadow:
              'inset 0 0 0 4px rgba(34, 197, 94, 0.8), inset 0 0 12px rgba(239, 68, 68, 0.4)',
          };
        } else {
          styles[sq] = {
            ...styles[sq],
            background:
              'radial-gradient(circle, rgba(34, 197, 94, 0.4) 25%, transparent 25%)',
            cursor: 'pointer',
          };
        }
      }
    }

    return styles;
  }, [level, remainingEnemies, knightMoves, enemySquareSet, knightSquare, gameState]);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  const startLevel = useCallback(
    (idx: number): void => {
      const lvl = KNIGHT_SWEEP_LEVELS[idx];
      setCurrentLevelIdx(idx);
      setKnightSquare(lvl.knightStart);
      setRemainingEnemies([...lvl.enemyPieces]);
      setMoveCount(0);
      setEfficientPopup(false);
      setGameState('playing');
      kidSpeak(
        `Level ${idx + 1}! Capture all ${lvl.enemyPieces.length} enemy pieces. Try to do it in ${lvl.par} moves or fewer!`,
      );
    },
    [kidSpeak],
  );

  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (gameState !== 'playing') return;
      if (!knightMoves.includes(square)) return;

      const newMoveCount = moveCount + 1;
      setMoveCount(newMoveCount);
      setKnightSquare(square);

      // Check capture
      if (enemySquareSet.has(square)) {
        const newEnemies = remainingEnemies.filter((e) => e.square !== square);
        setRemainingEnemies(newEnemies);

        if (newEnemies.length === 0) {
          setGameState('won');
          const rating =
            newMoveCount <= level.par
              ? 'Incredible efficiency!'
              : 'Well done!';
          kidSpeak(
            `All enemies captured in ${newMoveCount} moves! ${rating}`,
          );
          return;
        }

        // Check "Efficient!" — is a remaining enemy one knight-move away?
        const nextKnightMoves = getKnightMoves(square);
        const nextCapture = newEnemies.some((e) =>
          nextKnightMoves.includes(e.square),
        );
        if (nextCapture) {
          setEfficientPopup(true);
          if (efficientTimerRef.current) clearTimeout(efficientTimerRef.current);
          efficientTimerRef.current = setTimeout(
            () => setEfficientPopup(false),
            1200,
          );
        }
      }
    },
    [
      gameState,
      knightMoves,
      moveCount,
      enemySquareSet,
      remainingEnemies,
      level,
      kidSpeak,
    ],
  );

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  if (gameState === 'levelSelect') {
    return (
      <div
        className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
        style={{ color: 'var(--color-text)' }}
        data-testid="knight-sweep-level-select"
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid/knight-games')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">Knight Sweep</h2>
        </div>
        <p
          className="text-center"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Capture all enemy pieces with your knight in as few moves as possible!
        </p>
        <div className="flex flex-col gap-3">
          {KNIGHT_SWEEP_LEVELS.map((l, idx) => (
            <button
              key={l.level}
              onClick={() => startLevel(idx)}
              className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-accent)',
              }}
              data-testid={`knight-sweep-level-${l.level}`}
            >
              <span className="text-2xl">
                {l.level === 1 && '⚔️'}
                {l.level === 2 && '🗡️'}
                {l.level === 3 && '🏰'}
              </span>
              <div className="flex-1">
                <div className="font-bold text-lg">
                  Level {l.level} — {l.name}
                </div>
                <div
                  className="text-sm"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {l.enemyPieces.length} enemies · Par: {l.par} moves
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="knight-sweep-game"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('levelSelect')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back to levels"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">
            Knight Sweep — Level {level.level}
          </h2>
        </div>
        <button
          onClick={handleToggleVoice}
          className="p-2 rounded-lg border transition-colors"
          style={{
            background: voiceOn
              ? 'var(--color-accent)'
              : 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: voiceOn
              ? 'var(--color-bg)'
              : 'var(--color-text-muted)',
          }}
          aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
          data-testid="voice-toggle"
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      {/* Status bar */}
      <div
        className="rounded-2xl p-4 border-2 text-center"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-accent)',
        }}
      >
        <p className="text-lg font-bold" data-testid="move-counter">
          Moves: {moveCount} · Remaining: {remainingEnemies.length} ·
          Par: {level.par}
        </p>
      </div>

      {/* Efficient popup */}
      {efficientPopup && (
        <div
          className="text-center text-xl font-bold animate-bounce"
          style={{ color: 'var(--color-accent)' }}
          data-testid="efficient-popup"
        >
          Efficient!
        </div>
      )}

      {/* Win overlay */}
      {gameState === 'won' && (
        <div
          className="rounded-2xl p-6 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-success, var(--color-accent))',
          }}
          data-testid="knight-sweep-win"
        >
          <div className="text-4xl mb-2">⚔️</div>
          <div className="text-xl font-bold mb-1">All Enemies Captured!</div>
          <div
            className="text-sm mb-2"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Completed in {moveCount} moves (par: {level.par})
          </div>
          {moveCount <= level.par && (
            <div
              className="text-lg font-bold mb-2"
              style={{ color: 'var(--color-accent)' }}
              data-testid="under-par-message"
            >
              Under par! Amazing!
            </div>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => startLevel(currentLevelIdx)}
              className="px-4 py-2 rounded-lg border font-semibold"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
              }}
            >
              Replay
            </button>
            {currentLevelIdx < KNIGHT_SWEEP_LEVELS.length - 1 ? (
              <button
                onClick={() => startLevel(currentLevelIdx + 1)}
                className="px-4 py-2 rounded-lg font-semibold"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg)',
                }}
                data-testid="next-level-btn"
              >
                Next Level
              </button>
            ) : (
              <button
                onClick={() => void navigate('/kid/knight-games')}
                className="px-4 py-2 rounded-lg font-semibold"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg)',
                }}
              >
                All Done!
              </button>
            )}
          </div>
        </div>
      )}

      {/* Board */}
      <BoardVoiceOverlay fen={position} className="w-full md:max-w-[420px] mx-auto">
        <ConsistentChessboard
          fen={position}
          boardOrientation="white"
          squareStyles={squareStyles}
          onSquareClick={handleSquareClick}
        />
      </BoardVoiceOverlay>
    </div>
  );
}
