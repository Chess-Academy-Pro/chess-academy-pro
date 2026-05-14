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
    const input = screen.getByTestId('chat-text-input') as HTMLInputElement;
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
    const input = screen.getByTestId('chat-text-input') as HTMLInputElement;
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
    const input = screen.getByTestId('chat-text-input') as HTMLInputElement;
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
    const input = screen.getByTestId('chat-text-input') as HTMLInputElement;
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
