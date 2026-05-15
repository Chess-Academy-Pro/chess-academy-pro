import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Clock, Loader } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppStore } from '../../stores/appStore';
import { generateCoachSession } from '../../services/sessionGenerator';
import { createSession } from '../../services/sessionGenerator';
import { coachService } from '../../coach/coachService';
import { logAppAudit } from '../../services/appAuditor';
import { SENTENCE_END_RE } from '../../services/sanitizeCoachText';
import { voiceService } from '../../services/voiceService';
import { createStreamingSpeaker, type StreamingSpeaker } from '../../services/streamingSpeaker';
import { SESSION_PLAN_ADDITION } from '../../services/coachPrompts';
import { ChatInput } from './ChatInput';
import type { SessionPlan, SessionBlock } from '../../types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const BLOCK_LABELS: Record<string, { label: string; color: string; emoji: string }> = {
  opening_review: { label: 'Opening Review', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20', emoji: '📖' },
  puzzle_drill: { label: 'Puzzle Training', color: 'bg-green-500/10 text-green-500 border-green-500/20', emoji: '🧩' },
  flashcards: { label: 'Flashcards', color: 'bg-purple-500/10 text-purple-500 border-purple-500/20', emoji: '🃏' },
  endgame_drill: { label: 'Endgame Practice', color: 'bg-orange-500/10 text-orange-500 border-orange-500/20', emoji: '♔' },
  game_analysis: { label: 'Game Analysis', color: 'bg-red-500/10 text-red-500 border-red-500/20', emoji: '🔍' },
  master_game_study: { label: 'Master Games', color: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20', emoji: '👑' },
};

function SessionBlockCard({ block, index }: { block: SessionBlock; index: number }): JSX.Element {
  const meta = BLOCK_LABELS[block.type] ?? { label: block.type, color: 'bg-theme-surface', emoji: '📋' };

  return (
    <motion.div
      className={`flex items-center gap-3 p-3 rounded-lg border ${meta.color}`}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1 }}
    >
      <span className="text-xl">{meta.emoji}</span>
      <div className="flex-1">
        <p className="text-sm font-medium">{meta.label}</p>
        {block.puzzleTheme && (
          <p className="text-xs opacity-75">Focus: {block.puzzleTheme}</p>
        )}
      </div>
      <div className="flex items-center gap-1 text-xs opacity-75">
        <Clock size={12} />
        {block.targetMinutes} min
      </div>
    </motion.div>
  );
}

export function CoachSessionPlanPage(): JSX.Element {
  const navigate = useNavigate();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setCurrentSession = useAppStore((s) => s.setCurrentSession);

  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [coachExplanation, setCoachExplanation] = useState('');
  const [loading, setLoading] = useState(true);
  const [adjusting, setAdjusting] = useState(false);

  // Streaming-voice dispatcher. Kept across renders so the sentence
  // chain doesn't restart on each setCoachExplanation call. First-
  // sentence-fast: each completed sentence speaks ~500ms after the
  // first chunk arrives instead of waiting for the full LLM response
  // (the prior shape delayed audio by 3-5s).
  // `createStreamingSpeaker` encapsulates the abandoned-on-busy chain
  // semantics — see streamingSpeaker.ts.
  const speakerRef = useRef<StreamingSpeaker>(createStreamingSpeaker());

  const dispatchSentencesFromChunk = useCallback((accumulatedText: string) => {
    let remaining = accumulatedText;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(remaining)) !== null) {
      const endIdx = match.index + match[1].length;
      const sentence = remaining.slice(0, endIdx).trim();
      if (sentence) speakerRef.current.add(sentence);
      remaining = remaining.slice(endIdx);
    }
  }, []);

  // Generate initial plan
  useEffect(() => {
    if (!activeProfile) return;

    const generatePlan = async (): Promise<void> => {
      try {
        const sessionPlan = await generateCoachSession(activeProfile);
        setPlan(sessionPlan);

        // WO-COACH-UNIFY-01: route through coachService.ask so the
        // unified envelope (memory + live-state + tool-belt) wraps
        // this call. task='chat_response' keeps a non-reasoner model
        // (chat-tier on both providers) so the heavy spine envelope
        // doesn't push deepseek-reasoner into empty-content territory
        // — same fix that resolved phase-narration.
        const planAsk = [
          `Session plan generated:`,
          ...sessionPlan.blocks.map((b) => `- ${b.type} (${b.targetMinutes} min)`),
          `Total: ${sessionPlan.totalMinutes} minutes.`,
          `Student rating: ${activeProfile.currentRating}.`,
          activeProfile.badHabits.filter((h) => !h.isResolved).length > 0
            ? `Active weaknesses: ${activeProfile.badHabits.filter((h) => !h.isResolved).map((h) => h.description).join('; ')}.`
            : 'No active weaknesses on file.',
          '',
          'Explain the plan to the student in 3-5 sentences. Why these blocks, in this order, given their rating and weaknesses.',
        ].join('\n');

        speakerRef.current = createStreamingSpeaker();
        let explanation = '';
        const result = await coachService.ask(
          {
            surface: 'standalone-chat',
            ask: planAsk,
            liveState: {
              surface: 'standalone-chat',
              fen: STARTING_FEN,
              userJustDid: 'Opening the Training Plan tab',
            },
          },
          {
            task: 'chat_response',
            maxTokens: 800,
            maxToolRoundTrips: 1,
            systemPromptAddition: SESSION_PLAN_ADDITION,
            onChunk: (chunk: string) => {
              explanation += chunk;
              setCoachExplanation(explanation);
              // Drive Polly first-sentence-fast playback as the LLM
              // streams. Replaces the legacy after-the-fact
              // voiceService.speak(explanation.slice(0, 300)) call,
              // which couldn't start until the WHOLE response landed.
              dispatchSentencesFromChunk(explanation);
            },
          },
        );
        // Final flush in case the response ended without a sentence
        // terminator on the tail (rare but possible mid-clause).
        const isProviderError = result.text.startsWith('(coach-brain provider error:');
        if (isProviderError) {
          // Audit-driven fix (item #13): silent strip used to swallow
          // every spine error, so a "session plan voice didn't speak"
          // report had no signal. Now an llm-error audit fires.
          void logAppAudit({
            kind: 'llm-error',
            category: 'subsystem',
            source: 'CoachSessionPlanPage.generatePlan',
            summary: result.text.slice(0, 120),
          });
        }
        const finalText = isProviderError ? '' : result.text;
        if (finalText && speakerRef.current.count() === 0) {
          // Fallback: if no sentence terminator fired during streaming
          // (very short response, no period), speak whatever we got.
          void voiceService.speakIfFree(finalText.slice(0, 600));
        }
      } catch (error) {
        console.error('Plan generation error:', error);
        setCoachExplanation('Let me create a training plan for you based on your current progress.');
      } finally {
        setLoading(false);
      }
    };

    void generatePlan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle pushback / adjustment — same spine + streaming voice
  // shape as the initial plan generation.
  const handlePushback = useCallback(async (text: string) => {
    if (!activeProfile || !plan) return;

    setAdjusting(true);
    // Stop any in-flight narration from the prior plan; the
    // adjustment will start its own sentence chain.
    voiceService.stop();
    speakerRef.current = createStreamingSpeaker();

    try {
      const adjustedPlan = await generateCoachSession(activeProfile, text);
      setPlan(adjustedPlan);

      const adjustAsk = [
        `Student feedback: "${text}"`,
        `Adjusted plan based on that feedback:`,
        ...adjustedPlan.blocks.map((b) => `- ${b.type} (${b.targetMinutes} min)`),
        `Total: ${adjustedPlan.totalMinutes} minutes.`,
        `Student rating: ${activeProfile.currentRating}.`,
        '',
        'Acknowledge the adjustment in 2-3 sentences. What changed and why this fits their feedback.',
      ].join('\n');

      let explanation = '';
      const result = await coachService.ask(
        {
          surface: 'standalone-chat',
          ask: adjustAsk,
          liveState: {
            surface: 'standalone-chat',
            fen: STARTING_FEN,
            userJustDid: `Asked to adjust the plan: "${text.slice(0, 60)}"`,
          },
        },
        {
          task: 'chat_response',
          maxTokens: 600,
          maxToolRoundTrips: 1,
          systemPromptAddition: SESSION_PLAN_ADDITION,
          onChunk: (chunk: string) => {
            explanation += chunk;
            setCoachExplanation(explanation);
            dispatchSentencesFromChunk(explanation);
          },
        },
      );
      const isProviderError = result.text.startsWith('(coach-brain provider error:');
      if (isProviderError) {
        void logAppAudit({
          kind: 'llm-error',
          category: 'subsystem',
          source: 'CoachSessionPlanPage.handlePushback',
          summary: result.text.slice(0, 120),
        });
      }
      const finalText = isProviderError ? '' : result.text;
      if (finalText && speakerRef.current.count() === 0) {
        void voiceService.speakIfFree(finalText.slice(0, 400));
      }
    } catch {
      setCoachExplanation('Sure, I\'ve adjusted the plan. Let me know if this works better for you.');
    } finally {
      setAdjusting(false);
    }
  }, [activeProfile, plan, dispatchSentencesFromChunk]);

  // Start session
  const handleStartSession = useCallback(async () => {
    if (!activeProfile || !plan) return;

    const session = await createSession(activeProfile);
    setCurrentSession(session);

    // Navigate to first block
    const firstBlock = plan.blocks[0] as SessionBlock | undefined;
    if (firstBlock !== undefined) {
      switch (firstBlock.type) {
        case 'opening_review':
          void navigate(firstBlock.openingId ? `/openings/${firstBlock.openingId}` : '/openings');
          break;
        case 'puzzle_drill':
          void navigate('/tactics/adaptive');
          break;
        case 'flashcards':
          void navigate('/play');
          break;
        default:
          void navigate('/');
          break;
      }
    } else {
      void navigate('/');
    }
  }, [activeProfile, plan, navigate, setCurrentSession]);

  return (
    <div className="flex flex-col pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6 max-w-2xl mx-auto w-full" data-testid="coach-session-plan-page">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-theme-border">
        <button onClick={() => void navigate('/coach')} className="p-1.5 rounded-lg hover:bg-theme-surface">
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div>
          <h2 className="text-sm font-semibold text-theme-text">
            Session Plan
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Loading */}
        {loading && (
          <div className="flex items-center gap-2 text-theme-text-muted py-8 justify-center">
            <Loader size={16} className="animate-spin" />
            <span className="text-sm">Creating your personalised plan...</span>
          </div>
        )}

        {/* Plan blocks */}
        {plan && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-theme-text">Today&apos;s Plan</h3>
              <span className="text-sm text-theme-text-muted">{plan.totalMinutes} minutes</span>
            </div>

            <div className="space-y-2">
              {plan.blocks.map((block, i) => (
                <SessionBlockCard key={i} block={block} index={i} />
              ))}
            </div>
          </>
        )}

        {/* Coach explanation */}
        {coachExplanation && (
          <motion.div
            className="bg-theme-surface rounded-lg p-4 border border-theme-border"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <p className="text-sm text-theme-text leading-relaxed whitespace-pre-wrap" data-testid="plan-explanation">
              {coachExplanation}
            </p>
          </motion.div>
        )}

        {/* Start Session button */}
        {plan && !loading && (
          <motion.button
            onClick={() => void handleStartSession()}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-theme-accent text-white font-semibold text-sm hover:opacity-90 transition-opacity"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            data-testid="start-session-btn"
          >
            <Play size={18} />
            Start Session
          </motion.button>
        )}
      </div>

      {/* Pushback input */}
      <ChatInput
        onSend={(text) => void handlePushback(text)}
        disabled={loading || adjusting}
        placeholder="Want to adjust the plan? Tell me..."
      />
    </div>
  );
}
