import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Volume2, VolumeOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useCoachSessionStore } from '../../stores/coachSessionStore';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { routeChatIntent } from '../../services/coachSessionRouter';
import { detectNarrationToggle, applyNarrationToggle } from '../../services/coachAgentRunner';
import { coachService } from '../../coach/coachService';
import type { LiveState } from '../../coach/types';
import { logAppAudit } from '../../services/appAuditor';
import { voiceService } from '../../services/voiceService';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import type { ChatMessage as ChatMessageType } from '../../types';

/** Strip the brain's `[BOARD:...]` and `[ACTION:...]` / `[[ACTION:...]]`
 *  tags from display text. Tags are parsed and dispatched by the spine;
 *  the user shouldn't see them in the chat bubble. WO-COACH-RESILIENCE
 *  part C added the single-bracket form (Audit Finding 32). */
const TAG_STRIP_RE = /\[BOARD:[^\]]*\]|\[\[ACTION:[^\]]*\]\]|\[ACTION:[^\]]*\]/gi;

const STARTER_CHIPS = [
  'Play the Italian against me',
  'Play Black against me',
  'Narrate my last game',
  'Walk me through the Sicilian',
  'Key insights from my last game',
  "What's my worst opening?",
] as const;

/** "Read this to me" / "read that aloud" / "speak it" — user wants the
 *  previous coach message spoken verbatim, not re-summarized. */
const READ_THIS_RE =
  /^\s*(?:please\s+)?(?:read|say|speak|narrate)\s+(?:this|that|it|the\s+(?:last|previous)\s+(?:message|reply|response))(?:\s+(?:to\s+me|aloud|out\s+loud|for\s+me))?[.!?\s]*$/i;

/** Strip markdown/tags so Polly/Web Speech doesn't read "asterisk asterisk
 *  bold asterisk asterisk". Intentionally not a full Markdown parser. */
function stripMarkdownForTts(text: string): string {
  return text
    .replace(/\[BOARD:[^\]]*\]/gi, '')
    // WO-COACH-RESILIENCE part C: strip BOTH bracket variants. The
    // double-bracket form was leaking through to Polly (Audit
    // Finding 32: '[[ACTION:play_move {"san":"e4"}]] Done.').
    .replace(/\[\[ACTION:[^\]]*\]\]/gi, '')
    .replace(/\[ACTION:[^\]]*\]/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/→/g, 'to')
    .replace(/\s+/g, ' ')
    .trim();
}

export function CoachChatPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeProfile = useAppStore((s) => s.activeProfile);
  const chatMessages = useCoachSessionStore((s) => s.messages);
  const appendMessage = useCoachSessionStore((s) => s.appendMessage);
  const hydrate = useCoachSessionStore((s) => s.hydrate);
  const hydrated = useCoachSessionStore((s) => s.hydrated);
  const setCurrentRoute = useCoachSessionStore((s) => s.setCurrentRoute);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingModality, setStreamingModality] = useState<'voice' | 'text'>('text');
  const [voiceMuted, setVoiceMuted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const speechBufferRef = useRef('');
  const voiceMutedRef = useRef(false);

  // Hydrate persisted session on mount and publish current route.
  useEffect(() => {
    if (!hydrated) void hydrate();
    setCurrentRoute('/coach/chat');
  }, [hydrate, hydrated, setCurrentRoute]);

  // Keep ref in sync for use inside streaming callback
  useEffect(() => {
    voiceMutedRef.current = voiceMuted;
  }, [voiceMuted]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, streamingContent]);

  // (Audit-driven cleanup #23: deleted unused `flushSpeechBuffer`
  // helper that called the deprecated `voiceService.speak` API and
  // had no callers — it lived in handleSend's deps array as dead
  // weight. The chained `speakOrQueue` pattern below replaced it.)

  const handleSend = useCallback(async (text: string, modality: 'voice' | 'text' = 'text') => {
    // Guard: if the persisted session hasn't hydrated yet, refuse to
    // send so old messages don't suddenly appear MID-stream and race
    // with the new response. Dexie reads are fast locally but on a
    // cold start the hydrate() call is unawaited (fire-and-forget in
    // the mount effect), so a keystroke race is possible. Dropping
    // the send is safer than corrupting the transcript ordering —
    // user can retry after the input re-enables in the next tick.
    if (!activeProfile || isStreaming || !hydrated) return;

    // Deterministic narration toggle — flips voice on/off reliably
    // without depending on LLM prompt-following. When enabling from
    // the chat page (not mid-game), ALSO navigate to a new play
    // session so "narrate a game while we play" actually starts one.
    // Mirror chat turns into the spine's conversation memory so the
    // brain's next envelope reflects the back-and-forth. The LLM path
    // below already does this; fast-paths (narration toggle, read-this,
    // intent router) used to skip the memory write, leaving the brain
    // blind to anything the user did via deterministic routes.
    const recordTurn = (role: 'user' | 'coach', textContent: string): void => {
      useCoachMemoryStore.getState().appendConversationMessage({
        surface: 'chat-coach-tab',
        role,
        text: textContent,
        trigger: null,
      });
    };

    const narrationToggle = detectNarrationToggle(text);
    if (narrationToggle) {
      appendMessage({
        id: `msg-${Date.now()}-u`,
        role: 'user',
        content: text,
        modality,
        timestamp: Date.now(),
      });
      recordTurn('user', text);
      const ack = applyNarrationToggle(narrationToggle.enable);
      appendMessage({
        id: `msg-${Date.now()}-narr`,
        role: 'assistant',
        content: ack,
        modality,
        timestamp: Date.now(),
      } satisfies ChatMessageType);
      recordTurn('coach', ack);
      if (narrationToggle.enable) {
        void navigate('/coach/session/play-against?narrate=1');
      }
      return;
    }

    // "Read this to me" — speak the last coach message verbatim
    // (markdown-stripped). Bypass the LLM so the spoken words match
    // what's on screen instead of being paraphrased. Append the user
    // message to the session store so the transcript stays honest.
    if (READ_THIS_RE.test(text)) {
      const lastAssistant = [...chatMessages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant) {
        appendMessage({
          id: `msg-${Date.now()}-u`,
          role: 'user',
          content: text,
          modality,
          timestamp: Date.now(),
        });
        recordTurn('user', text);
        setVoiceMuted(false);
        voiceMutedRef.current = false;
        // Audit #5: switched from voiceService.speak() to speakForced()
        // so this "read this to me" replay shares the single-engine
        // Polly chain with the streaming dispatcher below — was racing
        // against in-flight stream chunks and producing concurrent
        // overlapping audio (the `tts-concurrent-speak` audit pattern).
        void voiceService.speakForced(stripMarkdownForTts(lastAssistant.content));
        return;
      }
    }

    // Fast-path: deterministic intent router for explicit phrases like
    // "play the KIA against me" or "review my last Catalan". Routes
    // instantly without an LLM round-trip. Falls through to the agent
    // loop for everything it doesn't recognize — that's where actions
    // like list_games / start_play with arbitrary openings live.
    try {
      const lastAssistantMessage = [...chatMessages]
        .reverse()
        .find((m) => m.role === 'assistant')?.content;
      const routed = await routeChatIntent(text, { lastAssistantMessage });
      if (routed) {
        appendMessage({
          id: `msg-${Date.now()}-u`,
          role: 'user',
          content: text,
          modality,
          timestamp: Date.now(),
        });
        recordTurn('user', text);
        appendMessage({
          id: `msg-${Date.now()}-ack`,
          role: 'assistant',
          content: routed.ackMessage,
          modality,
          timestamp: Date.now(),
        });
        recordTurn('coach', routed.ackMessage);
        if (routed.path) {
          void navigate(routed.path);
        }
        return;
      }
    } catch (err: unknown) {
      console.warn('[CoachChatPage] intent routing failed:', err);
    }

    // ── WO-BRAIN-05a — STANDALONE CHAT ROUTES THROUGH coachService ────
    // The legacy `runCoachTurn` path that built its own system prompt
    // (chat additions + analysis context + memory block) is gone. The
    // spine assembles the four-source envelope (identity, memory,
    // routes manifest, live state) on every call; this surface just
    // dispatches the ask. `navigate_to_route` graduates from stub to
    // real here too — the brain can take the user anywhere.
    setIsStreaming(true);
    setStreamingContent('');
    setStreamingModality(modality);
    speechBufferRef.current = '';

    // Append the user message into BOTH stores: session store (for
    // chat rendering) and memory store's conversationHistory (so the
    // brain envelope on the next ask reflects the back-and-forth).
    const userMsg: ChatMessageType = {
      id: `msg-${Date.now()}-u`,
      role: 'user',
      content: text,
      modality,
      timestamp: Date.now(),
    };
    appendMessage(userMsg);
    recordTurn('user', text);

    let streamed = '';
    // Stop any in-flight TTS at the START of the turn so we don't
    // stack replies. Every sentence chains through speakForced via a
    // Promise chain — single Polly engine, no Web-Speech overlap, no
    // dropped sentences from the dead speakQueuedForced path.
    const shouldSpeak = !voiceMutedRef.current || modality === 'voice';
    let speechChain: Promise<void> = Promise.resolve();
    const speakOrQueue = (sentence: string): void => {
      if (!sentence) return;
      speechChain = speechChain
        .then(() => voiceService.speakForced(sentence))
        .catch((err: unknown) => {
          console.warn('[CoachChatPage] speakForced failed:', err);
        });
    };
    if (shouldSpeak) voiceService.stop();

    const liveState: LiveState = {
      surface: 'standalone-chat',
      currentRoute: '/coach/chat',
      userJustDid: text,
    };
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'CoachChatPage.handleSend',
      summary: 'surface=standalone-chat viaSpine=true',
      details: JSON.stringify({
        surface: 'standalone-chat',
        viaSpine: true,
        modality,
        timestamp: Date.now(),
      }),
    });

    try {
      const answer = await coachService.ask(
        { surface: 'standalone-chat', ask: text, liveState },
        {
          // WO-COACH-GROUNDING (PR #338 part C): bumped from 1 to 3 so
          // the brain can call stockfish_eval / lichess_opening_lookup,
          // see the result, and synthesize a grounded answer instead of
          // skipping tools to fit a single round-trip budget.
          maxToolRoundTrips: 3,
          onNavigate: (path: string) => {
            void navigate(path);
          },
          onChunk: (chunk: string) => {
            streamed += chunk;
            // Display side: strip [BOARD:] / [[ACTION:]] tags so the
            // user sees only narrative text in the bubble.
            const displayText = streamed.replace(TAG_STRIP_RE, '').trim();
            setStreamingContent(displayText);

            if (shouldSpeak) {
              speechBufferRef.current += chunk;
              // Flush on any terminator including newline. The
              // `(?<!\d)` lookbehind keeps SAN move numbers ("1.",
              // "12.", "3.Nc3") atomic so Polly doesn't voice them
              // as standalone utterances (audit #29). Doesn't require
              // trailing whitespace — saves 200-400ms of first-word
              // latency vs the canonical SENTENCE_END_RE (which awaits
              // `\s|$`).
              const sentenceEnd = /(?<!\d)[.!?\n]/.exec(speechBufferRef.current);
              if (sentenceEnd) {
                const sentence = speechBufferRef.current.slice(0, sentenceEnd.index + 1).trim();
                speechBufferRef.current = speechBufferRef.current.slice(sentenceEnd.index + 1).trimStart();
                // Strip tags from spoken text too — never read action
                // tags out loud.
                const spoken = sentence.replace(TAG_STRIP_RE, '').trim();
                if (spoken) speakOrQueue(spoken);
              }
            }
          },
        },
      );
      // Flush any trailing text (no sentence terminator) via the same
      // gating so a tail-only reply still fires.
      if (shouldSpeak) {
        const tail = speechBufferRef.current.replace(TAG_STRIP_RE, '').trim();
        if (tail) speakOrQueue(tail);
      }
      speechBufferRef.current = '';

      // Strip tags from the final text and append the assistant
      // message into both stores (session + memory). Inherit modality
      // so the renderer can hide the text bubble for voice asks.
      const cleanText = answer.text.replace(TAG_STRIP_RE, '').trim();
      const assistantMsg: ChatMessageType = {
        id: `msg-${Date.now()}-resp`,
        role: 'assistant',
        content: cleanText,
        modality,
        timestamp: Date.now(),
      };
      appendMessage(assistantMsg);
      recordTurn('coach', cleanText);
    } catch (err) {
      console.warn('[CoachChatPage] coachService.ask failed:', err);
      // Surface the failure to the student instead of leaving a stuck
      // spinner + orphaned user message. Refresh-loses-chat was the
      // prior behaviour; now they see what went wrong.
      const detail = err instanceof Error ? err.message : 'Please try again.';
      const failureText = `⚠️ Coach is unavailable right now (${detail}). Your message is saved — tap send to retry when you\u2019re back online.`;
      appendMessage({
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: failureText,
        timestamp: Date.now(),
      });
      // Audit-driven (#18): also persist the failure to coach memory
      // so the conversation trail isn't "user asked X, then nothing."
      // The next turn's envelope sees the prior reply was a failure
      // stub — the brain can apologize and retry, or change tactic.
      // Without this write, memory shows the user asked a question
      // and the coach silently never replied.
      recordTurn('coach', failureText);
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
    }
  }, [activeProfile, hydrated, chatMessages, isStreaming, appendMessage, navigate]);

  // Auto-send a query carried in the URL (e.g., from the Game Insights
  // search bar navigating here with ?q=...). Runs once per distinct
  // query, strips the param after firing so refreshing doesn't resend,
  // and waits for the profile + hydration to be ready.
  const autoSentQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProfile || !hydrated) return;
    const q = searchParams.get('q');
    if (!q || !q.trim()) return;
    if (autoSentQueryRef.current === q) return;
    autoSentQueryRef.current = q;
    // Strip ?q= immediately so navigating back here doesn't resend it
    // and refreshing stays clean.
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    setSearchParams(next, { replace: true });
    void handleSend(q);
  }, [activeProfile, hydrated, searchParams, setSearchParams, handleSend]);

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] pb-16 md:pb-0 max-w-2xl mx-auto w-full" data-testid="coach-chat-page">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-theme-border">
        <button
          onClick={() => void navigate('/coach')}
          className="p-1.5 rounded-lg hover:bg-theme-surface transition-colors"
        >
          <ArrowLeft size={20} className="text-theme-text" />
        </button>
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold bg-theme-accent"
        >
          C
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-theme-text">
            Chat with Coach
          </h2>
          <p className="text-xs text-theme-text-muted">
            {isStreaming ? 'Typing...' : 'Online'}
          </p>
        </div>
        <button
          onClick={() => {
            setVoiceMuted((prev) => !prev);
            if (!voiceMuted) voiceService.stop();
          }}
          className="p-2 rounded-lg hover:bg-theme-surface transition-colors"
          data-testid="voice-toggle"
          title={voiceMuted ? 'Unmute voice' : 'Mute voice'}
        >
          {voiceMuted
            ? <VolumeOff size={18} className="text-theme-text-muted" />
            : <Volume2 size={18} className="text-theme-accent" />
          }
        </button>
      </div>

      {/* Messages */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y p-4 space-y-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Coach chat messages"
      >
        {chatMessages.length === 0 && !isStreaming && (
          <motion.div
            className="flex flex-col items-center gap-5 py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            data-testid="coach-greeting"
          >
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-bold bg-theme-accent"
            >
              C
            </div>
            <div className="text-center max-w-sm">
              <p className="text-lg font-semibold text-theme-text">
                How can I help you today?
              </p>
              <p className="text-xs text-theme-text-muted mt-2 leading-relaxed">
                I can play you at any strength, narrate your games move-by-move,
                study your history for patterns, walk through openings, and
                answer any chess question.
              </p>
            </div>
            <div className="w-full max-w-md">
              <p className="text-xs text-theme-text-muted mb-2">
                You can ask me to:
              </p>
              <div className="flex flex-wrap gap-2">
                {STARTER_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => void handleSend(chip)}
                    className="text-xs px-3 py-2 rounded-full border border-theme-border bg-theme-surface text-theme-text hover:border-theme-accent hover:text-theme-accent transition-colors"
                    data-testid="coach-starter-chip"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {chatMessages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
          />
        ))}

        {isStreaming && streamingContent && (
          <ChatMessage
            message={{
              id: 'streaming',
              role: 'assistant',
              content: streamingContent,
              modality: streamingModality,
              timestamp: Date.now(),
            }}
            isStreaming
          />
        )}

        {isStreaming && !streamingContent && (
          <ChatMessage
            message={{
              id: 'streaming-empty',
              role: 'assistant',
              content: '',
              modality: streamingModality,
              timestamp: Date.now(),
            }}
            isStreaming
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <ChatInput
        onSend={(text) => void handleSend(text)}
        disabled={isStreaming}
        placeholder="Ask your coach anything..."
      />
    </div>
  );
}
