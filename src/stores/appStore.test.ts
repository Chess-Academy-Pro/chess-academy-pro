import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useAppStore,
  selectFreshBoardSnapshot,
  LAST_BOARD_SNAPSHOT_TTL_MS,
} from '../stores/appStore';
import {
  buildUserProfile,
  buildCoachGameState,
  buildChatMessage,
} from '../test/factories';


beforeEach(() => {
  useAppStore.getState().reset();
});

// ─── DEFAULT_STATE ───────────────────────────────────────────────────────────

describe('DEFAULT_STATE', () => {
  it('initial activeProfile is null', () => {
    expect(useAppStore.getState().activeProfile).toBeNull();
  });

  it('initial isLoading is true', () => {
    expect(useAppStore.getState().isLoading).toBe(true);
  });

  it('initial engineEnabled is true', () => {
    expect(useAppStore.getState().engineEnabled).toBe(true);
  });

  it('initial evalBarVisible is true', () => {
    expect(useAppStore.getState().evalBarVisible).toBe(true);
  });

  it('initial coachGameState is null', () => {
    expect(useAppStore.getState().coachGameState).toBeNull();
  });

  it('initial chatMessages is empty array', () => {
    expect(useAppStore.getState().chatMessages).toEqual([]);
  });

  it('initial sidebarOpen is false', () => {
    expect(useAppStore.getState().sidebarOpen).toBe(false);
  });
});

// ─── Setters ─────────────────────────────────────────────────────────────────

describe('Setters', () => {
  it('setActiveProfile sets profile', () => {
    const profile = buildUserProfile({ name: 'Alice' });
    useAppStore.getState().setActiveProfile(profile);
    expect(useAppStore.getState().activeProfile).toEqual(profile);
  });

  it('setActiveProfile clears profile when set to null', () => {
    useAppStore.getState().setActiveProfile(buildUserProfile());
    useAppStore.getState().setActiveProfile(null);
    expect(useAppStore.getState().activeProfile).toBeNull();
  });

  it('setLoading sets loading state', () => {
    useAppStore.getState().setLoading(false);
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it('setCoachGameState sets game state', () => {
    const gameState = buildCoachGameState();
    useAppStore.getState().setCoachGameState(gameState);
    expect(useAppStore.getState().coachGameState).toEqual(gameState);
  });

  it('setChatMessages sets messages array', () => {
    const messages = [
      buildChatMessage({ content: 'Hello' }),
      buildChatMessage({ role: 'assistant', content: 'Hi there!' }),
    ];
    useAppStore.getState().setChatMessages(messages);
    expect(useAppStore.getState().chatMessages).toEqual(messages);
  });

  it('setSidebarOpen sets sidebar state', () => {
    useAppStore.getState().setSidebarOpen(true);
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });
});

// ─── Toggles ─────────────────────────────────────────────────────────────────

describe('Toggles', () => {
  it('toggleEngine flips engineEnabled', () => {
    expect(useAppStore.getState().engineEnabled).toBe(true);
    useAppStore.getState().toggleEngine();
    expect(useAppStore.getState().engineEnabled).toBe(false);
    useAppStore.getState().toggleEngine();
    expect(useAppStore.getState().engineEnabled).toBe(true);
  });

  it('toggleEvalBar flips evalBarVisible', () => {
    expect(useAppStore.getState().evalBarVisible).toBe(true);
    useAppStore.getState().toggleEvalBar();
    expect(useAppStore.getState().evalBarVisible).toBe(false);
    useAppStore.getState().toggleEvalBar();
    expect(useAppStore.getState().evalBarVisible).toBe(true);
  });
});

// ─── Chat Messages ───────────────────────────────────────────────────────────

describe('Chat Messages', () => {
  it('addChatMessage appends to chatMessages', () => {
    const msg1 = buildChatMessage({ content: 'First' });
    const msg2 = buildChatMessage({ content: 'Second' });

    useAppStore.getState().addChatMessage(msg1);
    expect(useAppStore.getState().chatMessages).toHaveLength(1);
    expect(useAppStore.getState().chatMessages[0]).toEqual(msg1);

    useAppStore.getState().addChatMessage(msg2);
    expect(useAppStore.getState().chatMessages).toHaveLength(2);
    expect(useAppStore.getState().chatMessages[1]).toEqual(msg2);
  });

  it('clearChatMessages empties chatMessages', () => {
    useAppStore.getState().addChatMessage(buildChatMessage());
    useAppStore.getState().addChatMessage(buildChatMessage());
    expect(useAppStore.getState().chatMessages).toHaveLength(2);

    useAppStore.getState().clearChatMessages();
    expect(useAppStore.getState().chatMessages).toEqual([]);
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────

describe('Reset', () => {
  it('reset returns all state to defaults', () => {
    // Mutate every piece of state
    useAppStore.getState().setActiveProfile(buildUserProfile());
    useAppStore.getState().setLoading(false);
    useAppStore.getState().setSidebarOpen(true);
    useAppStore.getState().toggleEngine();
    useAppStore.getState().toggleEvalBar();
    useAppStore.getState().setCoachGameState(buildCoachGameState());
    useAppStore.getState().addChatMessage(buildChatMessage());

    // Reset
    useAppStore.getState().reset();

    // Verify all defaults
    const state = useAppStore.getState();
    expect(state.activeProfile).toBeNull();
    expect(state.isLoading).toBe(true);
    expect(state.sidebarOpen).toBe(false);
    expect(state.engineEnabled).toBe(true);
    expect(state.evalBarVisible).toBe(true);
    expect(state.coachGameState).toBeNull();
    expect(state.chatMessages).toEqual([]);
  });
});

// ─── subscribeWithSelector ───────────────────────────────────────────────────

describe('subscribeWithSelector', () => {
  it('fires callback on specific field change', () => {
    const callback = vi.fn();

    const unsub = useAppStore.subscribe(
      (state) => state.engineEnabled,
      callback,
    );

    useAppStore.getState().toggleEngine();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(false, true);

    // Changing a different field should NOT fire the callback
    useAppStore.getState().setSidebarOpen(true);
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();
  });
});

// ─── lastBoardSnapshot ───────────────────────────────────────────────────────

describe('lastBoardSnapshot', () => {
  const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('is null by default', () => {
    expect(useAppStore.getState().lastBoardSnapshot).toBeNull();
  });

  it('setLastBoardSnapshot stores fen + source and stamps the time', () => {
    const before = Date.now();
    useAppStore.getState().setLastBoardSnapshot({ fen: TEST_FEN, source: 'game-review' });
    const snap = useAppStore.getState().lastBoardSnapshot;
    expect(snap).not.toBeNull();
    expect(snap?.fen).toBe(TEST_FEN);
    expect(snap?.source).toBe('game-review');
    expect(snap?.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('preserves optional label when provided', () => {
    useAppStore.getState().setLastBoardSnapshot({
      fen: TEST_FEN,
      source: 'game-review',
      label: 'vs. Smith, move 14',
    });
    expect(useAppStore.getState().lastBoardSnapshot?.label).toBe('vs. Smith, move 14');
  });

  it('clearLastBoardSnapshot resets it to null', () => {
    useAppStore.getState().setLastBoardSnapshot({ fen: TEST_FEN, source: 'puzzle' });
    useAppStore.getState().clearLastBoardSnapshot();
    expect(useAppStore.getState().lastBoardSnapshot).toBeNull();
  });

  it('selectFreshBoardSnapshot returns the snapshot when within TTL', () => {
    useAppStore.getState().setLastBoardSnapshot({ fen: TEST_FEN, source: 'analysis' });
    const state = useAppStore.getState();
    // Pretend "now" is just one second after the stamp.
    const nowMs = (state.lastBoardSnapshot?.timestamp ?? 0) + 1000;
    expect(selectFreshBoardSnapshot(state, nowMs)?.fen).toBe(TEST_FEN);
  });

  it('selectFreshBoardSnapshot returns null when snapshot is stale', () => {
    useAppStore.getState().setLastBoardSnapshot({ fen: TEST_FEN, source: 'analysis' });
    const state = useAppStore.getState();
    const nowMs =
      (state.lastBoardSnapshot?.timestamp ?? 0) + LAST_BOARD_SNAPSHOT_TTL_MS + 1;
    expect(selectFreshBoardSnapshot(state, nowMs)).toBeNull();
  });

  it('selectFreshBoardSnapshot returns null when no snapshot exists', () => {
    expect(selectFreshBoardSnapshot(useAppStore.getState())).toBeNull();
  });
});
