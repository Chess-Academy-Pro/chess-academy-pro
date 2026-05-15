import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAppStore } from '../../stores/appStore';
import { sanitizeCoachText, sanitizeCoachStream, formatForSpeech } from '../../services/sanitizeCoachText';
import { routeChatIntent } from '../../services/coachSessionRouter';
import { detectNarrationToggle, applyNarrationToggle } from '../../services/coachAgentRunner';
import { parseBoardTags } from '../../services/boardAnnotationService';
import { extractMoveArrows } from '../../services/coachMoveExtractor';
import { detectInGameChatIntent } from '../../services/inGameChatIntent';
import { tryCaptureForgetIntent } from '../../services/openingIntentCapture';
import { tryRouteIntent } from '../../services/coachIntentRouter';
import { parseActions } from '../../services/coachActionDispatcher';
import { coachService } from '../../coach/coachService';
import { withTimeout } from '../../coach/withTimeout';
import type { LiveState } from '../../coach/types';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { logAppAudit } from '../../services/appAuditor';
import { voiceService } from '../../services/voiceService';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import type { ChatMessage as ChatMessageType, BoardAnnotationCommand } from '../../types';

/** Strip [BOARD: ...] tags so they don't flash during streaming.
 *  Action tags ([[ACTION:...]] and [ACTION:...]) are stripped via a
 *  separate regex (`ACTION_TAG_STRIP_RE`) so each replace call can
 *  target one concern. WO-COACH-RESILIENCE part C added the
 *  single-bracket variant to ACTION_TAG_STRIP_RE — Audit Finding 32
 *  showed `[[ACTION:play_move {"san":"e4"}]] Done.` being spoken
 *  aloud because the previous regex only matched the double-bracket
 *  form. */
// WO-COACH-TTS-STRIP-01: legacy in-file regexes replaced by the
// shared sanitizeCoachText / sanitizeCoachStream module. Old shapes
// (single-`[ACTION:]`, single-`[BOARD:...]`) are still covered there.
// The streaming version buffers chunks across in-flight `[[...]]`
// boundaries so half-arrived markers never reach Polly.

interface GameChatPanelProps {
  fen: string;
  pgn: string;
  moveNumber: number;
  playerColor: 'white' | 'black';
  turn: 'w' | 'b';
  isGameOver: boolean;
  gameResult: string;
  lastMove?: { from: string; to: string; san: string } | null;
  /** Whose move was the most recent half-ply, if known. Threads into
   *  the intent router so "take back your move" / "take back my move"
   *  pick the correct ply count. WO-AUDIT-CYCLE-8 follow-up. */
  lastMoveBy?: 'user' | 'coach';
  history?: string[];
  /** FEN of the position before the last move (for tactic classification) */
  previousFen?: string | null;
  className?: string;
  onBoardAnnotation?: (commands: BoardAnnotationCommand[]) => void;
  /** Called when the user asks in chat to restart the current game. */
  onRestartGame?: () => void;
  /** Called when the user asks in chat to play a specific opening
   *  against them. The opening name is passed through to the board's
   *  opening-book hook. */
  onPlayOpening?: (openingName: string) => void;
  /** Called when the brain (or the Layer 1 intent router) emits
   *  play_move from the chat surface — e.g. the student says "play
   *  knight to f3" and the spine executes it on their behalf.
   *  WO-COACH-OPERATOR-FOUNDATION-01. */
  onPlayMove?: (san: string) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** Called when the brain (or router) emits take_back_move. The
   *  parent reverts `count` half-moves on the live game.
   *  WO-COACH-OPERATOR-FOUNDATION-01. */
  onTakeBackMove?: (count: number) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** Called when the brain (or router) emits set_board_position. The
   *  parent jumps the board to the supplied FEN.
   *  WO-COACH-OPERATOR-FOUNDATION-01. */
  onSetBoardPosition?: (fen: string) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** Called when the brain (or router) emits reset_board. The parent
   *  restarts the game from the starting position.
   *  WO-COACH-OPERATOR-FOUNDATION-01. */
  onResetBoard?: () => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** Called when the brain emits `quiz_user_for_move` from the chat
   *  surface. The parent registers a pending quiz on the live board
   *  and resolves the Promise on the student's next move so the
   *  brain can narrate feedback in its next round-trip.
   *  WO-COACH-LICHESS-OPENINGS. */
  onQuizUserForMove?: (args: {
    expectedSan: string;
    prompt: string;
    allowAlternatives?: readonly string[];
  }) => Promise<
    | { ok: true; played: string }
    | { ok: false; played: string; expected: string }
    | { ok: false; reason: string }
  >;
  /** Called when the brain emits `start_walkthrough_for_opening`. The
   *  parent navigates to the WalkthroughMode UI seeded with the named
   *  opening / variation / orientation. WO-COACH-LICHESS-OPENINGS. */
  onStartWalkthroughForOpening?: (args: {
    opening: string;
    variation?: string;
    orientation?: 'white' | 'black';
    pgn?: string;
  }) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  /** Apply a what-if variation: take back `undo` half-moves, then play
   *  `moves` (SAN) forward. Returns true on success, false if any move
   *  was invalid or there was nothing to undo. Powers the coach's
   *  play_variation action — "what if Black plays Ne4 instead of Bh6?" */
  onPlayVariation?: (args: { undo: number; moves: string[] }) => boolean;
  /** Snap the board back to the position it was in before the first
   *  variation was applied. Returns true on success, false if no
   *  snapshot exists (no variation in progress). Powers
   *  return_to_game — "ok back to my real game". */
  onReturnToGame?: () => boolean;
  /** If set, auto-sends this message on mount (e.g., from post-game practice bridge) */
  initialPrompt?: string | null;
  /** Called after the initial prompt has been sent */
  onInitialPromptSent?: () => void;
  /** Hide the built-in header (when embedded inside a container that provides its own) */
  hideHeader?: boolean;
  /** Restore messages from a previous session (used on mount only) */
  initialMessages?: ChatMessageType[];
  /** Called whenever the messages array changes, so the parent can persist them */
  onMessagesUpdate?: (messages: ChatMessageType[]) => void;
}

export interface GameChatPanelHandle {
  injectAssistantMessage: (text: string) => void;
}

export const GameChatPanel = forwardRef<GameChatPanelHandle, GameChatPanelProps>(
  function GameChatPanel(
    {
      fen,
      playerColor,
      isGameOver,
      history,
      lastMoveBy,
      className,
      onBoardAnnotation,
      onRestartGame,
      onPlayOpening,
      onPlayMove,
      onTakeBackMove,
      onSetBoardPosition,
      onResetBoard,
      onQuizUserForMove,
      onStartWalkthroughForOpening,
      initialPrompt,
      onInitialPromptSent,
      hideHeader,
      initialMessages,
      onMessagesUpdate,
    },
    ref,
  ) {
    const activeProfile = useAppStore((s) => s.activeProfile);
    const navigate = useNavigate();
    const location = useLocation();

    const [messages, setMessagesInternal] = useState<ChatMessageType[]>(initialMessages ?? []);
    const [isStreaming, setIsStreaming] = useState(false);
    const initialPromptSentRef = useRef(false);
    const [streamingContent, setStreamingContent] = useState('');
    const speechBufferRef = useRef('');
    // Sequential TTS chain — sentence-by-sentence streaming used to fire
    // `if (!speechAbortedRef.current) void voiceService.speak(sentence)` as parallel calls. Each speak
    // internally calls voiceService.stop() before starting, so two
    // sentences arriving microseconds apart could interleave / cut off /
    // produce overlapping audio (the "two voices at once" pattern caught
    // by tts-concurrent-speak audits on build 1f23808). Chaining each
    // speak onto the previous one's resolution ensures each sentence
    // plays IN FULL before the next starts. catch() the chain so a
    // single TTS failure doesn't poison every subsequent speak.
    const speechChainRef = useRef<Promise<void>>(Promise.resolve());
    // Abort flag for the speech chain. Set to true when the component
    // unmounts (the user navigated away from /coach/play or
    // /coach/teach). Each chained .then() checks this before invoking
    // a new speak — so even if the chain has 5 sentences queued at
    // unmount time, none of them fire after the user leaves. Without
    // this the coach kept talking after leaving the classroom and
    // collided with whatever the user did next on return.
    const speechAbortedRef = useRef(false);
    useEffect(() => {
      return () => {
        speechAbortedRef.current = true;
        voiceService.stop();
      };
    }, []);
    const queueSpeak = useCallback((text: string): void => {
      // Drop markdown bold/italic markers, horizontal rules, and bare
      // list-bullet chunks before they reach Polly — otherwise the
      // sentence streamer voices "**1.**" / "---" / "**" as separate
      // utterances and the lesson sounds stuck on a fragment.
      const trimmed = formatForSpeech(text);
      if (!trimmed) return;
      // Snapshot the current stop-generation when we QUEUE this
      // utterance. If voiceService.stop() fires before our .then()
      // dispatches (route change, mic barge-in, manual interrupt),
      // the generation counter advances and we abort cleanly. Without
      // this, calling stop() cuts the current audio but the chain's
      // next .then() fires shortly after and the next sentence plays
      // anyway — exactly what made the coach "keep talking" after
      // the user left the classroom or started speaking.
      const myGen = voiceService.currentStopGeneration;
      speechChainRef.current = speechChainRef.current
        .then(() => {
          if (speechAbortedRef.current) return;
          if (voiceService.currentStopGeneration !== myGen) return;
          return voiceService.speak(trimmed);
        })
        .catch(() => undefined);
    }, []);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessageType[]>(messages);

    // Keep messagesRef in sync
    messagesRef.current = messages;

    // Wrapper that also notifies parent
    const setMessages = useCallback((updater: ChatMessageType[] | ((prev: ChatMessageType[]) => ChatMessageType[])): void => {
      setMessagesInternal((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        // Notify parent asynchronously so we don't setState during render
        queueMicrotask(() => onMessagesUpdate?.(next));
        return next;
      });
    }, [onMessagesUpdate]);

    // Reverse-flow chat: snap the scroll container to the TOP when a
    // new message lands (newest is at index 0, rendered at top).
    // Otherwise a student scrolled down reading history wouldn't see
    // the new coach reply.
    useEffect(() => {
      const el = messagesEndRef.current;
      if (el) el.scrollTop = 0;
    }, [messages, streamingContent]);

    // Expose method for parent to inject assistant messages (hints, takeback msgs)
    useImperativeHandle(ref, () => ({
      injectAssistantMessage(text: string) {
        const msg: ChatMessageType = {
          id: `coach-${Date.now()}`,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, msg]);

        // Silenced by WO-LEGACY-VOICE-01 — this path was the funnel for
        // CoachGamePage's coach tips, missed-tactic alerts, and upcoming-
        // threat warnings (all of which carry `tacticSuffix` text like
        // "Hanging: White pawn on h7"). Text surface retained: the
        // message still renders in the chat panel — only TTS is muted.
        void text;
      },
    }), [setMessages]);

    // Buffer speech to sentence boundaries
    const flushSpeechBuffer = useCallback(() => {
      const buffer = speechBufferRef.current;
      // Read latest voice state directly from store to avoid stale closures
      if (buffer.trim() && useAppStore.getState().coachVoiceOn) {
        queueSpeak(buffer);
      }
      speechBufferRef.current = '';
    }, [queueSpeak]);

    const handleSend = useCallback(async (text: string) => {
      if (!activeProfile || isStreaming) return;

      // Mirror every assistant turn (acks, error stubs, timeouts) into
      // the spine's conversation memory so the brain's next envelope
      // reflects the back-and-forth. The user-message memory write
      // happens once below (line 304) right after the user message
      // is appended. Pre-fix the LLM path here wrote to memory but
      // every fast-path / error-stub / timeout-stub wrote only to
      // local chat state, leaving the brain with dissociative amnesia
      // for anything it routed deterministically.
      const recordCoachAck = (textContent: string): void => {
        useCoachMemoryStore.getState().appendConversationMessage({
          surface: isGameOver ? 'chat-home' : 'chat-in-game',
          role: 'coach',
          text: textContent,
          fen: fen || undefined,
          trigger: null,
        });
      };

      // WO-FOUNDATION-02 trace harness — generate one UUID per
      // user message and thread it through every audit emit so the
      // pipeline can be reconstructed end-to-end. crypto.randomUUID
      // is available in modern browsers and JSDOM via webcrypto.
      const traceId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      // WO-FOUNDATION-02 — log every message that reaches the surface
      // so we can verify the router is seeing real user input (not
      // assembled context strings) on every chat send.
      void logAppAudit({
        kind: 'chat-panel-message-received',
        category: 'subsystem',
        source: 'GameChatPanel.handleSend',
        summary: `text="${text.slice(0, 100)}"`,
      });

      // Add user message
      const userMsg: ChatMessageType = {
        id: `gmsg-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      const updatedMessages = [...messagesRef.current, userMsg];
      setMessages(updatedMessages);

      // WO-BRAIN-04: thread the user ask into the coach memory store so
      // the brain envelope sees the back-and-forth on the next call.
      // Surface labels follow `CoachMessage.surface` enum.
      const conversationSurface: 'chat-in-game' | 'chat-home' = isGameOver
        ? 'chat-home'
        : 'chat-in-game';
      useCoachMemoryStore.getState().appendConversationMessage({
        surface: conversationSurface,
        role: 'user',
        text,
        fen: fen || undefined,
        trigger: null,
      });

      // ─── WO-FOUNDATION-02: Layer 1 intent-router pre-emit ────────
      // Pattern-match high-confidence command shapes BEFORE running
      // any existing pre-LLM intercepts. Matched commands dispatch
      // the surface callback directly. Zero LLM round-trip; zero
      // hallucination risk. Falls through to the existing intercepts
      // (and ultimately coachService.ask) on miss.
      const routedIntent = tryRouteIntent(text, { currentFen: fen, lastMoveBy });
      if (routedIntent) {
        void logAppAudit({
          kind: 'coach-brain-intent-routed',
          category: 'subsystem',
          source: 'GameChatPanel.handleSend',
          summary: `routed=${routedIntent.kind} bypass-llm=true`,
        });

        let ackText = 'Done.';
        let dispatchOk = false;
        let dispatchError: string | undefined;

        try {
          switch (routedIntent.kind) {
            case 'play_move': {
              if (!onPlayMove) {
                dispatchError = 'no onPlayMove callback wired';
                break;
              }
              const result = await Promise.resolve(onPlayMove(routedIntent.san));
              dispatchOk = typeof result === 'boolean' ? result : result.ok;
              if (dispatchOk) {
                ackText = `${routedIntent.san} — your move.`;
              } else {
                dispatchError =
                  typeof result === 'object' && 'reason' in result
                    ? (result.reason ?? 'rejected')
                    : 'rejected';
              }
              break;
            }
            case 'take_back_move': {
              if (!onTakeBackMove) {
                dispatchError = 'no onTakeBackMove callback wired';
                break;
              }
              const result = await Promise.resolve(onTakeBackMove(routedIntent.count));
              dispatchOk = typeof result === 'boolean' ? result : result.ok;
              if (dispatchOk) {
                ackText =
                  routedIntent.count > 1 ? 'Taken back.' : 'Taken back — your move.';
              } else {
                dispatchError =
                  typeof result === 'object' && 'reason' in result
                    ? (result.reason ?? 'nothing to take back')
                    : 'nothing to take back';
              }
              break;
            }
            case 'reset_board': {
              if (!onResetBoard) {
                dispatchError = 'no onResetBoard callback wired';
                break;
              }
              const result = await Promise.resolve(onResetBoard());
              dispatchOk = typeof result === 'boolean' ? result : result.ok;
              if (dispatchOk) {
                ackText = 'Fresh board — your move.';
              } else {
                dispatchError =
                  typeof result === 'object' && 'reason' in result
                    ? (result.reason ?? 'reset rejected')
                    : 'reset rejected';
              }
              break;
            }
            case 'set_board_position': {
              if (!onSetBoardPosition) {
                dispatchError = 'no onSetBoardPosition callback wired';
                break;
              }
              const result = await Promise.resolve(onSetBoardPosition(routedIntent.fen));
              dispatchOk = typeof result === 'boolean' ? result : result.ok;
              if (dispatchOk) {
                ackText = 'Position loaded.';
              } else {
                dispatchError =
                  typeof result === 'object' && 'reason' in result
                    ? (result.reason ?? 'set-position rejected')
                    : 'set-position rejected';
              }
              break;
            }
            case 'navigate_to_route': {
              try {
                void navigate(routedIntent.route);
                dispatchOk = true;
                ackText = 'On it.';
              } catch (err) {
                dispatchError = err instanceof Error ? err.message : String(err);
              }
              break;
            }
          }
        } catch (err) {
          dispatchError = err instanceof Error ? err.message : String(err);
        }

        void logAppAudit({
          kind: 'coach-brain-tool-called',
          category: 'subsystem',
          source: 'GameChatPanel.handleSend',
          summary: `${routedIntent.kind} ${dispatchOk ? 'ok' : 'failed'} (router-direct)`,
          details: dispatchError ? `error=${dispatchError}` : undefined,
        });

        if (dispatchOk) {
          // Append a brief assistant ack to the chat so the user sees
          // a response. Mirrors the pattern existing intercepts use
          // (e.g., the restart-game / play-opening ack blocks below).
          const ackMsg: ChatMessageType = {
            id: `gmsg-${Date.now()}-routed`,
            role: 'assistant',
            content: ackText,
            timestamp: Date.now(),
          };
          setMessages([...updatedMessages, ackMsg]);
          recordCoachAck(ackText);
          if (useAppStore.getState().coachVoiceOn) {
            if (!speechAbortedRef.current) void voiceService.speak(ackText);
          }
          return;
        }
        // Match-but-failed (e.g., illegal SAN, nothing to take back):
        // fall through so the LLM can elaborate on why the command
        // didn't land. The user's original text is still in scope.
      }

      // WO-BRAIN-03: both branches now route through the brain. The
      // deterministic `tryCaptureOpeningIntent` regex shortcut is
      // retired entirely — `set_intended_opening` is in the brain's
      // toolbelt and the LLM emits it from either surface. The
      // `tryCaptureForgetIntent` regex stays for one more WO as a
      // belt-and-suspenders safety net. Removed in BRAIN-06 cleanup.
      const surface = isGameOver ? 'drawer-chat' : 'in-game-chat';
      tryCaptureForgetIntent(text, surface);

      // Narration toggle — deterministic intercept. Runs BEFORE the
      // in-game block below so "narrate while we play" reliably flips
      // the flag even during an active game (which the in-game branch
      // would otherwise handle via its own narrate case). This path
      // uses applyNarrationToggle from coachAgentRunner for consistency
      // with CoachChatPage.
      const narrationToggle = detectNarrationToggle(text);
      if (narrationToggle) {
        const ack = applyNarrationToggle(narrationToggle.enable);
        const ackMsg: ChatMessageType = {
          id: `gmsg-${Date.now()}-narr`,
          role: 'assistant',
          content: ack,
          timestamp: Date.now(),
        };
        setMessages([...updatedMessages, ackMsg]);
        recordCoachAck(ack);
        if (narrationToggle.enable) {
          if (!speechAbortedRef.current) void voiceService.speak(ack);
        } else {
          voiceService.stop();
        }
        return;
      }

      // In-game intents: short-circuit the LLM for actions that actually
      // need to change the board (restart, play a specific opening,
      // mute). Previously "Restart the game" would produce a narrative
      // reply but the board stayed where it was — the chat had no way
      // to mutate game state. Handle those here.
      if (!isGameOver) {
        const inGame = detectInGameChatIntent(text);
        if (inGame?.kind === 'mute') {
          useAppStore.getState().setCoachVoiceOn(false);
          voiceService.stop();
          const ack = 'Voice narration is off.';
          const ackMsg: ChatMessageType = {
            id: `gmsg-${Date.now()}-ack`,
            role: 'assistant',
            content: ack,
            timestamp: Date.now(),
          };
          setMessages([...updatedMessages, ackMsg]);
          recordCoachAck(ack);
          return;
        }
        if (inGame?.kind === 'restart' && onRestartGame) {
          onRestartGame();
          const ack: ChatMessageType = {
            id: `gmsg-${Date.now()}-ack`,
            role: 'assistant',
            content: 'Fresh board — starting over. Your move.',
            timestamp: Date.now(),
          };
          setMessages([...updatedMessages, ack]);
          recordCoachAck(ack.content);
          if (useAppStore.getState().coachVoiceOn) {
            if (!speechAbortedRef.current) void voiceService.speak(ack.content);
          }
          return;
        }
        if (inGame?.kind === 'play-opening' && onPlayOpening) {
          // Restart BEFORE queuing the opening — handleRestart clears
          // requestedOpeningMoves, so we have to wipe the board first
          // and then set the book line. React batches both state
          // updates inside this handler, so the coach's move effect
          // sees the fresh board + book on its next run and plays the
          // first book move immediately.
          onRestartGame?.();
          onPlayOpening(inGame.openingName);
          const ack: ChatMessageType = {
            id: `gmsg-${Date.now()}-ack`,
            role: 'assistant',
            content: `Starting a fresh game — I'll play the ${inGame.openingName} against you.`,
            timestamp: Date.now(),
          };
          setMessages([...updatedMessages, ack]);
          recordCoachAck(ack.content);
          if (useAppStore.getState().coachVoiceOn) {
            if (!speechAbortedRef.current) void voiceService.speak(ack.content);
          }
          return;
        }
      }

      // Intent routing: outside of an active game, let "play against me",
      // "explain this position", etc. launch dedicated sessions instead of
      // running through the chat LLM. We skip routing mid-game so the
      // in-game chat stays in-game — the user can finish their move first.
      if (isGameOver) {
        try {
          // Grab the most recent assistant message so the router can
          // detect "coach proposed a game → user said yes". Walk back
          // from the end of the existing chat history (pre-userMsg).
          const lastAssistantMessage = [...messagesRef.current]
            .reverse()
            .find((m) => m.role === 'assistant')?.content;
          const routed = await routeChatIntent(text, { currentFen: fen, lastAssistantMessage });
          if (routed) {
            const ackMsg: ChatMessageType = {
              id: `gmsg-${Date.now()}-ack`,
              role: 'assistant',
              content: routed.ackMessage,
              timestamp: Date.now(),
            };
            setMessages([...updatedMessages, ackMsg]);
            recordCoachAck(routed.ackMessage);
            // Reply-only routes (no `path`) just inject the ack as the
            // coach's response and stay in chat — used for cases like
            // "review my last Catalan" when the user has no Catalan
            // games. The ack ends with a play-game offer so the user's
            // next "yes" hits the affirmation-after-proposal path.
            if (routed.path) {
              void navigate(routed.path);
            }
            return;
          }
        } catch (err: unknown) {
          console.warn('[GameChatPanel] intent routing failed:', err);
        }
      }

      // ── WO-BRAIN-02 — IN-GAME BRANCH ROUTES THROUGH coachService ─────
      // Mid-game chat goes through the unified Coach Brain spine. The
      // envelope assembled in coachService.ask carries the four sources
      // of truth (identity, memory, app map, live state) plus the full
      // toolbelt — so memory + manifest awareness arrive on every call.
      // The drawer/post-game branch below still uses runAgentTurn until
      // BRAIN-03 collapses it the same way.
      if (!isGameOver) {
        onBoardAnnotation?.([{ type: 'clear' }]);
        setIsStreaming(true);
        setStreamingContent('');
        speechBufferRef.current = '';
        // WO-COACH-TTS-STRIP-01: streaming sanitization state.
        // streamMarkupBuf holds raw text that includes an in-flight
        // `[[DIRECTIVE...` we haven't seen the `]]` for yet. streamSafeBuf
        // accumulates only sanitized prose for display.
        let streamMarkupBuf = '';
        let streamSafeBuf = '';
        try {
          const liveState: LiveState = {
            surface: 'game-chat',
            fen,
            moveHistory: history,
            userJustDid: text,
            currentRoute: '/coach/play',
          };
          void logAppAudit({
            kind: 'coach-surface-migrated',
            category: 'subsystem',
            source: 'GameChatPanel.handleSend',
            summary: 'surface=game-chat viaSpine=true',
            details: JSON.stringify({
              surface: 'game-chat',
              viaSpine: true,
              timestamp: Date.now(),
              fenIfPresent: fen,
            }),
            fen,
          });
          // WO-COACH-RESILIENCE: wrap the in-game chat ask with the
          // shared withTimeout so a hung spine surfaces a graceful
          // error to the user instead of a forever-spinning indicator.
          const askResult = await withTimeout(
            coachService.ask(
            { surface: 'game-chat', ask: text, liveState },
            {
              // WO-COACH-GROUNDING (PR #338 part C): chat surfaces need
              // multiple round-trips so the brain can call stockfish_eval
              // (or any cerebellum lookup), see the result, and synthesize
              // a final answer. With the previous default of 1, a tool
              // call orphans the result with no follow-up turn — the LLM
              // correctly skipped tools and answered narratively, which
              // is the structural cause of tactical hallucinations.
              maxToolRoundTrips: 3,
              // WO-COACH-PERSONALITIES (PR B): thread the picked
              // personality + dial settings into every chat ask.
              // Defaults preserve current Danya voice.
              personality: activeProfile.preferences.coachPersonality,
              profanity: activeProfile.preferences.coachProfanity,
              mockery: activeProfile.preferences.coachMockery,
              flirt: activeProfile.preferences.coachFlirt,
              verbosity: activeProfile.preferences.coachResponseLength,
              onChunk: (chunk: string) => {
                // WO-COACH-TTS-STRIP-01: sanitize the streaming buffer
                // for both display and TTS. sanitizeCoachStream holds
                // back any in-flight `[[DIRECTIVE...` until the
                // closing `]]` arrives, so chunk-split markers never
                // reach the user.
                streamMarkupBuf += chunk;
                const { safe, pending } = sanitizeCoachStream(streamMarkupBuf);
                streamMarkupBuf = pending;
                streamSafeBuf += safe;
                setStreamingContent(streamSafeBuf.trim());
                if (useAppStore.getState().coachVoiceOn && safe) {
                  speechBufferRef.current += safe;
                  // Negative lookbehind keeps SAN move numbers ("1.",
                  // "12.") from triggering a sentence break — without
                  // it Polly voices "1." then "Nc3 Nc6 3." then "Bc4"
                  // as three separate utterances.
                  const sentenceEnd = /(?<!\d)[.!?]\s/.exec(speechBufferRef.current);
                  if (sentenceEnd) {
                    const sentence = speechBufferRef.current.slice(0, sentenceEnd.index + 1);
                    speechBufferRef.current = speechBufferRef.current.slice(sentenceEnd.index + 2);
                    queueSpeak(sentence);
                  }
                }
              },
              onNavigate: (path: string) => {
                void navigate(path);
              },
              // WO-COACH-OPERATOR-FOUNDATION-01 — board-state callbacks.
              // Wrapped so a thrown error from the parent surfaces as
              // a structured tool error instead of escaping the spine.
              onPlayMove: onPlayMove
                ? async (san: string): Promise<{ ok: boolean; reason?: string }> => {
                    try {
                      const r = await Promise.resolve(onPlayMove(san));
                      return typeof r === 'boolean' ? { ok: r } : r;
                    } catch (err) {
                      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                    }
                  }
                : undefined,
              onTakeBackMove: onTakeBackMove
                ? async (count: number): Promise<{ ok: boolean; reason?: string }> => {
                    try {
                      const r = await Promise.resolve(onTakeBackMove(count));
                      return typeof r === 'boolean' ? { ok: r } : r;
                    } catch (err) {
                      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                    }
                  }
                : undefined,
              onSetBoardPosition: onSetBoardPosition
                ? async (fen: string): Promise<{ ok: boolean; reason?: string }> => {
                    try {
                      const r = await Promise.resolve(onSetBoardPosition(fen));
                      return typeof r === 'boolean' ? { ok: r } : r;
                    } catch (err) {
                      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                    }
                  }
                : undefined,
              onResetBoard: onResetBoard
                ? async (): Promise<{ ok: boolean; reason?: string }> => {
                    try {
                      const r = await Promise.resolve(onResetBoard());
                      return typeof r === 'boolean' ? { ok: r } : r;
                    } catch (err) {
                      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                    }
                  }
                : undefined,
              onQuizUserForMove,
              onStartWalkthroughForOpening: onStartWalkthroughForOpening
                ? async (args): Promise<{ ok: boolean; reason?: string }> => {
                    try {
                      const r = await Promise.resolve(onStartWalkthroughForOpening(args));
                      return r;
                    } catch (err) {
                      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                    }
                  }
                : undefined,
              traceId,
            },
          ),
            15_000,
            'coach-turn-ask',
          );
          if (!askResult.ok) {
            console.warn(
              `[GameChatPanel] in-game ask timed out (${askResult.label}) — surfacing error to user`,
            );
            void logAppAudit({
              kind: 'llm-error',
              category: 'subsystem',
              source: 'GameChatPanel.handleSend.in-game',
              summary: `coach-turn-ask timeout label=${askResult.label}`,
            });
            const timeoutMsg: ChatMessageType = {
              id: `gmsg-${Date.now()}-timeout`,
              role: 'assistant',
              content: '⚠️ Coach is taking too long to respond. Try again in a moment.',
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, timeoutMsg]);
            recordCoachAck(timeoutMsg.content);
            return;
          }
          const answer = askResult.value;
          if (speechBufferRef.current.trim()) {
            flushSpeechBuffer();
          }
          // The spine parses tool calls emitted via the provider's
          // toolCalls channel, but the LLM frequently emits
          // [[ACTION:...]] in streamed text instead. We need a
          // surface-side dispatcher to catch those and fire the
          // matching callback. WO-FOUNDATION-02 (continued).
          const { cleanText: textWithoutBoardTags, commands: annotations } =
            parseBoardTags(answer.text);
          const { actions: streamedActions } = parseActions(answer.text);
          for (const action of streamedActions) {
            void logAppAudit({
              kind: 'coach-brain-tool-called',
              category: 'subsystem',
              source: 'GameChatPanel.parseActionsDispatch',
              summary: `${action.name} (post-stream)`,
            });
            try {
              switch (action.name) {
                case 'play_move': {
                  const san = typeof action.args.san === 'string' ? action.args.san : null;
                  if (san) void onPlayMove?.(san);
                  break;
                }
                case 'take_back_move': {
                  const count =
                    typeof action.args.count === 'number' ? action.args.count : 1;
                  void onTakeBackMove?.(count);
                  break;
                }
                case 'reset_board': {
                  void onResetBoard?.();
                  break;
                }
                case 'set_board_position': {
                  const fen =
                    typeof action.args.fen === 'string' ? action.args.fen : null;
                  if (fen) void onSetBoardPosition?.(fen);
                  break;
                }
                case 'navigate_to_route': {
                  const route =
                    typeof action.args.route === 'string' ? action.args.route : null;
                  if (route) void navigate(route);
                  break;
                }
              }
            } catch (err) {
              void logAppAudit({
                kind: 'coach-brain-tool-called',
                category: 'subsystem',
                source: 'GameChatPanel.parseActionsDispatch',
                summary: `${action.name} threw`,
                details: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const hasExplicitArrows = annotations.some(
            (c) => c.type === 'arrow' && (c.arrows?.length ?? 0) > 0,
          );
          if (!hasExplicitArrows) {
            const autoArrows = extractMoveArrows(textWithoutBoardTags, { fen });
            if (autoArrows.length > 0) {
              annotations.push({ type: 'arrow', arrows: autoArrows });
            }
          }
          // WO-COACH-TTS-STRIP-01: sanitize the final message text
          // for both the chat bubble AND the conversation memory.
          // Memory rehydration on the next turn re-feeds prior
          // assistant text into the prompt; if [[ACTION:...]] markup
          // is in there, the LLM learns the wrong protocol.
          const assistantText = sanitizeCoachText(textWithoutBoardTags);
          const assistantMsg: ChatMessageType = {
            id: `gmsg-${Date.now()}-resp`,
            role: 'assistant',
            content: assistantText,
            timestamp: Date.now(),
            metadata: {
              annotations: annotations.length > 0 ? annotations : undefined,
            },
          };
          setMessages((prev) => [...prev, assistantMsg]);
          // WO-BRAIN-04: thread the coach reply into conversation
          // history so future envelopes carry the back-and-forth.
          useCoachMemoryStore.getState().appendConversationMessage({
            surface: 'chat-in-game',
            role: 'coach',
            text: assistantText,
            fen: fen || undefined,
            trigger: null,
          });
          if (annotations.length > 0) {
            onBoardAnnotation?.(annotations);
          }
        } catch (err: unknown) {
          console.error('[GameChatPanel] coachService.ask failed:', err);
          const errMsg: ChatMessageType = {
            id: `gmsg-${Date.now()}-err`,
            role: 'assistant',
            content: 'Sorry — I couldn\'t reach the coach just now. Try again in a moment.',
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errMsg]);
          recordCoachAck(errMsg.content);
        } finally {
          setIsStreaming(false);
          setStreamingContent('');
        }
        return;
      }

      // ── WO-BRAIN-03 — DRAWER / POST-GAME BRANCH (migrated) ───────────
      // Mirrors the in-game branch above. Differences kept to a
      // minimum: the surface label is `'drawer-chat'`; the live state
      // captures `currentRoute = location.pathname` (matters for "take
      // me to X" intents); FEN / move history are passed only when
      // they're meaningful (post-game review has them, home dashboard
      // typically doesn't).
      onBoardAnnotation?.([{ type: 'clear' }]);
      setIsStreaming(true);
      setStreamingContent('');
      speechBufferRef.current = '';
      // WO-COACH-TTS-STRIP-01: same streaming-sanitize buffers as the
      // in-game branch above.
      let drawerMarkupBuf = '';
      let drawerSafeBuf = '';
      try {
        const drawerLiveState: LiveState = {
          surface: 'home-chat',
          fen: fen || undefined,
          moveHistory: history && history.length > 0 ? history : undefined,
          userJustDid: text,
          currentRoute: location.pathname,
        };
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'GameChatPanel.handleSend',
          summary: 'surface=home-chat viaSpine=true',
          details: JSON.stringify({
            surface: 'home-chat',
            viaSpine: true,
            timestamp: Date.now(),
            fenIfPresent: fen || null,
            currentRoute: location.pathname,
          }),
          fen: fen || undefined,
        });
        // WO-COACH-RESILIENCE: same withTimeout wrap as the in-game
        // branch.
        const drawerAskResult = await withTimeout(
          coachService.ask(
          { surface: 'home-chat', ask: text, liveState: drawerLiveState },
          {
            // WO-COACH-GROUNDING (PR #338 part C): see the in-game branch
            // above for rationale. Drawer surface needs the same budget
            // so tactical questions during a walkthrough or pre-game
            // chat get engine-grounded answers.
            maxToolRoundTrips: 3,
            // WO-COACH-PERSONALITIES (PR B): same prefs threading as
            // the in-game ask above.
            personality: activeProfile.preferences.coachPersonality,
            profanity: activeProfile.preferences.coachProfanity,
            mockery: activeProfile.preferences.coachMockery,
            flirt: activeProfile.preferences.coachFlirt,
            verbosity: activeProfile.preferences.coachResponseLength,
            onChunk: (chunk: string) => {
              // WO-COACH-TTS-STRIP-01: same streaming-sanitize as the
              // in-game branch.
              drawerMarkupBuf += chunk;
              const { safe, pending } = sanitizeCoachStream(drawerMarkupBuf);
              drawerMarkupBuf = pending;
              drawerSafeBuf += safe;
              setStreamingContent(drawerSafeBuf.trim());
              if (useAppStore.getState().coachVoiceOn && safe) {
                speechBufferRef.current += safe;
                const sentenceEnd = /(?<!\d)[.!?]\s/.exec(speechBufferRef.current);
                if (sentenceEnd) {
                  const sentence = speechBufferRef.current.slice(0, sentenceEnd.index + 1);
                  speechBufferRef.current = speechBufferRef.current.slice(sentenceEnd.index + 2);
                  const speechReady = formatForSpeech(sentence);
                  if (speechReady) if (!speechAbortedRef.current) void voiceService.speak(speechReady);
                }
              }
            },
            onNavigate: (path: string) => {
              void navigate(path);
            },
            // WO-COACH-OPERATOR-FOUNDATION-01 — same callback set as
            // the in-game branch. The drawer surface (post-game / home
            // chat) might trigger a play-against / position-set when
            // the user is mid-review and wants to try a line.
            onPlayMove: onPlayMove
              ? async (san: string): Promise<{ ok: boolean; reason?: string }> => {
                  try {
                    const r = await Promise.resolve(onPlayMove(san));
                    return typeof r === 'boolean' ? { ok: r } : r;
                  } catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                  }
                }
              : undefined,
            onTakeBackMove: onTakeBackMove
              ? async (count: number): Promise<{ ok: boolean; reason?: string }> => {
                  try {
                    const r = await Promise.resolve(onTakeBackMove(count));
                    return typeof r === 'boolean' ? { ok: r } : r;
                  } catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                  }
                }
              : undefined,
            onSetBoardPosition: onSetBoardPosition
              ? async (fen: string): Promise<{ ok: boolean; reason?: string }> => {
                  try {
                    const r = await Promise.resolve(onSetBoardPosition(fen));
                    return typeof r === 'boolean' ? { ok: r } : r;
                  } catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                  }
                }
              : undefined,
            onResetBoard: onResetBoard
              ? async (): Promise<{ ok: boolean; reason?: string }> => {
                  try {
                    const r = await Promise.resolve(onResetBoard());
                    return typeof r === 'boolean' ? { ok: r } : r;
                  } catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                  }
                }
              : undefined,
            onQuizUserForMove,
            onStartWalkthroughForOpening: onStartWalkthroughForOpening
              ? async (args): Promise<{ ok: boolean; reason?: string }> => {
                  try {
                    const r = await Promise.resolve(onStartWalkthroughForOpening(args));
                    return r;
                  } catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                  }
                }
              : undefined,
            traceId,
          },
        ),
          15_000,
          'coach-turn-ask',
        );
        if (!drawerAskResult.ok) {
          console.warn(
            `[GameChatPanel] drawer ask timed out (${drawerAskResult.label}) — surfacing error to user`,
          );
          void logAppAudit({
            kind: 'llm-error',
            category: 'subsystem',
            source: 'GameChatPanel.handleSend.drawer',
            summary: `coach-turn-ask timeout label=${drawerAskResult.label}`,
          });
          const timeoutMsg: ChatMessageType = {
            id: `gmsg-${Date.now()}-timeout-drawer`,
            role: 'assistant',
            content: '⚠️ Coach is taking too long to respond. Try again in a moment.',
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, timeoutMsg]);
          recordCoachAck(timeoutMsg.content);
          return;
        }
        const answer = drawerAskResult.value;
        if (speechBufferRef.current.trim()) {
          flushSpeechBuffer();
        }
        // Drawer surface has no live board to draw arrows on; just
        // strip the [BOARD:] tags out of display text and append.
        const { cleanText: drawerCleanText } = parseBoardTags(answer.text);
        // Same parseActions dispatch as in-game branch — the LLM may
        // emit action tags in streamed text from any surface.
        // WO-FOUNDATION-02 (continued).
        const { actions: drawerStreamedActions } = parseActions(answer.text);
        for (const action of drawerStreamedActions) {
          void logAppAudit({
            kind: 'coach-brain-tool-called',
            category: 'subsystem',
            source: 'GameChatPanel.parseActionsDispatch',
            summary: `${action.name} (post-stream, drawer)`,
          });
          try {
            switch (action.name) {
              case 'play_move': {
                const san = typeof action.args.san === 'string' ? action.args.san : null;
                if (san) void onPlayMove?.(san);
                break;
              }
              case 'take_back_move': {
                const count =
                  typeof action.args.count === 'number' ? action.args.count : 1;
                void onTakeBackMove?.(count);
                break;
              }
              case 'reset_board': {
                void onResetBoard?.();
                break;
              }
              case 'set_board_position': {
                const fen =
                  typeof action.args.fen === 'string' ? action.args.fen : null;
                if (fen) void onSetBoardPosition?.(fen);
                break;
              }
              case 'navigate_to_route': {
                const route =
                  typeof action.args.route === 'string' ? action.args.route : null;
                if (route) void navigate(route);
                break;
              }
            }
          } catch (err) {
            void logAppAudit({
              kind: 'coach-brain-tool-called',
              category: 'subsystem',
              source: 'GameChatPanel.parseActionsDispatch',
              summary: `${action.name} threw`,
              details: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // WO-COACH-TTS-STRIP-01: sanitize before bubble + memory.
        const drawerAssistantText = sanitizeCoachText(drawerCleanText);
        const assistantMsg: ChatMessageType = {
          id: `gmsg-${Date.now()}-resp`,
          role: 'assistant',
          content: drawerAssistantText,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        useCoachMemoryStore.getState().appendConversationMessage({
          surface: 'chat-home',
          role: 'coach',
          text: drawerAssistantText,
          fen: fen || undefined,
          trigger: null,
        });
      } catch (err: unknown) {
        console.error('[GameChatPanel] coachService.ask (drawer) failed:', err);
        const errMsg: ChatMessageType = {
          id: `gmsg-${Date.now()}-err`,
          role: 'assistant',
          content: 'Sorry — I couldn\'t reach the coach just now. Try again in a moment.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errMsg]);
        recordCoachAck(errMsg.content);
      } finally {
        setIsStreaming(false);
        setStreamingContent('');
      }
    }, [activeProfile, isStreaming, fen, history, lastMoveBy, isGameOver, flushSpeechBuffer, onBoardAnnotation, onRestartGame, onPlayOpening, onPlayMove, onTakeBackMove, onSetBoardPosition, onResetBoard, onQuizUserForMove, onStartWalkthroughForOpening, setMessages, navigate, location, playerColor]);

    // Auto-send initial prompt (from post-game practice bridge or search bar)
    useEffect(() => {
      if (initialPrompt && !initialPromptSentRef.current && activeProfile && !isStreaming) {
        initialPromptSentRef.current = true;
        void handleSend(initialPrompt);
        onInitialPromptSent?.();
      }
    }, [initialPrompt, activeProfile, isStreaming, handleSend, onInitialPromptSent]);

    return (
      <div
        className={`flex flex-col h-full ${className ?? ''}`}
        data-testid="game-chat-panel"
      >
        {/* Header (hidden when embedded in a container with its own header) */}
        {!hideHeader && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-theme-border">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold bg-theme-accent"
            >
              C
            </div>
            <div>
              <span className="text-sm font-semibold text-theme-text">Game Chat</span>
              <span className="text-xs text-theme-text-muted ml-2">
                {isStreaming ? 'Typing...' : 'Online'}
              </span>
            </div>
          </div>
        )}

        {/* Pinned input — first thing under the surface chrome.
            Reverse-flow design: typing is always reachable without
            scrolling, the newest message lands directly under the
            input, older messages scroll DOWN. Same shape used on
            /coach/teach so both surfaces feel like one room. */}
        <ChatInput
          onSend={(text) => void handleSend(text)}
          disabled={isStreaming}
          placeholder={isStreaming ? 'Coach is typing…' : 'Ask your coach…'}
        />

        {/* Messages — reverse chronological. Newest at top with a
            subtle highlight; older messages dim to 70% so the active
            turn is the visual focus. */}
        <div
          ref={messagesEndRef}
          className="flex-1 overflow-y-auto p-3 min-h-0 flex flex-col gap-3"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="In-game coach chat messages"
        >
          {isStreaming && (
            <div
              className="rounded-lg p-1 -m-1"
              style={{
                background: 'rgba(0, 229, 255, 0.05)',
                outline: '1px solid rgba(0, 229, 255, 0.25)',
              }}
            >
              <ChatMessage
                message={{
                  id: 'game-streaming',
                  role: 'assistant',
                  content: streamingContent,
                  timestamp: Date.now(),
                }}
                isStreaming
              />
            </div>
          )}

          {[...messages].reverse().map((msg, idxFromTop) => (
            <div
              key={msg.id}
              className={
                idxFromTop === 0 && !isStreaming
                  ? 'rounded-lg p-1 -m-1'
                  : ''
              }
              style={
                idxFromTop === 0 && !isStreaming
                  ? { background: 'rgba(0, 229, 255, 0.05)', outline: '1px solid rgba(0, 229, 255, 0.25)' }
                  : { opacity: 0.7 }
              }
            >
              <ChatMessage message={msg} />
            </div>
          ))}

          {messages.length === 0 && !isStreaming && (
            <motion.div
              className="flex flex-col items-center gap-3 py-8"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <div className="text-center max-w-xs">
                <p className="text-sm font-medium text-theme-text">
                  Chat with your coach
                </p>
                <p className="text-xs text-theme-text-muted mt-1">
                  Ask about the position, request analysis, or just chat during the game
                </p>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    );
  },
);
