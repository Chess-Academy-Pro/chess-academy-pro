import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { BoardVoiceOverlay } from '../Board/BoardVoiceOverlay';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { voiceService } from '../../services/voiceService';
import { getKnightMoves } from '../../utils/knightMoves';
import {
  LEAP_FROG_LEVELS,
  KNIGHT_START_SQUARE,
  TREASURE_SQUARE,
} from '../../data/knightGameLevels';
import type { SquareHandlerArgs } from 'react-chessboard';

type GameState = 'levelSelect' | 'playing' | 'won' | 'lost';

export function LeapFrogGame(): JSX.Element {
  const navigate = useNavigate();

  const [gameState, setGameState] = useState<GameState>('levelSelect');
  const [currentLevelIdx, setCurrentLevelIdx] = useState(0);
  const [knightSquare, setKnightSquare] = useState(KNIGHT_START_SQUARE);
  const [moveCount, setMoveCount] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const level = LEAP_FROG_LEVELS[currentLevelIdx];
  const dangerSet = useMemo(() => new Set(level.dangerSquares), [level]);
  const friendlySet = useMemo(
    () => new Set(level.friendlyPieces.map((p) => p.square)),
    [level],
  );

  const validMoves = useMemo(() => {
    if (gameState !== 'playing') return [];
    return getKnightMoves(knightSquare).filter(
      (sq) => !dangerSet.has(sq) && !friendlySet.has(sq),
    );
  }, [knightSquare, dangerSet, friendlySet, gameState]);

  const position = useMemo((): Record<string, { pieceType: string }> => {
    const pos: Record<string, { pieceType: string }> = {};
    pos[knightSquare] = { pieceType: 'wN' };
    for (const fp of level.friendlyPieces) {
      pos[fp.square] = { pieceType: fp.piece };
    }
    return pos;
  }, [knightSquare, level]);

  const squareStyles = useMemo((): Record<string, React.CSSProperties> => {
    const styles: Record<string, React.CSSProperties> = {};

    if (level.showTreasureGlow) {
      styles[TREASURE_SQUARE] = {
        background:
          'radial-gradient(circle, rgba(255, 215, 0, 0.8) 40%, rgba(255, 215, 0, 0.3) 100%)',
        boxShadow: 'inset 0 0 20px rgba(255, 215, 0, 0.6)',
      };
    } else {
      styles[TREASURE_SQUARE] = {
        background: 'rgba(255, 215, 0, 0.3)',
      };
    }

    if (level.showDangerHighlights) {
      for (const sq of level.dangerSquares) {
        styles[sq] = {
          background: 'rgba(239, 68, 68, 0.5)',
        };
      }
    }

    if (level.showValidMoveHighlights && gameState === 'playing') {
      for (const sq of validMoves) {
        if (sq === TREASURE_SQUARE) {
          styles[sq] = {
            background:
              'radial-gradient(circle, rgba(255, 215, 0, 0.8) 40%, rgba(255, 215, 0, 0.3) 100%)',
            boxShadow:
              'inset 0 0 0 4px rgba(34, 197, 94, 0.8), inset 0 0 20px rgba(255, 215, 0, 0.6)',
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

    // Knight square highlight
    if (gameState === 'playing') {
      styles[knightSquare] = {
        ...styles[knightSquare],
        background: 'rgba(59, 130, 246, 0.4)',
      };
    }

    return styles;
  }, [level, validMoves, gameState, knightSquare]);

  const kidSpeak = useCallback(
    (text: string): void => {
      if (!voiceOn) return;
      void voiceService.speak(text);
    },
    [voiceOn],
  );

  const startLevel = useCallback(
    (idx: number): void => {
      setCurrentLevelIdx(idx);
      setKnightSquare(KNIGHT_START_SQUARE);
      setMoveCount(0);
      setFeedback(null);
      setGameState('playing');
      kidSpeak(
        `Level ${idx + 1}! Get your knight from e1 to the treasure on e8. Watch out for danger zones!`,
      );
    },
    [kidSpeak],
  );

  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (gameState !== 'playing') return;

      const knightMoves = getKnightMoves(knightSquare);
      if (!knightMoves.includes(square)) return;

      if (dangerSet.has(square)) {
        setFeedback('Danger zone! Try another square.');
        kidSpeak('Danger! That square is not safe.');
        setTimeout(() => setFeedback(null), 1500);
        return;
      }

      if (friendlySet.has(square)) {
        setFeedback('A friendly piece is there!');
        kidSpeak('A friend is on that square.');
        setTimeout(() => setFeedback(null), 1500);
        return;
      }

      const newMoveCount = moveCount + 1;
      setKnightSquare(square);
      setMoveCount(newMoveCount);
      setFeedback(null);

      if (square === TREASURE_SQUARE) {
        setGameState('won');
        kidSpeak(`Amazing! You found the treasure in ${newMoveCount} moves!`);
        return;
      }

      const nextMoves = getKnightMoves(square);
      const nextValid = nextMoves.filter(
        (sq) => !dangerSet.has(sq) && !friendlySet.has(sq),
      );
      if (nextValid.length === 0) {
        setGameState('lost');
        kidSpeak('Oh no! The knight is stuck. Try again!');
      }
    },
    [gameState, knightSquare, dangerSet, friendlySet, moveCount, kidSpeak],
  );

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  if (gameState === 'levelSelect') {
    return (
      <div
        className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-6"
        style={{ color: 'var(--color-text)' }}
        data-testid="leap-frog-level-select"
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
          <h2 className="text-xl font-bold">Leap Frog</h2>
        </div>
        <p
          className="text-center"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Guide the knight from e1 to the treasure on e8!
        </p>
        <div className="flex flex-col gap-3">
          {LEAP_FROG_LEVELS.map((l, idx) => (
            <button
              key={l.level}
              onClick={() => startLevel(idx)}
              className="rounded-xl p-5 border-2 flex items-center gap-4 hover:opacity-80 transition-opacity w-full text-left"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-accent)',
              }}
              data-testid={`leap-frog-level-${l.level}`}
            >
              <span className="text-2xl">
                {l.level === 1 && '🌿'}
                {l.level === 2 && '🌲'}
                {l.level === 3 && '🌑'}
              </span>
              <div className="flex-1">
                <div className="font-bold text-lg">
                  Level {l.level} — {l.name}
                </div>
                <div
                  className="text-sm"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {l.level === 1 && 'Danger zones shown, valid moves highlighted'}
                  {l.level === 2 && 'Danger zones shown, no move hints'}
                  {l.level === 3 && 'No highlights — find the only path!'}
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
      className="flex flex-col gap-4 p-6 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="leap-frog-game"
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
            Leap Frog — Level {level.level}
          </h2>
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
        <p className="text-lg font-bold">
          Moves: {moveCount} · Get to e8!
        </p>
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          className="text-center text-lg font-bold animate-pulse"
          style={{ color: 'var(--color-error)' }}
          data-testid="leap-frog-feedback"
        >
          {feedback}
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
          data-testid="leap-frog-win"
        >
          <div className="text-4xl mb-2">💎</div>
          <div className="text-xl font-bold mb-1">Treasure Found!</div>
          <div
            className="text-sm mb-4"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Completed in {moveCount} moves
          </div>
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
            {currentLevelIdx < LEAP_FROG_LEVELS.length - 1 ? (
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

      {/* Lose overlay */}
      {gameState === 'lost' && (
        <div
          className="rounded-2xl p-6 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-error, var(--color-accent))',
          }}
          data-testid="leap-frog-lose"
        >
          <div className="text-4xl mb-2">🛑</div>
          <div className="text-xl font-bold mb-1">Knight is Stuck!</div>
          <div
            className="text-sm mb-4"
            style={{ color: 'var(--color-text-muted)' }}
          >
            No valid moves remaining
          </div>
          <button
            onClick={() => startLevel(currentLevelIdx)}
            className="px-4 py-2 rounded-lg font-semibold"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
            }}
            data-testid="try-again-btn"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Board */}
      <BoardVoiceOverlay fen={position} className="w-full md:max-w-[420px] mx-auto">
        <div className="relative">
          <ConsistentChessboard
            fen={position}
            boardOrientation="white"
            squareStyles={squareStyles}
            onSquareClick={handleSquareClick}
          />
          {/* Treasure icon overlay on e8 */}
          <div
            className="absolute inset-0 pointer-events-none grid grid-cols-8 grid-rows-8"
            data-testid="treasure-overlay"
          >
            <div
              style={{ gridColumn: 5, gridRow: 1 }}
              className="flex items-center justify-center text-2xl sm:text-3xl"
              data-testid="treasure-icon"
            >
              💎
            </div>
          </div>
        </div>
      </BoardVoiceOverlay>
    </div>
  );
}
