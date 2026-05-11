/**
 * CoachEndgamePage — endgame teaching surface.
 *
 * Two views in one page:
 *   1. Pattern picker grid — 37 mating patterns categorized by Named
 *      Patterns vs Piece-Mate fundamentals. Each tile shows pattern
 *      name + count of multi-move practice puzzles available in our
 *      local DB.
 *   2. Lesson runtime — when a pattern is selected, runs through 8
 *      practice puzzles (multi-move mates from the Lichess puzzle DB
 *      filtered by the pattern's theme tag, sorted by rating ascending
 *      so the lesson opens easy and ramps up). The intro narration
 *      from `mating-patterns.json` plays at lesson start; each puzzle
 *      becomes a find-the-mate fork with chess.js-derived distractors.
 *
 * David's principle: "the DB is the brain." The pychess Lichess
 * Practice studies provide the canonical recognition position. The
 * Lichess puzzle DB provides the practice corpus. The narration is
 * hand-crafted prose. The LLM is voice (Polly TTS) only — zero
 * authorship at runtime.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { ArrowLeft, Crown, ChevronRight, RotateCw, Lightbulb, MessageCircle } from 'lucide-react';
import type { PieceDropHandlerArgs } from 'react-chessboard';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useTeachWalkthrough } from '../../hooks/useTeachWalkthrough';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import {
  getAllPatterns,
  getPatternById,
  getPracticePuzzleCount,
  buildMatingPatternLesson,
  type EndgameTier,
} from '../../services/endgameService';
import {
  getEndgamePrinciples,
  getPawnEndings,
  getDrawingPatterns,
  getRookEndings,
} from '../../services/endgameLessonsService';
import { EndgameLessonTab } from './EndgameLessonTab';
import { EvalLabQuiz } from './EvalLabQuiz';
import { CalculationTab } from './CalculationTab';
import { FromYourGamesTab } from './FromYourGamesTab';
import { useAppStore } from '../../stores/appStore';
import { logAppAudit } from '../../services/appAuditor';
import type { MatingPattern } from '../../types/matingPattern';

const TIER_OPTIONS: { value: EndgameTier; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'mixed', label: 'Mixed' },
];

/** Top-level endgame surface tabs. Mating Patterns is the only
 *  populated one today — the others are placeholders for future
 *  endgame surfaces (K+P fundamentals, rook endings, etc.) so the
 *  page's IA reflects the real "Endgame" scope, not just mating
 *  patterns. User: "Can you put the mating patterns in their own
 *  tab under endgames?" */
type EndgameTab =
  | 'mating-patterns'
  | 'principles'
  | 'pawn-endings'
  | 'rook-endings'
  | 'drawing-patterns'
  | 'eval-lab'
  | 'calculation'
  | 'from-your-games';
const TAB_OPTIONS: { value: EndgameTab; label: string; ready: boolean }[] = [
  { value: 'mating-patterns', label: 'Mating', ready: true },
  { value: 'principles', label: 'Principles', ready: true },
  { value: 'pawn-endings', label: 'Pawn', ready: true },
  { value: 'rook-endings', label: 'Rook', ready: true },
  { value: 'drawing-patterns', label: 'Drawn', ready: true },
  { value: 'eval-lab', label: 'Eval Lab', ready: true },
  { value: 'calculation', label: 'Calc', ready: true },
  { value: 'from-your-games', label: 'Your Games', ready: true },
];

export function CoachEndgamePage(): JSX.Element {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<EndgameTab>('mating-patterns');
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);
  const [tier, setTier] = useState<EndgameTier>('beginner');
  // Session seed — bump on each lesson load so the within-tier
  // shuffle surfaces fresh puzzles even at the same difficulty.
  const [sessionSeed, setSessionSeed] = useState<number>(() => Date.now());

  const [puzzleIndex, setPuzzleIndex] = useState<number>(0);
  const [lessonMeta, setLessonMeta] = useState<{
    rating: number;
    movesToMate: number;
    totalAvailable: number;
    currentIndex: number;
  } | null>(null);
  const walkthrough = useTeachWalkthrough();

  const startLesson = useCallback(
    (patternId: string, t: EndgameTier, seed: number, index: number): void => {
      const pattern = getPatternById(patternId);
      if (!pattern) return;
      const built = buildMatingPatternLesson(pattern, {
        tier: t,
        seed,
        puzzleIndex: index,
      });
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'CoachEndgamePage.startLesson',
        summary: built
          ? `endgame lesson started: ${pattern.name} #${built.puzzleIndex + 1}/${built.totalAvailable} (mate in ${built.movesToMate}, rating ${built.rating}, tier=${t})`
          : `endgame lesson recognition-only: ${pattern.name} (no practice puzzles for tier=${t})`,
      });
      setSelectedPatternId(patternId);
      if (built) {
        setLessonMeta({
          rating: built.rating,
          movesToMate: built.movesToMate,
          totalAvailable: built.totalAvailable,
          currentIndex: built.puzzleIndex,
        });
        walkthrough.start(built.tree);
      } else {
        setLessonMeta(null);
      }
    },
    [walkthrough],
  );

  const exitLesson = useCallback((): void => {
    walkthrough.stop();
    setSelectedPatternId(null);
    setPuzzleIndex(0);
    setLessonMeta(null);
  }, [walkthrough]);

  const practiceMore = useCallback((): void => {
    if (!selectedPatternId) return;
    const nextIndex = puzzleIndex + 1;
    setPuzzleIndex(nextIndex);
    startLesson(selectedPatternId, tier, sessionSeed, nextIndex);
  }, [selectedPatternId, tier, sessionSeed, puzzleIndex, startLesson]);

  const reshufflePractice = useCallback((): void => {
    if (!selectedPatternId) return;
    const newSeed = Date.now();
    setSessionSeed(newSeed);
    setPuzzleIndex(0);
    startLesson(selectedPatternId, tier, newSeed, 0);
  }, [selectedPatternId, tier, startLesson]);

  const onTierChange = useCallback(
    (next: EndgameTier): void => {
      setTier(next);
      if (selectedPatternId) {
        const newSeed = Date.now();
        setSessionSeed(newSeed);
        setPuzzleIndex(0);
        startLesson(selectedPatternId, next, newSeed, 0);
      }
    },
    [selectedPatternId, startLesson],
  );

  // Picker view.
  if (selectedPatternId === null) {
    return <PatternPicker
      onPick={(id) => {
        setPuzzleIndex(0);
        startLesson(id, tier, sessionSeed, 0);
      }}
      onBack={() => void navigate('/coach/home')}
      tier={tier}
      onTierChange={onTierChange}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />;
  }

  // Lesson view.
  const pattern = getPatternById(selectedPatternId);
  if (!pattern) {
    setSelectedPatternId(null);
    return <div />;
  }

  return (
    <LessonView
      pattern={pattern}
      walkthrough={walkthrough}
      tier={tier}
      lessonMeta={lessonMeta}
      onTierChange={onTierChange}
      onExit={exitLesson}
      onPracticeMore={practiceMore}
      onReshuffle={reshufflePractice}
    />
  );
}

// ─── Picker ─────────────────────────────────────────────────────────

interface PickerProps {
  onPick: (patternId: string) => void;
  onBack: () => void;
  tier: EndgameTier;
  onTierChange: (next: EndgameTier) => void;
  activeTab: EndgameTab;
  onTabChange: (next: EndgameTab) => void;
}

function PatternPicker({ onPick, onBack, tier, onTierChange, activeTab, onTabChange }: PickerProps): JSX.Element {
  const patterns = useMemo(() => getAllPatterns(), []);
  const named = patterns.filter((p) => p.category === 'named-pattern');
  const piece = patterns.filter((p) => p.category === 'piece-mate');

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="coach-endgame-page"
    >
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center"
          aria-label="Back to coach hub"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <h1 className="text-xl font-bold text-center flex-1">Endgame with Coach</h1>
        <div className="w-[44px]" />
      </div>

      {/* Top-level endgame surface tabs. Mating Patterns is the
          populated tab; the others surface "coming soon" so the
          user can see the surface scope without us shipping
          half-built content. */}
      <div className="flex gap-1 max-w-lg mx-auto w-full border-b border-theme-border pb-0.5 overflow-x-auto">
        {TAB_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => opt.ready && onTabChange(opt.value)}
            disabled={!opt.ready}
            className={`flex-1 min-w-[68px] px-2 py-2 text-xs font-medium transition-colors border-b-2 whitespace-nowrap ${
              activeTab === opt.value
                ? 'border-theme-accent text-theme-text'
                : opt.ready
                  ? 'border-transparent text-theme-text-muted hover:text-theme-text'
                  : 'border-transparent text-theme-text-muted/40 cursor-not-allowed'
            }`}
            data-testid={`endgame-tab-${opt.value}`}
          >
            {opt.label}
            {!opt.ready && <span className="text-[9px] block opacity-70">soon</span>}
          </button>
        ))}
      </div>

      {activeTab === 'mating-patterns' && (
        <>
          <p className="text-sm text-center text-theme-text-muted max-w-lg mx-auto">
            Pick a checkmate pattern. Listen to the geometry, then practice setting it up across multiple positions.
          </p>

          {/* Tier selector */}
          <div className="flex justify-center gap-1 max-w-lg mx-auto w-full">
            {TIER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onTierChange(opt.value)}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tier === opt.value
                    ? 'bg-theme-accent text-theme-bg'
                    : 'bg-theme-surface text-theme-text-muted hover:bg-theme-bg'
                }`}
                data-testid={`endgame-tier-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <PatternSection title="Named Patterns" patterns={named} onPick={onPick} />
          <PatternSection title="Piece Mates" patterns={piece} onPick={onPick} subtitle="Recognition only — practice corpus coming soon" />
        </>
      )}

      {activeTab === 'principles' && (
        <EndgameLessonTab
          lessons={getEndgamePrinciples()}
          tabLabel="Endgame Principles"
          tabSubtitle="The seven universal rules. Master these, and every endgame decision gets simpler."
        />
      )}

      {activeTab === 'pawn-endings' && (
        <EndgameLessonTab
          lessons={getPawnEndings()}
          tabLabel="Pawn Endings"
          tabSubtitle="Opposition, key squares, the rule of the square — the foundation of all endgame technique."
        />
      )}

      {activeTab === 'rook-endings' && (
        <EndgameLessonTab
          lessons={getRookEndings()}
          tabLabel="Rook Endings"
          tabSubtitle="Lucena, Philidor, the active rook — the most common endgames in practice."
        />
      )}

      {activeTab === 'drawing-patterns' && (
        <EndgameLessonTab
          lessons={getDrawingPatterns()}
          tabLabel="Drawing Patterns"
          tabSubtitle="The eight positions every player should recognize. Knowing these turns lost games into half-points."
        />
      )}

      {activeTab === 'eval-lab' && (
        <EvalLabQuiz onExit={() => onTabChange('mating-patterns')} />
      )}

      {activeTab === 'calculation' && (
        <CalculationTab onExit={() => onTabChange('mating-patterns')} />
      )}

      {activeTab === 'from-your-games' && (
        <FromYourGamesTab onExit={() => onTabChange('mating-patterns')} />
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle?: string;
  patterns: MatingPattern[];
  onPick: (patternId: string) => void;
}

function PatternSection({ title, subtitle, patterns, onPick }: SectionProps): JSX.Element {
  return (
    <div className="max-w-lg mx-auto w-full flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wider text-theme-text-muted">
          {title}
        </h2>
        {subtitle && (
          <p className="text-[11px] text-theme-text-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {patterns.map((p) => {
          const count = getPracticePuzzleCount(p);
          const hasPractice = count > 0;
          return (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className={`relative rounded-xl border-2 p-3 text-left transition-colors ${
                hasPractice
                  ? 'bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15'
                  : 'bg-theme-surface border-theme-border hover:bg-theme-bg opacity-75'
              }`}
              data-testid={`endgame-pattern-${p.id}`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-sm font-semibold text-theme-text leading-tight">
                  {p.name}
                </span>
                <Crown size={14} className={hasPractice ? 'text-cyan-400' : 'text-theme-text-muted'} />
              </div>
              <div className="text-[10px] text-theme-text-muted mt-1.5">
                {hasPractice
                  ? `${count} practice ${count === 1 ? 'puzzle' : 'puzzles'}`
                  : 'Recognition only'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Lesson view ────────────────────────────────────────────────────

interface LessonViewProps {
  pattern: MatingPattern;
  walkthrough: ReturnType<typeof useTeachWalkthrough>;
  tier: EndgameTier;
  lessonMeta: {
    rating: number;
    movesToMate: number;
    totalAvailable: number;
    currentIndex: number;
  } | null;
  onTierChange: (next: EndgameTier) => void;
  onExit: () => void;
  onPracticeMore: () => void;
  onReshuffle: () => void;
}

function LessonView({
  pattern,
  walkthrough,
  tier,
  lessonMeta,
  onTierChange,
  onExit,
  onPracticeMore,
  onReshuffle,
}: LessonViewProps): JSX.Element {
  const { phase, fen, forkOptions, isLeaf, leafOutro } = walkthrough;
  const hasPractice = getPracticePuzzleCount(pattern) > 0;
  const studentSide = walkthrough.tree?.studentSide ?? 'white';
  const [wrongFlash, setWrongFlash] = useState<string | null>(null);
  // Wrong-attempt counter on the current fork. Resets on each new
  // fork. Used to surface a "Show options" bail-out after 2 wrong
  // tries so the student isn't permanently stuck — but the
  // primary interaction is always board-play, not multiple choice.
  const [wrongAttempts, setWrongAttempts] = useState<number>(0);
  const [showBailoutOptions, setShowBailoutOptions] = useState<boolean>(false);

  // Reset the wrong-attempt counter whenever the fork changes
  // (forkOptions identity flips on fork transition).
  useEffect(() => {
    setWrongAttempts(0);
    setShowBailoutOptions(false);
  }, [forkOptions]);

  // Drop handler — turns a board piece-drop into a fork pick. Only
  // fires during the 'fork' phase (when the student is supposed to
  // find the move). The lesson tree is built as a series of fork
  // choices (correct mate move + 2-3 distractors); this handler
  // converts a board drop into the matching fork index. The MC
  // button list is gone — the student answers by playing on the
  // board. A bail-out toggle (after 2 wrong drops) lets them
  // reveal options if they're stuck.
  const handlePieceDrop = useCallback(
    (args: PieceDropHandlerArgs): boolean => {
      if (phase !== 'fork') return false;
      if (!args.sourceSquare || !args.targetSquare) return false;
      const probe = new Chess(fen);
      let move;
      try {
        move = probe.move({
          from: args.sourceSquare,
          to: args.targetSquare,
          promotion: 'q',
        });
      } catch {
        return false;
      }
      const idx = forkOptions.findIndex((opt) => opt.node.san === move.san);
      if (idx >= 0) {
        walkthrough.pickFork(idx);
        return true;
      }
      // Legal move but not the right answer — flash the destination
      // square red and bump the wrong-attempts counter. After 2
      // wrong drops, the bail-out toggle becomes available.
      setWrongFlash(args.targetSquare);
      setWrongAttempts((n) => n + 1);
      window.setTimeout(() => setWrongFlash(null), 600);
      return false;
    },
    [phase, fen, forkOptions, walkthrough],
  );

  const wrongFlashStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!wrongFlash) return {};
    return {
      [wrongFlash]: { background: 'rgba(239, 68, 68, 0.45)' },
    };
  }, [wrongFlash]);

  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center flex-shrink-0"
          aria-label="Exit lesson"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-theme-text truncate">
            {pattern.name}
          </h2>
          <p className="text-xs text-theme-text-muted truncate">
            {hasPractice && lessonMeta
              ? `Mate in ${lessonMeta.movesToMate} · rating ${lessonMeta.rating} · #${lessonMeta.currentIndex + 1} of ${lessonMeta.totalAvailable}`
              : hasPractice
                ? `${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`
                : 'Recognition only'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onReshuffle}
            disabled={!hasPractice}
            className="p-2 rounded-lg hover:bg-theme-surface min-w-[40px] min-h-[40px] flex items-center justify-center disabled:opacity-30"
            aria-label="Reshuffle practice puzzles"
            title="Reshuffle"
          >
            <RotateCw size={16} className="text-theme-text-muted" />
          </button>
          <button
            onClick={() => useAppStore.getState().setCoachDrawerOpen(true)}
            className="p-2 rounded-lg hover:bg-theme-surface min-w-[40px] min-h-[40px] flex items-center justify-center"
            aria-label="Open chat"
          >
            <MessageCircle size={16} className="text-theme-accent" />
          </button>
        </div>
      </div>
      {hasPractice && (
        <div className="flex justify-center gap-1 mt-2">
          {TIER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onTierChange(opt.value)}
              className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                tier === opt.value
                  ? 'bg-theme-accent text-theme-bg'
                  : 'bg-theme-surface text-theme-text-muted hover:bg-theme-bg'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // No-practice fallback: when Lichess has no puzzle corpus for
  // the pattern, fall back to the curated lessonPositions data.
  // The pychess study data carries multi-move setup-and-mate
  // sequences for several recognition-only patterns — those become
  // playable via useEndgamePlayout. Patterns with neither a
  // Lichess theme tag NOR a curated playable position render as
  // recognition-only (the final fallback).
  if (!hasPractice) {
    const curatedPlayable = pattern.lessonPositions.find(
      (lp) => lp.solution && lp.solution.length > 0,
    );
    if (curatedPlayable && curatedPlayable.solution) {
      return (
        <CuratedMatingLessonView
          pattern={pattern}
          startFen={curatedPlayable.fen}
          solution={curatedPlayable.solution}
          header={header}
          onExit={onExit}
        />
      );
    }
    const recognition = pattern.lessonPositions.find((p) => p.movesToMate === 1) ?? pattern.lessonPositions[0];
    return (
      <ChessLessonLayout
        header={header}
        board={
          <ConsistentChessboard
            fen={recognition.fen}
            boardOrientation={studentSide}
          />
        }
        controls={
          <div className="flex flex-col gap-3 px-2">
            <div className="text-sm leading-relaxed text-theme-text">
              <span className="font-semibold">{pattern.name}.</span> {pattern.narration.intro}
            </div>
            <div className="text-xs leading-relaxed text-theme-text-muted">
              <span className="font-medium text-theme-text">Recognition: </span>
              {pattern.narration.recognition}
            </div>
            {pattern.narration.history && (
              <div className="text-xs leading-relaxed text-theme-text-muted">
                <span className="font-medium text-theme-text">History: </span>
                {pattern.narration.history}
              </div>
            )}
            {pattern.narration.tip && (
              <div className="text-xs leading-relaxed text-theme-text-muted flex gap-1.5">
                <Lightbulb size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <span>{pattern.narration.tip}</span>
              </div>
            )}
            <div className="text-[11px] text-amber-400/80 mt-2">
              No practice puzzles available for this pattern yet — Lichess doesn&apos;t tag this one in their puzzle DB. The position above shows the canonical setup.
            </div>
            <button
              onClick={onExit}
              className="mt-2 px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
            >
              Back to patterns
            </button>
          </div>
        }
      />
    );
  }

  // Live lesson: render walkthrough state. Board is interactive
  // during the 'fork' phase so the student can drag pieces to
  // attempt the correct mate move directly. During narration /
  // animation the board is non-interactive — pieces wouldn't make
  // sense to move while the coach is still talking.
  const board = (
    <ConsistentChessboard
      fen={fen}
      boardOrientation={studentSide}
      interactive={phase === 'fork'}
      onPieceDrop={handlePieceDrop}
      squareStyles={wrongFlashStyles}
    />
  );

  let controls: React.ReactNode;
  if (phase === 'fork') {
    // Board-play primary. The student drags a piece on the board to
    // answer; the drop handler routes to pickFork. After 2 wrong
    // drops a "Show options" bail-out reveals the MC choices so
    // the student isn't permanently stuck — but they only appear
    // on request, not by default.
    const canBailOut = wrongAttempts >= 2;
    controls = (
      <div className="flex flex-col gap-2 px-2">
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5 flex items-start gap-2">
          <Lightbulb size={14} className="text-cyan-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-theme-text">Find the move.</div>
            <div className="text-[11px] text-theme-text-muted leading-snug">
              Drag a piece on the board to play the move that completes the {pattern.name}.
            </div>
          </div>
        </div>
        {wrongAttempts > 0 && !showBailoutOptions && (
          <div className="text-[11px] text-amber-400 px-1">
            {wrongAttempts === 1
              ? 'Not the mate. Try again.'
              : `${wrongAttempts} wrong tries — drag a different piece.`}
          </div>
        )}
        {canBailOut && !showBailoutOptions && (
          <button
            onClick={() => setShowBailoutOptions(true)}
            className="text-xs text-cyan-400 hover:text-cyan-300 underline self-start px-1"
            data-testid="endgame-show-options"
          >
            Show options
          </button>
        )}
        {showBailoutOptions && (
          <div className="flex flex-col gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted px-1">
              Pick the right move
            </div>
            {forkOptions.map((opt, idx) => (
              <button
                key={`${opt.label ?? idx}-${idx}`}
                onClick={() => walkthrough.pickFork(idx)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-theme-surface hover:bg-theme-bg text-left min-h-[48px] transition-colors border border-theme-border"
                data-testid={`endgame-fork-option-${idx}`}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-theme-text">
                    {opt.label ?? `Option ${idx + 1}`}
                  </span>
                  {opt.forkSubtitle && (
                    <span className="text-xs text-theme-text-muted">{opt.forkSubtitle}</span>
                  )}
                </div>
                <ChevronRight size={16} className="text-theme-text-muted flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (isLeaf) {
    controls = (
      <div className="flex flex-col gap-3 px-2">
        {leafOutro && (
          <div className="text-sm leading-relaxed text-theme-text">{leafOutro}</div>
        )}
        <div className="flex gap-2">
          <button
            onClick={onPracticeMore}
            className="flex-1 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
            data-testid="endgame-practice-more"
          >
            Practice more
          </button>
          <button
            onClick={onReshuffle}
            className="px-3 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
            data-testid="endgame-reshuffle"
            aria-label="Reshuffle from start"
          >
            <RotateCw size={16} />
          </button>
          <button
            onClick={onExit}
            className="flex-1 px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
          >
            Back to patterns
          </button>
        </div>
      </div>
    );
  } else {
    // Narration / animation in progress — minimal controls.
    controls = (
      <div className="flex justify-center px-2">
        <button
          onClick={() => walkthrough.skipNarration()}
          className="px-4 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:bg-theme-bg"
        >
          Skip
        </button>
      </div>
    );
  }

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

// ─── Curated mating lesson — playable fallback for untagged patterns ──
// Used when the pattern has no Lichess puzzle corpus but does have
// a multi-move setup-and-mate solution in mating-patterns.json.
// Runs the curated SAN sequence through useEndgamePlayout so the
// student plays the technique on the board — same playability
// guarantee as the tagged-pattern path, sourced from the same
// curated DB.

interface CuratedMatingLessonViewProps {
  pattern: MatingPattern;
  startFen: string;
  solution: string[];
  header: React.ReactNode;
  onExit: () => void;
}

function CuratedMatingLessonView({
  pattern,
  startFen,
  solution,
  header,
  onExit,
}: CuratedMatingLessonViewProps): JSX.Element {
  const playout = useEndgamePlayout({
    startFen,
    solution,
    stockfishFallback: false,
    replyDelayMs: 450,
  });
  const wrongFlashStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return {
      [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' },
    };
  }, [playout.wrongSquare]);

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={playout.studentSide}
      interactive={playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      squareStyles={wrongFlashStyles}
    />
  );

  let controls: React.ReactNode;
  if (playout.isComplete) {
    controls = (
      <div className="flex flex-col gap-3 px-2">
        <div className="text-sm leading-relaxed text-theme-text">
          That&apos;s {pattern.name}.{' '}
          {playout.firstTryPerfect ? 'Played perfectly.' : 'Line completed.'} The geometry is the same
          every time you spot this pattern in your own games.
        </div>
        <div className="flex gap-2">
          <button
            onClick={playout.reset}
            className="flex-1 px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          >
            Play it again
          </button>
          <button
            onClick={onExit}
            className="flex-1 px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
          >
            Back to patterns
          </button>
        </div>
      </div>
    );
  } else if (playout.phase === 'opponent-replying') {
    controls = (
      <div className="px-2">
        <div className="text-[11px] text-amber-400">
          {playout.studentSide === 'white' ? 'Black' : 'White'} responds…
        </div>
      </div>
    );
  } else {
    controls = (
      <div className="flex flex-col gap-2 px-2">
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5 flex items-start gap-2">
          <Lightbulb size={14} className="text-cyan-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-theme-text">
              {playout.studentMovesPlayed === 0 ? `Find the ${pattern.name}.` : 'Keep the line going.'}
            </div>
            <div className="text-[11px] text-theme-text-muted leading-snug">
              Drag a piece — {playout.curatedStudentMoves - playout.studentMovesPlayed} move
              {playout.curatedStudentMoves - playout.studentMovesPlayed === 1 ? '' : 's'} to mate.
            </div>
          </div>
        </div>
        {playout.wrongAttempts > 0 && (
          <div className="text-[11px] text-amber-400 px-1">
            {playout.wrongAttempts === 1
              ? 'Not the move. Try again.'
              : `${playout.wrongAttempts} wrong tries.`}
          </div>
        )}
        {playout.wrongAttempts >= 2 && (
          <button
            onClick={playout.reveal}
            className="text-xs text-cyan-400 hover:text-cyan-300 underline self-start px-1"
            data-testid="curated-mating-reveal"
          >
            Reveal the line
          </button>
        )}
      </div>
    );
  }

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
