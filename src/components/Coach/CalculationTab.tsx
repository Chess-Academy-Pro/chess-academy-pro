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
import type { PieceDropHandlerArgs } from 'react-chessboard';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import {
  getCalculationSkills,
  getCalculationSkillById,
  getDrillPuzzles,
  getDrillPuzzleCount,
  type CalculationSkill,
} from '../../services/calculationDrillService';

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
  fen: string;
  /** Expected first move in SAN (computed from puzzle's UCI moves
   *  + chess.js for the FEN). Comparing against this is how we
   *  decide if the user got it right. */
  expectedSan: string;
  /** Lichess puzzle rating — surfaced as difficulty info. */
  rating: number;
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
      const c = new Chess(p.fen);
      const firstUci = p.moves.split(' ')[0];
      const from = firstUci.slice(0, 2);
      const to = firstUci.slice(2, 4);
      const promotion = firstUci.length > 4 ? firstUci.slice(4) : undefined;
      try {
        const mv = c.move({
          from,
          to,
          promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined,
        });
        puzzles.push({ id: p.id, fen: p.fen, expectedSan: mv.san, rating: p.rating });
      } catch {
        // Skip malformed puzzles — should be filtered by the
        // service's invariant tests but defensive anyway.
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
  const [wrongSquare, setWrongSquare] = useState<string | null>(null);
  const current = drill.puzzles[drill.currentIndex];
  const studentSide: 'white' | 'black' = useMemo(
    () => (current?.fen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [current?.fen],
  );
  const outcome = drill.outcomes[drill.currentIndex];
  const score = drill.outcomes.filter((o) => o === 'correct').length;
  const answered = drill.outcomes.filter((o) => o !== null).length;

  // Reset the wrong-square flash when the puzzle changes.
  useEffect(() => {
    setWrongSquare(null);
  }, [drill.currentIndex]);

  const handleDrop = useCallback(
    (args: PieceDropHandlerArgs): boolean => {
      if (!current) return false;
      if (outcome !== null) return false;
      if (!args.sourceSquare || !args.targetSquare) return false;
      const probe = new Chess(current.fen);
      let played;
      try {
        played = probe.move({
          from: args.sourceSquare,
          to: args.targetSquare,
          promotion: 'q',
        });
      } catch {
        return false;
      }
      const stripAnnotations = (san: string): string =>
        san.replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
      const playedClean = stripAnnotations(played.san);
      const expectedClean = stripAnnotations(current.expectedSan);
      if (playedClean === expectedClean) {
        setDrill((prev) => {
          if (!prev) return prev;
          const newOutcomes = [...prev.outcomes];
          newOutcomes[prev.currentIndex] = 'correct';
          return { ...prev, outcomes: newOutcomes };
        });
        return true;
      }
      // Mark wrong if answered for the first time, but allow retry
      // until they get it right OR explicitly skip.
      setWrongSquare(args.targetSquare);
      window.setTimeout(() => setWrongSquare(null), 600);
      return false;
    },
    [current, outcome, setDrill],
  );

  const advance = useCallback(() => {
    setDrill((prev) => {
      if (!prev) return prev;
      if (prev.currentIndex >= prev.puzzles.length - 1) return prev;
      return { ...prev, currentIndex: prev.currentIndex + 1 };
    });
  }, [setDrill]);

  const skipPuzzle = useCallback(() => {
    setDrill((prev) => {
      if (!prev) return prev;
      const newOutcomes = [...prev.outcomes];
      if (newOutcomes[prev.currentIndex] === null) {
        newOutcomes[prev.currentIndex] = 'incorrect';
      }
      return { ...prev, outcomes: newOutcomes };
    });
  }, [setDrill]);

  const flashStyles = useMemo<Record<string, CSSProperties>>(() => {
    if (!wrongSquare) return {};
    return { [wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' } };
  }, [wrongSquare]);

  if (!current) {
    return <DrillSummary drill={drill} skill={skill} onReshuffle={onReshuffle} onExit={onExit} />;
  }

  // Quiz is finished when every puzzle has an outcome AND user
  // pressed "Show summary" — the summary screen surfaces from the
  // last puzzle's "next" button. So if currentIndex is at the
  // last puzzle and outcome is set, show "show summary" CTA.
  const onLastPuzzle = drill.currentIndex === drill.puzzles.length - 1;
  const allAnswered = drill.outcomes.every((o) => o !== null);

  if (onLastPuzzle && allAnswered) {
    return <DrillSummary drill={drill} skill={skill} onReshuffle={onReshuffle} onExit={onExit} />;
  }

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
            Puzzle {drill.currentIndex + 1} of {drill.puzzles.length} · rating {current.rating} · score {score}/{answered}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard
      fen={current.fen}
      boardOrientation={studentSide}
      interactive={outcome === null}
      onPieceDrop={handleDrop}
      squareStyles={flashStyles}
    />
  );

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
        <p className="text-sm text-theme-text">
          {studentSide === 'white' ? 'White' : 'Black'} to play. Find the best move.
        </p>
        {outcome === 'correct' && (
          <div className="flex items-center gap-1.5 text-[12px] text-green-400 font-semibold">
            <Check size={14} />
            Correct — {current.expectedSan}
          </div>
        )}
        {outcome === 'incorrect' && (
          <div className="flex items-center gap-1.5 text-[12px] text-red-400 font-semibold">
            <X size={14} />
            Skipped — the move was {current.expectedSan}
          </div>
        )}
        {outcome === null && (
          <p className="text-[11px] text-cyan-400">Drag a piece to play your move.</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={skipPuzzle}
          disabled={outcome !== null}
          className="px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30"
          data-testid="calculation-skip"
        >
          Skip / Reveal
        </button>
        <span className="text-xs text-theme-text-muted font-mono">
          {drill.currentIndex + 1}/{drill.puzzles.length}
        </span>
        <button
          onClick={advance}
          disabled={outcome === null}
          className="px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
          data-testid="calculation-next"
        >
          Next
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
                  rating {p.rating} · solution: {p.expectedSan}
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
