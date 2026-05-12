import { useState, useCallback, useEffect, useMemo } from 'react';
import { Chess } from 'chess.js';
import { ControlledChessBoard } from '../Board/ControlledChessBoard';
import { useChessGame } from '../../hooks/useChessGame';
import { MoveTree } from '../Openings/MoveTree';
import { ArrowLeft, ArrowRight, ChevronsLeft, ChevronsRight, Download, Bot, Loader2 } from 'lucide-react';
import { useBoardContext } from '../../hooks/useBoardContext';
import { requestGameReview } from '../../services/gameReviewService';
import type { GameRecord, MoveAnnotation, MoveClassification } from '../../types';

interface GameViewerProps {
  game: GameRecord;
  onClose: () => void;
}

const CLASSIFICATION_COLORS: Record<MoveClassification, string> = {
  brilliant: 'text-cyan-400',
  great: 'text-blue-400',
  good: 'text-green-400',
  book: 'text-theme-text-muted',
  miss: 'text-yellow-400',
  inaccuracy: 'text-yellow-400',
  mistake: 'text-orange-400',
  blunder: 'text-red-400',
};

const CLASSIFICATION_BG: Record<string, string> = {
  blunder: 'bg-red-500/20 border-red-500/40',
  mistake: 'bg-orange-500/20 border-orange-500/40',
  inaccuracy: 'bg-yellow-500/20 border-yellow-500/40',
  brilliant: 'bg-cyan-500/20 border-cyan-500/40',
};

const CLASSIFICATION_SYMBOLS: Record<string, string> = {
  brilliant: '!!',
  great: '!',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export function GameViewer({ game, onClose }: GameViewerProps): JSX.Element {
  const chessGame = useChessGame();
  const moves = parsePgnMoves(game.pgn);
  const [moveIdx, setMoveIdx] = useState(-1);
  const [coachAnalysis, setCoachAnalysis] = useState(game.coachAnalysis);
  const [annotations, setAnnotations] = useState<MoveAnnotation[] | null>(game.annotations ?? null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewPhase, setReviewPhase] = useState('');

  const currentFen = moveIdx >= 0 && moveIdx < moves.length
    ? moves[moveIdx].fen
    : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Publish board context for global coach drawer
  const turn = currentFen.split(' ')[1] === 'b' ? 'b' : 'w';
  const viewerHistory = moves.slice(0, Math.max(0, moveIdx + 1)).map((m) => m.san);
  useBoardContext(currentFen, game.pgn, Math.max(0, moveIdx + 1), 'white', turn, undefined, viewerHistory);

  // Classification for current move
  const currentAnnotation = useMemo((): MoveAnnotation | null => {
    if (!annotations || moveIdx < 0 || moveIdx >= annotations.length) return null;
    return annotations[moveIdx];
  }, [annotations, moveIdx]);

  // Summary counts
  const classificationCounts = useMemo(() => {
    if (!annotations) return null;
    const counts = { brilliant: 0, great: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    for (const a of annotations) {
      if (a.classification in counts) {
        counts[a.classification as keyof typeof counts]++;
      }
    }
    return counts;
  }, [annotations]);

  const handleKeyDown = useCallback((e: KeyboardEvent): void => {
    if (e.key === 'ArrowRight') {
      setMoveIdx((i) => Math.min(i + 1, moves.length - 1));
    } else if (e.key === 'ArrowLeft') {
      setMoveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Home') {
      setMoveIdx(-1);
    } else if (e.key === 'End') {
      setMoveIdx(moves.length - 1);
    }
  }, [moves.length]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCoachReview = useCallback(async (): Promise<void> => {
    if (reviewing || !game.id) return;
    setReviewing(true);
    setReviewPhase('');
    let streamed = '';
    try {
      const result = await requestGameReview(
        game.id,
        (chunk) => {
          streamed += chunk;
          setCoachAnalysis(streamed);
        },
        (phase) => setReviewPhase(phase),
      );
      setCoachAnalysis(result);
      // Reload annotations from DB (analyzeSingleGame stores them)
      const updated = await import('../../db/schema').then(m => m.db.games.get(game.id));
      if (updated?.annotations) {
        setAnnotations(updated.annotations);
      }
    } catch {
      // If streaming fails, coachAnalysis stays as-is
    } finally {
      setReviewing(false);
      setReviewPhase('');
    }
  }, [game.id, reviewing]);

  const handleExportPgn = (): void => {
    const blob = new Blob([game.pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${game.white}_vs_${game.black}_${game.date}.pgn`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4" data-testid="game-viewer">
      <div className="flex items-center justify-between">
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-theme-surface"
          data-testid="close-viewer-btn"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <div className="text-center">
          <div className="font-semibold text-sm text-theme-text">{game.white} vs {game.black}</div>
          <div className="text-xs text-theme-text-muted">{game.result} · {game.date}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleCoachReview()}
            disabled={reviewing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-theme-accent text-white hover:opacity-80 disabled:opacity-50"
            data-testid="coach-review-btn"
          >
            {reviewing ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            {reviewing ? (reviewPhase || 'Reviewing…') : 'Coach Review'}
          </button>
          <button
            onClick={handleExportPgn}
            className="p-2 rounded-lg hover:bg-theme-surface"
            data-testid="export-pgn-btn"
          >
            <Download size={18} className="text-theme-text" />
          </button>
        </div>
      </div>

      {/* Classification summary bar */}
      {classificationCounts && (
        <div className="flex items-center justify-center gap-3 text-xs font-medium" data-testid="classification-summary">
          {classificationCounts.brilliant > 0 && (
            <span className="text-cyan-400">{classificationCounts.brilliant} Brilliant</span>
          )}
          {classificationCounts.great > 0 && (
            <span className="text-blue-400">{classificationCounts.great} Great</span>
          )}
          <span className="text-yellow-400">{classificationCounts.inaccuracy} Inaccuracy</span>
          <span className="text-orange-400">{classificationCounts.mistake} Mistake</span>
          <span className="text-red-400">{classificationCounts.blunder} Blunder</span>
        </div>
      )}

      <div className="w-full md:max-w-[420px] mx-auto">
        <ControlledChessBoard
          game={chessGame}
          positionOverride={currentFen}
          interactive={false}
          showFlipButton
          showUndoButton={false}
          showResetButton={false}
        />
      </div>

      {/* Current move annotation */}
      {currentAnnotation && currentAnnotation.classification !== 'good' && currentAnnotation.classification !== 'book' && (
        <div
          className={`mx-auto max-w-md rounded-lg border px-3 py-2 text-sm ${CLASSIFICATION_BG[currentAnnotation.classification] ?? 'bg-theme-surface border-theme-border'}`}
          data-testid="move-annotation"
        >
          <span className={`font-semibold ${CLASSIFICATION_COLORS[currentAnnotation.classification]}`}>
            {currentAnnotation.classification.charAt(0).toUpperCase() + currentAnnotation.classification.slice(1)}
          </span>
          <span className="text-theme-text-muted ml-2">
            {currentAnnotation.moveNumber}{currentAnnotation.color === 'black' ? '...' : '.'} {currentAnnotation.san}
            {currentAnnotation.evaluation !== null && (
              <span className="ml-1">
                {/* Annotation evals are centipawns (White POV); display
                    as pawns for the inline chip. */}
                ({currentAnnotation.evaluation > 0 ? '+' : ''}{(currentAnnotation.evaluation / 100).toFixed(1)})
              </span>
            )}
            {currentAnnotation.bestMove && (
              <span className="ml-1">· Best: {currentAnnotation.bestMove}</span>
            )}
          </span>
        </div>
      )}

      {/* Navigation controls */}
      <div className="flex items-center justify-center gap-2">
        <button onClick={() => setMoveIdx(-1)} className="p-2 rounded hover:bg-theme-surface" data-testid="nav-start">
          <ChevronsLeft size={18} className="text-theme-text" />
        </button>
        <button onClick={() => setMoveIdx((i) => Math.max(i - 1, -1))} className="p-2 rounded hover:bg-theme-surface" data-testid="nav-prev">
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <span className="text-sm px-3 text-theme-text-muted">
          {moveIdx + 1}/{moves.length}
        </span>
        <button onClick={() => setMoveIdx((i) => Math.min(i + 1, moves.length - 1))} className="p-2 rounded hover:bg-theme-surface" data-testid="nav-next">
          <ArrowRight size={18} className="text-theme-text" />
        </button>
        <button onClick={() => setMoveIdx(moves.length - 1)} className="p-2 rounded hover:bg-theme-surface" data-testid="nav-end">
          <ChevronsRight size={18} className="text-theme-text" />
        </button>
      </div>

      {/* Move list with classification markers */}
      {game.pgn && (
        <div
          className="rounded-xl p-4 border border-theme-border bg-theme-bg max-h-48 overflow-y-auto"
        >
          {annotations && annotations.length > 0 ? (
            <div className="flex flex-wrap gap-x-1 gap-y-0.5 text-sm font-mono">
              {annotations.map((ann, idx) => {
                const isSelected = idx === moveIdx;
                const symbol = CLASSIFICATION_SYMBOLS[ann.classification] ?? '';
                const colorClass = CLASSIFICATION_COLORS[ann.classification] ?? 'text-theme-text';
                return (
                  <span key={idx}>
                    {ann.color === 'white' && (
                      <span className="text-theme-text-muted mr-0.5">{ann.moveNumber}.</span>
                    )}
                    <button
                      onClick={() => setMoveIdx(idx)}
                      className={`px-0.5 rounded ${isSelected ? 'bg-theme-accent/30 font-bold' : 'hover:bg-theme-surface'} ${colorClass}`}
                      data-testid={`move-btn-${idx}`}
                    >
                      {ann.san}{symbol}
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <MoveTree
              mainLinePgn={stripPgnHeaders(game.pgn)}
              currentMoveIndex={moveIdx}
              onMoveSelect={(idx) => setMoveIdx(idx)}
            />
          )}
        </div>
      )}

      {coachAnalysis && (
        <div
          className="rounded-xl p-4 border border-theme-border bg-theme-surface"
          data-testid="coach-analysis-panel"
        >
          <h3 className="font-semibold text-sm text-theme-text mb-2">Coach Analysis</h3>
          <p className="text-sm whitespace-pre-wrap text-theme-text-muted">
            {coachAnalysis}
          </p>
        </div>
      )}
    </div>
  );
}

function stripPgnHeaders(pgn: string): string {
  return pgn
    .replace(/\[.*?\]\s*/g, '')
    .replace(/\{.*?\}/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, '')
    .replace(/\d+\.\.\./g, '')
    .replace(/\d+\./g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function parsePgnMoves(pgn: string): ParsedMove[] {
  const moveText = pgn
    .replace(/\[.*?\]/g, '')
    .replace(/\{.*?\}/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, '')
    .trim();

  if (!moveText) return [];

  const tokens = moveText.split(/\s+/).filter((t) => !t.match(/^\d+\.+$/));

  // Replay through chess.js to get correct FEN at each move
  const chess = new Chess();
  const result: ParsedMove[] = [];
  for (const san of tokens) {
    try {
      chess.move(san);
      result.push({ san, fen: chess.fen() });
    } catch {
      break;
    }
  }
  return result;
}

interface ParsedMove {
  san: string;
  fen: string;
}
