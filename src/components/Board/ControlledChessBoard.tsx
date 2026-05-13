import { useMemo, useCallback, useState, useEffect } from 'react';
import { Chessboard } from 'react-chessboard';
import { RotateCcw, SkipBack, RefreshCw } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { usePieceSound } from '../../hooks/usePieceSound';
import { useSettings } from '../../hooks/useSettings';
import { useBoardGlow } from '../../hooks/useBoardGlow';
import { getBoardColor } from '../../services/boardColorService';
import { buildPieceRenderer } from '../../services/pieceSetService';
import { buildPieceGlowFilter } from '../../utils/neonColors';
import { EvalBar } from './EvalBar';
import { VoiceChatMic } from './VoiceChatMic';
import type { EngineSnapshot, LastMoveContext } from './VoiceChatMic';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { UseChessGameReturn, MoveResult } from '../../hooks/useChessGame';
import { GhostPieceOverlay } from './GhostPieceOverlay';
import type {
  PieceDropHandlerArgs,
  SquareHandlerArgs,
  PieceHandlerArgs,
} from 'react-chessboard';
import type { GhostMoveData, PieceAnimationSpeed } from '../../types';
import type { MoveQuality } from './ChessBoard';

/** Maps the user's Piece Animation setting to a millisecond duration
 *  for react-chessboard. The 'none' option fast-forwards animation;
 *  'slow' gives beginners more time to follow what just moved. */
export function pieceAnimationSpeedToMs(speed: PieceAnimationSpeed): number {
  switch (speed) {
    case 'none': return 0;
    case 'fast': return 100;
    case 'medium': return 200;
    case 'slow': return 400;
  }
}

export interface ControlledChessBoardProps {
  /** The game object from useChessGame(), owned by the parent. */
  game: UseChessGameReturn;
  /** Override the displayed position without mutating game state (e.g. move navigation). */
  positionOverride?: string;
  interactive?: boolean;
  showFlipButton?: boolean;
  showUndoButton?: boolean;
  showResetButton?: boolean;
  showEvalBar?: boolean;
  evaluation?: number | null;
  isMate?: boolean;
  mateIn?: number | null;
  onMove?: (move: MoveResult) => void;
  onUndo?: () => void;
  onReset?: () => void;
  className?: string;
  highlightSquares?: { from: string; to: string } | null;
  showLastMoveHighlight?: boolean;
  moveQualityFlash?: MoveQuality;
  arrows?: Array<{ startSquare: string; endSquare: string; color: string }>;
  annotationHighlights?: Array<{ square: string; color: string }>;
  ghostMove?: GhostMoveData | null;
  classificationOverlay?: { square: string; symbol: string; color: string } | null;
  showVoiceMic?: boolean;
  pgnForChat?: string;
  onOpeningRequest?: (openingName: string) => void;
  voiceEngineSnapshot?: EngineSnapshot | null;
  voiceLastMoveContext?: LastMoveContext | null;
  voicePlayerColor?: 'white' | 'black';
  onVoiceActiveChange?: (active: boolean) => void;
  onVoiceArrows?: (arrows: Array<{ startSquare: string; endSquare: string; color: string }>) => void;
}

const FLASH_COLORS: Record<string, string> = {
  good: 'rgba(34, 197, 94, 0.95)',
  inaccuracy: 'rgba(245, 158, 11, 0.95)',
  blunder: 'rgba(239, 68, 68, 0.95)',
};

export function ControlledChessBoard({
  game,
  positionOverride,
  interactive = true,
  showFlipButton = true,
  showUndoButton = false,
  showResetButton = false,
  showEvalBar = false,
  evaluation = null,
  isMate = false,
  mateIn = null,
  onMove,
  onUndo,
  onReset,
  className = '',
  highlightSquares = null,
  /** Overrides the user's "Highlight Last Move" setting (Settings →
   *  Board). Callers that want to force highlights on/off (e.g. demo
   *  boards) pass an explicit boolean; otherwise the setting wins. */
  showLastMoveHighlight,
  moveQualityFlash = null,
  arrows,
  annotationHighlights,
  ghostMove,
  classificationOverlay = null,
  showVoiceMic = true,
  pgnForChat,
  onOpeningRequest,
  voiceEngineSnapshot,
  voiceLastMoveContext,
  voicePlayerColor,
  onVoiceActiveChange,
  onVoiceArrows,
}: ControlledChessBoardProps): JSX.Element {
  const { playMoveSound } = usePieceSound();
  const { settings } = useSettings();
  const isMobile = useIsMobile();

  // Resolve the board-display settings here so the rest of the
  // component can ignore where they came from. Explicit prop overrides
  // win; otherwise we read the user's Settings → Board preferences.
  const effectiveShowLastMoveHighlight = showLastMoveHighlight ?? settings.highlightLastMove;
  const effectiveShowLegalMoves = settings.showLegalMoves;
  const effectiveShowCoordinates = settings.showCoordinates;
  const effectiveAnimationMs = pieceAnimationSpeedToMs(settings.pieceAnimationSpeed);
  const dragAllowed = interactive && settings.moveMethod !== 'click';

  // Board color + piece set from settings
  const boardColorScheme = useMemo(() => getBoardColor(settings.boardColor), [settings.boardColor]);
  const pieceFilters = useMemo(() => ({
    whitePieceFilter: buildPieceGlowFilter(settings.whitePieceGlowColor, settings.glowBrightness) || boardColorScheme.whitePieceFilter,
    blackPieceFilter: buildPieceGlowFilter(settings.blackPieceGlowColor, settings.glowBrightness) || boardColorScheme.blackPieceFilter,
  }), [settings.whitePieceGlowColor, settings.blackPieceGlowColor, settings.glowBrightness, boardColorScheme]);
  const customPieces = useMemo(
    () => buildPieceRenderer(settings.pieceSet, pieceFilters),
    [settings.pieceSet, pieceFilters],
  );

  // Board border flash
  const [flashColor, setFlashColor] = useState<string | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // Honor the user's Settings → Board → Move Quality Flash toggle.
    // When the setting is off, ignore the caller's quality classification
    // and never flash the border. This is the standard chess.com /
    // Lichess "subtle feedback" toggle.
    if (!moveQualityFlash || !settings.moveQualityFlash) {
      setFlashColor(null);
      return;
    }
    setFlashColor(FLASH_COLORS[moveQualityFlash] ?? null);
    const timer = setTimeout(() => setFlashColor(null), 900);
    return () => clearTimeout(timer);
  }, [moveQualityFlash, settings.moveQualityFlash]);

  // Move handlers — delegate to parent-owned game object
  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!interactive || !targetSquare) {
        game.clearSelection();
        return false;
      }
      const result = game.onDrop(sourceSquare, targetSquare);
      if (result) {
        onMove?.(result);
        playMoveSound(result.san);
      } else {
        game.clearSelection();
      }
      return result !== null;
    },
    [interactive, game, onMove, playMoveSound],
  );

  const handleSquareClick = useCallback(
    ({ square }: SquareHandlerArgs): void => {
      if (!interactive) return;
      // Drag-only mode: ignore square clicks so the user can't
      // tap-to-select-then-tap-to-place when they've explicitly
      // chosen drag-only (Settings → Board → Move Method).
      if (settings.moveMethod === 'drag') return;
      const result = game.onSquareClick(square);
      if (result) {
        onMove?.(result);
        playMoveSound(result.san);
      }
    },
    [interactive, game, onMove, playMoveSound, settings.moveMethod],
  );

  const handlePieceDrag = useCallback(
    ({ square }: PieceHandlerArgs): void => {
      if (!interactive || !square) return;
      game.onSquareClick(square);
    },
    [interactive, game],
  );

  const handleUndo = useCallback((): void => {
    game.undoMove();
    onUndo?.();
  }, [game, onUndo]);

  const handleReset = useCallback((): void => {
    game.resetGame();
    onReset?.();
  }, [game, onReset]);

  // Square highlight styles
  const { lastMove, checkSquare, selectedSquare, legalMoves, getPiece } = game;

  // Board square neon glow from user settings
  const { baseGlow: baseGlowStr, mergeGlow } = useBoardGlow();

  const customSquareStyles = useMemo((): Record<string, React.CSSProperties> => {
    const styles: Record<string, React.CSSProperties> = {};

    // Apply per-square neon glow outlines
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const file of files) {
      for (const rank of ranks) {
        const sq = `${file}${rank}`;
        if (baseGlowStr) {
          styles[sq] = { boxShadow: baseGlowStr };
        }
      }
    }

    const centerSquares = ['e4', 'd4', 'e5', 'd5'];
    for (const sq of centerSquares) {
      styles[sq] = { ...styles[sq], boxShadow: mergeGlow('inset 0 0 8px 2px rgba(0, 229, 255, 0.08)') };
    }

    if (effectiveShowLastMoveHighlight) {
      const moveHighlight = lastMove ?? highlightSquares;
      if (moveHighlight) {
        styles[moveHighlight.from] = { ...styles[moveHighlight.from], background: 'rgba(0, 229, 255, 0.2)', boxShadow: mergeGlow('inset 0 0 12px rgba(0, 229, 255, 0.15)') };
        styles[moveHighlight.to] = { ...styles[moveHighlight.to], background: 'rgba(0, 229, 255, 0.25)', boxShadow: mergeGlow('inset 0 0 12px rgba(0, 229, 255, 0.2)') };
      }
    }

    if (annotationHighlights) {
      for (const h of annotationHighlights) {
        styles[h.square] = {
          ...styles[h.square],
          boxShadow: mergeGlow(`inset 0 0 0 3px ${h.color}`),
        };
      }
    }

    if (checkSquare) {
      styles[checkSquare] = {
        ...styles[checkSquare],
        background:
          'radial-gradient(circle, rgba(255,48,48,0.85) 40%, rgba(255,48,48,0.3) 100%)',
      };
    }

    if (selectedSquare) {
      styles[selectedSquare] = { ...styles[selectedSquare], background: 'rgba(0, 229, 255, 0.35)', boxShadow: mergeGlow('inset 0 0 8px rgba(0, 229, 255, 0.4)') };
    }

    if (effectiveShowLegalMoves) {
      for (const sq of legalMoves) {
        const hasPiece = getPiece(sq);
        if (hasPiece) {
          styles[sq] = {
            ...styles[sq],
            background:
              'radial-gradient(circle, rgba(0,0,0,0) 60%, rgba(0, 229, 255, 0.3) 60%, rgba(0, 229, 255, 0.3) 80%, rgba(0,0,0,0) 80%)',
            cursor: 'pointer',
          };
        } else {
          styles[sq] = {
            ...styles[sq],
            background: 'radial-gradient(circle, rgba(0, 229, 255, 0.3) 25%, transparent 25%)',
            cursor: 'pointer',
          };
        }
      }
    }

    return styles;
  }, [lastMove, highlightSquares, checkSquare, selectedSquare, legalMoves, getPiece, effectiveShowLastMoveHighlight, effectiveShowLegalMoves, annotationHighlights, baseGlowStr, mergeGlow]);

  const hasControls = showFlipButton || showUndoButton || showResetButton || showVoiceMic;

  return (
    <div
      className={`flex flex-col ${className}`}
      data-testid="chess-board-container"
    >
      {showEvalBar && isMobile && (
        <EvalBar
          evaluation={evaluation}
          isMate={isMate}
          mateIn={mateIn}
          horizontal
        />
      )}

      <div className="relative flex items-stretch gap-1">
        {showEvalBar && !isMobile && (
          <EvalBar
            evaluation={evaluation}
            isMate={isMate}
            mateIn={mateIn}
            className="self-stretch"
          />
        )}

        <div
          className="relative flex-1"
          data-testid="board-wrapper"
          style={boardColorScheme.borderGlow
            ? {
                boxShadow: `${boardColorScheme.borderGlow}, inset 0 0 40px 8px rgba(0, 229, 255, 0.06)`,
                borderRadius: '4px',
                border: '1px solid rgba(0, 229, 255, 0.15)',
              }
            : undefined
          }
        >
          <Chessboard
            options={{
              position: positionOverride ?? game.position,
              boardOrientation: game.boardOrientation,
              squareStyles: customSquareStyles,
              darkSquareStyle: { backgroundColor: boardColorScheme.darkSquare },
              lightSquareStyle: { backgroundColor: boardColorScheme.lightSquare },
              ...(customPieces ? { pieces: customPieces } : {}),
              allowDragging: dragAllowed,
              dragActivationDistance: 5,
              animationDurationInMs: effectiveAnimationMs,
              showNotation: effectiveShowCoordinates,
              onPieceDrop: handlePieceDrop,
              onSquareClick: handleSquareClick,
              onPieceDrag: handlePieceDrag,
              ...(arrows && arrows.length > 0 ? { arrows, clearArrowsOnPositionChange: true } : {}),
            }}
          />
          {flashColor && (
            <div
              className={`absolute inset-0 pointer-events-none rounded-sm ${prefersReducedMotion ? '' : 'animate-pulse'}`}
              style={{ boxShadow: `inset 0 0 0 8px ${flashColor}, 0 0 24px 6px ${flashColor}` }}
              data-testid="move-quality-flash"
            />
          )}
          {ghostMove && (
            <GhostPieceOverlay
              ghostMove={ghostMove}
              boardOrientation={game.boardOrientation}
              pieceSet={settings.pieceSet}
            />
          )}
          {classificationOverlay && (
            <ClassificationBadge
              square={classificationOverlay.square}
              symbol={classificationOverlay.symbol}
              color={classificationOverlay.color}
              boardOrientation={game.boardOrientation}
            />
          )}
        </div>
      </div>

      {hasControls && (
        <div className="flex justify-center gap-2 mt-2" data-testid="board-controls">
          {showResetButton && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-theme-surface hover:bg-theme-border text-theme-text-muted hover:text-theme-text text-sm transition-colors"
              title="New game"
              aria-label="New game"
              data-testid="reset-button"
            >
              <RefreshCw size={14} />
              <span>Reset</span>
            </button>
          )}
          {showUndoButton && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-theme-surface hover:bg-theme-border text-theme-text-muted hover:text-theme-text text-sm transition-colors"
              title="Undo last move"
              aria-label="Undo last move"
              data-testid="undo-button"
            >
              <SkipBack size={14} />
              <span>Undo</span>
            </button>
          )}
          {showFlipButton && (
            <button
              onClick={game.flipBoard}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-theme-surface hover:bg-theme-border text-theme-text-muted hover:text-theme-text text-sm transition-colors"
              title="Flip board"
              aria-label="Flip board"
              data-testid="flip-button"
            >
              <RotateCcw size={14} />
              <span>Flip</span>
            </button>
          )}
          {showVoiceMic && (
            <VoiceChatMic
              fen={game.position}
              pgn={pgnForChat}
              turn={game.turn}
              onOpeningRequest={onOpeningRequest}
              engineSnapshot={voiceEngineSnapshot}
              lastMoveContext={voiceLastMoveContext}
              playerColor={voicePlayerColor}
              onListeningChange={onVoiceActiveChange}
              onArrows={onVoiceArrows}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Re-use the ClassificationBadge from ChessBoard — identical implementation
import { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ClassificationBadgeProps {
  square: string;
  symbol: string;
  color: string;
  boardOrientation: 'white' | 'black';
}

function squareToPosition(
  square: string,
  boardOrientation: 'white' | 'black',
): { left: string; top: string } {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;

  const col = boardOrientation === 'white' ? file : 7 - file;
  const row = boardOrientation === 'white' ? 7 - rank : rank;

  return {
    left: `${(col + 0.5) * 12.5}%`,
    top: `${(row + 0.1) * 12.5}%`,
  };
}

const ClassificationBadge = memo(function ClassificationBadge({
  square,
  symbol,
  color,
  boardOrientation,
}: ClassificationBadgeProps): JSX.Element {
  const pos = squareToPosition(square, boardOrientation);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={`${square}-${symbol}`}
        className="absolute pointer-events-none"
        style={{
          left: pos.left,
          top: pos.top,
          transform: 'translate(-50%, -50%)',
          zIndex: 10,
        }}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        data-testid="classification-badge"
      >
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow-md"
          style={{ background: color }}
        >
          {symbol}
        </div>
      </motion.div>
    </AnimatePresence>
  );
});
