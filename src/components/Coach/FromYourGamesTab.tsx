/**
 * FromYourGamesTab — personalized practice over the user's
 * imported games. Mines endgame mistakes (queens off OR move ≥30,
 * mistake or blunder classification, eval drop ≥100cp) and
 * surfaces them as practice tiles. Tap a tile → load the position
 * with the user finding the move they (or their opponent) missed.
 *
 * Same architectural contract: positions and moves come from the
 * user's actual game data + the existing per-move classification
 * annotations. The runtime LLM is voice-only.
 *
 * Empty state when:
 *   - No games imported yet
 *   - No games are fully analyzed (annotations sparse)
 *   - All games are mistake-free in the endgame phase (lucky you)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertCircle,
  Lightbulb,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { ImportGamesButton } from '../Games/ImportGamesButton';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useAcceptableMoves } from '../../hooks/useAcceptableMoves';
import {
  mineEndgamePositions,
  type MinedEndgamePosition,
} from '../../services/fromYourGamesService';

interface FromYourGamesTabProps {
  onExit: () => void;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'empty'; reason: string }
  | { kind: 'picker'; positions: MinedEndgamePosition[] }
  | {
      kind: 'lesson';
      positions: MinedEndgamePosition[];
      index: number;
    };

export function FromYourGamesTab({ onExit }: FromYourGamesTabProps): JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void mineEndgamePositions().then((positions) => {
      if (cancelled) return;
      if (positions.length === 0) {
        setState({
          kind: 'empty',
          reason:
            'No mineable endgame mistakes yet. Import some games (Lichess / Chess.com) and run analysis on them — this tab will surface positions where you blundered or missed the better move in the endgame.',
        });
        return;
      }
      setState({ kind: 'picker', positions });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const startLesson = useCallback((index: number) => {
    setState((prev) => {
      if (prev.kind !== 'picker') return prev;
      return { kind: 'lesson', positions: prev.positions, index };
    });
  }, []);

  const exitLesson = useCallback(() => {
    setState((prev) => {
      if (prev.kind !== 'lesson') return prev;
      return { kind: 'picker', positions: prev.positions };
    });
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-theme-text-muted text-sm">
        <div className="animate-pulse">Mining your games for endgame mistakes…</div>
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center max-w-lg mx-auto">
        <AlertCircle size={32} className="text-cyan-400" />
        <h2 className="text-base font-semibold text-theme-text">From Your Games</h2>
        <p className="text-sm text-theme-text-muted leading-relaxed">{state.reason}</p>
        <ImportGamesButton variant="primary" />
        <button
          onClick={onExit}
          className="mt-1 px-4 py-2 rounded-lg bg-theme-surface hover:bg-theme-bg text-sm text-theme-text"
        >
          Back to endgames
        </button>
      </div>
    );
  }

  if (state.kind === 'picker') {
    return <Picker positions={state.positions} onPick={startLesson} />;
  }

  return (
    <Lesson
      positions={state.positions}
      index={state.index}
      onExit={exitLesson}
      onIndexChange={(i) =>
        setState((prev) => (prev.kind === 'lesson' ? { ...prev, index: i } : prev))
      }
    />
  );
}

// ─── Picker ───────────────────────────────────────────────────────

interface PickerProps {
  positions: MinedEndgamePosition[];
  onPick: (index: number) => void;
}

function Picker({ positions, onPick }: PickerProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4 max-w-lg mx-auto w-full">
      <div className="text-center">
        <h2 className="text-base font-semibold text-theme-text">From Your Games</h2>
        <p className="text-xs text-theme-text-muted mt-1">
          {positions.length} endgame {positions.length === 1 ? 'mistake' : 'mistakes'} mined
          from your imported games. Find the move you (or your opponent) missed.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {positions.map((p, idx) => (
          <button
            key={`${p.gameId}-${p.moveNumber}-${p.color}`}
            onClick={() => onPick(idx)}
            className="rounded-xl border-2 p-3 text-left transition-colors bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15"
            data-testid={`from-your-games-tile-${idx}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded border text-[9px] font-mono font-semibold tracking-wider ${
                      p.classification === 'blunder'
                        ? 'bg-red-500/15 text-red-400 border-red-500/40'
                        : 'bg-amber-500/15 text-amber-400 border-amber-500/40'
                    }`}
                  >
                    {p.classification.toUpperCase()}
                  </span>
                  <span className="text-sm font-semibold text-theme-text leading-tight">
                    {p.gameLabel}
                  </span>
                </div>
                <p className="text-[11px] text-theme-text-muted leading-snug">
                  Move {p.moveNumber}
                  {p.color === 'white' ? '.' : '...'} {p.playedMove} —{' '}
                  {p.evalDrop > 0 ? '+' : ''}
                  {p.evalDrop}cp
                  {p.queensOff ? ' · queens off' : ''}
                </p>
              </div>
              <ChevronRight size={16} className="text-cyan-400 flex-shrink-0 mt-1" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Lesson ───────────────────────────────────────────────────────

interface LessonProps {
  positions: MinedEndgamePosition[];
  index: number;
  onExit: () => void;
  onIndexChange: (i: number) => void;
}

function Lesson({ positions, index, onExit, onIndexChange }: LessonProps): JSX.Element {
  const position = positions[index];
  const studentSide: 'white' | 'black' = useMemo(
    () => (position.fen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [position.fen],
  );

  // Phase 6 (#6): accept any move within ~30 cp of the engine's pick.
  // Stockfish multipv runs on mount; until it lands, the playout falls
  // back to exact-SAN match (the prior behavior). Fixes the "asks for
  // a better move than Kf8 but accepts no legal move" dead-end where
  // the curated bestMove was just one of several equally good options.
  const { sans: acceptableSans } = useAcceptableMoves({
    fen: position.fen,
    toleranceCp: 30,
    enabled: !!position.bestMove,
  });

  // Drive the position through the playout runner. Solution is the
  // single engine-recommended bestMove; after that, Stockfish
  // fallback extends until mate / promotion / decisive material so
  // the lesson plays out to the actual win the player missed, not
  // just the first correct move.
  const playout = useEndgamePlayout({
    startFen: position.fen,
    solution: position.bestMove ? [position.bestMove] : [],
    extendToObviousWin: !!position.bestMove,
    fallbackPliesToPlay: 8,
    fallbackDifficulty: 'hard',
    replyDelayMs: 450,
    acceptableSans,
  });
  const clickToMove = useClickToMove(playout);

  const wrongFlash = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return { [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' } };
  }, [playout.wrongSquare]);
  const hintStyles = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.hintRevealed || !playout.hintMove) return {};
    return {
      [playout.hintMove.from]: {
        background: 'rgba(251, 191, 36, 0.55)',
        boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.9)',
      },
      [playout.hintMove.to]: {
        background: 'rgba(251, 191, 36, 0.35)',
        boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.7)',
      },
    };
  }, [playout.hintRevealed, playout.hintMove]);
  const flashStyles = useMemo<Record<string, CSSProperties>>(
    () => ({ ...clickToMove.squareStyles, ...hintStyles, ...wrongFlash }),
    [clickToMove.squareStyles, hintStyles, wrongFlash],
  );

  const goPrev = useCallback(
    () => onIndexChange(Math.max(0, index - 1)),
    [index, onIndexChange],
  );
  const goNext = useCallback(
    () => onIndexChange(Math.min(positions.length - 1, index + 1)),
    [index, positions.length, onIndexChange],
  );

  const solved = playout.isComplete;

  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back to picker"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <h2 className="text-sm font-semibold text-theme-text truncate">
            {position.gameLabel}
          </h2>
          <p className="text-xs text-theme-text-muted truncate">
            Move {position.moveNumber}
            {position.color === 'white' ? '.' : '...'} · played {position.playedMove} ·{' '}
            {position.evalDrop > 0 ? '+' : ''}
            {position.evalDrop}cp
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={studentSide}
      interactive={playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      onSquareClick={clickToMove.onSquareClick}
      squareStyles={flashStyles}
    />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
        <p className="text-sm text-theme-text">
          {studentSide === 'white' ? 'White' : 'Black'} to play. The move actually played
          was {position.playedMove} ({position.evalDrop > 0 ? '+' : ''}
          {position.evalDrop}cp). Find the better move — keep going until the win.
        </p>
        {solved && position.bestMove && (
          <div className="flex items-center gap-1.5 text-[12px] text-green-400 font-semibold">
            <Check size={14} />
            {playout.firstTryPerfect
              ? `Solved — engine recommended ${position.bestMove}`
              : `Played through — engine recommended ${position.bestMove}`}
          </div>
        )}
        {!solved && !position.bestMove && (
          <div className="text-[11px] text-theme-text-muted italic">
            No engine recommendation stored — practice mode only.
          </div>
        )}
        {!solved && position.bestMove && (
          <div className="flex items-center gap-3">
            <p className="text-[11px] text-cyan-400">
              {playout.wrongAttempts > 0
                ? 'Try again — drag or tap a piece.'
                : 'Drag or tap a piece to play your move.'}
            </p>
            {playout.hintMove && !playout.hintRevealed && (
              <button
                onClick={playout.revealHint}
                className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300"
                data-testid="from-games-hint"
              >
                <Lightbulb size={11} />
                Hint
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={goPrev}
          disabled={index === 0}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30"
        >
          <ChevronLeft size={16} />
          Prev
        </button>
        <span className="text-xs text-theme-text-muted font-mono">
          {index + 1}/{positions.length}
        </span>
        <button
          onClick={goNext}
          disabled={index === positions.length - 1}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30"
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
