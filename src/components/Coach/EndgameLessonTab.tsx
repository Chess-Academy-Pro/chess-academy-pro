/**
 * EndgameLessonTab — playable endgame lesson surface.
 *
 * Two views:
 *   1. Picker grid — tiles per lesson with the rule / one-line teaser
 *   2. Lesson view — full narration + a multi-ply playout per
 *      reference position. The student plays each of their moves
 *      on the board; the opponent's curated reply auto-plays
 *      after a brief delay. Wrong drops flash red and let the
 *      student retry. The lesson advances only after the student
 *      plays the entire authored sequence.
 *
 * Architectural contract — same as everywhere else:
 *   - chessboard always goes through ConsistentChessboard
 *   - timing/playback driven by useEndgamePlayout
 *   - moves come from the JSON data (solution[] / bestMove)
 *   - LLM authorship is zero at runtime
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  BookOpen,
  CheckCircle,
  RotateCw,
  Eye,
  Volume2,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useAdaptiveEndgameSession } from '../../hooks/useAdaptiveEndgameSession';
import {
  getDrillPositionsForLesson,
  getDrillPuzzleCount,
  type DrillTier,
} from '../../services/endgameDrillService';
import { voiceService } from '../../services/voiceService';
import {
  getLessonProgress,
  recordPlay,
  resetLessonProgress,
} from '../../services/endgameProgressService';
import { EndgameRecapCard } from './EndgameRecapCard';
import type { EndgameLesson, EndgameLessonPosition } from '../../types/endgameLesson';
import type { EndgameProgressRecord } from '../../types';

const TIER_OPTIONS: { value: DrillTier; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'mixed', label: 'Mixed' },
];

interface EndgameLessonTabProps {
  /** Lessons to surface in the picker (already sorted by order). */
  lessons: EndgameLesson[];
  /** Tab name for the picker header. */
  tabLabel: string;
  /** Short description rendered above the grid — sets context for
   *  the user before they pick a tile. */
  tabSubtitle: string;
}

export function EndgameLessonTab({ lessons, tabLabel, tabSubtitle }: EndgameLessonTabProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (selectedId === null) {
    return (
      <PickerGrid
        lessons={lessons}
        tabLabel={tabLabel}
        tabSubtitle={tabSubtitle}
        onPick={setSelectedId}
      />
    );
  }

  const lesson = lessons.find((l) => l.id === selectedId);
  if (!lesson) {
    setSelectedId(null);
    return <div />;
  }

  const onExitLesson = (): void => {
    // Kill any in-flight voice the moment the student leaves so a
    // half-played narration doesn't continue speaking on the picker.
    voiceService.stop();
    setSelectedId(null);
  };

  return <LessonView lesson={lesson} onExit={onExitLesson} />;
}

interface PickerGridProps {
  lessons: EndgameLesson[];
  tabLabel: string;
  tabSubtitle: string;
  onPick: (id: string) => void;
}

function PickerGrid({ lessons, tabLabel, tabSubtitle, onPick }: PickerGridProps): JSX.Element {
  // Persisted progress per lesson — { [lessonId]: masteredCount }.
  // Loaded once on mount; not live-updated because the picker is
  // re-mounted whenever the student returns from a lesson.
  const [masteredByLesson, setMasteredByLesson] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: Record<string, number> = {};
      for (const lesson of lessons) {
        const records: EndgameProgressRecord[] = await getLessonProgress(lesson.id);
        entries[lesson.id] = records.filter((r) => r.mastered).length;
      }
      if (!cancelled) setMasteredByLesson(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [lessons]);

  return (
    <div className="flex flex-col gap-4 max-w-lg mx-auto w-full">
      <div className="text-center">
        <h2 className="text-base font-semibold text-theme-text">{tabLabel}</h2>
        <p className="text-xs text-theme-text-muted mt-1">{tabSubtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {lessons.map((lesson) => {
          const playableCount = lesson.positions.filter(
            (p) => p.bestMove || (p.solution && p.solution.length > 0),
          ).length;
          const drillCount = getDrillPuzzleCount(lesson, 'mixed');
          const beginnerCount = getDrillPuzzleCount(lesson, 'beginner');
          const masteredCount = masteredByLesson[lesson.id] ?? 0;
          const isFullyMastered =
            masteredCount > 0 && masteredCount >= playableCount && playableCount > 0;
          const onResetLesson = async (): Promise<void> => {
            if (!window.confirm(`Reset progress for "${lesson.name}"?`)) return;
            await resetLessonProgress(lesson.id);
            setMasteredByLesson((prev) => ({ ...prev, [lesson.id]: 0 }));
          };
          return (
            <div key={lesson.id} className="relative">
              <button
                onClick={() => onPick(lesson.id)}
                className={`w-full relative rounded-xl border-2 p-3 text-left transition-colors ${
                  isFullyMastered
                    ? 'bg-green-500/10 border-green-500/30 hover:bg-green-500/15'
                    : 'bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15'
                }`}
                data-testid={`endgame-lesson-${lesson.id}`}
              >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-mono font-semibold ${
                        isFullyMastered
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-cyan-500/20 text-cyan-400'
                      }`}
                    >
                      {isFullyMastered ? '✓' : lesson.order}
                    </span>
                    <span className="text-sm font-semibold text-theme-text leading-tight">
                      {lesson.name}
                    </span>
                  </div>
                  <p className="text-[11px] text-theme-text-muted leading-snug line-clamp-2">
                    {lesson.narration.rule}
                  </p>
                  <div className="text-[10px] text-cyan-400 mt-1.5">
                    {lesson.positions.length} keystone{lesson.positions.length === 1 ? '' : 's'}
                    {playableCount > 0 && ` · ${playableCount} playable`}
                    {masteredCount > 0 && playableCount > 0 && (
                      <span className="text-green-400 font-medium">
                        {' '}
                        · {masteredCount}/{playableCount} mastered
                      </span>
                    )}
                    {drillCount > 0 && (
                      <>
                        {' · '}
                        {drillCount.toLocaleString()} drill puzzles
                        {beginnerCount > 0 && (
                          <span className="text-theme-text-muted">
                            {' '}
                            ({beginnerCount.toLocaleString()} beginner)
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  className={`flex-shrink-0 mt-1 ${
                    isFullyMastered ? 'text-green-400' : 'text-cyan-400'
                  }`}
                />
              </div>
            </button>
            {isFullyMastered && (
              <button
                onClick={onResetLesson}
                className="absolute top-2 right-9 w-7 h-7 rounded-md hover:bg-green-500/20 flex items-center justify-center text-green-400/70 hover:text-green-400 transition-colors"
                aria-label={`Reset progress for ${lesson.name}`}
                title="Reset progress"
                data-testid={`endgame-lesson-reset-${lesson.id}`}
              >
                <RotateCw size={12} />
              </button>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

interface LessonViewProps {
  lesson: EndgameLesson;
  onExit: () => void;
}

function LessonView({ lesson, onExit }: LessonViewProps): JSX.Element {
  const [drillSeed, setDrillSeed] = useState<number>(() => Date.now());
  const [tier, setTier] = useState<DrillTier>('beginner');
  // Persisted mastery for the keystones — { fen → mastered }.
  // Loaded once on lesson open. Drill positions don't surface
  // mastery (they're DB-rotated, not the canonical set).
  const [masteryByFen, setMasteryByFen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const records = await getLessonProgress(lesson.id);
      if (cancelled) return;
      const out: Record<string, boolean> = {};
      for (const r of records) out[r.fen] = r.mastered;
      setMasteryByFen(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [lesson.id]);

  // The full position list = keystones (hand-authored) followed by
  // drills. Drill mode toggles between 'fixed' (3 puzzles from the
  // selected tier — predictable, used for warm-up) and 'adaptive'
  // (infinite stream from the puzzle DB; each puzzle's rating
  // adjusts up/down based on the student's performance — used for
  // sustained training).
  type DrillMode = 'fixed' | 'adaptive';
  const [drillMode, setDrillMode] = useState<DrillMode>('adaptive');

  const adaptive = useAdaptiveEndgameSession(lesson);
  // History of completed adaptive drills + the current one (if any).
  // The current drill comes from adaptive.currentDrill; played
  // drills get pushed into adaptiveHistory on recordOutcome.
  const [adaptiveHistory, setAdaptiveHistory] = useState<EndgameLessonPosition[]>([]);

  // No `limit` — David's audit: "I want users to play as many as
  // they want." The full matching pool is returned, seed-shuffled.
  // Difficulty progression in fixed mode is handled by the tier
  // band (beginner / intermediate / advanced); adaptive mode uses
  // the rating-stepping picker instead.
  const fixedDrills = useMemo(
    () => getDrillPositionsForLesson(lesson, { seed: drillSeed, tier }),
    [lesson, drillSeed, tier],
  );
  const drillPositions = useMemo<EndgameLessonPosition[]>(() => {
    if (drillMode === 'fixed') return fixedDrills;
    // Adaptive: history (already played) + the current pending drill.
    return adaptive.currentDrill
      ? [...adaptiveHistory, adaptive.currentDrill]
      : adaptiveHistory;
  }, [drillMode, fixedDrills, adaptiveHistory, adaptive.currentDrill]);

  const allPositions = useMemo(
    () => [...lesson.positions, ...drillPositions],
    [lesson.positions, drillPositions],
  );
  const [posIndex, setPosIndex] = useState(0);
  const position = allPositions[posIndex] ?? lesson.positions[0];
  const isDrill = posIndex >= lesson.positions.length;
  const isAdaptiveCurrent =
    drillMode === 'adaptive' &&
    isDrill &&
    posIndex === allPositions.length - 1 &&
    adaptive.currentDrill !== null;
  const isMastered = !isDrill && (masteryByFen[position.fen] ?? false);

  // Reset posIndex when drill mode changes so we jump to a
  // sensible start (the first keystone) rather than landing in a
  // drill slot that may no longer exist.
  useEffect(() => {
    setPosIndex(0);
  }, [drillMode]);

  const goPrev = useCallback(() => {
    setPosIndex((i) => Math.max(0, i - 1));
  }, []);
  const goNext = useCallback(() => {
    setPosIndex((i) => Math.min(allPositions.length - 1, i + 1));
  }, [allPositions.length]);
  const reshuffleDrills = useCallback(() => {
    setDrillSeed(Date.now());
    setPosIndex(lesson.positions.length); // jump to first new drill
  }, [lesson.positions.length]);
  const onTierChange = useCallback(
    (next: DrillTier) => {
      setTier(next);
      setDrillSeed(Date.now());
      // Jump to the first drill of the new tier if we're currently
      // viewing a drill; otherwise keep the keystone position.
      setPosIndex((i) => (i >= lesson.positions.length ? lesson.positions.length : i));
    },
    [lesson.positions.length],
  );

  const onPlayPerfect = useCallback((fen: string) => {
    setMasteryByFen((prev) => ({ ...prev, [fen]: true }));
  }, []);

  // When a drill completes, the adaptive session needs to know so
  // it can step the target rating and pick the next puzzle. Only
  // fires for the CURRENT adaptive puzzle (the last item in the
  // adaptive history), not when the student navigates back to a
  // played drill via Prev.
  const onDrillComplete = useCallback(
    (stats: { wrongAttempts: number; durationMs: number }) => {
      if (drillMode !== 'adaptive') return;
      if (!isAdaptiveCurrent) return;
      // Push the finished drill to the history BEFORE advancing
      // the adaptive session, otherwise we'd lose the position
      // when adaptive.currentDrill swaps.
      if (adaptive.currentDrill) {
        setAdaptiveHistory((prev) => [...prev, adaptive.currentDrill as EndgameLessonPosition]);
      }
      // New adaptive algorithm uses a binary correct/wrong signal
      // (matches the tactic puzzle tab). First-try-perfect = no
      // wrong attempts AND no hint/reveal taken — `firstTryPerfect`
      // is tracked by useEndgamePlayout but we only have
      // `wrongAttempts` here; treat 0 wrong attempts as the proxy
      // for first-try-perfect since hint usage already flips
      // firstTryPerfect inside the hook and would have surfaced
      // wrongAttempts via the same playout state.
      adaptive.recordOutcome(stats.wrongAttempts === 0);
    },
    [drillMode, isAdaptiveCurrent, adaptive],
  );

  const completedCount = adaptive.solved + adaptive.failed;

  // Auto-advance posIndex when a new adaptive drill appears at the
  // tail so the student lands on it immediately without clicking
  // Next. Triggered after recordOutcome by the adaptive session's
  // currentDrill changing.
  useEffect(() => {
    if (drillMode !== 'adaptive') return;
    if (completedCount === 0) return;
    setPosIndex(allPositions.length - 1);
  }, [drillMode, completedCount, allPositions.length]);

  return (
    <PositionRunner
      key={`${lesson.id}-${posIndex}-${drillSeed}-${tier}-${drillMode}-${completedCount}`}
      lesson={lesson}
      position={position}
      posIndex={posIndex}
      totalPositions={allPositions.length}
      keystoneCount={lesson.positions.length}
      isDrill={isDrill}
      drillCount={drillPositions.length}
      tier={tier}
      isMastered={isMastered}
      drillMode={drillMode}
      onDrillModeChange={setDrillMode}
      adaptiveTargetRating={adaptive.sessionRating}
      adaptiveCompletedCount={completedCount}
      adaptiveLastAdjustment={adaptive.lastAdjustment}
      adaptiveUserRating={adaptive.userRating}
      onTierChange={onTierChange}
      onExit={onExit}
      onPrev={goPrev}
      onNext={goNext}
      canPrev={posIndex > 0}
      canNext={posIndex < allPositions.length - 1 || (isAdaptiveCurrent && adaptive.currentDrill !== null)}
      onReshuffleDrills={drillPositions.length > 0 && drillMode === 'fixed' ? reshuffleDrills : undefined}
      onPlayPerfect={onPlayPerfect}
      onDrillComplete={onDrillComplete}
    />
  );
}

interface PositionRunnerProps {
  lesson: EndgameLesson;
  position: EndgameLessonPosition;
  posIndex: number;
  totalPositions: number;
  keystoneCount: number;
  isDrill: boolean;
  drillCount: number;
  tier: DrillTier;
  /** Whether this keystone position is already mastered (from
   *  Dexie). Drives the ✓ chip on the position card. Drills don't
   *  surface mastery, so this is always false for drills. */
  isMastered: boolean;
  /** Drill mode: 'fixed' = 3 puzzles at the chosen tier;
   *  'adaptive' = infinite stream with auto difficulty stepping. */
  drillMode: 'fixed' | 'adaptive';
  onDrillModeChange: (mode: 'fixed' | 'adaptive') => void;
  /** Current adaptive target rating — surfaces in the header. */
  adaptiveTargetRating: number;
  /** Adaptive drills completed in this session. */
  adaptiveCompletedCount: number;
  /** Last adjustment direction — for the up/down arrow chip. */
  adaptiveLastAdjustment: 'up' | 'down' | null;
  /** Persistent user endgame Elo. Surfaces beside the session
   *  target in the header so the student sees both numbers. */
  adaptiveUserRating: number;
  onTierChange: (next: DrillTier) => void;
  onExit: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  onReshuffleDrills?: () => void;
  /** Called when the student completes the playout on first try.
   *  Lets the parent flip the in-memory mastery map without
   *  re-querying Dexie. */
  onPlayPerfect?: (fen: string) => void;
  /** Called once when a drill playout completes, with stats the
   *  adaptive session uses to step difficulty. Fired only when
   *  isDrill is true; ignored otherwise. */
  onDrillComplete?: (stats: { wrongAttempts: number; durationMs: number }) => void;
}

function PositionRunner({
  lesson,
  position,
  posIndex,
  totalPositions,
  keystoneCount,
  isDrill,
  drillCount,
  tier,
  isMastered,
  drillMode,
  onDrillModeChange,
  adaptiveTargetRating,
  adaptiveCompletedCount,
  adaptiveLastAdjustment,
  adaptiveUserRating,
  onTierChange,
  onExit,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onReshuffleDrills,
  onPlayPerfect,
  onDrillComplete,
}: PositionRunnerProps): JSX.Element {
  // Toggle for the optional "Play it out vs Stockfish" extension
  // surfaced after a single-bestMove curated portion completes.
  // When engaged, the playout restarts with engine fallback so the
  // student replays the bestMove and then continues against
  // Stockfish for fallbackPliesToPlay more half-moves. Resets when
  // the student navigates to a different position.
  const [playItOut, setPlayItOut] = useState(false);
  useEffect(() => {
    setPlayItOut(false);
  }, [position.fen]);

  const playout = useEndgamePlayout({
    startFen: position.fen,
    solution: position.solution ?? [],
    bestMove: position.bestMove,
    stockfishFallback: playItOut,
    fallbackPliesToPlay: isDrill ? 8 : 4,
    // Drills: extend automatically until mate / promotion / decisive
    // material. Keystones: keep the existing fixed-fallback path
    // (their lines are curated to end at an instructive point).
    extendToObviousWin: isDrill,
    // Max-strength Stockfish on the puzzle-extension path so the
    // engine plays the best defense — the student earns the win
    // against optimal play, not a weakened sparring partner.
    fallbackDifficulty: 'hard',
    replyDelayMs: 450,
  });
  const studentSide = playout.studentSide;
  const isPlayable = playout.curatedStudentMoves > 0;
  // Only single-curated-move keystones benefit from the
  // "Play it out vs Stockfish" extension — multi-move keystones
  // already drill the technique through their full solution.
  const offerPlayItOut =
    isPlayable && playout.curatedStudentMoves === 1 && !isDrill;

  // When the student opts in to play-it-out, the hook starts with
  // stockfishFallback=true but the chess.js position is already at
  // startFen. Calling reset() re-arms the playout so the student
  // can replay the curated bestMove, after which the engine takes
  // over for fallbackPliesToPlay half-moves.
  useEffect(() => {
    if (!playItOut) return;
    playout.reset();
    // playout.reset is stable across renders; we don't want it in
    // the deps because that would loop. Only re-run when playItOut
    // toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playItOut]);

  // Voice-first on keystones, silent on drills. Per CLAUDE.md
  // narration voice rules: the curator-authored prose for keystones
  // teaches the principle; DB-sourced drills are practice (the
  // position IS the lesson at that point) and stay silent so we
  // don't repeat templated phrases across hundreds of puzzles.
  //
  // Build the spoken text once per position so both the auto-effect
  // and the manual Replay button render identical narration.
  const narrationText = useMemo<string>(() => {
    if (!position.explanation) return '';
    const isFirstPosition = posIndex === 0 && !isDrill;
    const prefix = isFirstPosition
      ? `${lesson.narration.rule} ${lesson.narration.intro} `
      : '';
    return `${prefix}${position.title}. ${position.explanation}`;
  }, [position.title, position.explanation, posIndex, isDrill, lesson.narration.rule, lesson.narration.intro]);

  useEffect(() => {
    if (!narrationText) {
      voiceService.stop();
      return;
    }
    // speakForced bypasses the user's voiceEnabled pref — keystone
    // narration is authored content the student opted in to by
    // entering the lesson, not a coach side-channel they can mute.
    // (David's audit: "still not hearing voice narrations" — the
    // most likely silent-fail is a stale prefs.voiceEnabled = false
    // from a previous Master-Off toggle. Forced makes the prefs
    // gate irrelevant.)
    void voiceService.speakForced(narrationText);
    return () => {
      voiceService.stop();
    };
  }, [narrationText, position.fen]);

  const onReplayNarration = useCallback(() => {
    if (!narrationText) return;
    void voiceService.speakForced(narrationText);
  }, [narrationText]);

  // Persistence: write a progress record when the student completes
  // the playout. Guard against double-recording per position via
  // the ref — the effect dep on `isComplete` would otherwise fire
  // on every re-render with isComplete=true. Reset the guard when
  // the position changes (key change re-mounts PositionRunner via
  // the parent key prop so this ref is fresh per position anyway,
  // but the guard is defensive).
  // Time-to-solve tracking — starts when the position mounts,
  // captured on completion to feed the adaptive-difficulty hook.
  const startTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    startTimeRef.current = Date.now();
  }, [position.fen]);

  const recordedRef = useRef(false);
  useEffect(() => {
    if (!playout.isComplete) return;
    if (recordedRef.current) return;
    if (!isPlayable) return; // Reference-only positions don't persist.
    recordedRef.current = true;
    void recordPlay({
      lessonId: lesson.id,
      fen: position.fen,
      firstTryPerfect: playout.firstTryPerfect,
      wrongAttempts: playout.wrongAttempts,
    });
    if (playout.firstTryPerfect && !isDrill && onPlayPerfect) {
      onPlayPerfect(position.fen);
    }
    // Adaptive: report drill completion so the session can step
    // difficulty for the next puzzle. Fires once per drill, in
    // addition to the mastery persistence above.
    if (isDrill && onDrillComplete) {
      onDrillComplete({
        wrongAttempts: playout.wrongAttempts,
        durationMs: Date.now() - startTimeRef.current,
      });
    }
  }, [playout.isComplete, playout.firstTryPerfect, playout.wrongAttempts, isPlayable, isDrill, lesson.id, position.fen, onPlayPerfect, onDrillComplete]);

  const wrongFlash = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return { [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' } };
  }, [playout.wrongSquare]);

  const hasDrillPool = (lesson.practiceThemes?.length ?? 0) > 0;
  const header = (
    <div className="px-3 py-2 md:p-4 border-b border-theme-border">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onExit}
          className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center flex-shrink-0"
          aria-label="Back to lesson list"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <h2 className="text-sm font-semibold text-theme-text truncate">
            {lesson.name}
            {isDrill && <span className="ml-1.5 text-[10px] text-amber-400">DRILL</span>}
          </h2>
          <p className="text-xs text-theme-text-muted truncate">
            {isDrill
              ? drillMode === 'adaptive'
                ? `Drill #${adaptiveCompletedCount + 1} · target ${adaptiveTargetRating}${adaptiveLastAdjustment === 'up' ? ' ↑' : adaptiveLastAdjustment === 'down' ? ' ↓' : ''} · you ${adaptiveUserRating}`
                : `Drill ${posIndex - keystoneCount + 1}${drillCount < 1000 ? ` of ${drillCount}` : ''} · ${tier} tier`
              : `Keystone ${posIndex + 1} of ${keystoneCount}`}
            {isPlayable && playout.curatedStudentMoves > 1
              ? playout.studentMovesPlayed < playout.curatedStudentMoves
                ? ` · ${playout.studentMovesPlayed}/${playout.curatedStudentMoves} moves`
                : ' · playing it out'
              : ''}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
      {hasDrillPool && (
        <div className="flex flex-col gap-1 mt-2">
          <div className="flex justify-center gap-1">
            <button
              onClick={() => onDrillModeChange('adaptive')}
              className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                drillMode === 'adaptive'
                  ? 'bg-theme-accent text-theme-bg'
                  : 'bg-theme-surface text-theme-text-muted hover:bg-theme-bg'
              }`}
              data-testid="endgame-drill-mode-adaptive"
              title="Infinite stream; difficulty adapts to your performance"
            >
              Adaptive
            </button>
            <button
              onClick={() => onDrillModeChange('fixed')}
              className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                drillMode === 'fixed'
                  ? 'bg-theme-accent text-theme-bg'
                  : 'bg-theme-surface text-theme-text-muted hover:bg-theme-bg'
              }`}
              data-testid="endgame-drill-mode-fixed"
              title="Full puzzle pool at the selected tier"
            >
              Fixed tier
            </button>
          </div>
          {drillMode === 'fixed' && (
            <div className="flex justify-center gap-1">
              {TIER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onTierChange(opt.value)}
                  className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                    tier === opt.value
                      ? 'bg-theme-accent text-theme-bg'
                      : 'bg-theme-surface text-theme-text-muted hover:bg-theme-bg'
                  }`}
                  data-testid={`endgame-drill-tier-${opt.value}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const clickToMove = useClickToMove(playout);
  const hintStyles = useMemo<Record<string, CSSProperties>>(() => {
    if (!playout.hintRevealed || !playout.hintMove) return {};
    // Amber tint on the from + to squares; distinct from the cyan
    // click-to-move highlight so the hint reads as something the
    // student requested (peek), not a routine move suggestion.
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

  const mergedStyles = useMemo<Record<string, CSSProperties>>(() => {
    // wrongFlash wins over hint wins over click-to-move so red is
    // always visible for the latest action.
    return { ...clickToMove.squareStyles, ...hintStyles, ...wrongFlash };
  }, [clickToMove.squareStyles, hintStyles, wrongFlash]);

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

  const resultColor =
    position.result === 'white-wins'
      ? 'text-green-400'
      : position.result === 'black-wins'
        ? 'text-red-400'
        : 'text-amber-400';
  const resultLabel =
    position.result === 'white-wins'
      ? 'White wins'
      : position.result === 'black-wins'
        ? 'Black wins'
        : 'Drawn';

  const controls = (
    <div className="flex flex-col gap-3 px-2 pb-4">
      <PositionCard
        lesson={lesson}
        position={position}
        resultColor={resultColor}
        resultLabel={resultLabel}
        studentSide={studentSide}
        playout={playout}
        isPlayable={isPlayable}
        isMastered={isMastered}
        offerPlayItOut={offerPlayItOut}
        playItOutEngaged={playItOut}
        onEngagePlayItOut={() => setPlayItOut(true)}
        onReplayNarration={narrationText ? onReplayNarration : undefined}
      />
      {posIndex === 0 && <NarrationPanel lesson={lesson} />}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onPrev}
          disabled={!canPrev}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} />
          Prev
        </button>
        <span className="text-xs text-theme-text-muted font-mono">
          {posIndex + 1}/{totalPositions}
        </span>
        {canNext ? (
          <button
            onClick={onNext}
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
          >
            Next
            <ChevronRight size={16} />
          </button>
        ) : (
          // Last position — flip to a "Done" CTA that returns the
          // student to the lesson picker instead of a dead-end
          // disabled Next button.
          <button
            onClick={onExit}
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-green-500 text-theme-bg text-sm font-semibold"
            data-testid="endgame-lesson-done"
          >
            Done
            <CheckCircle size={16} />
          </button>
        )}
      </div>
      {onReshuffleDrills && !canNext && (
        <button
          onClick={onReshuffleDrills}
          className="self-center flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-xs text-cyan-400 hover:text-cyan-300"
          data-testid="endgame-reshuffle-drills"
        >
          <RotateCw size={12} />
          New drill set
        </button>
      )}
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

interface PositionCardProps {
  lesson: EndgameLesson;
  position: EndgameLessonPosition;
  resultColor: string;
  resultLabel: string;
  studentSide: 'white' | 'black';
  playout: ReturnType<typeof useEndgamePlayout>;
  isPlayable: boolean;
  isMastered: boolean;
  offerPlayItOut: boolean;
  playItOutEngaged: boolean;
  onEngagePlayItOut: () => void;
  /** Manual replay button — when present, renders a small speaker
   *  affordance next to the title so the user can re-trigger the
   *  narration if it failed to play (or just wants it again). */
  onReplayNarration?: () => void;
}

function PositionCard({
  lesson,
  position,
  resultColor,
  resultLabel,
  studentSide,
  playout,
  isPlayable,
  isMastered,
  offerPlayItOut,
  playItOutEngaged,
  onEngagePlayItOut,
  onReplayNarration,
}: PositionCardProps): JSX.Element {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-theme-text leading-tight flex items-center gap-1.5">
          {isMastered && (
            <span
              className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500/20 text-green-400 text-[9px] font-bold"
              aria-label="Mastered"
              data-testid="endgame-position-mastered"
            >
              ✓
            </span>
          )}
          {position.title}
          {onReplayNarration && (
            <button
              type="button"
              onClick={onReplayNarration}
              className="ml-1 inline-flex items-center justify-center w-6 h-6 rounded-md text-amber-400 hover:bg-amber-500/15 transition-colors"
              aria-label="Replay narration"
              title="Replay narration"
              data-testid="endgame-replay-narration"
            >
              <Volume2 size={14} />
            </button>
          )}
        </h3>
        <span className={`text-[11px] font-mono font-semibold ${resultColor} flex-shrink-0`}>
          {resultLabel}
        </span>
      </div>
      <p className="text-[12px] text-theme-text-muted leading-relaxed">{position.explanation}</p>
      {playout.wrongAttempts > 0 && (position.conceptHint || lesson.narration.rule) && (
        <div
          className="text-[12px] text-amber-300 leading-relaxed border-l-2 border-amber-500/40 pl-2"
          data-testid="endgame-concept-hint"
        >
          <span className="font-semibold">Concept:</span>{' '}
          {position.conceptHint ?? lesson.narration.rule}
        </div>
      )}
      {isPlayable ? (
        <PlayoutStatus
          playout={playout}
          studentSide={studentSide}
          offerPlayItOut={offerPlayItOut}
          playItOutEngaged={playItOutEngaged}
          onEngagePlayItOut={onEngagePlayItOut}
        />
      ) : (
        <div className="text-[11px] text-theme-text-muted italic">
          Reference position — no playable line authored. Study the position and tap Next.
        </div>
      )}
      {position.source && (
        <div className="text-[10px] text-theme-text-muted/70 italic">{position.source}</div>
      )}
    </div>
  );
}

interface PlayoutStatusProps {
  playout: ReturnType<typeof useEndgamePlayout>;
  studentSide: 'white' | 'black';
  offerPlayItOut: boolean;
  playItOutEngaged: boolean;
  onEngagePlayItOut: () => void;
}

function PlayoutStatus({
  playout,
  studentSide,
  offerPlayItOut,
  playItOutEngaged,
  onEngagePlayItOut,
}: PlayoutStatusProps): JSX.Element {
  if (playout.isComplete) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-green-400 font-semibold">
          <CheckCircle size={14} />
          {playItOutEngaged
            ? playout.fallbackOutcome === 'survived'
              ? 'Held the position vs Stockfish'
              : 'Played through'
            : playout.firstTryPerfect
              ? 'Played perfectly'
              : 'Line played out'}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={playout.reset}
            className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
          >
            <RotateCw size={11} />
            Try again
          </button>
          {offerPlayItOut && !playItOutEngaged && (
            <button
              onClick={onEngagePlayItOut}
              className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300"
              data-testid="endgame-play-it-out"
            >
              Play it out vs Stockfish →
            </button>
          )}
        </div>
        <EndgameRecapCard
          studentMoves={playout.studentMoveLog}
          studentSide={studentSide}
        />
      </div>
    );
  }
  if (playout.phase === 'opponent-replying') {
    return (
      <div className="text-[11px] text-amber-400">
        {studentSide === 'white' ? 'Black' : 'White'} is responding…
      </div>
    );
  }
  // student-to-move
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] text-cyan-400">
        {studentSide === 'white' ? 'White' : 'Black'} to play.{' '}
        {playout.curatedStudentMoves > 1
          ? `Play the move — ${playout.curatedStudentMoves - playout.studentMovesPlayed} to go.`
          : 'Play the best move.'}
      </div>
      {playout.wrongAttempts > 0 && (
        <div className="text-[11px] text-amber-400">
          {playout.wrongAttempts === 1
            ? 'Not the move — try again.'
            : `${playout.wrongAttempts} wrong tries.`}
        </div>
      )}
      <div className="flex items-center gap-3 mt-0.5">
        {playout.hintMove && !playout.hintRevealed && (
          <button
            onClick={playout.revealHint}
            className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 self-start"
            data-testid="endgame-hint"
          >
            <Lightbulb size={11} />
            Hint
          </button>
        )}
        {playout.hintRevealed && playout.hintMove && (
          <span className="text-[11px] text-amber-400/80 italic">
            Move highlighted on the board.
          </span>
        )}
        {playout.wrongAttempts >= 2 && (
          <button
            onClick={playout.reveal}
            className="flex items-center gap-1 text-[11px] text-theme-text-muted hover:text-theme-text self-start"
          >
            <Eye size={11} />
            Reveal answer
          </button>
        )}
      </div>
    </div>
  );
}

interface NarrationPanelProps {
  lesson: EndgameLesson;
}

function NarrationPanel({ lesson }: NarrationPanelProps): JSX.Element {
  const { narration } = lesson;
  return (
    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <BookOpen size={14} className="text-cyan-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
          The Lesson
        </h3>
      </div>
      <p className="text-[13px] text-theme-text leading-relaxed">{narration.intro}</p>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
          Rule
        </span>
        <p className="text-[13px] text-theme-text leading-relaxed font-medium">{narration.rule}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
          Why it works
        </span>
        <p className="text-[12px] text-theme-text-muted leading-relaxed">{narration.why}</p>
      </div>
      {narration.history && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
            History
          </span>
          <p className="text-[12px] text-theme-text-muted leading-relaxed italic">
            {narration.history}
          </p>
        </div>
      )}
      {narration.tip && (
        <div className="flex gap-2 items-start mt-1 pt-2 border-t border-cyan-500/15">
          <Lightbulb size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[12px] text-theme-text leading-relaxed">{narration.tip}</p>
        </div>
      )}
    </div>
  );
}
