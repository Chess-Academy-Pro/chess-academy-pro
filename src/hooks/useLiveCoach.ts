/**
 * useLiveCoach
 * ------------
 * Live-coach interjections during play (WO-LIVE-COACH-01). The coach
 * speaks unprompted at meaningful moments — great moves, missed
 * tactics, opponent blunders, positional eval swings, recoveries.
 *
 * The hook does NOT run Stockfish itself. CoachGamePage's existing
 * per-move analysis pipeline produces eval-before, eval-after, best
 * move, classification, hung-piece detection. The hook receives the
 * relevant fields via two notify functions and runs pure trigger
 * detectors (`liveCoachTriggers.ts`) over them. When any trigger
 * fires, the hook calls the LLM, speaks the response, and appends to
 * the unified coach memory store's `conversationHistory`.
 *
 * Rate limits are intentionally OFF in this WO — the user wanted to
 * see the firehose first, then tune via Coach Settings UI in a future
 * WO. The hook does dedupe per-ply (no double-speak on the same ply
 * for the same trigger).
 */
import { useCallback, useRef } from 'react';
import { getCoachChatResponse } from '../services/coachApi';
import { voiceService } from '../services/voiceService';
import { logAppAudit } from '../services/appAuditor';
import {
  LIVE_COACH_GREAT_MOVE_ADDITION,
  LIVE_COACH_MISSED_TACTIC_ADDITION,
  LIVE_COACH_OPPONENT_BLUNDER_ADDITION,
  LIVE_COACH_EVAL_SWING_WRONG_ADDITION,
  LIVE_COACH_RECOVERY_ADDITION,
} from '../services/coachPrompts';
import {
  evaluateOpponentMoveTriggers,
  evaluatePlayerMoveTriggers,
  type LiveCoachTrigger,
  type PlayerMoveSignal,
  type OpponentMoveSignal,
  type TriggerResult,
} from '../services/liveCoachTriggers';
import { useCoachMemoryStore } from '../stores/coachMemoryStore';

export interface UseLiveCoachArgs {
  gameId: string;
  playerColor: 'white' | 'black';
}

export interface PlayerMoveNotification {
  ply: number;
  san: string;
  fenAfter: string;
  /** White-perspective centipawn eval before the move. */
  evalBefore: number;
  /** White-perspective centipawn eval after the move. */
  evalAfter: number;
  /** White-perspective centipawn eval of the engine's best move from
   *  the position before this move. Null when no analysis was
   *  available. */
  bestMoveEval: number | null;
  /** SAN of the engine's best move from the pre-move position, used
   *  in the LLM context block for "missed tactic" and "great move"
   *  prompts. */
  bestMoveSan: string | null;
  /** True iff the played move equals the engine's best move. */
  isBestMove: boolean;
  /** True iff the engine's best move was tactical (capture, fork,
   *  pin, mate threat). Derived by the caller from the existing
   *  `tactic-classifier` output. */
  bestMoveWasTactical: boolean;
  /** True iff the played move left a piece hanging — used to
   *  suppress eval-swing-wrong (POLISH-02 blunder alert covers that
   *  case with dedicated prose). */
  hasHangingPiece: boolean;
}

export interface OpponentMoveNotification {
  ply: number;
  san: string;
  fenAfter: string;
  /** White-perspective centipawn evals around the opponent's move. */
  evalBefore: number;
  evalAfter: number;
}

export interface UseLiveCoachResult {
  notifyPlayerMove: (n: PlayerMoveNotification) => void;
  notifyOpponentMove: (n: OpponentMoveNotification) => void;
}

const LIVE_COACH_API_TIMEOUT_MS = 30_000;
const LIVE_COACH_MAX_TOKENS = 600;

/** Convert white-perspective eval into student-perspective. */
function toStudentEval(whitePerspectiveCp: number, color: 'white' | 'black'): number {
  return color === 'white' ? whitePerspectiveCp : -whitePerspectiveCp;
}

function pawnsFromCp(cp: number): string {
  const sign = cp >= 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

function buildUserMessage(
  trigger: LiveCoachTrigger,
  ctx: {
    playerSan?: string | null;
    bestMoveSan?: string | null;
    studentEvalBefore?: number;
    studentEvalAfter?: number;
    worstEval?: number;
    last3Moves?: string[];
  },
): string {
  switch (trigger) {
    case 'great-move':
      return [
        `San: ${ctx.playerSan ?? '?'}`,
        `Eval before: ${ctx.studentEvalBefore !== undefined ? pawnsFromCp(ctx.studentEvalBefore) : 'n/a'}`,
        `Eval after: ${ctx.studentEvalAfter !== undefined ? pawnsFromCp(ctx.studentEvalAfter) : 'n/a'}`,
        ctx.bestMoveSan ? `Engine confirms best: ${ctx.bestMoveSan}` : '',
      ].filter(Boolean).join('\n');
    case 'missed-tactic':
      return [
        `Played: ${ctx.playerSan ?? '?'}`,
        `Eval after: ${ctx.studentEvalAfter !== undefined ? pawnsFromCp(ctx.studentEvalAfter) : 'n/a'}`,
        // Intentionally omit the missed move's SAN from the user
        // message — the prompt forbids naming it. Telling the LLM
        // would leak.
      ].filter(Boolean).join('\n');
    case 'opponent-blunder':
      return [
        `Opponent's move: ${ctx.playerSan ?? '?'}`,
        `Eval before: ${ctx.studentEvalBefore !== undefined ? pawnsFromCp(ctx.studentEvalBefore) : 'n/a'}`,
        `Eval after: ${ctx.studentEvalAfter !== undefined ? pawnsFromCp(ctx.studentEvalAfter) : 'n/a'}`,
      ].filter(Boolean).join('\n');
    case 'eval-swing-wrong':
      return [
        `Played: ${ctx.playerSan ?? '?'}`,
        `Eval before: ${ctx.studentEvalBefore !== undefined ? pawnsFromCp(ctx.studentEvalBefore) : 'n/a'}`,
        `Eval after: ${ctx.studentEvalAfter !== undefined ? pawnsFromCp(ctx.studentEvalAfter) : 'n/a'}`,
        ctx.bestMoveSan ? `Best was: ${ctx.bestMoveSan}` : '',
      ].filter(Boolean).join('\n');
    case 'recovery':
      return [
        `Worst eval recent: ${ctx.worstEval !== undefined ? pawnsFromCp(ctx.worstEval) : 'n/a'}`,
        `Current eval: ${ctx.studentEvalAfter !== undefined ? pawnsFromCp(ctx.studentEvalAfter) : 'n/a'}`,
        ctx.last3Moves && ctx.last3Moves.length > 0
          ? `Recent moves: ${ctx.last3Moves.join(' ')}`
          : '',
      ].filter(Boolean).join('\n');
  }
}

const ADDITION_BY_TRIGGER: Record<LiveCoachTrigger, string> = {
  'great-move': LIVE_COACH_GREAT_MOVE_ADDITION,
  'missed-tactic': LIVE_COACH_MISSED_TACTIC_ADDITION,
  'opponent-blunder': LIVE_COACH_OPPONENT_BLUNDER_ADDITION,
  'eval-swing-wrong': LIVE_COACH_EVAL_SWING_WRONG_ADDITION,
  'recovery': LIVE_COACH_RECOVERY_ADDITION,
};

function speakStreamed(text: string): void {
  const sentences = text.match(/([^.!?]+[.!?])(?=\s|$)/g) ?? [text];
  if (sentences.length === 0) return;
  voiceService.stop();
  let chain: Promise<void> = Promise.resolve();
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    chain = chain
      .then(() => voiceService.speakForced(trimmed))
      .catch(() => undefined);
  }
}

export function useLiveCoach(args: UseLiveCoachArgs): UseLiveCoachResult {
  const { gameId, playerColor } = args;

  // student-perspective eval rolling window, oldest first; used by the
  // recovery detector. Capped at the last 12 plies to keep memory
  // stable.
  const evalHistoryRef = useRef<number[]>([]);
  // Per-ply dedupe so two notifies for the same ply (rare, but
  // possible if React re-renders) don't double-speak.
  const lastSpokenPlyRef = useRef<number>(-1);
  const inFlightRef = useRef<boolean>(false);

  const handleTrigger = useCallback(
    async (
      winner: TriggerResult,
      ctx: {
        ply: number;
        san: string;
        fenAfter: string;
        bestMoveSan: string | null;
        studentEvalBefore: number;
        studentEvalAfter: number;
        worstEval?: number;
        last3Moves?: string[];
      },
    ): Promise<void> => {
      if (inFlightRef.current) return;
      if (lastSpokenPlyRef.current === ctx.ply) return;
      inFlightRef.current = true;
      lastSpokenPlyRef.current = ctx.ply;

      const userMessage = buildUserMessage(winner.trigger, {
        playerSan: ctx.san,
        bestMoveSan: ctx.bestMoveSan,
        studentEvalBefore: ctx.studentEvalBefore,
        studentEvalAfter: ctx.studentEvalAfter,
        worstEval: ctx.worstEval,
        last3Moves: ctx.last3Moves,
      });

      void logAppAudit({
        kind: 'live-coach-trigger-fired',
        category: 'subsystem',
        source: 'useLiveCoach',
        summary: `${winner.trigger} ply=${ctx.ply}`,
        details: JSON.stringify({ ...winner, ply: ctx.ply, san: ctx.san }),
        fen: ctx.fenAfter,
      });

      let response = '';
      try {
        // WO-COACH-MASTER-INTEGRATION: pass the post-move FEN so live
        // interjections can be grounded if the trigger fires on a
        // move-question-shaped turn.
        const promise = getCoachChatResponse(
          [{ role: 'user', content: userMessage }],
          ADDITION_BY_TRIGGER[winner.trigger],
          undefined,
          'chat_response',
          LIVE_COACH_MAX_TOKENS,
          'medium',
          undefined, // forceProvider
          undefined, // skipPersonality
          ctx.fenAfter ? { currentFen: ctx.fenAfter, surface: '/coach/play' } : undefined,
        );
        const timeout = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('live-coach-timeout')), LIVE_COACH_API_TIMEOUT_MS),
        );
        response = await Promise.race([promise, timeout]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'useLiveCoach',
          summary: `${winner.trigger} LLM failed`,
          details: msg,
          fen: ctx.fenAfter,
        });
        inFlightRef.current = false;
        return;
      }

      const text = response.trim();
      if (!text || text.startsWith('⚠️')) {
        inFlightRef.current = false;
        return;
      }

      speakStreamed(text);

      useCoachMemoryStore.getState().appendConversationMessage({
        surface: 'live-coach',
        role: 'coach',
        text,
        gameId,
        ply: ctx.ply,
        fen: ctx.fenAfter,
        trigger: winner.trigger,
      });

      inFlightRef.current = false;
    },
    [gameId],
  );

  const notifyPlayerMove = useCallback(
    (n: PlayerMoveNotification) => {
      const studentEvalBefore = toStudentEval(n.evalBefore, playerColor);
      const studentEvalAfter = toStudentEval(n.evalAfter, playerColor);
      const studentBestEval =
        n.bestMoveEval !== null ? toStudentEval(n.bestMoveEval, playerColor) : null;

      // Push to history BEFORE detecting recovery so the current eval
      // is the one we compare against (recovery wants worst-of-recent
      // including this ply).
      evalHistoryRef.current = [...evalHistoryRef.current, studentEvalAfter].slice(-12);

      const signal: PlayerMoveSignal = {
        evalBefore: studentEvalBefore,
        evalAfter: studentEvalAfter,
        bestMoveEval: studentBestEval,
        isBestMove: n.isBestMove,
        bestMoveWasTactical: n.bestMoveWasTactical,
        hasHangingPiece: n.hasHangingPiece,
        recentEvalHistory: evalHistoryRef.current,
      };

      const { winner, suppressed } = evaluatePlayerMoveTriggers(signal);
      for (const s of suppressed) {
        void logAppAudit({
          kind: 'live-coach-trigger-suppressed',
          category: 'subsystem',
          source: 'useLiveCoach',
          summary: `${s.trigger} ply=${n.ply} (lost priority)`,
          details: JSON.stringify({ ...s, ply: n.ply }),
        });
      }
      if (!winner) return;

      const last3 = evalHistoryRef.current.slice(-3);
      const worstRecent = last3.length > 0 ? Math.min(...last3) : undefined;

      void handleTrigger(winner, {
        ply: n.ply,
        san: n.san,
        fenAfter: n.fenAfter,
        bestMoveSan: n.bestMoveSan,
        studentEvalBefore,
        studentEvalAfter,
        worstEval: worstRecent,
        last3Moves: undefined,
      });
    },
    [handleTrigger, playerColor],
  );

  const notifyOpponentMove = useCallback(
    (n: OpponentMoveNotification) => {
      const studentEvalBefore = toStudentEval(n.evalBefore, playerColor);
      const studentEvalAfter = toStudentEval(n.evalAfter, playerColor);
      // Opponent moves don't extend the recovery history — only the
      // student's plies do (recovery is about THEIR play).
      const signal: OpponentMoveSignal = {
        evalBefore: studentEvalBefore,
        evalAfter: studentEvalAfter,
      };
      const { winner } = evaluateOpponentMoveTriggers(signal);
      if (!winner) return;

      void handleTrigger(winner, {
        ply: n.ply,
        san: n.san,
        fenAfter: n.fenAfter,
        bestMoveSan: null,
        studentEvalBefore,
        studentEvalAfter,
      });
    },
    [handleTrigger, playerColor],
  );

  return { notifyPlayerMove, notifyOpponentMove };
}
