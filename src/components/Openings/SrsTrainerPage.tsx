/**
 * SrsTrainerPage — Chessable MoveTrainer-style daily review.
 *
 * Two views in one route:
 *
 *  1. Hub (no session active): shows "X due today / Y total enrolled"
 *     and a per-opening breakdown. CTA: "Start review" (when due > 0)
 *     or "Enroll an opening" (when total enrolled === 0).
 *
 *  2. Review session: one card at a time. The board shows `fenBefore`
 *     oriented for the student's color. The student plays a move; the
 *     SAN is normalized (`+#!?` stripped) and compared to the card's
 *     `expectedSan`. SM-2 schedules the next review. The session walks
 *     the queue and ends on a stats screen.
 *
 * Board surface: `ConsistentChessboard` in **controlled** mode (via
 * `useChessGame`). This is the standard per CLAUDE.md — no direct
 * `react-chessboard` or `ControlledChessBoard`. Controlled mode means
 * all the user's board settings (highlight-last-move, animation speed,
 * board color, piece set, show-legal-moves, click-vs-drag) apply
 * automatically through `useSettings` inside `ControlledChessBoard`.
 *
 * Narration: silent by design. Per CLAUDE.md narration rule 8 — "drill
 * positions stay silent. Voice resumes only when the student returns to
 * a hand-authored keystone." There is NO `voiceService.speak` call in
 * this surface. Feedback uses board flashes (green/red rings) and a
 * compact info strip; no "Correct!" / "Wrong!" praise text (rule 5 —
 * the position changing IS the acknowledgment).
 *
 * Move-quality flash: gated on `settings.moveQualityFlash` (same as
 * Practice / Drill), so users who turn it off in Settings see no
 * green/red ring animation here either.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { useChessGame, type MoveResult } from '../../hooks/useChessGame';
import { useSettings } from '../../hooks/useSettings';
import type { MoveQuality } from '../Board/ChessBoard';
import {
  getDueCards,
  getDueCount,
  getEnrolledOpenings,
  getTotalEnrolled,
  normalizeSan,
  recordReview,
} from '../../services/srsOpeningService';
import { getOpeningById } from '../../services/openingService';
import { logAppAudit } from '../../services/appAuditor';
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
const FLASH_MS = 600;

function describeInterval(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days} days`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${Math.round(days / 365)} years`;
}

export function SrsTrainerPage(): JSX.Element {
  const navigate = useNavigate();
  const { settings } = useSettings();

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
  const [feedback, setFeedback] = useState<
    { kind: 'correct' | 'wrong'; expectedSan: string; intervalDays: number } | null
  >(null);
  const [moveFlash, setMoveFlash] = useState<MoveQuality>(null);

  // Controlled-mode board: one useChessGame instance for the whole
  // session; we reset its FEN when the active card changes.
  const game = useChessGame();
  // Track the current card id so we know when to push a new FEN
  // into the controlled game state.
  const lastCardIdRef = useRef<string | null>(null);

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

  // Reset / orient the board when the active card changes. Skipped if
  // the same card id is still active (e.g. a state update unrelated to
  // navigation) to avoid clobbering an in-flight move animation.
  useEffect(() => {
    if (!card) {
      lastCardIdRef.current = null;
      return;
    }
    if (lastCardIdRef.current === card.id) return;
    lastCardIdRef.current = card.id;
    game.reset(card.fenBefore);
    game.setOrientation(card.studentColor);
  }, [card, game]);

  // ─── Session ─────────────────────────────────────────────────────────────
  const startSession = useCallback(async (): Promise<void> => {
    const cards = await getDueCards(SESSION_LIMIT);
    if (cards.length === 0) return;
    setQueue(cards);
    setIndex(0);
    setCorrectCount(0);
    setWrongCount(0);
    setFeedback(null);
    setMoveFlash(null);
    setPhase('waiting');
    void logAppAudit({
      kind: 'srs-session-start',
      category: 'subsystem',
      source: 'SrsTrainerPage.startSession',
      summary: `started review session — ${cards.length} cards`,
    });
  }, []);

  const advance = useCallback((): void => {
    setFeedback(null);
    if (index + 1 >= queue.length) {
      setPhase('complete');
      void loadHub();
      void logAppAudit({
        kind: 'srs-session-complete',
        category: 'subsystem',
        source: 'SrsTrainerPage.advance',
        summary: `session complete — ${correctCount} correct / ${wrongCount} missed`,
      });
      return;
    }
    setIndex((i) => i + 1);
    setPhase('waiting');
  }, [index, queue.length, loadHub, correctCount, wrongCount]);

  const handleMove = useCallback(
    (result: MoveResult): void => {
      if (!card || phase !== 'waiting') return;
      const correct = normalizeSan(result.san) === card.expectedSan;

      // Move-quality flash: gated on user's "Move quality flash" setting.
      // (Same setting Practice/Drill respects.)
      if (settings.moveQualityFlash) {
        setMoveFlash(correct ? 'good' : 'blunder');
        setTimeout(() => setMoveFlash(null), FLASH_MS);
      }

      void (async () => {
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
          expectedSan: card.expectedSan,
          intervalDays: next?.intervalDays ?? card.intervalDays,
        });
        // On a wrong move, revert the board to the prompt so the next
        // card transition isn't visually surprising. Correct stays as-
        // is — the played book line is the right closing image.
        if (!correct) {
          setTimeout(() => game.reset(card.fenBefore), 400);
        }
        setTimeout(advance, FEEDBACK_MS);
      })();
    },
    [card, phase, settings.moveQualityFlash, game, advance],
  );

  const handleExitSession = useCallback((): void => {
    setQueue([]);
    setPhase('idle');
    setIndex(0);
    setCorrectCount(0);
    setWrongCount(0);
    setFeedback(null);
    setMoveFlash(null);
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

          <button
            onClick={handleExitSession}
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

  // ─── Render: active session ─────────────────────────────────────────────
  if (phase !== 'idle' && card) {
    const sessionTotal = queue.length;
    const progress = Math.round(
      ((index + (phase === 'waiting' ? 0 : 1)) / sessionTotal) * 100,
    );
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
            <p className="text-xs font-semibold text-theme-text uppercase tracking-wide">
              SRS Review
            </p>
            <p className="text-xs text-theme-text-muted" data-testid="srs-card-counter">
              Card {index + 1} of {sessionTotal}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-emerald-400 font-semibold" data-testid="srs-correct-count">
              {correctCount}
            </span>
            <span className="text-theme-text-muted">/</span>
            <span className="text-rose-400 font-semibold" data-testid="srs-wrong-count">
              {wrongCount}
            </span>
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

        {/* Prompt — names the variation and side-to-move. No "find the
            best move" cheerleading; the prompt is functional, not
            spoken. Per narration policy rules 2 + 6: no interface
            references, no first-person/meta. */}
        <div className="px-4 pt-3 pb-2 text-center">
          <p className="text-sm font-semibold text-theme-text" data-testid="srs-variation-name">
            {card.variationName}
          </p>
          <p className="text-xs text-theme-text-muted" data-testid="srs-prompt">
            {promptColor} to move
          </p>
        </div>

        {/* Board — ConsistentChessboard controlled mode pulls the user's
            board settings (highlight-last-move, animation speed, color
            scheme, piece set, click-vs-drag) through useSettings. We do
            NOT show the voice-mic / flip / undo / reset chrome — this
            is a drill, not a free-play surface. */}
        <div className="flex-1 flex flex-col items-center justify-start px-2 py-2">
          <div className="w-full md:max-w-[420px]">
            <div className="relative">
              <ConsistentChessboard
                game={game}
                interactive={phase === 'waiting'}
                onMove={handleMove}
                showFlipButton={false}
                showUndoButton={false}
                showResetButton={false}
                showEvalBar={false}
                showVoiceMic={false}
                moveQualityFlash={moveFlash}
              />
              {phase === 'correct' && (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  data-testid="srs-correct-overlay"
                >
                  <div className="w-16 h-16 rounded-full bg-emerald-500/30 flex items-center justify-center animate-pulse">
                    <CheckCircle size={36} className="text-emerald-400" />
                  </div>
                </div>
              )}
              {phase === 'wrong' && (
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

        {/* Feedback strip — purely informational. No praise text, no
            "Wrong!" callout. The visual cue (green/red overlay) IS the
            acknowledgment per narration rule 5. We only carry data the
            user can act on: the book line + when this card returns. */}
        {feedback && (
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
            Pick an opening from your repertoire and tap "Add to trainer" to start drilling its
            lines.
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
          Start review · {Math.min(dueCount, SESSION_LIMIT)} card
          {Math.min(dueCount, SESSION_LIMIT) !== 1 ? 's' : ''}
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
