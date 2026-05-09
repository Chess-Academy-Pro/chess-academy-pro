/**
 * EndgameLessonTab — generic UI for the new hand-authored endgame
 * lesson catalogs (Principles / Pawn Endings / Drawing Patterns /
 * Rook Endings).
 *
 * Two views:
 *   1. Picker grid — tiles per lesson with the rule / one-line teaser
 *   2. Lesson view — full narration (intro / rule / why / history /
 *      tip) + reference positions on board with explanations
 *
 * Identical chrome and feel to the existing Mating Patterns surface,
 * so the surface coheres across tabs. ConsistentChessboard is the
 * only board used; voice narration goes through Polly TTS via
 * voiceService.
 */
import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Lightbulb, BookOpen } from 'lucide-react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import type { EndgameLesson, EndgameLessonPosition } from '../../types/endgameLesson';

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

  return <LessonView lesson={lesson} onExit={() => setSelectedId(null)} />;
}

interface PickerGridProps {
  lessons: EndgameLesson[];
  tabLabel: string;
  tabSubtitle: string;
  onPick: (id: string) => void;
}

function PickerGrid({ lessons, tabLabel, tabSubtitle, onPick }: PickerGridProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4 max-w-lg mx-auto w-full">
      <div className="text-center">
        <h2 className="text-base font-semibold text-theme-text">{tabLabel}</h2>
        <p className="text-xs text-theme-text-muted mt-1">{tabSubtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {lessons.map((lesson) => (
          <button
            key={lesson.id}
            onClick={() => onPick(lesson.id)}
            className="relative rounded-xl border-2 p-3 text-left transition-colors bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15"
            data-testid={`endgame-lesson-${lesson.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 text-[10px] font-mono font-semibold">
                    {lesson.order}
                  </span>
                  <span className="text-sm font-semibold text-theme-text leading-tight">
                    {lesson.name}
                  </span>
                </div>
                <p className="text-[11px] text-theme-text-muted leading-snug line-clamp-2">
                  {lesson.narration.rule}
                </p>
              </div>
              <ChevronRight size={16} className="text-cyan-400 flex-shrink-0 mt-1" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

interface LessonViewProps {
  lesson: EndgameLesson;
  onExit: () => void;
}

function LessonView({ lesson, onExit }: LessonViewProps): JSX.Element {
  const [posIndex, setPosIndex] = useState(0);
  const position = lesson.positions[posIndex];
  const studentSide = useMemo<'white' | 'black'>(
    () => (position.fen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [position.fen],
  );

  const goPrev = useCallback(() => {
    setPosIndex((i) => Math.max(0, i - 1));
  }, []);
  const goNext = useCallback(() => {
    setPosIndex((i) => Math.min(lesson.positions.length - 1, i + 1));
  }, [lesson.positions.length]);

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
          <h2 className="text-sm font-semibold text-theme-text truncate">{lesson.name}</h2>
          <p className="text-xs text-theme-text-muted truncate">
            Position {posIndex + 1} of {lesson.positions.length}
          </p>
        </div>
        <div className="w-[44px]" />
      </div>
    </div>
  );

  const board = (
    <ConsistentChessboard fen={position.fen} boardOrientation={studentSide} />
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
      <PositionCard position={position} resultColor={resultColor} resultLabel={resultLabel} />
      {posIndex === 0 && <NarrationPanel lesson={lesson} />}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={goPrev}
          disabled={posIndex === 0}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} />
          Prev
        </button>
        <span className="text-xs text-theme-text-muted font-mono">
          {posIndex + 1}/{lesson.positions.length}
        </span>
        <button
          onClick={goNext}
          disabled={posIndex === lesson.positions.length - 1}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface text-sm text-theme-text-muted hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}

interface PositionCardProps {
  position: EndgameLessonPosition;
  resultColor: string;
  resultLabel: string;
}

function PositionCard({ position, resultColor, resultLabel }: PositionCardProps): JSX.Element {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-theme-text leading-tight">{position.title}</h3>
        <span className={`text-[11px] font-mono font-semibold ${resultColor} flex-shrink-0`}>
          {resultLabel}
        </span>
      </div>
      <p className="text-[12px] text-theme-text-muted leading-relaxed">{position.explanation}</p>
      {position.bestMove && (
        <div className="text-[11px] text-cyan-400 font-mono">Best move: {position.bestMove}</div>
      )}
      {position.source && (
        <div className="text-[10px] text-theme-text-muted/70 italic">{position.source}</div>
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
