import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Loader } from 'lucide-react';
import { motion } from 'framer-motion';
import { ControlledChessBoard } from '../Board/ControlledChessBoard';
import { ChatInput } from './ChatInput';
import { useChessGame } from '../../hooks/useChessGame';
import { useBoardContext } from '../../hooks/useBoardContext';
import { useAppStore } from '../../stores/appStore';
import { stockfishEngine } from '../../services/stockfishEngine';
import { coachService } from '../../coach/coachService';
import { voiceService } from '../../services/voiceService';
import { createStreamingSpeaker, type StreamingSpeaker } from '../../services/streamingSpeaker';
import { SENTENCE_END_RE, unwrapSpineError } from '../../services/sanitizeCoachText';
import { logAppAudit } from '../../services/appAuditor';
import type { StockfishAnalysis } from '../../types';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function CoachAnalysePage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);

  const game = useChessGame();

  // Publish board context for global coach drawer
  const turn = game.fen.split(' ')[1] === 'b' ? 'b' : 'w';
  const lastSan = game.history.length > 0 ? game.history[game.history.length - 1] : undefined;
  const ctxLastMove = game.lastMove && lastSan ? { ...game.lastMove, san: lastSan } : undefined;
  useBoardContext(game.fen, '', 0, 'white', turn, ctxLastMove, game.history);

  const [fenInput, setFenInput] = useState('');
  const [analysis, setAnalysis] = useState<StockfishAnalysis | null>(null);
  const [coachExplanation, setCoachExplanation] = useState('');
  const [loading, setLoading] = useState(false);
  const [candidateMoves, setCandidateMoves] = useState<string[]>([]);

  // Streaming-voice dispatcher refs — same pattern as CoachSessionPlanPage.
  // Each completed sentence speaks via speakForced as soon as the
  // SENTENCE_END_RE terminator arrives in the stream (first sentence
  // within ~500ms instead of waiting for full LLM completion).
  // `createStreamingSpeaker` encapsulates the abandoned-on-busy chain
  // semantics — see streamingSpeaker.ts.
  const speakerRef = useRef<StreamingSpeaker>(createStreamingSpeaker());
  const dispatchSentencesFromChunk = useCallback((accumulated: string) => {
    let remaining = accumulated;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(remaining)) !== null) {
      const endIdx = match.index + match[1].length;
      const sentence = remaining.slice(0, endIdx).trim();
      if (sentence) speakerRef.current.add(sentence);
      remaining = remaining.slice(endIdx);
      consumed += endIdx;
    }
    void consumed;
  }, []);

  const analysePosition = useCallback(async (fen: string) => {
    setLoading(true);
    setCoachExplanation('');
    // Cut any in-flight TTS before starting a new narration. Fresh
    // speaker so a prior stream's abandoned flag doesn't carry over.
    voiceService.stop();
    speakerRef.current = createStreamingSpeaker();

    try {
      // Run Stockfish analysis
      const sfAnalysis = await stockfishEngine.analyzePosition(fen, 18);
      setAnalysis(sfAnalysis);

      // Extract candidate moves
      const moves = sfAnalysis.topLines.map((line) => line.moves[0]).filter((m): m is string => Boolean(m));
      setCandidateMoves(moves);

      // Audit-driven (#4): route through coachService.ask so the
      // unified envelope (memory + live-state + tool-belt) wraps
      // this call. task='chat_response' keeps a non-reasoner model
      // — same fix as phase-narration. The Stockfish analysis is
      // threaded into the user message via plain prose since the
      // spine's envelope already provides eval context separately.
      const evalText = sfAnalysis.isMate
        ? `Mate in ${sfAnalysis.mateIn ?? '?'}`
        : `${(sfAnalysis.evaluation / 100).toFixed(2)} pawns (white perspective)`;
      const candidateLines = sfAnalysis.topLines.slice(0, 3).map((line, i) => {
        const moveSeq = line.moves.slice(0, 5).join(' ');
        const lineEval = line.mate !== null ? `M${line.mate}` : (line.evaluation / 100).toFixed(2);
        return `  ${i + 1}. ${moveSeq} (${lineEval})`;
      }).join('\n');
      const ask = [
        `Analyze this position deeply.`,
        `FEN: ${fen}`,
        `Engine eval: ${evalText} at depth ${sfAnalysis.depth}.`,
        `Top engine candidates:`,
        candidateLines,
        '',
        `Student rating: ${activeProfile?.currentRating ?? 1420}.`,
        activeProfile?.badHabits.filter((h) => !h.isResolved).length
          ? `Active weaknesses: ${activeProfile.badHabits.filter((h) => !h.isResolved).map((h) => h.description).join('; ')}.`
          : 'No active weaknesses on file.',
        '',
        `Explain the position in 4-6 sentences: who's better, why, key plans for both sides, what to watch for.`,
      ].join('\n');

      let explanation = '';
      const result = await coachService.ask(
        {
          surface: 'standalone-chat',
          ask,
          liveState: {
            surface: 'standalone-chat',
            fen,
            evalCp: sfAnalysis.isMate ? undefined : sfAnalysis.evaluation,
            evalMateIn: sfAnalysis.mateIn ?? undefined,
            userJustDid: 'Loaded a position into Analyse',
          },
        },
        {
          task: 'chat_response',
          maxTokens: 600,
          maxToolRoundTrips: 1,
          onChunk: (chunk: string) => {
            explanation += chunk;
            setCoachExplanation(explanation);
            dispatchSentencesFromChunk(explanation);
          },
        },
      );
      const finalText = unwrapSpineError(result.text);
      if (!finalText) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'CoachAnalysePage.analysePosition',
          summary: result.text.slice(0, 120),
          fen,
        });
      } else if (speakerRef.current.count() === 0) {
        // Fallback: if no sentence terminator fired (very short
        // response), speak whatever we got.
        void voiceService.speakIfFree(finalText.slice(0, 600));
      }
    } catch (error) {
      console.error('Analysis error:', error);
      setCoachExplanation('I had trouble analysing that position. Please check the FEN and try again.');
    } finally {
      setLoading(false);
    }
  }, [activeProfile, dispatchSentencesFromChunk]);

  const handleLoadFen = useCallback(() => {
    const fen = fenInput.trim() || START_FEN;
    const loaded = game.loadFen(fen);
    if (loaded) {
      void analysePosition(fen);
    }
  }, [fenInput, game, analysePosition]);

  const handleMoveOnBoard = useCallback((moveResult: { fen: string }) => {
    void analysePosition(moveResult.fen);
  }, [analysePosition]);

  const handleFollowUp = useCallback(async (question: string) => {
    setLoading(true);
    voiceService.stop();
    speakerRef.current = createStreamingSpeaker();

    const evalText = analysis
      ? (analysis.isMate
          ? `Mate in ${analysis.mateIn ?? '?'}`
          : `${(analysis.evaluation / 100).toFixed(2)} pawns`)
      : 'no engine eval cached';
    const ask = [
      `Student question: ${question}`,
      `Position FEN: ${game.fen}`,
      `Engine eval: ${evalText}.`,
      `Student rating: ${activeProfile?.currentRating ?? 1420}.`,
      '',
      `Answer in 2-4 sentences. Stay grounded in the position.`,
    ].join('\n');

    let response = '';
    const result = await coachService.ask(
      {
        surface: 'standalone-chat',
        ask,
        liveState: {
          surface: 'standalone-chat',
          fen: game.fen,
          evalCp: analysis && !analysis.isMate ? analysis.evaluation : undefined,
          evalMateIn: analysis?.mateIn ?? undefined,
          userJustDid: `Asked: "${question.slice(0, 60)}"`,
        },
      },
      {
        task: 'chat_response',
        maxTokens: 400,
        maxToolRoundTrips: 1,
        onChunk: (chunk: string) => {
          response += chunk;
          setCoachExplanation((prev) => prev + '\n\n' + response);
          dispatchSentencesFromChunk(response);
        },
      },
    );
    const finalText = unwrapSpineError(result.text);
    if (!finalText) {
      void logAppAudit({
        kind: 'llm-error',
        category: 'subsystem',
        source: 'CoachAnalysePage.handleFollowUp',
        summary: result.text.slice(0, 120),
      });
    } else if (speakerRef.current.count() === 0) {
      void voiceService.speakIfFree(finalText.slice(0, 400));
    }
    setLoading(false);
  }, [game.fen, analysis, activeProfile, dispatchSentencesFromChunk]);

  return (
    <div className="flex flex-col pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 max-w-2xl mx-auto w-full" data-testid="coach-analyse-page">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-theme-border">
        <button onClick={() => void navigate('/coach')} className="p-1.5 rounded-lg hover:bg-theme-surface">
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div>
          <h2 className="text-sm font-semibold text-theme-text">
            Position Analysis
          </h2>
        </div>
      </div>

      {/* FEN Input */}
      <div className="flex gap-2 px-4 pt-4">
        <input
          type="text"
          value={fenInput}
          onChange={(e) => setFenInput(e.target.value)}
          placeholder="Paste FEN or use the board..."
          className="flex-1 px-3 py-2 rounded-lg border border-theme-border bg-theme-surface text-sm text-theme-text placeholder:text-theme-text-muted"
          data-testid="fen-input"
        />
        <button
          onClick={handleLoadFen}
          disabled={loading}
          className="flex items-center gap-1 px-4 py-2 rounded-lg bg-theme-accent text-white text-sm font-medium disabled:opacity-50"
          data-testid="load-fen-btn"
        >
          <Search size={14} />
          Analyse
        </button>
      </div>

      {/* Board */}
      <div className="px-2 py-1 flex justify-center">
        <div className="w-full md:max-w-[420px]">
          <ControlledChessBoard
            game={game}
            interactive
            showEvalBar={!!analysis}
            evaluation={analysis?.evaluation}
            isMate={analysis?.isMate}
            mateIn={analysis?.mateIn}
            onMove={handleMoveOnBoard}
          />
        </div>
      </div>

      {/* Candidate Moves */}
      {candidateMoves.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-theme-text-muted">Candidate moves:</span>
            {candidateMoves.map((move, i) => (
              <span key={i} className="text-xs font-mono px-2 py-0.5 rounded bg-theme-surface border border-theme-border text-theme-text">
                {move}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Coach Explanation */}
      {(coachExplanation || loading) && (
        <motion.div
          className="mx-4 mb-2 bg-theme-surface rounded-lg p-4 border border-theme-border"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {loading && !coachExplanation && (
            <div className="flex items-center gap-2 text-theme-text-muted">
              <Loader size={14} className="animate-spin" />
              <span className="text-sm">Analysing position...</span>
            </div>
          )}
          {coachExplanation && (
            <p className="text-sm text-theme-text leading-relaxed whitespace-pre-wrap" data-testid="coach-explanation">
              {coachExplanation}
            </p>
          )}
        </motion.div>
      )}

      {/* Follow-up input */}
      <ChatInput
        onSend={(text) => void handleFollowUp(text)}
        disabled={loading}
        placeholder="Ask a follow-up question..."
      />
    </div>
  );
}
