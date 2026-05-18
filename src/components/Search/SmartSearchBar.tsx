import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Sparkles, BookOpen, Swords, Target, Puzzle, Loader2, MessageCircle, Play, Mic, MicOff } from 'lucide-react';
import { useSmartSearch } from '../../hooks/useSmartSearch';
import { useAppStore, selectFreshBoardSnapshot } from '../../stores/appStore';
import { useCoachSessionStore } from '../../stores/coachSessionStore';
import { useCoachMemoryStore } from '../../stores/coachMemoryStore';
import { parseCoachIntent } from '../../services/coachAgent';
import { favoriteOpeningTool } from '../../coach/tools/cerebrum/favoriteOpening';
import { voiceInputService } from '../../services/voiceInputService';
import { coachService } from '../../coach/coachService';
import type { LiveState } from '../../coach/types';
import { logAppAudit } from '../../services/appAuditor';
import { voiceService } from '../../services/voiceService';
import type { SmartSearchResult, SmartSearchCategory } from '../../types';

/** Strip the brain's `[BOARD:...]` and `[[ACTION:...]]` tags from any
 *  spoken / persisted text — never read action tags out loud, never
 *  show them in chat history. */
const TAG_STRIP_RE = /\[BOARD:[^\]]*\]|\[\[ACTION:[^\]]*\]\]/gi;

interface SmartSearchBarProps {
  scope?: SmartSearchCategory;
  placeholder?: string;
  onResultsChange?: (results: SmartSearchResult[]) => void;
}

const CATEGORY_ICONS: Record<SmartSearchCategory, typeof BookOpen> = {
  opening: BookOpen,
  game: Swords,
  mistake: Target,
  puzzle: Puzzle,
};

const CATEGORY_LABELS: Record<SmartSearchCategory, string> = {
  opening: 'Opening',
  game: 'Game',
  mistake: 'Mistake',
  puzzle: 'Puzzle',
};

const ASK_COACH_MIN_LENGTH = 3;

export function SmartSearchBar({ scope, placeholder, onResultsChange }: SmartSearchBarProps): JSX.Element {
  const navigate = useNavigate();
  const { query, setQuery, results, loading, clear } = useSmartSearch({ scope });
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [listening, setListening] = useState(false);
  const [voiceUnsupported, setVoiceUnsupported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  /** Holds the current voice-input unsubscriber so we can drop it
   *  before registering a new one on each mic tap, and on unmount.
   *  Stops the service's resultHandlers array from growing every
   *  time the user starts listening. */
  const voiceUnsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      voiceUnsubscribeRef.current?.();
      voiceUnsubscribeRef.current = null;
    };
  }, []);

  const setCoachDrawerOpen = useAppStore((s) => s.setCoachDrawerOpen);
  const setCoachDrawerInitialMessage = useAppStore((s) => s.setCoachDrawerInitialMessage);
  const lastBoardSnapshot = useAppStore((s) => selectFreshBoardSnapshot(s));

  // When a `scope` is set the bar is in pure-search mode — the host
  // surface (e.g. /openings) wants the query to filter its own list,
  // NOT route the user into a coach session or open the Ask-Coach
  // drawer. Suppress both fast-paths in that mode.
  const pureSearch = Boolean(scope);
  const showAskCoach = !pureSearch && query.trim().length >= ASK_COACH_MIN_LENGTH;
  // Detect agent-routable intents (e.g. "run me through the middlegame",
  // "play the Sicilian against me"). When matched we show a fast-path
  // "Start session" suggestion at the top of the dropdown.
  const agentIntent = useMemo(
    () =>
      !pureSearch && query.trim().length >= ASK_COACH_MIN_LENGTH
        ? parseCoachIntent(query.trim())
        : { kind: 'qa' as const, raw: '' },
    [query, pureSearch],
  );
  const showAgentAction =
    !pureSearch && (
      agentIntent.kind === 'continue-middlegame' ||
      agentIntent.kind === 'play-against' ||
      agentIntent.kind === 'walkthrough' ||
      agentIntent.kind === 'puzzle' ||
      agentIntent.kind === 'explain-position' ||
      agentIntent.kind === 'favorite-opening'
    );
  const totalItems =
    results.length + (showAskCoach ? 1 : 0) + (showAgentAction ? 1 : 0);
  const agentActionIndex = showAgentAction ? 0 : -1;
  const resultsOffset = showAgentAction ? 1 : 0;
  const askCoachIndex = showAskCoach ? resultsOffset + results.length : -1;

  // Notify parent of result changes (for Openings page integration)
  useEffect(() => {
    onResultsChange?.(results);
  }, [results, onResultsChange]);

  // Show dropdown when there are results, loading, or query is long enough for "Ask Coach"
  useEffect(() => {
    if (query.trim() && (results.length > 0 || loading || showAskCoach || showAgentAction)) {
      setShowDropdown(true);
    } else if (!query.trim()) {
      setShowDropdown(false);
    }
  }, [query, results, loading, showAskCoach, showAgentAction]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(-1);
  }, [results]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const askCoach = useCallback((text: string): void => {
    setCoachDrawerInitialMessage(text);
    setCoachDrawerOpen(true);
    clear();
    setShowDropdown(false);
    inputRef.current?.blur();
  }, [setCoachDrawerInitialMessage, setCoachDrawerOpen, clear]);

  // Voice input — lets the user dictate into the search bar from any
  // page. On final transcript we submit the same way Enter does: agent
  // action if one matches, otherwise hand the whole utterance to the
  // coach. Auto-finalize on silence handles the "mic just stops and
  // sends" experience.
  const handleMicToggle = useCallback(() => {
    if (!voiceInputService.isSupported()) {
      setVoiceUnsupported(true);
      setTimeout(() => setVoiceUnsupported(false), 2500);
      return;
    }
    if (listening) {
      voiceInputService.stopListening();
      setListening(false);
      return;
    }
    // Pre-warm mic permission + hardware so first-tap reliably
    // starts recognition (fixes the "press twice" bug).
    void voiceInputService.prewarmMic();
    // Drop any previous handler from this component before
    // registering a new one — otherwise every mic-tap would pile
    // another listener into the service's fan-out array. In
    // continuous mode the mic stays ON until the user taps off, so
    // this callback may fire MULTIPLE times (once per utterance). The
    // first utterance that matches a routable intent navigates and
    // turns the mic off; otherwise we keep listening and ask the
    // coach.
    voiceUnsubscribeRef.current?.();
    voiceUnsubscribeRef.current = voiceInputService.onResult((transcript) => {
      const text = transcript.trim();
      if (!text) return;
      setQuery(text);
      // Scoped search bars (e.g. /openings) are pure-filter — voice
      // dictation just populates the input so the host page's live
      // filter updates. Never route into a coach session from a
      // scoped bar.
      if (pureSearch) {
        voiceInputService.stopListening();
        inputRef.current?.blur();
        return;
      }
      // Re-parse the intent against the final transcript (live
      // agentIntent memo may still be showing the interim).
      const intent = parseCoachIntent(text);
      const params = new URLSearchParams();
      if (intent.kind === 'play-against') {
        if (intent.subject) params.set('subject', intent.subject);
        if (intent.side) params.set('side', intent.side);
        params.set('difficulty', intent.difficulty ?? 'auto');
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void navigate(`/coach/session/play-against?${params.toString()}`);
      } else if (intent.kind === 'walkthrough' && intent.subject) {
        params.set('subject', intent.subject);
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void navigate(`/coach/session/walkthrough?${params.toString()}`);
      } else if (intent.kind === 'continue-middlegame') {
        if (intent.subject) params.set('subject', intent.subject);
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void navigate(
          `/coach/session/middlegame${params.toString() ? `?${params.toString()}` : ''}`,
        );
      } else if (intent.kind === 'puzzle') {
        if (intent.theme) params.set('theme', intent.theme);
        if (intent.difficulty && intent.difficulty !== 'auto') {
          params.set('difficulty', intent.difficulty);
        }
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void navigate(
          `/coach/session/puzzle${params.toString() ? `?${params.toString()}` : ''}`,
        );
      } else if (intent.kind === 'explain-position') {
        if (lastBoardSnapshot) params.set('fen', lastBoardSnapshot.fen);
        const qs = params.toString();
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void navigate(`/coach/session/explain-position${qs ? `?${qs}` : ''}`);
      } else if (intent.kind === 'favorite-opening' && intent.subject) {
        const subject = intent.subject;
        voiceInputService.stopListening();
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();
        void (async () => {
          const result = await favoriteOpeningTool.execute({ name: subject });
          void logAppAudit({
            kind: 'coach-surface-migrated',
            category: 'subsystem',
            source: 'SmartSearchBar.favoriteOpeningVoicePath',
            summary: result.ok
              ? `favorited "${subject}" via voice search`
              : `favorite failed for "${subject}": ${result.error ?? 'unknown'}`,
            details: JSON.stringify(result),
          });
        })();
      } else {
        // ── WO-BRAIN-05a — VOICE-ONLY QA ROUTES THROUGH coachService ────
        // No structured intent — voice-only QA. The brain handles it
        // in the BACKGROUND (no drawer, no chat panel) so a text box
        // doesn't pop up just because the user said something. The
        // coach reply streams via TTS only. The exchange persists to
        // both the session store (so the chat page renders it later)
        // and the memory store's conversationHistory (so the next
        // brain envelope sees the back-and-forth).
        clear();
        setShowDropdown(false);
        inputRef.current?.blur();

        // Persist the user's voice ask immediately. If the spine call
        // fails or the page unmounts mid-reply, at least the question
        // is preserved.
        const userMsgId = `msg-${Date.now()}-u`;
        useCoachSessionStore.getState().appendMessage({
          id: userMsgId,
          role: 'user',
          content: text,
          modality: 'voice',
          timestamp: Date.now(),
        });
        useCoachMemoryStore.getState().appendConversationMessage({
          surface: 'chat-smart-search',
          role: 'user',
          text,
          trigger: null,
        });

        // Stream the reply straight to TTS, sentence-by-sentence.
        // Every sentence chains through speakForced via a Promise chain
        // so each Polly call awaits the previous one's audio —
        // single-engine consistency, no Web-Speech tail overlap, no
        // dropped sentences from the dead speakQueuedForced path.
        let speechBuffer = '';
        let speechChain: Promise<void> = Promise.resolve();
        const speakOrQueue = (sentence: string): void => {
          const cleaned = sentence
            .replace(TAG_STRIP_RE, '')
            .replace(/^(great question!?|excellent!?|good question!?|nice (one|question)!?|interesting!?|that'?s a (great|good|nice) (question|one)!?)\s*/i, '')
            .trim();
          if (!cleaned) return;
          speechChain = speechChain
            .then(() => voiceService.speakForced(cleaned))
            .catch((err: unknown) => {
              console.warn('[SmartSearchBar] speakForced failed:', err);
            });
        };
        voiceService.stop();

        const liveState: LiveState = {
          surface: 'smart-search',
          currentRoute: '/',
          userJustDid: text,
        };
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'SmartSearchBar.handleMicToggle.voiceQA',
          summary: 'surface=smart-search viaSpine=true',
          details: JSON.stringify({
            surface: 'smart-search',
            viaSpine: true,
            modality: 'voice',
            timestamp: Date.now(),
          }),
        });
        void coachService
          .ask(
            { surface: 'smart-search', ask: text, liveState },
            {
              maxToolRoundTrips: 1,
              onNavigate: (path: string) => {
                void navigate(path);
              },
              onChunk: (chunk: string) => {
                speechBuffer += chunk;
                // Flush on ANY sentence terminator (.!?\n) — no whitespace
                // requirement. Earlier regex required `[.!?]\s` which
                // delayed first audio until the second word arrived.
                const sentenceEnd = /[.!?\n]/.exec(speechBuffer);
                if (sentenceEnd) {
                  const sentence = speechBuffer.slice(0, sentenceEnd.index + 1).trim();
                  speechBuffer = speechBuffer.slice(sentenceEnd.index + 1).trimStart();
                  speakOrQueue(sentence);
                }
              },
            },
          )
          .then((answer) => {
            const tail = speechBuffer.replace(TAG_STRIP_RE, '').trim();
            if (tail) speakOrQueue(tail);
            // Persist the coach reply (post-strip) into both stores
            // mirroring the user-side appends above. Voice modality
            // tells the chat renderer to hide the text bubble for
            // voice-originated turns.
            const cleanText = answer.text.replace(TAG_STRIP_RE, '').trim();
            useCoachSessionStore.getState().appendMessage({
              id: `msg-${Date.now()}-resp`,
              role: 'assistant',
              content: cleanText,
              modality: 'voice',
              timestamp: Date.now(),
            });
            useCoachMemoryStore.getState().appendConversationMessage({
              surface: 'chat-smart-search',
              role: 'coach',
              text: cleanText,
              trigger: null,
            });
          })
          .catch((err: unknown) => {
            console.warn('[SmartSearchBar] background voice turn failed:', err);
          });
      }
    });
    const ok = voiceInputService.startListening({
      onInterim: (interim) => setQuery(interim),
      onEnd: () => setListening(false),
      // Student starts talking → coach stops. Matches natural
      // conversation tempo: no talking over the student.
      onSpeechStart: () => voiceService.stop(),
      // Surface hard errors so the mic never looks mysteriously
      // dead. Reuses the existing voiceUnsupported inline chip UX
      // — overloads it with a transient error message.
      onError: (reason) => {
        setListening(false);
        setVoiceUnsupported(true);
        setTimeout(() => setVoiceUnsupported(false), 4000);
        console.warn('[SmartSearchBar] mic error:', reason);
      },
    });
    setListening(ok);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tracked for dedicated audit; intentional dep list.
  }, [listening, setQuery, clear, navigate, lastBoardSnapshot, askCoach, pureSearch]);

  const startAgentSession = useCallback((): void => {
    clear();
    setShowDropdown(false);
    inputRef.current?.blur();
    const params = new URLSearchParams();
    if (agentIntent.kind === 'continue-middlegame') {
      if (agentIntent.subject) params.set('subject', agentIntent.subject);
      void navigate(
        `/coach/session/middlegame${params.toString() ? `?${params.toString()}` : ''}`,
      );
    } else if (agentIntent.kind === 'play-against') {
      if (agentIntent.subject) params.set('subject', agentIntent.subject);
      if (agentIntent.side) params.set('side', agentIntent.side);
      params.set('difficulty', agentIntent.difficulty ?? 'auto');
      void navigate(`/coach/session/play-against?${params.toString()}`);
    } else if (agentIntent.kind === 'walkthrough') {
      if (agentIntent.subject) params.set('subject', agentIntent.subject);
      void navigate(
        `/coach/session/walkthrough${params.toString() ? `?${params.toString()}` : ''}`,
      );
    } else if (agentIntent.kind === 'puzzle') {
      if (agentIntent.theme) params.set('theme', agentIntent.theme);
      if (agentIntent.difficulty && agentIntent.difficulty !== 'auto') {
        params.set('difficulty', agentIntent.difficulty);
      }
      void navigate(
        `/coach/session/puzzle${params.toString() ? `?${params.toString()}` : ''}`,
      );
    } else if (agentIntent.kind === 'explain-position') {
      // Prefer the persistent snapshot the user was just looking at;
      // the session page defaults to the starting position when no fen
      // is passed.
      if (lastBoardSnapshot) {
        params.set('fen', lastBoardSnapshot.fen);
      }
      const qs = params.toString();
      void navigate(`/coach/session/explain-position${qs ? `?${qs}` : ''}`);
    } else if (agentIntent.kind === 'favorite-opening' && agentIntent.subject) {
      // Rolodex fast-path (WO-ROLODEX-PLUMBING-01 item 5). Invoke
      // the tool directly — no navigation. The Openings page (and
      // future rolodex UI) reads `isFavorite` from Dexie reactively,
      // so the heart flips wherever it's visible. Audit captures the
      // operation regardless of whether a hearted UI is open.
      const subject = agentIntent.subject;
      void (async () => {
        const result = await favoriteOpeningTool.execute({ name: subject });
        void logAppAudit({
          kind: 'coach-surface-migrated',
          category: 'subsystem',
          source: 'SmartSearchBar.favoriteOpeningFastPath',
          summary: result.ok
            ? `favorited "${subject}" via search bar`
            : `favorite failed for "${subject}": ${result.error ?? 'unknown'}`,
          details: JSON.stringify(result),
        });
      })();
    }
  }, [agentIntent, clear, navigate, lastBoardSnapshot]);

  // Build the action label + subtitle per intent kind.
  const agentActionLabel = useMemo((): string => {
    switch (agentIntent.kind) {
      case 'continue-middlegame':
        return 'Run the middlegame plans';
      case 'play-against': {
        if (agentIntent.subject) {
          return `Play the ${agentIntent.subject}`;
        }
        return 'Play against the coach';
      }
      case 'walkthrough':
        return agentIntent.subject
          ? `Study ${agentIntent.subject}`
          : 'Study opening';
      case 'puzzle':
        return agentIntent.theme
          ? `Practice ${agentIntent.theme} puzzles`
          : 'Practice puzzles';
      case 'explain-position':
        return 'Analyze the position';
      case 'favorite-opening':
        return agentIntent.subject
          ? `Add ${agentIntent.subject} to your Training Plan`
          : 'Add to Training Plan';
      default:
        return 'Start session';
    }
  }, [agentIntent]);

  const agentActionSubtitle = useMemo((): string => {
    switch (agentIntent.kind) {
      case 'play-against': {
        const bits: string[] = ['Coach plays against you'];
        if (agentIntent.difficulty && agentIntent.difficulty !== 'auto') {
          const name =
            agentIntent.difficulty.charAt(0).toUpperCase() +
            agentIntent.difficulty.slice(1);
          bits.push(name);
        }
        if (agentIntent.side) {
          bits.push(`You play ${agentIntent.side === 'white' ? 'White' : 'Black'}`);
        }
        return bits.join(' · ');
      }
      case 'walkthrough':
        return 'Opens a guided lesson';
      case 'puzzle':
        return 'Opens puzzle trainer';
      case 'explain-position':
        return 'Stockfish + coach explanation';
      case 'favorite-opening':
        return 'Favorites the opening in one tap';
      case 'continue-middlegame':
      default:
        return 'Opens a lesson session with the coach';
    }
  }, [agentIntent]);

  const handleSelect = useCallback((result: SmartSearchResult): void => {
    setShowDropdown(false);
    void navigate(result.route);
  }, [navigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent): void => {
    if (!showDropdown || totalItems === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex === agentActionIndex && showAgentAction) {
        startAgentSession();
      } else if (
        selectedIndex >= resultsOffset &&
        selectedIndex < resultsOffset + results.length
      ) {
        handleSelect(results[selectedIndex - resultsOffset]);
      } else if (selectedIndex === askCoachIndex) {
        askCoach(query.trim());
      } else if (selectedIndex === -1 && pureSearch && results.length > 0) {
        // Scoped search: Enter on the default state submits to the
        // top result, matching standard search-bar UX. No coach
        // fallback — host page's live filter still applies.
        handleSelect(results[0]);
      } else if (selectedIndex === -1 && showAgentAction) {
        // Unselected default → prefer agent action over ask-coach.
        startAgentSession();
      } else if (selectedIndex === -1 && showAskCoach) {
        askCoach(query.trim());
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
      inputRef.current?.blur();
    }
  }, [showDropdown, totalItems, results, selectedIndex, handleSelect, askCoachIndex, showAskCoach, askCoach, query, agentActionIndex, showAgentAction, startAgentSession, resultsOffset, pureSearch]);

  const defaultPlaceholder = scope === 'opening'
    ? 'Search openings — try "Sicilian as black" or "B01"...'
    : 'Ask a question or search games, openings, puzzles...';

  return (
    <div className="relative" data-testid="smart-search">
      {/* Input */}
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (results.length > 0 || showAskCoach) setShowDropdown(true); }}
          onKeyDown={handleKeyDown}
          aria-label={scope === 'opening' ? 'Search openings' : 'Search or ask coach'}
          placeholder={placeholder ?? defaultPlaceholder}
          className="w-full pl-9 pr-16 py-2.5 rounded-xl text-sm transition-all duration-200 focus:outline-none"
          style={{
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            borderTop: '1px solid rgba(201, 168, 76, 0.15)',
            borderRight: '1px solid rgba(201, 168, 76, 0.15)',
            borderLeft: '2px solid rgba(201, 168, 76, 0.5)',
            borderBottom: '2px solid rgba(201, 168, 76, 0.5)',
            boxShadow: '0 0 6px rgba(201, 168, 76, 0.35), 0 0 14px rgba(201, 168, 76, 0.2), 0 0 24px rgba(201, 168, 76, 0.1)',
          }}
          onFocusCapture={(e) => {
            e.currentTarget.style.borderLeft = '2px solid rgba(201, 168, 76, 0.8)';
            e.currentTarget.style.borderBottom = '2px solid rgba(201, 168, 76, 0.8)';
            e.currentTarget.style.borderTop = '1px solid rgba(201, 168, 76, 0.3)';
            e.currentTarget.style.borderRight = '1px solid rgba(201, 168, 76, 0.3)';
            e.currentTarget.style.boxShadow = '0 0 8px rgba(201, 168, 76, 0.5), 0 0 18px rgba(201, 168, 76, 0.3), 0 0 30px rgba(201, 168, 76, 0.15)';
          }}
          onBlurCapture={(e) => {
            e.currentTarget.style.borderLeft = '2px solid rgba(201, 168, 76, 0.5)';
            e.currentTarget.style.borderBottom = '2px solid rgba(201, 168, 76, 0.5)';
            e.currentTarget.style.borderTop = '1px solid rgba(201, 168, 76, 0.15)';
            e.currentTarget.style.borderRight = '1px solid rgba(201, 168, 76, 0.15)';
            e.currentTarget.style.boxShadow = '0 0 6px rgba(201, 168, 76, 0.35), 0 0 14px rgba(201, 168, 76, 0.2), 0 0 24px rgba(201, 168, 76, 0.1)';
          }}
          data-testid="smart-search-input"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {loading && (
            <Loader2
              size={14}
              className="animate-spin"
              style={{ color: 'var(--color-accent)' }}
              data-testid="search-loading"
            />
          )}
          {query && (
            <button
              onClick={() => { clear(); setShowDropdown(false); }}
              className="p-1 rounded-md hover:opacity-70"
              aria-label="Clear search"
              data-testid="search-clear"
            >
              <X size={14} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          )}
          <button
            onClick={handleMicToggle}
            // min-h/w 44px = WCAG AA tap target minimum (previously
            // ~26x26 which is too small on mobile).
            className={`flex items-center justify-center min-h-[44px] min-w-[44px] p-2 rounded-md transition-colors ${
              listening ? 'bg-red-500/15' : 'hover:opacity-70'
            }`}
            style={{
              color: listening ? 'rgb(239, 68, 68)' : 'var(--color-accent)',
            }}
            aria-label={listening ? 'Stop voice input' : 'Dictate with voice'}
            title={listening ? 'Stop listening' : 'Speak to search'}
            data-testid="search-mic"
          >
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        </div>
      </div>
      {voiceUnsupported && (
        <div
          className="absolute left-0 right-0 mt-1 text-[10px] text-center"
          style={{ color: 'rgb(239, 68, 68)' }}
          data-testid="search-mic-unsupported"
        >
          Voice input isn't supported in this browser.
        </div>
      )}

      {/* AI badge caption */}
      <div className="flex items-center gap-1 mt-1.5 ml-1">
        <Sparkles size={10} style={{ color: 'var(--color-accent)' }} />
        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          AI-powered — try &quot;my worst opening as black&quot; or ask your coach a question
        </span>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 left-0 right-0 mt-1 rounded-xl overflow-hidden shadow-lg max-h-80 overflow-y-auto"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
          }}
          data-testid="search-dropdown"
        >
          {loading && results.length === 0 && (
            <div className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <Sparkles size={12} style={{ color: 'var(--color-accent)' }} />
                Searching with AI...
              </div>
            </div>
          )}
          {!loading && results.length === 0 && !showAskCoach && !showAgentAction && query.trim() && (
            <div className="p-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No results found
            </div>
          )}
          {/* Agent action suggestion — takes priority when detected */}
          {showAgentAction && (
            <button
              onClick={startAgentSession}
              className="w-full px-3 py-3 flex items-center gap-3 text-left transition-colors border-b"
              style={{
                background: selectedIndex === agentActionIndex ? 'var(--color-border)' : 'transparent',
                borderColor: 'var(--color-border)',
              }}
              onMouseEnter={() => setSelectedIndex(agentActionIndex)}
              data-testid="agent-action-option"
            >
              <div
                className="p-1.5 rounded-lg shrink-0"
                style={{ background: 'rgba(34, 211, 238, 0.2)', color: '#22d3ee' }}
              >
                <Play size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
                  {agentActionLabel}
                </div>
                <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                  {agentActionSubtitle}
                </div>
              </div>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                style={{ background: 'rgba(34, 211, 238, 0.3)', color: '#22d3ee' }}
              >
                Start
              </span>
            </button>
          )}
          {results.map((result, i) => {
            const Icon = CATEGORY_ICONS[result.category];
            const itemIndex = resultsOffset + i;
            return (
              <button
                key={`${result.category}-${result.id}`}
                onClick={() => handleSelect(result)}
                className="w-full px-3 py-2.5 flex items-start gap-3 text-left transition-colors"
                style={{
                  background: itemIndex === selectedIndex ? 'var(--color-border)' : 'transparent',
                }}
                onMouseEnter={() => setSelectedIndex(itemIndex)}
                data-testid="search-result"
              >
                <div
                  className="mt-0.5 p-1.5 rounded-lg shrink-0"
                  style={{ background: 'var(--color-bg)' }}
                >
                  <Icon size={14} style={{ color: 'var(--color-accent)' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
                    {result.title}
                  </div>
                  <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {result.subtitle}
                  </div>
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 mt-0.5"
                  style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
                >
                  {CATEGORY_LABELS[result.category]}
                </span>
              </button>
            );
          })}

          {/* Ask Coach option */}
          {showAskCoach && (
            <>
              {results.length > 0 && (
                <div className="mx-3 border-t" style={{ borderColor: 'var(--color-border)' }} />
              )}
              <button
                onClick={() => askCoach(query.trim())}
                className="w-full px-3 py-3 flex items-center gap-3 text-left transition-colors"
                style={{
                  background: selectedIndex === askCoachIndex ? 'var(--color-border)' : 'transparent',
                }}
                onMouseEnter={() => setSelectedIndex(askCoachIndex)}
                data-testid="ask-coach-option"
              >
                <div
                  className="p-1.5 rounded-lg shrink-0"
                  style={{ background: 'var(--color-accent)', color: 'white' }}
                >
                  <MessageCircle size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
                    Ask Coach
                  </div>
                  <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                    &ldquo;{query.trim()}&rdquo;
                  </div>
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                  style={{ background: 'var(--color-accent)', color: 'white' }}
                >
                  Enter
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
