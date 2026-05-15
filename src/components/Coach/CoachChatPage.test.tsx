import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { CoachChatPage } from './CoachChatPage';
import { useAppStore } from '../../stores/appStore';
import {
  useCoachSessionStore,
  __resetCoachSessionStoreForTests,
} from '../../stores/coachSessionStore';
import {
  useCoachMemoryStore,
  __resetCoachMemoryStoreForTests,
} from '../../stores/coachMemoryStore';
import { buildUserProfile } from '../../test/factories';
import type { ChatMessage as ChatMessageType } from '../../types';

vi.mock('../../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn().mockResolvedValue(undefined),
    speakForced: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}));

vi.mock('../../services/coachApi', () => ({
  getCoachChatResponse: vi.fn().mockResolvedValue('Hello! How can I help?'),
}));

vi.mock('../../services/coachChatService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/coachChatService')>();
  return {
    ...actual,
    loadAnalysisContext: vi.fn().mockResolvedValue(''),
  };
});

vi.mock('../../services/coachSessionRouter', () => ({
  routeChatIntent: vi.fn(),
}));
import { routeChatIntent } from '../../services/coachSessionRouter';
import { getCoachChatResponse } from '../../services/coachApi';
import { voiceService } from '../../services/voiceService';
import { coachService } from '../../coach/coachService';

const mockedNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockedNavigate,
  };
});

const mockProfile = buildUserProfile({
  id: 'main',
  name: 'Player',
  currentRating: 1420,
  puzzleRating: 1400,
  xp: 500,
  level: 3,
});

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

function setSessionMessages(messages: ChatMessageType[]): void {
  useCoachSessionStore.setState({ messages, hydrated: true });
}

describe('CoachChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedNavigate.mockReset();
    vi.mocked(routeChatIntent).mockReset();
    vi.mocked(routeChatIntent).mockResolvedValue(null);
    __resetCoachSessionStoreForTests();
    __resetCoachMemoryStoreForTests();
    useAppStore.setState({
      activeProfile: mockProfile,
      chatMessages: [],
    });
  });

  it('renders the chat page', () => {
    render(<CoachChatPage />);
    expect(screen.getByTestId('coach-chat-page')).toBeInTheDocument();
  });

  it('shows coach name in header', () => {
    render(<CoachChatPage />);
    expect(screen.getByText(/Chat with Coach/)).toBeInTheDocument();
  });

  it('shows empty state prompt', () => {
    render(<CoachChatPage />);
    expect(screen.getByText(/How can I help you today\?/)).toBeInTheDocument();
  });

  it('renders chat input', () => {
    render(<CoachChatPage />);
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('renders text input', () => {
    render(<CoachChatPage />);
    expect(screen.getByTestId('chat-text-input')).toBeInTheDocument();
  });

  it('renders send button', () => {
    render(<CoachChatPage />);
    expect(screen.getByTestId('chat-send-btn')).toBeInTheDocument();
  });

  it('shows existing messages', () => {
    setSessionMessages([
        { id: '1', role: 'user', content: 'Hello coach!', timestamp: 1000 },
        { id: '2', role: 'assistant', content: 'Hello! Ready to train?', timestamp: 1001 },
      ]);

    render(<CoachChatPage />);
    expect(screen.getByText('Hello coach!')).toBeInTheDocument();
    expect(screen.getByText('Hello! Ready to train?')).toBeInTheDocument();
  });

  it('renders user messages with user role test id', () => {
    setSessionMessages([
        { id: '1', role: 'user', content: 'What opening should I play?', timestamp: 1000 },
      ]);

    render(<CoachChatPage />);
    expect(screen.getByTestId('chat-message-user')).toBeInTheDocument();
  });

  it('renders assistant messages with assistant role test id', () => {
    setSessionMessages([
        { id: '2', role: 'assistant', content: 'Try the Italian Game!', timestamp: 1001 },
      ]);

    render(<CoachChatPage />);
    expect(screen.getByTestId('chat-message-assistant')).toBeInTheDocument();
  });

  it('hides empty state when messages exist', () => {
    setSessionMessages([
        { id: '1', role: 'user', content: 'Hello!', timestamp: 1000 },
      ]);

    render(<CoachChatPage />);
    expect(screen.queryByText(/Ask about positions, openings, strategy/)).not.toBeInTheDocument();
  });

  it('displays Online status when not streaming', () => {
    render(<CoachChatPage />);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('send button is initially disabled when input is empty', () => {
    render(<CoachChatPage />);
    const sendBtn = screen.getByTestId('chat-send-btn');
    expect(sendBtn).toBeDisabled();
  });

  it('renders action tag buttons when assistant message has actions', () => {
    const msgWithActions: ChatMessageType = {
      id: '3',
      role: 'assistant',
      content: 'You should practice the Sicilian!',
      timestamp: 1002,
      metadata: {
        actions: [
          { type: 'drill_opening', id: 'sicilian' },
          { type: 'puzzle_theme', id: 'fork' },
        ],
      },
    };
    setSessionMessages([msgWithActions]);

    render(<CoachChatPage />);
    expect(screen.getByTestId('action-drill_opening')).toBeInTheDocument();
    expect(screen.getByTestId('action-puzzle_theme')).toBeInTheDocument();
  });

  it('navigates to a session instead of calling LLM when intent is detected', async () => {
    vi.mocked(routeChatIntent).mockResolvedValueOnce({
      path: '/coach/session/play-against?difficulty=auto',
      ackMessage: "Let's play!",
      intent: { kind: 'play-against', raw: "let's play" },
    });

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: "let's play" } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() =>
      expect(mockedNavigate).toHaveBeenCalledWith(
        '/coach/session/play-against?difficulty=auto',
      ),
    );
    // Intent-routed messages skip the LLM entirely.
    expect(getCoachChatResponse).not.toHaveBeenCalled();
  });

  it('falls through to LLM when intent router returns null', async () => {
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'Why is f7 weak?' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(getCoachChatResponse).toHaveBeenCalled());
    expect(mockedNavigate).not.toHaveBeenCalled();
  });

  it('mirrors intent-routed fast-path turns into the coach memory store', async () => {
    vi.mocked(routeChatIntent).mockResolvedValueOnce({
      path: '/coach/session/play-against?difficulty=auto',
      ackMessage: "Let's play!",
      intent: { kind: 'play-against', raw: "let's play" },
    });

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: "let's play" } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() =>
      expect(mockedNavigate).toHaveBeenCalledWith(
        '/coach/session/play-against?difficulty=auto',
      ),
    );

    const history = useCoachMemoryStore.getState().conversationHistory;
    // Both the user ask and the ack must land in memory so the brain's
    // next envelope reflects the fast-path turn. The bug fixed in this
    // PR was that fast-paths only wrote to the session store, leaving
    // memory empty.
    expect(history.length).toBeGreaterThanOrEqual(2);
    const recent = history.slice(-2);
    expect(recent[0]).toMatchObject({
      role: 'user',
      surface: 'chat-coach-tab',
      text: "let's play",
    });
    expect(recent[1]).toMatchObject({
      role: 'coach',
      surface: 'chat-coach-tab',
      text: "Let's play!",
    });
  });

  it('mirrors LLM-path turns into the coach memory store', async () => {
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'Why is f7 weak?' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(getCoachChatResponse).toHaveBeenCalled());

    // The LLM path writes the user ask immediately and the assistant
    // reply after the stream resolves. Wait for at least the user
    // entry, then verify the pair.
    await waitFor(() => {
      expect(useCoachMemoryStore.getState().conversationHistory.length).toBeGreaterThanOrEqual(2);
    });
    const history = useCoachMemoryStore.getState().conversationHistory;
    const recent = history.slice(-2);
    expect(recent[0]).toMatchObject({
      role: 'user',
      surface: 'chat-coach-tab',
      text: 'Why is f7 weak?',
    });
    expect(recent[1].role).toBe('coach');
    expect(recent[1].surface).toBe('chat-coach-tab');
  });

  // ── Contract gaps from the UX doc ─────────────────────────────────

  it('3.6 surfaces the failure stub when coachService.ask throws', async () => {
    // Force the spine to throw so the catch block in CoachChatPage
    // fires. This path is rarely hit in production (coachApi swallows
    // most LLM errors at the provider level), so without an explicit
    // test the stub copy could silently rot if a future refactor
    // removes the catch.
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);
    const spy = vi.spyOn(coachService, 'ask').mockRejectedValueOnce(new Error('simulated provider outage'));

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'Why is f7 weak?' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => {
      expect(screen.getByText(/Coach is unavailable right now/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/simulated provider outage/)).toBeInTheDocument();
    // Failure must also land in conversation memory so the next turn's
    // envelope sees "user asked X, coach failed."
    const history = useCoachMemoryStore.getState().conversationHistory;
    expect(history.at(-1)?.role).toBe('coach');
    expect(history.at(-1)?.text).toMatch(/unavailable/i);

    spy.mockRestore();
  });

  it('4.2 blocks send while the persisted session is hydrating', async () => {
    // Reset hydrated=false so the guard short-circuits handleSend.
    __resetCoachSessionStoreForTests();
    useCoachSessionStore.setState({ messages: [], hydrated: false });
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'Why is f7 weak?' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    // Nothing should fire while !hydrated — the intent router would
    // be reached AFTER the early-return guard, so it stays
    // unconsulted, the LLM call doesn't happen, and the transcript
    // remains empty.
    await new Promise((r) => setTimeout(r, 50));
    expect(getCoachChatResponse).not.toHaveBeenCalled();
    expect(routeChatIntent).not.toHaveBeenCalled();
    expect(useCoachSessionStore.getState().messages).toEqual([]);
    expect(useCoachMemoryStore.getState().conversationHistory).toEqual([]);
  });

  it('4.4 restores the transcript from a persisted session on mount', () => {
    // Seed the session store as if hydrate() already pulled prior
    // messages from Dexie. The page should render them on mount.
    const persisted: ChatMessageType[] = [
      { id: 'p-1', role: 'user', content: 'Walk me through the Italian.', timestamp: 1000 },
      { id: 'p-2', role: 'assistant', content: "Sure — here's the spine.", timestamp: 1001 },
    ];
    setSessionMessages(persisted);

    render(<CoachChatPage />);
    expect(screen.getByText('Walk me through the Italian.')).toBeInTheDocument();
    expect(screen.getByText("Sure — here's the spine.")).toBeInTheDocument();
    // Empty-state greeting MUST be hidden when there are restored
    // messages — otherwise the 6 chips render alongside the
    // transcript on every refresh, which violates the contract.
    expect(screen.queryByTestId('coach-greeting')).not.toBeInTheDocument();
  });

  it('3.2 strips [BOARD: ...] and [[ACTION: ...]] tags from the display bubble', async () => {
    // The LLM may emit board-arrow and action-tag markers. The
    // dispatcher consumes them, but the user-visible bubble must
    // not show them. Without this stripping the chat would render
    // raw tags like "[BOARD: arrow:e2-e4:green]" which the user
    // reads as garbage. The streaming buffer's TAG_STRIP_RE is the
    // gate; this test exercises it via the streamed-chunks path.
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);
    vi.mocked(getCoachChatResponse).mockImplementationOnce(async (_msgs, _sys, onChunk) => {
      const raw = '[BOARD: arrow:e2-e4:green] Push the e-pawn. [[ACTION:set_intended_opening {"name":"Italian"}]] Done.';
      onChunk?.(raw);
      return raw;
    });

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'What now?' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => {
      expect(screen.getByText(/Push the e-pawn/i)).toBeInTheDocument();
    });
    // The displayed bubble must NOT contain the raw markers.
    const allText = document.body.textContent ?? '';
    expect(allText).not.toMatch(/\[BOARD:/);
    expect(allText).not.toMatch(/\[\[ACTION:/);
    expect(allText).not.toMatch(/\[ACTION:/);
  });

  it('3.3 voice gating: streamed sentences flush through speakForced when unmuted', async () => {
    vi.mocked(routeChatIntent).mockResolvedValueOnce(null);
    // Emit each sentence as a separate chunk. The streaming onChunk
    // handler in CoachChatPage flushes one sentence per chunk (non-
    // greedy regex match), so multi-sentence chunks would only fire
    // one in-stream flush + one tail flush. By chunking per sentence
    // we exercise the in-stream flush path for each terminator.
    vi.mocked(getCoachChatResponse).mockImplementationOnce(async (_msgs, _sys, onChunk) => {
      onChunk?.('First idea. ');
      onChunk?.('Second idea! ');
      onChunk?.('Third idea?');
      return 'First idea. Second idea! Third idea?';
    });

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'tell me' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(getCoachChatResponse).toHaveBeenCalled());
    // At least 3 speak calls — one per sentence terminator (the
    // post-stream tail flush may or may not fire depending on
    // whether any text remains in the buffer; we just enforce the
    // minimum of one-per-sentence).
    await waitFor(() => {
      expect(vi.mocked(voiceService.speakForced).mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    const callTexts = vi.mocked(voiceService.speakForced).mock.calls.map((c) => c[0]);
    expect(callTexts.join(' ')).toMatch(/First idea\./);
    expect(callTexts.join(' ')).toMatch(/Second idea!/);
    expect(callTexts.join(' ')).toMatch(/Third idea\?/);
  });

  it('double-tap race: two synchronous sends fire at most one fast-path', async () => {
    // Regression guard for the inFlightRef synchronous guard.
    // Pre-fix, two rapid Enter-presses both passed `if (isStreaming)
    // return;` because isStreaming hadn't React-committed yet, so
    // both fired the routeChatIntent fast-path and double-appended
    // user + ack pairs.
    vi.mocked(routeChatIntent).mockResolvedValue({
      path: '/coach/session/play-against?difficulty=auto',
      ackMessage: "Let's play!",
      intent: { kind: 'play-against', raw: "let's play" },
    });

    render(<CoachChatPage />);
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: "let's play" } });
    // Fire two sends synchronously — same JS tick.
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(routeChatIntent).toHaveBeenCalled());
    // routeChatIntent should be called AT MOST ONCE despite two
    // clicks. With the inFlightRef guard, the second click
    // short-circuits before reaching the router.
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(routeChatIntent).mock.calls.length).toBeLessThanOrEqual(1);
    // Session store should also contain at most one user + ack pair.
    const userMsgs = useCoachSessionStore.getState().messages.filter((m) => m.role === 'user');
    expect(userMsgs.length).toBeLessThanOrEqual(1);
  });

  it('read-this-to-me does NOT silently unmute the voice toggle', async () => {
    // Regression guard: pre-fix, READ_THIS_RE branch flipped
    // voiceMuted to false without telling the user. speakForced
    // already bypasses the mute, so the state mutation was both
    // unnecessary and surprising.
    setSessionMessages([
      {
        id: 'c-prev',
        role: 'assistant',
        content: 'The Italian opens with **e4 e5 Nf3 Nc6 Bc4**.',
        timestamp: 1000,
      },
    ]);

    render(<CoachChatPage />);
    // Start in unmuted state (default). Mute by clicking the toggle.
    const voiceBtn = screen.getByTestId('voice-toggle');
    fireEvent.click(voiceBtn);
    // Verify muted by checking the title attribute.
    await waitFor(() => {
      expect(voiceBtn).toHaveAttribute('title', expect.stringMatching(/Unmute voice/i));
    });

    // Send "read this to me".
    const input = screen.getByTestId('chat-text-input');
    fireEvent.change(input, { target: { value: 'read this to me' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    // Wait for speakForced to fire (the read-this path always speaks).
    await waitFor(() => expect(voiceService.speakForced).toHaveBeenCalled());

    // The voice toggle should STILL be in the muted state — the
    // read-this path must not silently flip it.
    expect(voiceBtn).toHaveAttribute('title', expect.stringMatching(/Unmute voice/i));
  });

  it('action buttons have correct labels', () => {
    const msgWithActions: ChatMessageType = {
      id: '3',
      role: 'assistant',
      content: 'Review this game.',
      timestamp: 1002,
      metadata: {
        actions: [
          { type: 'review_game', id: 'game1' },
        ],
      },
    };
    setSessionMessages([msgWithActions]);

    render(<CoachChatPage />);
    expect(screen.getByTestId('action-review_game')).toHaveTextContent('Review Game');
  });
});
