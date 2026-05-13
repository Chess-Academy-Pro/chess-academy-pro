// ConsistentChessboard — the single board facade used everywhere in the app.
//
// Two usage modes:
//   1. Controlled mode  — pass a `game` from useChessGame(); forwards to ControlledChessBoard.
//                         Use this for any interactive lesson/coach/play screen.
//   2. Static mode      — pass a `fen`, optional handlers, and optional arrows/highlights/
//                         squareStyles. Use this for inline boards that own their own
//                         chess instance (memory drills, kid games, model-game viewers).
//
// In both modes the board's piece set, square colors, glow, animation duration, and
// promotion behavior are pinned to the values from useBoardTheme(). Callers cannot
// override appearance — that is the point.
//
// Static mode also auto-derives the controlled-mode chrome (move sound, last-move
// highlight, check-square red) from FEN deltas so endgame / openings / kid surfaces
// pick up the same visual signature as teach/play. Opt out per board via
// `enableMoveSound={false}` / `showLastMoveHighlight={false}`.

import { useMemo, useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type {
  PieceDropHandlerArgs,
  SquareHandlerArgs,
  PieceHandlerArgs,
} from 'react-chessboard';
import { ControlledChessBoard, type ControlledChessBoardProps, pieceAnimationSpeedToMs } from '../Board/ControlledChessBoard';
import { useBoardTheme, BOARD_ANIMATION_MS } from '../../hooks/useBoardTheme';
import { buildGlowSquareStyles } from '../../hooks/useBoardGlow';
import { usePieceSound } from '../../hooks/usePieceSound';
import { detectMoveFromFen } from '../../utils/boardMoveDetect';
import { useSettings } from '../../hooks/useSettings';

export type BoardArrow = { startSquare: string; endSquare: string; color: string };
export type BoardHighlight = { square: string; color: string };

interface ControlledModeProps extends ControlledChessBoardProps {
  /** Controlled mode marker — `game` is required by ControlledChessBoardProps. */
  fen?: never;
}

/** A piece-square map alternative to FEN, used by Kid games that render only a few pieces. */
export type PiecePositionMap = Record<string, { pieceType: string }>;

interface StaticModeProps {
  /** A position — either a FEN string or a piece-square map.
   *  Mutually exclusive with `game`. */
  fen: string | PiecePositionMap;
  game?: never;
  boardOrientation?: 'white' | 'black';
  /** Whether dragging is allowed. Defaults to false (static mode is usually display-only). */
  interactive?: boolean;
  arrows?: BoardArrow[];
  /** Extra per-square styles (e.g. selection, legal-move dots). Merged on top of the
   *  base glow styles so callers don't lose the consistent look. */
  squareStyles?: Record<string, CSSProperties>;
  onPieceDrop?: (args: PieceDropHandlerArgs) => boolean;
  onSquareClick?: (args: SquareHandlerArgs) => void;
  onPieceDrag?: (args: PieceHandlerArgs) => void;
  /** Override the default animation duration (e.g. 400ms for slow demo boards). */
  animationDurationInMs?: number;
  className?: string;
  /** Content rendered on top of the board (flash overlays, hint badges, etc.). */
  overlay?: ReactNode;
  /** Auto-play piece sound on detected FEN moves. Default true. Set false when the
   *  parent already pumps `usePieceSound().playMoveSound(san)` to avoid doubling up. */
  enableMoveSound?: boolean;
  /** Apply the cyan last-move highlight on detected from/to squares. Default true. */
  showLastMoveHighlight?: boolean;
  /** Highlight the king square red when the side-to-move is in check. Default true. */
  showCheckHighlight?: boolean;
}

export type ConsistentChessboardProps = ControlledModeProps | StaticModeProps;

function isControlled(props: ConsistentChessboardProps): props is ControlledModeProps {
  return 'game' in props && props.game !== undefined;
}

export function ConsistentChessboard(props: ConsistentChessboardProps): JSX.Element {
  if (isControlled(props)) {
    return <ControlledChessBoard {...props} />;
  }
  return <StaticBoard {...props} />;
}

const LAST_MOVE_FROM_STYLE: CSSProperties = {
  background: 'rgba(0, 229, 255, 0.2)',
  boxShadow: 'inset 0 0 12px rgba(0, 229, 255, 0.15)',
};
const LAST_MOVE_TO_STYLE: CSSProperties = {
  background: 'rgba(0, 229, 255, 0.25)',
  boxShadow: 'inset 0 0 12px rgba(0, 229, 255, 0.2)',
};
const CHECK_SQUARE_STYLE: CSSProperties = {
  background:
    'radial-gradient(circle, rgba(255,48,48,0.85) 40%, rgba(255,48,48,0.3) 100%)',
};

function findCheckSquare(fen: string | undefined): string | null {
  if (!fen) return null;
  try {
    const chess = new Chess(fen);
    if (!chess.inCheck()) return null;
    const board = chess.board();
    const turn = chess.turn();
    for (const row of board) {
      for (const piece of row) {
        if (piece?.type === 'k' && piece.color === turn) {
          return piece.square;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function StaticBoard({
  fen: position,
  boardOrientation = 'white',
  interactive = false,
  arrows,
  squareStyles,
  onPieceDrop,
  onSquareClick,
  onPieceDrag,
  animationDurationInMs,
  className = '',
  overlay,
  enableMoveSound = true,
  showLastMoveHighlight = true,
  showCheckHighlight = true,
}: StaticModeProps): JSX.Element {
  const theme = useBoardTheme();
  const { settings } = useSettings();
  const { playMoveSound } = usePieceSound();

  // Explicit prop > user setting > BOARD_ANIMATION_MS default. Static
  // boards can still override (e.g. demo boards at 400ms for clarity).
  const effectiveAnimationMs =
    animationDurationInMs ?? pieceAnimationSpeedToMs(settings.pieceAnimationSpeed) ?? BOARD_ANIMATION_MS;
  const dragAllowed = interactive && settings.moveMethod !== 'click';

  const fenString = typeof position === 'string' ? position : null;
  const prevFenRef = useRef<string | null>(fenString);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    const prev = prevFenRef.current;
    const next = fenString;
    if (next === prev) return;
    const detected = detectMoveFromFen(prev, next);
    if (detected) {
      if (enableMoveSound) {
        const sanShape =
          detected.sound === 'castle'
            ? 'O-O'
            : detected.sound === 'capture'
              ? `${detected.from[0]}x${detected.to}`
              : detected.sound === 'check'
                ? `${detected.to}+`
                : detected.to;
        playMoveSound(sanShape);
      }
      if (showLastMoveHighlight) {
        setLastMove({ from: detected.from, to: detected.to });
      }
    } else {
      setLastMove(null);
    }
    prevFenRef.current = next;
  }, [fenString, enableMoveSound, showLastMoveHighlight, playMoveSound]);

  const checkSquare = useMemo(
    () => (showCheckHighlight ? findCheckSquare(fenString ?? undefined) : null),
    [fenString, showCheckHighlight],
  );

  const mergedSquareStyles = useMemo((): Record<string, CSSProperties> => {
    const base = buildGlowSquareStyles(theme.baseGlow);
    if (lastMove) {
      base[lastMove.from] = { ...base[lastMove.from], ...LAST_MOVE_FROM_STYLE };
      base[lastMove.to] = { ...base[lastMove.to], ...LAST_MOVE_TO_STYLE };
    }
    if (squareStyles) {
      for (const [square, style] of Object.entries(squareStyles)) {
        base[square] = { ...base[square], ...style };
      }
    }
    if (checkSquare) {
      base[checkSquare] = { ...base[checkSquare], ...CHECK_SQUARE_STYLE };
    }
    return base;
  }, [theme.baseGlow, squareStyles, lastMove, checkSquare]);

  return (
    <div
      className={`relative ${className}`}
      data-testid="consistent-chessboard-static"
      style={theme.borderWrapperStyle}
    >
      <Chessboard
        options={{
          position,
          boardOrientation,
          allowDragging: dragAllowed,
          dragActivationDistance: 5,
          animationDurationInMs: effectiveAnimationMs,
          showNotation: settings.showCoordinates,
          darkSquareStyle: theme.darkSquareStyle,
          lightSquareStyle: theme.lightSquareStyle,
          squareStyles: mergedSquareStyles,
          ...(theme.customPieces ? { pieces: theme.customPieces } : {}),
          ...(arrows !== undefined
            ? { arrows, clearArrowsOnPositionChange: true }
            : {}),
          ...(onPieceDrop ? { onPieceDrop } : {}),
          ...(onSquareClick ? { onSquareClick } : {}),
          ...(onPieceDrag ? { onPieceDrag } : {}),
        }}
      />
      {overlay}
    </div>
  );
}
