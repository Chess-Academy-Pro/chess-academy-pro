/**
 * EvalLabQuiz — "play the critical move, then hold the eval"
 * ----------------------------------------------------------
 * Two-stage interaction per position. No more 3-button W/D/L
 * multiple choice — the categorical answer is earned through
 * play, not picked.
 *
 *   Stage 1 — Find the critical move.
 *     Position appears with the result label HIDDEN. Prompt:
 *     "Find the move that holds your best result." Student plays
 *     the curator's bestMove on the board. Wrong drops flash red
 *     and increment the wrong-attempts counter; right drop
 *     advances to stage 2.
 *
 *   Stage 2 — Play it out.
 *     Stockfish takes over as opponent for ~3 more plies via
 *     useEndgamePlayout's fallback path. Student plays any legal
 *     move; engine responds at easy strength (resolveConfig).
 *     After the playout the final position is tablebased and
 *     compared against the curator's authored result.
 *
 *   Reveal.
 *     Final card shows the curator's authored result + explanation,
 *     a "held the eval" / "slipped" verdict from comparing the
 *     final tablebase verdict to the original claim, and the
 *     existing tablebase-confirms / author-mismatch badge from the
 *     v1 surface (still used to flag content bugs at the original
 *     FEN).
 *
 * Pool filter: only positions with a `bestMove` field qualify for
 * Eval Lab. Positions without a curated answer can't drive the
 * "find the move" stage, so they're excluded from the quiz pool
 * (they still render in their parent lesson's static card).
 *
 * Pedagogical purpose unchanged from v1 — build the recognition
 * reflex by forcing the student to evaluate cold — but the
 * mechanism is now active. They prove their evaluation by playing
 * the position, not by tapping a button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  X,
  RotateCw,
  ShieldCheck,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { getAllEndgameLessons } from '../../services/endgameLessonsService';
import { lookupTablebase, type TablebaseLookupResult } from '../../services/lichessTablebaseService';
import type { EndgameLessonPosition } from '../../types/endgameLesson';

const QUIZ_SIZE = 10;
/** How many engine plies the student plays in stage 2 to verify
 *  they can convert. 3 student moves × 2 (with engine replies) =
 *  ~6 plies of play. Enough to expose the slip patterns, short
 *  enough to keep each quiz item fast. */
const STAGE2_PLIES = 3;

interface EvalLabQuizProps {
  onExit: () => void;
}

interface QuizItem {
  position: EndgameLessonPosition;
  fromLesson: string;
}

interface AnsweredItem extends QuizItem {
  stage1Correct: boolean;
  stage1FirstTry: boolean;
  heldTheEval: boolean | null;
}

type Stage = 'stage1' | 'stage2' | 'reveal';

export function EvalLabQuiz({ onExit }: EvalLabQuizProps): JSX.Element {
  const [seed, setSeed] = useState(() => Date.now());
  const [items, setItems] = useState<QuizItem[]>(() => buildQuiz(seed));
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnsweredItem[]>([]);

  useEffect(() => {
    setItems(buildQuiz(seed));
    setIndex(0);
    setAnswers([]);
  }, [seed]);

  const reshuffle = useCallback(() => setSeed(Date.now()), []);

  const onItemComplete = useCallback((result: AnsweredItem) => {
    setAnswers((prev) => [...prev, result]);
  }, []);

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
  }, []);

  if (items.length === 0) {
    return <EmptyPool onExit={onExit} />;
  }

  if (index >= items.length) {
    return <Summary answers={answers} onReshuffle={reshuffle} onExit={onExit} />;
  }

  const current = items[index];

  return (
    <QuizItemRunner
      key={`${index}-${current.position.fen}`}
      item={current}
      index={index}
      total={items.length}
      score={answers.filter((a) => a.heldTheEval === true).length}
      answered={answers.length}
      onExit={onExit}
      onComplete={(result) => {
        onItemComplete(result);
      }}
      onAdvance={advance}
      isLast={index === items.length - 1}
    />
  );
}

// ─── Per-item runner ────────────────────────────────────────────────

interface QuizItemRunnerProps {
  item: QuizItem;
  index: number;
  total: number;
  score: number;
  answered: number;
  onExit: () => void;
  onComplete: (result: AnsweredItem) => void;
  onAdvance: () => void;
  isLast: boolean;
}

function QuizItemRunner({
  item,
  index,
  total,
  score,
  answered,
  onExit,
  onComplete,
  onAdvance,
  isLast,
}: QuizItemRunnerProps): JSX.Element {
  const { position, fromLesson } = item;
  const [stage, setStage] = useState<Stage>('stage1');
  const [stage1FirstTry, setStage1FirstTry] = useState<boolean>(true);
  /** Tablebase at the ORIGINAL FEN — used by the reveal card to
   *  show the existing "tablebase confirms / author mismatch"
   *  badge, same as v1. */
  const [tablebaseOriginal, setTablebaseOriginal] = useState<TablebaseLookupResult | null>(null);
  /** Tablebase at the FINAL FEN — used to verify the student held
   *  the eval through stage 2. */
  const [tablebaseFinal, setTablebaseFinal] = useState<TablebaseLookupResult | null>(null);
  const [heldTheEval, setHeldTheEval] = useState<boolean | null>(null);
  const [resultLogged, setResultLogged] = useState<boolean>(false);

  // bestMove is required for stage 1; the pool filter ensures it.
  const bestMove = position.bestMove ?? '';

  const playout = useEndgamePlayout({
    startFen: position.fen,
    solution: [bestMove],
    stockfishFallback: true,
    fallbackPliesToPlay: STAGE2_PLIES,
    fallbackDifficulty: 'easy',
    replyDelayMs: 450,
  });

  // Track whether the student got stage 1 on first try, BEFORE
  // stage transitions clear playout.wrongAttempts.
  useEffect(() => {
    if (stage === 'stage1' && playout.wrongAttempts > 0) {
      setStage1FirstTry(false);
    }
  }, [stage, playout.wrongAttempts]);

  // Stage transition: stage 1 → stage 2 when student plays the
  // curated bestMove. stage 2 → reveal when the playout completes.
  useEffect(() => {
    if (stage === 'stage1' && playout.studentMovesPlayed >= 1) {
      setStage('stage2');
    }
    if (stage === 'stage2' && playout.isComplete) {
      setStage('reveal');
    }
  }, [stage, playout.studentMovesPlayed, playout.isComplete]);

  // Fire the tablebase lookup at the ORIGINAL FEN once per item.
  useEffect(() => {
    let cancelled = false;
    void lookupTablebase(position.fen).then((res) => {
      if (!cancelled) setTablebaseOriginal(res);
    });
    return () => {
      cancelled = true;
    };
  }, [position.fen]);

  // Fire the tablebase lookup at the FINAL FEN when stage 2 ends.
  useEffect(() => {
    if (stage !== 'reveal') return;
    let cancelled = false;
    void lookupTablebase(playout.fen).then((res) => {
      if (cancelled) return;
      setTablebaseFinal(res);
      // Verdict: if tablebase has a verdict at the final FEN, compare
      // to curator's authored result. If they match, student held;
      // if they don't, student slipped. >7 pieces → no verdict
      // possible, default to "completed" rather than slipped.
      if (res && res.whiteRelativeResult) {
        setHeldTheEval(res.whiteRelativeResult === position.result);
      } else {
        // No tablebase verdict (>7 pieces or fetch failed). Trust
        // that completing the playout counts as holding — engine
        // accepted the line without forcing a refutation.
        setHeldTheEval(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stage, playout.fen, position.result]);

  // Once the reveal stage has a verdict, log this item to the
  // parent's answer list — exactly once.
  useEffect(() => {
    if (stage !== 'reveal') return;
    if (resultLogged) return;
    if (heldTheEval === null) return;
    setResultLogged(true);
    onComplete({
      position,
      fromLesson,
      stage1Correct: true,
      stage1FirstTry,
      heldTheEval,
    });
  }, [stage, heldTheEval, resultLogged, onComplete, position, fromLesson, stage1FirstTry]);

  const studentSide: 'white' | 'black' = playout.studentSide;
  const wrongFlash = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return { [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' } };
  }, [playout.wrongSquare]);

  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Exit quiz"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 text-center">
          <h2 className="text-sm font-semibold text-theme-text">Eval Lab</h2>
          <p className="text-xs text-theme-text-muted">
            Position {index + 1} of {total} · score {score}/{answered}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const clickToMove = useClickToMove(playout);
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
  const mergedStyles = useMemo<Record<string, CSSProperties>>(() => ({
    ...clickToMove.squareStyles,
    ...hintStyles,
    ...wrongFlash,
  }), [clickToMove.squareStyles, hintStyles, wrongFlash]);

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={studentSide}
      interactive={playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      onSquareClick={clickToMove.onSquareClick}
      squareStyles={mergedStyles}
    />
  );

  let controls: React.ReactNode;
  if (stage === 'stage1') {
    controls = (
      <div className="flex flex-col gap-3 px-2 pb-4">
        <Stage1Prompt
          studentSide={studentSide}
          wrongAttempts={playout.wrongAttempts}
          hintAvailable={playout.hintMove !== null}
          hintRevealed={playout.hintRevealed}
          onRevealHint={playout.revealHint}
        />
      </div>
    );
  } else if (stage === 'stage2') {
    const fallbackPliesPlayed = playout.studentMovesPlayed - playout.curatedStudentMoves;
    controls = (
      <div className="flex flex-col gap-3 px-2 pb-4">
        <Stage2Prompt
          studentSide={studentSide}
          pliesPlayed={fallbackPliesPlayed}
          totalPlies={STAGE2_PLIES}
          opponentReplying={playout.phase === 'opponent-replying'}
        />
      </div>
    );
  } else {
    controls = (
      <div className="flex flex-col gap-3 px-2 pb-4">
        <RevealCard
          position={position}
          fromLesson={fromLesson}
          stage1FirstTry={stage1FirstTry}
          heldTheEval={heldTheEval}
          tablebaseOriginal={tablebaseOriginal}
          tablebaseFinal={tablebaseFinal}
        />
        <button
          onClick={onAdvance}
          className="w-full px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          data-testid="eval-lab-next"
        >
          {isLast ? 'Show summary' : 'Next position'}
        </button>
      </div>
    );
  }

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

// ─── Stage 1: find the critical move ─────────────────────────────────

interface Stage1PromptProps {
  studentSide: 'white' | 'black';
  wrongAttempts: number;
  hintAvailable: boolean;
  hintRevealed: boolean;
  onRevealHint: () => void;
}

function Stage1Prompt({
  studentSide,
  wrongAttempts,
  hintAvailable,
  hintRevealed,
  onRevealHint,
}: Stage1PromptProps): JSX.Element {
  return (
    <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/10 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Lightbulb size={14} className="text-cyan-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
          Stage 1 · Find the move
        </span>
      </div>
      <p className="text-sm text-theme-text leading-relaxed">
        {studentSide === 'white' ? 'White' : 'Black'} to play. Evaluate the position — is it winning,
        drawing, or losing? — and play the move that holds your best result.
      </p>
      {wrongAttempts > 0 && (
        <p className="text-[11px] text-amber-400">
          {wrongAttempts === 1
            ? 'Not the critical move. Look again — the right move often isn\'t the most natural one.'
            : `${wrongAttempts} wrong tries. Drag a different piece.`}
        </p>
      )}
      {hintAvailable && !hintRevealed && (
        <button
          onClick={onRevealHint}
          className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 self-start"
          data-testid="eval-lab-hint"
        >
          <Lightbulb size={11} />
          Hint
        </button>
      )}
      {hintRevealed && (
        <span className="text-[11px] text-amber-400/80 italic">
          Move highlighted on the board.
        </span>
      )}
    </div>
  );
}

// ─── Stage 2: play it out vs Stockfish ──────────────────────────────

interface Stage2PromptProps {
  studentSide: 'white' | 'black';
  pliesPlayed: number;
  totalPlies: number;
  opponentReplying: boolean;
}

function Stage2Prompt({
  studentSide,
  pliesPlayed,
  totalPlies,
  opponentReplying,
}: Stage2PromptProps): JSX.Element {
  return (
    <div className="rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Lightbulb size={14} className="text-amber-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
          Stage 2 · Hold the eval
        </span>
        <span className="ml-auto text-[10px] text-theme-text-muted font-mono">
          {pliesPlayed}/{totalPlies}
        </span>
      </div>
      <p className="text-sm text-theme-text leading-relaxed">
        {opponentReplying
          ? 'Stockfish is responding…'
          : `${studentSide === 'white' ? 'White' : 'Black'} to play. Convert the position against the engine.`}
      </p>
      <p className="text-[11px] text-theme-text-muted leading-snug">
        Finding the move was the half of it. Now play it out — if your move was right, you should
        be able to hold the result for {totalPlies} more moves.
      </p>
    </div>
  );
}

// ─── Reveal ─────────────────────────────────────────────────────────

interface RevealCardProps {
  position: EndgameLessonPosition;
  fromLesson: string;
  stage1FirstTry: boolean;
  heldTheEval: boolean | null;
  tablebaseOriginal: TablebaseLookupResult | null;
  tablebaseFinal: TablebaseLookupResult | null;
}

function RevealCard({
  position,
  fromLesson,
  stage1FirstTry,
  heldTheEval,
  tablebaseOriginal,
  tablebaseFinal,
}: RevealCardProps): JSX.Element {
  const success = stage1FirstTry && heldTheEval === true;
  const tablebaseAgrees =
    tablebaseOriginal &&
    tablebaseOriginal.whiteRelativeResult !== null &&
    tablebaseOriginal.whiteRelativeResult === position.result;
  const tablebaseDisagrees =
    tablebaseOriginal &&
    tablebaseOriginal.whiteRelativeResult !== null &&
    tablebaseOriginal.whiteRelativeResult !== position.result;
  return (
    <div
      className={`rounded-xl border-2 p-3 flex flex-col gap-2 ${
        success ? 'border-green-500/40 bg-green-500/5' : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center gap-2">
        {success ? (
          <Check size={16} className="text-green-400" />
        ) : heldTheEval === false ? (
          <X size={16} className="text-red-400" />
        ) : (
          <AlertTriangle size={16} className="text-amber-400" />
        )}
        <span
          className={`text-sm font-semibold ${
            success ? 'text-green-400' : heldTheEval === false ? 'text-red-400' : 'text-amber-400'
          }`}
        >
          {success
            ? 'Found and held'
            : stage1FirstTry
              ? heldTheEval === false
                ? 'Found the move, lost the technique'
                : 'Completed'
              : 'Right move, eventually'}
        </span>
      </div>
      <div className="text-[12px] text-theme-text-muted">
        From: <span className="text-theme-text font-medium">{fromLesson}</span> — {position.title}
      </div>
      <div className="text-[12px] text-theme-text leading-relaxed">
        <span className="font-semibold">Result: {labelFor(position.result)}.</span>{' '}
        {position.explanation}
      </div>
      {tablebaseAgrees && (
        <div className="flex items-center gap-1.5 text-[11px] text-cyan-400 font-medium">
          <ShieldCheck size={13} />
          Tablebase confirms · {labelFor(tablebaseOriginal.whiteRelativeResult as Result)} · DTM{' '}
          {tablebaseOriginal.dtm ?? '—'}
        </div>
      )}
      {tablebaseDisagrees && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-400 font-medium">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            Tablebase reports {labelFor(tablebaseOriginal.whiteRelativeResult as Result)} —
            disagrees with the curator&apos;s claim of {labelFor(position.result)}. Content bug
            logged; the tablebase is mathematically certain.
          </span>
        </div>
      )}
      {tablebaseFinal && tablebaseFinal.whiteRelativeResult && heldTheEval === false && (
        <div className="text-[11px] text-red-400 italic">
          After the playout the position is {labelFor(tablebaseFinal.whiteRelativeResult)} —
          you slipped during conversion.
        </div>
      )}
      {position.source && (
        <div className="text-[10px] text-theme-text-muted/70 italic">{position.source}</div>
      )}
    </div>
  );
}

// ─── Summary ────────────────────────────────────────────────────────

interface SummaryProps {
  answers: AnsweredItem[];
  onReshuffle: () => void;
  onExit: () => void;
}

function Summary({ answers, onReshuffle, onExit }: SummaryProps): JSX.Element {
  const heldCount = answers.filter((a) => a.heldTheEval === true).length;
  const firstTryCount = answers.filter((a) => a.stage1FirstTry && a.heldTheEval === true).length;
  const total = answers.length;
  const percent = total > 0 ? Math.round((heldCount / total) * 100) : 0;
  const grade =
    percent >= 90
      ? "Master's eye"
      : percent >= 75
        ? 'Strong recognition'
        : percent >= 60
          ? 'Solid foundation'
          : percent >= 40
            ? 'Building up'
            : 'Just starting';

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 max-w-lg mx-auto w-full"
      style={{ color: 'var(--color-text)' }}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <h2 className="text-base font-semibold text-theme-text">Quiz complete</h2>
        <div className="w-[44px]" />
      </div>
      <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/5 p-4 text-center">
        <div className="text-4xl font-bold text-cyan-400">
          {heldCount} / {total}
        </div>
        <div className="text-sm text-theme-text-muted mt-1">{percent}% held</div>
        <div className="text-xs font-semibold text-theme-text mt-2">{grade}</div>
        <div className="text-[10px] text-theme-text-muted mt-1">
          {firstTryCount} solved on first try
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">
          Answers
        </h3>
        {answers.map((a, idx) => (
          <div
            key={idx}
            className={`rounded-lg border p-2 flex items-center gap-2 ${
              a.heldTheEval ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
            }`}
          >
            {a.heldTheEval ? (
              <Check size={14} className="text-green-400 flex-shrink-0" />
            ) : (
              <X size={14} className="text-red-400 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-theme-text truncate">{a.position.title}</div>
              <div className="text-[10px] text-theme-text-muted">
                {a.fromLesson}
                {!a.stage1FirstTry && ' · retried'}
              </div>
            </div>
            <span className="text-[10px] font-mono text-theme-text-muted">
              {labelFor(a.position.result)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onReshuffle}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
        >
          <RotateCw size={14} />
          New quiz
        </button>
        <button
          onClick={onExit}
          className="px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ─── Empty pool fallback ────────────────────────────────────────────

function EmptyPool({ onExit }: { onExit: () => void }): JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 p-6 flex-1 max-w-lg mx-auto w-full text-center"
      style={{ color: 'var(--color-text)' }}
    >
      <h2 className="text-base font-semibold text-theme-text">Eval Lab is empty</h2>
      <p className="text-sm text-theme-text-muted">
        No quiz positions have curated best moves yet. Eval Lab needs at least one position with a
        bestMove set to drive the play-the-critical-move stage.
      </p>
      <button
        onClick={onExit}
        className="px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
      >
        Back
      </button>
    </div>
  );
}

type Result = 'white-wins' | 'black-wins' | 'draw';

function labelFor(result: Result): string {
  switch (result) {
    case 'white-wins':
      return 'W wins';
    case 'black-wins':
      return 'B wins';
    case 'draw':
      return 'Draw';
  }
}

function buildQuiz(seed: number): QuizItem[] {
  const all: QuizItem[] = [];
  for (const lesson of getAllEndgameLessons()) {
    for (const pos of lesson.positions) {
      // Quiz pool requires a curated best move to drive stage 1.
      if (!pos.bestMove) continue;
      all.push({ position: pos, fromLesson: lesson.name });
    }
  }
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.min(QUIZ_SIZE, all.length));
}
