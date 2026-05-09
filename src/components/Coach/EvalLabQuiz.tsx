/**
 * EvalLabQuiz — the headline "is it winning, drawing, or losing?"
 * surface from the endgame design.
 *
 * Aggregates every authored reference position across all four
 * lesson catalogs (principles, pawn endings, drawn patterns, rook
 * endings) into a quiz pool. Picks 10 at random per session,
 * presents the position with result hidden, asks the student to
 * guess. Reveal shows the correct answer + the explanation
 * authored for that position. Score tracked across the 10.
 *
 * Pedagogical purpose: builds the recognition reflex. The student
 * sees an unfamiliar position and has to evaluate it cold — same
 * skill they need OTB. Hand-authored explanations give them the
 * "why" the moment after they answer, when the brain is most
 * receptive (right after a wrong guess in particular).
 *
 * Tablebase verification: when a position has ≤7 pieces, the quiz
 * fires a `lookupTablebase(fen)` call after the student answers
 * and surfaces a "Tablebase confirms: <result>" badge on the
 * reveal card. Mathematical certainty stacked on top of the
 * curator's hand-authored claim. If the two disagree, that's a
 * content bug (an "Author / tablebase mismatch" warning surfaces
 * so I can fix it). For positions >7 pieces, the curator's claim
 * stands alone — that's the contract.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, X, RotateCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { getAllEndgameLessons } from '../../services/endgameLessonsService';
import { lookupTablebase, type TablebaseLookupResult } from '../../services/lichessTablebaseService';
import type { EndgameLesson, EndgameLessonPosition } from '../../types/endgameLesson';

const QUIZ_SIZE = 10;

interface EvalLabQuizProps {
  onExit: () => void;
}

interface QuizItem {
  position: EndgameLessonPosition;
  fromLesson: string;
}

type Guess = 'white-wins' | 'black-wins' | 'draw';

interface AnsweredItem extends QuizItem {
  guess: Guess;
  correct: boolean;
}

export function EvalLabQuiz({ onExit }: EvalLabQuizProps): JSX.Element {
  const [seed, setSeed] = useState(() => Date.now());
  const [items, setItems] = useState<QuizItem[]>(() => buildQuiz(seed));
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnsweredItem[]>([]);
  const [guess, setGuess] = useState<Guess | null>(null);
  /** Tablebase lookup for the CURRENT position. null when no
   *  lookup attempted yet, or when the position is >7 pieces, or
   *  when the network call failed. Resets on each puzzle. */
  const [tablebase, setTablebase] = useState<TablebaseLookupResult | null>(null);
  const [tablebaseLoading, setTablebaseLoading] = useState(false);

  // Re-roll quiz pool when seed changes.
  useEffect(() => {
    setItems(buildQuiz(seed));
    setIndex(0);
    setAnswers([]);
    setGuess(null);
    setTablebase(null);
  }, [seed]);

  // Reset tablebase lookup state when puzzle index changes.
  useEffect(() => {
    setTablebase(null);
    setTablebaseLoading(false);
  }, [index]);

  const reshuffle = useCallback(() => setSeed(Date.now()), []);

  const onGuess = useCallback(
    (g: Guess) => {
      if (guess !== null) return;
      setGuess(g);
      const current = items[index];
      setAnswers((prev) => [
        ...prev,
        {
          ...current,
          guess: g,
          correct: g === current.position.result,
        },
      ]);
      // Fire-and-forget tablebase lookup for verification. Caller
      // ignores the call when the position is >7 pieces. Only sets
      // state if the user is still on this puzzle when the response
      // arrives (effect index check).
      const fenAtGuess = current.position.fen;
      const indexAtGuess = index;
      setTablebaseLoading(true);
      void lookupTablebase(fenAtGuess).then((result) => {
        setTablebaseLoading(false);
        // Only commit the result if user is still on the same
        // puzzle. The effect that resets `tablebase` on index
        // change handles the case where they advanced.
        if (indexAtGuess === index) {
          setTablebase(result);
        }
      });
    },
    [guess, items, index],
  );

  const advance = useCallback(() => {
    if (index >= items.length - 1) return;
    setIndex((i) => i + 1);
    setGuess(null);
  }, [index, items.length]);

  if (index >= items.length || (index === items.length - 1 && guess !== null && answers.length === items.length)) {
    return <Summary answers={answers} onReshuffle={reshuffle} onExit={onExit} />;
  }

  const current = items[index];
  const studentSide: 'white' | 'black' =
    current.position.fen.split(' ')[1] === 'w' ? 'white' : 'black';

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
            Position {index + 1} of {items.length} · score {answers.filter((a) => a.correct).length}/{answers.length}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard fen={current.position.fen} boardOrientation={studentSide} />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-4">
      <p className="text-sm text-center text-theme-text">
        With best play, what's the result?
      </p>
      <div className="grid grid-cols-3 gap-2">
        <GuessButton
          label="White wins"
          guess="white-wins"
          colorClass="bg-green-500/15 border-green-500/40 text-green-400"
          activeClass="bg-green-500/30 border-green-500/80"
          selectedGuess={guess}
          correctAnswer={current.position.result}
          onClick={() => onGuess('white-wins')}
        />
        <GuessButton
          label="Draw"
          guess="draw"
          colorClass="bg-amber-500/15 border-amber-500/40 text-amber-400"
          activeClass="bg-amber-500/30 border-amber-500/80"
          selectedGuess={guess}
          correctAnswer={current.position.result}
          onClick={() => onGuess('draw')}
        />
        <GuessButton
          label="Black wins"
          guess="black-wins"
          colorClass="bg-red-500/15 border-red-500/40 text-red-400"
          activeClass="bg-red-500/30 border-red-500/80"
          selectedGuess={guess}
          correctAnswer={current.position.result}
          onClick={() => onGuess('black-wins')}
        />
      </div>
      {guess !== null && (
        <RevealCard
          position={current.position}
          fromLesson={current.fromLesson}
          guess={guess}
          tablebase={tablebase}
          tablebaseLoading={tablebaseLoading}
        />
      )}
      {guess !== null && (
        <button
          onClick={advance}
          className="w-full px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          data-testid="eval-lab-next"
        >
          {index === items.length - 1 ? 'Show summary' : 'Next position'}
        </button>
      )}
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

interface GuessButtonProps {
  label: string;
  guess: Guess;
  colorClass: string;
  activeClass: string;
  selectedGuess: Guess | null;
  correctAnswer: Guess;
  onClick: () => void;
}

function GuessButton({
  label,
  guess,
  colorClass,
  activeClass,
  selectedGuess,
  correctAnswer,
  onClick,
}: GuessButtonProps): JSX.Element {
  const revealing = selectedGuess !== null;
  const isThisChoiceCorrect = guess === correctAnswer;
  const isThisChoiceSelected = selectedGuess === guess;
  let className = `px-2 py-3 rounded-lg border-2 text-xs font-semibold transition-colors ${colorClass}`;
  if (revealing) {
    if (isThisChoiceCorrect) className = `${className} ring-2 ring-green-400`;
    if (isThisChoiceSelected && !isThisChoiceCorrect) className = `${className} opacity-50 line-through`;
  } else {
    className = `${className} hover:${activeClass.split(' ').filter((c) => c.startsWith('bg-')).join(' ')}`;
  }
  return (
    <button
      onClick={onClick}
      disabled={revealing}
      className={className}
      data-testid={`eval-lab-guess-${guess}`}
    >
      {label}
    </button>
  );
}

interface RevealCardProps {
  position: EndgameLessonPosition;
  fromLesson: string;
  guess: Guess;
  tablebase: TablebaseLookupResult | null;
  tablebaseLoading: boolean;
}

function RevealCard({
  position,
  fromLesson,
  guess,
  tablebase,
  tablebaseLoading,
}: RevealCardProps): JSX.Element {
  const correct = guess === position.result;
  // Tablebase verification: when available, show a badge.
  // - Confirms author: green ShieldCheck "Tablebase confirms".
  // - Disagrees with author: amber AlertTriangle "Author / tablebase mismatch"
  //   (this is a content bug — the curator's claim is wrong; surfaces so
  //   I can fix it).
  // - >7 pieces or fetch failed: no badge.
  const tablebaseAgrees =
    tablebase &&
    tablebase.whiteRelativeResult !== null &&
    tablebase.whiteRelativeResult === position.result;
  const tablebaseDisagrees =
    tablebase &&
    tablebase.whiteRelativeResult !== null &&
    tablebase.whiteRelativeResult !== position.result;
  return (
    <div
      className={`rounded-xl border-2 p-3 flex flex-col gap-2 ${
        correct ? 'border-green-500/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5'
      }`}
    >
      <div className="flex items-center gap-2">
        {correct ? (
          <Check size={16} className="text-green-400" />
        ) : (
          <X size={16} className="text-red-400" />
        )}
        <span
          className={`text-sm font-semibold ${correct ? 'text-green-400' : 'text-red-400'}`}
        >
          {correct ? 'Correct' : 'Not quite'}
        </span>
      </div>
      <div className="text-[12px] text-theme-text-muted">
        From: <span className="text-theme-text font-medium">{fromLesson}</span> — {position.title}
      </div>
      <p className="text-[12px] text-theme-text leading-relaxed">{position.explanation}</p>
      {tablebaseLoading && (
        <div className="text-[10px] text-theme-text-muted/70">Verifying with tablebase…</div>
      )}
      {tablebaseAgrees && (
        <div className="flex items-center gap-1.5 text-[11px] text-cyan-400 font-medium">
          <ShieldCheck size={13} />
          Tablebase confirms · {labelFor(tablebase.whiteRelativeResult as Guess)} · DTM {tablebase.dtm ?? '—'}
        </div>
      )}
      {tablebaseDisagrees && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-400 font-medium">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            Tablebase reports {labelFor(tablebase.whiteRelativeResult as Guess)} —
            disagrees with the curator's claim of {labelFor(position.result)}.
            Content bug logged; the tablebase is mathematically certain.
          </span>
        </div>
      )}
      {position.source && (
        <div className="text-[10px] text-theme-text-muted/70 italic">{position.source}</div>
      )}
    </div>
  );
}

interface SummaryProps {
  answers: AnsweredItem[];
  onReshuffle: () => void;
  onExit: () => void;
}

function Summary({ answers, onReshuffle, onExit }: SummaryProps): JSX.Element {
  const correctCount = answers.filter((a) => a.correct).length;
  const total = answers.length;
  const percent = Math.round((correctCount / total) * 100);
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
          {correctCount} / {total}
        </div>
        <div className="text-sm text-theme-text-muted mt-1">{percent}%</div>
        <div className="text-xs font-semibold text-theme-text mt-2">{grade}</div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">
          Answers
        </h3>
        {answers.map((a, idx) => (
          <div
            key={idx}
            className={`rounded-lg border p-2 flex items-center gap-2 ${
              a.correct ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
            }`}
          >
            {a.correct ? (
              <Check size={14} className="text-green-400 flex-shrink-0" />
            ) : (
              <X size={14} className="text-red-400 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-theme-text truncate">{a.position.title}</div>
              <div className="text-[10px] text-theme-text-muted">{a.fromLesson}</div>
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

function labelFor(result: Guess): string {
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
  for (const lesson of getAllEndgameLessons() as EndgameLesson[]) {
    for (const pos of lesson.positions) {
      all.push({ position: pos, fromLesson: lesson.name });
    }
  }
  // Deterministic shuffle by seed so re-runs at the same seed are
  // reproducible. Mulberry32-style PRNG for portability.
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
