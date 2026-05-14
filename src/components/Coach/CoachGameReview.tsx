import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { RotateCcw, Home, ArrowLeft, MessageCircle, Loader2, Volume2, VolumeX, Target, Crosshair } from 'lucide-react';
import { ChessBoard } from '../Board/ChessBoard';
import { voiceService } from '../../services/voiceService';
import { usePieceSound } from '../../hooks/usePieceSound';
import { getCoachMove, resolveConfig } from '../../services/coachPlaySession';
import { MoveListPanel } from './MoveListPanel';
import { ReviewSummaryCard } from './ReviewSummaryCard';
import { KeyMomentNav } from './KeyMomentNav';
import { ChatInput } from './ChatInput';
import { calculateAccuracy, getClassificationCounts, detectMisses } from '../../services/accuracyService';
import { getPhaseBreakdown } from '../../services/gamePhaseService';
import { detectMissedTactics } from '../../services/missedTacticService';
import {
  generateNarrativeSummary,
  generateReviewNarration,
} from '../../services/coachFeatureService';
import type {
  NarrativeMoveData,
  ReviewNarration,
  ReviewMoveInput,
} from '../../services/coachFeatureService';
import { useReviewPlayback } from '../../hooks/useReviewPlayback';
import { useReviewEngineLines } from '../../hooks/useReviewEngineLines';
import { SkipBack, SkipForward, ChevronLeft, ChevronRight, Cpu } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { tryCaptureForgetIntent } from '../../services/openingIntentCapture';
import { coachService } from '../../coach/coachService';
import type { LiveState } from '../../coach/types';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { useAppStore } from '../../stores/appStore';
import { resolveCoachNarration } from '../../utils/coachNarration';
import { logAppAudit } from '../../services/appAuditor';
import { CLASSIFICATION_STYLES } from './classificationStyles';
import { Chess } from 'chess.js';
import type { CoachGameMove, KeyMoment, ReviewState, GameAccuracy, MoveClassificationCounts, PhaseAccuracy, MissedTactic } from '../../types';

interface CoachGameReviewProps {
  moves: CoachGameMove[];
  keyMoments: KeyMoment[];
  playerColor: 'white' | 'black';
  result: string;
  openingName: string | null;
  playerName: string;
  playerRating: number;
  opponentRating: number;
  onPlayAgain: () => void;
  onBackToCoach: () => void;
  onPracticeInChat?: (prompt: string) => void;
  isGuidedLesson?: boolean;
  pgn?: string;
  initialMoveIndex?: number;
  /** When true, auto-fire the post-game walkthrough as soon as the
   *  component mounts — the user lands directly in the big-button +
   *  chat-panel mode with the intro narration playing instead of
   *  having to tap "Full Review" first. Used by the new
   *  /coach/review/:gameId entry point so opening a game from the
   *  picker drops the student straight into the walkthrough. */
  autoStartReview?: boolean;
  /** Game id of the review being walked. Forwarded to `useReviewPlayback`
   *  so hint callouts are scoped to THIS game and don't leak across
   *  reviews via the global `useCoachMemoryStore` (ship-5). */
  gameId?: string;
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ship-4: PLAYED_MOVE_ARROW_COLORS + sanToSquares + AUTO_REVIEW_* pacing
// + CLASSIFICATION_BORDER_COLORS removed alongside the analysis-phase
// board they served. The walk-phase board derives its own arrow/badge
// styling inline from the segment classification.

export function CoachGameReview(props: CoachGameReviewProps): JSX.Element {
  const {
    moves, playerColor, result, openingName,
    playerRating,
    onPlayAgain, onBackToCoach, onPracticeInChat,
    pgn,
  } = props;
  const initialMoveIndex = props.initialMoveIndex;
  // ship-4: `keyMoments`, `playerName`, `opponentRating`, `isGuidedLesson`,
  // `autoStartReview` are retained on the prop interface for
  // backwards-compat with legacy callers but no longer consumed —
  // the walk surface derives everything it needs from `moves`.
  const navigate = useNavigate();

  // ship-4: `reviewPhase` state removed. The walk-phase UI is the only
  // review surface; when narration generation fails or the prep effect
  // is still in flight, the `ReviewSummaryCard` fallback renders.

  // ship-4: guided-lesson mode removed — `isGuidedLesson` no longer
  // branches the start index. The walk surface owns navigation.
  const startIndex = initialMoveIndex !== undefined
    ? Math.min(initialMoveIndex, moves.length - 1)
    : (moves.length > 0 ? moves.length - 1 : -1);

  const [reviewState, setReviewState] = useState<ReviewState>({
    mode: 'analysis',
    currentMoveIndex: startIndex,
    whatIfMoves: [],
    whatIfStartFen: null,
  });

  // ship-4: what-if mode, practice/drill mode, best-line state, and
  // best-move-reveal toggle all removed — their UI lived in the
  // deleted analysis phase. The walk surface gets its arrow + badge
  // gating inline (see the walk render); board interactivity is
  // owned by `walkExplorationFen` below.

  // ─── Ask About Position State ───────────────────────────────────────────────
  const [askExpanded, setAskExpanded] = useState(false);
  const [askResponse, setAskResponse] = useState<string | null>(null);
  const [isAskStreaming, setIsAskStreaming] = useState(false);
  const askAbortRef = useRef<AbortController | null>(null);

  // Audit-driven (review walk #4): tracks whether this component is
  // still mounted. The walk-prep effect's generateReviewNarration call
  // can take 5–60s; if the user navigates back to the list and opens
  // a different game before it resolves, the orphan Promise's .then
  // would call setWalkNarration on the unmounted component (React
  // warning) AND any partial-state mutation could land on the next
  // game's UI before the new prep call completes. Production audit
  // (Audit 3, build 6459def+ Finding 41) showed `43 of 43 plies
  // narrated` landing on a 9-ply game's URL — the prior 43-ply game's
  // segments call leaked through on the new page. The mountedRef
  // is set to false in an unmount-only cleanup; the .then/.catch
  // guards check it and emit a cancellation audit instead of
  // applying state.
  const walkMountedRef = useRef(true);
  useEffect(() => {
    walkMountedRef.current = true;
    return () => {
      walkMountedRef.current = false;
    };
  }, []);

  // Walk-mode exploration: when the student is on a ply that has a
  // better-move arrow (inaccuracy/mistake/blunder), they can grab the
  // suggested piece on the board and play that move themselves. The
  // resulting FEN lives here until they tap "Resume game" — at which
  // point we clear it and the board returns to the actual game line.
  const [walkExplorationFen, setWalkExplorationFen] = useState<string | null>(null);
  const [walkExplorationSan, setWalkExplorationSan] = useState<string | null>(null);
  const walkExplorationPlyRef = useRef<number | null>(null);
  // Opt-in toggle: when on at an arrow-bearing ply, the board
  // displays `seg.fenBefore` (so the missed move is playable)
  // instead of the canonical `seg.fenAfter`. Resets when the
  // student steps to a different ply.
  const [walkExploreToggleOn, setWalkExploreToggleOn] = useState<boolean>(false);
  // "Show me" playout: when active, Stockfish auto-plays the
  // punishment line from `seg.fenAfter` so the student can SEE
  // why their move was a mistake/blunder. Each engine ply updates
  // `walkExplorationFen` so the board animates the slide. Board
  // is non-interactive while this is true. Cleared on Resume,
  // ply change, or when the playout reaches its stop condition
  // (4 plies, mate, or game over).
  const [walkShowMeActive, setWalkShowMeActive] = useState<boolean>(false);
  // Mirror walkShowMeActive in a ref so the async playout loop can
  // detect cancellation (Resume tap, ply nav) AFTER awaiting a
  // Stockfish round-trip. Reading state directly inside the loop
  // would close over the stale value at loop-entry.
  const walkShowMeActiveRef = useRef<boolean>(false);
  useEffect(() => {
    walkShowMeActiveRef.current = walkShowMeActive;
  }, [walkShowMeActive]);

  // ship-4: auto-review state machine + guided-lesson state machine
  // both removed. The walk-phase UI driven by `useReviewPlayback` is
  // the only review playback path now. See the function comment near
  // the bottom of the file for the prior decomposition history.
  const [narrativeSummary, setNarrativeSummary] = useState<string | null>(null);
  const [isLoadingNarrative, setIsLoadingNarrative] = useState(false);
  // WO-REVIEW-02 walk-the-game state. Fetched once per review mount;
  // null while loading, set to a ReviewNarration once ready. Falls back
  // to the ReviewSummaryCard's paragraph view if generation fails.
  const [walkNarration, setWalkNarration] = useState<ReviewNarration | null>(null);
  const [isLoadingWalk, setIsLoadingWalk] = useState(false);

  // Pre-compute accuracy + classification counts
  const accuracy = useMemo<GameAccuracy>(() => calculateAccuracy(moves), [moves]);
  const classificationCounts = useMemo<MoveClassificationCounts>(
    () => getClassificationCounts(moves, playerColor),
    [moves, playerColor],
  );

  // Pre-compute phase breakdown + missed tactics
  const phaseBreakdown = useMemo<PhaseAccuracy[]>(
    () => getPhaseBreakdown(moves, playerColor),
    [moves, playerColor],
  );
  const missedTactics = useMemo<MissedTactic[]>(
    () => detectMissedTactics(moves, playerColor),
    [moves, playerColor],
  );

  const missCount = useMemo(() => detectMisses(moves, playerColor), [moves, playerColor]);

  // Build engine move data for narrative summary enrichment
  const narrativeMoveData = useMemo<NarrativeMoveData[]>(() =>
    moves.map((m) => ({
      moveNumber: m.moveNumber,
      san: m.san,
      classification: m.classification,
      commentary: m.commentary || '',
      evaluation: m.evaluation,
      bestMove: m.bestMove,
      isCoachMove: m.isCoachMove,
    })),
    [moves],
  );

  // Generate narrative summary on summary phase mount (for non-guided lessons)
  useEffect(() => {
    if (narrativeSummary !== null) return;
    const gamePgn = pgn ?? moves.map((m) => m.san).join(' ');
    setIsLoadingNarrative(true);
    setNarrativeSummary('');
    void generateNarrativeSummary(
      gamePgn,
      playerColor,
      openingName,
      result,
      playerRating,
      (chunk: string) => setNarrativeSummary((prev: string | null) => (prev ?? '') + chunk),
      narrativeMoveData,
    ).then((fullText) => {
      // getCoachChatResponse never throws on API failure — it returns
      // "⚠️ Coach error: …" strings. Translate those to the degraded
      // UI state so the student isn't shown a raw error string and no
      // half-generated review is spoken aloud.
      if (fullText.startsWith('⚠️')) {
        setNarrativeSummary('Review is unavailable for this game. Tap Full Review for detailed analysis.');
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'CoachGameReview.narrativeSummary',
          summary: 'generateNarrativeSummary returned error placeholder',
          details: fullText,
        });
        return;
      }
      setNarrativeSummary(fullText);
      // WO-REVIEW-02a-FIX: do NOT speak the legacy monolithic summary
      // — the walk-the-game narration owns voice at review mount. The
      // summary text is still shown as a fallback card when the walk
      // bundle fails to load; speaking it here produced a dual-voice
      // regression (summary + walk intro overlapping on mount).
    }).catch((err: unknown) => {
      // Surface a graceful degraded state rather than leaving the
      // review blank. Log the actual error so silent failures are
      // visible post-WO-REVIEW-01.
      const msg = err instanceof Error ? err.message : String(err);
      setNarrativeSummary('Review is unavailable for this game. Tap Full Review for detailed analysis.');
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'CoachGameReview.narrativeSummary',
        summary: 'generateNarrativeSummary rejected',
        details: msg,
      });
    }).finally(() => {
      setIsLoadingNarrative(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrative summary fires once on mount
  }, []);

  // WO-REVIEW-02 walk-the-game: fetch per-ply segments + intro when
  // the summary phase mounts (non-guided lessons only). Runs in
  // parallel with the legacy narrativeSummary fetch; if the walk
  // narration succeeds we render the walk UI, otherwise the summary
  // card's paragraph is the graceful fallback.
  const reviewMoveInputs = useMemo<ReviewMoveInput[]>(() =>
    moves.map((m, i) => ({
      ply: i + 1,
      san: m.san,
      isCoachMove: m.isCoachMove,
      classification: m.classification ?? null,
      evaluation: m.evaluation,
      preMoveEval: m.preMoveEval,
      bestMove: m.bestMove,
      fenAfter: m.fen,
    })),
    [moves],
  );

  useEffect(() => {
    if (walkNarration !== null || isLoadingWalk) return;
    if (reviewMoveInputs.length === 0) return;
    setIsLoadingWalk(true);
    void generateReviewNarration({
      moves: reviewMoveInputs,
      playerColor,
      openingName,
      result,
      playerRating,
      // Tied to the unified Settings → Coach → Coach Narration dial.
      // Silent skips the intro LLM call entirely; Brief caps it at
      // ~80 tokens; Full uses the legacy 200-token allowance. Resolved
      // fresh per mount so a Settings change between reviews takes
      // effect on the next open.
      coachNarration: resolveCoachNarration(useAppStore.getState().activeProfile?.preferences),
    }).then((narration) => {
      // Audit-driven (review walk #4): bail if the component
      // unmounted mid-call (user navigated away). React-level
      // protection is also there — setWalkNarration on an unmounted
      // component is a no-op + warning — but we want the explicit
      // observability trail.
      if (!walkMountedRef.current) {
        void logAppAudit({
          kind: 'review-walk-skipped',
          category: 'subsystem',
          source: 'CoachGameReview.walkNarration',
          summary: `walk-prep result discarded — component unmounted (${narration?.segments.length ?? 0} segments)`,
          details: JSON.stringify({
            reason: 'component-unmounted-before-prep-resolved',
            segmentCount: narration?.segments.length ?? 0,
            plyCount: reviewMoveInputs.length,
          }),
        });
        return;
      }
      // Empty segments → keep the summary card visible as a
      // graceful fallback. The walk UI requires segments to render;
      // without them, the student stays on the card with stats only.
      if (narration && narration.segments.length > 0) {
        setWalkNarration(narration);
      } else {
        // Audit-driven (#26): the empty-segments fallback used to be
        // silent — paste-back audit logs showed nothing for "I tapped
        // Review and got the summary card, not the walk." Now we
        // log the skip with the segment count + ply count so a
        // regression in generateReviewNarration is debuggable from
        // the audit panel without DevTools.
        void logAppAudit({
          kind: 'review-walk-skipped',
          category: 'subsystem',
          source: 'CoachGameReview.walkNarration',
          summary: `walk UI skipped — ${narration?.segments.length ?? 0} segments for ${reviewMoveInputs.length} plies`,
          details: JSON.stringify({
            segmentCount: narration?.segments.length ?? 0,
            plyCount: reviewMoveInputs.length,
            hasIntro: Boolean(narration?.intro?.trim()),
          }),
        });
      }
    }).catch((err: unknown) => {
      if (!walkMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'CoachGameReview.walkNarration',
        summary: 'generateReviewNarration rejected',
        details: msg,
      });
    }).finally(() => {
      if (!walkMountedRef.current) return;
      setIsLoadingWalk(false);
    });
  }, [reviewMoveInputs, playerColor, openingName, result, playerRating, walkNarration, isLoadingWalk]);

  // Instantiate the playback hook; drives the walk-the-game UI below.
  // totalPlies is the authoritative ceiling — nav walks every move the
  // student played, even when the LLM narrated only a subset
  // (WO-REVIEW-02a-FIX).
  const walkPlayback = useReviewPlayback({
    narration: walkNarration,
    totalPlies: moves.length,
    // ship-5: scope hint callouts to this specific game.
    gameId: props.gameId,
  });

  // Move sound on every walk advance — Polly + voice narration is
  // great pedagogy but the silent piece transition makes it hard to
  // pick out which piece moved. usePieceSound matches the chime the
  // Learn-with-Coach board plays on student moves (per David's
  // 2026-05 review audit feedback).
  const { playMoveSound } = usePieceSound();
  const lastSoundPlyRef = useRef<number>(walkPlayback.currentPly);
  useEffect(() => {
    if (walkPlayback.currentPly === lastSoundPlyRef.current) return;
    const advancedForward = walkPlayback.currentPly > lastSoundPlyRef.current;
    const targetPly = walkPlayback.currentPly;
    lastSoundPlyRef.current = targetPly;
    // Skip the silent boot-up render (no transition to sound).
    if (targetPly === 0) return;
    // Use the SAN of the ply we just arrived at — for forward
    // motion that's the move played; for back motion it's the move
    // we're un-playing (sound still helps signal that something
    // moved). When the segment SAN is missing fall back to
    // moves[ply-1].san.
    const seg = walkPlayback.currentSegment;
    const san = seg?.san ?? moves[targetPly - 1]?.san;
    if (san) playMoveSound(san);
    void advancedForward;
  }, [walkPlayback.currentPly, walkPlayback.currentSegment, moves, playMoveSound]);

  // Auto-clear walk exploration when the student steps to a different
  // ply. Exploration is anchored to ONE position — once they nav away,
  // the actual game line resumes silently (snap-back is implicit).
  useEffect(() => {
    if (
      walkExplorationFen !== null &&
      walkExplorationPlyRef.current !== null &&
      walkExplorationPlyRef.current !== walkPlayback.currentPly
    ) {
      void logAppAudit({
        kind: 'review-walk-resumed',
        category: 'subsystem',
        source: 'CoachGameReview.walkAutoResume',
        summary: `ply changed (${walkExplorationPlyRef.current}→${walkPlayback.currentPly}) — auto-resumed actual line`,
        details: JSON.stringify({
          fromPly: walkExplorationPlyRef.current,
          toPly: walkPlayback.currentPly,
          exploredSan: walkExplorationSan,
          reason: 'ply-changed',
        }),
      });
      setWalkExplorationFen(null);
      setWalkExplorationSan(null);
      walkExplorationPlyRef.current = null;
    }
  }, [walkPlayback.currentPly, walkExplorationFen, walkExplorationSan]);

  // Reset the explore-toggle on every ply change. Each arrow-bearing
  // ply has its OWN suggested-move-vs-played-move discussion, so the
  // student should opt in fresh on each one. Keeps the canonical
  // playback path animating cleanly when they just press Next.
  useEffect(() => {
    setWalkExploreToggleOn(false);
    // Show-me playout is also ply-anchored — if the student nav's
    // away mid-playout we cancel it. The async loop checks this
    // flag every iteration and bails when it flips false.
    setWalkShowMeActive(false);
  }, [walkPlayback.currentPly]);

  // WO-REVIEW-02b — Engine lines panel. Off by default. Analyzes every
  // position in the walk (starting position + one FEN per ply) via
  // Stockfish MultiPV once the user toggles it on.
  const [engineLinesEnabled, setEngineLinesEnabled] = useState(false);
  const reviewFens = useMemo<string[] | null>(() => {
    if (!walkNarration || walkNarration.segments.length === 0) return null;
    const fens: string[] = [walkNarration.segments[0].fenBefore];
    for (const seg of walkNarration.segments) fens.push(seg.fenAfter);
    return fens;
  }, [walkNarration]);
  const engineLines = useReviewEngineLines({ fens: reviewFens, enabled: engineLinesEnabled });

  // ship-4: `currentMove` removed — only the deleted analysis-phase
  // board read it. Walk render uses `walkPlayback.currentSegment` and
  // computes its own per-ply derivations.

  // ship-4: `displayFen` derivation removed — only the analysis-phase
  // board read it. Walk render derives its own displayFen inline
  // from the segment + walkExplorationFen.

  // ship-4: removed `capturedPieces`, `materialAdv`, `isPlayerWhite`,
  // `arrows`, `classificationHighlights`, `classificationOverlay`,
  // `commentary` — all fed the old analysis-phase PlayerInfoBar +
  // ChessBoard render that's gone. The walk-phase render computes its
  // own arrow gating + classification badge inline; captured-pieces +
  // material chips are not currently surfaced in the walk UI.

  // ship-4: `boardFlash` border-pulse effect removed — only the
  // analysis-phase board read it. Walk-phase uses the inline
  // classification badge for the same signal.

  // Keyboard navigation effect is declared below navigateMove — it
  // needs navigateMove in its dep array, so it has to come after the
  // useCallback declaration to avoid a TDZ error at render time.

  // ─── Ask About Position handler ────────────────────────────────────────────
  const handleAskSend = useCallback((question: string) => {
    if (isAskStreaming) return;

    // WO-BRAIN-03: review-ask now routes through coachService.ask. The
    // brain envelope carries the same memory + manifest awareness as
    // every other migrated surface; the LLM emits set_intended_opening
    // via tool when it should, so the deterministic regex is retired
    // here too. tryCaptureForgetIntent stays as belt-and-suspenders
    // until BRAIN-06 cleanup.
    tryCaptureForgetIntent(question, 'review-ask');

    // Abort previous ask
    if (askAbortRef.current) askAbortRef.current.abort();
    askAbortRef.current = new AbortController();

    setAskResponse('');
    setIsAskStreaming(true);

    const moveIdx = reviewState.currentMoveIndex;
    const move = moveIdx >= 0 && moveIdx < moves.length ? moves[moveIdx] : null;
    const fenForQ = move?.fen ?? STARTING_FEN;

    const abortSignal = askAbortRef.current.signal;
    const reviewLiveState: LiveState = {
      surface: 'review',
      fen: fenForQ,
      moveHistory: moves.slice(0, Math.max(0, moveIdx + 1)).map((m) => m.san),
      userJustDid: question,
      currentRoute: '/coach/play',
    };
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'CoachGameReview.handleAskSend',
      summary: 'surface=review viaSpine=true',
      details: JSON.stringify({
        surface: 'review',
        viaSpine: true,
        timestamp: Date.now(),
        fenIfPresent: fenForQ,
      }),
      fen: fenForQ,
    });
    // WO-BRAIN-04: thread the user ask into conversation history.
    useCoachMemoryStore.getState().appendConversationMessage({
      surface: 'chat-review-ask',
      role: 'user',
      text: question,
      fen: fenForQ,
      trigger: null,
    });

    // WO-REVIEW-MERGE: per-turn voice marker extraction. The brain's
    // REVIEW_MODE_ADDITION asks for one `[VOICE: ...]` per response;
    // we capture the first closed marker as it streams and speak it
    // via Polly so the surface matches the /coach/teach voice cue.
    let voiceRawBuffer = '';
    let voiceSpokenForTurn = false;
    const VOICE_MARKER_RE = /\[VOICE:\s*([\s\S]*?)\]/g;
    const tryExtractVoiceMarker = (): void => {
      if (voiceSpokenForTurn) return;
      VOICE_MARKER_RE.lastIndex = 0;
      const match = VOICE_MARKER_RE.exec(voiceRawBuffer);
      if (!match) return;
      const inner = match[1].trim();
      if (!inner) return;
      voiceSpokenForTurn = true;
      void logAppAudit({
        kind: 'coach-voice-marker-extracted',
        category: 'subsystem',
        source: 'CoachGameReview.tryExtractVoiceMarker',
        summary: `extracted [VOICE: ...] block (${inner.length} chars)`,
        details: JSON.stringify({ length: inner.length, preview: inner.slice(0, 80) }),
      });
      void voiceService.speakForcedPollyOnly(inner);
    };

    void coachService
      .ask(
        { surface: 'review', ask: question, liveState: reviewLiveState },
        {
          // WO-COACH-TEACHING-01: review chat now also wires the
          // board-state callbacks so the brain can demonstrate
          // variations on the review board — play a candidate,
          // narrate, take back. Same teaching loop the in-game
          // chat got via the OPERATOR_BASE_BODY teaching directive.
          maxToolRoundTrips: 6,
          onChunk: (chunk: string) => {
            if (abortSignal.aborted) return;
            // WO-REVIEW-MERGE: extract `[VOICE: ...]` markers from the
            // streamed response and route them to Polly. Mirrors the
            // /coach/teach pattern so the new REVIEW_MODE_ADDITION's
            // mandate ("emit one [VOICE: ...] per turn") actually
            // produces spoken summaries here too. The marker text is
            // also stripped from the chat display so the bubble shows
            // clean prose instead of leaking the directive.
            voiceRawBuffer += chunk;
            tryExtractVoiceMarker();
            const visible = chunk.replace(VOICE_MARKER_RE, '');
            setAskResponse((prev: string | null) => (prev ?? '') + visible);
          },
          onNavigate: (path: string) => {
            void navigate(path);
          },
          // ship-8 — defense-in-depth: lock the board against brain
          // tool-use in review mode. The REVIEW_MODE_ADDITION envelope
          // (envelope.ts:316–320) already tells the brain "do NOT call
          // play_move / take_back_move / set_board_position — the
          // timeline is the source of truth." But the surface used to
          // expose those callbacks anyway, wired to handleBoardMove +
          // navigateMove + setWhatIfFen, each of which can fire
          // Stockfish (5s timeout) and generateMoveCommentary
          // (maxTokens=1500). At maxToolRoundTrips=6 a single chat
          // reply could chain up to ~12 Stockfish + 6 LLM calls. If
          // the brain ever forgets the directive (or a future prompt
          // regresses), the surface itself enforces the rule. The
          // refusal reasons name [BOARD: arrow:...] so the brain
          // learns to use the marker mandate instead.
          onPlayMove: async (): Promise<{ ok: false; reason: string }> => ({
            ok: false,
            reason:
              'play_move is locked on the review surface — the timeline is the source of truth. Use a [BOARD: arrow:from-to:green] marker to show the move, and the student can tap the suggested piece to explore.',
          }),
          onTakeBackMove: async (): Promise<{ ok: false; reason: string }> => ({
            ok: false,
            reason: 'take_back_move is locked on the review surface — the student drives navigation with the forward/back buttons.',
          }),
          onSetBoardPosition: async (): Promise<{ ok: false; reason: string }> => ({
            ok: false,
            reason: 'set_board_position is locked on the review surface — the timeline is the source of truth.',
          }),
          onResetBoard: async (): Promise<{ ok: false; reason: string }> => ({
            ok: false,
            reason: 'reset_board is locked on the review surface — the student can use the Jump-to-Start nav button to rewind.',
          }),
        },
      )
      .then((answer) => {
        // WO-BRAIN-04: persist coach reply into conversation history.
        if (!abortSignal.aborted && answer.text.trim().length > 0) {
          useCoachMemoryStore.getState().appendConversationMessage({
            surface: 'chat-review-ask',
            role: 'coach',
            text: answer.text,
            fen: fenForQ,
            trigger: null,
          });
        }
      })
      .finally(() => {
        if (!abortSignal.aborted) {
          setIsAskStreaming(false);
        }
      });
  }, [isAskStreaming, reviewState.currentMoveIndex, moves, navigate]);

  // Reset Ask state when navigating to a different move so a stale
  // response doesn't linger after the student clicks forward.
  useEffect(() => {
    setAskExpanded(false);
    setAskResponse(null);
    setIsAskStreaming(false);
    if (askAbortRef.current) askAbortRef.current.abort();
  }, [reviewState.currentMoveIndex]);

  const navigateMove = useCallback((direction: 'first' | 'prev' | 'next' | 'last') => {
    voiceService.stop();
    // ship-4: practice / best-line / auto-review state clearing
    // removed — all those state machines are gone.
    setReviewState((prev: ReviewState) => {
      let newIndex = prev.currentMoveIndex;
      switch (direction) {
        case 'first': newIndex = -1; break;
        case 'prev': newIndex = Math.max(-1, prev.currentMoveIndex - 1); break;
        case 'next': newIndex = Math.min(moves.length - 1, prev.currentMoveIndex + 1); break;
        case 'last': newIndex = moves.length - 1; break;
      }
      return { ...prev, currentMoveIndex: newIndex, mode: 'analysis' };
    });
  }, [moves.length]);

  // Keyboard navigation. Dep array is REQUIRED — without it the effect
  // re-runs on every render and stacks keydown listeners, so one key
  // press advances N plies at once.
  //
  // Audit-driven (#17): the walk UI took over the summary phase but
  // this handler still drove the legacy `navigateMove` (analysis-phase
  // currentMoveIndex), so arrow keys updated a hidden index that the
  // walk UI never consulted. Now we branch on the same condition the
  // render uses: when the walk is up, route to walkPlayback; only the
  // analysis-phase path keeps the legacy navigateMove drive.
  const walkUiActive =
    walkNarration !== null &&
    walkNarration.segments.length > 0;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (walkUiActive) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          walkPlayback.goBack();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          walkPlayback.goForward();
        }
        return;
      }
      if (reviewState.mode !== 'analysis' && reviewState.mode !== 'guided_lesson') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateMove('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateMove('next');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reviewState.mode, navigateMove, walkUiActive, walkPlayback]);

  // ship-4: handleMoveClick / handleBoardMove / handleBackToReview
  // removed alongside the analysis-phase what-if board. Walk-phase
  // exploration is owned by `walkExplorationFen` + the green-arrow
  // grab affordance on the live walk board.
  // ship-4: handlePlayFromHere + the whole practice/drill handler
  // family (handleStartPractice, handlePracticeMove, handleExitPractice,
  // handleStartMistakeDrill) removed. They drove the deleted
  // analysis-phase what-if board + the 3-attempt practice prompt.
  // Walk-phase exploration is owned by `walkExplorationFen` and the
  // green-arrow grab affordance.

  // ship-4: handleShowMissedTactic + handleDrillNext + practiceArrows
  // removed alongside the practice/drill UI. The missed-tactics list
  // in the walk render now just jumps to the relevant ply on tap
  // (jumpToPly via the row's onClick); the board there already shows
  // the classification badge + green best-move arrow + narration.

  // ─── Best Line Explorer ────────────────────────────────────────────────────
  // ship-4: handleToggleBestLine + handleBestLineStep + the reset-on-ply
  // effect all removed alongside the bestLine state they drove. The
  // walk-phase engine-lines panel now shows the top 3 PVs as static
  // display rows (no exploration affordance).

  // ─── Practice In Chat Handler ─────────────────────────────────────────────
  const handlePracticeInChat = useCallback(() => {
    const tacticTypes = [...new Set(missedTactics.map((t: MissedTactic) => t.tacticType))];
    const prompt = tacticTypes.length > 0
      ? `I want to practice the tactics I missed in my last game. I struggled with: ${tacticTypes.join(', ')}. Set up some practice positions for me.`
      : 'I want to practice tactics based on my recent game. Set up some practice positions for me.';
    onPracticeInChat?.(prompt);
  }, [missedTactics, onPracticeInChat]);

  // ship-4: handleStartReview removed alongside auto-review state. The
  // "Full Analysis" button it backed never had a live JSX target —
  // tapping it landed the user on the prep-failed fallback summary
  // card with no way back. Walk phase is the only review surface.

  // Empty state
  if (moves.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 w-full" data-testid="coach-game-review">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          No moves to review.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onPlayAgain}
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
          >
            Play Again
          </button>
          <button
            onClick={onBackToCoach}
            className="px-4 py-2 rounded-lg border text-sm font-medium"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            Back to Coach
          </button>
        </div>
      </div>
    );
  }

  // ─── Walk Phase (only review surface — ship-4) ─────────────────────────────
  // When per-ply narration is ready, render the walk UI (board + nav +
  // subtitle banner). While loading or after a prep failure, the
  // ReviewSummaryCard fallback at the bottom of this function renders
  // so the student isn't blocked.
  {
    if (walkNarration && walkNarration.segments.length > 0) {
      const seg = walkPlayback.currentSegment;
      // Board FEN source of truth: the walk segment when available,
      // otherwise the game's move history (moves[ply-1].fen). This
      // keeps the board in sync even when the narration bundle is
      // truncated or missing for the current ply (WO-REVIEW-02a-FIX).
      //
      // Canonical playback shows `seg.fenAfter` — the position
      // AFTER the displayed ply was played. This gives react-
      // chessboard a clean one-move animation per Next press.
      //
      // At inaccuracy / mistake / blunder plies WITH a known better
      // move, we ALSO expose a separate "Explore this position"
      // affordance (via `walkExploreToggleOn` below) that swaps the
      // board to `seg.fenBefore` so the suggested missed move is
      // actually playable. This swap is OPT-IN — by default the
      // walk uses fenAfter so stepping Next ↔ Prev animates as a
      // single move on the board, not a double-jump that hides
      // which piece moved (David's review-audit feedback, 2026-05).
      const showBest = !!seg && (
        seg.classification === 'inaccuracy' ||
        seg.classification === 'mistake' ||
        seg.classification === 'blunder'
      );
      const hasArrow = showBest && !!seg && !!seg.bestMoveUci && seg.bestMoveUci.length >= 4;
      const displayFen = seg
        ? (walkExploreToggleOn && hasArrow ? seg.fenBefore : seg.fenAfter)
        : walkPlayback.currentPly > 0
          ? moves[walkPlayback.currentPly - 1]?.fen ?? STARTING_FEN
          : STARTING_FEN;
      const walkArrows = (() => {
        // Hide the arrow once the student has explored — they've seen
        // the suggestion, no need to clutter the post-exploration view.
        if (walkExplorationFen) return undefined;
        if (!seg || !hasArrow) return undefined;
        const startSquare = seg.bestMoveUci!.slice(0, 2);
        const endSquare = seg.bestMoveUci!.slice(2, 4);
        return [{ startSquare, endSquare, color: '#22c55e' }];
      })();
      // Walk-mode board is interactive only when a green arrow is on
      // screen — the student can grab the suggested piece and play it
      // themselves. Otherwise the board stays read-only (passive
      // playback). The exploration FEN takes over the displayed
      // position until they tap "Resume game".
      //
      // Board is interactive in two cases:
      //   (a) the student tapped "Explore this position" at an
      //       arrow-bearing ply — display flips to fenBefore so the
      //       missed move is legal + the drop captures their pick.
      //   (b) they're already in exploration mode and want to play
      //       further continuation moves (engine replies handled
      //       separately via the onMove handler).
      // Show-me playout drives the board itself — the student must
      // not be able to interrupt by dragging a piece mid-animation.
      // We gate explicitly off `walkShowMeActive` even though it
      // sets `walkExplorationFen` on the first tick (which would
      // otherwise flip this true via the second clause below).
      const walkBoardInteractive = walkShowMeActive
        ? false
        : (walkExploreToggleOn && hasArrow && walkExplorationFen === null) ||
          walkExplorationFen !== null;
      const walkDisplayFen = walkExplorationFen ?? displayFen;
      const badge = seg?.classification ?? null;
      // Authoritative nav ceiling = the full game length, not the
      // segments' trailing ply. The LLM frequently truncates segment
      // generation (audit cycle 8: a 32-ply game came back with only
      // segment 1, which froze the forward button after the first
      // move). The hook itself already walks past missing segments —
      // see useReviewPlayback's `totalPlies` plumbing — so the UI
      // ceiling needs to match or the buttons grey out prematurely.
      const lastPly = moves.length;
      // Map the walk's 1-indexed ply to the move list / KeyMomentNav's
      // 0-indexed move index. ply 0 = intro (no selected move).
      const walkMoveIndex = walkPlayback.currentPly > 0 ? walkPlayback.currentPly - 1 : -1;

      // ship-4: `enterAnalysisAnd` wrapper removed alongside the
      // Drill All / Show / Try It buttons that consumed it.

      // "Show me" playout — when the student taps the button at an
      // inaccuracy / mistake / blunder ply, Stockfish auto-plays the
      // punishment line from `seg.fenAfter` so the student SEES why
      // their move was wrong. Silent (no narration), standard board
      // animation cadence (200ms slide + 600ms pause ≈ 800ms/ply),
      // and capped at 4 plies or game-over (whichever comes first).
      //
      // Why silent in v1: the chat/voice surface around it is already
      // narrating the position; the playout is a visual demonstration,
      // not a teaching moment. If we later want narration on each ply
      // it goes through voiceService.speak() with the same density
      // gating the rest of the review uses.
      const runShowMePlayout = async (): Promise<void> => {
        if (!seg || !hasArrow) return;
        if (walkShowMeActive) return;
        setWalkShowMeActive(true);
        const startedAtPly = walkPlayback.currentPly;
        walkExplorationPlyRef.current = startedAtPly;
        void logAppAudit({
          kind: 'review-show-me-started',
          category: 'subsystem',
          source: 'CoachGameReview.runShowMePlayout',
          summary: `ply ${startedAtPly} show-me playout begin (${seg.classification})`,
          fen: seg.fenAfter,
          details: JSON.stringify({
            ply: startedAtPly,
            classification: seg.classification,
            playedSan: seg.san,
            bestMoveUci: seg.bestMoveUci ?? null,
          }),
        });
        let currentFen = seg.fenAfter;
        // Surface the starting position immediately so the Resume
        // button shows and the badge stays oriented to "exploration".
        setWalkExplorationFen(currentFen);
        setWalkExplorationSan(null);
        let pliesPlayed = 0;
        const MAX_PLIES = 4;
        try {
          while (pliesPlayed < MAX_PLIES && walkMountedRef.current) {
            const probe = new Chess(currentFen);
            if (probe.isGameOver()) break;
            const config = resolveConfig('hard', playerRating);
            let coachMove;
            try {
              coachMove = await getCoachMove(currentFen, config);
            } catch {
              break; // Stockfish unreachable — bail silently
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ref can flip during the await above
            if (!walkMountedRef.current) break;
            // Re-check the active flag AFTER the await — the student
            // may have hit Resume or navigated away while Stockfish
            // was thinking. Without this guard the loop overwrites
            // their fresh state with a stale engine ply.
            // We read the latest state via a ref to dodge the
            // closure-staleness — see walkShowMeActiveRef below.
            if (!walkShowMeActiveRef.current) break;
            const applied = probe.move({
              from: coachMove.from,
              to: coachMove.to,
              promotion: coachMove.promotion,
            });
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- chess.js types claim non-null but returns null for illegal moves at runtime
            if (!applied) break;
            currentFen = probe.fen();
            setWalkExplorationFen(currentFen);
            playMoveSound(applied.san);
            pliesPlayed++;
            if (probe.isCheckmate()) break;
            // Standard board cadence: 200ms slide + 600ms beat so the
            // student's eye catches each move before the next fires.
            await new Promise((r) => setTimeout(r, 600));
          }
        } finally {
          if (walkMountedRef.current) setWalkShowMeActive(false);
          void logAppAudit({
            kind: 'review-show-me-finished',
            category: 'subsystem',
            source: 'CoachGameReview.runShowMePlayout',
            summary: `ply ${startedAtPly} show-me played ${pliesPlayed} plies`,
            details: JSON.stringify({
              startedAtPly,
              pliesPlayed,
            }),
          });
        }
      };

      // WO-REVIEW-02b — Engine lines panel helpers.
      const currentPlyLines = engineLines.linesForPly(walkPlayback.currentPly);
      const currentBaseFen = reviewFens ? reviewFens[walkPlayback.currentPly] : null;
      const handleToggleEngineLines = (): void => {
        setEngineLinesEnabled((v: boolean) => {
          void logAppAudit({
            kind: 'review-engine-lines-toggled',
            category: 'subsystem',
            source: 'CoachGameReview',
            summary: `enabled=${!v}`,
          });
          // Layout state snapshot — captures viewport + board container
          // dims at the moment the panel opens / closes. Diagnoses
          // "showing engine lines shrinks the board" by making the
          // before/after diff measurable. The panel renders on the next
          // tick; we run after a microtask so the measurement reflects
          // the new layout state.
          if (typeof window !== 'undefined') {
            const enabling = !v;
            queueMicrotask(() => {
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const orientation = vw > vh ? 'landscape' : 'portrait';
              // Best-effort board measurement via a stable selector.
              // Falls back to null when the wrapper can't be found —
              // never throws, never blocks the toggle.
              const boardEl = document.querySelector<HTMLElement>(
                '[data-testid="consistent-chessboard"], .chessboard-wrapper, .react-chessboard',
              );
              const boardW = boardEl?.getBoundingClientRect().width ?? null;
              const boardH = boardEl?.getBoundingClientRect().height ?? null;
              void logAppAudit({
                kind: 'engine-lines-layout-state',
                category: 'subsystem',
                source: 'CoachGameReview.handleToggleEngineLines',
                summary: `panel=${enabling ? 'open' : 'closed'} orientation=${orientation} viewport=${vw}x${vh} board=${boardW ? Math.round(boardW) : '?'}x${boardH ? Math.round(boardH) : '?'}`,
                details: JSON.stringify({
                  panelEnabled: enabling,
                  viewport: { width: vw, height: vh, orientation },
                  board: { width: boardW, height: boardH },
                }),
              });
            });
          }
          return !v;
        });
      };
      // Seed the existing under-board best-line nav with a tapped
      // ship-4: `handleExploreCandidate` removed — the engine-lines
      // panel rows are now static display labels. Tapping a row in
      // the old surface staged the PV in `bestLine*` state and flipped
      // to the deleted analysis phase. The green best-move arrow on
      // the board already conveys the top suggestion, and the engine
      // lines panel still shows the eval + 5-ply preview for context.
      const formatEval = (line: { evaluation: number; mate: number | null }): string => {
        if (line.mate !== null) return line.mate > 0 ? `M${line.mate}` : `-M${Math.abs(line.mate)}`;
        const pawns = line.evaluation / 100;
        return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
      };

      return (
        <div className="flex flex-col w-full h-full overflow-hidden" data-testid="coach-game-review-walk">
          {/* ── Fixed top: header, board, badge, HERO nav ─────────────── */}
          <div className="shrink-0 border-b border-theme-border">
            <div className="flex items-center gap-2 w-full px-3 py-2">
              <button onClick={onBackToCoach} className="p-1 rounded-lg hover:bg-theme-surface" aria-label="Back to coach">
                <ArrowLeft size={18} style={{ color: 'var(--color-text)' }} />
              </button>
              <h2 className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
                Game Review
              </h2>
              <div className="ml-auto text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Ply {walkPlayback.currentPly}/{lastPly}
              </div>
            </div>

            <div className="px-2 pt-1 pb-2 flex justify-center relative">
              <div className="w-full md:max-w-[420px] relative">
                <ChessBoard
                  // Re-key on exploration toggle so the underlying chess
                  // instance resets cleanly when the user enters or
                  // resumes from exploration. Without the key, the
                  // board's internal Chess() retains move history from
                  // the prior FEN and rejects the next move.
                  //
                  // Audit-driven (review walk #1): the key originally
                  // included `-ply${currentPly}` which forced a fresh
                  // ChessBoard mount on every forward/back press. The
                  // brief unmount+remount collapsed the board wrapper's
                  // height to 0 for one frame, causing the HERO nav row
                  // below to jump up and back down — user reported as
                  // "board shifts down after each press." Per-ply key
                  // is also redundant: useChessGame already syncs FEN
                  // changes via its [initialFen] effect (rebuilds the
                  // Chess instance, clears lastMove + selection). The
                  // exploration half of the key stays — it forces a
                  // clean remount when entering/exiting exploration so
                  // any chess.js move history accumulated during
                  // exploration is wiped.
                  key={`walk-board-${walkExplorationFen ? 'expl' : 'live'}`}
                  initialFen={walkDisplayFen}
                  orientation={playerColor}
                  interactive={walkBoardInteractive}
                  arrows={walkArrows}
                  // Eval bar parity with Learn-with-Coach: pass the
                  // segment's per-ply evaluation through so the user
                  // can see the position eval as they walk forward.
                  // During exploration there's no fresh Stockfish run
                  // yet, so the bar holds the last known eval until
                  // the next ply.
                  showEvalBar
                  evaluation={seg?.evalAfter ?? null}
                  showFlipButton
                  // Parity with Learn-with-Coach board: last-move
                  // highlight on every transition so the piece that
                  // just moved is visually obvious. useChessGame
                  // resets `lastMove` on every initialFen change, so
                  // we pass an explicit `highlightSquares` derived
                  // from the segment's played-move SAN.
                  showLastMoveHighlight
                  highlightSquares={(() => {
                    if (walkExplorationFen || !seg) return null;
                    try {
                      const probe = new Chess(seg.fenBefore);
                      const m = probe.move(seg.san);
                      return m ? { from: m.from, to: m.to } : null;
                    } catch {
                      return null;
                    }
                  })()}
                  onMove={walkBoardInteractive ? (moveResult) => {
                    // Student played a piece while a better-move arrow
                    // was showing → record their exploration. We capture
                    // the post-move FEN + SAN and surface a "Resume game"
                    // button. Audit emit so the unified panel shows the
                    // exploration trail.
                    setWalkExplorationFen(moveResult.fen);
                    setWalkExplorationSan(moveResult.san);
                    walkExplorationPlyRef.current = walkPlayback.currentPly;
                    playMoveSound(moveResult.san);
                    void logAppAudit({
                      kind: 'review-walk-explored',
                      category: 'subsystem',
                      source: 'CoachGameReview.walkExplore',
                      summary: `ply ${walkPlayback.currentPly} explored ${moveResult.san}`,
                      fen: moveResult.fen,
                      details: JSON.stringify({
                        ply: walkPlayback.currentPly,
                        playedSan: moveResult.san,
                        suggestedUci: seg?.bestMoveUci ?? null,
                        classification: seg?.classification ?? null,
                      }),
                    });
                    // Engine reply — David's review-audit feedback:
                    // "I could only move my piece on the board and the
                    // opponent did not make a move after I did." Fire
                    // Stockfish at medium strength (~1500 ELO) so the
                    // exploration feels like a continuation rather than
                    // a frozen one-move analysis.
                    void (async () => {
                      try {
                        const config = resolveConfig('medium', 1500);
                        const reply = await getCoachMove(moveResult.fen, config);
                        // Apply on a local chess.js, get the post-reply
                        // FEN, then swap walkExplorationFen so the board
                        // animates the opponent's slide.
                        const probe = new Chess(moveResult.fen);
                        const applied = probe.move({
                          from: reply.from,
                          to: reply.to,
                          promotion: reply.promotion,
                        });
                        if (!applied || !walkMountedRef.current) return;
                        setWalkExplorationFen(probe.fen());
                        playMoveSound(applied.san);
                      } catch {
                        // Stockfish unreachable / engine error — stay
                        // on the student's exploration FEN. The Resume
                        // button still lets them snap back.
                      }
                    })();
                  } : undefined}
                />
                {badge && (
                  <div
                    className="absolute top-1 right-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide pointer-events-none text-white"
                    style={{
                      background: CLASSIFICATION_STYLES[badge as keyof typeof CLASSIFICATION_STYLES].color,
                    }}
                    data-testid="review-classification-badge"
                  >
                    {CLASSIFICATION_STYLES[badge as keyof typeof CLASSIFICATION_STYLES].label}
                  </div>
                )}
                {/* Resume-game button — appears whenever the student
                    has explored a move that diverges from the actual
                    game line. Tap to clear exploration and snap the
                    board back to the real game position at this ply. */}
                {walkExplorationFen && (
                  <button
                    onClick={() => {
                      void logAppAudit({
                        kind: 'review-walk-resumed',
                        category: 'subsystem',
                        source: 'CoachGameReview.walkResume',
                        summary: `ply ${walkPlayback.currentPly} resumed (was ${walkShowMeActive ? 'show-me playing' : `exploring ${walkExplorationSan ?? '?'}`})`,
                        fen: displayFen,
                        details: JSON.stringify({
                          ply: walkPlayback.currentPly,
                          exploredSan: walkExplorationSan,
                          showMeActive: walkShowMeActive,
                        }),
                      });
                      // Cancel any in-flight show-me playout. The async
                      // loop reads walkShowMeActiveRef every iteration
                      // and bails when it flips false.
                      setWalkShowMeActive(false);
                      setWalkExplorationFen(null);
                      setWalkExplorationSan(null);
                      walkExplorationPlyRef.current = null;
                    }}
                    className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-lg"
                    style={{
                      background: 'var(--color-accent)',
                      color: 'var(--color-bg)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                    data-testid="walk-resume-game-btn"
                    aria-label="Resume the actual game line"
                  >
                    <RotateCcw size={12} />
                    Resume game
                  </button>
                )}
                {/* Pre-exploration action row at the bottom of the
                    board on inaccuracy/mistake/blunder plies. Two CTAs:
                    - "Explore this position" — flips the board to
                      `seg.fenBefore` so the student can play the
                      missed move themselves (existing behavior).
                    - "Show me" — Stockfish auto-plays the punishment
                      line from `seg.fenAfter` so the student sees
                      WHY their move was bad. Silent v1, standard
                      board cadence, capped at 4 plies / game-over.
                    Both hidden once exploration or playout starts;
                    the Resume button takes over. */}
                {hasArrow && walkExplorationFen === null && !walkExploreToggleOn && !walkShowMeActive && (
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-2">
                    <button
                      onClick={() => setWalkExploreToggleOn(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-lg"
                      style={{
                        background: '#22c55e',
                        color: 'white',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                      }}
                      data-testid="walk-explore-toggle-btn"
                      aria-label="Try the missed move yourself"
                    >
                      Explore this position
                    </button>
                    <button
                      onClick={() => { void runShowMePlayout(); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-lg"
                      style={{
                        background: '#ef4444',
                        color: 'white',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                      }}
                      data-testid="walk-show-me-btn"
                      aria-label="Show me the punishment line"
                    >
                      Show me
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Walk nav: four uniform 52px buttons, forward gets a
                subtle accent border so it reads as primary without
                dwarfing the others. Audit-driven redesign — the prior
                gold 120×90 forward chevron next to 60×60 transparent
                siblings was visually unbalanced. All four now share
                the same shape, size, and active-press affordance. */}
            <div className="flex items-center justify-center gap-2 py-2" data-testid="review-nav-controls">
              <button
                onClick={walkPlayback.goToStart}
                className="w-[52px] h-[52px] rounded-xl border border-theme-border hover:bg-theme-surface disabled:opacity-30 flex items-center justify-center transition-transform active:scale-[0.96]"
                disabled={walkPlayback.currentPly === 0}
                aria-label="Jump to start"
              >
                <SkipBack size={22} style={{ color: 'var(--color-text)' }} />
              </button>
              <button
                onClick={walkPlayback.goBack}
                className="w-[52px] h-[52px] rounded-xl border border-theme-border hover:bg-theme-surface disabled:opacity-30 flex items-center justify-center transition-transform active:scale-[0.96]"
                disabled={walkPlayback.currentPly === 0}
                aria-label="Back one move"
                data-testid="review-back-btn"
              >
                <ChevronLeft size={24} style={{ color: 'var(--color-text)' }} />
              </button>
              <button
                onClick={walkPlayback.goForward}
                className="w-[52px] h-[52px] rounded-xl border-2 disabled:opacity-30 flex items-center justify-center transition-transform active:scale-[0.96]"
                disabled={walkPlayback.currentPly >= lastPly}
                style={{
                  borderColor: 'var(--color-accent)',
                }}
                aria-label="Forward one move"
                data-testid="review-forward-btn"
              >
                <ChevronRight size={24} style={{ color: 'var(--color-accent)' }} />
              </button>
              <button
                onClick={walkPlayback.goToEnd}
                className="w-[52px] h-[52px] rounded-xl border border-theme-border hover:bg-theme-surface disabled:opacity-30 flex items-center justify-center transition-transform active:scale-[0.96]"
                disabled={walkPlayback.currentPly >= lastPly}
                aria-label="Jump to end"
              >
                <SkipForward size={22} style={{ color: 'var(--color-text)' }} />
              </button>
            </div>

            {/* Secondary controls row: pause/play + Ask (inline, small) */}
            <div className="flex items-center justify-center gap-2 pb-2">
              {/* Narration toggle — pauses or replays the SPOKEN narration
                  for the current ply. Does NOT advance to the next ply
                  (manual-only stepping). User feedback (build 3d8e3ef)
                  caught the prior "Play / Pause" labels reading like an
                  auto-advance toggle; this rename + Volume icons make
                  voice control unambiguous. */}
              <button
                onClick={walkPlayback.togglePausePlay}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-surface"
                style={{ color: 'var(--color-text)' }}
                aria-label={walkPlayback.narrationState === 'speaking' ? 'Stop narration' : 'Replay narration'}
                data-testid="walk-narration-toggle-btn"
              >
                {walkPlayback.narrationState === 'speaking'
                  ? <><VolumeX size={12} /> Stop narration</>
                  : <><Volume2 size={12} /> Replay narration</>}
              </button>
              <button
                onClick={() => setAskExpanded((v: boolean) => !v)}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-surface"
                style={{ color: 'var(--color-text)' }}
                data-testid="walk-ask-toggle-btn"
              >
                <MessageCircle size={12} />
                Ask
              </button>
            </div>
          </div>

          {/* ── Scrollable middle: narration, move list, tactics, ask ── */}
          <div className="flex-1 min-h-0 overflow-y-auto" data-testid="review-scroll-middle">
            {/* Current-move narration banner */}
            <div className="px-3 pt-2 pb-1">
              <div
                className="rounded-xl backdrop-blur-md border border-emerald-500/30 px-3 py-2"
                style={{ background: 'color-mix(in srgb, var(--color-bg) 85%, rgba(16,185,129,0.3))' }}
                data-testid="review-narration-banner"
              >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text)' }}>
                  {walkPlayback.currentText ?? '(this move passes silently — tap forward to continue)'}
                </p>
              </div>
            </div>

            {/* Engine lines panel (WO-REVIEW-02b) */}
            <div className="px-3 pt-2 pb-1" data-testid="review-engine-lines-section">
              <button
                onClick={handleToggleEngineLines}
                className="w-full flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-theme-border hover:bg-theme-surface"
                style={{ color: 'var(--color-text)' }}
                data-testid="review-engine-lines-toggle"
              >
                <Cpu size={12} style={{ color: 'var(--color-accent)' }} />
                <span className="font-semibold">
                  {engineLinesEnabled ? 'Hide engine lines' : 'Show engine lines'}
                </span>
                {engineLinesEnabled && engineLines.loading && (
                  <span className="ml-auto text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    Analyzing {engineLines.progress.current}/{engineLines.progress.total}…
                  </span>
                )}
              </button>
              {engineLinesEnabled && (
                <div className="mt-2 space-y-1.5" data-testid="review-engine-lines-panel">
                  {currentPlyLines && currentPlyLines.length > 0 ? (
                    currentPlyLines.map((line, i) => {
                      const previewSans: string[] = [];
                      if (currentBaseFen) {
                        try {
                          const c = new Chess(currentBaseFen);
                          for (const u of line.moves.slice(0, 5)) {
                            const r = c.move({
                              from: u.slice(0, 2),
                              to: u.slice(2, 4),
                              promotion: u.length > 4 ? u.slice(4, 5) : undefined,
                            });
                            previewSans.push(r.san);
                          }
                        } catch {
                          // ignore — bad fen/uci, preview stays empty
                        }
                      }
                      // ship-4: rows are static display labels. The
                      // old `handleExploreCandidate` onClick routed to
                      // the deleted analysis-phase bestLine nav.
                      return (
                        <div
                          key={`${line.rank}-${i}`}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-theme-border text-left"
                          data-testid={`review-engine-line-${i}`}
                        >
                          <span
                            className="text-[11px] font-bold font-mono min-w-[52px]"
                            style={{ color: 'var(--color-accent)' }}
                          >
                            {formatEval(line)}
                          </span>
                          <span className="text-xs font-mono truncate" style={{ color: 'var(--color-text)' }}>
                            {previewSans.length > 0 ? previewSans.join(' ') : '—'}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-[11px] px-2 py-1" style={{ color: 'var(--color-text-muted)' }}>
                      {engineLines.loading
                        ? 'Analyzing this position…'
                        : 'No engine lines for this ply.'}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Ask panel (expandable) */}
            {askExpanded && (
              <div className="px-3 py-2 border-t border-theme-border" data-testid="walk-ask-panel">
                {askResponse !== null && (
                  <div className="mb-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-accent)' }}>
                        Coach
                      </span>
                      {isAskStreaming && (
                        <Loader2 size={10} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
                      )}
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text)' }} data-testid="walk-ask-response">
                      {askResponse || (isAskStreaming ? '' : 'No response')}
                    </p>
                  </div>
                )}
                <ChatInput
                  onSend={handleAskSend}
                  disabled={isAskStreaming}
                  placeholder="Ask about this position..."
                />
              </div>
            )}

            {/* Opening + move list */}
            <div className="border-t border-theme-border">
              <div className="px-3 pt-2 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                  {openingName ?? 'Move list'}
                </span>
                <KeyMomentNav
                  moves={moves}
                  currentIndex={walkMoveIndex}
                  onNavigate={(idx: number) => walkPlayback.jumpToPly(idx + 1)}
                  className=""
                  extraIndices={walkPlayback.hintPlies.map((ply) => ply - 1)}
                />
              </div>
              <div className="max-h-[180px] overflow-y-auto">
                <MoveListPanel
                  moves={moves}
                  openingName={openingName}
                  currentMoveIndex={walkMoveIndex >= 0 ? walkMoveIndex : null}
                  onMoveClick={(idx: number) => walkPlayback.jumpToPly(idx + 1)}
                  className="h-full"
                />
              </div>
            </div>

            {/* Missed tactics — ship-1 made this non-empty for every
                reviewed game. Tapping a row jumps to the ply; the
                board there already surfaces the classification badge,
                the green best-move arrow, and the deterministic
                narration banner. The prior Drill All / Show / Try It
                buttons routed through a now-deleted practice phase —
                dropped in ship-4. Future ship can add a leaner
                inline drill flow if needed. */}
            {missedTactics.length > 0 && (
              <div className="border-t border-theme-border px-3 py-2" data-testid="walk-missed-tactics">
                <div className="flex items-center gap-1.5 mb-2">
                  <Crosshair size={12} style={{ color: 'var(--color-text-muted)' }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                    Missed tactics ({missedTactics.length})
                  </span>
                </div>
                <div className="space-y-1.5">
                  {missedTactics.map((tactic: MissedTactic, i: number) => (
                    <button
                      key={i}
                      type="button"
                      className="w-full flex items-center gap-2 p-1.5 rounded-md hover:bg-theme-surface transition-colors text-left"
                      onClick={() => walkPlayback.jumpToPly(tactic.moveIndex + 1)}
                      data-testid={`walk-missed-tactic-${i}`}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                          Move {Math.ceil(moves[tactic.moveIndex].moveNumber / 2)}:{' '}
                          <span className="capitalize">{tactic.tacticType.replace(/_/g, ' ')}</span>
                        </span>
                        <span className="text-[10px] ml-1.5" style={{ color: 'var(--color-text-muted)' }}>
                          ({(tactic.evalSwing / 100).toFixed(1)} pawns)
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Practice in Chat */}
            {missedTactics.length > 0 && onPracticeInChat && (
              <div className="border-t border-theme-border px-3 py-2" data-testid="walk-practice-in-chat">
                <button
                  onClick={handlePracticeInChat}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                  data-testid="walk-practice-in-chat-btn"
                >
                  <Target size={12} />
                  Practice in Chat
                </button>
              </div>
            )}

            {/* ship-4: "Full analysis" escape hatch removed — it
                routed to a deleted analysis phase and landed users on
                the prep-failed fallback summary card with no way back.
                Walk phase is the canonical review surface. */}
          </div>

          {/* ── Fixed bottom: Play Again + Back to Coach ──────────────
              mb-[4.5rem] (mobile only) lifts the bar above
              AppLayout's md:hidden fixed bottom-0 nav (≈4.5rem tall)
              so its click area isn't intercepted. Audit-driven:
              audit-coach-review.mjs caught `walk-back-to-coach-btn`
              clicks failing on mobile viewport because the nav sat on
              top of the bar. md+ hides the nav, so md:mb-0. */}
          <div
            className="shrink-0 flex items-center gap-2 px-3 py-3 border-t border-theme-border mb-[4.5rem] md:mb-0"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
            data-testid="review-bottom-bar"
          >
            <button
              onClick={onPlayAgain}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="walk-play-again-btn"
            >
              <RotateCcw size={14} />
              Play Again
            </button>
            <button
              onClick={onBackToCoach}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border text-sm font-medium hover:opacity-90"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              data-testid="walk-back-to-coach-btn"
            >
              <Home size={14} />
              Back to Coach
            </button>
          </div>
        </div>
      );
    }

    // Loading / prep-failed fallback: show the summary card.
    // Per user architecture: there should NOT be a separate analysis
    // phase the user opts into. The walk UI is the only review
    // experience and auto-renders above when walkNarration arrives.
    // The `onStartReview` prop is still wired for backwards-compat
    // with the legacy "Quick / Full Review" buttons (covered by 21
    // existing tests) — but since CoachReviewSessionPage no longer
    // passes `autoStartReview` and walk-phase auto-renders on prep
    // success, normal users never need to click them. Cleanup of
    // those buttons + their tests is deferred to a follow-up commit
    // that rewrites the tests against walk-phase rendering.
    return (
      <div className="flex flex-col items-center justify-center w-full h-full overflow-y-auto" data-testid="coach-game-review">
        <ReviewSummaryCard
          result={result}
          playerColor={playerColor}
          accuracy={accuracy}
          classificationCounts={classificationCounts}
          phaseBreakdown={phaseBreakdown}
          openingName={openingName}
          moveCount={accuracy.moveCount}
          moves={moves}
          narrativeSummary={isLoadingNarrative ? (narrativeSummary ?? undefined) : (narrativeSummary ?? undefined)}
          missedOpportunities={missCount}
          // onStartReview omitted: clicking it would route to the
          // deleted analysis-phase, leaving the user on a dead-end
          // fallback render with no way forward. Walk-phase auto-
          // renders the moment walkNarration arrives, so no manual
          // start button is needed.
          onPlayAgain={onPlayAgain}
          onBackToCoach={onBackToCoach}
        />
      </div>
    );
  }

}
