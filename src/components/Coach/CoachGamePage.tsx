import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Undo2, Eye, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, Loader2, Lightbulb, AlertTriangle, GraduationCap, Compass, RotateCcw, Volume2, MessageCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Chess } from 'chess.js';
import { safeChessFromFen } from '../../services/chessSafe';
import { useChessGame } from '../../hooks/useChessGame';
import { usePracticePosition } from '../../hooks/usePracticePosition';
import { useHintSystem } from '../../hooks/useHintSystem';
import { useLiveCoach } from '../../hooks/useLiveCoach';
import { useCoachTips } from '../../hooks/useCoachTips';
import type { TacticLineData } from '../../hooks/useCoachTips';
import { ChessBoard } from '../Board/ChessBoard';
import { VoiceChatMic } from '../Board/VoiceChatMic';
import type { EngineSnapshot, LastMoveContext } from '../Board/VoiceChatMic';
import { EngineLines } from '../Board/EngineLines';
import { AnalysisToggles } from '../Board/AnalysisToggles';
import { DifficultyToggle } from './DifficultyToggle';
import { HintButton } from './HintButton';
import { CoachGameReview } from './CoachGameReview';
import { GameChatPanel } from './GameChatPanel';
import type { GameChatPanelHandle } from './GameChatPanel';
import { PlayerInfoBar } from './PlayerInfoBar';
import { MoveListPanel } from './MoveListPanel';
import { ResignButton } from './ResignButton';
import { PositionNarrationBanner } from './PositionNarrationBanner';
import { usePositionNarration } from '../../hooks/usePositionNarration';
import { usePhaseNarration } from '../../hooks/usePhaseNarration';
import {
  createPhaseTransitionState,
  detectPhaseTransition,
  phaseTransitionDiagnostic,
  type PhaseTransitionState,
} from '../../services/phaseTransitionDetector';
import { logAppAudit } from '../../services/appAuditor';
import { unwrapSpineError, SENTENCE_END_RE } from '../../services/sanitizeCoachText';
import { createStreamingSpeaker } from '../../services/streamingSpeaker';
import type { PhaseNarrationVerbosity } from '../../types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePieceSound } from '../../hooks/usePieceSound';
import { useAppStore } from '../../stores/appStore';
import { useCoachSessionStore } from '../../stores/coachSessionStore';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { narrateMove } from '../../services/coachAgentRunner';
import { useSettings } from '../../hooks/useSettings';
import { getRandomLegalMove, getTargetStrength } from '../../services/coachGameEngine';
import { coachService } from '../../coach/coachService';
import { anthropicProvider } from '../../coach/providers/anthropic';
import { withTimeout } from '../../coach/withTimeout';
import { emergencyPickMove } from '../../coach/coachTurnFallback';
import type { LiveState } from '../../coach/types';
import { classifyPosition, scanUpcomingTactics } from '../../services/tacticClassifier';
import { getScenarioTemplate } from '../../services/coachTemplates';
import { generateMoveCommentary } from '../../services/coachMoveCommentary';
import {
  loadCoachPlayState,
  saveCoachPlayState,
  clearCoachPlayState,
  loadCoachPlayChat,
  saveCoachPlayChat,
} from '../../services/coachPlayPersistence';
import { fetchLichessExplorer, fetchCloudEval } from '../../services/lichessExplorerService';
import { detectTrapInPosition, formatTrapForPrompt, type MoveEvaluation } from '../../services/openingTrapDetector';

/** Max wall-clock for any Lichess lookup during opening teaching.
 *  Matches coachContextEnricher's FETCH_TIMEOUT_MS so the whole
 *  coach-narration path shares a budget. Past this, narration
 *  degrades to ungrounded prose rather than stalling the turn. */
const LICHESS_FETCH_TIMEOUT_MS = 2500;

/** Race a fetch-style promise against a timeout, throwing 'timeout'
 *  on expiry. Distinct from `../../coach/withTimeout` (which returns
 *  a discriminated `{ ok }` result for the resilience chain) — this
 *  one is used by Lichess cloud-eval / explorer fetches that already
 *  use try / catch and want a thrown error on timeout. */
function withFetchTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Evaluate a set of candidate SAN moves on the position reached AFTER
 * each move. Uses Lichess cloud-eval (no auth, free, cached) per
 * candidate in parallel. Candidates whose FEN has no cloud eval
 * (404) are skipped — better to miss a trap than to mis-flag one.
 *
 * Eval is normalised to the MOVER's POV: positive = the candidate
 * player got better, negative = they lost ground. This matches what
 * `detectTrapInPosition` expects (it looks for popular moves where
 * evalCp &lt;= -200 for the mover).
 */
/** Max Lichess cloud-eval requests in flight at once. Previously
 *  Promise.all fired 5+ candidates in parallel on every trap check,
 *  which could 429 on the public endpoint or just pile up on slow
 *  networks. 2-at-a-time is enough to keep latency reasonable
 *  without burst. */
const LICHESS_CLOUD_EVAL_CONCURRENCY = 2;

async function evaluateExplorerCandidates(
  fen: string,
  sanList: string[],
  mover: 'w' | 'b',
): Promise<MoveEvaluation[]> {
  const ChessCtor = (await import('chess.js')).Chess;

  const evalOne = async (san: string): Promise<MoveEvaluation | null> => {
    try {
      const board = new ChessCtor(fen);
      const moved = board.move(san);
      if (!moved) return null;
      const resultingFen = board.fen();
      const eval_ = await withFetchTimeout(fetchCloudEval(resultingFen, 1), LICHESS_FETCH_TIMEOUT_MS);
      if (!eval_ || !eval_.pvs || eval_.pvs.length === 0) return null;
      // cloud-eval cp is from WHITE's POV. Flip for black movers so
      // the detector gets a "this was good/bad for the MOVER" number.
      const cpWhitePov = eval_.pvs[0].cp ?? 0;
      const evalCp = mover === 'w' ? cpWhitePov : -cpWhitePov;
      return { san, evalCp };
    } catch {
      return null;
    }
  };

  // Chunked Promise.all — process LICHESS_CLOUD_EVAL_CONCURRENCY at a
  // time to cap outbound request bursts against the free Lichess API.
  const results: (MoveEvaluation | null)[] = [];
  for (let i = 0; i < sanList.length; i += LICHESS_CLOUD_EVAL_CONCURRENCY) {
    const chunk = sanList.slice(i, i + LICHESS_CLOUD_EVAL_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(evalOne));
    results.push(...chunkResults);
  }
  return results.filter((r): r is MoveEvaluation => r !== null);
}
import { resolveVerbosity, shouldCallLlmForMove } from '../../services/coachCommentaryPolicy';
import { BLUNDER_ALERT_ADDITION, EXPLORE_REACTION_ADDITION } from '../../services/coachPrompts';
import { stockfishEngine } from '../../services/stockfishEngine';
import { resolveConfig as resolvePlayConfig } from '../../services/coachPlaySession';
import { detectOpening, getOpeningMoves, resolveOpeningEntry } from '../../services/openingDetectionService';
import { stripSanAnnotations } from '../../data/openingWalkthroughs/validate';
import { getCapturedPieces, getMaterialAdvantage } from '../../services/boardUtils';
import { uciMoveToSan, uciLinesToSan } from '../../utils/uciToSan';
import { db } from '../../db/schema';
import { calculateAccuracy, getClassificationCounts } from '../../services/accuracyService';
import { getPhaseBreakdown } from '../../services/gamePhaseService';
import { detectMissedTactics } from '../../services/missedTacticService';
import { detectBadHabitsFromGame } from '../../services/coachFeatureService';
import { generateMistakePuzzlesFromGame } from '../../services/mistakePuzzleService';
import { computeWeaknessProfile } from '../../services/weaknessAnalyzer';
import { reconstructMovesFromGame } from '../../services/gameReconstructionService';
import { voiceService, resolvePollyVoice, POLLY_VOICES } from '../../services/voiceService';
import type {
  CoachGameState, CoachGameMove, KeyMoment, DetectedOpening,
  CoachDifficulty, MoveClassification, MoveAnnotation,
  StockfishAnalysis, GameAnalysisSummary, GameRecord, AnalysisLine,
  GameResult, BoardArrow, BoardHighlight, BoardAnnotationCommand,
  ChatMessage,
} from '../../types';
import type { MoveResult } from '../../hooks/useChessGame';
import { isMateEval } from '../../services/engineConstants';

function classifyMove(
  preMoveEval: number | null,
  postMoveEval: number,
  bestMoveEval: number | null,
  isEngineBestMove: boolean,
  playerColor: 'white' | 'black',
  secondBestEval?: number | null,
): MoveClassification {
  if (preMoveEval === null) return 'good';
  // Both evals are from White's perspective (normalized by stockfishEngine).

  // If the player delivered checkmate or found a forced mate, it's brilliant/great
  const postMoveGoodForPlayer = playerColor === 'white' ? postMoveEval > 0 : postMoveEval < 0;
  if (isMateEval(postMoveEval) && postMoveGoodForPlayer) {
    return isEngineBestMove ? 'brilliant' : 'great';
  }

  // If the player walked into a forced mate against them (was fine before), it's a blunder
  const postMoveBadForPlayer = playerColor === 'white' ? postMoveEval < 0 : postMoveEval > 0;
  if (isMateEval(postMoveEval) && postMoveBadForPlayer && !isMateEval(preMoveEval)) {
    return 'blunder';
  }

  // If both pre and post are mate evals (e.g. forced mate was already on the board),
  // the player maintained the line — classify as good unless they lost the mate
  if (isMateEval(preMoveEval) && isMateEval(postMoveEval)) {
    return 'good';
  }

  // cpLostVsBest = how much worse the played move is vs the engine's best
  const cpLostVsBest = bestMoveEval !== null
    ? (playerColor === 'white'
        ? bestMoveEval - postMoveEval
        : postMoveEval - bestMoveEval)
    : 0;

  // Brilliant: player found the engine's best move AND second-best was significantly worse.
  // This means the move was the *only* good option in a critical position (Chess.com-style).
  // We require second-best to be ≥150cp worse than best to qualify as brilliant.
  if (isEngineBestMove && secondBestEval !== null && secondBestEval !== undefined) {
    const secondBestGap = playerColor === 'white'
      ? (bestMoveEval ?? postMoveEval) - secondBestEval
      : secondBestEval - (bestMoveEval ?? postMoveEval);
    if (secondBestGap >= 150) return 'brilliant';
  }

  // Great: played the best move or very close (<10cp off)
  if (cpLostVsBest <= 10) return 'great';
  // Good: small inaccuracy vs best
  if (cpLostVsBest < 50) return 'good';
  // Suboptimal classifications based on cp lost vs best move
  if (cpLostVsBest < 100) return 'inaccuracy';
  if (cpLostVsBest < 250) return 'mistake';
  return 'blunder';
}

function findKeyMoments(moves: CoachGameMove[]): KeyMoment[] {
  const evaluated = moves.filter((m) => m.evaluation !== null && !m.isCoachMove);
  if (evaluated.length < 2) return [];

  // Find largest eval swings, clamping mate evals so they don't distort deltas
  const clampEval = (e: number): number => Math.max(-3000, Math.min(3000, e));

  const swings: { index: number; delta: number; move: CoachGameMove }[] = [];

  for (let i = 1; i < evaluated.length; i++) {
    const prev = evaluated[i - 1];
    const curr = evaluated[i];
    if (prev.evaluation !== null && curr.evaluation !== null) {
      const delta = Math.abs(clampEval(curr.evaluation) - clampEval(prev.evaluation));
      swings.push({ index: i, delta, move: curr });
    }
  }

  swings.sort((a, b) => b.delta - a.delta);

  return swings.slice(0, 5).map((s) => {
    const cls = s.move.classification;
    const type: KeyMoment['type'] = cls === 'brilliant' || cls === 'great'
      ? 'brilliant'
      : cls === 'blunder' || cls === 'mistake'
        ? 'blunder'
        : s.delta > 200 ? 'turning_point' : 'turning_point';

    return {
      moveNumber: s.move.moveNumber,
      fen: s.move.fen,
      explanation: s.move.commentary || `Move ${s.move.moveNumber}: ${s.move.san} — evaluation changed significantly.`,
      type,
    };
  });
}

function movesToAnnotations(moves: CoachGameMove[], playerColor: 'white' | 'black'): MoveAnnotation[] {
  return moves
    .filter((m): m is CoachGameMove & { classification: MoveClassification } =>
      !m.isCoachMove && m.classification !== null)
    .map((m) => ({
      moveNumber: Math.ceil(m.moveNumber / 2),
      color: playerColor,
      san: m.san,
      // Both values are already centipawns (White POV) from the live
      // CoachGamePage classifier — pass through unchanged so the review
      // surface's swing math matches the live game's classifier output.
      evaluation: m.evaluation,
      bestMove: m.bestMove,
      bestMoveEval: m.bestMoveEval,
      classification: m.classification,
      comment: m.commentary || null,
    }));
}

function buildAnalysisSummary(
  moves: CoachGameMove[],
  keyMoments: KeyMoment[],
  playerColor: 'white' | 'black',
  result: 'win' | 'loss' | 'draw',
): GameAnalysisSummary {
  const accuracy = calculateAccuracy(moves);
  const classificationCounts = getClassificationCounts(moves, playerColor);
  const phaseBreakdown = getPhaseBreakdown(moves, playerColor);
  const missedTactics = detectMissedTactics(moves, playerColor);

  return {
    accuracy,
    classificationCounts,
    phaseBreakdown,
    missedTactics,
    keyMoments,
    playerColor,
    result,
  };
}

/** WO-COACH-RATING-FLOOR. Maximum centipawn loss the coach is allowed
 *  to take vs. Stockfish's bestmove, indexed by the student's rating.
 *
 *  Lower-rated students intentionally get a higher tolerance — letting
 *  the coach blunder a bit makes early-rating play feel human and gives
 *  the student real winning chances. Higher-rated students get a tighter
 *  floor so the coach stays sharp and the practice has teeth.
 *
 *  Returns `Infinity` for ratings under 1000 — eval floor disengaged
 *  entirely. See `enforceMateFloor` for the matching beginner exemption
 *  on mate-walk: beginners NEED to see the coach hang itself into mate
 *  so they get pattern recognition reps. */
function maxCpLossFor(rating: number): number {
  if (rating < 1000) return Infinity;
  if (rating < 1400) return 350;
  if (rating < 1800) return 200;
  if (rating < 2200) return 100;
  return 50;
}

/** Whether the coach should refuse to walk into mate-in-≤-2 at this
 *  rating. Below 1000 the coach is allowed to be Scholar's-Mated by
 *  the student — that's a teaching moment, not a bug. At and above
 *  1000 the floor is active so the coach plays at least competently. */
function enforceMateFloor(rating: number): boolean {
  return rating >= 1000;
}

export interface CoachGamePageProps {
  /** Which surface this render is for. Same UI for both — every button,
   *  every info bar, every chrome element renders identically. The
   *  ONLY difference is the coach brain:
   *    - 'play'  → DeepSeek default + live commentary on key moments
   *    - 'teach' → Anthropic Sonnet + teaching-mode prompt that
   *                explains every move in depth, suggests with arrows,
   *                cites master games, etc.
   *  Stockfish stays as the opponent in both modes — it's still a
   *  real game; the coach just teaches more in teach mode.
   *  Default: 'play'. */
  surfaceMode?: 'play' | 'teach';
}

export function CoachGamePage({ surfaceMode = 'play' }: CoachGamePageProps = {}): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reviewGameId = searchParams.get('review');
  const startMoveParam = searchParams.get('move');
  const activeProfile = useAppStore((s) => s.activeProfile);

  // ─── Guided Lesson State (review query param) ──────────────────────────────
  const [reviewGame, setReviewGame] = useState<GameRecord | null>(null);
  const [reviewMoves, setReviewMoves] = useState<CoachGameMove[] | null>(null);
  const [reviewLoading, setReviewLoading] = useState(!!reviewGameId);

  useEffect(() => {
    if (!reviewGameId) return;
    setReviewLoading(true);
    void db.games.get(reviewGameId).then((game) => {
      if (game) {
        setReviewGame(game);
        setReviewMoves(reconstructMovesFromGame(game));
      }
      setReviewLoading(false);
    });
  }, [reviewGameId]);

  const coachTipsOn = useAppStore((s) => s.coachTipsOn);
  const toggleCoachTips = useAppStore((s) => s.toggleCoachTips);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);

  // Ref to inject messages into GameChatPanel (hints, takeback msgs)
  const gameChatRef = useRef<GameChatPanelHandle>(null);

  // ─── Coach-driven quiz state (WO-COACH-LICHESS-OPENINGS) ───────────
  // When the LLM emits `quiz_user_for_move`, the surface registers a
  // pending quiz here. The next student move resolves it: matching
  // `expectedSan` (or any `allowAlternatives`) → `{ ok: true }`, anything
  // else → `{ ok: false, played, expected }`. Either branch fires a
  // `quiz-resolved` audit so the LLM's next round-trip can narrate
  // feedback. The ref + state pair mirrors the pattern used elsewhere
  // (phase narration, blunder pause): ref is the synchronous read,
  // state drives the banner UI.
  type ActiveQuiz = {
    active: true;
    expectedSan: string;
    allowAlternatives: readonly string[];
    prompt: string;
    resolve: (
      result:
        | { ok: true; played: string }
        | { ok: false; played: string; expected: string }
        | { ok: false; reason: string },
    ) => void;
  };
  type QuizState = ActiveQuiz | { active: false };
  const [quizState, setQuizState] = useState<QuizState>({ active: false });
  const quizStateRef = useRef<QuizState>({ active: false });

  const cancelActiveQuizRef = useRef<(reason: string) => void>(() => {});
  cancelActiveQuizRef.current = (reason: string): void => {
    const cur = quizStateRef.current;
    if (!cur.active) return;
    cur.resolve({ ok: false, reason });
    quizStateRef.current = { active: false };
    setQuizState({ active: false });
    void logAppAudit({
      kind: 'quiz-cancelled',
      category: 'subsystem',
      source: 'CoachGamePage.cancelActiveQuiz',
      summary: `expected=${cur.expectedSan} reason=${reason}`,
    });
  };

  const handleQuizUserForMove = useCallback(
    (args: {
      expectedSan: string;
      prompt: string;
      allowAlternatives?: readonly string[];
    }): Promise<
      | { ok: true; played: string }
      | { ok: false; played: string; expected: string }
      | { ok: false; reason: string }
    > => {
      // Supersede any in-flight quiz before registering the new one.
      cancelActiveQuizRef.current('superseded by new quiz');
      return new Promise((resolve) => {
        const next: ActiveQuiz = {
          active: true,
          expectedSan: args.expectedSan,
          allowAlternatives: args.allowAlternatives ?? [],
          prompt: args.prompt,
          resolve,
        };
        quizStateRef.current = next;
        setQuizState(next);
        void logAppAudit({
          kind: 'quiz-started',
          category: 'subsystem',
          source: 'CoachGamePage.handleQuizUserForMove',
          summary: `expected=${args.expectedSan} alts=${(args.allowAlternatives ?? []).join(',') || 'none'}`,
          details: JSON.stringify(args),
        });
      });
    },
    [],
  );

  const handleStartWalkthroughForOpening = useCallback(
    (args: {
      opening: string;
      variation?: string;
      orientation?: 'white' | 'black';
      pgn?: string;
    }): { ok: boolean; reason?: string } => {
      const params = new URLSearchParams();
      params.set('subject', args.opening);
      if (args.variation) params.set('variation', args.variation);
      if (args.orientation) params.set('orientation', args.orientation);
      if (args.pgn) params.set('pgn', args.pgn);
      const route = `/coach/session/walkthrough?${params.toString()}`;
      void logAppAudit({
        kind: 'walkthrough-started-from-coach',
        category: 'subsystem',
        source: 'CoachGamePage.handleStartWalkthroughForOpening',
        summary: `opening=${args.opening} variation=${args.variation ?? 'none'} orientation=${args.orientation ?? 'auto'}`,
        details: JSON.stringify({ ...args, route }),
      });
      try {
        navigate(route);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    [navigate],
  );

  const playerRating = activeProfile?.currentRating ?? 1420;

  // Dynamic sessions redirect here with query params set by SmartSearchBar
  // / chat intent routing ("play the Sicilian against me as black hard").
  // Honor those on mount so the student lands in a ready-to-play game
  // with the requested configuration, not the default.
  const difficultyParam = searchParams.get('difficulty');
  const sideParam = searchParams.get('side');
  const subjectParam = searchParams.get('subject');
  // Carried over from the coach-chat "let's play / yes let's do it"
  // affirmation flow. When present, the coach's per-move reactions
  // get prefixed with this agreed training focus so the session
  // doesn't feel like a cold reset from the chat conversation.
  const focusParam = searchParams.get('focus');
  // When the coach describes a position in chat (via the "Play from
  // this position" CTA), or the user asks to play a specific
  // middlegame setup, we seed the game with this FEN instead of the
  // standard start. The book-move auto-play driven by `subject` is
  // suppressed when `fen` is set — we're not starting from move 1.
  const fenParam = searchParams.get('fen');
  const initialDifficulty: CoachDifficulty =
    difficultyParam === 'easy' || difficultyParam === 'medium' || difficultyParam === 'hard'
      ? difficultyParam
      : 'medium';
  const initialSide: 'white' | 'black' = sideParam === 'black' ? 'black' : 'white';

  const [difficulty, setDifficulty] = useState<CoachDifficulty>(initialDifficulty);
  const targetStrength = getTargetStrength(playerRating, difficulty);

  // Player color selection (disabled once game has started)
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>(initialSide);
  // Capture the fen param once on mount so navigation or param-clearing
  // later in the session doesn't re-seed the game. fenParam is null for
  // normal "start-from-scratch" games.
  const [initialGameFen] = useState<string | undefined>(() => fenParam ?? undefined);
  const game = useChessGame(initialGameFen, playerColor);

  const [gameState, setGameState] = useState<CoachGameState>({
    gameId: `game-${Date.now()}`,
    playerColor,
    targetStrength,
    moves: [],
    hintsUsed: 0,
    currentHintLevel: 0,
    takebacksUsed: 0,
    status: 'playing',
    result: 'ongoing',
    keyMoments: [],
  });

  const isMobile = useIsMobile();

  const [coachLastMove, setCoachLastMove] = useState<{ from: string; to: string } | null>(null);
  const previousFenRef = useRef<string | null>(null);
  const [isCoachThinking, setIsCoachThinking] = useState(false);
  const moveCountRef = useRef(0);
  // Track which openings we've already introduced this game so the
  // long teaching narration only fires ONCE per opening, not on
  // every move in book. Routine book moves stay silent until a key
  // moment (blunder / mistake / brilliant) or a phase transition
  // (handled by usePhaseNarration). Reset on game restart below
  // so a fresh game can re-introduce the opening.
  //
  // NB (WO-NARR-POLICY-01): collapsed from a Set<openingName> to a
  // single boolean. The auto-detector refines the opening name as more
  // moves are played ("Italian Game" → "King's Pawn Game" → "Damiano
  // Defense"), so the per-name set was firing the long intro three
  // times in a row for what the user perceives as one opening. One
  // intro per GAME aligns with what was asked for. Only fires under
  // verbosity='every-move' — under 'key-moments' the user explicitly
  // asked for silence except on actual events.
  const openingIntroSpokenRef = useRef<boolean>(false);

  // Requested opening — read live from the memory store. Post-tightening
  // (WO-BRAIN-04) the move-selector no longer derives a parallel SAN
  // array here; the brain consults `local_opening_book` itself when it
  // wants the line. Narration still asks for the line LENGTH to size
  // its "still in opening teaching mode" window, which is computed
  // inline at the call site below.
  const intendedOpening = useCoachMemoryStore((s) => s.intendedOpening);

  // Legacy shim: URL params (`?opening=…`, `?subject=…`) and resumed
  // games still call `handleOpeningRequest(name)`. We keep the name
  // and simply forward into the memory store, which handles audit
  // emission and persistence. Live chat surfaces skip this shim and
  // go straight to `tryCaptureOpeningIntent`.
  const handleOpeningRequest = useCallback((openingName: string) => {
    const moves = getOpeningMoves(openingName);
    if (!moves) {
      console.warn('[CoachGame] Opening not found in book:', openingName);
      return;
    }
    useCoachMemoryStore.getState().setIntendedOpening({
      name: openingName,
      color: playerColor,
      capturedFromSurface: 'url-or-resume',
    });
  }, [playerColor]);

  // Honor `?subject=` on mount once, so a dynamic session redirected
  // from /coach/session/play-against with ?subject=Sicilian seeds the
  // book moves as if the student had asked by voice. Skipped when
  // `?fen=` is set — a specific starting position overrides the
  // opening book (the student is jumping past the opening).
  const subjectAppliedRef = useRef(false);
  useEffect(() => {
    if (subjectAppliedRef.current) return;
    const seed = searchParams.get('opening') ?? subjectParam;
    if (!seed) return;
    if (initialGameFen) return;
    subjectAppliedRef.current = true;
    handleOpeningRequest(seed);
  }, [subjectParam, handleOpeningRequest, initialGameFen, searchParams]);

  // Resume a saved in-progress game from Dexie. Runs once on mount.
  // Only fires when the URL has no explicit game specifier (?fen,
  // ?review, ?subject, ?opening, ?side) — if the user is starting
  // something specific, we respect that over the saved snapshot.
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    const hasExplicitStart =
      searchParams.has('fen') ||
      searchParams.has('review') ||
      searchParams.has('subject') ||
      searchParams.has('opening') ||
      searchParams.has('side');
    if (hasExplicitStart) return;
    // Disabled by WO-CLEANUP-01 — resume produces ghost squares; see WO-RESUME-01 for rebuild.
    const RESUME_ENABLED = false;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!RESUME_ENABLED) return;
    void loadCoachPlayState().then((saved) => {
      if (!saved) return;
      // Only restore when we haven't made any moves yet (mount state).
      if (moveCountRef.current > 0) return;
      setDifficulty(saved.difficulty);
      setPlayerColor(saved.playerColor);
      const ok = game.loadFen(saved.fen);
      if (!ok) {
        // Saved FEN is corrupt — drop it and start fresh.
        void clearCoachPlayState();
        return;
      }
      if (saved.subject) {
        handleOpeningRequest(saved.subject);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active game on every board change so the next visit
  // resumes where we left off. Skipped while a review is loaded
  // (review mode has its own state path), while the game is done
  // (clearCoachPlayState runs in the game-over path instead), and
  // while no real moves have been played yet (writing a starting
  // position as a resumable snapshot buys us nothing and just wastes
  // a DB write on every mount).
  useEffect(() => {
    if (reviewMoves) return;
    if (gameState.status !== 'playing') return;
    if (game.isGameOver) return;
    if (gameState.moves.length === 0) return;
    void saveCoachPlayState({
      fen: game.fen,
      playerColor,
      difficulty,
      subject: subjectParam ?? null,
      halfMoveCount: moveCountRef.current,
      updatedAt: Date.now(),
    });
  }, [
    game.fen,
    game.isGameOver,
    reviewMoves,
    gameState.status,
    gameState.moves.length,
    playerColor,
    difficulty,
    subjectParam,
  ]);

  // Honor `?narrate=1` from the agent's start_play action. Flips
  // both the session-store narrationMode and the appStore voice
  // toggle so the existing per-move commentary path actually speaks.
  const narrationAppliedRef = useRef(false);
  useEffect(() => {
    if (narrationAppliedRef.current) return;
    if (searchParams.get('narrate') !== '1') return;
    narrationAppliedRef.current = true;
    useCoachSessionStore.getState().setNarrationMode(true);
    if (!useAppStore.getState().coachVoiceOn) {
      useAppStore.getState().toggleCoachVoice();
    }
  }, [searchParams]);

  // Publish the current route to the agent's session store so its
  // context snapshot reflects "user is on the play screen."
  useEffect(() => {
    useCoachSessionStore.getState().setCurrentRoute('/coach/play');
  }, []);

  // Subscribe to pending narration from the agent. When the LLM emits
  // [[ACTION:narrate {text:...}]] from another surface (e.g., chat
  // drawer), the dispatcher pushes onto the queue and the play view
  // mirrors it into status text. The dispatcher already calls
  // voiceService.speak(text) so we only handle the visual surface here.
  const pendingNarration = useCoachSessionStore((s) => s.pendingNarration);
  const consumeNarration = useCoachSessionStore((s) => s.consumeNarration);
  useEffect(() => {
    if (!pendingNarration) return;
    consumeNarration();
  }, [pendingNarration, consumeNarration]);

  // ─── Blunder Interception State ──────────────────────────────────────────
  const [blunderPause, setBlunderPause] = useState<{
    explanation: string;
    bestMoveSan: string;
    bestMoveUci: string;
    preFen: string;
    playerMoveSan: string;
  } | null>(null);
  const [moveFlash, setMoveFlash] = useState<'blunder' | 'inaccuracy' | 'good' | null>(null);
  // Single shared flash-clear timer. Without this, back-to-back flashes
  // (player move then coach reply) leak the first timer, which fires
  // during the second flash and clears it early.
  const flashClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerMoveFlash = useCallback((flash: 'blunder' | 'inaccuracy' | 'good') => {
    if (flashClearTimerRef.current !== null) {
      clearTimeout(flashClearTimerRef.current);
    }
    setMoveFlash(flash);
    flashClearTimerRef.current = setTimeout(() => {
      setMoveFlash(null);
      flashClearTimerRef.current = null;
    }, 900);
  }, []);
  useEffect(() => {
    return () => {
      if (flashClearTimerRef.current !== null) {
        clearTimeout(flashClearTimerRef.current);
      }
    };
  }, []);

  // Track whether voice mic is active (listening or streaming) to suppress tips
  const [voiceActive, setVoiceActive] = useState(false);

  // Resizable split between move list and chat panel (percentage for chat)
  const [chatPercent, setChatPercent] = useState(80);
  const rightColumnRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const handleDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  }, []);

  const handleDividerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !rightColumnRef.current) return;
    const rect = rightColumnRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const totalHeight = rect.height;
    const moveListPercent = Math.max(15, Math.min(75, (y / totalHeight) * 100));
    setChatPercent(Math.max(25, Math.min(85, 100 - moveListPercent)));
  }, []);

  const handleDividerPointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // Board annotation state (controlled by chat and voice)
  const [annotationArrows, setAnnotationArrows] = useState<BoardArrow[]>([]);
  const [voiceArrows, setVoiceArrows] = useState<BoardArrow[]>([]);
  const [annotationHighlights, setAnnotationHighlights] = useState<BoardHighlight[]>([]);
  const [temporaryFen, setTemporaryFen] = useState<string | null>(null);
  const [temporaryLabel, setTemporaryLabel] = useState<string | null>(null);

  // Practice position (reusable hook)
  const {
    practicePosition,
    practiceAttempts,
    handlePracticeMove: evaluatePracticeMove,
    exitPractice,
    setPracticeFromAnnotation,
  } = usePracticePosition();

  // Move sound: ChessBoard already plays the sound on user drag/click,
  // but coach moves are committed programmatically via game.makeMove
  // and bypass that path. Hook the same audio service here so coach
  // moves get the same audible cue as the student's. WO-COACH-OPPONENT-FX.
  const { playMoveSound } = usePieceSound();

  // Post-game practice bridge prompt
  const [pendingChatPrompt, setPendingChatPrompt] = useState<string | null>(null);

  // In-game chat transcript, hydrated from Dexie on mount so the
  // conversation survives reload / navigation. Previously lost
  // because GameChatPanel's internal useState was the only home for
  // messages — the component exposes initialMessages + onMessagesUpdate
  // hooks but CoachGamePage wasn't wiring them.
  const [initialChatMessages, setInitialChatMessages] = useState<ChatMessage[] | null>(null);
  useEffect(() => {
    void loadCoachPlayChat().then((msgs) => setInitialChatMessages(msgs));
  }, []);
  const handleChatMessagesUpdate = useCallback((messages: ChatMessage[]) => {
    // Persist every transcript change. saveCoachPlayChat bounds the
    // array at 200 messages internally and swallows DB errors.
    void saveCoachPlayChat(messages);
  }, []);

  // Settings-driven analysis toggles (user can override in-game)
  const { settings } = useSettings();
  const [evalBarOverride, setEvalBarOverride] = useState<boolean | null>(null);
  const [engineLinesOverride, setEngineLinesOverride] = useState<boolean | null>(null);
  const showEvalBarEffective = evalBarOverride ?? settings.showEvalBar;
  const showEngineLinesEffective = engineLinesOverride ?? settings.showEngineLines;

  // Evaluation tracking for eval bar
  const [latestEval, setLatestEval] = useState<number>(0);
  const [latestIsMate, setLatestIsMate] = useState(false);
  const [latestMateIn, setLatestMateIn] = useState<number | null>(null);
  const [latestTopLines, setLatestTopLines] = useState<AnalysisLine[]>([]);

  // Pre-computed engine snapshot for voice chat (avoids re-running Stockfish)
  const voiceEngineSnapshot: EngineSnapshot | null = useMemo(() => {
    if (latestTopLines.length === 0) return null;
    const bestLine = latestTopLines[0];
    const bestMoveUci = bestLine.moves.length > 0 ? bestLine.moves[0] : '';
    return {
      bestMove: bestMoveUci ? uciMoveToSan(bestMoveUci, game.fen) : '',
      evaluation: latestEval,
      isMate: latestIsMate,
      mateIn: latestMateIn,
      topLines: latestTopLines.slice(0, 3).map((l) => ({
        moves: [uciLinesToSan(l.moves, game.fen, 5)],
        evaluation: l.evaluation,
        mate: l.mate,
      })),
    };
  }, [latestTopLines, latestEval, latestIsMate, latestMateIn, game.fen]);

  // Last move context for voice chat (so users can ask "was that an inaccuracy?")
  const voiceLastMoveContext: LastMoveContext | null = useMemo(() => {
    if (gameState.moves.length === 0) return null;
    const last = gameState.moves[gameState.moves.length - 1];
    // bestMove is UCI from Stockfish for the pre-move position
    // Use previous move's FEN as pre-move FEN; for the first move, use starting position
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const preFen = gameState.moves.length >= 2
      ? gameState.moves[gameState.moves.length - 2].fen
      : START_FEN;
    let bestMoveSan: string | null = null;
    if (last.bestMove) {
      try { bestMoveSan = uciMoveToSan(last.bestMove, preFen); } catch { /* skip */ }
    }
    return {
      san: last.san,
      player: last.isCoachMove ? 'opponent' : 'you',
      classification: last.classification,
      evalBefore: last.preMoveEval,
      evalAfter: last.evaluation,
      bestMove: bestMoveSan,
    };
  }, [gameState.moves]);

  // 3-tier visual hint system (Stockfish-powered, no knownMove)
  const isPlayersTurn =
    (playerColor === 'white' && game.turn === 'w') ||
    (playerColor === 'black' && game.turn === 'b');
  const { hintState, requestHint, resetHints } = useHintSystem({
    fen: game.fen,
    playerColor,
    enabled: gameState.status === 'playing' && isPlayersTurn && !game.isGameOver,
  });

  // WO-LIVE-COACH-01: live-coach interjection driver. Receives per-move
  // analysis from this component's existing Stockfish pipeline (we do
  // NOT re-run the engine inside the hook) and dispatches LLM speech
  // when one of the five triggers fires.
  const liveCoach = useLiveCoach({
    gameId: gameState.gameId,
    playerColor,
  });

  // Inject nudge text into chat when it appears
  const prevNudgeRef = useRef<string | null>(null);
  useEffect(() => {
    if (hintState.nudgeText && hintState.nudgeText !== prevNudgeRef.current) {
      prevNudgeRef.current = hintState.nudgeText;
      gameChatRef.current?.injectAssistantMessage(hintState.nudgeText);
    }
  }, [hintState.nudgeText]);

  // ─── Plan tracker (Upgrade D) ──────────────────────────────────────────────
  // When the student declared an intendedOpening before sitting down to
  // play (e.g. "I want to play the Najdorf today"), watch the move list
  // and call out the moment they LEAVE the canonical PGN of that
  // opening. One-shot per game so we don't nag every move past the
  // divergence point. User: "D yes!" — highest-enthusiasm upgrade in
  // the Play with Coach helping-hand pass.
  const offBookFiredRef = useRef(false);
  useEffect(() => {
    if (offBookFiredRef.current) return;
    const intent = useCoachMemoryStore.getState().intendedOpening;
    if (!intent) return;
    const playedMoves = gameState.moves.map((m) => m.san);
    if (playedMoves.length === 0) return;
    const entry = resolveOpeningEntry(intent.name);
    if (!entry || entry.moves.length === 0) return;
    // Use the LONGEST canonical PGN under intent.name as the book —
    // gives the player the most theory before being called off-book.
    const allEntries = (() => {
      try {
        // findShortestCanonicalPgn isn't quite right here; we want the
        // deepest version of the user's declared opening. resolveOpeningEntry
        // returns the deepest match by default (longest PGN preferred on
        // exact-name ties), so entry.moves IS the deep book.
        return entry.moves;
      } catch {
        return entry.moves;
      }
    })();
    // Replay user's path against the book PGN. First divergence wins.
    let divergenceIdx = -1;
    for (let i = 0; i < playedMoves.length; i += 1) {
      if (i >= allEntries.length) break;
      // Same-side moves only: book[i] is the i-th ply played from the
      // start position; gameState.moves[i] is also the i-th ply.
      if (
        stripSanAnnotations(playedMoves[i]) !==
        stripSanAnnotations(allEntries[i])
      ) {
        divergenceIdx = i;
        break;
      }
    }
    // Only fire if the JUST-played move (last entry) is the divergence.
    // Prior moves matched the book; this one breaks it.
    if (
      divergenceIdx === playedMoves.length - 1 &&
      divergenceIdx >= 0 &&
      divergenceIdx < allEntries.length
    ) {
      offBookFiredRef.current = true;
      const movedSan = playedMoves[divergenceIdx];
      const bookSan = allEntries[divergenceIdx];
      const moveNumber = Math.floor(divergenceIdx / 2) + 1;
      const dotted = divergenceIdx % 2 === 0 ? `${moveNumber}.` : `${moveNumber}…`;
      const whoMoved = divergenceIdx % 2 === 0 ? 'White' : 'Black';
      const studentMoved = whoMoved.toLowerCase() === intent.color;
      const verb = studentMoved ? 'You' : `${whoMoved}`;
      const msg = studentMoved
        ? `Heads up — ${verb} just left ${entry.canonicalName} theory. The book here was ${dotted}${bookSan}, you played ${dotted}${movedSan}. Out of book.`
        : `${verb} deviated from the book ${entry.canonicalName} line at ${dotted}${movedSan} (theory was ${dotted}${bookSan}). You're on your own from here.`;
      gameChatRef.current?.injectAssistantMessage(msg);
      void logAppAudit({
        kind: 'coach-surface-migrated',
        category: 'subsystem',
        source: 'CoachGamePage.planTracker',
        summary: `off-book warning fired at ply ${divergenceIdx + 1} for "${entry.canonicalName}"`,
        details: `played=${movedSan}, book=${bookSan}, studentMoved=${studentMoved}`,
      });
    }
  }, [gameState.moves]);

  // Reset plan-tracker on new game so the warning fires once per game,
  // not once per app session.
  useEffect(() => {
    if (gameState.moves.length === 0) {
      offBookFiredRef.current = false;
    }
  }, [gameState.moves.length]);

  // ─── Coach Tip Bubble (floating overlay near board) ─────────────────────────
  const [tipBubbleText, setTipBubbleText] = useState<string | null>(null);
  const [tipTacticLine, setTipTacticLine] = useState<TacticLineData | null>(null);
  const [showingTacticLine, setShowingTacticLine] = useState(false);
  const tipBubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tacticAnimTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ─── Show Mode Step Navigation ─────────────────────────────────────────────
  const [showFens, setShowFens] = useState<string[]>([]);
  const [showIndex, setShowIndex] = useState<number>(-1);

  // ─── Explore Ahead Mode ────────────────────────────────────────────────────
  const [isExploreMode, setIsExploreMode] = useState(false);
  const [exploreFen, setExploreFen] = useState<string | null>(null);
  const [exploreMessages, setExploreMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [isExploreReacting, setIsExploreReacting] = useState(false);
  const [exploreEval, setExploreEval] = useState<number | null>(null);
  const [exploreIsMate, setExploreIsMate] = useState(false);
  const [exploreMateIn, setExploreMateIn] = useState<number | null>(null);
  const [exploreTopLines, setExploreTopLines] = useState<AnalysisLine[]>([]);
  const exploreChatRef = useRef<HTMLDivElement>(null);

  const clearTacticAnimation = useCallback(() => {
    tacticAnimTimersRef.current.forEach(clearTimeout);
    tacticAnimTimersRef.current = [];
  }, []);

  /** Auto-play interval ref for tactic line step-through */
  const tacticAutoPlayRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTacticAutoPlay = useCallback(() => {
    if (tacticAutoPlayRef.current) {
      clearInterval(tacticAutoPlayRef.current);
      tacticAutoPlayRef.current = null;
    }
  }, []);

  const showTipBubble = useCallback((text: string, tacticLine?: TacticLineData) => {
    if (tipBubbleTimerRef.current) clearTimeout(tipBubbleTimerRef.current);
    clearTacticAnimation();
    clearTacticAutoPlay();
    setTipBubbleText(text);
    setTipTacticLine(tacticLine ?? null);
    setShowingTacticLine(false);
    tipBubbleTimerRef.current = setTimeout(() => {
      setTipBubbleText(null);
      setTipTacticLine(null);
      setShowingTacticLine(false);
    }, 12000);
  }, [clearTacticAnimation, clearTacticAutoPlay]);

  /** Show button: build FEN array and auto-play through the tactic line */
  const handleShowTactic = useCallback(() => {
    if (!tipTacticLine) return;
    // Cancel auto-dismiss — user is actively viewing
    if (tipBubbleTimerRef.current) {
      clearTimeout(tipBubbleTimerRef.current);
      tipBubbleTimerRef.current = null;
    }
    setShowingTacticLine(true);
    clearTacticAnimation();
    clearTacticAutoPlay();

    try {
      const chess = new Chess(tipTacticLine.fen);
      const fens: string[] = [];
      for (const uci of tipTacticLine.uciMoves) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;
        chess.move({ from, to, promotion });
        fens.push(chess.fen());
      }

      setShowFens(fens);
      setShowIndex(0);
      setTemporaryFen(fens[0]);
      setTemporaryLabel('Tactic preview');

      // Auto-play through remaining moves at 800ms intervals
      if (fens.length > 1) {
        let step = 1;
        tacticAutoPlayRef.current = setInterval(() => {
          if (step >= fens.length) {
            clearTacticAutoPlay();
            return;
          }
          setShowIndex(step);
          setTemporaryFen(fens[step]);
          step++;
        }, 800);
      }
    } catch {
      // Fallback: just show the text notation
    }
  }, [tipTacticLine, clearTacticAnimation, clearTacticAutoPlay]);

  /** Step backward in the shown tactic line */
  const handleShowPrev = useCallback(() => {
    clearTacticAutoPlay();
    if (showIndex <= 0 || showFens.length === 0) return;
    const newIndex = showIndex - 1;
    setShowIndex(newIndex);
    setTemporaryFen(showFens[newIndex]);
  }, [showIndex, showFens, clearTacticAutoPlay]);

  /** Step forward in the shown tactic line */
  const handleShowNext = useCallback(() => {
    clearTacticAutoPlay();
    if (showIndex >= showFens.length - 1) return;
    const newIndex = showIndex + 1;
    setShowIndex(newIndex);
    setTemporaryFen(showFens[newIndex]);
  }, [showIndex, showFens, clearTacticAutoPlay]);

  /** Enter Explore Ahead mode from the current shown position */
  const handleEnterExplore = useCallback(() => {
    if (showFens.length === 0 || showIndex < 0) return;
    setIsExploreMode(true);
    const currentShowFen = showFens[showIndex];
    setExploreFen(currentShowFen);
    setExploreMessages([]);
    setExploreEval(null);
    setExploreIsMate(false);
    setExploreMateIn(null);
    setExploreTopLines([]);
    // Run initial engine analysis on the explore position
    void stockfishEngine.queueAnalysis(currentShowFen, 16).then((analysis) => {
      setExploreEval(analysis.evaluation);
      setExploreIsMate(analysis.isMate);
      setExploreMateIn(analysis.mateIn);
      setExploreTopLines(analysis.topLines);
    }).catch(() => { /* engine may be busy */ });
  }, [showFens, showIndex]);

  /** Handle a move made during Explore Ahead mode */
  const handleExploreMove = useCallback((moveResult: MoveResult) => {
    const newFen = moveResult.fen;
    setExploreFen(newFen);
    setTemporaryFen(newFen);

    // Run engine analysis on the new position
    void stockfishEngine.queueAnalysis(newFen, 16).then((analysis) => {
      setExploreEval(analysis.evaluation);
      setExploreIsMate(analysis.isMate);
      setExploreMateIn(analysis.mateIn);
      setExploreTopLines(analysis.topLines);

      // Fetch coach reaction with engine context
      setIsExploreReacting(true);
      const evalText = analysis.isMate
        ? `Mate in ${analysis.mateIn}`
        : `${analysis.evaluation > 0 ? '+' : ''}${(analysis.evaluation / 100).toFixed(1)}`;
      const bestMoveSan = analysis.topLines[0]?.moves[0] ?? 'unknown';

      const userMsg = `Position FEN: ${newFen}\nMove played: ${moveResult.san}\nStockfish eval after move: ${evalText}\nEngine best move: ${bestMoveSan}\nReact to this move in 1-2 sentences.`;

      // When the student arrived here via "let's play / yes let's do it",
      // prefix the reaction prompt with the agreed training focus so the
      // coach's commentary stays on-theme with the chat conversation.
      const systemPrompt = focusParam
        ? `${EXPLORE_REACTION_ADDITION}\n\nTraining focus for this game (carried over from the chat where the student agreed to play): ${focusParam}. Weave this focus into your reactions — praise moves that apply it, gently flag moves that miss it.`
        : EXPLORE_REACTION_ADDITION;

      // WO-COACH-UNIFY-01 commit 4: explore-reaction routes through
      // coachService.ask. Explore session messages aren't in the
      // long-term memory snapshot (they're transient UI state), so
      // we concat the prior chat into the ask. systemPrompt
      // (EXPLORE_REACTION_ADDITION + optional focus) becomes a
      // systemPromptAddition on the envelope. task='explore_reaction'
      // preserves the cheap-haiku / deepseek-chat routing.
      const priorChatBlock = exploreMessages.length > 0
        ? '\n\nPrior conversation in this explore session:\n' +
          exploreMessages.map((m) => `${m.role === 'user' ? 'Student' : 'You'}: ${m.content}`).join('\n')
        : '';
      const exploreFenSideToMove = newFen.split(' ')[1] === 'b' ? 'black' : 'white';
      void coachService.ask(
        {
          surface: 'game-chat',
          ask: `${userMsg}${priorChatBlock}`,
          liveState: {
            surface: 'game-chat',
            fen: newFen,
            userJustDid: `Played ${moveResult.san} in explore mode`,
            whoseTurn: exploreFenSideToMove,
          },
        },
        {
          task: 'explore_reaction',
          maxTokens: 256,
          maxToolRoundTrips: 1,
          systemPromptAddition: systemPrompt,
        },
      ).then((spineAnswer) => {
        const reaction = unwrapSpineError(spineAnswer.text);
        setExploreMessages((prev) => [
          ...prev,
          { role: 'user', content: userMsg },
          { role: 'assistant', content: reaction },
        ]);
        setIsExploreReacting(false);
      }).catch(() => {
        setIsExploreReacting(false);
      });
    }).catch(() => { /* engine may be busy */ });
  }, [exploreMessages, focusParam]);

  /** Dismiss tip and snap board back to the live position */
  const handleDismissTip = useCallback(() => {
    if (tipBubbleTimerRef.current) {
      clearTimeout(tipBubbleTimerRef.current);
      tipBubbleTimerRef.current = null;
    }
    clearTacticAnimation();
    setTipBubbleText(null);
    setTipTacticLine(null);
    setShowingTacticLine(false);
    setTemporaryFen(null);
    setTemporaryLabel(null);
    // Reset show step state
    setShowFens([]);
    setShowIndex(-1);
    // Reset explore state
    setIsExploreMode(false);
    setExploreFen(null);
    setExploreMessages([]);
    setIsExploreReacting(false);
    setExploreEval(null);
    setExploreIsMate(false);
    setExploreMateIn(null);
    setExploreTopLines([]);
  }, [clearTacticAnimation]);

  // Proactive coach tips (positional awareness, tactics, key moments)
  const handleCoachTip = useCallback((tip: string, tacticLine?: TacticLineData) => {
    gameChatRef.current?.injectAssistantMessage(tip);
    showTipBubble(tip, tacticLine);
  }, [showTipBubble]);

  // Missed tactic alert — coach tells player they missed a tactic and suggests takeback
  const handleMissedTactic = useCallback((message: string) => {
    gameChatRef.current?.injectAssistantMessage(message);
    showTipBubble(message);
  }, [showTipBubble]);

  useCoachTips({
    fen: game.fen,
    playerColor,
    isPlayerTurn: isPlayersTurn,
    enabled: coachTipsOn && !voiceActive && gameState.status === 'playing' && !game.isGameOver,
    moves: gameState.moves,
    playerRating: activeProfile?.currentRating ?? 1200,
    onTip: handleCoachTip,
    onMissedTactic: difficulty === 'hard' || !settings.coachMissedTacticTakeback ? undefined : handleMissedTactic,
    blunderAlerts: settings.coachBlunderAlerts,
    tacticAlerts: settings.coachTacticAlerts,
    positionalTips: settings.coachPositionalTips,
  });

  // Move navigation — null means live position
  const [viewedMoveIndex, setViewedMoveIndex] = useState<number | null>(null);

  const handleBackToGame = useCallback(() => {
    setTemporaryFen(null);
    setTemporaryLabel(null);
    setAnnotationArrows([]);
    setVoiceArrows([]);
    setAnnotationHighlights([]);
    exitPractice();
  }, [exitPractice]);

  const handleVoiceArrows = useCallback((arrows: BoardArrow[]) => {
    setVoiceArrows(arrows);
  }, []);

  const handleBoardAnnotation = useCallback((commands: BoardAnnotationCommand[]) => {
    // Collect all arrows and highlights from the full response so they accumulate
    const newArrows: BoardArrow[] = [];
    const newHighlights: BoardHighlight[] = [];
    let hasClear = false;
    let hasPractice = false;

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'arrow':
          newArrows.push(...(cmd.arrows ?? []));
          break;
        case 'highlight':
          newHighlights.push(...(cmd.highlights ?? []));
          break;
        case 'show_position':
          if (cmd.fen) {
            setTemporaryFen(cmd.fen);
            setTemporaryLabel(cmd.label ?? 'Analysis position');
          }
          break;
        case 'practice':
          hasPractice = true;
          break;
        case 'clear':
          hasClear = true;
          break;
      }
    }

    if (hasClear) {
      handleBackToGame();
    } else {
      if (hasPractice) setPracticeFromAnnotation(commands);
      if (newArrows.length > 0) setAnnotationArrows(newArrows);
      if (newHighlights.length > 0) setAnnotationHighlights(newHighlights);
    }
  }, [handleBackToGame, setPracticeFromAnnotation]);

  // Restart handler — resets board + game state back to the starting position
  // while keeping the current player color and difficulty. Used by the
  // Restart button and by the in-chat "restart the game" intent.
  // When the coach plays a variation, we snapshot the real-line FEN
  // BEFORE applying the first variation so return_to_game can snap
  // back. Cleared on restart (handleRestart) and whenever the student
  // lands back on the real position via return_to_game.
  const preVariationFenRef = useRef<string | null>(null);

  // Apply a what-if variation on command from the in-game chat coach:
  // rebuild the position by replaying the current move history minus
  // `undo` half-moves, then playing the supplied SAN moves forward.
  // Returns true on success; false on any illegal SAN / nothing to undo.
  // The coach can only invoke this via play_variation when the student
  // explicitly asks for a hypothetical — see coachPrompts.
  const handlePlayVariation = useCallback(
    ({ undo, moves }: { undo: number; moves: string[] }): boolean => {
      try {
        const sandbox = initialGameFen ? new Chess(initialGameFen) : new Chess();
        const currentHistory = game.history;
        const keep = Math.max(0, currentHistory.length - Math.max(0, undo));
        if (keep === currentHistory.length && moves.length === 0) {
          // Nothing requested — don't mutate the board.
          return false;
        }
        if (undo > currentHistory.length) {
          // Can't undo more than we've played.
          return false;
        }
        for (let i = 0; i < keep; i++) {
          const played = sandbox.move(currentHistory[i]);
          if (!played) return false;
        }
        for (const san of moves) {
          const played = sandbox.move(san);
          if (!played) return false;
        }
        // Snapshot the REAL-line FEN before we load the variation so
        // return_to_game can restore it. Capture only on the FIRST
        // variation of a session — subsequent variations shouldn't
        // overwrite the real-line anchor with another variation FEN.
        if (preVariationFenRef.current === null) {
          preVariationFenRef.current = game.fen;
        }
        return game.loadFen(sandbox.fen());
      } catch {
        return false;
      }
    },
    [game, initialGameFen],
  );

  // Snap the board back to the real game after exploring variations.
  // Returns false when the snapshot is empty (no variation in progress);
  // the dispatcher surfaces that as an error message to the LLM.
  const handleReturnToGame = useCallback((): boolean => {
    const saved = preVariationFenRef.current;
    if (!saved) return false;
    const ok = game.loadFen(saved);
    if (ok) preVariationFenRef.current = null;
    return ok;
  }, [game]);

  const handleRestart = useCallback((opts?: { keepRequestedOpening?: boolean }) => {
    // Explicit restart — drop the resumable snapshot so we don't
    // auto-load the abandoned game on next visit. Also clear the
    // pre-variation snapshot so return_to_game from a later chat
    // doesn't try to snap to a stale position from the old game.
    void clearCoachPlayState();
    preVariationFenRef.current = null;
    // Reset the phase-transition ledger so the new game can fire its
    // transitions fresh (WO-PHASE-NARRATION-01).
    phaseStateRef.current = createPhaseTransitionState();
    // Reset the introduced-openings tracker so the next opening gets
    // its long teaching intro again.
    openingIntroSpokenRef.current = false;
    // Cancel any pending coach quiz — its expectedSan refers to the
    // old position and won't match anything in the fresh game.
    cancelActiveQuizRef.current('game-restart');
    game.resetGame();
    moveCountRef.current = 0;
    setGameState({
      gameId: `game-${Date.now()}`,
      playerColor,
      targetStrength,
      moves: [],
      hintsUsed: 0,
      currentHintLevel: 0,
      takebacksUsed: 0,
      status: 'playing',
      result: 'ongoing',
      keyMoments: [],
    });
    setLatestEval(0);
    setLatestIsMate(false);
    setLatestMateIn(null);
    setViewedMoveIndex(null);
    // WO-COACH-MEMORY-UNIFY-01: memory persists across games. Do NOT
    // clear `intendedOpening` on restart — the coach keeps following
    // the named opening in the next game until the user explicitly
    // says "forget it" or "play anything". `opts.keepRequestedOpening`
    // is now a no-op flag retained for callers that pass it.
    void opts;
    resetHints();
    prevNudgeRef.current = null;
    handleBackToGame();
  }, [game, playerColor, targetStrength, handleBackToGame, resetHints]);

  // Color change handler — resets the game with the new color
  const handleColorChange = useCallback((color: 'white' | 'black') => {
    setPlayerColor(color);
    game.resetGame();
    moveCountRef.current = 0;
    setGameState({
      gameId: `game-${Date.now()}`,
      playerColor: color,
      targetStrength,
      moves: [],
      hintsUsed: 0,
      currentHintLevel: 0,
      takebacksUsed: 0,
      status: 'playing',
      result: 'ongoing',
      keyMoments: [],
    });
    setLatestEval(0);
    setLatestIsMate(false);
    setLatestMateIn(null);
    setViewedMoveIndex(null);
    // WO-COACH-MEMORY-UNIFY-01: memory persists across color changes
    // too. The user can switch sides and still want the same opening
    // repertoire — a Caro-Kann player will happily play the White side
    // of a position they just defended. Opening validity for the new
    // color is enforced inside `local_opening_book` (which returns
    // null when it isn't the AI's book turn), so the brain naturally
    // falls back to Stockfish when sides flip.
    resetHints();
    prevNudgeRef.current = null;
    handleBackToGame();
  }, [game, targetStrength, handleBackToGame, resetHints]);

  // Move navigation handlers
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const goToFirstMove = useCallback(() => {
    if (gameState.moves.length === 0) return;
    setViewedMoveIndex(-1);
    handleBackToGame();
  }, [gameState.moves.length, handleBackToGame]);

  const goToPrevMove = useCallback(() => {
    if (gameState.moves.length === 0) return;
    setViewedMoveIndex((prev) => {
      if (prev === null) return gameState.moves.length - 2;
      return Math.max(-1, prev - 1);
    });
    handleBackToGame();
  }, [gameState.moves.length, handleBackToGame]);

  const goToNextMove = useCallback(() => {
    if (gameState.moves.length === 0) return;
    setViewedMoveIndex((prev) => {
      if (prev === null) return null;
      if (prev >= gameState.moves.length - 1) return null;
      return prev + 1;
    });
  }, [gameState.moves.length]);

  const goToLastMove = useCallback(() => {
    setViewedMoveIndex(null);
  }, []);

  // Compute the displayed FEN based on navigation state
  const displayFen = practicePosition?.fen
    ?? temporaryFen
    ?? (viewedMoveIndex !== null
      ? (viewedMoveIndex === -1 ? START_FEN : gameState.moves[viewedMoveIndex]?.fen ?? game.fen)
      : game.fen);

  // Opening detection — recalculated when move history changes
  const detectedOpening = useMemo<DetectedOpening | null>(
    () => detectOpening(game.history),
    [game.history],
  );

  // Position narration — "Read this position" button on the play screen.
  const positionNarration = usePositionNarration({
    fen: game.fen,
    pgn: game.history.join(' '),
    moveNumber: moveCountRef.current,
    playerColor,
    openingName: detectedOpening?.name ?? null,
  });

  const handleReadPosition = useCallback(() => {
    void positionNarration.narrate();
  }, [positionNarration]);

  // Phase-transition narration — fires at most twice per game
  // (opening→middlegame, middlegame→endgame) per WO-PHASE-NARRATION-01.
  // The detector ledger resets when a new game starts (see handleRestart
  // / play-again paths). Using a ref so mutations don't trigger renders.
  const phaseStateRef = useRef<PhaseTransitionState>(createPhaseTransitionState());
  const phaseNarration = usePhaseNarration({
    getPgn: () => game.history.join(' '),
    getOpeningName: () => detectedOpening?.name ?? null,
  });

  // Fire phase-transition narration when the student's move completes a
  // phase boundary. Gates (WO-PHASE-NARRATION-01):
  //   - Only fires when the most recent move is the student's (coach
  //     moves don't trigger; the detector also enforces this).
  //   - Never fires when verbosity is 'off'.
  //   - Never fires when a blunder alert is active or pending — the
  //     blunder wins priority and the transition is marked fired so
  //     it won't retry later in the game.
  //   - Never fires while the "Read this position" narration is in
  //     flight — user-triggered narration wins.
  // Every detection (fired or suppressed) is logged via logAppAudit so
  // we have a tuning trail without debug-mode toggles.
  useEffect(() => {
    const lastMove = gameState.moves[gameState.moves.length - 1];
    // WO-PHASE-FIX-02 temporary devtools instrumentation — remove once
    // Dave reproduces and we diagnose. Prefixed [PHASE-*] for easy
    // devtools filtering / later grep-and-remove.
    console.log('[PHASE-01] detection effect fired', {
      movesLength: gameState.moves.length,
      status: gameState.status,
      blunderPauseActive: gameState.status === 'blunder_pause' || blunderPause !== null,
      positionNarrating: positionNarration.isNarrating,
      phaseNarrationVerbosity:
        useAppStore.getState().activeProfile?.preferences.phaseNarrationVerbosity ?? 'standard',
      ledger: { ...phaseStateRef.current },
      lastMove: lastMove
        ? { san: lastMove.san, moveNumber: lastMove.moveNumber, isCoachMove: lastMove.isCoachMove }
        : null,
    });
    if (!lastMove) {
      console.log('[PHASE-02] skipped: no lastMove (moves array empty)');
      return;
    }
    if (lastMove.isCoachMove) {
      console.log('[PHASE-02] skipped: was coach move, not student move');
      // Full-trail audit (WO-PHASE-FIX-02): every time the effect fires
      // we record what it saw, so a silent-detector regression never
      // vanishes into a gap. Coach moves get a lightweight entry.
      void logAppAudit({
        kind: 'phase-transition-suppressed',
        category: 'subsystem',
        source: 'CoachGamePage.phaseTransition',
        summary: `skipped: coach move (ply ${lastMove.moveNumber})`,
        details: JSON.stringify({ reason: 'coach-move', san: lastMove.san }),
      });
      return;
    }

    const diag = phaseTransitionDiagnostic(lastMove, phaseStateRef.current, playerColor);
    const event = detectPhaseTransition(lastMove, phaseStateRef.current, playerColor);
    console.log('[PHASE-03] detector result:', event ? { ...event, diag } : { event: null, diag });

    if (!event) {
      console.log('[PHASE-02] skipped: detector returned null');
      // WO-PHASE-FIX-03: summary now shows which of the 4 rules are
      // close to firing so a silent game is diagnosable at a glance.
      void logAppAudit({
        kind: 'phase-transition-suppressed',
        category: 'subsystem',
        source: 'CoachGamePage.phaseTransition',
        summary:
          `no-fire: move ${diag.san} (fullMove=${diag.fullMoveNumber}, ` +
          `developed=${diag.developedMinors.total}/8 [w${diag.developedMinors.white} b${diag.developedMinors.black}], ` +
          `castled=${diag.studentCastled}, rooks=${diag.studentRooksOnBackRank}, ` +
          `majorCaptured=${diag.majorPieceCaptured})`,
        details: JSON.stringify(diag),
        fen: lastMove.fen,
      });
      return;
    }

    const verbosity: PhaseNarrationVerbosity =
      useAppStore.getState().activeProfile?.preferences.phaseNarrationVerbosity ?? 'standard';
    const blunderActive =
      gameState.status === 'blunder_pause' || blunderPause !== null;

    if (verbosity === 'off' || blunderActive || positionNarration.isNarrating) {
      const reason = verbosity === 'off'
        ? 'verbosity-off'
        : blunderActive
          ? 'blunder-priority'
          : 'position-narration-active';
      console.log('[PHASE-02] skipped:', reason);
      void logAppAudit({
        kind: 'phase-transition-suppressed',
        category: 'subsystem',
        source: 'CoachGamePage.phaseTransition',
        summary: `suppressed: ${event.kind} (${reason})`,
        details: JSON.stringify({ ...event, reason, verbosity }),
        fen: event.fen,
      });
      return;
    }

    console.log('[PHASE-04] dispatching phase narration', { kind: event.kind, verbosity });
    // Detection success — dedicated kind so Dave can filter the audit
    // log for 'phase-transition-detected' and see exactly when/where
    // each boundary fired. Narration voice is traced separately via
    // the 'voice-speak-invoked' audit from WO-LEGACY-VOICE-01.
    void logAppAudit({
      kind: 'phase-transition-detected',
      category: 'subsystem',
      source: 'CoachGamePage.phaseTransition',
      summary: `${event.kind} at move ${event.moveNumber} ${event.triggeringMoveSan}`,
      details: JSON.stringify({ ...event, verbosity }),
      fen: event.fen,
    });
    void phaseNarration.narrate(event, verbosity);
    // Dependencies: we watch moves.length so this fires exactly once
    // per new move. blunderPause + status are read inside the effect
    // via live reads — deliberate, so the guard always reflects the
    // current truth at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.moves.length]);

  // Captured pieces — recalculated when FEN changes
  const capturedPieces = useMemo(
    () => getCapturedPieces(game.fen),
    [game.fen],
  );

  // WO-AUDIT-CYCLE-8: who made the most recent move? Threads into
  // the chat / voice intent routers so phrases like "take back your
  // move" / "take back my move" resolve to the right ply count
  // (1 if the named side is the most-recent mover, 2 otherwise).
  const lastMoveBy = useMemo<'user' | 'coach' | undefined>(() => {
    if (gameState.moves.length === 0) return undefined;
    const last = gameState.moves[gameState.moves.length - 1];
    return last.isCoachMove ? 'coach' : 'user';
  }, [gameState.moves]);
  const materialAdv = useMemo(
    () => getMaterialAdvantage(game.fen),
    [game.fen],
  );

  // Resign handler
  const handleResign = useCallback(() => {
    const keyMoments = findKeyMoments(gameState.moves);
    setGameState((prev) => ({
      ...prev,
      status: 'postgame',
      result: 'loss',
      keyMoments,
    }));
  }, [gameState.moves]);

  // Inject coach message into the Game Chat panel (hints, takeback msgs)
  const coachSay = useCallback((text: string): void => {
    gameChatRef.current?.injectAssistantMessage(text);
  }, []);

  // Check for game over — transition to 'gameover' first to show final position
  useEffect(() => {
    if (game.isGameOver && gameState.status === 'playing') {
      const result: 'win' | 'loss' | 'draw' = game.isCheckmate
        ? (game.turn === 'w' && playerColor === 'white' ? 'loss' : 'win')
        : 'draw';

      const keyMoments = findKeyMoments(gameState.moves);

      // Show the final board position with game-over overlay before transitioning
      setGameState((prev) => ({
        ...prev,
        status: 'gameover',
        result,
        keyMoments,
      }));

      // Save game to DB
      const playerWon = result === 'win';
      const playerLost = result === 'loss';
      const pgnResult: GameResult = playerColor === 'white'
        ? (playerWon ? '1-0' : playerLost ? '0-1' : '1/2-1/2')
        : (playerWon ? '0-1' : playerLost ? '1-0' : '1/2-1/2');
      const tags: string[] = [difficulty === 'hard' ? 'Hard' : '', gameState.hintsUsed === 0 ? 'NoHints' : ''].filter(Boolean);

      const annotations = movesToAnnotations(gameState.moves, playerColor);
      const summary = buildAnalysisSummary(gameState.moves, keyMoments, playerColor, result);

      const playerName = activeProfile?.name ?? 'Player';
      const gameRecord = {
        id: gameState.gameId,
        pgn: game.history.join(' '),
        white: playerColor === 'white' ? playerName : 'Stockfish Bot',
        black: playerColor === 'black' ? playerName : 'Stockfish Bot',
        result: pgnResult,
        date: new Date().toISOString().split('T')[0],
        event: `Coach Game ${tags.join(' ')}`.trim(),
        eco: detectedOpening?.eco ?? null,
        whiteElo: playerColor === 'white' ? playerRating : targetStrength,
        blackElo: playerColor === 'black' ? playerRating : targetStrength,
        source: 'coach' as const,
        annotations,
        coachAnalysis: JSON.stringify(summary),
        isMasterGame: false,
        openingId: detectedOpening?.name ?? null,
      };

      void db.games.add(gameRecord).then(() => {
        if (!activeProfile) return;

        // Detect bad habits from game moves
        void detectBadHabitsFromGame(gameState.moves, activeProfile);

        // Generate mistake puzzles and refresh weakness profile
        void generateMistakePuzzlesFromGame(gameRecord.id).then(() => {
          // Refresh weakness profile with new game data and generated puzzles
          void computeWeaknessProfile(activeProfile);
        });

      });
    }
  }, [game.isGameOver, game.isCheckmate, game.turn, gameState.status, gameState.moves, playerColor, difficulty, gameState.hintsUsed, gameState.gameId, game.history, activeProfile, playerRating, targetStrength, setActiveProfile, detectedOpening]);

  // Auto-transition from gameover overlay to postgame review after showing final position
  useEffect(() => {
    if (gameState.status !== 'gameover') return;
    // Clear the resumable snapshot once the game actually ends so we
    // don't auto-restore a finished position on the next visit.
    void clearCoachPlayState();
    const timer = setTimeout(() => {
      setGameState((prev) => ({ ...prev, status: 'postgame' }));
    }, 3500);
    return () => clearTimeout(timer);
  }, [gameState.status]);

  // Coach makes a move when it's their turn.
  // Uses an AbortController (not a ref guard) to handle React strict-mode
  // double-invocation and dependency-change re-runs safely.
  useEffect(() => {
    const isCoachTurn =
      gameState.status === 'playing' &&
      !game.isGameOver &&
      ((playerColor === 'white' && game.turn === 'b') ||
       (playerColor === 'black' && game.turn === 'w'));

    if (!isCoachTurn) return;

    setIsCoachThinking(true);
    const abortController = new AbortController();
    const isCancelled = (): boolean => abortController.signal.aborted;

    const applyCoachMove = (
      result: MoveResult,
      evaluation: number,
      preMoveEval: number | null = null,
      bestMove: string | null = null,
    ): void => {
      moveCountRef.current += 1;

      const coachMove: CoachGameMove = {
        moveNumber: moveCountRef.current,
        san: result.san,
        fen: result.fen,
        isCoachMove: true,
        commentary: '',
        evaluation,
        classification: null,
        expanded: false,
        bestMove,
        bestMoveEval: null,
        preMoveEval,
      };

      setCoachLastMove({ from: result.from, to: result.to });
      // WO-COACH-OPPONENT-FX: emit the move/capture sound + an audit
      // marker so we can verify in the audit log that this fired. The
      // student gets the same sound on their own moves via ChessBoard's
      // drag/click handlers; this closes the gap for coach moves.
      playMoveSound(result.san);
      void logAppAudit({
        kind: 'coach-move-fx-emitted',
        category: 'subsystem',
        source: 'CoachGamePage.applyCoachMove',
        summary: `san=${result.san} from=${result.from} to=${result.to}`,
      });
      setGameState((prev) => ({
        ...prev,
        moves: [...prev.moves, coachMove],
      }));
      // Narrate the coach's move when narration mode is on. Coach moves
      // almost never have LLM commentary attached — applyCoachMove
      // doesn't run the LLM on the engine's side — so narrateMove
      // typically returns early with reason=empty-commentary. We used
      // to call voiceService.stop() unconditionally before narrateMove
      // to prevent overlap, but that clipped the student's in-flight
      // narration about THEIR last move every time the coach replied
      // (~5s into a 50-90s narration), which was the user-reported
      // "narration keeps getting cut off" symptom. WO-NARR-POLICY-01:
      // let voiceService.speak handle interruption itself — it already
      // stops the previous utterance before starting a new one — and
      // only when narrateMove actually produces speech.
      const coachSide: 'w' | 'b' = playerColor === 'white' ? 'b' : 'w';
      narrateMove({
        san: result.san,
        mover: coachSide,
        playerColor: playerColor === 'white' ? 'w' : 'b',
      });
    };

    const tryMakeMove = (moveUci: string): MoveResult | null => {
      const from = moveUci.slice(0, 2);
      const to = moveUci.slice(2, 4);
      const promotion = moveUci.length > 4 ? moveUci[4] : undefined;
      return game.makeMove(from, to, promotion);
    };

    const makeCoachMove = async (): Promise<void> => {
      if (isCancelled()) return;

      try {
        console.log('[CoachGame] Coach thinking... FEN:', game.fen);

        // Sanity guard: verify chess.js ACTUALLY agrees it's AI's turn
        // before any engine / book call. React-state derived `game.turn`
        // can lag the real chess instance during rapid move sequences,
        // and without this check a stale effect firing could hand
        // Stockfish the user's side — letting the AI play BOTH sides.
        const fenTurn = game.fen.split(' ')[1] as 'w' | 'b' | undefined;
        const aiColor = playerColor === 'white' ? 'black' : 'white';
        const aiTurnChar = aiColor === 'white' ? 'w' : 'b';
        if (fenTurn !== aiTurnChar) {
          console.warn('[CoachGame] Abort — FEN says', fenTurn, 'but AI is', aiColor);
          return;
        }

        // ── WO-BRAIN-04 (post-tightening) — BRAIN OWNS MOVE SELECTION ──
        // The deterministic hybrid (book + Stockfish, then optional
        // brain override) is gone. The brain consults
        // `local_opening_book` and / or `stockfish_eval` itself and
        // emits `play_move`; `onPlayMove` validates the SAN against
        // the live FEN and records the choice in `brainPickSan`. The
        // pre-move Stockfish eval below is purely informational —
        // eval bar, move classification, opponent-threat scan — and
        // does NOT pick the move. If the brain fails to emit
        // `play_move` (network error, parse miss, illegal SAN), the
        // safety fallback is a random legal move so the game never
        // freezes.
        const preAnalysisPromise: Promise<StockfishAnalysis> = stockfishEngine
          .analyzePosition(game.fen, 10)
          .catch(() => ({
            bestMove: '',
            evaluation: 0,
            isMate: false,
            mateIn: null,
            depth: 0,
            topLines: [],
            nodesPerSecond: 0,
          }));

        let brainPickSan: string | null = null;
        const intendedOpeningName = useCoachMemoryStore.getState().intendedOpening?.name ?? null;
        // WO-COACH-MATE-FLOOR: pre-seed the LLM with Stockfish's
        // bestmove + eval so it has a strong nudge from the start.
        // The post-move floor below catches obvious mate-walks; this
        // reduces how often the floor has to fire.
        const seededAnalysis = await Promise.race([
          preAnalysisPromise,
          new Promise<StockfishAnalysis | null>((resolve) =>
            setTimeout(() => resolve(null), 2_000),
          ),
        ]);
        const engineHint = seededAnalysis && seededAnalysis.bestMove
          ? ` Engine analysis at depth ${seededAnalysis.depth}: bestmove ${seededAnalysis.bestMove}, eval ${(seededAnalysis.evaluation / 100).toFixed(2)}. Use this as your primary signal — deviations are fine for variety at the student's rating, but never walk into a forced mate.`
          : '';
        const moveSelectorAsk = intendedOpeningName
          ? `It is your turn (${aiColor}). The student is rated about ${targetStrength} and has committed to ${intendedOpeningName}. Consult local_opening_book first; if we are still in book, play that move via play_move. If we are out of book, use stockfish_eval and pick a move calibrated to the student's rating, then play it via play_move.${engineHint}`
          : `It is your turn (${aiColor}). The student is rated about ${targetStrength}. Use stockfish_eval if you want depth, then pick a move calibrated to the student's rating and play it via play_move.${engineHint}`;
        const moveSelectorLiveState: LiveState = {
          surface: 'move-selector',
          fen: game.fen,
          moveHistory: game.history,
          currentRoute: '/coach/play',
          userJustDid: 'pondering coach move',
        };
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'CoachGamePage.makeCoachMove',
          summary: `surface=move-selector viaSpine=true intent=${intendedOpeningName ?? 'none'}`,
          details: JSON.stringify({
            surface: 'move-selector',
            viaSpine: true,
            intendedOpening: intendedOpeningName,
            plyCount: game.history.length,
            targetStrength,
          }),
          fen: game.fen,
        });
        // ── WO-PLAN-B fast path: Stockfish + opening book directly ──
        // The LLM spine spent ~8 seconds making 3 tool round-trips
        // (local_opening_book → stockfish_eval → play_move) when all
        // it actually does is route data the engine already has. Skip
        // it for routine moves: pick the opening-book move when the
        // student's intended opening is set + we're still in book,
        // otherwise pick Stockfish's best move at the strength
        // calibrated to the student's rating. Both run in <250ms.
        // The full LLM spine still acts as a fallback if the fast
        // path fails to produce a legal move.
        if (intendedOpeningName) {
          try {
            const bookMoves = getOpeningMoves(intendedOpeningName);
            if (bookMoves && game.history.length < bookMoves.length) {
              const next = bookMoves[game.history.length];
              const probe = new Chess(game.fen);
              if (probe.move(next)) {
                brainPickSan = next;
                void logAppAudit({
                  kind: 'coach-move-fastpath',
                  category: 'subsystem',
                  source: 'CoachGamePage.coachTurn.fastpath',
                  summary: `book: ${next} (${intendedOpeningName} ply ${game.history.length})`,
                  fen: game.fen,
                });
              }
            }
          } catch {
            /* fall through */
          }
        }
        if (!brainPickSan) {
          try {
            const config = resolvePlayConfig(difficulty, playerRating);
            const uciResult = await withTimeout(
              stockfishEngine.getBestMove(game.fen, config.moveTimeMs),
              Math.max(2_000, config.moveTimeMs + 1_000),
              'fastpath-bestmove',
            );
            if (uciResult.ok && uciResult.value) {
              const probe = new Chess(game.fen);
              const result = probe.move({
                from: uciResult.value.slice(0, 2),
                to: uciResult.value.slice(2, 4),
                promotion: uciResult.value.length > 4 ? uciResult.value.slice(4, 5) : undefined,
              });
              if (result) {
                brainPickSan = result.san;
                void logAppAudit({
                  kind: 'coach-move-fastpath',
                  category: 'subsystem',
                  source: 'CoachGamePage.coachTurn.fastpath',
                  summary: `stockfish: ${result.san} at strength ${targetStrength} (skill ${config.skill}, ${config.moveTimeMs}ms)`,
                  fen: game.fen,
                });
              }
            }
          } catch {
            /* fall through to spine */
          }
        }

        // WO-COACH-RESILIENCE — three-tier fallback chain so the
        // coach never hangs mid-game. PR #344 shipped audit-kind
        // names without implementation; this is the real layer.
        // Primary 15 s → Level 1 stockfish-bypass 10 s → Level 2
        // LLM-only 8 s → Level 3 deterministic legal move.
        const askInput = {
          surface: 'move-selector' as const,
          ask: moveSelectorAsk,
          liveState: moveSelectorLiveState,
        };
        // Spine fallback path — only runs when the fast path above
        // didn't produce a legal move (rare: Stockfish hung, no book
        // move available + Stockfish errored, etc.)
        const onPlayMoveCallback = (san: string): { ok: boolean; reason?: string } => {
          // Validate against the live FEN. The play_move tool already
          // validated, but board state may have shifted between
          // turns; double-check.
          try {
            const probe = new Chess(game.fen);
            const result = probe.move(san);
            if (!result) return { ok: false, reason: 'illegal at apply time' };
            brainPickSan = san;
            return { ok: true };
          } catch (err) {
            return {
              ok: false,
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        };
        // WO-COACH-PERSONALITIES (PR B): thread the user's personality
        // + dial settings into every coach-turn ask. Defaults preserve
        // the original Danya prompt verbatim — no behavior change for
        // profiles that haven't opted in.
        const prefs = useAppStore.getState().activeProfile?.preferences;
        const baseOptions = {
          maxToolRoundTrips: 3,
          onPlayMove: onPlayMoveCallback,
          personality: prefs?.coachPersonality,
          profanity: prefs?.coachProfanity,
          mockery: prefs?.coachMockery,
          flirt: prefs?.coachFlirt,
          verbosity: prefs?.coachResponseLength,
          // Teach mode: route the same coach-turn ask through Sonnet
          // instead of DeepSeek for richer commentary + deeper line
          // explanations. Stockfish stays as the opponent; only the
          // narration brain swaps. Play mode keeps the cheaper
          // DeepSeek default.
          ...(surfaceMode === 'teach' ? { providerOverride: anthropicProvider } : {}),
        };

        if (!brainPickSan) try {
          // Primary: full toolbelt, 15 s budget.
          const primary = await withTimeout(
            coachService.ask(askInput, baseOptions),
            15_000,
            'coach-turn-ask',
          );
          if (!primary.ok) {
            // Level 1 — Stockfish bypass.
            void logAppAudit({
              kind: 'coach-move-stockfish-bypassed',
              category: 'subsystem',
              source: 'CoachGamePage.coachTurn',
              summary: 'primary ask timed out, retrying without stockfish_eval',
              fen: game.fen,
            });
            const lvl1 = await withTimeout(
              coachService.ask(askInput, {
                ...baseOptions,
                excludeTools: ['stockfish_eval'],
              }),
              10_000,
              'coach-move-stockfish-bypassed',
            );
            if (!lvl1.ok && !brainPickSan) {
              // Level 2 — pure-LLM, no data tools.
              const llmOnlyAsk =
                moveSelectorAsk +
                "\n\nEngine and database are unavailable. Play a sensible move at this student's level using your own chess knowledge. Use the play_move tool.";
              void logAppAudit({
                kind: 'coach-move-llm-fallback',
                category: 'subsystem',
                source: 'CoachGamePage.coachTurn',
                summary: 'level 1 also timed out, retrying with LLM only (no data tools)',
                fen: game.fen,
              });
              const lvl2 = await withTimeout(
                coachService.ask(
                  { ...askInput, ask: llmOnlyAsk },
                  {
                    ...baseOptions,
                    excludeTools: [
                      'stockfish_eval',
                      'lichess_opening_lookup',
                      'lichess_master_games',
                      'lichess_puzzle_fetch',
                      'local_opening_book',
                    ],
                  },
                ),
                8_000,
                'coach-move-llm-fallback',
              );
              if (!lvl2.ok && !brainPickSan) {
                // Level 3 — deterministic emergency pick.
                const emergencySan = emergencyPickMove(game.fen, game.history);
                void logAppAudit({
                  kind: 'coach-move-emergency-pick',
                  category: 'subsystem',
                  source: 'CoachGamePage.coachTurn',
                  summary: `level 2 also timed out, deterministic pick=${emergencySan ?? 'null'}`,
                  fen: game.fen,
                });
                if (emergencySan) {
                  brainPickSan = emergencySan;
                }
              }
            }
          }
        } catch (err: unknown) {
          console.warn('[CoachGame] move-selector spine call failed:', err);
        }

        if (isCancelled()) return;

        // Convert the brain's SAN to UCI for tryMakeMove. If the brain
        // emitted no play_move (or an illegal one), fall back to a
        // random legal move so the game never freezes.
        //
        // WO-COACH-MATE-FLOOR: hard safety check. Audit cycle 9 caught
        // the coach walking into Scholar's Mate as Black at move 5
        // because the LLM's pick wasn't validated against the engine.
        // Run a quick Stockfish probe on the position AFTER the LLM's
        // pick — if the student has mate-in-≤-2 from that position,
        // override with the engine's bestmove. Cheap (depth 8, 1500ms
        // budget) compared to the cost of letting the coach get mated
        // mid-tutorial.
        if (brainPickSan && seededAnalysis && seededAnalysis.bestMove) {
          try {
            const probe = new Chess(game.fen);
            const probedMove = probe.move(brainPickSan);
            if (probedMove) {
              const fenAfter = probe.fen();
              const mateProbe = await withTimeout(
                stockfishEngine.analyzePosition(fenAfter, 8),
                1_500,
                'coach-mate-floor',
              );
              if (mateProbe.ok) {
                const post = mateProbe.value;
                // Two-tier veto:
                //
                //   Mate floor (universal, all ratings): if the student
                //   has mate-in-≤-2 from this position, override.
                //   Audit cycle 9 caught Scholar's Mate at move 5 — even
                //   beginner students shouldn't watch the coach get
                //   instamated.
                //
                //   Quality floor (rating-tier, WO-COACH-RATING-FLOOR):
                //   compare the coach's eval after the LLM's pick to
                //   the eval if it had played the engine bestmove. If
                //   cp loss exceeds the student's rating threshold,
                //   override. Lower-rated students get a higher cp-loss
                //   tolerance so the coach can blunder for them; higher-
                //   rated students get a tighter floor so they get
                //   sharper play.
                //
                //   Stockfish reports `evaluation` and `mateIn` from
                //   the side-to-move's perspective. The probe is at
                //   FEN-after where side-to-move = student, so `post`
                //   is from student's perspective. To get coach's view,
                //   flip the sign.
                let vetoReason: string | null = null;
                let auditKind: 'coach-move-mate-floor-triggered' | 'coach-move-quality-floor-triggered' =
                  'coach-move-mate-floor-triggered';
                let auditDetails: Record<string, unknown> = {};

                if (
                  enforceMateFloor(targetStrength) &&
                  post.isMate &&
                  post.mateIn !== null &&
                  post.mateIn > 0 &&
                  post.mateIn <= 2
                ) {
                  vetoReason = `student mate-in-${post.mateIn}`;
                  auditKind = 'coach-move-mate-floor-triggered';
                  auditDetails = {
                    llmPickSan: brainPickSan,
                    mateIn: post.mateIn,
                    override: seededAnalysis.bestMove,
                    rating: targetStrength,
                    fenBefore: game.fen,
                    fenAfter,
                  };
                } else if (!post.isMate) {
                  // Quality floor — only meaningful when neither side
                  // has a forced mate (otherwise mate dominates and the
                  // cp comparison is degenerate).
                  const maxCpLoss = maxCpLossFor(targetStrength);
                  if (Number.isFinite(maxCpLoss)) {
                    const coachEvalAfter = -post.evaluation;
                    const coachEvalIfBest = seededAnalysis.evaluation;
                    const cpLoss = coachEvalIfBest - coachEvalAfter;
                    if (cpLoss > maxCpLoss) {
                      vetoReason = `cpLoss=${cpLoss.toFixed(0)} > tier=${maxCpLoss} for rating ${targetStrength}`;
                      auditKind = 'coach-move-quality-floor-triggered';
                      auditDetails = {
                        llmPickSan: brainPickSan,
                        targetStrength,
                        maxCpLoss,
                        cpLoss: Math.round(cpLoss),
                        coachEvalIfBest,
                        coachEvalAfter,
                        override: seededAnalysis.bestMove,
                        fenBefore: game.fen,
                        fenAfter,
                      };
                    }
                  }
                }

                if (vetoReason) {
                  void logAppAudit({
                    kind: auditKind,
                    category: 'subsystem',
                    source: 'CoachGamePage.coachTurn',
                    summary: `LLM picked ${brainPickSan} → ${vetoReason}; overriding with engine bestmove ${seededAnalysis.bestMove}`,
                    details: JSON.stringify(auditDetails),
                    fen: game.fen,
                  });
                  // Convert engine bestmove (UCI) into SAN for re-validation
                  // through the same probe path below.
                  try {
                    const overrideProbe = new Chess(game.fen);
                    const overrideMove = overrideProbe.move({
                      from: seededAnalysis.bestMove.slice(0, 2),
                      to: seededAnalysis.bestMove.slice(2, 4),
                      promotion: seededAnalysis.bestMove.length > 4
                        ? seededAnalysis.bestMove.slice(4, 5)
                        : undefined,
                    });
                    if (overrideMove) {
                      brainPickSan = overrideMove.san;
                    }
                  } catch {
                    // If we can't convert the engine bestmove, leave
                    // brainPickSan as-is — at least the audit logged it
                    // and the user can see the floor fired.
                  }
                }
              }
            }
          } catch {
            // Probe failed (Stockfish hang, illegal state) — fall
            // through with the LLM's original pick. The floor is a
            // best-effort safety net, not a hard requirement.
          }
        }

        let move: string | null = null;
        if (brainPickSan) {
          try {
            const probe = new Chess(game.fen);
            const m = probe.move(brainPickSan);
            if (m) {
              const promo = m.promotion ?? '';
              move = `${m.from}${m.to}${promo}`;
            }
          } catch {
            /* fall through to random fallback */
          }
        }
        if (!move) {
          console.warn(
            '[CoachGame] Brain emitted no usable play_move; falling back to random legal move',
          );
          move = getRandomLegalMove(game.fen);
        }
        if (!move) {
          console.error('[CoachGame] No legal moves available');
          return;
        }

        let result = tryMakeMove(move);

        // If move was invalid, fall back to a random legal move
        if (!result) {
          console.warn('[CoachGame] Move invalid:', move, '— trying random fallback');
          const randomMove = getRandomLegalMove(game.fen);
          if (randomMove) {
            result = tryMakeMove(randomMove);
          }
        }

        if (!result) {
          console.error('[CoachGame] No valid move could be made');
          return;
        }

        // WO-COACH-FX-DIAG checkpoint — keep the diagnostic trace so the
        // audit log retains the FX flow signal, but do NOT bail on
        // cancellation: chess.js was already mutated by tryMakeMove, so
        // applyCoachMove MUST run to keep gameState.moves in sync and
        // fire the last-move highlight, sound, narration, and move-list
        // entry. Cancellation at this gate is expected — game.fen
        // flipped during tryMakeMove, the useEffect re-fired, and the
        // previous run's controller was aborted. Let the in-flight call
        // commit its FX; the FEN-turn guard at the top of makeCoachMove
        // prevents the next effect run from double-firing.
        void logAppAudit({
          kind: 'coach-turn-checkpoint',
          category: 'subsystem',
          source: 'CoachGamePage.coachTurn',
          summary: `move-committed san=${result.san} cancelled=${isCancelled()}`,
          fen: result.fen,
        });

        if (isCancelled()) {
          void logAppAudit({
            kind: 'coach-move-fx-cancellation-ignored',
            category: 'subsystem',
            source: 'CoachGamePage',
            summary: `gate=post-tryMakeMove san=${result.san} — committing FX path`,
          });
        }

        console.log('[CoachGame] Coach played:', result.san);

        // Pre-move analysis is awaited only now — it ran in parallel
        // with the spine call so the round-trip didn't double the
        // wait. It is purely informational: classification, eval bar,
        // opponent-threat scan.
        const analysis = await preAnalysisPromise;

        // Analyze the position AFTER the coach moved — this gives:
        // 1. Accurate eval/top lines for the player's upcoming turn (voice chat needs this)
        // 2. preMoveEval for the player's next move classification
        // WO-COACH-FREEZE-FIX (PR #349): wrap with withTimeout. If this
        // hangs the user can't move (isCoachThinking stays true and the
        // board stays non-interactive), so the freeze is just deferred
        // by one turn. 5 s is plenty for depth-10.
        let postCoachAnalysis: StockfishAnalysis | null = null;
        try {
          const wrappedPost = await withTimeout(
            stockfishEngine.analyzePosition(result.fen, 10),
            5_000,
            'post-coach-move-analysis',
          );
          postCoachAnalysis = wrappedPost.ok ? wrappedPost.value : null;
        } catch {
          // Fall back to pre-coach analysis if post-analysis fails
        }

        // Same reasoning as the gate above — the move is already on the
        // board, so applyCoachMove must run regardless of whether the
        // effect was cancelled during the post-move analysis await.
        if (isCancelled()) {
          void logAppAudit({
            kind: 'coach-move-fx-cancellation-ignored',
            category: 'subsystem',
            source: 'CoachGamePage',
            summary: `gate=post-postCoachAnalysis san=${result.san} — committing FX path`,
          });
        }

        void logAppAudit({
          kind: 'coach-turn-checkpoint',
          category: 'subsystem',
          source: 'CoachGamePage.coachTurn',
          summary: `reached applyCoachMove call — about to fire FX (sound + highlight + audit)`,
          fen: result.fen,
        });

        const postCoachEval = postCoachAnalysis?.evaluation ?? analysis.evaluation;
        applyCoachMove(result, postCoachEval, analysis.evaluation, analysis.bestMove);
        // Track previous FEN for tactic classification
        previousFenRef.current = result.fen;

        // Classify the coach's move the same way the player's moves are
        // classified so users get a visual flash on the opponent's turn
        // too. Adaptive / book moves can still land as a blunder at low
        // difficulty, so this is informative rather than cosmetic.
        const coachColor: 'white' | 'black' = playerColor === 'white' ? 'black' : 'white';
        const isEngineBest = !!analysis.bestMove && move === analysis.bestMove;
        const secondBestEval = analysis.topLines.length > 1 ? analysis.topLines[1].evaluation : null;
        const coachClassification = classifyMove(
          analysis.evaluation,
          postCoachEval,
          analysis.evaluation,
          isEngineBest,
          coachColor,
          secondBestEval,
        );
        const coachFlashMap = new Map<string, 'blunder' | 'inaccuracy' | 'good'>([
          ['blunder', 'blunder'],
          ['mistake', 'blunder'],
          ['inaccuracy', 'inaccuracy'],
          ['brilliant', 'good'],
          ['great', 'good'],
        ]);
        const coachFlash = coachFlashMap.get(coachClassification);
        if (coachFlash && !isCancelled()) {
          triggerMoveFlash(coachFlash);
        }

        // Use POST-move analysis for eval bar + engine lines — these are for the
        // player's turn, which is what voice chat needs when answering "what should I play?"
        setLatestEval(postCoachEval);
        setLatestIsMate(postCoachAnalysis?.isMate ?? analysis.isMate);
        setLatestMateIn(postCoachAnalysis?.mateIn ?? analysis.mateIn);
        setLatestTopLines(postCoachAnalysis?.topLines ?? analysis.topLines);

        // WO-LIVE-COACH-01: opponent move signal. analysis.evaluation
        // is the eval BEFORE coach moved, postCoachEval is AFTER.
        // The hook detects opponent-blunder only — student-side
        // triggers fire on the student's own moves above.
        liveCoach.notifyOpponentMove({
          ply: moveCountRef.current,
          san: result.san,
          fenAfter: result.fen,
          evalBefore: analysis.evaluation,
          evalAfter: postCoachEval,
        });

        // Proactive tactic alert: scan for opponent threats after coach's
        // move. Fires the alert as soon as the threat is brewing
        // — BEFORE the student plays into it — which is the only useful
        // moment per the user. Stockfish-driven (no LLM round-trip), so
        // it speaks within ~100ms of the coach's reply.
        //
        // WO-NARR-POLICY-01: gated on verbosity !== 'off'. Both
        // 'key-moments' and 'every-move' speak the alert; 'off' stays
        // silent. Cancellation is intentionally NOT a gate — same
        // reasoning as the FX path: chess.js is mutated, the threat
        // exists on the board, the player needs to hear it.
        //
        // Wording (audit build 9b74213 caught the bug): the pattern
        // description is generated from the FUTURE FEN where the
        // tactic exists ("Queen on h4 pins pawn on h2") but the queen
        // ISN'T on h4 yet — so a present-tense announcement was
        // confusing. Prefix with the move that would set it up so the
        // student hears "if I play Qh4, [description]" — clearly a
        // threat to watch, not a fait accompli. Also verify the move
        // setting up the threat is legal on the current board (it
        // already is, since scanUpcomingTactics walks chess.js — but
        // the explicit check guards against any future regression).
        if (postCoachAnalysis) {
          const playerColorCode = playerColor === 'white' ? 'w' : 'b';
          const upcoming = scanUpcomingTactics(
            result.fen,
            postCoachAnalysis.topLines.map((l) => ({ moves: l.moves, evaluation: l.evaluation, mate: l.mate })),
            playerColorCode,
          );
          const threats = upcoming.filter((u) => u.beneficiary === 'opponent' && u.depthAhead <= 2);
          if (threats.length > 0) {
            const threat = threats[0];
            // The opponent's move that sets up the tactic. line[i]
            // alternates side-to-move; depthAhead=1 → line[0] is the
            // student's move and the threat emerges from that, depthAhead=2
            // → line[1] is the opponent's move that creates the threat.
            const threatMoveIdx = threat.depthAhead - 1;
            const threatMove = threat.line[threatMoveIdx] ?? '';
            const isOppMove = threatMoveIdx % 2 === 1;
            const lowerDesc = threat.pattern.description.charAt(0).toLowerCase() + threat.pattern.description.slice(1);
            const warning = isOppMove && threatMove
              ? `Watch out — if I play ${threatMove}, ${lowerDesc}.`
              : threatMove
                ? `Watch out — ${threatMove} from you would let ${lowerDesc}.`
                : `Watch out — ${threat.pattern.description}.`;
            gameChatRef.current?.injectAssistantMessage(warning);
            const tacticVerbosity = resolveVerbosity(useAppStore.getState().activeProfile);
            if (tacticVerbosity !== 'off') {
              void logAppAudit({
                kind: 'coach-tactic-alert-spoken',
                category: 'subsystem',
                source: 'CoachGamePage.coachTurn',
                summary: `pattern=${threat.pattern.description} threatMove=${threatMove} depthAhead=${threat.depthAhead} verbosity=${tacticVerbosity}`,
                fen: result.fen,
              });
              // Mirror into the coach's session memory so when the user
              // asks "what did you just say?" the brain can recall the
              // alert it just spoke. WO-NARR-POLICY-02.
              useCoachSessionStore.getState().appendMessage({
                id: `tactic-alert-${Date.now()}`,
                role: 'assistant',
                content: warning,
                timestamp: Date.now(),
              });
              // WO-VOICE-LAYER-01 (b): use the personality's secondary
              // voice so the alert cuts through with a different timbre
              // than the main narration.
              void voiceService.speakAlert(warning).catch((err: unknown) => {
                console.warn('[tactic-alert] TTS failed:', err);
              });
            }
          }
        }
      } catch (error) {
        if (isCancelled()) return;
        console.error('[CoachGame] Coach move failed, attempting random fallback:', error);

        // Last resort: random legal move so the game never freezes
        const randomMove = getRandomLegalMove(game.fen);
        if (randomMove) {
          const result = tryMakeMove(randomMove);
          if (result) {
            console.log('[CoachGame] Fallback random move played:', result.san);
            applyCoachMove(result, 0);
            return;
          }
        }
        console.error('[CoachGame] All move attempts failed');
      } finally {
        // Only clear thinking state if this operation wasn't cancelled.
        // If cancelled, the cleanup function already handled it.
        if (!isCancelled()) {
          setIsCoachThinking(false);
        }
      }
    };

    // Small delay to feel natural
    const timer = setTimeout(() => void makeCoachMove(), 800);

    return () => {
      abortController.abort();
      clearTimeout(timer);
      setIsCoachThinking(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depend on specific game properties, not the whole object
  }, [game.turn, game.fen, game.isGameOver, gameState.status, playerColor, targetStrength, game.makeMove]);

  // Handle player move
  const handlePlayerMove = useCallback(async (moveResult: MoveResult) => {
    // ─── Quiz interceptor (WO-COACH-LICHESS-OPENINGS) ────────────────
    // If a coach-driven quiz is pending, the student's move resolves
    // it before any classification / coach reply runs. The Promise
    // result feeds back to the LLM in its next round-trip; the LLM
    // reads it and narrates feedback ("perfect — that's the main
    // line" or "Nf3 is the principled move here, not Nc3"). We do
    // NOT skip the rest of the function — the move still needs
    // analysis, eval bar update, blunder detection, etc. The quiz is
    // a side-channel that runs in parallel with normal flow.
    {
      const cur = quizStateRef.current;
      if (cur.active) {
        const playedSan = moveResult.san;
        const accepted =
          playedSan === cur.expectedSan ||
          cur.allowAlternatives.includes(playedSan);
        const result = accepted
          ? ({ ok: true, played: playedSan } as const)
          : ({ ok: false, played: playedSan, expected: cur.expectedSan } as const);
        cur.resolve(result);
        quizStateRef.current = { active: false };
        setQuizState({ active: false });
        void logAppAudit({
          kind: 'quiz-resolved',
          category: 'subsystem',
          source: 'CoachGamePage.handlePlayerMove',
          summary: `played=${playedSan} expected=${cur.expectedSan} ok=${accepted}`,
          details: JSON.stringify({
            played: playedSan,
            expected: cur.expectedSan,
            allowAlternatives: cur.allowAlternatives,
            accepted,
          }),
        });
      }
    }

    // Clear any coach annotations, hints, and reset move navigation when player moves
    handleBackToGame();
    setViewedMoveIndex(null);
    resetHints();
    prevNudgeRef.current = null;
    // Clear any stale move-quality flash before we start analyzing this
    // move. Without this, a previous move's flash (including an 'blunder'
    // flash from the coach's last move) can still be visible during the
    // current move's analysis window, which looked to the user like
    // their best move was being flagged red (WO-COACH-NARRATION-06).
    setMoveFlash(null);

    // Capture pre-move FEN before making the move
    const preFen = game.fen;
    previousFenRef.current = preFen;

    // NOTE: We intentionally defer game.makeMove() until after analysis.
    // Calling it here would flip game.turn to the coach's color, and because
    // the analysis below is async, React would re-render between awaits,
    // allowing the coach-move useEffect to fire before we know whether this
    // move is a blunder.  Deferring keeps game.turn on the player's color
    // throughout the analysis window, preventing the coach from responding
    // prematurely.
    //
    // WO-COACH-RESILIENCE part D — board flash on student moves.
    // Previously this line set `setCoachLastMove(null)` which wiped
    // the last-move highlight whenever the student moved, so only
    // coach replies got the colored from→to squares. The variable
    // is misnamed (it's the "last move played" highlight, not coach-
    // specific). Setting it here highlights the student's move just
    // like coach moves do — same visual cue, both directions.
    setCoachLastMove({ from: moveResult.from, to: moveResult.to });
    moveCountRef.current += 1;

    // Analyze the position AFTER the player's move (for eval bar + post-move eval).
    // withTimeout: a hung Stockfish must not block the deferred game.makeMove
    // below — without that move, game.turn never flips and the coach-turn
    // effect never fires. On timeout we proceed with null analysis; the
    // classification logic handles null gracefully.
    let analysis: StockfishAnalysis | null = null;
    try {
      const wrapped = await withTimeout(
        stockfishEngine.analyzePosition(moveResult.fen, 12),
        5_000,
        'player-move-analysis-after',
      );
      analysis = wrapped.ok ? wrapped.value : null;
    } catch {
      // If analysis throws, default to null (existing classification handles it)
    }

    // Analyze the position BEFORE the player's move (for best move comparison).
    let preAnalysis: StockfishAnalysis | null = null;
    try {
      const wrappedPre = await withTimeout(
        stockfishEngine.analyzePosition(preFen, 12),
        5_000,
        'player-move-analysis-before',
      );
      preAnalysis = wrappedPre.ok ? wrappedPre.value : null;
    } catch {
      // If pre-analysis throws, we'll use simpler classification
    }

    // Update eval bar + engine lines
    if (analysis) {
      setLatestEval(analysis.evaluation);
      setLatestIsMate(analysis.isMate);
      setLatestMateIn(analysis.mateIn);
      setLatestTopLines(analysis.topLines);
    }

    // Check if the player played the engine's best move
    const playerUci = moveResult.from + moveResult.to + (moveResult.promotion ?? '');
    const isEngineBestMove = preAnalysis?.bestMove === playerUci;
    const bestMoveEval = preAnalysis?.topLines[0]?.evaluation ?? null;
    const secondBestEval = preAnalysis?.topLines[1]?.evaluation ?? null;

    // Compute classification and build the move record
    const prevMoves = gameState.moves;
    const preMoveEval = prevMoves.length > 0 ? (prevMoves[prevMoves.length - 1].evaluation ?? null) : 0;
    let classification = analysis
      ? classifyMove(preMoveEval, analysis.evaluation, bestMoveEval, isEngineBestMove, playerColor, secondBestEval)
      : 'good';

    const evalLoss = analysis && preMoveEval !== null
      ? Math.max(0, playerColor === 'white'
          ? preMoveEval - analysis.evaluation
          : analysis.evaluation - preMoveEval)
      : 0;

    // bestMove from pre-analysis = what the player SHOULD have played (convert UCI → SAN)
    const engineBestMoveUci = preAnalysis?.bestMove ?? null;
    let engineBestMoveSan = '?';
    if (engineBestMoveUci) {
      try {
        engineBestMoveSan = uciMoveToSan(engineBestMoveUci, preFen);
      } catch {
        engineBestMoveSan = engineBestMoveUci;
      }
    }

    // If the engine's best move matches what the player played, override to 'good'
    if (isEngineBestMove || engineBestMoveSan === moveResult.san) {
      classification = 'good';
    }

    // Run deterministic tactic classifier on the move
    let tacticSuffix = '';
    // Hoisted by WO-POLISH-02: tacticResult is also consumed by the
    // blunder-alert LLM call below as grounded context, so it needs
    // outer scope, not just inside the suffix try-block.
    let tacticResult: ReturnType<typeof classifyPosition> | null = null;
    if (analysis) {
      try {
        tacticResult = classifyPosition(
          preFen,
          moveResult.fen,
          moveResult.san,
          preMoveEval ?? 0,
          analysis.evaluation,
        );
        const realTactics = tacticResult.tactics.filter((t) => t.type !== 'none');
        if (realTactics.length > 0) {
          tacticSuffix = ` (${realTactics.map((t) => t.description).join('; ')})`;
        }
        // WO-NARR-POLICY-06: dropped the "Hanging: White pawn on h7"
        // listing from tacticSuffix entirely. The robotic enumeration
        // was bleeding into the move-list / chat surfaces and the user
        // explicitly asked for it removed. The hanging-piece info is
        // still passed to the live-coach blunder detector (via
        // `tacticResult.hangingPieces` directly) and to the LLM
        // commentary path as grounded context — only the deterministic
        // banner text is gone.
      } catch {
        // Tactic classification failed, continue without it
      }
    }

    // LLM commentary is gated on the user's coachCommentaryVerbosity
    // preference (default 'key-moments'). On non-key moves we skip the
    // LLM entirely and fall back to the deterministic tacticSuffix,
    // which cuts per-game LLM spend ~60% without losing the
    // pedagogically important commentary on blunders/brilliants.
    //
    // EXCEPTION: when a subject is set AND we're still in opening
    // theory (book depth OR configured book length), fire the LLM on
    // every move so the coach can teach the opening ideas in real
    // time. "Key moments only" would skip most opening book moves
    // because they classify as 'book' / 'best', killing the feature.
    let commentary = '';
    // Tracks whether the LLM produced speech-worthy content for this
    // move. The deterministic tactic suffix ("Hanging: Black rook on
    // h8 ...") is fine in the move-list display but NEVER gets spoken
    // — it's a robotic readout that breaks the personality voice and
    // fires on every player move regardless of verbosity setting.
    // Bug observed in production audit ac8088d. WO-NARR-POLICY-03.
    let llmProducedSpeech = false;
    const verbosity = resolveVerbosity(useAppStore.getState().activeProfile);
    // Narration density — separate from the commentary-gate verbosity
    // above. Honors the user's Settings toggle (none/fast/medium/slow)
    // so the LLM output matches the chosen depth. 'none' short-circuits
    // the LLM call entirely so no tokens are burned producing text
    // we'd throw away.
    const narrationDensity =
      useAppStore.getState().activeProfile?.preferences.coachVerbosity ?? 'unlimited';
    // Auto-detect the opening from the SAN move history so opening
    // teaching mode activates whenever the position matches a known
    // book line — even if the student didn't pick a subject from the
    // dropdown. Detection is fast (trie lookup over the bundled
    // Lichess openings DB) and safe to run every move. Resolution
    // precedence: explicit URL subject > committed intent > auto-detect.
    const detectedOpening = detectOpening(game.history);
    // Resolution precedence: URL > auto-detect > intent. Auto-detect
    // is always accurate to the actual moves on the board, so it wins
    // over a (potentially stale) committed intent. Production audit
    // build cb018c0 caught the bug: a sticky `intendedOpening =
    // "Italian Game"` from a prior session was overriding the
    // auto-detected "Scandinavian Defense" on a fresh 1.e4 d5 game,
    // and the LLM was being told "Italian Game" while narrating
    // moves that weren't Italian. Auto-detect-first eliminates the
    // mismatch — intent only fires when the position is too generic
    // for the trie to name (rare, very early game).
    const resolutionSource: 'url' | 'auto-detect' | 'intent' | 'none' = subjectParam
      ? 'url'
      : detectedOpening
        ? 'auto-detect'
        : intendedOpening
          ? 'intent'
          : 'none';
    const resolvedSubject =
      subjectParam ?? detectedOpening?.name ?? intendedOpening?.name ?? null;
    const bookDepth = resolvedSubject
      ? (getOpeningMoves(resolvedSubject)?.length ?? 0)
      : 0;
    const inOpeningTeaching =
      !!resolvedSubject && game.history.length <= Math.max(bookDepth, 12);
    if (detectedOpening) {
      void logAppAudit({
        kind: 'coach-opening-auto-detected',
        category: 'subsystem',
        source: 'CoachGamePage.move',
        summary: `eco=${detectedOpening.eco} name="${detectedOpening.name}" ply=${detectedOpening.plyCount} resolution=${resolutionSource}`,
        fen: moveResult.fen,
      });
    }
    if (inOpeningTeaching && resolvedSubject) {
      void logAppAudit({
        kind: 'coach-opening-teaching-active',
        category: 'subsystem',
        source: 'CoachGamePage.move',
        summary: `subject="${resolvedSubject}" resolution=${resolutionSource} ply=${game.history.length}/${Math.max(bookDepth, 12)}`,
        fen: moveResult.fen,
      });
    }
    // Sparse-cadence narration (WO-NARRATION-CADENCE).
    //
    // The previous behavior fired the LLM on every move while in
    // opening teaching mode, which made the game feel like waiting
    // for the coach to monologue between every move (5-7s latency
    // per call, ~1700-char response). Player flow died.
    //
    // New cadence:
    //   1. ONCE per opening — fire the long teaching narration the
    //      first time we see a recognizable opening name. Subsequent
    //      moves in the same opening stay silent unless a key moment
    //      fires.
    //   2. KEY MOMENTS — blunders / mistakes / inaccuracies /
    //      brilliants / greats trigger a short personality-laden
    //      zinger (briefMode below). Latency budget: ~2s for a
    //      1-2 sentence response with mockery / critique.
    //   3. PHASE TRANSITIONS — handled by usePhaseNarration. Fires
    //      automatically at opening→middlegame and
    //      middlegame→endgame, giving the next teaching beat.
    //   4. EXPLICIT every-move setting — power users who set
    //      `coachCommentaryVerbosity = 'every-move'` still get the
    //      old per-move running commentary.
    //
    // Settings → Coach → Commentary Frequency drives this:
    //   'off'         → all three triggers gated off (silent except
    //                   for deterministic tactic suffix)
    //   'key-moments' → blunder/mistake/brilliant/great only. NO
    //                   opening intro, NO phase transition prose.
    //                   Tactic alerts still speak from the post-coach
    //                   scan — those are Stockfish-driven, no LLM
    //                   latency, and the user wants them as soon as
    //                   the threat lands on the board.
    //   'every-move'  → opening intro once per game + every player
    //                   move + key moments + tactic alerts.
    //
    // WO-NARR-POLICY-01: opening intro gated to 'every-move' only.
    // Under 'key-moments' the user explicitly asked for silence except
    // on actual events. The intro flag is also collapsed from per-name
    // to per-game so a refining auto-detect doesn't trigger three
    // intros for one opening.
    const isFirstSeeingOpening =
      verbosity === 'every-move' &&
      inOpeningTeaching &&
      !!resolvedSubject &&
      !openingIntroSpokenRef.current;
    const isKeyMoment = shouldCallLlmForMove(verbosity, classification);
    const userWantsEveryMove = verbosity === 'every-move';
    // briefMode: short personality-laden response. Skipped for the
    // big opening intro (wants long prose) and for explicit
    // every-move (user wants normal length).
    const briefMode = isKeyMoment && !isFirstSeeingOpening && !userWantsEveryMove;
    const shouldFire =
      narrationDensity !== 'none' &&
      (isFirstSeeingOpening || isKeyMoment || userWantsEveryMove);
    if (shouldFire) {
      try {
        // Build a probe Chess instance that carries the FULL move
        // history. The LLM commentary path uses
        // `gameAfter.history({ verbose: true })` to extract the last
        // move's SAN + flags + recent SAN list. A FEN-only probe
        // (`new Chess(fen)`) has empty history, so
        // generateMoveCommentary returned '' immediately at its
        // history.length===0 guard — every move silently skipped the
        // LLM. Audit-log evidence for the bug: zero `verbosity-resolved`
        // audits despite `coach-opening-teaching-active` firing on
        // every move (so shouldFire was true and generateMoveCommentary
        // WAS being called — just bailing before the LLM call).
        // Replay from the starting position so chess.js generates a
        // real verbose history; fall back to the FEN-only probe if
        // any SAN doesn't validate (rare — chess.js produced these
        // SANs in the first place, but defensive in case the URL
        // import path ever feeds in a non-replayable history).
        let probe: Chess | null;
        try {
          const replay = new Chess();
          for (const san of game.history) replay.move(san);
          replay.move(moveResult.san);
          probe = replay;
        } catch (err: unknown) {
          void logAppAudit({
            kind: 'bad-fen',
            category: 'subsystem',
            source: 'CoachGamePage.move.probe-replay',
            summary: `replay failed; falling back to FEN probe — ${err instanceof Error ? err.message : String(err)}`,
            fen: moveResult.fen,
          });
          probe = safeChessFromFen(moveResult.fen);
        }
        if (!probe) {
          console.warn('[CoachGame] bad FEN for narration probe:', moveResult.fen);
          return;
        }
        const mover: 'w' | 'b' = probe.turn() === 'w' ? 'b' : 'w';
        // Pull recent chat from the shared session store so narration
        // stays consistent with what was just said in chat.
        const sessionMessages = useCoachSessionStore.getState().messages;

        // In opening-teaching mode, ground the commentary in REAL
        // Lichess + engine data: pull the Opening Explorer for the
        // current position, cloud-eval each popular candidate on its
        // RESULTING position, and run the trap detector on the
        // combined result. The fetch is best-effort — wrapped in
        // withTimeout so a slow Lichess response never stalls
        // narration; failures fall through to prose without the
        // numbers.
        const groundedNotes: string[] = [];
        if (inOpeningTeaching) {
          try {
            const explorer = await withFetchTimeout(
              fetchLichessExplorer(probe.fen(), 'lichess'),
              LICHESS_FETCH_TIMEOUT_MS,
            );
            if (explorer.moves && explorer.moves.length > 0) {
              const topMoves = explorer.moves
                .slice(0, 5)
                .map((m) => {
                  const total = m.white + m.draws + m.black;
                  const whitePct = total ? Math.round((m.white + m.draws * 0.5) / total * 100) : 0;
                  return `- ${m.san}: ${total.toLocaleString()} games, ${whitePct}% for White`;
                })
                .join('\n');
              const openingLabel = explorer.opening
                ? ` (${explorer.opening.eco} ${explorer.opening.name})`
                : '';
              groundedNotes.push(
                `[Lichess Opening Explorer at current position${openingLabel}]\n${topMoves}`,
              );

              // Trap detection — cloud-eval each top explorer move on
              // its RESULTING position to get a correct per-candidate
              // eval. The prior implementation paired explorer moves
              // (ranked by popularity) with Stockfish top-lines
              // (ranked by strength) by array index. Those arrays
              // don't align, so the detector was reading the wrong
              // eval for the wrong move. Now each candidate is
              // evaluated on its own resulting FEN; missing cloud
              // evals (404) are skipped, never misattributed.
              const evaluations = await evaluateExplorerCandidates(
                probe.fen(),
                explorer.moves.slice(0, 5).map((m) => m.san),
                mover,
              );
              if (evaluations.length > 0) {
                const trap = detectTrapInPosition({
                  explorer,
                  evaluations,
                  engineBestSan: engineBestMoveSan !== '?' ? engineBestMoveSan : undefined,
                  // Gate against the CURRENT legal-move set so an
                  // explorer/FEN mismatch can't surface a trap for a
                  // move that isn't playable right now.
                  legalSan: probe.moves(),
                });
                if (trap) {
                  groundedNotes.push(formatTrapForPrompt(trap));
                }
              }
            }
          } catch (err: unknown) {
            console.warn('[CoachGame] Lichess explorer fetch failed:', err);
          }
        }

        // Recent move classifications — feeds the [StudentState] block
        // so the coach can read the rhythm (just blundered? on a
        // streak?) and adapt tone. Take the newest 5.
        const recentMoveClassifications = gameState.moves
          .slice(-5)
          .map((m) => m.classification);
        // Tempo signal: time of the PREVIOUS user interaction (chat
        // message or board move), not "now". The builder treats <2s
        // as no-signal, so passing Date.now() always flagged FAST
        // and forced the LLM into "keep replies tight" mode — that
        // cancelled out Unlimited verbosity. Use the newest user
        // chat message timestamp (the student's last typed/spoken
        // turn); undefined when there is none so the block skips
        // tempo entirely.
        const lastUserChatMs = [...sessionMessages]
          .reverse()
          .find((m) => m.role === 'user')?.timestamp;

        // Personality dials — picked up at narration time (not at
        // session start) so a mid-session settings change takes
        // effect on the next move. Mirrors how the brain (chat) path
        // reads dials in coach/envelope.ts.
        const activePrefs = useAppStore.getState().activeProfile?.preferences;
        // Track whether streaming actually dispatched a sentence to TTS.
        // If yes, the post-LLM speak path below skips (the streamed
        // sentences ARE the narration; speaking again would double up).
        let streamedAnything = false;
        const llm = await generateMoveCommentary({
          gameAfter: probe,
          mover,
          evalBefore: preMoveEval,
          evalAfter: analysis?.evaluation ?? null,
          bestReplySan: engineBestMoveSan !== '?' ? engineBestMoveSan : undefined,
          chatHistory: sessionMessages,
          // Threading the resolved subject (URL > committed intent >
          // auto-detected) activates the OPENING TEACHING MODE branch
          // of PLAY_SYSTEM_PROMPT whenever the student is playing a
          // recognizable book line — no dropdown pick required.
          subject: resolvedSubject ?? undefined,
          verbosity: narrationDensity,
          groundedNotes,
          recentMoveClassifications,
          lastUserInteractionMs: lastUserChatMs,
          personality: activePrefs?.coachPersonality,
          profanity: activePrefs?.coachProfanity,
          mockery: activePrefs?.coachMockery,
          flirt: activePrefs?.coachFlirt,
          // Explicit perspective: the student plays `playerColor`; the
          // coach plays the opposite. Without this, the LLM was
          // inferring (audit log build ac20cc5 caught it narrating
          // the student's e4 as "Alright, I'm playing e4...").
          studentColor: playerColor === 'white' ? 'w' : 'b',
          // Brief mode for key-moment zingers (blunders, mistakes,
          // brilliants etc.) — short personality-laden 1-2 sentence
          // response (~2s latency). Long-form prose only fires for
          // the once-per-opening intro and explicit every-move mode.
          briefMode,
          // WO-VOICE-LAYER-02: tell the LLM which Polly engine will
          // speak its output so it embeds emotional cues for
          // Generative voices (Ruth/Matthew/Danielle/Gregory) that
          // ignore SSML prosody. Neural voices skip the cue block.
          voiceEngine: (() => {
            const activeVoice = resolvePollyVoice(
              activePrefs?.coachPersonality,
              activePrefs?.coachPersonalityVoices,
              activePrefs?.pollyVoice ?? 'ruth',
            );
            return POLLY_VOICES.find((v) => v.id === activeVoice)?.engine as 'generative' | 'neural' | undefined;
          })(),
          // Stream the LLM and ship each completed sentence to Polly
          // the moment it lands. `createStreamingSpeaker()` encapsulates
          // the chain semantics: first sentence drops politely via
          // speakIfFree if Polly is busy, and when that drop happens
          // every subsequent sentence in the batch also drops so the
          // in-flight narration plays through cleanly. See
          // streamingSpeaker.ts for the production-audit history.
          onStream: (() => {
            let buffer = '';
            const speaker = createStreamingSpeaker();
            return (chunk: string): void => {
              buffer += chunk;
              let match: RegExpExecArray | null;
              while ((match = SENTENCE_END_RE.exec(buffer)) !== null) {
                // Take the whole prefix from buffer[0] up to the end of
                // the match — any content before match.index is unmatched
                // prose that belongs to THIS sentence (the regex skipped
                // it because of an earlier digit-period). Slicing only
                // from match.index would drop it silently.
                const endIdx = match.index + match[1].length;
                const sentence = buffer.slice(0, endIdx).trim();
                if (sentence) {
                  streamedAnything = true;
                  speaker.add(sentence);
                }
                buffer = buffer.slice(endIdx);
              }
            };
          })(),
        });
        // Mark this opening as introduced so subsequent moves in the
        // same line stay silent (until a key moment or phase transition).
        // Only mark on success — if the LLM returned empty / errored,
        // we'll retry on the next move.
        if (llm && resolvedSubject && isFirstSeeingOpening) {
          openingIntroSpokenRef.current = true;
        }
        commentary = llm ? llm + tacticSuffix : tacticSuffix.trim();
        // Only the LLM portion is speech-worthy. tacticSuffix is a
        // deterministic readout meant for the move list display, NOT
        // for TTS.
        // If we already streamed sentences to TTS during generation,
        // mark llmProducedSpeech=false so the post-LLM speakIfFree
        // below DOESN'T fire — the streamed sentences ARE the
        // narration; speaking the full string again would double up.
        // WO-PLAN-B.
        llmProducedSpeech = Boolean(llm.trim()) && !streamedAnything;
        // Mirror the commentary into the shared session so the next
        // chat turn (or the next move's narration) sees what we just
        // said. Skip empties and pure tactic suffixes — we only record
        // real narration.
        if (llm) {
          useCoachSessionStore.getState().appendMessage({
            id: `narr-${Date.now()}`,
            role: 'assistant',
            content: llm,
            timestamp: Date.now(),
          });
        }
      } catch {
        commentary = tacticSuffix.trim();
      }
    } else {
      // Non-key move — skip the LLM. The tactic classifier may still
      // have found something worth noting (hanging piece, fork motif);
      // keep that so the user isn't staring at a blank row.
      commentary = tacticSuffix.trim();
    }
    // Keep evalLoss referenced even when we drop the template so it's
    // still available for classification decisions above.
    void evalLoss;

    const playerMove: CoachGameMove = {
      moveNumber: moveCountRef.current,
      san: moveResult.san,
      fen: moveResult.fen,
      isCoachMove: false,
      commentary,
      evaluation: analysis?.evaluation ?? null,
      classification,
      expanded: false,
      bestMove: engineBestMoveUci,
      bestMoveEval: bestMoveEval,
      preMoveEval,
    };

    // WO-LIVE-COACH-01: hand the per-move analysis to the live-coach
    // hook so it can run the five trigger detectors and speak when
    // one fires. We reuse the Stockfish results we already computed
    // above (no extra engine cycle).
    if (analysis) {
      const realTactics = tacticResult?.tactics.filter((t) => t.type !== 'none') ?? [];
      const bestMoveWasTactical = realTactics.length > 0;
      const hasHangingPiece = !!(tacticResult && tacticResult.hangingPieces.length > 0);
      liveCoach.notifyPlayerMove({
        ply: moveCountRef.current,
        san: moveResult.san,
        fenAfter: moveResult.fen,
        evalBefore: preMoveEval ?? 0,
        evalAfter: analysis.evaluation,
        bestMoveEval: bestMoveEval,
        bestMoveSan: engineBestMoveSan === '?' ? null : engineBestMoveSan,
        isBestMove: isEngineBestMove || engineBestMoveSan === moveResult.san,
        bestMoveWasTactical,
        hasHangingPiece,
      });
    }

    // Flash the board based on classification (map to MoveQuality type)
    const flashMap = new Map<string, 'blunder' | 'inaccuracy' | 'good'>([
      ['blunder', 'blunder'],
      ['mistake', 'blunder'],
      ['inaccuracy', 'inaccuracy'],
      ['brilliant', 'good'],
      ['great', 'good'],
    ]);
    const flash = flashMap.get(classification);
    if (flash) {
      triggerMoveFlash(flash);
    }

    // BLUNDER INTERCEPTION: pause game and explain
    if (classification === 'blunder' && engineBestMoveUci) {
      // Sync the blunder move onto the game instance so undoMove() in
      // handleBlunderTryBestMove / handleBlunderTakeBack can reverse it.
      // Status is set to 'blunder_pause' in the same synchronous block,
      // so the coach-move useEffect never sees 'playing' + coach's turn.
      game.makeMove(moveResult.from, moveResult.to, moveResult.promotion);

      // WO-POLISH-02: build a clean coach-voice fallback for the blunder
      // popup. Used verbatim if the LLM call below times out or errors.
      // NEVER falls back to tacticSuffix — that's template prose with
      // "Hanging: White pawn on d2" shape Dave wants gone.
      let explanation: string;
      const firstHanging = tacticResult?.hangingPieces[0];
      if (firstHanging) {
        const pieceName = {
          p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
        }[firstHanging.piece.toLowerCase()] ?? firstHanging.piece;
        const ownership = (firstHanging.color === 'w') === (playerColor === 'white') ? 'Your' : "Opponent's";
        explanation = `${ownership} ${pieceName} on ${firstHanging.square} is hanging.`;
      } else {
        explanation = 'That move loses material — take another look at the position.';
      }

      // WO-POLISH-02: LLM-generated coach-voice alert. Uses the grounded
      // context (FEN + hanging pieces + best move) so it can describe
      // what's wrong in plain prose. Falls back to the clean template
      // above on timeout / error — never to the tacticSuffix template.
      try {
        const alertContext = [
          `Position after the student's blunder (FEN): ${moveResult.fen}`,
          `Student color: ${playerColor}.`,
          `Student just played: ${moveResult.san}.`,
          `Engine evaluation after the move: ${analysis?.evaluation ?? 0} centipawns (white's perspective).`,
          engineBestMoveSan && engineBestMoveSan !== '?'
            ? `What the engine preferred (do NOT quote this to the student): ${engineBestMoveSan}.`
            : '',
          tacticResult && tacticResult.hangingPieces.length > 0
            ? `Hanging pieces detected (coordinates + piece): ${tacticResult.hangingPieces
                .map((p) => `${p.color === 'w' ? 'white' : 'black'} ${p.piece} on ${p.square}`)
                .join(', ')}.`
            : '',
          tacticResult && tacticResult.tactics.filter((t) => t.type !== 'none').length > 0
            ? `Tactics detected: ${tacticResult.tactics
                .filter((t) => t.type !== 'none')
                .map((t) => t.description)
                .join('; ')}.`
            : '',
        ].filter(Boolean).join('\n');

        // WO-COACH-UNIFY-01 commit 4: route blunder-alert through
        // coachService.ask. BLUNDER_ALERT_ADDITION threads as
        // systemPromptAddition; live FEN + just-played move flow into
        // liveState. task='chat_response' + maxTokens=200 preserves
        // legacy model + cost. Empty string on provider error keeps
        // the existing fallback path (clean template above).
        const fenSideToMove = moveResult.fen.split(' ')[1] === 'b' ? 'black' : 'white';
        const spineAlert = await coachService.ask(
          {
            surface: 'game-chat',
            ask: alertContext,
            liveState: {
              surface: 'game-chat',
              fen: moveResult.fen,
              userJustDid: `Student blundered with ${moveResult.san}`,
              whoseTurn: fenSideToMove,
            },
          },
          {
            task: 'chat_response',
            maxTokens: 200,
            maxToolRoundTrips: 1,
            systemPromptAddition: BLUNDER_ALERT_ADDITION,
          },
        );
        const alertText = unwrapSpineError(spineAlert.text);
        const trimmed = alertText.trim();
        if (trimmed && !trimmed.startsWith('⚠️')) {
          explanation = trimmed;
        }
      } catch {
        // fall through with the clean template
      }

      setBlunderPause({
        explanation,
        bestMoveSan: engineBestMoveSan,
        bestMoveUci: engineBestMoveUci,
        preFen,
        playerMoveSan: moveResult.san,
      });

      setGameState((prev) => ({
        ...prev,
        status: 'blunder_pause',
        moves: [...prev.moves, playerMove],
        currentHintLevel: 0,
      }));

      // Per-move narration. A blunder is always a "key moment" so we
      // speak the explanation whenever the user hasn't fully muted
      // commentary (`coachCommentaryVerbosity !== 'off'`). Phase
      // narration takes precedence: usePhaseNarration calls
      // voiceService.stop() on entry, and voiceService.speakInternal
      // also stops in-flight speech before starting — so a phase
      // summary firing will cleanly cut this off.
      if (verbosity !== 'off' && explanation.trim()) {
        void logAppAudit({
          kind: 'coach-move-narration-fired',
          category: 'subsystem',
          source: 'CoachGamePage.blunder',
          summary: `verbosity=${verbosity} chars=${explanation.length}`,
          fen: moveResult.fen,
        });
        void voiceService.speak(explanation).catch((err: unknown) => {
          console.warn('[CoachGame] blunder narration TTS failed:', err);
        });
      } else {
        void logAppAudit({
          kind: 'coach-move-narration-skipped',
          category: 'subsystem',
          source: 'CoachGamePage.blunder',
          summary: `verbosity=${verbosity} hasExplanation=${Boolean(explanation.trim())}`,
          fen: moveResult.fen,
        });
      }
      return;
    }

    // Non-blunder: sync the move and let the coach-move useEffect respond.
    game.makeMove(moveResult.from, moveResult.to, moveResult.promotion);

    // Per-move narration. ONLY speak when the LLM actually produced
    // personality-driven prose. The deterministic tactic suffix
    // ("Hanging: Black rook on h8, ...") is great for the move-list
    // display but is robotic and breaks the voice when read aloud —
    // and it would fire on every move regardless of the
    // 'key-moments' setting. Audit build ac8088d caught this bug.
    // WO-NARR-POLICY-03.
    if (llmProducedSpeech) {
      void logAppAudit({
        kind: 'coach-move-narration-fired',
        category: 'subsystem',
        source: 'CoachGamePage.move',
        summary: `verbosity=${verbosity} classification=${classification} chars=${commentary.length}`,
        fen: moveResult.fen,
      });
      // WO-NARR-POLICY-05: speakIfFree drops the new utterance when
      // a previous narration is still playing — the long opening
      // intro / phase summary gets to FINISH instead of being cut
      // mid-sentence the moment the student plays their next move.
      // The student can keep playing while the coach finishes its
      // thought; the per-move zinger about the new move just gets
      // skipped. They asked for this explicitly.
      void voiceService.speakIfFree(commentary).catch((err: unknown) => {
        console.warn('[CoachGame] move narration TTS failed:', err);
      });
    } else {
      void logAppAudit({
        kind: 'coach-move-narration-skipped',
        category: 'subsystem',
        source: 'CoachGamePage.move',
        summary: `verbosity=${verbosity} classification=${classification} reason=${commentary.trim() ? 'tactic-suffix-only' : 'empty-commentary'}`,
        fen: moveResult.fen,
      });
    }

    setGameState((prev) => ({
      ...prev,
      moves: [...prev.moves, playerMove],
      currentHintLevel: 0,
    }));
  }, [game, handleBackToGame, resetHints, playerColor, gameState.moves, triggerMoveFlash]);

  // Handle practice move (when in chat-driven practice mode)
  const handlePracticeMove = useCallback(async (moveResult: MoveResult) => {
    const result = await evaluatePracticeMove(moveResult);
    coachSay(result.message);
  }, [evaluatePracticeMove, coachSay]);

  // Handle board move routing — explore mode, practice mode, or normal gameplay
  const handleBoardMoveRouted = useCallback((moveResult: MoveResult) => {
    // WO-STOCKFISH-SWAP-AND-PERF (part 4): speculative prefetch.
    // Kick off a depth-12 Stockfish eval against the post-move FEN
    // before the brain runs. The full depth-18 eval the brain will
    // request next is a different cache key, but Stockfish's internal
    // hash table carries information across the two searches, so the
    // deeper search lands faster. Fire-and-forget — failure is not
    // fatal to the move flow.
    const prefetchFen = moveResult.fen;
    if (prefetchFen) {
      void logAppAudit({
        kind: 'stockfish-prefetch-fired',
        category: 'subsystem',
        source: 'CoachGamePage.prefetch',
        summary: `fen=${prefetchFen.slice(0, 30)}... depth=12`,
      });
      void stockfishEngine
        .analyzePosition(prefetchFen, 12, undefined, 'prefetch')
        .catch(() => {
          /* prefetch is best-effort: dropped when brain eval is in
             flight (PrefetchDroppedError), or cancelled by a newer
             prefetch / brain call. All swallowed silently — the brain
             will run its own depth-18 eval next anyway. */
        });
    }
    if (isExploreMode) {
      handleExploreMove(moveResult);
    } else if (practicePosition) {
      void handlePracticeMove(moveResult);
    } else {
      void handlePlayerMove(moveResult);
    }
  }, [isExploreMode, handleExploreMove, practicePosition, handlePracticeMove, handlePlayerMove]);

  // ─── WO-COACH-OPERATOR-FOUNDATION-01 — chat-driven board commands ───
  // The Layer 1 intent router (in coachService.ask) pattern-matches
  // commands like "play e4" / "take that back" / "reset the board"
  // BEFORE the LLM and dispatches via these callbacks. Each handler
  // delegates to existing chess.js + game-state machinery — no new
  // mutation paths.

  const handleChatPlayMove = useCallback(
    (san: string): { ok: boolean; reason?: string } => {
      // Trace harness deleted (Coach-tab full audit #30). Failures
      // are now visible via coach-tool-callback-rejected emitted by
      // the spine when this callback returns ok=false.
      const finish = (result: { ok: boolean; reason?: string }): { ok: boolean; reason?: string } => {
        if (!result.ok) {
          void logAppAudit({
            kind: 'coach-tool-callback-rejected',
            category: 'subsystem',
            source: 'CoachGamePage.handleChatPlayMove',
            summary: `san=${san} reason=${result.reason ?? 'unknown'}`,
          });
        }
        return result;
      };
      try {
        // Probe SAN in a sandbox to extract from/to/promotion; the
        // live `game.makeMove` API takes from/to, not SAN.
        const probe = new Chess(game.fen);
        const probed = probe.move(san);
        if (!probed) return finish({ ok: false, reason: `illegal SAN "${san}" from current FEN` });
        const moveResult = game.makeMove(probed.from, probed.to, probed.promotion);
        if (!moveResult) {
          return finish({
            ok: false,
            reason: `commit rejected for "${san}" — likely a turn or state mismatch`,
          });
        }
        // Route through the same post-move analysis pipeline a
        // board-drag move takes.
        handleBoardMoveRouted(moveResult);
        return finish({ ok: true });
      } catch (err) {
        return finish({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [game, handleBoardMoveRouted],
  );

  const handleChatTakeBackMove = useCallback(
    (count: number): { ok: boolean; reason?: string } => {
      const finish = (result: { ok: boolean; reason?: string }): { ok: boolean; reason?: string } => {
        if (!result.ok) {
          void logAppAudit({
            kind: 'coach-tool-callback-rejected',
            category: 'subsystem',
            source: 'CoachGamePage.handleChatTakeBackMove',
            summary: `count=${count} reason=${result.reason ?? 'unknown'}`,
          });
        }
        return result;
      };
      try {
        const target = Math.max(1, Math.floor(count));
        for (let i = 0; i < target; i++) {
          if (game.history.length === 0) {
            // Nothing more to undo — half-success if we already
            // reverted at least one move; full failure otherwise.
            return i === 0
              ? finish({ ok: false, reason: 'nothing to take back' })
              : finish({ ok: true });
          }
          game.undoMove();
        }
        return finish({ ok: true });
      } catch (err) {
        return finish({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [game],
  );

  const handleChatSetBoardPosition = useCallback(
    (fen: string): { ok: boolean; reason?: string } => {
      const finish = (result: { ok: boolean; reason?: string }): { ok: boolean; reason?: string } => {
        if (!result.ok) {
          void logAppAudit({
            kind: 'coach-tool-callback-rejected',
            category: 'subsystem',
            source: 'CoachGamePage.handleChatSetBoardPosition',
            summary: `reason=${result.reason ?? 'unknown'}`,
            fen,
          });
        }
        return result;
      };
      try {
        const ok = game.loadFen(fen);
        return ok
          ? finish({ ok: true })
          : finish({ ok: false, reason: 'game.loadFen rejected the FEN' });
      } catch (err) {
        return finish({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [game],
  );

  const handleChatResetBoard = useCallback(
    (): { ok: boolean; reason?: string } => {
      const finish = (result: { ok: boolean; reason?: string }): { ok: boolean; reason?: string } => {
        if (!result.ok) {
          void logAppAudit({
            kind: 'coach-tool-callback-rejected',
            category: 'subsystem',
            source: 'CoachGamePage.handleChatResetBoard',
            summary: `reason=${result.reason ?? 'unknown'}`,
          });
        }
        return result;
      };
      try {
        handleRestart();
        return finish({ ok: true });
      } catch (err) {
        return finish({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
    [handleRestart],
  );

  // Handle practice-in-chat from post-game review
  const handlePracticeInChat = useCallback((prompt: string) => {
    // Transition from postgame back to playing mode with chat
    game.resetGame();
    moveCountRef.current = 0;
    openingIntroSpokenRef.current = false;
    setGameState({
      gameId: `game-${Date.now()}`,
      playerColor,
      targetStrength,
      moves: [],
      hintsUsed: 0,
      currentHintLevel: 0,
      takebacksUsed: 0,
      status: 'playing',
      result: 'ongoing',
      keyMoments: [],
    });
    setLatestEval(0);
    setLatestIsMate(false);
    setLatestMateIn(null);
    setViewedMoveIndex(null);
    // WO-COACH-MEMORY-UNIFY-01: chat-prompt resets don't clear intent.
    // The user's new chat prompt may reaffirm, override, or leave the
    // intent as-is — `tryCaptureOpeningIntent` handles the write when
    // the new prompt actually names an opening.
    setPendingChatPrompt(prompt);
  }, [game, playerColor, targetStrength]);

  // Hint request — uses 3-tier visual hint system
  const handleHint = useCallback(() => {
    requestHint();
    setGameState((prev) => ({
      ...prev,
      currentHintLevel: Math.min(prev.currentHintLevel + 1, 3) as 0 | 1 | 2 | 3,
      hintsUsed: prev.hintsUsed + 1,
    }));
  }, [requestHint]);

  // Takeback — undo only enough plies to revert the STUDENT's most
  // recent move. Production audit: user reported "Taking back a move
  // should only take back my move. Not opponents." Old code blindly
  // undid 2 plies, which on a state like [user1, coach1, user2]
  // (coach hasn't replied yet) would undo user2 AND coach1 — the
  // student's last move plus the opponent's PRIOR move. Now we undo
  // exactly: 1 ply if the student's move is the most recent (no
  // coach reply yet), 2 plies if the coach has already replied
  // (coach reply + student move). Coach's earlier moves stay put.
  const handleTakeback = useCallback(() => {
    const moves = gameState.moves;
    if (moves.length === 0) return;
    const lastMove = moves[moves.length - 1];
    const lastWasCoach = lastMove.isCoachMove === true;
    // Coach just replied → undo coach + student. Student's move was
    // the most recent → undo student only. Either way, anything
    // before the student's most recent move stays untouched.
    const undoCount = lastWasCoach ? Math.min(2, moves.length) : 1;

    for (let i = 0; i < undoCount; i++) {
      game.undoMove();
    }
    moveCountRef.current = Math.max(0, moveCountRef.current - undoCount);
    resetHints();
    prevNudgeRef.current = null;

    setGameState((prev) => ({
      ...prev,
      moves: prev.moves.slice(0, -undoCount),
      takebacksUsed: prev.takebacksUsed + 1,
    }));

    const msg = getScenarioTemplate('takeback_allowed');
    coachSay(msg);
  }, [game, coachSay, resetHints, gameState.moves]);

  // ─── Blunder Interception Handlers ──────────────────────────────────────
  const handleBlunderContinue = useCallback(() => {
    voiceService.stop();
    setBlunderPause(null);
    setGameState((prev) => ({ ...prev, status: 'playing' }));
  }, []);

  const handleBlunderTakeBack = useCallback(() => {
    voiceService.stop();
    // Undo just the player's move (coach hasn't responded yet during blunder_pause)
    game.undoMove();
    moveCountRef.current = Math.max(0, moveCountRef.current - 1);
    resetHints();
    prevNudgeRef.current = null;

    setBlunderPause(null);
    setGameState((prev) => ({
      ...prev,
      status: 'playing',
      moves: prev.moves.slice(0, -1),
      takebacksUsed: prev.takebacksUsed + 1,
    }));
  }, [game, resetHints]);

  const handleBlunderTryBestMove = useCallback(() => {
    voiceService.stop();
    if (!blunderPause) return;

    // Undo the blunder move
    game.undoMove();
    moveCountRef.current = Math.max(0, moveCountRef.current - 1);
    resetHints();
    prevNudgeRef.current = null;

    // Apply the best move instead
    const bestMoveUci = blunderPause.bestMoveUci;
    const from = bestMoveUci.slice(0, 2);
    const to = bestMoveUci.slice(2, 4);
    const promotion = bestMoveUci.length > 4 ? bestMoveUci[4] : undefined;
    const result = game.makeMove(from, to, promotion);

    if (result) {
      moveCountRef.current += 1;
      const bestMove: CoachGameMove = {
        moveNumber: moveCountRef.current,
        san: result.san,
        fen: result.fen,
        isCoachMove: false,
        commentary: `Great! ${blunderPause.bestMoveSan} is the right move here.`,
        evaluation: null,
        classification: 'great',
        expanded: false,
        bestMove: bestMoveUci,
        bestMoveEval: null,
        preMoveEval: null,
      };

      setBlunderPause(null);
      setGameState((prev) => ({
        ...prev,
        status: 'playing',
        moves: [...prev.moves.slice(0, -1), bestMove],
        takebacksUsed: prev.takebacksUsed + 1,
      }));
    } else {
      // If best move failed, just take back
      setBlunderPause(null);
      setGameState((prev) => ({
        ...prev,
        status: 'playing',
        moves: prev.moves.slice(0, -1),
        takebacksUsed: prev.takebacksUsed + 1,
      }));
    }
  }, [game, resetHints, blunderPause]);

  // Derive opponent/player info for PlayerInfoBar
  const isPlayerWhite = playerColor === 'white';
  const playerName = activeProfile?.name ?? 'Player';
  const opponentName = 'Stockfish Bot';
  const isPlayerTurn = (isPlayerWhite && game.turn === 'w') || (!isPlayerWhite && game.turn === 'b');

  // Guided Lesson Mode — review a past game
  if (reviewGameId) {
    if (reviewLoading) {
      return (
        <div className="flex items-center justify-center h-dvh" data-testid="coach-game-page">
          <div className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm">Loading game...</span>
          </div>
        </div>
      );
    }

    if (!reviewGame || !reviewMoves) {
      return (
        <div className="flex flex-col items-center justify-center h-dvh gap-3" data-testid="coach-game-page">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Game not found.</p>
          <button
            onClick={() => void navigate('/coach')}
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
          >
            Back to Coach
          </button>
        </div>
      );
    }

    const reviewPlayerColor: 'white' | 'black' = reviewGame.white !== 'Stockfish Bot' && reviewGame.white !== 'AI Coach' ? 'white' : 'black';
    const reviewPlayerName = reviewPlayerColor === 'white' ? reviewGame.white : reviewGame.black;
    const reviewOpponentRating = reviewPlayerColor === 'white' ? (reviewGame.blackElo ?? 1500) : (reviewGame.whiteElo ?? 1500);
    const reviewPlayerRating = reviewPlayerColor === 'white' ? (reviewGame.whiteElo ?? playerRating) : (reviewGame.blackElo ?? playerRating);

    return (
      <div className="flex flex-col md:flex-row h-full overflow-hidden" data-testid="coach-game-page">
        <CoachGameReview
          moves={reviewMoves}
          keyMoments={[]}
          playerColor={reviewPlayerColor}
          result={reviewGame.result}
          openingName={reviewGame.openingId}
          playerName={reviewPlayerName}
          playerRating={reviewPlayerRating}
          opponentRating={reviewOpponentRating}
          onPlayAgain={() => void navigate('/coach/play')}
          onBackToCoach={() => void navigate(startMoveParam ? '/coach/report' : '/coach')}
          isGuidedLesson
          pgn={reviewGame.pgn}
          initialMoveIndex={startMoveParam ? parseInt(startMoveParam, 10) : undefined}
        />
      </div>
    );
  }

  // Game-over overlay — show final position with checkmate/result before review
  if (gameState.status === 'gameover') {
    const resultLabel = gameState.result === 'win' ? 'Victory!' : gameState.result === 'loss' ? 'Defeat' : 'Draw';
    const resultColor = gameState.result === 'win' ? 'var(--color-success)' : gameState.result === 'loss' ? 'var(--color-error)' : 'var(--color-warning)';
    const resultDetail = game.isCheckmate
      ? 'Checkmate'
      : game.isStalemate
        ? 'Stalemate'
        : game.isDraw
          ? 'Draw'
          : 'Game Over';

    return (
      <div className="flex flex-col md:flex-row h-full overflow-hidden" data-testid="coach-game-page">
        <div className="flex flex-col flex-1 items-center justify-center min-h-0 relative">
          {/* Opponent info */}
          <div className="px-2 pt-1 w-full md:max-w-[460px]">
            <PlayerInfoBar
              name={opponentName}
              rating={targetStrength}
              isBot
              capturedPieces={isPlayerWhite ? capturedPieces.black : capturedPieces.white}
              materialAdvantage={isPlayerWhite ? Math.max(0, -materialAdv) : Math.max(0, materialAdv)}
              isActive={false}
            />
          </div>

          {/* Board with overlay */}
          <div className="px-2 py-1 flex justify-center relative w-full">
            <div className="w-full md:max-w-[420px] relative">
              <ChessBoard
                initialFen={game.fen}
                orientation={playerColor}
                interactive={false}
                showEvalBar={showEvalBarEffective}
                evaluation={latestEval}
                isMate={latestIsMate}
                mateIn={latestMateIn}
                showFlipButton={false}
                highlightSquares={coachLastMove}
              />
              {/* Result overlay */}
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
              >
                <div
                  className="rounded-2xl px-8 py-5 flex flex-col items-center gap-1 shadow-2xl"
                  style={{
                    background: 'rgba(0, 0, 0, 0.75)',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  <span className="text-3xl font-black tracking-tight" style={{ color: resultColor }}>
                    {resultLabel}
                  </span>
                  <span className="text-sm font-medium text-white/80">
                    {resultDetail}
                  </span>
                </div>
              </motion.div>
            </div>
          </div>

          {/* Player info */}
          <div className="px-2 w-full md:max-w-[460px]">
            <PlayerInfoBar
              name={playerName}
              rating={playerRating}
              capturedPieces={isPlayerWhite ? capturedPieces.white : capturedPieces.black}
              materialAdvantage={isPlayerWhite ? Math.max(0, materialAdv) : Math.max(0, -materialAdv)}
              isActive={false}
            />
          </div>

          {/* Skip to review button */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.5 }}
            className="mt-4"
          >
            <button
              onClick={() => setGameState((prev) => ({ ...prev, status: 'postgame' }))}
              className="px-4 py-2 rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              data-testid="skip-to-review-btn"
            >
              Review Game &rarr;
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  // Post-game review — same two-column layout as gameplay
  if (gameState.status === 'postgame') {
    return (
      <div className="flex flex-col md:flex-row h-full overflow-hidden" data-testid="coach-game-page">
        <CoachGameReview
          moves={gameState.moves}
          keyMoments={gameState.keyMoments}
          playerColor={playerColor}
          result={gameState.result === 'ongoing' ? 'draw' : gameState.result}
          openingName={detectedOpening?.name ?? null}
          playerName={playerName}
          playerRating={playerRating}
          opponentRating={targetStrength}
          onPlayAgain={() => {
            game.resetGame();
            moveCountRef.current = 0;
            // Reset phase-transition ledger for the fresh game
            // (WO-PHASE-NARRATION-01).
            phaseStateRef.current = createPhaseTransitionState();
            openingIntroSpokenRef.current = false;
            setGameState({
              gameId: `game-${Date.now()}`,
              playerColor,
              targetStrength,
              moves: [],
              hintsUsed: 0,
              currentHintLevel: 0,
              takebacksUsed: 0,
              status: 'playing',
              result: 'ongoing',
              keyMoments: [],
            });
            setLatestEval(0);
            setLatestIsMate(false);
            setLatestMateIn(null);
            setViewedMoveIndex(null);
            // WO-COACH-MEMORY-UNIFY-01: "play again" keeps the prior
            // opening intent. A user who just finished a Caro-Kann
            // game tapping Play Again expects another Caro-Kann.
            resetHints();
            prevNudgeRef.current = null;
          }}
          onBackToCoach={() => void navigate('/coach')}
          onPracticeInChat={handlePracticeInChat}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden" data-testid="coach-game-page">
      {/* Left column: board + controls */}
      <div className="flex flex-col flex-none md:w-3/5 min-h-0 overflow-y-auto">
        {/* Header — two rows for compact mobile layout */}
        <div className="px-3 py-2 md:p-4 border-b border-theme-border space-y-1.5">
          {/* Row 1: Back + title + color selector + analysis toggles */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3">
              <button onClick={() => void navigate('/coach')} className="p-2 rounded-lg hover:bg-theme-surface min-w-[44px] min-h-[44px] flex items-center justify-center">
                <ArrowLeft size={20} className="text-theme-text" />
              </button>
              <div>
                <h2 className="text-sm font-semibold text-theme-text">
                  vs Stockfish Bot
                </h2>
                <p className="text-xs text-theme-text-muted">
                  ~{targetStrength} ELO
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 md:gap-2">
              {/* Color selector */}
              <div className="flex items-center gap-0.5 rounded-lg border border-theme-border p-0.5" data-testid="color-selector">
                <button
                  onClick={() => handleColorChange('white')}
                  disabled={gameState.moves.length > 0}
                  className={`w-6 h-6 md:w-7 md:h-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-40 ${
                    playerColor === 'white' ? 'ring-2 ring-theme-accent ring-inset' : ''
                  }`}
                  aria-label="Play as white"
                  data-testid="color-white-btn"
                >
                  <div className="w-3.5 h-3.5 md:w-4 md:h-4 rounded-full bg-white border border-neutral-300" />
                </button>
                <button
                  onClick={() => handleColorChange('black')}
                  disabled={gameState.moves.length > 0}
                  className={`w-6 h-6 md:w-7 md:h-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-40 ${
                    playerColor === 'black' ? 'ring-2 ring-theme-accent ring-inset' : ''
                  }`}
                  aria-label="Play as black"
                  data-testid="color-black-btn"
                >
                  <div className="w-3.5 h-3.5 md:w-4 md:h-4 rounded-full bg-neutral-800 border border-neutral-600" />
                </button>
              </div>
              <AnalysisToggles
                showEvalBar={showEvalBarEffective}
                onToggleEvalBar={() => setEvalBarOverride((prev) => !(prev ?? settings.showEvalBar))}
                showEngineLines={showEngineLinesEffective}
                onToggleEngineLines={() => setEngineLinesOverride((prev) => !(prev ?? settings.showEngineLines))}
              />
            </div>
          </div>
          {/* Row 2: Difficulty toggle + Chat + Coach Tips buttons. Chat
              is a permanent fixture matching CoachTeachPage's layout
              per user request — both coach tabs surface the chat
              opener in the same place. */}
          <div className="flex items-center justify-between pl-12 md:pl-14">
            <DifficultyToggle
              value={difficulty}
              onChange={setDifficulty}
              disabled={gameState.moves.length > 0}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => useAppStore.getState().setCoachDrawerOpen(true)}
                className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-all duration-200"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg)',
                  borderTop: '1px solid rgba(201, 168, 76, 0.3)',
                  borderRight: '1px solid rgba(201, 168, 76, 0.3)',
                  borderLeft: '2px solid rgba(201, 168, 76, 0.8)',
                  borderBottom: '2px solid rgba(201, 168, 76, 0.8)',
                  boxShadow: '0 0 8px rgba(201, 168, 76, 0.6), 0 0 18px rgba(201, 168, 76, 0.35), 0 0 30px rgba(201, 168, 76, 0.2)',
                }}
                aria-label="Open chat"
                data-testid="play-chat-button"
              >
                <MessageCircle size={16} />
                <span className="hidden sm:inline">Chat</span>
              </button>
              <button
                onClick={toggleCoachTips}
                className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-all duration-200"
                style={{
                  background: coachTipsOn ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: coachTipsOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
                  borderTop: coachTipsOn ? '1px solid rgba(201, 168, 76, 0.3)' : '1px solid var(--color-border)',
                  borderRight: coachTipsOn ? '1px solid rgba(201, 168, 76, 0.3)' : '1px solid var(--color-border)',
                  borderLeft: coachTipsOn ? '2px solid rgba(201, 168, 76, 0.8)' : '2px solid rgba(234, 179, 8, 0.5)',
                  borderBottom: coachTipsOn ? '2px solid rgba(201, 168, 76, 0.8)' : '2px solid rgba(234, 179, 8, 0.5)',
                  boxShadow: coachTipsOn
                    ? '0 0 8px rgba(201, 168, 76, 0.6), 0 0 18px rgba(201, 168, 76, 0.35), 0 0 30px rgba(201, 168, 76, 0.2)'
                    : '0 0 6px rgba(234, 179, 8, 0.35), 0 0 14px rgba(234, 179, 8, 0.2), 0 0 24px rgba(234, 179, 8, 0.1)',
                }}
                aria-label={coachTipsOn ? 'Disable coach tips' : 'Enable coach tips'}
                aria-pressed={coachTipsOn}
                data-testid="coach-tips-toggle"
              >
                <Lightbulb size={16} />
                <span className="hidden sm:inline">Tips</span>
              </button>
            </div>
          </div>
        </div>

        {/* Opponent info bar (top) */}
        <div className="px-2 pt-1">
          <PlayerInfoBar
            name={opponentName}
            rating={targetStrength}
            isBot
            capturedPieces={isPlayerWhite ? capturedPieces.black : capturedPieces.white}
            materialAdvantage={isPlayerWhite ? Math.max(0, -materialAdv) : Math.max(0, materialAdv)}
            isActive={!isPlayerTurn && !game.isGameOver}
          />
        </div>

        {/* Temporary position banner */}
        <AnimatePresence>
          {temporaryFen && !practicePosition && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="rounded-lg mx-2 mt-1 p-2.5 flex items-center justify-between overflow-hidden"
              style={{ background: 'color-mix(in srgb, var(--color-accent) 15%, var(--color-surface))' }}
              data-testid="temp-position-banner"
            >
              <div className="flex items-center gap-2">
                <Eye size={14} style={{ color: 'var(--color-accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  {temporaryLabel}
                </span>
              </div>
              <button
                onClick={handleBackToGame}
                className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="back-to-game-btn"
              >
                Back to Game
              </button>
            </motion.div>
          )}
          {practicePosition && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="rounded-lg mx-2 mt-1 p-2.5 flex items-center justify-between overflow-hidden"
              style={{ background: 'color-mix(in srgb, var(--color-success) 15%, var(--color-surface))' }}
              data-testid="practice-position-banner"
            >
              <div className="flex items-center gap-2">
                <Eye size={14} style={{ color: 'var(--color-success, var(--color-accent))' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  Practice: {practicePosition.label}
                </span>
              </div>
              <button
                onClick={handleBackToGame}
                className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                data-testid="exit-practice-btn"
              >
                Back to Game
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Tip Bubble (now flows ABOVE the board, no overlay) ────────
             Previously this was `absolute top-0` on top of the board so
             the user couldn't see/move the pieces underneath. Moved
             to a normal block-flow sibling above the board container.
             User report: tactic preview popup covered the board. */}
        <AnimatePresence>
          {tipBubbleText && gameState.status !== 'blunder_pause' && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
              className={`mx-2 mb-1 rounded-xl backdrop-blur-md border px-3 py-2.5 shrink-0 ${
                isExploreMode
                  ? 'border-purple-500/30'
                  : tipTacticLine && !tipTacticLine.forPlayer
                    ? 'border-red-500/30'
                    : 'border-blue-500/30'
              }`}
              style={{
                background: isExploreMode
                  ? 'color-mix(in srgb, var(--color-bg) 85%, rgba(168, 85, 247, 0.3))'
                  : tipTacticLine && !tipTacticLine.forPlayer
                    ? 'color-mix(in srgb, var(--color-bg) 85%, rgba(239, 68, 68, 0.3))'
                    : 'color-mix(in srgb, var(--color-bg) 85%, rgba(59, 130, 246, 0.3))',
              }}
              data-testid="coach-tip-bubble"
            >
              {/* Header: icon + tip text */}
              <div className="flex items-start gap-2">
                {isExploreMode
                  ? <Compass size={16} className="text-purple-400 flex-shrink-0 mt-0.5" />
                  : tipTacticLine && !tipTacticLine.forPlayer
                    ? <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
                    : <GraduationCap size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-xs leading-relaxed line-clamp-3" style={{ color: 'var(--color-text)' }}>
                    {isExploreMode ? 'Explore Ahead — make moves freely and get coach reactions' : tipBubbleText}
                  </p>
                  {showingTacticLine && tipTacticLine && !isExploreMode && (
                    <p className="text-xs font-mono mt-1.5 font-semibold text-emerald-400" data-testid="tactic-line-moves">
                      {uciLinesToSan(tipTacticLine.uciMoves, tipTacticLine.fen, 6)}
                    </p>
                  )}
                </div>
              </div>

              {/* Show Mode: step navigation arrows */}
              {showingTacticLine && showFens.length > 0 && !isExploreMode && (
                <div className="flex items-center justify-center gap-3 mt-2" data-testid="show-step-nav">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleShowPrev(); }}
                    disabled={showIndex <= 0}
                    className="p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200"
                    aria-label="Previous show move"
                    data-testid="show-prev-btn"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }} data-testid="show-step-counter">
                    Move {showIndex + 1} of {showFens.length}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleShowNext(); }}
                    disabled={showIndex >= showFens.length - 1}
                    className="p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200"
                    aria-label="Next show move"
                    data-testid="show-next-btn"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}

              {/* Explore Mode: engine eval + scrollable coach reaction history */}
              {isExploreMode && (
                <div className="mt-2">
                  {/* Engine analysis bar */}
                  {exploreEval !== null && (
                    <div className="flex items-center gap-2 mb-2 px-1" data-testid="explore-engine-eval">
                      <span className="text-[10px] font-mono font-semibold" style={{ color: 'var(--color-text-muted)' }}>
                        Eval:
                      </span>
                      <span className={`text-[10px] font-mono font-bold ${
                        exploreIsMate
                          ? (exploreMateIn !== null && exploreMateIn > 0 ? 'text-emerald-400' : 'text-red-400')
                          : exploreEval > 50 ? 'text-emerald-400' : exploreEval < -50 ? 'text-red-400' : 'text-gray-400'
                      }`}>
                        {exploreIsMate ? `M${exploreMateIn}` : `${exploreEval > 0 ? '+' : ''}${(exploreEval / 100).toFixed(1)}`}
                      </span>
                      {exploreTopLines.length > 0 && exploreTopLines[0].moves.length > 0 && (
                        <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          Best: {(() => {
                            try { return uciMoveToSan(exploreTopLines[0].moves[0], exploreFen ?? ''); } catch { return exploreTopLines[0].moves[0]; }
                          })()}
                        </span>
                      )}
                    </div>
                  )}
                  {/* Scrollable reaction messages */}
                  <div
                    ref={exploreChatRef}
                    className="max-h-24 overflow-y-auto space-y-1.5 scrollbar-thin"
                    data-testid="explore-messages"
                  >
                    {exploreMessages.filter((m) => m.role === 'assistant').map((msg, i) => (
                      <p key={i} className="text-xs leading-relaxed px-1" style={{ color: 'var(--color-text)' }}>
                        {msg.content}
                      </p>
                    ))}
                    {isExploreReacting && (
                      <div className="flex items-center gap-1.5 px-1">
                        <Loader2 size={10} className="animate-spin text-purple-400" />
                        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Thinking...</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-2">
                {/* Show button — only when tactic line is available and not yet showing */}
                {tipTacticLine && !showingTacticLine && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleShowTactic(); }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all duration-200"
                    style={{
                      background: 'rgba(52, 211, 153, 0.15)',
                      color: 'rgb(52, 211, 153)',
                      border: '1px solid rgba(52, 211, 153, 0.3)',
                      boxShadow: '0 0 6px rgba(52, 211, 153, 0.2)',
                    }}
                    data-testid="show-tactic-line-btn"
                  >
                    <Eye size={12} />
                    Show
                  </button>
                )}
                {/* Explore from here button — available during show mode, not during explore */}
                {showingTacticLine && showIndex >= 0 && !isExploreMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEnterExplore(); }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all duration-200"
                    style={{
                      background: 'rgba(168, 85, 247, 0.15)',
                      color: 'rgb(168, 85, 247)',
                      border: '1px solid rgba(168, 85, 247, 0.3)',
                      boxShadow: '0 0 6px rgba(168, 85, 247, 0.2)',
                    }}
                    data-testid="explore-from-here-btn"
                  >
                    <Compass size={12} />
                    Explore from here
                  </button>
                )}
                {/* Dismiss button — always visible */}
                <button
                  onClick={handleDismissTip}
                  className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-colors"
                  style={{
                    background: 'rgba(148, 163, 184, 0.1)',
                    color: 'var(--color-text-muted)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                  }}
                  data-testid="dismiss-tip-btn"
                >
                  Dismiss
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Narration subtitle — reused for both "Read this position"
            (user-triggered) and phase-transition narration (auto).
            Position narration wins if both are active, but that's
            guarded out above so this is really just "whichever one is
            currently streaming." (WO-PHASE-NARRATION-01) */}
        <PositionNarrationBanner
          text={positionNarration.isNarrating || positionNarration.currentText
            ? positionNarration.currentText
            : phaseNarration.currentText}
          active={positionNarration.isNarrating || phaseNarration.isNarrating}
        />

        {/* Board — flex-shrink-0 so it never shrinks regardless of content above/below */}
        <div className="px-2 py-1 flex justify-center flex-shrink-0">
          <div className="w-full md:max-w-[420px] relative">
            <ChessBoard
              key={`${gameState.gameId}-${playerColor}-${practicePosition?.fen ?? ''}-${practiceAttempts}-${exploreFen ?? ''}`}
              initialFen={displayFen}
              orientation={playerColor}
              interactive={(gameState.status === 'playing' && !isCoachThinking && !temporaryFen && viewedMoveIndex === null && !positionNarration.isNarrating && !phaseNarration.isNarrating) || !!practicePosition || isExploreMode}
              onMove={handleBoardMoveRouted}
              showEvalBar={showEvalBarEffective || isExploreMode}
              evaluation={isExploreMode && exploreEval !== null ? exploreEval : latestEval}
              isMate={isExploreMode ? exploreIsMate : latestIsMate}
              mateIn={isExploreMode ? exploreMateIn : latestMateIn}
              moveQualityFlash={moveFlash}
              showFlipButton={false}
              showVoiceMic={false}
              highlightSquares={coachLastMove}
              arrows={[...hintState.arrows, ...annotationArrows, ...voiceArrows].length > 0 ? [...hintState.arrows, ...annotationArrows, ...voiceArrows] : undefined}
              annotationHighlights={annotationHighlights.length > 0 ? annotationHighlights : undefined}
              ghostMove={hintState.ghostMove}
              pgnForChat={game.history.join(' ')}
              onOpeningRequest={handleOpeningRequest}
              voiceEngineSnapshot={voiceEngineSnapshot}
              voiceLastMoveContext={voiceLastMoveContext}
              voicePlayerColor={playerColor}
              onVoiceActiveChange={setVoiceActive}
              onVoiceArrows={handleVoiceArrows}
            />

            {/* ─── Blunder Interception Overlay (on board) ──────────────────── */}
            <AnimatePresence>
              {gameState.status === 'blunder_pause' && blunderPause && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="absolute bottom-0 left-0 right-0 z-20 rounded-t-2xl border-t-2 border-x-2 border-red-500/40 backdrop-blur-md overflow-hidden"
                  style={{ background: 'color-mix(in srgb, var(--color-error, #ef4444) 12%, var(--color-bg) 88%)' }}
                  data-testid="blunder-interception"
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
                      <span className="font-bold text-red-400 text-sm">Blunder Detected</span>
                    </div>
                    <p className="text-xs leading-relaxed line-clamp-3" style={{ color: 'var(--color-text)' }}>
                      {blunderPause.explanation}
                    </p>
                  </div>
                  <div className="flex gap-2 px-3 pb-3">
                    <button
                      onClick={handleBlunderContinue}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold border border-theme-border transition-colors"
                      style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
                      data-testid="blunder-continue"
                    >
                      Continue
                    </button>
                    <button
                      onClick={handleBlunderTakeBack}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold transition-colors"
                      style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
                      data-testid="blunder-takeback"
                    >
                      Take Back
                    </button>
                    <button
                      onClick={handleBlunderTryBestMove}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold border-2 border-green-500/40 transition-colors"
                      style={{ background: 'color-mix(in srgb, var(--color-success, #22c55e) 15%, var(--color-surface))', color: 'var(--color-text)' }}
                      data-testid="blunder-try-best"
                    >
                      Try {blunderPause.bestMoveSan}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ─── Coach quiz banner (WO-COACH-LICHESS-OPENINGS) ───────── */}
            <AnimatePresence>
              {quizState.active && (
                <motion.div
                  initial={{ opacity: 0, y: -16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -16 }}
                  className="absolute top-0 left-0 right-0 z-20 rounded-b-2xl border-b-2 border-x-2 border-amber-500/40 backdrop-blur-md overflow-hidden"
                  style={{ background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 12%, var(--color-bg) 88%)' }}
                  data-testid="coach-quiz-banner"
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-1">
                      <GraduationCap size={16} className="text-amber-400 flex-shrink-0" />
                      <span className="font-bold text-amber-300 text-sm">Coach is asking</span>
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text)' }}>
                      {quizState.prompt}
                    </p>
                  </div>
                  <div className="flex gap-2 px-3 pb-3">
                    <button
                      onClick={() => cancelActiveQuizRef.current('user-dismissed')}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold border border-theme-border transition-colors"
                      style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}
                      data-testid="coach-quiz-dismiss"
                    >
                      Skip the quiz
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

          </div>
          {isExploreMode && exploreTopLines.length > 0 && (
            <EngineLines lines={exploreTopLines} fen={exploreFen ?? ''} className="mt-1" />
          )}
          {!isExploreMode && showEngineLinesEffective && latestTopLines.length > 0 && (
            <EngineLines lines={latestTopLines} fen={game.fen} className="mt-1" />
          )}
        </div>

        {/* Player info bar (bottom) — rating shown in header, omitted here */}
        <div className="px-2">
          <PlayerInfoBar
            name={playerName}
            capturedPieces={isPlayerWhite ? capturedPieces.white : capturedPieces.black}
            materialAdvantage={isPlayerWhite ? Math.max(0, materialAdv) : Math.max(0, -materialAdv)}
            isActive={isPlayerTurn && !game.isGameOver}
          />
        </div>

        {/* Controls */}
        {gameState.status === 'playing' && (
          <div className="flex flex-col gap-1.5 px-4 py-2 flex-shrink-0">
            {/* Row 1: Hint, Takeback, Resign — primary actions */}
            <div className="flex items-center justify-center gap-2">
              <HintButton
                currentLevel={hintState.level}
                onRequestHint={handleHint}
                disabled={isCoachThinking || hintState.isAnalyzing}
              />
              <button
                onClick={handleTakeback}
                disabled={gameState.moves.length === 0}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg border-2 border-amber-500/30 text-sm font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 disabled:opacity-30 transition-all duration-200"
                style={{ boxShadow: '0 0 10px rgba(245, 158, 11, 0.25), 0 0 3px rgba(245, 158, 11, 0.15)' }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 18px rgba(245, 158, 11, 0.45), 0 0 6px rgba(245, 158, 11, 0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.25), 0 0 3px rgba(245, 158, 11, 0.15)'; }}
                data-testid="takeback-btn"
              >
                <Undo2 size={16} />
                <span>Takeback</span>
              </button>
              <button
                onClick={() => handleRestart()}
                disabled={gameState.moves.length === 0}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg border-2 border-cyan-500/30 text-sm font-medium text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200"
                style={{ boxShadow: '0 0 10px rgba(6, 182, 212, 0.25), 0 0 3px rgba(6, 182, 212, 0.15)' }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 18px rgba(6, 182, 212, 0.45), 0 0 6px rgba(6, 182, 212, 0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 0 10px rgba(6, 182, 212, 0.25), 0 0 3px rgba(6, 182, 212, 0.15)'; }}
                data-testid="restart-btn"
                aria-label="Restart game"
              >
                <RotateCcw size={16} />
                <span>Restart</span>
              </button>
              <ResignButton onResign={handleResign} disabled={gameState.moves.length === 0} />
            </div>

            {/* Row 1.5: Read this position (coach narration) */}
            <div className="flex justify-center">
              <button
                onClick={handleReadPosition}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg border-2 border-emerald-500/30 text-sm font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all duration-200"
                style={{ boxShadow: '0 0 10px rgba(16, 185, 129, 0.25), 0 0 3px rgba(16, 185, 129, 0.15)' }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 18px rgba(16, 185, 129, 0.45), 0 0 6px rgba(16, 185, 129, 0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.25), 0 0 3px rgba(16, 185, 129, 0.15)'; }}
                data-testid="read-position-btn"
                aria-label={positionNarration.isNarrating ? 'Restart position narration' : 'Read this position aloud'}
              >
                {positionNarration.isNarrating ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Volume2 size={16} />
                )}
                <span>{positionNarration.isNarrating ? 'Reading…' : 'Read this position'}</span>
              </button>
            </div>

            {/* Row 2: Ask (voice) button */}
            <div className="flex justify-center">
              <VoiceChatMic
                fen={game.fen}
                pgn={game.history.join(' ')}
                turn={game.turn}
                onOpeningRequest={handleOpeningRequest}
                engineSnapshot={voiceEngineSnapshot}
                lastMoveContext={voiceLastMoveContext}
                playerColor={playerColor}
                onListeningChange={setVoiceActive}
                onArrows={handleVoiceArrows}
                onPlayMove={handleChatPlayMove}
                onTakeBackMove={handleChatTakeBackMove}
                onResetBoard={handleChatResetBoard}
                getMoveCount={() => game.history.length}
                getCurrentFen={() => game.fen}
              />
            </div>

            {/* Row 3: Move navigation */}
            <div className="flex items-center justify-center gap-0.5" data-testid="move-nav">
              <button
                onClick={goToFirstMove}
                disabled={gameState.moves.length === 0 || viewedMoveIndex === -1}
                className="p-2 md:p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200 min-w-[44px] min-h-[44px] flex items-center justify-center"
                aria-label="First move"
                data-testid="nav-first"
              >
                <ChevronsLeft size={16} />
              </button>
              <button
                onClick={goToPrevMove}
                disabled={gameState.moves.length === 0 || viewedMoveIndex === -1}
                className="p-2 md:p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200 min-w-[44px] min-h-[44px] flex items-center justify-center"
                aria-label="Previous move"
                data-testid="nav-prev"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={goToNextMove}
                disabled={gameState.moves.length === 0 || viewedMoveIndex === null}
                className="p-2 md:p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200 min-w-[44px] min-h-[44px] flex items-center justify-center"
                aria-label="Next move"
                data-testid="nav-next"
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={goToLastMove}
                disabled={gameState.moves.length === 0 || viewedMoveIndex === null}
                className="p-2 md:p-1.5 rounded-md text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 transition-all duration-200 min-w-[44px] min-h-[44px] flex items-center justify-center"
                aria-label="Last move"
                data-testid="nav-last"
              >
                <ChevronsRight size={16} />
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Right column: chat (mobile = inline below board, desktop =
          move list + divider + chat). Mirrors the Learn-with-coach
          layout so both surfaces feel like one room — chat input
          pinned, reverse-flow messages below. */}
      <div
        ref={rightColumnRef}
        className="flex flex-col flex-1 min-h-0 border-t md:border-t-0 md:border-l border-theme-border bg-theme-bg md:overflow-hidden"
      >
        {!isMobile && (
          <>
            <div
              className="min-h-0 overflow-hidden"
              style={{ height: `${100 - chatPercent}%` }}
            >
              <MoveListPanel
                moves={gameState.moves}
                openingName={detectedOpening?.name ?? null}
                currentMoveIndex={viewedMoveIndex !== null ? viewedMoveIndex : (gameState.moves.length > 0 ? gameState.moves.length - 1 : null)}
                className="h-full"
              />
            </div>

            <div
              className="flex-shrink-0 h-1.5 bg-theme-border hover:bg-theme-accent/50 cursor-row-resize flex items-center justify-center transition-colors"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              data-testid="panel-divider"
            >
              <div className="w-8 h-0.5 rounded-full bg-theme-text-muted/40" />
            </div>
          </>
        )}

        <div
          className={isMobile ? 'flex-1 min-h-0 overflow-hidden' : 'min-h-[120px] overflow-hidden'}
          style={isMobile ? undefined : { height: `${chatPercent}%` }}
        >
            <GameChatPanel
              ref={gameChatRef}
              fen={game.fen}
              pgn={game.history.join(' ')}
              moveNumber={moveCountRef.current}
              playerColor={playerColor}
              turn={game.turn}
              isGameOver={game.isGameOver}
              gameResult={gameState.result}
              lastMove={game.lastMove && game.history.length > 0 ? { ...game.lastMove, san: game.history[game.history.length - 1] } : undefined}
              lastMoveBy={lastMoveBy}
              history={game.history}
              previousFen={previousFenRef.current}
              onBoardAnnotation={handleBoardAnnotation}
              onRestartGame={handleRestart}
              onPlayOpening={handleOpeningRequest}
              onPlayMove={handleChatPlayMove}
              onTakeBackMove={handleChatTakeBackMove}
              onSetBoardPosition={handleChatSetBoardPosition}
              onResetBoard={handleChatResetBoard}
              onQuizUserForMove={handleQuizUserForMove}
              onStartWalkthroughForOpening={handleStartWalkthroughForOpening}
              onPlayVariation={handlePlayVariation}
              onReturnToGame={handleReturnToGame}
              initialPrompt={pendingChatPrompt}
              initialMessages={initialChatMessages ?? undefined}
              onMessagesUpdate={handleChatMessagesUpdate}
              className="h-full"
            />
          </div>
      </div>
    </div>
  );
}
