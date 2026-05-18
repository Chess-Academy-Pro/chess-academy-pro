/**
 * ExplainPositionSessionView
 * --------------------------
 * Non-interactive analysis view. Shows a board locked to the target
 * FEN (or the starting position), runs Stockfish to depth 18, then
 * streams an LLM explanation via the existing coachApi channel.
 *
 * Unlike CoachAnalysePage this is a read-only lesson surface (lives
 * inside ChessLessonLayout, no FEN input, no drag-to-move). It's what
 * the coach drops you into when you say "explain this position" in
 * chat and we have — or pick up — a FEN to analyse.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader, Volume2, VolumeOff } from 'lucide-react';
import { motion } from 'framer-motion';
import { ConsistentChessboard } from '../Chessboard/ConsistentChessboard';
import { ChessLessonLayout } from '../Layout/ChessLessonLayout';
import { ChatInput } from './ChatInput';
import { stockfishEngine } from '../../services/stockfishEngine';
import { coachService } from '../../coach/coachService';
import { voiceService } from '../../services/voiceService';
import {
  createStreamingDispatcher,
  type StreamingDispatcher,
} from '../../services/streamingSpeaker';
import { SENTENCE_END_RE, unwrapSpineError } from '../../services/sanitizeCoachText';
import { logAppAudit } from '../../services/appAuditor';
import { useAppStore } from '../../stores/appStore';
import { buildTacticsLiveContext } from '../../services/liveTacticsContext';
import type { StockfishAnalysis } from '../../types';

const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ANALYSIS_DEPTH = 18;

export interface ExplainPositionSessionViewProps {
  fen?: string;
  orientation: 'white' | 'black';
  onExit: () => void;
}

export function ExplainPositionSessionView({
  fen,
  orientation,
  onExit,
}: ExplainPositionSessionViewProps): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const targetFen = fen && fen.trim() ? fen : START_FEN;

  const [analysis, setAnalysis] = useState<StockfishAnalysis | null>(null);
  const [explanation, setExplanation] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [voiceMuted, setVoiceMuted] = useState<boolean>(true);
  const mountedRef = useRef<boolean>(true);
  // Streaming-voice dispatcher: same pattern as CoachAnalysePage.
  // First sentence speaks ~500ms after first
  // chunk arrives instead of waiting for the full LLM completion.
  // `createStreamingDispatcher` tracks an accumulated-text cursor so
  // each sentence dispatches exactly once across all chunks (fixes
  // the 2026-05-16 voice-loop bug — same shape lived here too).
  const dispatcherRef = useRef<StreamingDispatcher>(
    createStreamingDispatcher(SENTENCE_END_RE),
  );
  const pushAccumulated = useCallback((accumulated: string) => {
    if (voiceMuted) return;
    dispatcherRef.current.push(accumulated);
  }, [voiceMuted]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      voiceService.stop();
    };
  }, []);

  // Run Stockfish + stream LLM commentary on mount / when FEN changes.
  useEffect(() => {
    // Ref-shaped flag; mutated in cleanup below. ESLint's flow analysis
    // can't see the mutation across awaits, so the check-is-always-false
    // warnings are suppressed at the call sites.
    const cancelled: { value: boolean } = { value: false };
    setLoading(true);
    setExplanation('');
    setAnalysis(null);

    void (async () => {
      try {
        const sf = await stockfishEngine.analyzePosition(targetFen, ANALYSIS_DEPTH);
        if (cancelled.value || !mountedRef.current) return;
        setAnalysis(sf);

        // Reset speech chain for this position's narration. Fresh
        // speaker so a prior stream's abandoned flag doesn't carry over.
        dispatcherRef.current = createStreamingDispatcher(SENTENCE_END_RE);

        const evalText = sf.isMate
          ? `Mate in ${sf.mateIn ?? '?'}`
          : `${(sf.evaluation / 100).toFixed(2)} pawns`;
        const candidateLines = sf.topLines.slice(0, 3).map((line, i) => {
          const moveSeq = line.moves.slice(0, 5).join(' ');
          const lineEval = line.mate !== null ? `M${line.mate}` : (line.evaluation / 100).toFixed(2);
          return `  ${i + 1}. ${moveSeq} (${lineEval})`;
        }).join('\n');
        const ask = [
          `Explain this position deeply.`,
          `FEN: ${targetFen}`,
          `Engine eval: ${evalText} at depth ${sf.depth}.`,
          `Top engine candidates:`,
          candidateLines,
          '',
          `Student rating: ${activeProfile?.currentRating ?? 1420}.`,
          '',
          `Explain in 4-6 sentences: assessment, plans, tactics to watch for.`,
        ].join('\n');

        // Tactical context — sf analysis is already in scope (we ran
        // Stockfish on targetFen to power the explain prompt), so the
        // forward PV scan fires here too. Explain-position's job is
        // exactly tactical articulation, so this is high-value wiring.
        const explainStudentColor = targetFen.split(' ')[1] === 'b' ? 'b' : 'w';
        const explainStudentRating =
          useAppStore.getState().activeProfile?.puzzleRating ?? 1200;
        const explainTactics = buildTacticsLiveContext(
          targetFen,
          sf,
          explainStudentColor,
          explainStudentRating,
        );
        let streamed = '';
        const result = await coachService.ask(
          {
            surface: 'standalone-chat',
            ask,
            liveState: {
              surface: 'standalone-chat',
              fen: targetFen,
              evalCp: sf.isMate ? undefined : sf.evaluation,
              evalMateIn: sf.mateIn ?? undefined,
              userJustDid: 'Loaded a position into Explain',
              tactics: explainTactics,
            },
          },
          {
            task: 'chat_response',
            maxTokens: 600,
            maxToolRoundTrips: 1,
            onChunk: (chunk: string) => {
              if (cancelled.value || !mountedRef.current) return;
              streamed += chunk;
              setExplanation(streamed);
              pushAccumulated(streamed);
            },
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelled.value || !mountedRef.current) return;
        const finalText = unwrapSpineError(result.text);
        if (!finalText) {
          void logAppAudit({
            kind: 'llm-error',
            category: 'subsystem',
            source: 'ExplainPositionSessionView.analyse',
            summary: result.text.slice(0, 120),
            fen: targetFen,
          });
        } else if (!voiceMuted && dispatcherRef.current.count() === 0) {
          // Fallback: short response without a sentence terminator.
          void voiceService.speakIfFree(finalText.slice(0, 600));
        }
      } catch (err: unknown) {
        if (cancelled.value || !mountedRef.current) return;
        console.warn('[ExplainPositionSessionView] analysis failed:', err);
        setExplanation(
          'I had trouble analysing that position. Try a different FEN, or open the Analysis Board.',
        );
      } finally {
        if (!cancelled.value && mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled.value = true;
    };
    // voiceMuted is intentionally not a dep — muting mid-analysis
    // shouldn't restart the stream. The read inside the closure uses
    // the value at analysis time, matching CoachAnalysePage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFen, activeProfile]);

  const handleFollowUp = useCallback(
    async (question: string) => {
      if (!analysis) return;
      setLoading(true);
      voiceService.stop();
      dispatcherRef.current = createStreamingDispatcher(SENTENCE_END_RE);

      const evalText = analysis.isMate
        ? `Mate in ${analysis.mateIn ?? '?'}`
        : `${(analysis.evaluation / 100).toFixed(2)} pawns`;
      const ask = [
        `Student question: ${question}`,
        `Position FEN: ${targetFen}`,
        `Engine eval: ${evalText}.`,
        `Student rating: ${activeProfile?.currentRating ?? 1420}.`,
        '',
        `Answer in 2-4 sentences. Stay grounded in the position.`,
      ].join('\n');

      // Tactical context for the follow-up question.
      const askStudentColor = targetFen.split(' ')[1] === 'b' ? 'b' : 'w';
      const askStudentRating =
        useAppStore.getState().activeProfile?.puzzleRating ?? 1200;
      const askTactics = buildTacticsLiveContext(
        targetFen,
        analysis,
        askStudentColor,
        askStudentRating,
      );
      let response = '';
      const result = await coachService.ask(
        {
          surface: 'standalone-chat',
          ask,
          liveState: {
            surface: 'standalone-chat',
            fen: targetFen,
            evalCp: analysis.isMate ? undefined : analysis.evaluation,
            evalMateIn: analysis.mateIn ?? undefined,
            userJustDid: `Asked: "${question.slice(0, 60)}"`,
            tactics: askTactics,
          },
        },
        {
          task: 'chat_response',
          maxTokens: 400,
          maxToolRoundTrips: 1,
          onChunk: (chunk: string) => {
            if (!mountedRef.current) return;
            response += chunk;
            setExplanation((prev) => `${prev}\n\n${response}`);
            pushAccumulated(response);
          },
        },
      );
      if (!mountedRef.current) return;
      const finalText = unwrapSpineError(result.text);
      if (!finalText) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'ExplainPositionSessionView.handleFollowUp',
          summary: result.text.slice(0, 120),
          fen: targetFen,
        });
      } else if (!voiceMuted && dispatcherRef.current.count() === 0) {
        void voiceService.speakIfFree(finalText.slice(0, 400));
      }
      setLoading(false);
    },
    [targetFen, analysis, activeProfile, voiceMuted, pushAccumulated],
  );

  const evalDisplay = analysis
    ? analysis.isMate
      ? `#${analysis.mateIn ?? ''}`
      : `${analysis.evaluation > 0 ? '+' : ''}${(analysis.evaluation / 100).toFixed(2)}`
    : null;

  const header = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-bold text-theme-text truncate">
          Position analysis
        </h1>
        <div className="text-xs text-theme-text-muted uppercase tracking-wide">
          Stockfish depth {ANALYSIS_DEPTH}
          {evalDisplay ? ` · ${evalDisplay}` : ''}
        </div>
      </div>
      <button
        onClick={() => setVoiceMuted((v) => !v)}
        className="shrink-0 p-2 rounded-lg bg-theme-surface border border-theme-border"
        aria-label={voiceMuted ? 'Unmute voice' : 'Mute voice'}
      >
        {voiceMuted ? (
          <VolumeOff size={16} className="text-theme-text-muted" />
        ) : (
          <Volume2 size={16} className="text-theme-accent" />
        )}
      </button>
      <button
        onClick={onExit}
        className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-theme-surface border border-theme-border text-sm"
        aria-label="Back to chat"
      >
        <ArrowLeft size={16} />
        Chat
      </button>
    </div>
  );

  const controls = (
    <ChatInput
      onSend={(text) => void handleFollowUp(text)}
      disabled={loading}
      placeholder="Ask a follow-up about this position…"
    />
  );

  return (
    <ChessLessonLayout
      header={header}
      board={
        <ConsistentChessboard
          fen={targetFen}
          boardOrientation={orientation}
          interactive={false}
        />
      }
      controls={controls}
      belowControls={
        (explanation || loading) ? (
          <motion.div
            className="mt-2 rounded-lg border border-theme-border bg-theme-surface p-4"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {loading && !explanation && (
              <div className="flex items-center gap-2 text-theme-text-muted">
                <Loader size={14} className="animate-spin" />
                <span className="text-sm">Thinking about the position…</span>
              </div>
            )}
            {explanation && (
              <p
                className="text-sm text-theme-text leading-relaxed whitespace-pre-wrap"
                data-testid="explain-position-text"
              >
                {explanation}
              </p>
            )}
          </motion.div>
        ) : undefined
      }
    />
  );
}
