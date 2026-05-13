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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { ArrowLeft, Crown, ChevronLeft, ChevronRight, RotateCw, Lightbulb, MessageCircle } from 'lucide-react';
import type { PieceDropHandlerArgs } from 'react-chessboard';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { ScrollHintBar } from '../Common/ScrollHintBar';
import { useTeachWalkthrough } from '../../hooks/useTeachWalkthrough';
import { useEndgamePlayout } from '../../hooks/useEndgamePlayout';
import { useClickToMove } from '../../hooks/useClickToMove';
import { useAdaptiveEndgameSession } from '../../hooks/useAdaptiveEndgameSession';
import { useNarration } from '../../hooks/useNarration';
import { getMasteredCount } from '../../services/endgameProgressService';
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
  // Legacy tier kept ONLY for the untagged-pattern fallback path
  // (a handful of patterns Lichess doesn't tag). For everything
  // else, adaptive mode drives puzzle picks. Locked at 'beginner'
  // since there's no user-facing toggle any more.
  const [tier] = useState<EndgameTier>('beginner');
  const [sessionSeed, setSessionSeed] = useState<number>(() => Date.now());

  const [lessonMeta, setLessonMeta] = useState<{
    rating: number;
    movesToMate: number;
    totalAvailable: number;
    currentIndex: number;
  } | null>(null);
  const walkthrough = useTeachWalkthrough();

  // Adaptive endgame session scoped to the active pattern's
  // theme tag (when present). Drives puzzle picks on Practice More.
  const selectedPattern = selectedPatternId ? getPatternById(selectedPatternId) : null;
  const adaptiveThemes = useMemo<string[]>(() => {
    if (!selectedPattern?.puzzleThemeTag) return [];
    return [selectedPattern.puzzleThemeTag];
  }, [selectedPattern?.puzzleThemeTag]);
  const adaptive = useAdaptiveEndgameSession(null, { themes: adaptiveThemes });

  // Build a tree for a SPECIFIC puzzle id (adaptive path).
  const buildAndStart = useCallback(
    (patternId: string, puzzleId: string | null): void => {
      const pattern = getPatternById(patternId);
      if (!pattern) return;
      const built = buildMatingPatternLesson(pattern, {
        tier,
        seed: sessionSeed,
        // Adaptive flow passes specificPuzzleId. Falls back to
        // tier-based selection when null.
        specificPuzzleId: puzzleId ?? undefined,
      });
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'CoachEndgamePage.startLesson',
        summary: built
          ? `endgame lesson started: ${pattern.name} #${built.puzzleIndex + 1}/${built.totalAvailable} (mate in ${built.movesToMate}, rating ${built.rating}${puzzleId ? `, adaptive` : `, tier=${tier}`})`
          : `endgame lesson recognition-only: ${pattern.name} (no practice puzzles)`,
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
    [tier, sessionSeed, walkthrough],
  );

  // Extract the Lichess puzzle id from the adaptive session's
  // currentDrill source string. The drill service writes
  // "Lichess puzzle #<id> (rating ...)" — we pull <id> back out.
  const adaptivePuzzleId = useMemo<string | null>(() => {
    const src = adaptive.currentDrill?.source ?? '';
    const m = src.match(/Lichess puzzle\s*#?\s*([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }, [adaptive.currentDrill]);

  const exitLesson = useCallback((): void => {
    walkthrough.stop();
    setSelectedPatternId(null);
    setLessonMeta(null);
  }, [walkthrough]);

  // Practice More: report the previous puzzle's outcome to the
  // adaptive session (which steps target + Elo + picks next), then
  // build a tree from the newly-picked puzzle.
  const practiceMore = useCallback(
    (firstTryPerfect: boolean): void => {
      if (!selectedPatternId) return;
      adaptive.recordOutcome(firstTryPerfect);
      // The adaptive session will surface a NEW currentDrill on
      // its next render; the effect below kicks the rebuild.
    },
    [selectedPatternId, adaptive],
  );

  // Whenever the adaptive session's currentDrill changes for the
  // active pattern, rebuild the walkthrough tree to feature it.
  useEffect(() => {
    if (!selectedPatternId) return;
    if (!adaptivePuzzleId) return;
    buildAndStart(selectedPatternId, adaptivePuzzleId);
    // Don't depend on buildAndStart's full closure — it changes on
    // every render via walkthrough identity. Just re-run when the
    // puzzle id flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatternId, adaptivePuzzleId]);

  const reshufflePractice = useCallback((): void => {
    if (!selectedPatternId) return;
    setSessionSeed(Date.now());
    adaptive.reset();
  }, [selectedPatternId, adaptive]);


  // Picker view — tap a pattern to start the lesson. For tagged
  // patterns, the adaptive session will pick the first puzzle and
  // the buildAndStart effect kicks in. For untagged ones, fall
  // back to the tier-based path.
  if (selectedPatternId === null) {
    return <PatternPicker
      onPick={(id) => {
        const pat = getPatternById(id);
        if (pat?.puzzleThemeTag) {
          // Adaptive will populate currentDrill, which triggers
          // buildAndStart via the effect above.
          setSelectedPatternId(id);
        } else {
          // No Lichess tag → use legacy tier-based flow.
          buildAndStart(id, null);
        }
      }}
      onBack={() => void navigate('/coach/home')}
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
      lessonMeta={lessonMeta}
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
  activeTab: EndgameTab;
  onTabChange: (next: EndgameTab) => void;
}

function PatternPicker({ onPick, onBack, activeTab, onTabChange }: PickerProps): JSX.Element {
  const patterns = useMemo(() => getAllPatterns(), []);
  const named = patterns.filter((p) => p.category === 'named-pattern');
  const piece = patterns.filter((p) => p.category === 'piece-mate');
  // Drives the ScrollHintBar below the strip — the gold arrow sweep
  // tells the user the tabs scroll horizontally when they overflow.
  const tabStripRef = useRef<HTMLDivElement>(null);
  // Index of the currently-selected tab — drives the spotlight
  // position on the ScrollHintBar so the gold pools under the
  // active tab label.
  const activeTabIndex = Math.max(0, TAB_OPTIONS.findIndex((opt) => opt.value === activeTab));

  // Cumulative mastery across every endgame lesson tab. Cheap
  // Dexie aggregate; re-runs whenever the picker mounts so the
  // count reflects the student's most-recent session.
  const [masteredCount, setMasteredCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    void getMasteredCount().then((n) => {
      if (!cancelled) setMasteredCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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
        <div className="flex-1 flex flex-col items-center gap-0.5">
          <h1 className="text-xl font-bold text-center">Endgame with Coach</h1>
          {masteredCount > 0 && (
            <div
              className="inline-flex items-center gap-1 text-[10px] text-green-400 font-medium"
              data-testid="endgame-hub-mastered-count"
            >
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-green-500/20 text-[8px] font-bold">
                ✓
              </span>
              {masteredCount} mastered
            </div>
          )}
        </div>
        <div className="w-[44px]" />
      </div>

      {/* Top-level endgame surface tabs. Mating Patterns is the
          populated tab; the others surface "coming soon" so the
          user can see the surface scope without us shipping
          half-built content. ScrollHintBar below the strip is
          spotlit under the active tab — the gold extends visually
          from the selected label into the bar. */}
      <div className="flex flex-col gap-0 max-w-lg mx-auto w-full">
        <div
          ref={tabStripRef}
          className="flex gap-1 w-full overflow-x-auto"
        >
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
        <ScrollHintBar
          targetRef={tabStripRef}
          axis="x"
          spotlightAt={(activeTabIndex + 0.5) / TAB_OPTIONS.length}
        />
      </div>

      {activeTab === 'mating-patterns' && (
        <>
          <p className="text-sm text-center text-theme-text-muted max-w-lg mx-auto">
            Pick a checkmate pattern. Listen to the geometry, then practice setting it up across multiple positions.
          </p>

          {/* Tier picker dropped — each pattern's drill is now
              adaptive (PR #437/#438): the session pulls puzzles
              from the pattern's puzzleThemeTag at your current
              endgame Elo, stepping up/down per result. The tier
              control was effectively dead UI for tagged patterns. */}

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
  lessonMeta: {
    rating: number;
    movesToMate: number;
    totalAvailable: number;
    currentIndex: number;
  } | null;
  onExit: () => void;
  onPracticeMore: (firstTryPerfect: boolean) => void;
  onReshuffle: () => void;
}

function LessonView({
  pattern,
  walkthrough,
  lessonMeta,
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
  // Cumulative wrong attempts across the entire lesson (all forks).
  // Drives the adaptive Elo update when the student reaches the
  // mating leaf — firstTryPerfect = `lessonWrongAttempts === 0`.
  // Reset only when the LESSON changes (FEN starts over), not on
  // each fork transition.
  const [lessonWrongAttempts, setLessonWrongAttempts] = useState<number>(0);
  const lessonStartFen = walkthrough.tree?.startFen;
  useEffect(() => {
    setLessonWrongAttempts(0);
  }, [lessonStartFen]);

  // Reset the per-fork wrong-attempt counter whenever the fork
  // changes (forkOptions identity flips on fork transition).
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
  // Core move attempt — shared by piece-drop (drag) and the
  // click-to-move flow below. Returns true when the move matched a
  // fork option; false on legal-but-wrong (red flash + counter).
  const tryForkMove = useCallback(
    (from: string, to: string): boolean => {
      if (phase !== 'fork') return false;
      const probe = new Chess(fen);
      let move;
      try {
        move = probe.move({ from, to, promotion: 'q' });
      } catch {
        return false;
      }
      const idx = forkOptions.findIndex((opt) => opt.node.san === move.san);
      if (idx >= 0) {
        walkthrough.pickFork(idx);
        return true;
      }
      setWrongFlash(to);
      setWrongAttempts((n) => n + 1);
      setLessonWrongAttempts((n) => n + 1);
      window.setTimeout(() => setWrongFlash(null), 600);
      return false;
    },
    [phase, fen, forkOptions, walkthrough],
  );

  const handlePieceDrop = useCallback(
    (args: PieceDropHandlerArgs): boolean => {
      if (!args.sourceSquare || !args.targetSquare) return false;
      return tryForkMove(args.sourceSquare, args.targetSquare);
    },
    [tryForkMove],
  );

  // Click-to-move state for the fork phase. Mirrors useClickToMove
  // but uses tryForkMove instead of playMove because this board is
  // driven by useTeachWalkthrough's fork mechanic, not the playout
  // hook.
  const [forkSelected, setForkSelected] = useState<string | null>(null);
  useEffect(() => {
    // Clear selection whenever the FEN changes (auto-played move).
    setForkSelected(null);
  }, [fen]);
  const forkLegalTargets = useMemo<string[]>(() => {
    if (!forkSelected) return [];
    try {
      const c = new Chess(fen);
      return c.moves({ square: forkSelected as Square, verbose: true }).map((m) => m.to);
    } catch {
      return [];
    }
  }, [forkSelected, fen]);
  const handleForkSquareClick = useCallback(
    (args: { square?: string }) => {
      const sq = args.square;
      if (!sq) return;
      if (phase !== 'fork') return;
      if (!forkSelected) {
        try {
          const c = new Chess(fen);
          const piece = c.get(sq as Square);
          if (!piece) return;
          const stm = fen.split(' ')[1];
          if (piece.color !== stm) return;
          setForkSelected(sq);
        } catch {
          /* swallow */
        }
        return;
      }
      if (sq === forkSelected) {
        setForkSelected(null);
        return;
      }
      if (forkLegalTargets.includes(sq)) {
        tryForkMove(forkSelected, sq);
        setForkSelected(null);
        return;
      }
      try {
        const c = new Chess(fen);
        const piece = c.get(sq as Square);
        const stm = fen.split(' ')[1];
        if (piece && piece.color === stm) {
          setForkSelected(sq);
          return;
        }
      } catch {
        /* swallow */
      }
      setForkSelected(null);
    },
    [phase, fen, forkSelected, forkLegalTargets, tryForkMove],
  );
  const forkClickStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    const out: Record<string, React.CSSProperties> = {};
    if (forkSelected) {
      out[forkSelected] = {
        background: 'rgba(0, 229, 255, 0.35)',
        boxShadow: 'inset 0 0 0 2px rgba(0, 229, 255, 0.7)',
      };
    }
    for (const t of forkLegalTargets) {
      out[t] = {
        ...(out[t] ?? {}),
        background:
          out[t]?.background ??
          'radial-gradient(circle, rgba(0, 229, 255, 0.5) 18%, transparent 22%)',
      };
    }
    return out;
  }, [forkSelected, forkLegalTargets]);

  // Hint for the main mating board (fork-based). Parse the correct
  // forkOption's SAN against the current FEN to derive from/to.
  // The correct option is whichever option ISN'T marked
  // 'Not the mate' (curator-set forkSubtitle from endgameService).
  const [matingHintRevealed, setMatingHintRevealed] = useState<boolean>(false);
  useEffect(() => {
    setMatingHintRevealed(false);
  }, [forkOptions]);
  const matingHintMove = useMemo<{ from: string; to: string } | null>(() => {
    if (phase !== 'fork') return null;
    const correct = forkOptions.find((o) => o.forkSubtitle !== 'Not the mate');
    if (!correct || !correct.node.san) return null;
    const correctSan = correct.node.san;
    try {
      const probe = new Chess(fen);
      const moves = probe.moves({ verbose: true });
      const strip = (s: string) =>
        s.replace(/[+#!?]+$/, '').replace(/=Q$|=R$|=B$|=N$/, '');
      const match = moves.find((m) => strip(m.san) === strip(correctSan));
      if (!match) return null;
      return { from: match.from, to: match.to };
    } catch {
      return null;
    }
  }, [phase, forkOptions, fen]);
  const matingHintStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!matingHintRevealed || !matingHintMove) return {};
    return {
      [matingHintMove.from]: {
        background: 'rgba(251, 191, 36, 0.55)',
        boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.9)',
      },
      [matingHintMove.to]: {
        background: 'rgba(251, 191, 36, 0.35)',
        boxShadow: 'inset 0 0 0 2px rgba(251, 191, 36, 0.7)',
      },
    };
  }, [matingHintRevealed, matingHintMove]);
  const revealMatingHint = useCallback(() => {
    setMatingHintRevealed(true);
    // Taking the hint counts as a wrong attempt against the
    // adaptive Elo signal — same convention as useEndgamePlayout
    // (revealHint flips firstTryPerfect=false there). We bump
    // lessonWrongAttempts so when the student reaches the mate
    // and clicks Practice More, the adaptive session sees a
    // non-perfect run and steps the rating down.
    setLessonWrongAttempts((n) => n + 1);
  }, []);

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
              ? `Mate in ${lessonMeta.movesToMate} · rating ${lessonMeta.rating}`
              : hasPractice
                ? 'Adaptive drill'
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
      {/* Tier picker dropped — the mating drill is now adaptive
          (PR #438). Difficulty steps from your endgame Elo
          based on per-attempt success, not a manual tier. */}
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
    // Phase 7b: surface every curated playable position, sorted shallow→deep,
    // so a pattern's mate-in-1 reference and its longer game-citation
    // setups both get airtime. The CuratedMatingLessonView walks them
    // with Prev/Next.
    const curatedPlayables = pattern.lessonPositions
      .filter((lp) => lp.solution && lp.solution.length > 0)
      .sort(
        (a, b) =>
          (a.movesToMate ?? Number.MAX_SAFE_INTEGER) -
          (b.movesToMate ?? Number.MAX_SAFE_INTEGER),
      );
    if (curatedPlayables.length > 0) {
      return (
        <CuratedMatingLessonView
          pattern={pattern}
          positions={curatedPlayables}
          header={header}
          onExit={onExit}
        />
      );
    }
    // Phase 7d: piece-mate fundamentals (K+Q vs K, K+B+B vs K, K+Q+B vs K,
    // K+Q+N vs K) have no curated solution because there's no single
    // "correct" technique — the student drives the lone king to mate
    // against Stockfish defense. Route them through CuratedMatingLessonView
    // in free-play mode (any legal move accepted, ends when mate is on
    // the board).
    if (pattern.category === 'piece-mate' && pattern.lessonPositions[0]) {
      return (
        <CuratedMatingLessonView
          pattern={pattern}
          positions={[
            {
              fen: pattern.lessonPositions[0].fen,
              solution: [],
              movesToMate: null,
            },
          ]}
          freePlay
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
  const mergedForkStyles = useMemo<Record<string, React.CSSProperties>>(() => ({
    ...forkClickStyles,
    ...matingHintStyles,
    ...wrongFlashStyles,
  }), [forkClickStyles, matingHintStyles, wrongFlashStyles]);

  const board = (
    <ConsistentChessboard
      fen={fen}
      boardOrientation={studentSide}
      interactive={phase === 'fork'}
      onPieceDrop={handlePieceDrop}
      onSquareClick={handleForkSquareClick}
      squareStyles={mergedForkStyles}
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
        <div className="flex items-center gap-3 px-1">
          {matingHintMove && !matingHintRevealed && (
            <button
              onClick={revealMatingHint}
              className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
              data-testid="endgame-mating-hint"
            >
              <Lightbulb size={11} />
              Hint
            </button>
          )}
          {matingHintRevealed && matingHintMove && (
            <span className="text-[11px] text-amber-400/80 italic">
              Move highlighted on the board.
            </span>
          )}
          {canBailOut && !showBailoutOptions && (
            <button
              onClick={() => setShowBailoutOptions(true)}
              className="text-xs text-cyan-400 hover:text-cyan-300 underline"
              data-testid="endgame-show-options"
            >
              Show options
            </button>
          )}
        </div>
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
            onClick={() => onPracticeMore(lessonWrongAttempts === 0)}
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

interface CuratedMatingLessonPosition {
  fen: string;
  solution?: string[];
  movesToMate: number | null;
}

interface CuratedMatingLessonViewProps {
  pattern: MatingPattern;
  positions: CuratedMatingLessonPosition[];
  header: React.ReactNode;
  onExit: () => void;
  /** Phase 7d: open-board piece-mate fundamentals (K+Q vs K, K+B+B vs K,
   *  K+Q+B vs K, K+Q+N vs K). No curated SAN — student plays any legal
   *  move; Stockfish defends; phase 'complete' fires when mate is on
   *  the board (or the playout runs out of plies). */
  freePlay?: boolean;
}

function CuratedMatingLessonView({
  pattern,
  positions,
  header,
  onExit,
  freePlay = false,
}: CuratedMatingLessonViewProps): JSX.Element {
  const [posIndex, setPosIndex] = useState(0);
  const safeIndex = Math.min(posIndex, positions.length - 1);
  const current = positions[safeIndex];
  const solution = useMemo(() => current.solution ?? [], [current]);

  const playout = useEndgamePlayout({
    startFen: current.fen,
    solution,
    stockfishFallback: freePlay,
    extendToObviousWin: freePlay,
    fallbackPliesToPlay: freePlay ? 50 : undefined,
    fallbackDifficulty: 'hard',
    replyDelayMs: 450,
  });

  const canPrev = safeIndex > 0;
  const canNext = safeIndex < positions.length - 1;
  const goPrev = useCallback(() => {
    if (canPrev) setPosIndex((n) => n - 1);
  }, [canPrev]);
  const goNext = useCallback(() => {
    if (canNext) setPosIndex((n) => n + 1);
  }, [canNext]);

  // Voice-first: read the pattern intro + recognition cue aloud
  // when the lesson opens. Phase 2 routes this through the shared
  // useNarration hook so lifecycle (stop on unmount / route change /
  // pattern change) is handled in one place. Note: switched from
  // `speak()` to the hook's internal `speakForced` semantics so
  // pattern narration matches EndgameLessonTab's keystone narration
  // (both are opt-in lesson content, pref gate should not mute).
  const matingNarrationText = useMemo<string>(
    () =>
      [`${pattern.name}.`, pattern.narration.intro, pattern.narration.recognition]
        .filter(Boolean)
        .join(' '),
    [pattern.name, pattern.narration.intro, pattern.narration.recognition],
  );
  useNarration({ text: matingNarrationText });
  const wrongFlashStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!playout.wrongSquare) return {};
    return {
      [playout.wrongSquare]: { background: 'rgba(239, 68, 68, 0.45)' },
    };
  }, [playout.wrongSquare]);

  const clickToMove = useClickToMove(playout);
  const hintStyles = useMemo<Record<string, React.CSSProperties>>(() => {
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
  const mergedStyles = useMemo<Record<string, React.CSSProperties>>(() => ({
    ...clickToMove.squareStyles,
    ...hintStyles,
    ...wrongFlashStyles,
  }), [clickToMove.squareStyles, hintStyles, wrongFlashStyles]);

  const board = (
    <ConsistentChessboard
      fen={playout.fen}
      boardOrientation={playout.studentSide}
      interactive={playout.phase === 'student-to-move'}
      onPieceDrop={playout.onPieceDrop}
      onSquareClick={clickToMove.onSquareClick}
      squareStyles={mergedStyles}
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
        {canNext ? (
          <button
            onClick={goNext}
            className="px-4 py-2 rounded-lg bg-theme-accent text-theme-bg text-sm font-semibold"
            data-testid="curated-mating-next-position"
          >
            Try the {positions[safeIndex + 1].movesToMate
              ? `mate-in-${positions[safeIndex + 1].movesToMate}`
              : 'next position'}
          </button>
        ) : null}
        <div className="flex gap-2">
          <button
            onClick={playout.reset}
            className="flex-1 px-4 py-2 rounded-lg bg-theme-surface text-sm font-medium text-theme-text hover:bg-theme-bg"
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
        {positions.length > 1 && (
          <div
            className="flex items-center justify-between text-[11px] text-theme-text-muted px-1"
            data-testid="curated-mating-position-strip"
          >
            <button
              onClick={goPrev}
              disabled={!canPrev}
              className="px-2 py-1 rounded hover:bg-theme-surface disabled:opacity-30"
              aria-label="Previous position"
            >
              <ChevronLeft size={12} />
            </button>
            <span className="font-mono">
              {safeIndex + 1}/{positions.length}
              {current.movesToMate ? ` · M${current.movesToMate}` : ''}
            </span>
            <button
              onClick={goNext}
              disabled={!canNext}
              className="px-2 py-1 rounded hover:bg-theme-surface disabled:opacity-30"
              aria-label="Next position"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5 flex items-start gap-2">
          <Lightbulb size={14} className="text-cyan-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-theme-text">
              {freePlay
                ? playout.studentMovesPlayed === 0
                  ? `Drive the king to mate.`
                  : 'Keep restricting the king.'
                : playout.studentMovesPlayed === 0
                  ? `Find the ${pattern.name}.`
                  : 'Keep the line going.'}
            </div>
            <div className="text-[11px] text-theme-text-muted leading-snug">
              {freePlay
                ? 'Stockfish defends. Any legal move is fine — find mate.'
                : `Drag a piece — ${playout.curatedStudentMoves - playout.studentMovesPlayed} move${playout.curatedStudentMoves - playout.studentMovesPlayed === 1 ? '' : 's'} to mate.`}
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
        <div className="flex items-center gap-3 px-1">
          {playout.hintMove && !playout.hintRevealed && (
            <button
              onClick={playout.revealHint}
              className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
              data-testid="curated-mating-hint"
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
              className="text-xs text-cyan-400 hover:text-cyan-300 underline"
              data-testid="curated-mating-reveal"
            >
              Reveal the line
            </button>
          )}
        </div>
      </div>
    );
  }

  return <ChessLessonLayout header={header} board={board} controls={controls} />;
}
