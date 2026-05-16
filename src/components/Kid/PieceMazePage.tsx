import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { SquareHandlerArgs } from 'react-chessboard';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { StarDisplay } from './StarDisplay';
import { voiceService } from '../../services/voiceService';
import { PIECE_MAZE_LEVELS } from '../../data/pieceMazeLevels';
import {
  getPieceLegalMoves,
  buildPieceMazePieceMap,
  completePieceMazeLevel,
} from '../../services/pieceMazeService';
import type { ChessPiece } from '../../types';

// Generic piece-maze surface — routed at /kid/<piece>-games/maze/:level
// for each of the 6 pieces. Pulls level configs from pieceMazeLevels
// keyed by the `piece` prop + URL :level param.
//
// Movement rules are computed by pieceMazeService.getPieceLegalMoves
// (no chess.js — single piece on an empty board, captures don't apply).
// Win = piece reaches target square. Stars from moves-vs-par.

interface Props {
  piece: ChessPiece;
}

const PIECE_LABEL: Record<ChessPiece, string> = {
  king: 'King', queen: 'Queen', rook: 'Rook',
  bishop: 'Bishop', knight: 'Knight', pawn: 'Pawn',
};

const PIECE_HUB_ROUTE: Record<ChessPiece, string> = {
  king: '/kid/king-games',
  queen: '/kid/queen-games',
  rook: '/kid/rook-games',
  bishop: '/kid/bishop-games',
  knight: '/kid/knight-games',
  pawn: '/kid/pawn-games',
};

type Phase = 'playing' | 'won';

export function PieceMazePage({ piece }: Props): JSX.Element {
  const { level: levelParam } = useParams<{ level: string }>();
  const navigate = useNavigate();
  const levelId = parseInt(levelParam ?? '1', 10);
  const level = useMemo(
    () => PIECE_MAZE_LEVELS.find((l) => l.piece === piece && l.id === levelId),
    [piece, levelId],
  );

  const [piecePos, setPiecePos] = useState(level?.pieceStart ?? 'a1');
  const [moveCount, setMoveCount] = useState(0);
  const [phase, setPhase] = useState<Phase>('playing');
  const [voiceOn, setVoiceOn] = useState(true);
  const [stars, setStars] = useState(0);
  const hasSpoken = useRef(false);

  const blockedSet = useMemo(
    () => new Set(level?.obstacles ?? []),
    [level?.obstacles],
  );

  const legalMoves = useMemo(
    () => (phase === 'playing' && level
      ? getPieceLegalMoves(piece, piecePos, blockedSet)
      : []),
    [phase, level, piece, piecePos, blockedSet],
  );
  const legalSet = useMemo(() => new Set(legalMoves), [legalMoves]);

  const pieceMap = useMemo(() => {
    if (!level) return {};
    return buildPieceMazePieceMap(piece, piecePos, level.obstacles);
  }, [piece, piecePos, level]);

  // Welcome line + missing-level redirect.
  useEffect(() => {
    if (!level) {
      void navigate(PIECE_HUB_ROUTE[piece]);
      return;
    }
    if (!hasSpoken.current && voiceOn) {
      hasSpoken.current = true;
      void voiceService.speak(`${PIECE_LABEL[piece]} maze. Reach the target square.`);
    }
  }, [level, piece, voiceOn, navigate]);

  const handleSquareClick = useCallback(({ square }: SquareHandlerArgs): void => {
    if (phase !== 'playing' || !level) return;
    if (!legalSet.has(square)) return;
    const nextMoves = moveCount + 1;
    setPiecePos(square);
    setMoveCount(nextMoves);
    if (square === level.target) {
      setPhase('won');
      void completePieceMazeLevel(piece, level.id, nextMoves, level.par).then((p) => {
        setStars(p.stars);
        if (voiceOn) {
          // Milestone praise per non-negotiable #5 — one short line.
          const msg = p.stars === 3 ? 'Perfect run!'
            : p.stars === 2 ? 'Nicely done.'
            : 'You made it.';
          void voiceService.speak(msg);
        }
      });
    }
  }, [phase, level, legalSet, moveCount, piece, voiceOn]);

  const handleRestart = useCallback((): void => {
    if (!level) return;
    setPiecePos(level.pieceStart);
    setMoveCount(0);
    setPhase('playing');
    setStars(0);
    voiceService.stop();
  }, [level]);

  const handleToggleVoice = useCallback((): void => {
    voiceService.stop();
    setVoiceOn((v) => !v);
  }, []);

  if (!level) return <></>;

  const targetHighlight = { [level.target]: { background: 'rgba(34, 197, 94, 0.35)' } };
  const legalHighlight = Object.fromEntries(
    legalMoves.map((sq) => [sq, { background: 'rgba(59, 130, 246, 0.20)' }]),
  );

  return (
    <div
      className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid={`piece-maze-${piece}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate(PIECE_HUB_ROUTE[piece])}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
            aria-label="Back to hub"
            data-testid="piece-maze-back"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">
            {PIECE_LABEL[piece]} Maze · {level.name}
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
        >
          {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <div className="text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Moves: <span data-testid="piece-maze-move-count">{moveCount}</span>
        {' '}· Par: {level.par}
      </div>

      <div className="w-full md:max-w-[420px] mx-auto">
        <KidChessboard
          fen={pieceMap}
          onSquareClick={phase === 'playing' ? handleSquareClick : undefined}
          interactive={false}
          squareStyles={{ ...legalHighlight, ...targetHighlight }}
        />
      </div>

      {phase === 'won' && (
        <div
          className="rounded-2xl p-6 border-2 text-center"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-accent)',
          }}
          data-testid="piece-maze-won"
        >
          <p className="text-xl font-bold mb-2">You reached the target!</p>
          <StarDisplay earned={stars} total={3} size="lg" />
          <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
            {moveCount} moves · Par {level.par}
          </p>
          <div className="flex gap-3 justify-center mt-4">
            <button
              onClick={handleRestart}
              className="px-4 py-2 rounded-lg font-semibold border"
              style={{ borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }}
              data-testid="piece-maze-replay"
            >
              <RotateCcw size={14} className="inline mr-1" />
              Replay
            </button>
            <button
              onClick={() => void navigate(PIECE_HUB_ROUTE[piece])}
              className="px-4 py-2 rounded-lg font-semibold"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="piece-maze-back-to-hub"
            >
              Back to {PIECE_LABEL[piece]} Games
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
