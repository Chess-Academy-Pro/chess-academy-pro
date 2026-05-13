/**
 * EvalLabQuiz — recognition + play + conversion, adaptive.
 * ---------------------------------------------------------
 * Per puzzle, the student goes through three stages:
 *
 *   Stage 0 — "What's the result?" (recognition)
 *     Three buttons: White wins / Draw / Black wins. Student picks
 *     before any move. Cold evaluation skill — same eval reflex
 *     they'd need OTB. Ground truth comes from the curator's
 *     `result` for keystones, and inferred from puzzle theme tags
 *     for DB-sourced Lichess puzzles (defensiveMove → drawn,
 *     mate/fork/etc → winning for the student to move).
 *
 *   Stage 1 — "Find the critical move."
 *     Student plays the curator's bestMove (keystone) or the
 *     puzzle's first solution move (Lichess). Wrong drops flash red.
 *
 *   Stage 2 — "Play it out."
 *     Stockfish hard takes over for ~3 plies. Does the position
 *     still hold the same result?
 *
 *   Reveal — three-grade card + tablebase verification when
 *     ≤7 pieces. Final firstTryPerfect = (Stage 0 correct ∧
 *     Stage 1 first-try ∧ held the eval).
 *
 * The pool combines hand-authored keystones (24 curated W/D/L
 * positions across all endgame lessons) with the broader Lichess
 * endgame puzzle DB. Selection is adaptive: each puzzle pulled at
 * the student's current endgame rating ± a widening band, played
 * once per session. Persistent `UserProfile.endgameRating` updates
 * via classic Elo K=32 on each completed puzzle.
 *
 * Hint button + click-to-move + Stockfish-hard fallback all reuse
 * the same wiring as the lesson tab.
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
import { Chess } from 'chess.js';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useNarration } from '../../hooks/useNarration';
import { getAllEndgameLessons } from '../../services/endgameLessonsService';
import { lookupTablebase, type TablebaseLookupResult } from '../../services/lichessTablebaseService';
import {
  applyAdaptiveOutcome,
  createAdaptiveEndgameState,
  DEFAULT_ENDGAME_RATING,
  type AdaptiveEndgameState,
} from '../../services/adaptiveEndgameService';
import { calculateRatingDelta } from '../../services/puzzleService';
import { db } from '../../db/schema';
import { useAppStore } from '../../stores/appStore';
import puzzlesData from '../../data/puzzles.json';

/** How many engine plies the student plays in stage 2. */
const STAGE2_PLIES = 3;

type Verdict = 'white-wins' | 'black-wins' | 'draw';

interface RawPuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
  popularity: number;
  nbPlays: number;
}

const PUZZLES = puzzlesData as RawPuzzle[];

interface EvalLabItem {
  /** Stable id — keystone:<fen> or lichess:<puzzleId>. */
  id: string;
  /** FEN where it's the student's turn. */
  fen: string;
  /** Side the student plays — derived from FEN. */
  studentSide: 'white' | 'black';
  /** Full SAN sequence for stage 1+2 playout. */
  solution: string[];
  /** Ground-truth verdict (best-play outcome). */
  verdict: Verdict;
  /** Rating used for adaptive selection. */
  rating: number;
  /** Lichess theme tags (for weakness tracking). */
  themes: string[];
  /** True when sourced from the curator's keystone pool;
   *  surfaces the named position + curator prose on the reveal. */
  isKeystone: boolean;
  fromLesson?: string;
  title?: string;
  explanation?: string;
  source?: string;
}

interface EvalLabQuizProps {
  onExit: () => void;
}

interface AnsweredItem {
  item: EvalLabItem;
  stage0Correct: boolean;
  stage1FirstTry: boolean;
  heldTheEval: boolean | null;
  firstTryPerfect: boolean;
}

type Stage = 'stage0' | 'stage1' | 'stage2' | 'reveal';

// ─── Pool builder ────────────────────────────────────────────────────

/** Build the combined Eval Lab pool — curated keystones + Lichess
 *  endgame puzzles. Computed once at module load.
 *
 *  Keystones get the curator's explicit `result`. Lichess puzzles
 *  get an inferred verdict from theme tags: defensiveMove /
 *  stalemate / perpetualCheck → 'draw'; anything else →
 *  studentSide wins (Lichess convention). */
function buildEvalLabPool(): EvalLabItem[] {
  const out: EvalLabItem[] = [];

  // 1. Keystones — full W/D/L variety, ~24 entries.
  for (const lesson of getAllEndgameLessons()) {
    for (const pos of lesson.positions) {
      if (!pos.bestMove) continue;
      const stm = pos.fen.split(' ')[1];
      const studentSide: 'white' | 'black' = stm === 'w' ? 'white' : 'black';
      out.push({
        id: `keystone:${pos.fen}`,
        fen: pos.fen,
        studentSide,
        solution: pos.solution && pos.solution.length > 0 ? pos.solution : [pos.bestMove],
        verdict: pos.result,
        rating: 1300,
        themes: lesson.practiceThemes ?? [],
        isKeystone: true,
        fromLesson: lesson.name,
        title: pos.title,
        explanation: pos.explanation,
        source: pos.source,
      });
    }
  }

  // 2. Lichess endgame puzzles — tablebase-eligible (≤7 pieces)
  //    so the reveal can verify ground truth. Filter to popular,
  //    well-played puzzles to keep noise down.
  for (const p of PUZZLES) {
    if (!p.themes.includes('endgame')) continue;
    if (p.popularity < 60) continue;
    if (p.nbPlays < 80) continue;
    const pieces = p.fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
    if (pieces > 7) continue;
    // Replay UCI → SAN. moves[0] is the opponent setup; moves[1..]
    // alternate student/opponent.
    const ucis = p.moves.split(/\s+/).filter(Boolean);
    if (ucis.length < 2) continue;
    const chess = new Chess(p.fen);
    try {
      chess.move({
        from: ucis[0].slice(0, 2),
        to: ucis[0].slice(2, 4),
        promotion: ucis[0].length > 4 ? ucis[0][4] : undefined,
      });
    } catch {
      continue;
    }
    const startFen = chess.fen();
    const sans: string[] = [];
    let parseOk = true;
    for (let i = 1; i < ucis.length; i += 1) {
      try {
        const m = chess.move({
          from: ucis[i].slice(0, 2),
          to: ucis[i].slice(2, 4),
          promotion: ucis[i].length > 4 ? ucis[i][4] : undefined,
        });
        sans.push(m.san);
      } catch {
        parseOk = false;
        break;
      }
    }
    if (!parseOk || sans.length === 0) continue;
    const stm = startFen.split(' ')[1];
    const studentSide: 'white' | 'black' = stm === 'w' ? 'white' : 'black';
    // Verdict inference: defensiveMove / stalemate / perpetualCheck → draw.
    // Otherwise the student wins (Lichess convention).
    const drawnHints = ['defensiveMove', 'stalemate', 'perpetualCheck'];
    const isDrawn = p.themes.some((t) => drawnHints.includes(t));
    const verdict: Verdict = isDrawn
      ? 'draw'
      : studentSide === 'white'
        ? 'white-wins'
        : 'black-wins';
    out.push({
      id: `lichess:${p.id}`,
      fen: startFen,
      studentSide,
      solution: sans,
      verdict,
      rating: p.rating,
      themes: p.themes,
      isKeystone: false,
      source: `Lichess puzzle #${p.id} (rating ${p.rating})`,
    });
  }
  return out;
}

const POOL = buildEvalLabPool();

/** Pick the closest-rated unplayed item from the pool. Widens the
 *  band progressively when none qualify. Null when the entire pool
 *  has been played. */
function pickNextItem(state: AdaptiveEndgameState): EvalLabItem | null {
  const eligible = POOL.filter((it) => !state.playedIds.has(it.id));
  if (eligible.length === 0) return null;
  for (let mult = 1; mult <= 4; mult += 1) {
    const bw = 150 * mult;
    const inBand = eligible.filter(
      (it) => Math.abs(it.rating - state.sessionRating) <= bw,
    );
    if (inBand.length > 0) {
      inBand.sort(
        (a, b) =>
          Math.abs(a.rating - state.sessionRating) -
          Math.abs(b.rating - state.sessionRating),
      );
      const pool = inBand.slice(0, Math.min(5, inBand.length));
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  eligible.sort(
    (a, b) =>
      Math.abs(a.rating - state.sessionRating) -
      Math.abs(b.rating - state.sessionRating),
  );
  return eligible[0];
}

// ─── Main component ────────────────────────────────────────────────

export function EvalLabQuiz({ onExit }: EvalLabQuizProps): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const initialRating = activeProfile?.endgameRating ?? DEFAULT_ENDGAME_RATING;

  const [state, setState] = useState<AdaptiveEndgameState>(() =>
    createAdaptiveEndgameState(initialRating),
  );
  const [current, setCurrent] = useState<EvalLabItem | null>(() =>
    pickNextItem(createAdaptiveEndgameState(initialRating)),
  );
  const [answers, setAnswers] = useState<AnsweredItem[]>([]);

  const handleComplete = useCallback(
    (result: AnsweredItem) => {
      if (!current) return;
      const next = applyAdaptiveOutcome(state, {
        firstTryPerfect: result.firstTryPerfect,
        puzzleRating: current.rating,
        puzzleId: current.id,
        puzzleThemes: current.themes,
      });
      setState(next);
      // Persist the Elo update to the active profile.
      if (activeProfile) {
        const updated = { ...activeProfile, endgameRating: next.userRating };
        setActiveProfile(updated);
        void db.profiles.update(activeProfile.id, { endgameRating: next.userRating });
      }
      setAnswers((prev) => [...prev, result]);
    },
    [current, state, activeProfile, setActiveProfile],
  );

  const advance = useCallback(() => {
    setCurrent(pickNextItem(state));
  }, [state]);

  const reset = useCallback(() => {
    const fresh = createAdaptiveEndgameState(initialRating);
    setState(fresh);
    setCurrent(pickNextItem(fresh));
    setAnswers([]);
  }, [initialRating]);

  if (POOL.length === 0) return <EmptyPool onExit={onExit} />;
  if (!current) return <Summary answers={answers} state={state} onReshuffle={reset} onExit={onExit} />;

  return (
    <QuizItemRunner
      key={current.id}
      item={current}
      state={state}
      score={answers.filter((a) => a.firstTryPerfect).length}
      answered={answers.length}
      onExit={onExit}
      onComplete={handleComplete}
      onAdvance={advance}
    />
  );
}

// ─── Per-item runner ───────────────────────────────────────────────

interface QuizItemRunnerProps {
  item: EvalLabItem;
  state: AdaptiveEndgameState;
  score: number;
  answered: number;
  onExit: () => void;
  onComplete: (result: AnsweredItem) => void;
  onAdvance: () => void;
}

function QuizItemRunner({
  item,
  state,
  score,
  answered,
  onExit,
  onComplete,
  onAdvance,
}: QuizItemRunnerProps): JSX.Element {
  // Stage 0 only fires on keystones (curator-set varied verdict).
  // Lichess puzzles are always wins-for-student, so stage 0 there
  // would be a busywork tap — skip straight to stage 1.
  const initialStage: Stage = item.isKeystone ? 'stage0' : 'stage1';
  const [stage, setStage] = useState<Stage>(initialStage);
  const [stage0Guess, setStage0Guess] = useState<Verdict | null>(null);
  const [stage1FirstTry, setStage1FirstTry] = useState<boolean>(true);
  const [tablebaseFinal, setTablebaseFinal] = useState<TablebaseLookupResult | null>(null);
  const [heldTheEval, setHeldTheEval] = useState<boolean | null>(null);
  const [resultLogged, setResultLogged] = useState<boolean>(false);

  const playout = useEndgamePlayout({
    startFen: item.fen,
    solution: item.solution,
    stockfishFallback: true,
    fallbackPliesToPlay: STAGE2_PLIES,
    fallbackDifficulty: 'hard',
    replyDelayMs: 450,
  });
  const clickToMove = useClickToMove(playout);

  // Stage 1 first-try tracking.
  useEffect(() => {
    if (stage === 'stage1' && playout.wrongAttempts > 0) {
      setStage1FirstTry(false);
    }
    if (stage === 'stage1' && playout.hintRevealed) {
      setStage1FirstTry(false);
    }
  }, [stage, playout.wrongAttempts, playout.hintRevealed]);

  // Stage transitions: 0 → 1 happens via onGuess; 1 → 2 when student plays
  // the first move; 2 → reveal when playout completes.
  useEffect(() => {
    if (stage === 'stage1' && playout.studentMovesPlayed >= 1) {
      setStage('stage2');
    }
    if (stage === 'stage2' && playout.isComplete) {
      setStage('reveal');
    }
  }, [stage, playout.studentMovesPlayed, playout.isComplete]);

  // Tablebase lookup at the final FEN — verifies the verdict.
  useEffect(() => {
    if (stage !== 'reveal') return;
    let cancelled = false;
    void lookupTablebase(playout.fen).then((res) => {
      if (cancelled) return;
      setTablebaseFinal(res);
      // heldTheEval: did the position keep the same verdict?
      if (res && res.whiteRelativeResult) {
        setHeldTheEval(res.whiteRelativeResult === item.verdict);
      } else {
        // No tablebase (>7 pieces or fetch failed) — trust that
        // completing the playout counts as holding.
        setHeldTheEval(true);
      }
    });
    return () => { cancelled = true; };
  }, [stage, playout.fen, item.verdict]);

  // Log the outcome ONCE on reveal.
  useEffect(() => {
    if (stage !== 'reveal' || resultLogged || heldTheEval === null) return;
    setResultLogged(true);
    const stage0Correct = item.isKeystone ? stage0Guess === item.verdict : true;
    const firstTryPerfect = stage0Correct && stage1FirstTry && heldTheEval === true;
    onComplete({
      item,
      stage0Correct,
      stage1FirstTry,
      heldTheEval,
      firstTryPerfect,
    });
  }, [stage, resultLogged, heldTheEval, item, stage0Guess, stage1FirstTry, onComplete]);

  const wrongFlash = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return { [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' } };
  }, [playout.wrongSquare]);
  const hintStyles = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.hintRevealed || !playout.hintMove) return {};
    return {
      [playout.hintMove.from]: { background: 'rgba(251, 191, 36, 0.55)', boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.9)' },
      [playout.hintMove.to]: { background: 'rgba(251, 191, 36, 0.35)', boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.7)' },
    };
  }, [playout.hintRevealed, playout.hintMove]);
  const mergedStyles = useMemo<Record<string, CSSProperties>>(() => ({
    ...clickToMove.squareStyles,
    ...hintStyles,
    ...wrongFlash,
  }), [clickToMove.squareStyles, hintStyles, wrongFlash]);

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
            #{answered + 1} · {item.rating}{state.lastAdjustment === 'up' ? ' ↑' : state.lastAdjustment === 'down' ? ' ↓' : ''} · target {state.sessionRating} · you {state.userRating} · {score}/{answered}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  // Stage 0: W/D/L picker. Board is non-interactive — pure recognition.
  if (stage === 'stage0') {
    return (
      <ChessLessonLayout
        header={header}
        board={
          <ConsistentChessboard
            fen={item.fen}
            boardOrientation={item.studentSide}
            interactive={false}
          />
        }
        controls={
          <div className="flex flex-col gap-3 px-2 pb-4">
            <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/10 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Lightbulb size={14} className="text-cyan-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                  Stage 0 · What's the result?
                </span>
              </div>
              <p className="text-sm text-theme-text leading-relaxed">
                With best play from both sides, what's the verdict?
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stage0Button label="White wins" verdict="white-wins" onPick={(v) => { setStage0Guess(v); setStage('stage1'); }} />
              <Stage0Button label="Draw" verdict="draw" onPick={(v) => { setStage0Guess(v); setStage('stage1'); }} />
              <Stage0Button label="Black wins" verdict="black-wins" onPick={(v) => { setStage0Guess(v); setStage('stage1'); }} />
            </div>
          </div>
        }
      />
    );
  }

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={item.studentSide}
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
        <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/10 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Lightbulb size={14} className="text-cyan-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
              Stage 1 · Find the critical move
            </span>
          </div>
          <p className="text-sm text-theme-text leading-relaxed">
            {item.studentSide === 'white' ? 'White' : 'Black'} to play. Play the move that holds your best result.
          </p>
          {playout.wrongAttempts > 0 && (
            <p className="text-[11px] text-amber-400">
              {playout.wrongAttempts === 1
                ? 'Not the move. Try again.'
                : `${playout.wrongAttempts} wrong tries.`}
            </p>
          )}
          {playout.hintMove && !playout.hintRevealed && (
            <button
              onClick={playout.revealHint}
              className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 self-start"
              data-testid="eval-lab-hint"
            >
              <Lightbulb size={11} />
              Hint
            </button>
          )}
        </div>
      </div>
    );
  } else if (stage === 'stage2') {
    const fallbackPliesPlayed = playout.studentMovesPlayed - playout.curatedStudentMoves;
    controls = (
      <div className="flex flex-col gap-3 px-2 pb-4">
        <div className="rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Lightbulb size={14} className="text-amber-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
              Stage 2 · Hold the eval
            </span>
            <span className="ml-auto text-[10px] text-theme-text-muted font-mono">
              {fallbackPliesPlayed}/{STAGE2_PLIES}
            </span>
          </div>
          <p className="text-sm text-theme-text leading-relaxed">
            {playout.phase === 'opponent-replying'
              ? 'Stockfish is responding…'
              : `${item.studentSide === 'white' ? 'White' : 'Black'} to play. Convert against the engine.`}
          </p>
        </div>
      </div>
    );
  } else {
    // reveal
    controls = (
      <div className="flex flex-col gap-3 px-2 pb-4">
        <RevealCard
          item={item}
          stage0Guess={stage0Guess}
          stage1FirstTry={stage1FirstTry}
          heldTheEval={heldTheEval}
          tablebaseFinal={tablebaseFinal}
        />
        <button
          onClick={onAdvance}
          className="w-full px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          data-testid="eval-lab-next"
        >
          Next position
        </button>
      </div>
    );
  }

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

// ─── Stage 0 button ────────────────────────────────────────────────

function Stage0Button({ label, verdict, onPick }: { label: string; verdict: Verdict; onPick: (v: Verdict) => void }): JSX.Element {
  return (
    <button
      onClick={() => onPick(verdict)}
      className="px-2 py-3 rounded-lg border-2 border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-xs font-semibold text-theme-text"
      data-testid={`eval-lab-stage0-${verdict}`}
    >
      {label}
    </button>
  );
}

// ─── Reveal ────────────────────────────────────────────────────────

function RevealCard({
  item,
  stage0Guess,
  stage1FirstTry,
  heldTheEval,
  tablebaseFinal,
}: {
  item: EvalLabItem;
  stage0Guess: Verdict | null;
  stage1FirstTry: boolean;
  heldTheEval: boolean | null;
  tablebaseFinal: TablebaseLookupResult | null;
}): JSX.Element {
  const stage0Correct = item.isKeystone ? stage0Guess === item.verdict : null;
  return (
    <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/5 p-3 flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-theme-text">
        Result: {labelFor(item.verdict)}
      </div>
      <div className="flex flex-col gap-1 text-[12px] text-theme-text">
        {item.isKeystone && (
          <div className="flex items-center gap-1.5">
            {stage0Correct ? <Check size={13} className="text-green-400" /> : <X size={13} className="text-red-400" />}
            <span>
              Recognition: {stage0Correct ? 'spot on' : `you said ${labelFor(stage0Guess ?? 'draw')}`}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {stage1FirstTry ? <Check size={13} className="text-green-400" /> : <X size={13} className="text-amber-400" />}
          <span>Move: {stage1FirstTry ? 'first-try' : 'retry or hint'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {heldTheEval === true ? <Check size={13} className="text-green-400" /> : heldTheEval === false ? <X size={13} className="text-red-400" /> : <AlertTriangle size={13} className="text-amber-400" />}
          <span>Conversion: {heldTheEval === true ? 'held the eval' : heldTheEval === false ? 'slipped during conversion' : 'engine still running'}</span>
        </div>
      </div>
      {tablebaseFinal && tablebaseFinal.whiteRelativeResult && (
        <div className="flex items-center gap-1.5 text-[11px] text-cyan-400 font-medium">
          <ShieldCheck size={13} />
          Tablebase final: {labelFor(tablebaseFinal.whiteRelativeResult)}
          {tablebaseFinal.dtm != null && ` · DTM ${tablebaseFinal.dtm}`}
        </div>
      )}
      {item.isKeystone && item.fromLesson && (
        <div className="text-[10px] text-theme-text-muted">
          From: <span className="text-theme-text font-medium">{item.fromLesson}</span>
          {item.title && ` — ${item.title}`}
        </div>
      )}
      {item.isKeystone && item.explanation && (
        <p className="text-[12px] text-theme-text-muted leading-relaxed">{item.explanation}</p>
      )}
      {item.source && (
        <div className="text-[10px] text-theme-text-muted/70 italic">{item.source}</div>
      )}
    </div>
  );
}

// ─── Summary ───────────────────────────────────────────────────────

function Summary({
  answers,
  state,
  onReshuffle,
  onExit,
}: {
  answers: AnsweredItem[];
  state: AdaptiveEndgameState;
  onReshuffle: () => void;
  onExit: () => void;
}): JSX.Element {
  const perfect = answers.filter((a) => a.firstTryPerfect).length;
  const total = answers.length;
  const percent = total > 0 ? Math.round((perfect / total) * 100) : 0;
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

  // Phase 2: Eval Lab outro narration. Previously the result card
  // appeared silently (David's audit: "no outro narration"). The
  // short spoken line concretely names the score + grade so the
  // user gets audible closure without staring at numbers.
  // Narration text is memoized on the values so React StrictMode's
  // double-effect doesn't double-speak.
  const outroText = useMemo<string>(
    () =>
      total === 0
        ? ''
        : `${perfect} of ${total}. ${percent} percent perfect. ${grade}.`,
    [perfect, total, percent, grade],
  );
  useNarration({ text: outroText });

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
        <h2 className="text-base font-semibold text-theme-text">Pool exhausted</h2>
        <div className="w-[44px]" />
      </div>
      <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/5 p-4 text-center">
        <div className="text-4xl font-bold text-cyan-400">
          {perfect} / {total}
        </div>
        <div className="text-sm text-theme-text-muted mt-1">{percent}% perfect</div>
        <div className="text-xs font-semibold text-theme-text mt-2">{grade}</div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-theme-text-muted">
          <div>
            <div className="text-cyan-400 font-mono text-base">{state.userRating}</div>
            <div>Endgame rating</div>
          </div>
          <div>
            <div className="text-cyan-400 font-mono text-base">{state.bestStreak}</div>
            <div>Best streak</div>
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onReshuffle}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
        >
          <RotateCw size={14} />
          New session
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

function EmptyPool({ onExit }: { onExit: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1 max-w-lg mx-auto w-full text-center" style={{ color: 'var(--color-text)' }}>
      <h2 className="text-base font-semibold text-theme-text">Eval Lab is empty</h2>
      <p className="text-sm text-theme-text-muted">
        No eligible positions in the pool. Check the keystone catalog
        and puzzle DB filters.
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

function labelFor(v: Verdict): string {
  switch (v) {
    case 'white-wins': return 'W wins';
    case 'black-wins': return 'B wins';
    case 'draw': return 'Draw';
  }
}

// Use the imported calculateRatingDelta to suppress unused-import warning
// when bundlers don't tree-shake — the function isn't called directly here
// because applyAdaptiveOutcome already runs the Elo step internally.
void calculateRatingDelta;
