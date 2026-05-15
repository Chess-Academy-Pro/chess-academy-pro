/**
 * SrsTrainerPage — Chessable MoveTrainer-style daily review.
 *
 * Two views in one route:
 *
 *  1. Hub (no session active): shows "X due today / Y total enrolled"
 *     and a per-opening breakdown. CTA: "Start review" (when due > 0)
 *     or "Enroll an opening" (when total enrolled === 0).
 *
 *  2. Review session: one card at a time. Board shows fenBefore in the
 *     student's orientation. Student drags a piece; if the SAN matches
 *     the card's expectedSan (after stripping `+#!?`), it's correct and
 *     we apply SM-2 + advance. If wrong, the board reverts after a
 *     brief delay, the correct answer is revealed, and we apply SM-2
 *     (lapse). End-of-session screen shows correct / wrong counts.
 *
 * Why one route: David wants Chessable parity. Chessable's daily review
 * is one button; the session opens, plays through due cards, and ends
 * — no extra navigation. The hub view is the entry point and the
 * session lives at the same URL so closing the session lands back on
 * the hub with fresh counts.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { PieceDropHandlerArgs } from 'react-chessboard';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Sparkles,
  Trophy,
  BookOpen,
  Layers,
  Clock,
} from 'lucide-react';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import {
  getDueCards,
  getDueCount,
  getEnrolledOpenings,
  getTotalEnrolled,
  normalizeSan,
  recordReview,
} from '../../services/srsOpeningService';
import { getOpeningById } from '../../services/openingService';
import type { OpeningRecord, SrsOpeningCard } from '../../types';

interface EnrolledRow {
  opening: OpeningRecord | undefined;
  openingId: string;
  totalCards: number;
  dueCards: number;
}

type SessionPhase = 'idle' | 'waiting' | 'correct' | 'wrong' | 'complete';

const SESSION_LIMIT = 20;
const FEEDBACK_MS = 1100;

function describeInterval(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days} days`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${Math.round(days / 365)} years`;
}

export function SrsTrainerPage(): JSX.Element {
  const navigate = useNavigate();

  // Hub state
  const [dueCount, setDueCount] = useState<number>(0);
  const [totalEnrolled, setTotalEnrolled] = useState<number>(0);
  const [enrolled, setEnrolled] = useState<EnrolledRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Session state
  const [queue, setQueue] = useState<SrsOpeningCard[]>([]);
  const [index, setIndex] = useState<number>(0);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [correctCount, setCorrectCount] = useState<number>(0);
  const [wrongCount, setWrongCount] = useState<number>(0);
  const [feedback, setFeedback] = useState<{ kind: 'correct' | 'wrong'; expectedSan: string; intervalDays: number } | null>(null);

  // Board state for the active card. We keep a separate chess.js instance
  // per card so the position reverts cleanly on a wrong move.
  const [boardFen, setBoardFen] = useState<string | null>(null);

  const card = queue[index];

  // ─── Hub loader ──────────────────────────────────────────────────────────
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

  // Reset the board when the active card changes.
  useEffect(() => {
    if (!card) {
      setBoardFen(null);
      return;
    }
    setBoardFen(card.fenBefore);
  }, [card]);

  // ─── Session ─────────────────────────────────────────────────────────────
  const startSession = useCallback(async (): Promise<void> => {
    const cards = await getDueCards(SESSION_LIMIT);
    if (cards.length === 0) return;
    setQueue(cards);
    setIndex(0);
    setCorrectCount(0);
    setWrongCount(0);
    setFeedback(null);
    setPhase('waiting');
  }, []);

  const advance = useCallback((): void => {
    setFeedback(null);
    if (index + 1 >= queue.length) {
      setPhase('complete');
      // Refresh hub counts behind the complete screen.
      void loadHub();
      return;
    }
    setIndex((i) => i + 1);
    setPhase('waiting');
  }, [index, queue.length, loadHub]);

  const handleResult = useCallback(
    async (correct: boolean, expectedSan: string, attemptedSan?: string): Promise<void> => {
      if (!card) return;
      const next = await recordReview(card.id, correct);
      if (correct) {
        setCorrectCount((c) => c + 1);
        setPhase('correct');
      } else {
        setWrongCount((w) => w + 1);
        setPhase('wrong');
      }
      setFeedback({
        kind: correct ? 'correct' : 'wrong',
        expectedSan,
        intervalDays: next?.intervalDays ?? card.intervalDays,
      });
      // Reset board on wrong so the student sees the original prompt
      // again before we move on. On correct, leave the played move on
      // the board so the result is visible during the feedback flash.
      if (!correct) {
        setTimeout(() => setBoardFen(card.fenBefore), 400);
      }
      // Optional: mark unused so eslint doesn't complain in case we
      // wire attempted-SAN display later.
      void attemptedSan;
      setTimeout(advance, FEEDBACK_MS);
    },
    [card, advance],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!card || phase !== 'waiting' || !targetSquare) return false;
      // Validate against chess.js — we need the SAN regardless of result.
      const chess = new Chess(card.fenBefore);
      let attempt: ReturnType<Chess['move']> | null = null;
      try {
        attempt = chess.move({
          from: sourceSquare as Square,
          to: targetSquare as Square,
          promotion: 'q',
        });
      } catch {
        return false;
      }
      if (!attempt) return false;
      // Show the attempted move on the board immediately.
      setBoardFen(chess.fen());
      const correct = normalizeSan(attempt.san) === card.expectedSan;
      void handleResult(correct, card.expectedSan, attempt.san);
      return true;
    },
    [card, phase, handleResult],
  );

  const handleRetryAll = useCallback((): void => {
    setQueue([]);
    setPhase('idle');
    setIndex(0);
    setCorrectCount(0);
    setWrongCount(0);
    setFeedback(null);
    void loadHub();
  }, [loadHub]);

  const handleExitSession = useCallback((): void => {
    setQueue([]);
    setPhase('idle');
    setIndex(0);
    setCorrectCount(0);
    setWrongCount(0);
    setFeedback(null);
    void loadHub();
  }, [loadHub]);

  // ─── Render: loading ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-theme-text-muted">Loading your repertoire…</p>
      </div>
    );
  }

  // ─── Render: complete screen ────────────────────────────────────────────
  if (phase === 'complete') {
    const total = correctCount + wrongCount;
    const accuracy = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const perfect = wrongCount === 0 && correctCount > 0;
    return (
      <div className="flex flex-col flex-1 p-4 md:p-6 items-center justify-center" data-testid="srs-complete">
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
            <h2 className="text-2xl font-bold text-theme-text">
              {perfect ? 'Perfect session!' : 'Session complete'}
            </h2>
            <p className="text-sm text-theme-text-muted mt-1">
              {correctCount} correct · {wrongCount} missed · {accuracy}% accuracy
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-emerald-500/30">
              <p className="text-2xl font-bold text-emerald-400">{correctCount}</p>
              <p className="text-xs text-theme-text-muted">Correct</p>
            </div>
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-rose-500/30">
              <p className="text-2xl font-bold text-rose-400">{wrongCount}</p>
              <p className="text-xs text-theme-text-muted">Missed</p>
            </div>
            <div className="bg-theme-surface rounded-xl p-3 text-center border border-blue-500/30">
              <p className="text-2xl font-bold text-blue-400">{total}</p>
              <p className="text-xs text-theme-text-muted">Cards</p>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleRetryAll}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold hover:opacity-90 transition-opacity"
              data-testid="srs-done"
            >
              <ArrowLeft size={16} />
              Back to trainer
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: active session ─────────────────────────────────────────────
  if (phase !== 'idle' && card && boardFen) {
    const sessionTotal = queue.length;
    const progress = Math.round(((index + (phase === 'waiting' ? 0 : 1)) / sessionTotal) * 100);
    const promptColor = card.studentColor === 'white' ? 'White' : 'Black';
    return (
      <div className="flex flex-col flex-1 overflow-hidden" data-testid="srs-session">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
          <button
            onClick={handleExitSession}
            className="p-1.5 rounded-lg hover:bg-theme-surface"
            data-testid="srs-exit"
            aria-label="Exit session"
          >
            <ArrowLeft size={18} className="text-theme-text" />
          </button>
          <div className="text-center">
            <p className="text-xs font-semibold text-theme-text uppercase tracking-wide">SRS Review</p>
            <p className="text-xs text-theme-text-muted">
              Card {index + 1} of {sessionTotal}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-emerald-400 font-semibold">{correctCount}</span>
            <span className="text-theme-text-muted">/</span>
            <span className="text-rose-400 font-semibold">{wrongCount}</span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-4 pt-2">
          <div className="w-full h-1.5 bg-theme-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-theme-accent rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
              data-testid="srs-progress"
            />
          </div>
        </div>

        {/* Prompt */}
        <div className="px-4 pt-3 pb-2 text-center">
          <p className="text-sm font-semibold text-theme-text" data-testid="srs-variation-name">
            {card.variationName}
          </p>
          <p className="text-xs text-theme-text-muted">
            {promptColor} to move — find the book line
          </p>
        </div>

        {/* Board */}
        <div className="flex-1 flex flex-col items-center justify-start px-2 py-2">
          <div className="w-full md:max-w-[420px]">
            <div className="relative">
              <ConsistentChessboard
                fen={boardFen}
                boardOrientation={card.studentColor}
                interactive={phase === 'waiting'}
                onPieceDrop={onPieceDrop}
                showLastMoveHighlight={true}
                showCheckHighlight={true}
              />
              {phase === 'correct' && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-16 h-16 rounded-full bg-emerald-500/30 flex items-center justify-center animate-pulse">
                    <CheckCircle size={36} className="text-emerald-400" />
                  </div>
                </div>
              )}
              {phase === 'wrong' && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-16 h-16 rounded-full bg-rose-500/30 flex items-center justify-center animate-pulse">
                    <XCircle size={36} className="text-rose-400" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Feedback strip */}
        {feedback && (
          <div
            className={`px-4 py-3 border-t ${
              feedback.kind === 'correct'
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : 'border-rose-500/40 bg-rose-500/10'
            }`}
            data-testid={feedback.kind === 'correct' ? 'srs-feedback-correct' : 'srs-feedback-wrong'}
          >
            <p
              className={`text-sm font-semibold ${
                feedback.kind === 'correct' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {feedback.kind === 'correct' ? 'Correct!' : 'Not quite.'}
            </p>
            <p className="text-xs text-theme-text-muted">
              Book line: <span className="font-mono text-theme-text">{feedback.expectedSan}</span>
              {' · next review '}
              {describeInterval(feedback.intervalDays)}
            </p>
          </div>
        )}
      </div>
    );
  }

  // ─── Render: hub ─────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col flex-1 p-4 md:p-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 overflow-y-auto"
      data-testid="srs-trainer-hub"
    >
      {/* Header */}
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

      <p className="text-sm text-theme-text-muted mb-4">
        Spaced-repetition review for your opening repertoire. One card per
        position you need to play — book lines drilled until they're
        automatic.
      </p>

      {/* Stats row */}
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

      {/* Primary CTA */}
      {totalEnrolled === 0 ? (
        <div className="bg-theme-surface rounded-xl p-6 text-center mb-4 border border-theme-border">
          <BookOpen size={28} className="mx-auto text-theme-text-muted mb-2" />
          <p className="text-sm text-theme-text font-semibold mb-1">No openings enrolled yet</p>
          <p className="text-xs text-theme-text-muted mb-4">
            Pick an opening from your repertoire and tap "Add to trainer" to
            start drilling its lines.
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
          onClick={() => void startSession()}
          className="w-full py-4 rounded-xl bg-theme-accent text-white font-bold text-base hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2"
          data-testid="srs-start-session"
        >
          <Sparkles size={18} />
          Start review · {Math.min(dueCount, SESSION_LIMIT)} card{Math.min(dueCount, SESSION_LIMIT) !== 1 ? 's' : ''}
        </button>
      ) : (
        <div className="bg-theme-surface rounded-xl p-4 text-center mb-4 border border-emerald-500/30">
          <Trophy size={24} className="mx-auto text-yellow-500 mb-1" />
          <p className="text-sm text-theme-text font-semibold">All caught up!</p>
          <p className="text-xs text-theme-text-muted">
            No cards due right now. Come back later — your next review is on
            schedule.
          </p>
        </div>
      )}

      {/* Enrolled list */}
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
