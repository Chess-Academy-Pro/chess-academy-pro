// KidChessboard — the single chessboard facade for /kid/* surfaces.
//
// Per CLAUDE.md "Kids section non-negotiables" #12: this is the only
// board allowed under /kid/. It wraps the appropriate underlying
// primitive based on which props are passed, and locks down the
// "adult app" affordances kids don't need:
//   - flip / undo / reset buttons (always off)
//   - eval bar (never)
//   - arrows-on-hover, move-quality flash, hint ghost pieces (never)
//   - coordinate labels (default off — togglable later if needed)
//
// Three call shapes, mapping to the three current kid use cases:
//   1. controlled mode — `{ game }` from useChessGame()
//      → ControlledChessBoard (KidPiecePage, GameChapterPage lesson view)
//   2. chess.js-validating — `{ initialFen, onMove, ... }`
//      → Board/ChessBoard (KingMarch, KingEscape, ColorWars,
//        BishopVsPawns, MiniGamePage, GuidedGamePage)
//   3. static display — `{ fen }` only
//      → ConsistentChessboard static mode (KidModePage Find-the-King
//        background board)
//
// Adding new kid surfaces? Import from here. Do NOT import
// ControlledChessBoard, ChessBoard, or react-chessboard directly under
// src/components/Kid/.

import type { CSSProperties } from 'react';
import type { SquareHandlerArgs } from 'react-chessboard';
import { ChessBoard, type ChessBoardProps } from '../Board/ChessBoard';
import {
  ControlledChessBoard,
  type ControlledChessBoardProps,
} from '../Board/ControlledChessBoard';
import { ConsistentChessboard } from './ConsistentChessboard';
import type { PiecePositionMap } from './ConsistentChessboard';

type ControlledKidProps = Omit<
  ControlledChessBoardProps,
  'showFlipButton' | 'showUndoButton' | 'showResetButton' | 'showEvalBar'
>;

type ValidatingKidProps = Omit<
  ChessBoardProps,
  'showFlipButton' | 'showUndoButton' | 'showResetButton' | 'showEvalBar' | 'evaluation' | 'isMate' | 'mateIn' | 'moveQualityFlash'
> & {
  /** Required: the puzzle / mini-game starting position. */
  initialFen: string;
};

interface StaticKidProps {
  fen: string | PiecePositionMap;
  boardOrientation?: 'white' | 'black';
  interactive?: boolean;
  className?: string;
  /** Click handler for square-tap interactions on a static board
   *  (piece-maze gameplay routes square clicks through here rather
   *  than chess.js move validation). */
  onSquareClick?: (args: SquareHandlerArgs) => void;
  /** Custom per-square styling — e.g. legal-move dots, target tint. */
  squareStyles?: Record<string, CSSProperties>;
}

export type KidChessboardProps =
  | (ControlledKidProps & { game: ControlledChessBoardProps['game']; initialFen?: never; fen?: never })
  | (ValidatingKidProps & { game?: never; fen?: never })
  | (StaticKidProps & { game?: never; initialFen?: never });

function isControlled(
  props: KidChessboardProps,
): props is ControlledKidProps & { game: ControlledChessBoardProps['game'] } {
  return 'game' in props && props.game !== undefined;
}

function isValidating(
  props: KidChessboardProps,
): props is ValidatingKidProps {
  return 'initialFen' in props && typeof props.initialFen === 'string' && !('game' in props && props.game);
}

export function KidChessboard(props: KidChessboardProps): JSX.Element {
  if (isControlled(props)) {
    return (
      <ControlledChessBoard
        {...props}
        showFlipButton={false}
        showUndoButton={false}
        showResetButton={false}
      />
    );
  }
  if (isValidating(props)) {
    return (
      <ChessBoard
        {...props}
        showFlipButton={false}
        showUndoButton={false}
        showResetButton={false}
        showEvalBar={false}
      />
    );
  }
  // Static display mode.
  return (
    <ConsistentChessboard
      fen={props.fen}
      boardOrientation={props.boardOrientation}
      interactive={props.interactive ?? false}
      className={props.className}
      onSquareClick={props.onSquareClick}
      squareStyles={props.squareStyles}
    />
  );
}
