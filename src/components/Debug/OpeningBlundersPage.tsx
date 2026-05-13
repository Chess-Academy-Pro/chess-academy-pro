// Opening Blunders — Tactics → Opening Traps tab
// -----------------------------------------------
// `/tactics/opening-traps` mines the local Lichess puzzle DB for
// positions tagged `opening` + a tactical-outcome theme. Family-grouped
// picker, then split into White / Black panels (the COLOR YOU PLAY —
// i.e., the side that delivers the punishing tactic). Tap a puzzle →
// playable lesson with voice intro.

import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useNarration } from '../../hooks/useNarration';
import {
  getOpeningBlunderPuzzles,
  groupByOpeningFamily,
  type OpeningBlunderPuzzle,
  type OpeningBlunderFamily,
} from '../../services/openingBlunderService';

function uciToSanLine(fen: string, uciLine: string): string[] {
  const c = new Chess(fen);
  const sans: string[] = [];
  for (const uci of uciLine.split(/\s+/).filter(Boolean)) {
    try {
      const move = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      sans.push(move.san);
    } catch {
      break;
    }
  }
  return sans;
}

function applyFirstMove(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return c.fen();
  } catch {
    return fen;
  }
}

function puzzleGoal(themes: string[]): string {
  const mateN = themes.find((t) => /^mateIn\d$/.test(t));
  if (mateN) return `${mateN.replace('mateIn', 'Mate in ')}`;
  if (themes.includes('crushing')) return 'Win decisive material';
  if (themes.includes('mate')) return 'Deliver mate';
  const pattern = themes.find((t) =>
    ['fork', 'pin', 'skewer', 'hangingPiece', 'attackingF2F7', 'deflection', 'attraction'].includes(t),
  );
  if (pattern) return `Win material — ${pattern.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`;
  return 'Find the tactic';
}

type ColorTab = 'white' | 'black';

export function OpeningBlundersPage(): JSX.Element {
  const navigate = useNavigate();
  const families = useMemo<OpeningBlunderFamily[]>(() => groupByOpeningFamily(), []);
  const total = useMemo<number>(() => getOpeningBlunderPuzzles().length, []);
  const [activeFamily, setActiveFamily] = useState<string | null>(null);
  const [activeColor, setActiveColor] = useState<ColorTab>('white');
  const [activePuzzle, setActivePuzzle] = useState<OpeningBlunderPuzzle | null>(null);

  if (activePuzzle) {
    return <PuzzleView puzzle={activePuzzle} onExit={() => setActivePuzzle(null)} />;
  }

  if (activeFamily) {
    const family = families.find((f) => f.family === activeFamily);
    if (!family) {
      setActiveFamily(null);
      return <></>;
    }
    const list = activeColor === 'white' ? family.white : family.black;
    return (
      <div
        className="flex flex-col flex-1 overflow-y-auto"
        style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
      >
        <div className="flex items-center gap-2 px-3 py-3 border-b border-theme-border sticky top-0 bg-theme-bg z-10">
          <button
            onClick={() => setActiveFamily(null)}
            className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
            aria-label="Back to families"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold truncate">{family.label}</h2>
            <p className="text-[11px] text-theme-text-muted">
              {family.white.length + family.black.length} blunders to punish
            </p>
          </div>
        </div>

        {/* White / Black toggle */}
        <div className="px-3 pt-3 max-w-2xl mx-auto w-full">
          <div
            className="flex gap-1 rounded-lg p-1"
            style={{ background: 'var(--color-bg-secondary)' }}
          >
            {(['white', 'black'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setActiveColor(c)}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors"
                style={{
                  background: activeColor === c ? 'var(--color-surface)' : 'transparent',
                  color: activeColor === c ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
                data-testid={`opening-blunder-color-${c}`}
              >
                <span aria-hidden>{c === 'white' ? '♙' : '♟'}</span>
                <span className="capitalize">You play {c}</span>
                <span className="text-[11px] opacity-60">({c === 'white' ? family.white.length : family.black.length})</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 p-3 max-w-2xl mx-auto w-full">
          {list.length === 0 ? (
            <p className="text-sm text-theme-text-muted text-center py-8">
              No {activeColor}-side blunders for this opening in the local corpus.
            </p>
          ) : (
            list.slice(0, 100).map((p) => (
              <button
                key={p.id}
                onClick={() => setActivePuzzle(p)}
                className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-bg text-left min-h-[60px] transition-colors"
                data-testid={`opening-blunder-${p.id}`}
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-block px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-[9px] font-mono font-semibold tracking-wider text-amber-400">
                      {puzzleGoal(p.themes).toUpperCase()}
                    </span>
                    <span className="text-[11px] text-theme-text-muted font-mono">
                      {p.rating}
                    </span>
                  </div>
                  <p className="text-[11px] text-theme-text-muted truncate">
                    {p.themes
                      .filter((t) => !['opening', 'short', 'long', 'oneMove', 'master'].includes(t))
                      .slice(0, 4)
                      .join(' · ')}
                  </p>
                </div>
                <ChevronRight size={16} className="text-theme-text-muted flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col flex-1 overflow-y-auto"
      style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
      data-testid="opening-blunders-page"
    >
      <div className="flex items-center gap-2 px-3 py-3 border-b border-theme-border sticky top-0 bg-theme-bg z-10">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold">Opening traps</h1>
          <p className="text-[11px] text-theme-text-muted">
            {total} tactical refutations from the Lichess puzzle DB, grouped
            by opening
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3 max-w-2xl mx-auto w-full">
        {families.map((f) => {
          const total = f.white.length + f.black.length;
          return (
            <button
              key={f.family}
              onClick={() => {
                // Default to the side with more puzzles when entering a family.
                setActiveColor(f.white.length >= f.black.length ? 'white' : 'black');
                setActiveFamily(f.family);
              }}
              className="flex items-center justify-between gap-3 px-3 py-3 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-bg text-left min-h-[60px] transition-colors"
              data-testid={`opening-blunder-family-${f.family}`}
            >
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <span className="text-sm font-semibold truncate">{f.label}</span>
                <div className="flex items-center gap-2 text-[11px] text-theme-text-muted">
                  <span>{total} total</span>
                  <span aria-hidden>·</span>
                  <span>
                    <span aria-hidden>♙</span> {f.white.length}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    <span aria-hidden>♟</span> {f.black.length}
                  </span>
                </div>
              </div>
              <ChevronRight size={16} className="text-theme-text-muted flex-shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface PuzzleViewProps {
  puzzle: OpeningBlunderPuzzle;
  onExit: () => void;
}

function PuzzleView({ puzzle, onExit }: PuzzleViewProps): JSX.Element {
  // Lichess puzzle convention: moves[0] is the OPPONENT's setup move
  // that creates the puzzle position. moves[1..] is the alternating
  // solution starting with the student's move. We pre-apply moves[0]
  // and feed moves[1..] (in SAN) to useEndgamePlayout as the curated
  // solution.
  const startFen = useMemo<string>(() => {
    const uciList = puzzle.moves.split(/\s+/).filter(Boolean);
    return uciList.length > 0 ? applyFirstMove(puzzle.fen, uciList[0]) : puzzle.fen;
  }, [puzzle]);

  const solutionSan = useMemo<string[]>(() => {
    const uciList = puzzle.moves.split(/\s+/).filter(Boolean);
    return uciToSanLine(startFen, uciList.slice(1).join(' '));
  }, [startFen, puzzle.moves]);

  const studentSide = puzzle.studentColor;

  const playout = useEndgamePlayout({
    startFen,
    solution: solutionSan,
    replyDelayMs: 450,
  });
  const clickToMove = useClickToMove(playout);

  const introText = useMemo<string>(
    () =>
      `${puzzleGoal(puzzle.themes)}. ${studentSide === 'white' ? 'White' : 'Black'} to play.`,
    [puzzle.themes, studentSide],
  );
  useNarration({ text: introText });

  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <h2 className="text-sm font-semibold truncate">
            {puzzleGoal(puzzle.themes)} — rating {puzzle.rating}
          </h2>
          <p className="text-[11px] text-theme-text-muted truncate">
            {puzzle.themes
              .filter((t) => !['opening', 'short', 'long', 'oneMove', 'master'].includes(t))
              .slice(0, 5)
              .join(' · ')}
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
      squareStyles={clickToMove.squareStyles}
    />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-2">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
        {!playout.isComplete && playout.expectedSan && (
          <p className="text-sm text-theme-text">
            {studentSide === 'white' ? 'White' : 'Black'} to play. {puzzleGoal(puzzle.themes)}.
          </p>
        )}
        {playout.isComplete && (
          <p className="text-sm text-green-400 font-semibold">
            Solved — that's the punishing line.
          </p>
        )}
        {playout.wrongAttempts > 0 && !playout.isComplete && (
          <p className="text-[11px] text-amber-400">
            {playout.wrongAttempts === 1
              ? 'Not the move. Try again.'
              : `${playout.wrongAttempts} wrong tries.`}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => playout.reset()}
          className="flex-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text hover:bg-theme-bg"
        >
          Reset
        </button>
        {playout.hintMove && !playout.hintRevealed && (
          <button
            onClick={() => playout.revealHint()}
            className="flex-1 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-sm font-medium"
          >
            Hint
          </button>
        )}
        <button
          onClick={onExit}
          className="flex-1 px-3 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
        >
          Next puzzle
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
