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
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import {
  getDrillPositionsForLesson,
  getDrillPuzzleCount,
  type DrillTier,
} from '../../services/endgameDrillService';
import { voiceService } from '../../services/voiceService';
import {
  getLessonProgress,
  recordPlay,
} from '../../services/endgameProgressService';
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
          return (
            <button
              key={lesson.id}
              onClick={() => onPick(lesson.id)}
              className={`relative rounded-xl border-2 p-3 text-left transition-colors ${
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
  // The full position list = keystone positions (hand-authored)
  // followed by drill positions (Lichess puzzle DB). The student
  // sees keystones first (named theory, explained), then drills
  // (real-game tests of the same technique). Tier narrows the
  // drill pool to a rating band; mixed = full range.
  const drillPositions = useMemo(
    () => getDrillPositionsForLesson(lesson, { limit: 3, seed: drillSeed, tier }),
    [lesson, drillSeed, tier],
  );
  const allPositions = useMemo(
    () => [...lesson.positions, ...drillPositions],
    [lesson.positions, drillPositions],
  );
  const [posIndex, setPosIndex] = useState(0);
  const position = allPositions[posIndex];
  const isDrill = posIndex >= lesson.positions.length;

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

  return (
    <PositionRunner
      key={`${lesson.id}-${posIndex}-${drillSeed}-${tier}`}
      lesson={lesson}
      position={position}
      posIndex={posIndex}
      totalPositions={allPositions.length}
      keystoneCount={lesson.positions.length}
      isDrill={isDrill}
      drillCount={drillPositions.length}
      tier={tier}
      onTierChange={onTierChange}
      onExit={onExit}
      onPrev={goPrev}
      onNext={goNext}
      canPrev={posIndex > 0}
      canNext={posIndex < allPositions.length - 1}
      onReshuffleDrills={drillPositions.length > 0 ? reshuffleDrills : undefined}
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
  onTierChange: (next: DrillTier) => void;
  onExit: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  onReshuffleDrills?: () => void;
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
  onTierChange,
  onExit,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onReshuffleDrills,
}: PositionRunnerProps): JSX.Element {
  const playout = useEndgamePlayout({
    startFen: position.fen,
    solution: position.solution ?? [],
    bestMove: position.bestMove,
    stockfishFallback: false,
    replyDelayMs: 450,
  });
  const studentSide = playout.studentSide;
  const isPlayable = playout.curatedStudentMoves > 0;

  // Voice-first: speak the position's hand-authored explanation the
  // moment the student lands on it. On the FIRST position of the
  // lesson we lead with the rule + intro so the student hears the
  // principle before the geometry. Polly TTS via voiceService.
  // Manual position change cancels in-flight speech (the speak()
  // implementation calls stop() first).
  useEffect(() => {
    const isFirstPosition = posIndex === 0 && !isDrill;
    const prefix = isFirstPosition
      ? `${lesson.narration.rule} ${lesson.narration.intro} `
      : '';
    const text = `${prefix}${position.title}. ${position.explanation}`;
    void voiceService.speak(text);
    return () => {
      // Stop any in-flight narration when the position changes or
      // the component unmounts so it doesn't keep speaking over the
      // next position.
      voiceService.stop();
    };
  }, [position.fen, position.title, position.explanation, posIndex, isDrill, lesson.narration.rule, lesson.narration.intro]);

  // Persistence: write a progress record when the student completes
  // the playout. Guard against double-recording per position via
  // the ref — the effect dep on `isComplete` would otherwise fire
  // on every re-render with isComplete=true. Reset the guard when
  // the position changes (key change re-mounts PositionRunner via
  // the parent key prop so this ref is fresh per position anyway,
  // but the guard is defensive).
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
  }, [playout.isComplete, playout.firstTryPerfect, playout.wrongAttempts, isPlayable, lesson.id, position.fen]);

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
              ? `Drill ${posIndex - keystoneCount + 1} of ${drillCount} · ${tier} tier`
              : `Keystone ${posIndex + 1} of ${keystoneCount}`}
            {isPlayable && playout.curatedStudentMoves > 1
              ? ` · ${playout.studentMovesPlayed}/${playout.curatedStudentMoves} moves`
              : ''}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
      {hasDrillPool && (
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
              data-testid={`endgame-drill-tier-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={studentSide}
      interactive={playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      squareStyles={wrongFlash}
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
        position={position}
        resultColor={resultColor}
        resultLabel={resultLabel}
        studentSide={studentSide}
        playout={playout}
        isPlayable={isPlayable}
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
        <button
          onClick={onNext}
          disabled={!canNext}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
          <ChevronRight size={16} />
        </button>
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
  position: EndgameLessonPosition;
  resultColor: string;
  resultLabel: string;
  studentSide: 'white' | 'black';
  playout: ReturnType<typeof useEndgamePlayout>;
  isPlayable: boolean;
}

function PositionCard({
  position,
  resultColor,
  resultLabel,
  studentSide,
  playout,
  isPlayable,
}: PositionCardProps): JSX.Element {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-theme-text leading-tight">{position.title}</h3>
        <span className={`text-[11px] font-mono font-semibold ${resultColor} flex-shrink-0`}>
          {resultLabel}
        </span>
      </div>
      <p className="text-[12px] text-theme-text-muted leading-relaxed">{position.explanation}</p>
      {isPlayable ? (
        <PlayoutStatus playout={playout} studentSide={studentSide} />
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
}

function PlayoutStatus({ playout, studentSide }: PlayoutStatusProps): JSX.Element {
  if (playout.isComplete) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-green-400 font-semibold">
          <CheckCircle size={14} />
          {playout.firstTryPerfect ? 'Played perfectly' : 'Line played out'}
        </div>
        <button
          onClick={playout.reset}
          className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 self-start"
        >
          <RotateCw size={11} />
          Try again
        </button>
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
