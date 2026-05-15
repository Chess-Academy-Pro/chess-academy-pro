/**
 * SrsTrainerPage — Chessable MoveTrainer-style daily review, two modes.
 *
 * **Card mode** (default — "one easy answer"): one position per card,
 * SM-2 schedules each position independently. On each card the board
 * first plays IN the moves leading up to the position (animated, ~ply
 * cadence), pauses on the student's prompt, the student answers, and
 * the trainer advances to the next card. Voice-silent (drill rule 8).
 *
 * **Line mode** (Woodpecker — "full line for the challenge"): groups
 * due cards by `(openingId, variationName)` and plays the WHOLE line
 * move-by-move — opponent moves auto-play, student plays each of
 * their moves in sequence. On a wrong move the board reverts and the
 * student retries that ply. At line end each position writes SM-2
 * based on its first-attempt outcome. Same scheduler as card mode —
 * the difference is purely how cards are presented for review.
 *
 * Top-of-board tab toggles between modes mid-session — switching
 * exits the current run and starts fresh in the new mode.
 *
 * Board surface: `ConsistentChessboard` controlled mode via
 * `useChessGame` — all user settings (highlight-last-move, animation
 * speed, color scheme, piece set, move method) apply automatically.
 *
 * Narration: silent. NO `voiceService.speak` call. Feedback uses
 * green/red board overlays + a compact info strip (book line + next-
 * review window only). No "Correct!" / "Wrong!" praise text — per
 * CLAUDE.md rule 5 the position changing IS the acknowledgment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Sparkles,
  Trophy,
  BookOpen,
  Layers,
  Clock,
  Zap,
  GraduationCap,
} from 'lucide-react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { useChessGame, type MoveResult } from '../../hooks/useChessGame';
import { useSettings } from '../../hooks/useSettings';
import type { MoveQuality } from '../Board/ChessBoard';
import {
  type DueLine,
  getDueCards,
  getDueCount,
  getDueLines,
  getEnrolledOpenings,
  getTotalEnrolled,
  normalizeSan,
  recordReview,
} from '../../services/srsOpeningService';
import { getOpeningById } from '../../services/openingService';
import { logAppAudit } from '../../services/appAuditor';
import type { OpeningRecord, SrsOpeningCard } from '../../types';

type Mode = 'card' | 'line';

type CardPhase = 'idle' | 'playing-in' | 'waiting' | 'correct' | 'wrong' | 'complete';
type LinePhase = 'idle' | 'opponent' | 'waiting' | 'wrong' | 'between-lines' | 'all-complete';

interface EnrolledRow {
  opening: OpeningRecord | undefined;
  openingId: string;
  totalCards: number;
  dueCards: number;
}

interface LineMove {
  san: string;
  from: string;
  to: string;
  promotion?: string;
  /** True if this ply is the student's turn — only those are quizzed. */
  isStudent: boolean;
  /** The card that owns this ply (when isStudent === true). */
  card?: SrsOpeningCard;
}

const CARD_SESSION_LIMIT = 20;
const LINE_SESSION_LIMIT = 5;
const FEEDBACK_MS = 1100;
const FLASH_MS = 600;
const PLAY_IN_PLY_MS = 320;
const OPPONENT_MS = 500;
const LINE_WRONG_REVERT_MS = 1100;

function describeInterval(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days} days`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${Math.round(days / 365)} years`;
}

/** Parse a PGN into per-ply move records keyed against a list of
 *  cards. The N-th student ply lines up with the N-th card in
 *  `cards` (cards are pre-sorted by pgnPrefix length ASC). */
function parseLineMoves(
  fullPgn: string,
  studentColor: 'white' | 'black',
  cards: SrsOpeningCard[],
): LineMove[] {
  const tokens = fullPgn.trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  const out: LineMove[] = [];
  const studentTurn = studentColor === 'white' ? 'w' : 'b';
  let cardIdx = 0;
  for (const san of tokens) {
    const isStudent = chess.turn() === studentTurn;
    let m: ReturnType<Chess['move']>;
    try {
      m = chess.move(san);
    } catch {
      break;
    }
    if (!m) break;
    out.push({
      san: m.san,
      from: m.from,
      to: m.to,
      promotion: m.promotion,
      isStudent,
      card: isStudent ? cards[cardIdx++] : undefined,
    });
  }
  return out;
}

export function SrsTrainerPage(): JSX.Element {
  const navigate = useNavigate();
  const { settings } = useSettings();

  // ─── Hub state ────────────────────────────────────────────────────────
  const [dueCount, setDueCount] = useState<number>(0);
  const [totalEnrolled, setTotalEnrolled] = useState<number>(0);
  const [enrolled, setEnrolled] = useState<EnrolledRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // ─── Mode (Card / Line) ───────────────────────────────────────────────
  // Persisted only in session state; default 'card' (the easier mode).
  const [mode, setMode] = useState<Mode>('card');

  // ─── Card-mode session state ──────────────────────────────────────────
  const [cardQueue, setCardQueue] = useState<SrsOpeningCard[]>([]);
  const [cardIndex, setCardIndex] = useState<number>(0);
  const [cardPhase, setCardPhase] = useState<CardPhase>('idle');
  const [cardCorrect, setCardCorrect] = useState<number>(0);
  const [cardWrong, setCardWrong] = useState<number>(0);
  const [feedback, setFeedback] = useState<
    { kind: 'correct' | 'wrong'; expectedSan: string; intervalDays: number } | null
  >(null);
  const [moveFlash, setMoveFlash] = useState<MoveQuality>(null);
  const lastCardIdRef = useRef<string | null>(null);

  // ─── Line-mode session state ──────────────────────────────────────────
  const [lineQueue, setLineQueue] = useState<DueLine[]>([]);
  const [lineIndex, setLineIndex] = useState<number>(0);
  const [lineMoves, setLineMoves] = useState<LineMove[]>([]);
  const [lineMoveIndex, setLineMoveIndex] = useState<number>(0);
  const [linePhase, setLinePhase] = useState<LinePhase>('idle');
  /** Per-card first-attempt outcomes for this run. Persisted to SM-2 at
   *  line end. `true` = correct on first attempt; `false` = a wrong
   *  move was played for this card (even if the student later got the
   *  retry right). */
  const lineResultsRef = useRef<Map<string, boolean>>(new Map());
  const [linesPerfected, setLinesPerfected] = useState<number>(0);
  const [linesAttempted, setLinesAttempted] = useState<number>(0);
  const [lineMistakes, setLineMistakes] = useState<number>(0);
  const [lineFlash, setLineFlash] = useState<MoveQuality>(null);

  // ─── Single chess game instance reused across both modes ─────────────
  const game = useChessGame();

  const activeCard = cardQueue[cardIndex];
  const activeLine = lineQueue[lineIndex];

  // ─── Hub loader ──────────────────────────────────────────────────────
  const loadHub = useCallback(async (): Promise<void> => {
    const [due, total, rows] = await Promise.all([
      getDueCount(),
      getTotalEnrolled(),
      getEnrolledOpenings(),
    ]);
    const hydrated: EnrolledRow[] = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        opening: await getOpeningById(r.openingId),
      })),
    );
    hydrated.sort((a, b) => b.dueCards - a.dueCards || b.totalCards - a.totalCards);
    setDueCount(due);
    setTotalEnrolled(total);
    setEnrolled(hydrated);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadHub();
  }, [loadHub]);

  // ═══════════════════════════════════════════════════════════════════════
  // CARD MODE
  // ═══════════════════════════════════════════════════════════════════════

  /** Play in the moves leading up to `card.fenBefore`, animated at
   *  ~PLAY_IN_PLY_MS per ply. Doesn't call voiceService. Cancellable
   *  via lastCardIdRef. */
  const playInCard = useCallback(
    async (card: SrsOpeningCard): Promise<void> => {
      game.reset();
      game.setOrientation(card.studentColor);
      const moves = card.pgnPrefix.trim().split(/\s+/).filter(Boolean);
      if (moves.length === 0) {
        // No prior moves — card is at the starting position. Just
        // unlock interactive immediately, no animation needed.
        setCardPhase('waiting');
        return;
      }
      setCardPhase('playing-in');
      const chess = new Chess();
      for (const san of moves) {
        // Guard: another card became active while we were animating.
        if (lastCardIdRef.current !== card.id) return;
        await new Promise((r) => setTimeout(r, PLAY_IN_PLY_MS));
        let m: ReturnType<Chess['move']>;
        try {
          m = chess.move(san);
        } catch {
          break;
        }
        if (!m) break;
        // Push the move through the controlled game so the board
        // animates (uses the user's pieceAnimationSpeed setting).
        game.makeMove(m.from, m.to, m.promotion);
      }
      // Small breath before unlocking — gives the eye time to register
      // the final position before the student is expected to respond.
      await new Promise((r) => setTimeout(r, 320));
      if (lastCardIdRef.current !== card.id) return;
      setCardPhase('waiting');
    },
    [game],
  );

  // Watch for active card changes in card mode. Don't refire on
  // unrelated state updates — only when the active card's id changes.
  useEffect(() => {
    if (mode !== 'card') return;
    if (!activeCard) {
      lastCardIdRef.current = null;
      return;
    }
    if (cardPhase === 'idle' || cardPhase === 'complete') return;
    if (lastCardIdRef.current === activeCard.id) return;
    lastCardIdRef.current = activeCard.id;
    void playInCard(activeCard);
  }, [mode, activeCard, cardPhase, playInCard]);

  const startCardSession = useCallback(async (): Promise<void> => {
    const cards = await getDueCards(CARD_SESSION_LIMIT);
    if (cards.length === 0) return;
    setCardQueue(cards);
    setCardIndex(0);
    setCardCorrect(0);
    setCardWrong(0);
    setFeedback(null);
    setMoveFlash(null);
    setCardPhase('playing-in');
    lastCardIdRef.current = null;
    void logAppAudit({
      kind: 'srs-session-start',
      category: 'subsystem',
      source: 'SrsTrainerPage.startCardSession',
      summary: `card-mode session — ${cards.length} cards`,
    });
  }, []);

  const advanceCard = useCallback((): void => {
    setFeedback(null);
    if (cardIndex + 1 >= cardQueue.length) {
      setCardPhase('complete');
      void loadHub();
      void logAppAudit({
        kind: 'srs-session-complete',
        category: 'subsystem',
        source: 'SrsTrainerPage.advanceCard',
        summary: `card-mode complete — ${cardCorrect} / ${cardWrong}`,
      });
      return;
    }
    setCardIndex((i) => i + 1);
    // The card-change effect will trigger the play-in for the new card.
    // Set phase to 'playing-in' so the interactive flag stays off
    // during the transition.
    setCardPhase('playing-in');
  }, [cardIndex, cardQueue.length, loadHub, cardCorrect, cardWrong]);

  const handleCardMove = useCallback(
    (result: MoveResult): void => {
      if (!activeCard || cardPhase !== 'waiting') return;
      const correct = normalizeSan(result.san) === activeCard.expectedSan;
      if (settings.moveQualityFlash) {
        setMoveFlash(correct ? 'good' : 'blunder');
        setTimeout(() => setMoveFlash(null), FLASH_MS);
      }
      void (async () => {
        const next = await recordReview(activeCard.id, correct);
        if (correct) {
          setCardCorrect((c) => c + 1);
          setCardPhase('correct');
        } else {
          setCardWrong((w) => w + 1);
          setCardPhase('wrong');
        }
        setFeedback({
          kind: correct ? 'correct' : 'wrong',
          expectedSan: activeCard.expectedSan,
          intervalDays: next?.intervalDays ?? activeCard.intervalDays,
        });
        if (!correct) {
          setTimeout(() => game.reset(activeCard.fenBefore), 400);
        }
        setTimeout(advanceCard, FEEDBACK_MS);
      })();
    },
    [activeCard, cardPhase, settings.moveQualityFlash, game, advanceCard],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LINE MODE
  // ═══════════════════════════════════════════════════════════════════════

  const startLineSession = useCallback(async (): Promise<void> => {
    const lines = await getDueLines(LINE_SESSION_LIMIT);
    if (lines.length === 0) return;
    setLineQueue(lines);
    setLineIndex(0);
    setLineMoveIndex(0);
    setLineMistakes(0);
    setLinesPerfected(0);
    setLinesAttempted(0);
    lineResultsRef.current = new Map();
    setLineFlash(null);
    const first = lines[0];
    const moves = parseLineMoves(first.fullPgn, first.studentColor, first.cards);
    setLineMoves(moves);
    // Mark all student plies as "correct so far" — flipped to false on
    // first wrong attempt at that position.
    for (const m of moves) {
      if (m.card) lineResultsRef.current.set(m.card.id, true);
    }
    game.reset();
    game.setOrientation(first.studentColor);
    setLinePhase(moves[0]?.isStudent ? 'waiting' : 'opponent');
    void logAppAudit({
      kind: 'srs-session-start',
      category: 'subsystem',
      source: 'SrsTrainerPage.startLineSession',
      summary: `line-mode session — ${lines.length} lines`,
    });
  }, [game]);

  /** Move to next line in the queue, or end the session. */
  const advanceToNextLine = useCallback(
    async (perfect: boolean): Promise<void> => {
      // Persist SM-2 for every card in the finished line.
      const finishedLine = lineQueue[lineIndex];
      if (finishedLine) {
        for (const card of finishedLine.cards) {
          const wasCorrect = lineResultsRef.current.get(card.id) ?? true;
          await recordReview(card.id, wasCorrect);
        }
      }
      setLinesAttempted((n) => n + 1);
      if (perfect) setLinesPerfected((n) => n + 1);
      if (lineIndex + 1 >= lineQueue.length) {
        setLinePhase('all-complete');
        void loadHub();
        void logAppAudit({
          kind: 'srs-session-complete',
          category: 'subsystem',
          source: 'SrsTrainerPage.advanceToNextLine',
          summary: `line-mode complete — ${linesPerfected + (perfect ? 1 : 0)} / ${linesAttempted + 1} perfected`,
        });
        return;
      }
      const next = lineQueue[lineIndex + 1];
      setLineIndex((n) => n + 1);
      setLineMoveIndex(0);
      setLineMistakes(0);
      lineResultsRef.current = new Map();
      const moves = parseLineMoves(next.fullPgn, next.studentColor, next.cards);
      setLineMoves(moves);
      for (const m of moves) {
        if (m.card) lineResultsRef.current.set(m.card.id, true);
      }
      game.reset();
      game.setOrientation(next.studentColor);
      setLinePhase(moves[0]?.isStudent ? 'waiting' : 'opponent');
    },
    [lineQueue, lineIndex, loadHub, game, linesPerfected, linesAttempted],
  );

  // Opponent auto-play handler — fires when phase = 'opponent'.
  useEffect(() => {
    if (mode !== 'line') return;
    if (linePhase !== 'opponent') return;
    if (lineMoveIndex >= lineMoves.length) return;
    const move = lineMoves[lineMoveIndex];
    if (move.isStudent) {
      setLinePhase('waiting');
      return;
    }
    const t = setTimeout(() => {
      game.makeMove(move.from, move.to, move.promotion);
      const nextIdx = lineMoveIndex + 1;
      setLineMoveIndex(nextIdx);
      if (nextIdx >= lineMoves.length) {
        // Line is over (last ply was opponent's — shouldn't happen
        // in our PGN extractor but defensive).
        const perfect = lineMistakes === 0;
        void advanceToNextLine(perfect);
        return;
      }
      setLinePhase(lineMoves[nextIdx].isStudent ? 'waiting' : 'opponent');
    }, OPPONENT_MS);
    return () => clearTimeout(t);
  }, [mode, linePhase, lineMoveIndex, lineMoves, game, lineMistakes, advanceToNextLine]);

  const handleLineMove = useCallback(
    (result: MoveResult): void => {
      if (linePhase !== 'waiting') return;
      const expected = lineMoves[lineMoveIndex];
      if (!expected || !expected.isStudent) return;
      const correct = normalizeSan(result.san) === normalizeSan(expected.san);
      if (settings.moveQualityFlash) {
        setLineFlash(correct ? 'good' : 'blunder');
        setTimeout(() => setLineFlash(null), FLASH_MS);
      }
      if (!correct) {
        if (expected.card) lineResultsRef.current.set(expected.card.id, false);
        setLineMistakes((n) => n + 1);
        setLinePhase('wrong');
        // Revert after a brief delay so the student sees their attempt
        // then the correct position to retry. Same UX shape as Practice
        // mode (auto-takeback).
        setTimeout(() => {
          // Walk back the wrong move using chess.js to compute the FEN
          // before the attempt.
          const c = new Chess();
          for (let i = 0; i < lineMoveIndex; i++) {
            c.move(lineMoves[i].san);
          }
          game.reset(c.fen());
          game.setOrientation(expected.card?.studentColor ?? 'white');
          setLinePhase('waiting');
        }, LINE_WRONG_REVERT_MS);
        return;
      }
      // Correct — student's move stays on the board. Advance ply.
      const nextIdx = lineMoveIndex + 1;
      setLineMoveIndex(nextIdx);
      if (nextIdx >= lineMoves.length) {
        const perfect = lineMistakes === 0;
        setLinePhase('between-lines');
        setTimeout(() => void advanceToNextLine(perfect), 700);
        return;
      }
      setLinePhase(lineMoves[nextIdx].isStudent ? 'waiting' : 'opponent');
    },
    [linePhase, lineMoves, lineMoveIndex, settings.moveQualityFlash, game, lineMistakes, advanceToNextLine],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Mode toggle helpers
  // ═══════════════════════════════════════════════════════════════════════

  const exitToHub = useCallback((): void => {
    // Reset both mode state machines
    setCardQueue([]);
    setCardIndex(0);
    setCardPhase('idle');
    setCardCorrect(0);
    setCardWrong(0);
    setFeedback(null);
    setMoveFlash(null);
    lastCardIdRef.current = null;
    setLineQueue([]);
    setLineIndex(0);
    setLineMoves([]);
    setLineMoveIndex(0);
    setLineMistakes(0);
    setLinesPerfected(0);
    setLinesAttempted(0);
    setLinePhase('idle');
    setLineFlash(null);
    lineResultsRef.current = new Map();
    void loadHub();
  }, [loadHub]);

  const switchModeMidSession = useCallback(
    (next: Mode): void => {
      if (next === mode) return;
      const wasInSession =
        (mode === 'card' && cardPhase !== 'idle' && cardPhase !== 'complete') ||
        (mode === 'line' && linePhase !== 'idle' && linePhase !== 'all-complete');
      // Reset both runners — switching always exits the in-flight run.
      setCardQueue([]);
      setCardIndex(0);
      setCardPhase('idle');
      setCardCorrect(0);
      setCardWrong(0);
      setFeedback(null);
      setMoveFlash(null);
      lastCardIdRef.current = null;
      setLineQueue([]);
      setLineIndex(0);
      setLineMoves([]);
      setLineMoveIndex(0);
      setLineMistakes(0);
      setLinesPerfected(0);
      setLinesAttempted(0);
      setLinePhase('idle');
      setLineFlash(null);
      lineResultsRef.current = new Map();
      setMode(next);
      if (wasInSession) {
        // Auto-start the new mode so the user doesn't have to bounce
        // back to the hub.
        if (next === 'card') {
          void startCardSession();
        } else {
          void startLineSession();
        }
      }
    },
    [mode, cardPhase, linePhase, startCardSession, startLineSession],
  );

  // ─── Derived render flags ─────────────────────────────────────────────
  const inCardSession = mode === 'card' && cardPhase !== 'idle' && cardPhase !== 'complete';
  const inLineSession = mode === 'line' && linePhase !== 'idle' && linePhase !== 'all-complete';
  const inSession = inCardSession || inLineSession;

  const cardInteractive = cardPhase === 'waiting';
  const lineInteractive = linePhase === 'waiting';
  const boardInteractive = inCardSession ? cardInteractive : lineInteractive;
  const activeMoveFlash = inCardSession ? moveFlash : lineFlash;

  // Card-mode promptColor + variation (active card).
  const cardPromptColor = activeCard?.studentColor === 'white' ? 'White' : 'Black';
  // Line-mode header (active line + ply counter).
  const lineStudentPlies = useMemo(
    () => lineMoves.filter((m) => m.isStudent).length,
    [lineMoves],
  );
  const lineStudentPliesDone = useMemo(() => {
    let n = 0;
    for (let i = 0; i < lineMoveIndex; i++) if (lineMoves[i]?.isStudent) n += 1;
    return n;
  }, [lineMoves, lineMoveIndex]);

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Loading your repertoire…</p>
      </div>
    );
  }

  // ─── Mode tabs (used in hub + session) ────────────────────────────────
  // Selected tab: strong color + bright multi-layer glow.
  // Unselected tab: SUBTLE same-color glow so the user can see "this is
  // a chooser" at a glance without competing with the active state.
  const ModeTabs = ({ inSessionView }: { inSessionView: boolean }): JSX.Element => (
    <div
      className="grid grid-cols-2 gap-1 p-1 bg-theme-surface rounded-xl mb-3"
      data-testid="srs-mode-tabs"
    >
      <button
        onClick={() => switchModeMidSession('card')}
        className={`flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-lg text-xs font-medium transition-all border-l-2 border-b-2 ${
          mode === 'card'
            ? 'bg-purple-500/25 text-purple-200 border-purple-400/80 shadow-[0_0_6px_rgba(168,85,247,0.7),0_0_14px_rgba(168,85,247,0.45),0_0_24px_rgba(168,85,247,0.25)]'
            : 'text-purple-400/70 hover:text-purple-300 border-purple-500/25 shadow-[0_0_4px_rgba(168,85,247,0.25),0_0_10px_rgba(168,85,247,0.12)]'
        }`}
        data-testid="srs-mode-card"
      >
        <Zap size={14} />
        <span className="leading-tight text-center">
          Card{inSessionView ? '' : ' · easy'}
        </span>
      </button>
      <button
        onClick={() => switchModeMidSession('line')}
        className={`flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-lg text-xs font-medium transition-all border-l-2 border-b-2 ${
          mode === 'line'
            ? 'bg-amber-500/25 text-amber-200 border-amber-400/80 shadow-[0_0_6px_rgba(245,158,11,0.7),0_0_14px_rgba(245,158,11,0.45),0_0_24px_rgba(245,158,11,0.25)]'
            : 'text-amber-400/70 hover:text-amber-300 border-amber-500/25 shadow-[0_0_4px_rgba(245,158,11,0.25),0_0_10px_rgba(245,158,11,0.12)]'
        }`}
        data-testid="srs-mode-line"
      >
        <GraduationCap size={14} />
        <span className="leading-tight text-center">
          Line{inSessionView ? '' : ' · challenge'}
        </span>
      </button>
    </div>
  );

  // ─── Complete (card mode) ─────────────────────────────────────────────
  if (cardPhase === 'complete') {
    const total = cardCorrect + cardWrong;
    const accuracy = total > 0 ? Math.round((cardCorrect / total) * 100) : 0;
    const perfect = cardWrong === 0 && cardCorrect > 0;
    return (
      <div
        className="flex flex-col flex-1 p-4 md:p-6 items-center justify-center"
        data-testid="srs-complete"
      >
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <div
              className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
                perfect ? 'bg-yellow-500/20' : 'bg-emerald-500/20'
              }`}
            >
              {perfect ? (
                <Trophy size={32} className="text-yellow-500" />
              ) : (
                <CheckCircle size={32} className="text-emerald-500" />
              )}
            </div>
            <h2 className="text-2xl font-bold text-theme-text" data-testid="srs-complete-headline">
              Session complete
            </h2>
            <p className="text-sm text-theme-text-muted mt-1" data-testid="srs-complete-stats">
              {cardCorrect} correct · {cardWrong} missed · {accuracy}% accuracy
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-emerald-500/30">
              <p className="text-2xl font-bold text-emerald-400">{cardCorrect}</p>
              <p className="text-xs text-theme-text-muted">Correct</p>
            </div>
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-rose-500/30">
              <p className="text-2xl font-bold text-rose-400">{cardWrong}</p>
              <p className="text-xs text-theme-text-muted">Missed</p>
            </div>
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-blue-500/30">
              <p className="text-2xl font-bold text-blue-400">{total}</p>
              <p className="text-xs text-theme-text-muted">Cards</p>
            </div>
          </div>
          <button
            onClick={exitToHub}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold hover:opacity-90 transition-opacity"
            data-testid="srs-done"
          >
            <ArrowLeft size={16} />
            Back to trainer
          </button>
        </div>
      </div>
    );
  }

  // ─── Complete (line mode) ─────────────────────────────────────────────
  if (linePhase === 'all-complete') {
    const total = linesAttempted;
    const accuracy = total > 0 ? Math.round((linesPerfected / total) * 100) : 0;
    const perfect = linesPerfected === total && total > 0;
    return (
      <div
        className="flex flex-col flex-1 p-4 md:p-6 items-center justify-center"
        data-testid="srs-complete"
      >
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <div
              className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
                perfect ? 'bg-yellow-500/20' : 'bg-emerald-500/20'
              }`}
            >
              {perfect ? (
                <Trophy size={32} className="text-yellow-500" />
              ) : (
                <CheckCircle size={32} className="text-emerald-500" />
              )}
            </div>
            <h2 className="text-2xl font-bold text-theme-text" data-testid="srs-complete-headline">
              Session complete
            </h2>
            <p className="text-sm text-theme-text-muted mt-1" data-testid="srs-complete-stats">
              {linesPerfected} perfected · {total} lines · {accuracy}% accuracy
            </p>
          </div>
          <button
            onClick={exitToHub}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold hover:opacity-90 transition-opacity"
            data-testid="srs-done"
          >
            <ArrowLeft size={16} />
            Back to trainer
          </button>
        </div>
      </div>
    );
  }

  // ─── Active session view (shared chrome for both modes) ───────────────
  if (inSession) {
    const headerSubtitle = inCardSession
      ? `Card ${cardIndex + 1} of ${cardQueue.length}`
      : `Line ${lineIndex + 1} of ${lineQueue.length}`;
    const correctLabel = inCardSession ? cardCorrect : linesPerfected;
    const wrongLabel = inCardSession ? cardWrong : lineMistakes;
    const variationName = inCardSession
      ? activeCard?.variationName ?? ''
      : activeLine?.variationName ?? '';
    const promptText = inCardSession
      ? cardPhase === 'playing-in'
        ? 'Watching the line'
        : `${cardPromptColor} to move`
      : linePhase === 'opponent'
        ? 'Watching the line'
        : `${activeLine?.studentColor === 'white' ? 'White' : 'Black'} to move`;
    const progressPercent = inCardSession
      ? Math.round(((cardIndex + (cardPhase === 'waiting' ? 0 : 1)) / cardQueue.length) * 100)
      : lineStudentPlies > 0
        ? Math.round((lineStudentPliesDone / lineStudentPlies) * 100)
        : 0;

    return (
      <div
        className="flex flex-col flex-1 min-h-0 overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-4"
        data-testid="srs-session"
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
          <button
            onClick={exitToHub}
            className="p-1.5 rounded-lg hover:bg-theme-surface"
            data-testid="srs-exit"
            aria-label="Exit session"
          >
            <ArrowLeft size={18} className="text-theme-text" />
          </button>
          <div className="text-center">
            <p className="text-xs font-semibold text-theme-text uppercase tracking-wide">
              SRS Review
            </p>
            <p className="text-xs text-theme-text-muted" data-testid="srs-card-counter">
              {headerSubtitle}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-emerald-400 font-semibold" data-testid="srs-correct-count">
              {correctLabel}
            </span>
            <span className="text-theme-text-muted">/</span>
            <span className="text-rose-400 font-semibold" data-testid="srs-wrong-count">
              {wrongLabel}
            </span>
          </div>
        </div>

        {/* Mode toggle tabs — top of board, persistent during session.
            Switching mode ends the current run and starts fresh. */}
        <div className="px-4 pt-3">
          <ModeTabs inSessionView={true} />
        </div>

        {/* Progress bar */}
        <div className="px-4">
          <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-theme-accent rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
              data-testid="srs-progress"
            />
          </div>
        </div>

        {/* Prompt — variation + side-to-move. NO interface references,
            NO praise text (narration policy rules 2 + 5 + 6). */}
        <div className="px-4 pt-3 pb-2 text-center">
          <p className="text-sm font-semibold text-theme-text" data-testid="srs-variation-name">
            {variationName}
          </p>
          <p className="text-xs text-theme-text-muted" data-testid="srs-prompt">
            {promptText}
          </p>
        </div>

        {/* Board (ConsistentChessboard controlled mode). Cap the board's
            max-height the same way ChessLessonLayout does so the
            bottom rank can't slide under the mobile nav on short
            phones. min-h-0 lets the flex-1 ancestor actually shrink. */}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-start px-2 py-2 overflow-y-auto">
          <div className="w-full self-center md:max-w-[420px] max-h-[min(60vh,440px)]">
            <div className="relative">
              <ConsistentChessboard
                game={game}
                interactive={boardInteractive}
                onMove={inCardSession ? handleCardMove : handleLineMove}
                showFlipButton={false}
                showUndoButton={false}
                showResetButton={false}
                showEvalBar={false}
                showVoiceMic={false}
                moveQualityFlash={activeMoveFlash}
              />
              {(cardPhase === 'correct' || linePhase === 'between-lines') && (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  data-testid="srs-correct-overlay"
                >
                  <div className="w-16 h-16 rounded-full bg-emerald-500/30 flex items-center justify-center animate-pulse">
                    <CheckCircle size={36} className="text-emerald-400" />
                  </div>
                </div>
              )}
              {(cardPhase === 'wrong' || linePhase === 'wrong') && (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  data-testid="srs-wrong-overlay"
                >
                  <div className="w-16 h-16 rounded-full bg-rose-500/30 flex items-center justify-center animate-pulse">
                    <XCircle size={36} className="text-rose-400" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Feedback strip — only in card mode. Line mode uses the
            board reverting + overlay; printing the book line would
            give away the answer for the retry. */}
        {inCardSession && feedback && (
          <div
            className={`px-4 py-3 border-t ${
              feedback.kind === 'correct'
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : 'border-rose-500/40 bg-rose-500/10'
            }`}
            data-testid={
              feedback.kind === 'correct' ? 'srs-feedback-correct' : 'srs-feedback-wrong'
            }
          >
            <p className="text-xs text-theme-text-muted">
              Book line:{' '}
              <span className="font-mono text-theme-text font-semibold">
                {feedback.expectedSan}
              </span>
              {' · next review '}
              {describeInterval(feedback.intervalDays)}
            </p>
          </div>
        )}

        {/* Line-mode wrong feedback — minimal hint that you missed it
            without revealing the answer. */}
        {inLineSession && linePhase === 'wrong' && (
          <div
            className="px-4 py-3 border-t border-rose-500/40 bg-rose-500/10"
            data-testid="srs-feedback-wrong"
          >
            <p className="text-xs text-theme-text-muted">
              Not the book line — try again.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ─── HUB ──────────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto"
      data-testid="srs-trainer-hub"
    >
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => void navigate('/openings')}
          className="p-1.5 rounded-lg hover:bg-theme-surface"
          data-testid="srs-back"
          aria-label="Back to openings"
        >
          <ArrowLeft size={18} className="text-theme-text" />
        </button>
        <Sparkles size={22} className="text-theme-accent" />
        <h1 className="text-2xl font-bold text-theme-text">Opening Trainer</h1>
      </div>

      <p className="text-sm text-theme-text-muted mb-3">
        Spaced-repetition review for your opening repertoire. Pick your mode below — card for
        one position at a time, line for the full sequence.
      </p>

      {/* Mode toggle (hub) */}
      <ModeTabs inSessionView={false} />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-theme-surface rounded-xl p-4 border-2 border-emerald-500/30">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-emerald-400" />
            <p className="text-xs text-theme-text-muted uppercase tracking-wide">Due today</p>
          </div>
          <p className="text-3xl font-bold text-emerald-400" data-testid="srs-due-count">
            {dueCount}
          </p>
        </div>
        <div className="bg-theme-surface rounded-xl p-4 border-2 border-blue-500/30">
          <div className="flex items-center gap-2 mb-1">
            <Layers size={14} className="text-blue-400" />
            <p className="text-xs text-theme-text-muted uppercase tracking-wide">Enrolled</p>
          </div>
          <p className="text-3xl font-bold text-blue-400" data-testid="srs-total-count">
            {totalEnrolled}
          </p>
        </div>
      </div>

      {totalEnrolled === 0 ? (
        <div className="bg-theme-surface rounded-xl p-6 text-center mb-4 border border-theme-border">
          <BookOpen size={28} className="mx-auto text-theme-text-muted mb-2" />
          <p className="text-sm text-theme-text font-semibold mb-1">No openings enrolled yet</p>
          <p className="text-xs text-theme-text-muted mb-4">
            Pick an opening from your repertoire and tap "Add to trainer" to start drilling.
          </p>
          <button
            onClick={() => void navigate('/openings')}
            className="px-4 py-2 rounded-lg bg-theme-accent text-white text-sm font-semibold hover:opacity-90 transition-opacity"
            data-testid="srs-enroll-prompt"
          >
            Browse openings
          </button>
        </div>
      ) : dueCount > 0 ? (
        <button
          onClick={() =>
            mode === 'card' ? void startCardSession() : void startLineSession()
          }
          className="w-full py-4 rounded-xl bg-theme-accent text-white font-bold text-base hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2"
          data-testid="srs-start-session"
        >
          {mode === 'card' ? <Zap size={18} /> : <GraduationCap size={18} />}
          Start {mode === 'card' ? 'card' : 'line'} review
        </button>
      ) : (
        <div className="bg-theme-surface rounded-xl p-4 text-center mb-4 border border-emerald-500/30">
          <Trophy size={24} className="mx-auto text-yellow-500 mb-1" />
          <p className="text-sm text-theme-text font-semibold">All caught up</p>
          <p className="text-xs text-theme-text-muted">
            No cards due right now. Your next review is on schedule.
          </p>
        </div>
      )}

      {enrolled.length > 0 && (
        <>
          <h2 className="text-xs font-bold text-theme-text-muted uppercase tracking-widest mb-2 mt-2">
            Your repertoire
          </h2>
          <div className="space-y-2">
            {enrolled.map((row) => {
              const name = row.opening?.name ?? row.openingId;
              const eco = row.opening?.eco;
              return (
                <button
                  key={row.openingId}
                  onClick={() => void navigate(`/openings/${row.openingId}`)}
                  className="w-full flex items-center justify-between p-3 rounded-xl bg-theme-surface border border-theme-border hover:border-theme-accent/50 transition-colors text-left"
                  data-testid={`srs-enrolled-${row.openingId}`}
                >
                  <div>
                    <p className="text-sm font-semibold text-theme-text">{name}</p>
                    <p className="text-xs text-theme-text-muted">
                      {eco ? `${eco} · ` : ''}
                      {row.totalCards} card{row.totalCards !== 1 ? 's' : ''}
                    </p>
                  </div>
                  {row.dueCards > 0 ? (
                    <span className="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">
                      {row.dueCards} due
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded-full bg-theme-border/30 text-theme-text-muted text-xs">
                      scheduled
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
