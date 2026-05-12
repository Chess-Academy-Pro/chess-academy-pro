/**
 * CalculationTab — six calculation skill drills layered over the
 * Lichess puzzle DB.
 *
 * Three views:
 *   1. Skill picker — grid of 6 tiles (one per skill)
 *   2. Skill rationale screen — shows the "why this matters"
 *      narration before the drill starts
 *   3. Drill view — 5 puzzles in sequence, interactive board, the
 *      student drags pieces to attempt the first move of each
 *      puzzle's solution; right move → green + advance, wrong →
 *      red flash + retry
 *
 * Architectural contract: positions and moves come from the
 * puzzle DB (already on disk, 15K curated). The UI verifies user
 * input via chess.js. No runtime LLM authorship.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Lightbulb,
  RotateCw,
  X,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import {
  getCalculationSkills,
  getCalculationSkillById,
  getDrillPuzzles,
  getDrillPuzzleCount,
  type CalculationSkill,
} from '../../services/calculationDrillService';
import { pickConceptHint } from '../../services/puzzleConceptHint';

const PUZZLES_PER_DRILL = 5;

interface CalculationTabProps {
  onExit: () => void;
}

type ViewMode = 'picker' | 'rationale' | 'drill';

interface DrillState {
  puzzles: DrillPuzzle[];
  currentIndex: number;
  /** Per-puzzle outcome: 'correct' | 'incorrect' | null when not
   *  yet answered. */
  outcomes: ('correct' | 'incorrect' | null)[];
}

interface DrillPuzzle {
  id: string;
  /** Starting FEN with the student to move (post-setup). */
  fen: string;
  /** Full alternating SAN sequence — student/opponent/student/...
   *  The student plays each of their moves; opponent replies
   *  auto-play. After the curated line ends, the playout extends
   *  via Stockfish until mate / promotion / decisive material. */
  solutionSans: string[];
  /** Lichess puzzle rating — surfaced as difficulty info. */
  rating: number;
  /** Short concept hint mapped from the puzzle's theme tags. Shown
   *  under the prompt only AFTER the student plays a wrong first
   *  move — gives them a tactical nudge without revealing the move. */
  conceptHint: string | null;
}

export function CalculationTab({ onExit }: CalculationTabProps): JSX.Element {
  const [view, setView] = useState<ViewMode>('picker');
  const [skillId, setSkillId] = useState<string | null>(null);
  const [seed, setSeed] = useState(() => Date.now());
  const [drill, setDrill] = useState<DrillState | null>(null);

  const startSkill = useCallback((id: string) => {
    setSkillId(id);
    setView('rationale');
  }, []);

  const startDrill = useCallback(() => {
    if (!skillId) return;
    const raw = getDrillPuzzles(skillId, { limit: PUZZLES_PER_DRILL, seed });
    const puzzles: DrillPuzzle[] = [];
    for (const p of raw) {
      // Lichess puzzle convention:
      //   puzzle.fen   = position BEFORE the opponent's setup move
      //   moves[0]     = opponent's setup move (auto-played)
      //   moves[1]     = the FIRST move the student must find
      // We apply the setup so the student is presented with the
      // position to solve from — side-to-move is THEIR side.
      // Previous code stored p.fen directly, which left the
      // student looking at the opponent-to-move position and
      // asked them to play the opponent's setup move (find-the-
      // mate from the wrong side).
      const c = new Chess(p.fen);
      const ucis = p.moves.split(/\s+/).filter(Boolean);
      if (ucis.length < 2) continue;
      // Apply opponent's setup move (ucis[0]) → student-to-move FEN.
      // Then convert ucis[1..] (the full puzzle solution, alternating
      // student/opponent) to SAN so the playout runner can drive
      // each prompt.
      try {
        const setupUci = ucis[0];
        c.move({
          from: setupUci.slice(0, 2),
          to: setupUci.slice(2, 4),
          promotion: setupUci.length > 4 ? (setupUci[4] as 'q' | 'r' | 'b' | 'n') : undefined,
        });
        const startFen = c.fen();
        const solutionSans: string[] = [];
        let parseOk = true;
        for (let i = 1; i < ucis.length; i += 1) {
          const u = ucis[i];
          try {
            const mv = c.move({
              from: u.slice(0, 2),
              to: u.slice(2, 4),
              promotion: u.length > 4 ? (u[4] as 'q' | 'r' | 'b' | 'n') : undefined,
            });
            solutionSans.push(mv.san);
          } catch {
            parseOk = false;
            break;
          }
        }
        if (!parseOk || solutionSans.length === 0) continue;
        puzzles.push({
          id: p.id,
          fen: startFen,
          solutionSans,
          rating: p.rating,
          conceptHint: pickConceptHint(p.themes),
        });
      } catch {
        // Skip malformed puzzles — defensive.
      }
    }
    setDrill({
      puzzles,
      currentIndex: 0,
      outcomes: puzzles.map(() => null),
    });
    setView('drill');
  }, [skillId, seed]);

  const exitToPicker = useCallback(() => {
    setView('picker');
    setSkillId(null);
    setDrill(null);
  }, []);

  const reshuffle = useCallback(() => {
    setSeed(Date.now());
    if (skillId) startDrill();
  }, [skillId, startDrill]);

  if (view === 'picker') {
    return <SkillPicker onPick={startSkill} onBack={onExit} />;
  }

  const skill = skillId ? getCalculationSkillById(skillId) : null;
  if (!skill) {
    return <SkillPicker onPick={startSkill} onBack={onExit} />;
  }

  if (view === 'rationale') {
    return (
      <RationaleScreen
        skill={skill}
        onStart={startDrill}
        onBack={exitToPicker}
      />
    );
  }

  if (view === 'drill' && drill) {
    return (
      <DrillScreen
        skill={skill}
        drill={drill}
        setDrill={setDrill}
        onExit={exitToPicker}
        onReshuffle={reshuffle}
      />
    );
  }

  return <SkillPicker onPick={startSkill} onBack={onExit} />;
}

// ─── Picker ───────────────────────────────────────────────────────

interface SkillPickerProps {
  onPick: (skillId: string) => void;
  onBack: () => void;
}

function SkillPicker({ onPick, onBack: _onBack }: SkillPickerProps): JSX.Element {
  const skills = useMemo(() => getCalculationSkills(), []);
  return (
    <div className="flex flex-col gap-4 max-w-lg mx-auto w-full">
      <div className="text-center">
        <h2 className="text-base font-semibold text-theme-text">Calculation</h2>
        <p className="text-xs text-theme-text-muted mt-1">
          Six drills built on Lichess puzzle theme tags. Pick a skill to train.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {skills.map((skill, idx) => {
          const count = getDrillPuzzleCount(skill.id);
          return (
            <button
              key={skill.id}
              onClick={() => onPick(skill.id)}
              className="rounded-xl border-2 p-3 text-left transition-colors bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15"
              data-testid={`calculation-skill-${skill.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 text-[10px] font-mono font-semibold">
                      {idx + 1}
                    </span>
                    <span className="text-sm font-semibold text-theme-text leading-tight">
                      {skill.name}
                    </span>
                  </div>
                  <p className="text-[11px] text-theme-text-muted leading-snug line-clamp-2">
                    {skill.description}
                  </p>
                  <div className="text-[10px] text-cyan-400 mt-1.5">
                    {count.toLocaleString()} puzzles available
                  </div>
                </div>
                <ChevronRight size={16} className="text-cyan-400 flex-shrink-0 mt-1" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Rationale screen ────────────────────────────────────────────

interface RationaleScreenProps {
  skill: CalculationSkill;
  onStart: () => void;
  onBack: () => void;
}

function RationaleScreen({ skill, onStart, onBack }: RationaleScreenProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4 max-w-lg mx-auto w-full">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back to skills"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <h2 className="text-base font-semibold text-theme-text">{skill.name}</h2>
        <div className="w-[44px]" />
      </div>
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Lightbulb size={16} className="text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
            Why this matters
          </span>
        </div>
        <p className="text-[13px] text-theme-text leading-relaxed">{skill.rationale}</p>
      </div>
      <button
        onClick={onStart}
        className="w-full px-4 py-3 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
        data-testid="calculation-start-drill"
      >
        Start drill (5 puzzles)
      </button>
    </div>
  );
}

// ─── Drill screen ────────────────────────────────────────────────

interface DrillScreenProps {
  skill: CalculationSkill;
  drill: DrillState;
  setDrill: React.Dispatch<React.SetStateAction<DrillState | null>>;
  onExit: () => void;
  onReshuffle: () => void;
}

function DrillScreen({ skill, drill, setDrill, onExit, onReshuffle }: DrillScreenProps): JSX.Element {
  const current = drill.puzzles[drill.currentIndex];

  const advance = useCallback(() => {
    setDrill((prev) => {
      if (!prev) return prev;
      if (prev.currentIndex >= prev.puzzles.length - 1) return prev;
      return { ...prev, currentIndex: prev.currentIndex + 1 };
    });
  }, [setDrill]);

  const recordOutcome = useCallback(
    (firstTryPerfect: boolean) => {
      setDrill((prev) => {
        if (!prev) return prev;
        // Don't overwrite an existing outcome — recordOutcome can
        // fire multiple times on re-renders after completion; we
        // only commit the FIRST result.
        if (prev.outcomes[prev.currentIndex] !== null) return prev;
        const newOutcomes = [...prev.outcomes];
        newOutcomes[prev.currentIndex] = firstTryPerfect ? 'correct' : 'incorrect';
        return { ...prev, outcomes: newOutcomes };
      });
    },
    [setDrill],
  );

  if (!current) {
    return <DrillSummary drill={drill} skill={skill} onReshuffle={onReshuffle} onExit={onExit} />;
  }

  const onLastPuzzle = drill.currentIndex === drill.puzzles.length - 1;
  const allAnswered = drill.outcomes.every((o) => o !== null);
  if (onLastPuzzle && allAnswered) {
    return <DrillSummary drill={drill} skill={skill} onReshuffle={onReshuffle} onExit={onExit} />;
  }

  return (
    <PuzzleRunner
      key={`${drill.currentIndex}-${current.id}`}
      puzzle={current}
      drillIndex={drill.currentIndex}
      drillTotal={drill.puzzles.length}
      score={drill.outcomes.filter((o) => o === 'correct').length}
      answered={drill.outcomes.filter((o) => o !== null).length}
      skill={skill}
      currentOutcome={drill.outcomes[drill.currentIndex]}
      onRecordOutcome={recordOutcome}
      onAdvance={advance}
      onExit={onExit}
    />
  );
}

interface PuzzleRunnerProps {
  puzzle: DrillPuzzle;
  drillIndex: number;
  drillTotal: number;
  score: number;
  answered: number;
  skill: CalculationSkill;
  currentOutcome: 'correct' | 'incorrect' | null;
  onRecordOutcome: (firstTryPerfect: boolean) => void;
  onAdvance: () => void;
  onExit: () => void;
}

function PuzzleRunner({
  puzzle,
  drillIndex,
  drillTotal,
  score,
  answered,
  skill,
  currentOutcome,
  onRecordOutcome,
  onAdvance,
  onExit,
}: PuzzleRunnerProps): JSX.Element {
  const studentSide: 'white' | 'black' =
    puzzle.fen.split(' ')[1] === 'w' ? 'white' : 'black';

  // Drive the entire puzzle through the playout runner. The
  // student plays each of their moves; opponent replies auto-play
  // from the puzzle's UCI sequence. After the curated line ends,
  // Stockfish extends until mate / promotion / decisive material —
  // so every puzzle plays out to a clear win, not stopping mid-
  // combination. extendToObviousWin caps at 8 fallback plies.
  const playout = useEndgamePlayout({
    startFen: puzzle.fen,
    solution: puzzle.solutionSans,
    extendToObviousWin: true,
    fallbackPliesToPlay: 8,
    fallbackDifficulty: 'easy',
    replyDelayMs: 450,
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
  const mergedSquareStyles = useMemo<Record<string, CSSProperties>>(
    () => ({ ...clickToMove.squareStyles, ...hintStyles, ...wrongFlash }),
    [clickToMove.squareStyles, hintStyles, wrongFlash],
  );

  // When the playout finishes, record outcome ONCE. firstTryPerfect
  // means zero wrong attempts + no hint/reveal taken.
  useEffect(() => {
    if (playout.isComplete && currentOutcome === null) {
      onRecordOutcome(playout.firstTryPerfect);
    }
  }, [playout.isComplete, playout.firstTryPerfect, currentOutcome, onRecordOutcome]);

  const isLast = drillIndex === drillTotal - 1;

  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center flex-shrink-0"
          aria-label="Exit drill"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <h2 className="text-sm font-semibold text-theme-text truncate">{skill.name}</h2>
          <p className="text-xs text-theme-text-muted truncate">
            Puzzle {drillIndex + 1} of {drillTotal} · rating {puzzle.rating} · score {score}/{answered}
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
      squareStyles={mergedSquareStyles}
    />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
        <p className="text-sm text-theme-text">
          {studentSide === 'white' ? 'White' : 'Black'} to play.{' '}
          {playout.isComplete
            ? playout.firstTryPerfect
              ? 'Solved — played to the win.'
              : 'Played through to the win.'
            : 'Play the best move — keep going until the win.'}
        </p>
        {!playout.isComplete && playout.wrongAttempts > 0 && puzzle.conceptHint && (
          <div
            className="text-[12px] text-amber-300 leading-relaxed border-l-2 border-amber-500/40 pl-2"
            data-testid="calc-concept-hint"
          >
            <span className="font-semibold">Concept:</span> {puzzle.conceptHint}
          </div>
        )}
        {playout.isComplete && currentOutcome === 'correct' && (
          <div className="flex items-center gap-1.5 text-[12px] text-green-400 font-semibold">
            <Check size={14} />
            Correct
          </div>
        )}
        {playout.isComplete && currentOutcome === 'incorrect' && (
          <div className="flex items-center gap-1.5 text-[12px] text-red-400 font-semibold">
            <X size={14} />
            Played out — needed a hint or retry
          </div>
        )}
        {!playout.isComplete && (
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
                data-testid="calc-hint"
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
          onClick={playout.reveal}
          disabled={playout.isComplete}
          className="px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30"
          data-testid="calculation-skip"
        >
          Skip / Reveal
        </button>
        <span className="text-xs text-theme-text-muted font-mono">
          {drillIndex + 1}/{drillTotal}
        </span>
        <button
          onClick={onAdvance}
          disabled={!playout.isComplete}
          className="px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
          data-testid="calculation-next"
        >
          {isLast ? 'Done' : 'Next'}
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

// ─── Summary ─────────────────────────────────────────────────────

interface DrillSummaryProps {
  drill: DrillState;
  skill: CalculationSkill;
  onReshuffle: () => void;
  onExit: () => void;
}

function DrillSummary({ drill, skill, onReshuffle, onExit }: DrillSummaryProps): JSX.Element {
  const correct = drill.outcomes.filter((o) => o === 'correct').length;
  const total = drill.outcomes.length;
  const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
  const grade =
    percent === 100
      ? 'Perfect'
      : percent >= 80
        ? 'Sharp'
        : percent >= 60
          ? 'Solid'
          : percent >= 40
            ? 'Building up'
            : 'Drill again';

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
        <h2 className="text-base font-semibold text-theme-text">{skill.name} — done</h2>
        <div className="w-[44px]" />
      </div>
      <div className="rounded-xl border-2 border-cyan-500/30 bg-cyan-500/5 p-4 text-center">
        <div className="text-4xl font-bold text-cyan-400">
          {correct} / {total}
        </div>
        <div className="text-sm text-theme-text-muted mt-1">{percent}%</div>
        <div className="text-xs font-semibold text-theme-text mt-2">{grade}</div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">
          Puzzles
        </h3>
        {drill.puzzles.map((p, i) => {
          const o = drill.outcomes[i];
          const isCorrect = o === 'correct';
          return (
            <div
              key={p.id}
              className={`rounded-lg border p-2 flex items-center gap-2 ${
                isCorrect
                  ? 'border-green-500/30 bg-green-500/5'
                  : 'border-red-500/30 bg-red-500/5'
              }`}
            >
              {isCorrect ? (
                <Check size={14} className="text-green-400 flex-shrink-0" />
              ) : (
                <X size={14} className="text-red-400 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-theme-text">Puzzle #{i + 1}</div>
                <div className="text-[10px] text-theme-text-muted">
                  rating {p.rating} · {p.solutionSans.length} ply solution starting {p.solutionSans[0]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onReshuffle}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          data-testid="calculation-reshuffle"
        >
          <RotateCw size={14} />
          New drill
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
