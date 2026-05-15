import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Chess } from 'chess.js';
import { sanitizeForTTS } from '../../services/voiceService';
import { generateWalkthroughNarrations } from '../../services/walkthroughLlmNarrator';
import { DrillMode } from './DrillMode';
import { PracticeMode } from './PracticeMode';
import { OpeningPlayMode } from './OpeningPlayMode';
import { TrainMode } from './TrainMode';
import { WalkthroughMode } from './WalkthroughMode';
import { MasteryRing } from './MasteryRing';
import { MiniBoard } from '../Board/MiniBoard';
import { ModelGamesSection } from './ModelGamesSection';
import { ModelGameViewer } from './ModelGameViewer';
import { MiddlegamePlansSection } from './MiddlegamePlansSection';
import { MiddlegamePlanStudy } from './MiddlegamePlanStudy';
import { MiddlegamePractice } from './MiddlegamePractice';
import { CheckpointQuiz } from './CheckpointQuiz';
import { CommonMistakesSection } from './CommonMistakesSection';
import { SidelineExplainer } from './SidelineExplainer';
import commonMistakesData from '../../data/common-mistakes.json';
import checkpointQuizzesData from '../../data/checkpoint-quizzes.json';
import type { CommonMistake, CheckpointQuizItem } from '../../types';
import {
  getOpeningById,
  getMasteryPercent,
  getLinesDiscovered,
  getLinesPerfected,
  getTotalLines,
  toggleFavorite,
} from '../../services/openingService';
import {
  enrollOpening,
  unenrollOpening,
  isEnrolled,
} from '../../services/srsOpeningService';
import { narrateOpeningSection } from '../../services/openingSectionNarrator';
import type { OpeningRecord, ModelGame, MiddlegamePlan } from '../../types';
import {
  ArrowLeft,
  BookOpen as LearnIcon,
  Brain,
  Swords,
  AlertTriangle,
  Lightbulb,
  BookOpen,
  Repeat,
  Clock,
  Target,
  CheckCircle,
  Trophy,
  Volume2,
  Square as StopIcon,
  Crosshair,
  Heart,
  PlayCircle,
  Loader2,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';

type ViewMode =
  | 'detail'
  | 'learn'
  | 'practice'
  | 'play'
  | 'variation-learn'
  | 'variation-practice'
  | 'variation-play'
  | 'trap-learn'
  | 'trap-practice'
  | 'trap-play'
  | 'warning-learn'
  | 'warning-practice'
  | 'warning-play'
  | 'walkthrough'
  | 'variation-walkthrough'
  | 'trap-walkthrough'
  | 'warning-walkthrough'
  | 'train-traps'
  | 'train-warnings'
  | 'model-game'
  | 'middlegame-plan'
  | 'middlegame-practice';

function computeFenFromPgn(pgn: string): string {
  const tokens = pgn.trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  for (const san of tokens) {
    try {
      chess.move(san);
    } catch {
      break;
    }
  }
  return chess.fen();
}

export function OpeningDetailPage(): JSX.Element {
  const { id, playerId } = useParams<{ id: string; playerId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isProContext = location.pathname.includes('/openings/pro/');
  const [opening, setOpening] = useState<OpeningRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('detail');
  const [activeVariationIndex, setActiveVariationIndex] = useState(-1);
  const [activeTrapLineIndex, setActiveTrapLineIndex] = useState(-1);
  const [activeWarningLineIndex, setActiveWarningLineIndex] = useState(-1);
  const [narratingSection, setNarratingSection] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [activeModelGame, setActiveModelGame] = useState<ModelGame | null>(null);
  const [activeMiddlegamePlan, setActiveMiddlegamePlan] = useState<MiddlegamePlan | null>(null);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [quizPlayFen, setQuizPlayFen] = useState<string | null>(null);
  const [srsEnrolled, setSrsEnrolled] = useState<boolean>(false);
  const [srsBusy, setSrsBusy] = useState<boolean>(false);
  const [srsFlash, setSrsFlash] = useState<string | null>(null);

  const loadOpening = useCallback(async (): Promise<void> => {
    if (!id) return;
    const result = await getOpeningById(id);
    setOpening(result ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void loadOpening();
  }, [loadOpening]);

  // SRS enrollment state — refreshed every time the opening loads
  // so toggling from another tab eventually reconciles.
  useEffect(() => {
    if (!id) return;
    void isEnrolled(id).then(setSrsEnrolled);
  }, [id]);

  const handleToggleSrs = useCallback(async (): Promise<void> => {
    if (!opening || srsBusy) return;
    setSrsBusy(true);
    try {
      if (srsEnrolled) {
        await unenrollOpening(opening.id);
        setSrsEnrolled(false);
        setSrsFlash('Removed from trainer');
      } else {
        const result = await enrollOpening(opening);
        setSrsEnrolled(true);
        if (result.added > 0) {
          setSrsFlash(`Added ${result.added} card${result.added !== 1 ? 's' : ''} to trainer`);
        } else if (result.alreadyEnrolled > 0) {
          setSrsFlash('Already in trainer');
        } else {
          setSrsFlash('No reviewable positions in this line');
        }
      }
      setTimeout(() => setSrsFlash(null), 2200);
    } finally {
      setSrsBusy(false);
    }
  }, [opening, srsEnrolled, srsBusy]);

  // Cleanup speech on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  const handleComplete = useCallback((): void => {
    void loadOpening();
  }, [loadOpening]);

  const handleExit = useCallback((): void => {
    setViewMode('detail');
    setActiveVariationIndex(-1);
    setActiveTrapLineIndex(-1);
    setActiveWarningLineIndex(-1);
    setActiveModelGame(null);
    setActiveMiddlegamePlan(null);
    setQuizPlayFen(null);
    void loadOpening();
  }, [loadOpening]);

  const handleQuizPlayPosition = useCallback((fen: string): void => {
    setQuizPlayFen(fen);
    setViewMode('play');
  }, []);

  const handleSelectModelGame = useCallback((game: ModelGame): void => {
    setActiveModelGame(game);
    setViewMode('model-game');
  }, []);

  const handleSelectMiddlegamePlan = useCallback((plan: MiddlegamePlan): void => {
    setActiveMiddlegamePlan(plan);
    setViewMode('middlegame-plan');
  }, []);

  const handlePlayMiddlegamePlan = useCallback((plan: MiddlegamePlan): void => {
    setActiveMiddlegamePlan(plan);
    setViewMode('middlegame-practice');
  }, []);

  // Pre-warm the LLM narration cache when the user picks a variation
  // — fires before WalkthroughMode mounts, so by the time they tap
  // Play the Dexie cache hit returns instantly. Without this the
  // first 3-4 moves play with bare-SAN stubs while the LLM call (~7s)
  // catches up. Idempotent — already-cached results return without
  // a fresh API call.
  const prewarmVariationNarration = useCallback((index: number): void => {
    if (!opening) return;
    const variation = opening.variations?.[index];
    if (!variation?.pgn) return;
    void generateWalkthroughNarrations({
      openingName: opening.name,
      variationName: variation.name,
      pgn: variation.pgn,
    }).catch(() => { /* never break navigation on a pre-warm failure */ });
  }, [opening]);

  const handleStartVariationWalkthrough = useCallback((index: number): void => {
    setActiveVariationIndex(index);
    prewarmVariationNarration(index);
    setViewMode('variation-walkthrough');
  }, [prewarmVariationNarration]);

  const handleStartVariationLearn = useCallback((index: number): void => {
    setActiveVariationIndex(index);
    setViewMode('variation-learn');
  }, []);

  const handleStartVariationPractice = useCallback((index: number): void => {
    setActiveVariationIndex(index);
    setViewMode('variation-practice');
  }, []);

  const handleStartVariationPlay = useCallback((index: number): void => {
    setActiveVariationIndex(index);
    setViewMode('variation-play');
  }, []);

  const handleStartTrapLineAction = useCallback((index: number, action: 'learn' | 'practice' | 'play' | 'walkthrough'): void => {
    setActiveTrapLineIndex(index);
    setViewMode(`trap-${action}` as ViewMode);
  }, []);

  const handleStartWarningLineAction = useCallback((index: number, action: 'learn' | 'practice' | 'play' | 'walkthrough'): void => {
    setActiveWarningLineIndex(index);
    setViewMode(`warning-${action}` as ViewMode);
  }, []);

  const handleToggleFavorite = useCallback(async (): Promise<void> => {
    if (!opening) return;
    const newVal = await toggleFavorite(opening.id);
    setOpening({ ...opening, isFavorite: newVal });
  }, [opening]);

  // ─── Voice narration ──────────────────────────────────────────────────────
  // Sections currently waiting on the LLM paragraph (traps/warnings only).
  const [loadingSection, setLoadingSection] = useState<string | null>(null);
  // Token counter so a stale async fetch can't start speaking after the user
  // has already tapped the button again.
  const narrationRequestToken = useRef(0);

  const speakText = useCallback((sectionId: string, text: string): void => {
    if (!text) {
      setNarratingSection(null);
      return;
    }
    // Sanitize chess notation + piece-letter shorthand before the Web
    // Speech engine sees it. Raw SpeechSynthesisUtterance bypasses
    // voiceService, so we normalise here instead.
    const utterance = new SpeechSynthesisUtterance(sanitizeForTTS(text));
    utterance.rate = 0.95;
    utterance.onend = () => {
      setNarratingSection(null);
      utteranceRef.current = null;
    };
    utterance.onerror = () => {
      setNarratingSection(null);
      utteranceRef.current = null;
    };
    utteranceRef.current = utterance;
    setNarratingSection(sectionId);
    window.speechSynthesis.speak(utterance);
  }, []);

  const toggleNarration = useCallback((
    sectionId: string,
    text: string,
    options?: { kind?: 'traps' | 'warnings'; bullets?: string[] | null },
  ): void => {
    if (narratingSection === sectionId || loadingSection === sectionId) {
      // Stop (or cancel an in-flight fetch)
      window.speechSynthesis.cancel();
      narrationRequestToken.current += 1;
      setNarratingSection(null);
      setLoadingSection(null);
      utteranceRef.current = null;
      return;
    }

    // Stop any current narration
    window.speechSynthesis.cancel();
    narrationRequestToken.current += 1;
    const token = narrationRequestToken.current;

    // Traps & warnings go through the LLM narrator: the dry bullet-list
    // readout is replaced by one cohesive teaching paragraph. Cached, so
    // only the first tap per section per opening pays the round-trip.
    if (opening && options?.kind && options.bullets && options.bullets.length > 0) {
      setLoadingSection(sectionId);
      void narrateOpeningSection({
        openingId: opening.id,
        openingName: opening.name,
        color: opening.color,
        kind: options.kind,
        bullets: options.bullets,
      })
        .then((paragraph) => {
          if (narrationRequestToken.current !== token) return; // superseded
          setLoadingSection(null);
          speakText(sectionId, paragraph || text);
        })
        .catch(() => {
          if (narrationRequestToken.current !== token) return;
          setLoadingSection(null);
          speakText(sectionId, text);
        });
      return;
    }

    speakText(sectionId, text);
  }, [narratingSection, loadingSection, opening, speakText]);

  // Precompute variation FENs for thumbnails
  const variationFens = useMemo((): string[] => {
    if (!opening?.variations) return [];
    return opening.variations.map((v) => computeFenFromPgn(v.pgn));
  }, [opening?.variations]);

  // Precompute trap/warning line FENs for thumbnails
  const trapLineFens = useMemo((): string[] => {
    if (!opening?.trapLines) return [];
    return opening.trapLines.map((v) => computeFenFromPgn(v.pgn));
  }, [opening?.trapLines]);

  const warningLineFens = useMemo((): string[] => {
    if (!opening?.warningLines) return [];
    return opening.warningLines.map((v) => computeFenFromPgn(v.pgn));
  }, [opening?.warningLines]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Loading opening...</p>
      </div>
    );
  }

  if (!opening) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Opening not found.</p>
      </div>
    );
  }

  // Walkthrough mode (main line or variation)
  if (viewMode === 'walkthrough' || viewMode === 'variation-walkthrough') {
    return (
      <WalkthroughMode
        opening={opening}
        variationIndex={viewMode === 'variation-walkthrough' ? activeVariationIndex : undefined}
        onExit={handleExit}
      />
    );
  }

  // Walkthrough mode (trap/warning lines)
  if (viewMode === 'trap-walkthrough' && opening.trapLines?.[activeTrapLineIndex]) {
    return (
      <WalkthroughMode
        opening={opening}
        customLine={opening.trapLines[activeTrapLineIndex]}
        subLineKey={`trap-${activeTrapLineIndex}`}
        onExit={handleExit}
      />
    );
  }
  if (viewMode === 'warning-walkthrough' && opening.warningLines?.[activeWarningLineIndex]) {
    return (
      <WalkthroughMode
        opening={opening}
        customLine={opening.warningLines[activeWarningLineIndex]}
        subLineKey={`warning-${activeWarningLineIndex}`}
        onExit={handleExit}
      />
    );
  }

  // Learn mode (main line or variation)
  if (viewMode === 'learn' || viewMode === 'variation-learn') {
    return (
      <DrillMode
        opening={opening}
        variationIndex={viewMode === 'variation-learn' ? activeVariationIndex : undefined}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }

  // Learn mode (trap/warning lines)
  if (viewMode === 'trap-learn' && opening.trapLines?.[activeTrapLineIndex]) {
    return (
      <DrillMode
        opening={opening}
        customLine={opening.trapLines[activeTrapLineIndex]}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }
  if (viewMode === 'warning-learn' && opening.warningLines?.[activeWarningLineIndex]) {
    return (
      <DrillMode
        opening={opening}
        customLine={opening.warningLines[activeWarningLineIndex]}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }

  // Practice mode (main line or variation)
  if (viewMode === 'practice' || viewMode === 'variation-practice') {
    return (
      <PracticeMode
        opening={opening}
        variationIndex={viewMode === 'variation-practice' ? activeVariationIndex : undefined}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }

  // Practice mode (trap/warning lines)
  if (viewMode === 'trap-practice' && opening.trapLines?.[activeTrapLineIndex]) {
    return (
      <PracticeMode
        opening={opening}
        customLine={opening.trapLines[activeTrapLineIndex]}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }
  if (viewMode === 'warning-practice' && opening.warningLines?.[activeWarningLineIndex]) {
    return (
      <PracticeMode
        opening={opening}
        customLine={opening.warningLines[activeWarningLineIndex]}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );
  }

  // Play mode (main line, or from quiz position)
  if (viewMode === 'play') {
    return (
      <OpeningPlayMode
        opening={opening}
        startFen={quizPlayFen ?? undefined}
        onExit={handleExit}
      />
    );
  }

  // Play mode (variation)
  if (viewMode === 'variation-play' && opening.variations?.[activeVariationIndex]) {
    return (
      <OpeningPlayMode
        opening={opening}
        customLine={opening.variations[activeVariationIndex]}
        onExit={handleExit}
      />
    );
  }

  // Play mode (trap/warning lines)
  if (viewMode === 'trap-play' && opening.trapLines?.[activeTrapLineIndex]) {
    return (
      <OpeningPlayMode
        opening={opening}
        customLine={opening.trapLines[activeTrapLineIndex]}
        onExit={handleExit}
      />
    );
  }
  if (viewMode === 'warning-play' && opening.warningLines?.[activeWarningLineIndex]) {
    return (
      <OpeningPlayMode
        opening={opening}
        customLine={opening.warningLines[activeWarningLineIndex]}
        onExit={handleExit}
      />
    );
  }

  // Train mode (traps or warnings)
  if (viewMode === 'train-traps' && opening.trapLines && opening.trapLines.length > 0) {
    return (
      <TrainMode
        opening={opening}
        lines={opening.trapLines}
        sectionLabel="Traps & Pitfalls"
        onExit={handleExit}
      />
    );
  }

  if (viewMode === 'train-warnings' && opening.warningLines && opening.warningLines.length > 0) {
    return (
      <TrainMode
        opening={opening}
        lines={opening.warningLines}
        sectionLabel="Watch Out For"
        onExit={handleExit}
      />
    );
  }

  // Model game viewer
  if (viewMode === 'model-game' && activeModelGame) {
    return (
      <ModelGameViewer
        game={activeModelGame}
        boardOrientation={opening.color}
        onExit={handleExit}
      />
    );
  }

  // Middlegame plan study
  if (viewMode === 'middlegame-plan' && activeMiddlegamePlan) {
    return (
      <MiddlegamePlanStudy
        plan={activeMiddlegamePlan}
        boardOrientation={opening.color}
        onExit={handleExit}
      />
    );
  }

  // Middlegame practice (direct play)
  if (viewMode === 'middlegame-practice' && activeMiddlegamePlan) {
    return (
      <MiddlegamePractice
        plan={activeMiddlegamePlan}
        playerColor={opening.color}
        onExit={handleExit}
      />
    );
  }

  // Detail view
  const mastery = getMasteryPercent(opening);
  const totalLines = getTotalLines(opening);
  const discovered = getLinesDiscovered(opening);
  const perfected = getLinesPerfected(opening);

  // Data lookups for new features
  const mistakes = (commonMistakesData as Record<string, CommonMistake[]>)[opening.id] ?? [];
  const quizzes = (checkpointQuizzesData as Record<string, CheckpointQuizItem[]>)[opening.id] ?? [];
  const currentQuiz: CheckpointQuizItem | null = quizzes[quizIndex] as CheckpointQuizItem | undefined ?? null;

  const NarrationButton = ({
    sectionId,
    text,
    kind,
    bullets,
  }: {
    sectionId: string;
    text: string;
    kind?: 'traps' | 'warnings';
    bullets?: string[] | null;
  }): JSX.Element => {
    const isNarrating = narratingSection === sectionId;
    const isLoading = loadingSection === sectionId;
    return (
      <button
        onClick={() => toggleNarration(sectionId, text, kind ? { kind, bullets } : undefined)}
        className="ml-auto p-1.5 rounded-lg hover:bg-theme-border/50 text-theme-text-muted hover:text-theme-accent transition-colors"
        aria-label={
          isLoading
            ? 'Preparing narration'
            : isNarrating
              ? 'Stop narration'
              : 'Narrate section'
        }
        data-testid={`narrate-${sectionId}`}
      >
        {isLoading ? (
          <Loader2 size={14} className="animate-spin" />
        ) : isNarrating ? (
          <StopIcon size={14} />
        ) : (
          <Volume2 size={14} />
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto" data-testid="opening-detail">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => void navigate(isProContext && playerId ? `/openings/pro/${playerId}` : '/openings')}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          aria-label="Back to openings"
          data-testid="back-button"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-theme-text">{opening.name}</h1>
          <div className="flex items-center gap-2 text-sm text-theme-text-muted">
            <span className="font-mono">{opening.eco}</span>
            <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
            <span className="capitalize">{opening.color}</span>
            {opening.style && (
              <>
                <span className="w-1 h-1 rounded-full bg-theme-text-muted" />
                <span>{opening.style}</span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => void handleToggleFavorite()}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          aria-label={opening.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          data-testid="favorite-btn"
        >
          <Heart
            size={20}
            className={opening.isFavorite ? 'text-red-500 fill-red-500' : 'text-theme-text-muted'}
          />
        </button>
        <MasteryRing percent={mastery} size={48} />
      </div>

      {/* Line stats */}
      {totalLines > 0 && (
        <div className="flex gap-4 mb-4 text-sm text-theme-text-muted">
          <span data-testid="lines-discovered">{discovered}/{totalLines} lines discovered</span>
          <span data-testid="lines-perfected">{perfected}/{totalLines} lines perfected</span>
        </div>
      )}

      {/* WALKTHROUGH, LEARN, PRACTICE, PLAY buttons */}
      <div className="grid grid-cols-4 gap-1.5 mb-6">
        <button
          onClick={() => setViewMode('walkthrough')}
          className="flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-theme-accent text-white font-semibold text-xs hover:opacity-90 transition-opacity opening-action-glow opening-action-glow-watch"
          data-testid="walkthrough-btn"
        >
          <PlayCircle size={18} />
          Watch
        </button>
        <button
          onClick={() => setViewMode('learn')}
          className="flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-theme-surface border border-theme-border text-theme-text font-semibold text-xs hover:bg-theme-border transition-colors opening-action-glow opening-action-glow-learn"
          data-testid="learn-btn"
        >
          <LearnIcon size={18} />
          Learn
        </button>
        <button
          onClick={() => setViewMode('practice')}
          className="flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-theme-surface border border-theme-border text-theme-text font-semibold text-xs hover:bg-theme-border transition-colors opening-action-glow opening-action-glow-practice"
          data-testid="practice-btn"
        >
          <Brain size={18} />
          Practice
        </button>
        <button
          onClick={() => setViewMode('play')}
          className="flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-theme-surface border border-theme-border text-theme-text font-semibold text-xs hover:bg-theme-border transition-colors opening-action-glow opening-action-glow-play"
          data-testid="play-btn"
        >
          <Swords size={18} />
          Play
        </button>
      </div>

      {/* SRS trainer enrollment */}
      <div className="flex items-center gap-2 mb-5" data-testid="srs-enroll-row">
        <button
          onClick={() => void handleToggleSrs()}
          disabled={srsBusy}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors border-2 ${
            srsEnrolled
              ? 'bg-purple-500/15 border-purple-400/60 text-purple-200 hover:bg-purple-500/25'
              : 'bg-theme-surface border-purple-500/30 text-theme-text hover:border-purple-400/60'
          } disabled:opacity-60 disabled:cursor-wait`}
          data-testid={srsEnrolled ? 'srs-unenroll-btn' : 'srs-enroll-btn'}
        >
          {srsEnrolled ? <CheckCircle2 size={16} /> : <Sparkles size={16} />}
          {srsEnrolled ? 'In trainer' : 'Add to trainer'}
        </button>
        {srsEnrolled && (
          <button
            onClick={() => void navigate('/openings/srs')}
            className="px-3 py-2.5 rounded-xl bg-purple-500/15 border-2 border-purple-400/60 text-purple-200 text-sm font-semibold hover:bg-purple-500/25 transition-colors"
            data-testid="srs-open-btn"
          >
            Review
          </button>
        )}
      </div>
      {srsFlash && (
        <p className="text-xs text-purple-300 -mt-3 mb-4" data-testid="srs-flash">
          {srsFlash}
        </p>
      )}

      {/* Overview */}
      {opening.overview && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen size={14} className="text-theme-accent" />
            <h3 className="text-sm font-semibold text-theme-text">Overview</h3>
            <NarrationButton sectionId="overview" text={opening.overview} />
          </div>
          <p className="text-sm text-theme-text-muted leading-relaxed">{opening.overview}</p>
        </div>
      )}

      {/* Key Ideas */}
      {opening.keyIdeas && opening.keyIdeas.length > 0 && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb size={14} className="text-yellow-500" />
            <h3 className="text-sm font-semibold text-theme-text">Key Ideas</h3>
            <NarrationButton sectionId="keyIdeas" text={opening.keyIdeas.join('. ')} />
          </div>
          <ul className="space-y-1.5">
            {opening.keyIdeas.map((idea, i) => (
              <li key={i} className="text-sm text-theme-text-muted flex gap-2">
                <span className="text-theme-accent mt-0.5 shrink-0">-</span>
                <span>{idea}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Checkpoint Quiz — after Key Ideas */}
      {currentQuiz && !quizCompleted && (
        <CheckpointQuiz
          quiz={currentQuiz}
          boardOrientation={opening.color}
          onComplete={() => {
            if (quizIndex < quizzes.length - 1) {
              setQuizIndex((prev) => prev + 1);
            } else {
              setQuizCompleted(true);
            }
          }}
          onPlayPosition={handleQuizPlayPosition}
        />
      )}

      {/* Middlegame Plans */}
      <MiddlegamePlansSection
        openingId={opening.id}
        onSelectPlan={handleSelectMiddlegamePlan}
        onPlayPlan={handlePlayMiddlegamePlan}
      />

      {/* Model Games */}
      <ModelGamesSection
        openingId={opening.id}
        onSelectGame={handleSelectModelGame}
      />

      {/* Common Mistakes */}
      {mistakes.length > 0 && (
        <CommonMistakesSection
          mistakes={mistakes}
          boardOrientation={opening.color}
        />
      )}

      {/* Traps */}
      {opening.traps && opening.traps.length > 0 && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Target size={14} className="text-green-500" />
            <h3 className="text-sm font-semibold text-theme-text">Traps & Pitfalls</h3>
            <NarrationButton
              sectionId="traps"
              text={opening.traps.join('. ')}
              kind="traps"
              bullets={opening.traps}
            />
            {opening.trapLines && opening.trapLines.length > 0 && (
              <button
                onClick={() => setViewMode('train-traps')}
                className="p-1.5 rounded-lg hover:bg-theme-border/50 text-theme-text-muted hover:text-green-500 transition-colors"
                aria-label="Train traps"
                title="Train"
                data-testid="train-traps-btn"
              >
                <Crosshair size={14} />
              </button>
            )}
          </div>
          <ul className="space-y-2">
            {opening.traps.map((trap, i) => (
              <li key={i} className="text-sm text-theme-text-muted">{trap}</li>
            ))}
          </ul>
          {opening.trapLines && opening.trapLines.length > 0 && (
            <div className="space-y-1 mt-3 pt-3 border-t border-theme-border">
              {opening.trapLines.map((line, i) => (
                <div
                  key={i}
                  className="w-full p-3 rounded-lg hover:bg-theme-border/50 transition-colors"
                  data-testid={`trap-line-${i}`}
                >
                  <button
                    onClick={() => handleStartTrapLineAction(i, 'walkthrough')}
                    className="flex items-center gap-3 w-full text-left"
                    aria-label={`Open ${line.name}`}
                  >
                    <MiniBoard fen={trapLineFens[i]} size={48} orientation={opening.color} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-theme-text">{line.name}</span>
                      <p className="text-xs text-theme-text-muted truncate mt-0.5">{line.explanation}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5 mt-2 ml-[60px]">
                    <button
                      onClick={() => handleStartTrapLineAction(i, 'walkthrough')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-watch"
                      aria-label={`Watch ${line.name}`}
                      title="Watch"
                      data-testid={`trap-walkthrough-${i}`}
                    >
                      <PlayCircle size={16} />
                    </button>
                    <button
                      onClick={() => handleStartTrapLineAction(i, 'learn')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-learn"
                      aria-label={`Learn ${line.name}`}
                      title="Learn"
                      data-testid={`trap-learn-${i}`}
                    >
                      <LearnIcon size={16} />
                    </button>
                    <button
                      onClick={() => handleStartTrapLineAction(i, 'practice')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-practice"
                      aria-label={`Practice ${line.name}`}
                      title="Practice"
                      data-testid={`trap-practice-${i}`}
                    >
                      <Brain size={16} />
                    </button>
                    <button
                      onClick={() => handleStartTrapLineAction(i, 'play')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-play"
                      aria-label={`Play ${line.name}`}
                      title="Play"
                      data-testid={`trap-play-${i}`}
                    >
                      <Swords size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {opening.warnings && opening.warnings.length > 0 && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} className="text-amber-500" />
            <h3 className="text-sm font-semibold text-theme-text">Watch Out For</h3>
            <NarrationButton
              sectionId="warnings"
              text={opening.warnings.join('. ')}
              kind="warnings"
              bullets={opening.warnings}
            />
            {opening.warningLines && opening.warningLines.length > 0 && (
              <button
                onClick={() => setViewMode('train-warnings')}
                className="p-1.5 rounded-lg hover:bg-theme-border/50 text-theme-text-muted hover:text-amber-500 transition-colors"
                aria-label="Train warnings"
                title="Train"
                data-testid="train-warnings-btn"
              >
                <Crosshair size={14} />
              </button>
            )}
          </div>
          <ul className="space-y-2">
            {opening.warnings.map((warning, i) => (
              <li key={i} className="text-sm text-theme-text-muted">{warning}</li>
            ))}
          </ul>
          {opening.warningLines && opening.warningLines.length > 0 && (
            <div className="space-y-1 mt-3 pt-3 border-t border-theme-border">
              {opening.warningLines.map((line, i) => (
                <div
                  key={i}
                  className="w-full p-3 rounded-lg hover:bg-theme-border/50 transition-colors"
                  data-testid={`warning-line-${i}`}
                >
                  <button
                    onClick={() => handleStartWarningLineAction(i, 'walkthrough')}
                    className="flex items-center gap-3 w-full text-left"
                    aria-label={`Open ${line.name}`}
                  >
                    <MiniBoard fen={warningLineFens[i]} size={48} orientation={opening.color} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-theme-text">{line.name}</span>
                      <p className="text-xs text-theme-text-muted truncate mt-0.5">{line.explanation}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5 mt-2 ml-[60px]">
                    <button
                      onClick={() => handleStartWarningLineAction(i, 'walkthrough')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-watch"
                      aria-label={`Watch ${line.name}`}
                      title="Watch"
                      data-testid={`warning-walkthrough-${i}`}
                    >
                      <PlayCircle size={16} />
                    </button>
                    <button
                      onClick={() => handleStartWarningLineAction(i, 'learn')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-learn"
                      aria-label={`Learn ${line.name}`}
                      title="Learn"
                      data-testid={`warning-learn-${i}`}
                    >
                      <LearnIcon size={16} />
                    </button>
                    <button
                      onClick={() => handleStartWarningLineAction(i, 'practice')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-practice"
                      aria-label={`Practice ${line.name}`}
                      title="Practice"
                      data-testid={`warning-practice-${i}`}
                    >
                      <Brain size={16} />
                    </button>
                    <button
                      onClick={() => handleStartWarningLineAction(i, 'play')}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-play"
                      aria-label={`Play ${line.name}`}
                      title="Play"
                      data-testid={`warning-play-${i}`}
                    >
                      <Swords size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Variations (lines) */}
      {opening.variations && opening.variations.length > 0 && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <h3 className="text-sm font-semibold text-theme-text mb-3">
            Lines ({opening.variations.length})
          </h3>
          <div className="space-y-1">
            {opening.variations.map((variation, i) => {
              const isDiscovered = opening.linesDiscovered?.includes(i) ?? false;
              const isPerfected = opening.linesPerfected?.includes(i) ?? false;
              return (
                <div
                  key={i}
                  className="w-full p-3 rounded-lg hover:bg-theme-border/50 transition-colors group"
                  data-testid={`variation-${i}`}
                >
                  <button
                    onClick={() => handleStartVariationWalkthrough(i)}
                    className="flex items-center gap-3 w-full text-left"
                    aria-label={`Open ${variation.name}`}
                  >
                    {/* Board thumbnail */}
                    <MiniBoard
                      fen={variationFens[i]}
                      size={48}
                      orientation={opening.color}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-theme-text">{variation.name}</span>
                        {isPerfected && <Trophy size={12} className="text-yellow-500" />}
                        {isDiscovered && !isPerfected && <CheckCircle size={12} className="text-green-500" />}
                        {variation.frequency && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wide ${
                            variation.frequency === 'common' ? 'bg-blue-500/15 text-blue-400' :
                            variation.frequency === 'uncommon' ? 'bg-amber-500/15 text-amber-400' :
                            'bg-gray-500/15 text-gray-400'
                          }`}>
                            {variation.frequency}
                          </span>
                        )}
                        {variation.danger && variation.danger !== 'safe' && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wide ${
                            variation.danger === 'critical' ? 'bg-red-500/15 text-red-400' :
                            'bg-amber-500/15 text-amber-400'
                          }`}>
                            {variation.danger}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-theme-text-muted truncate mt-0.5">{variation.explanation}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5 mt-2 ml-[60px]">
                    <button
                      onClick={() => handleStartVariationWalkthrough(i)}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-watch"
                      aria-label={`Watch ${variation.name}`}
                      title="Watch"
                      data-testid={`variation-walkthrough-${i}`}
                    >
                      <PlayCircle size={16} />
                    </button>
                    <button
                      onClick={() => handleStartVariationLearn(i)}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-learn"
                      aria-label={`Learn ${variation.name}`}
                      title="Learn"
                      data-testid={`variation-learn-${i}`}
                    >
                      <LearnIcon size={16} />
                    </button>
                    <button
                      onClick={() => handleStartVariationPractice(i)}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-practice"
                      aria-label={`Practice ${variation.name}`}
                      title="Practice"
                      data-testid={`variation-practice-${i}`}
                    >
                      <Brain size={16} />
                    </button>
                    <button
                      onClick={() => handleStartVariationPlay(i)}
                      className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg hover:bg-theme-accent/20 bg-theme-surface border border-theme-border hover:border-theme-accent/40 text-theme-text-muted hover:text-theme-accent transition-colors opening-action-glow opening-action-glow-play"
                      aria-label={`Play ${variation.name}`}
                      title="Play"
                      data-testid={`variation-play-${i}`}
                    >
                      <Swords size={16} />
                    </button>
                    <SidelineExplainer
                      opening={opening}
                      variation={variation}
                      fen={variationFens[i]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Woodpecker stats */}
      {opening.woodpeckerReps > 0 && (
        <div className="bg-theme-surface rounded-xl p-4 mb-4">
          <h3 className="text-sm font-semibold text-theme-text mb-3">Woodpecker Stats</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-theme-accent mb-1">
                <Repeat size={14} />
              </div>
              <p className="text-lg font-bold text-theme-text" data-testid="wp-reps">{opening.woodpeckerReps}</p>
              <p className="text-[10px] text-theme-text-muted uppercase">Total Reps</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-theme-accent mb-1">
                <Clock size={14} />
              </div>
              <p className="text-lg font-bold text-theme-text" data-testid="wp-speed">
                {opening.woodpeckerSpeed !== null ? `${Math.round(opening.woodpeckerSpeed)}s` : '—'}
              </p>
              <p className="text-[10px] text-theme-text-muted uppercase">Best Time</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-theme-accent mb-1">
                <Target size={14} />
              </div>
              <p className="text-lg font-bold text-theme-text">
                {opening.woodpeckerLastDate
                  ? new Date(opening.woodpeckerLastDate).toLocaleDateString()
                  : '—'}
              </p>
              <p className="text-[10px] text-theme-text-muted uppercase">Last Drilled</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
