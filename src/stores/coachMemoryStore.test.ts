import { describe, it, expect, beforeEach, vi } from 'vitest';

const auditCalls: { kind: string; summary: string }[] = [];
vi.mock('../services/appAuditor', () => ({
  logAppAudit: vi.fn((entry: { kind: string; summary: string }) => {
    auditCalls.push({ kind: entry.kind, summary: entry.summary });
    return Promise.resolve();
  }),
}));

import {
  useCoachMemoryStore,
  __resetCoachMemoryStoreForTests,
  __flushCoachMemoryPersistForTests,
} from './coachMemoryStore';
import {
  tryCaptureOpeningIntent,
  tryCaptureForgetIntent,
} from '../services/openingIntentCapture';
import { db } from '../db/schema';

beforeEach(async () => {
  auditCalls.length = 0;
  __resetCoachMemoryStoreForTests();
  await db.meta.delete('coachMemory.v1');
});

describe('useCoachMemoryStore.setIntendedOpening', () => {
  it('writes intent and emits coach-memory-intent-set audit', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const intent = useCoachMemoryStore.getState().intendedOpening;
    expect(intent).not.toBeNull();
    expect(intent?.name).toBe('Caro-Kann Defense');
    expect(intent?.color).toBe('black');
    expect(intent?.capturedFromSurface).toBe('test');
    expect(intent?.setAt).toBeGreaterThan(0);
    expect(auditCalls.some((c) => c.kind === 'coach-memory-intent-set')).toBe(true);
  });

  it('overwrites the prior intent on a new set', () => {
    const s = useCoachMemoryStore.getState();
    s.setIntendedOpening({ name: 'Caro-Kann Defense', color: 'black', capturedFromSurface: 'a' });
    s.setIntendedOpening({ name: 'Sicilian Defense', color: 'black', capturedFromSurface: 'b' });
    expect(useCoachMemoryStore.getState().intendedOpening?.name).toBe('Sicilian Defense');
    expect(auditCalls.filter((c) => c.kind === 'coach-memory-intent-set')).toHaveLength(2);
  });
});

describe('useCoachMemoryStore.clearIntendedOpening', () => {
  it('clears intent and emits coach-memory-intent-cleared with reason', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    useCoachMemoryStore.getState().clearIntendedOpening('user-said-forget');
    expect(useCoachMemoryStore.getState().intendedOpening).toBeNull();
    const cleared = auditCalls.find((c) => c.kind === 'coach-memory-intent-cleared');
    expect(cleared).toBeTruthy();
    expect(cleared?.summary).toMatch(/user-said-forget/);
  });

  it('is a no-op when there is no current intent', () => {
    useCoachMemoryStore.getState().clearIntendedOpening('user-said-forget');
    expect(auditCalls.some((c) => c.kind === 'coach-memory-intent-cleared')).toBe(false);
  });
});

describe('useCoachMemoryStore persistence', () => {
  it('roundtrips intent through Dexie via hydrate', async () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    await __flushCoachMemoryPersistForTests();

    // Simulate a cold start: in-memory reset, then hydrate from Dexie.
    useCoachMemoryStore.setState({
      intendedOpening: null,
      conversationHistory: [],
      preferences: { likes: [], dislikes: [], style: null },
      hintRequests: [],
      blunderPatterns: [],
      growthMap: [],
      gameHistory: [],
      hydrated: false,
    });
    await useCoachMemoryStore.getState().hydrate();

    const restored = useCoachMemoryStore.getState().intendedOpening;
    expect(restored?.name).toBe('Caro-Kann Defense');
    expect(restored?.color).toBe('black');
    expect(useCoachMemoryStore.getState().hydrated).toBe(true);
  });
});

describe('useCoachMemoryStore.setActiveOpeningCard', () => {
  it('sets the active card for the given color and bumps lastActiveRolodexColor', () => {
    useCoachMemoryStore.getState().setActiveOpeningCard('white', 'italian-game-id');
    const s = useCoachMemoryStore.getState();
    expect(s.activeOpeningCardId).toEqual({ white: 'italian-game-id', black: null });
    expect(s.lastActiveRolodexColor).toBe('white');
    expect(auditCalls.some((c) => c.kind === 'coach-memory-rolodex-active-card-set')).toBe(true);
  });

  it('updates only the color passed; the other slot is untouched', () => {
    const s = useCoachMemoryStore.getState();
    s.setActiveOpeningCard('white', 'italian-game-id');
    s.setActiveOpeningCard('black', 'caro-kann-id');
    const state = useCoachMemoryStore.getState();
    expect(state.activeOpeningCardId).toEqual({
      white: 'italian-game-id',
      black: 'caro-kann-id',
    });
    expect(state.lastActiveRolodexColor).toBe('black');
  });

  it('is a no-op when the same id is set again for the same color', () => {
    const s = useCoachMemoryStore.getState();
    s.setActiveOpeningCard('white', 'italian-game-id');
    auditCalls.length = 0;
    s.setActiveOpeningCard('white', 'italian-game-id');
    expect(auditCalls).toHaveLength(0);
  });

  it('re-runs when the same id is set for the same color but folder was last-touched elsewhere', () => {
    const s = useCoachMemoryStore.getState();
    s.setActiveOpeningCard('white', 'italian-game-id');
    s.setActiveOpeningCard('black', 'caro-kann-id');
    auditCalls.length = 0;
    s.setActiveOpeningCard('white', 'italian-game-id');
    expect(useCoachMemoryStore.getState().lastActiveRolodexColor).toBe('white');
    expect(auditCalls).toHaveLength(1);
  });

  it('accepts null to clear the active card for a color (last favorite removed)', () => {
    const s = useCoachMemoryStore.getState();
    s.setActiveOpeningCard('white', 'italian-game-id');
    s.setActiveOpeningCard('white', null);
    expect(useCoachMemoryStore.getState().activeOpeningCardId.white).toBeNull();
  });
});

describe('useCoachMemoryStore rolodex persistence', () => {
  it('roundtrips activeOpeningCardId + lastActiveRolodexColor through Dexie via hydrate', async () => {
    useCoachMemoryStore.getState().setActiveOpeningCard('white', 'italian-game-id');
    useCoachMemoryStore.getState().setActiveOpeningCard('black', 'caro-kann-id');
    await __flushCoachMemoryPersistForTests();

    __resetCoachMemoryStoreForTests();
    expect(useCoachMemoryStore.getState().activeOpeningCardId).toEqual({
      white: null,
      black: null,
    });

    await useCoachMemoryStore.getState().hydrate();

    expect(useCoachMemoryStore.getState().activeOpeningCardId).toEqual({
      white: 'italian-game-id',
      black: 'caro-kann-id',
    });
    expect(useCoachMemoryStore.getState().lastActiveRolodexColor).toBe('black');
  });

  it('falls back to defaults when a legacy persisted blob omits the rolodex fields', async () => {
    // Simulate a persisted blob written before the rolodex fields existed —
    // the keys are simply absent from the JSON payload.
    await db.meta.put({
      key: 'coachMemory.v1',
      value: JSON.stringify({
        intendedOpening: null,
        conversationHistory: [],
        preferences: { likes: [], dislikes: [], style: null },
        hintRequests: [],
        blunderPatterns: [],
        growthMap: [],
        gameHistory: [],
        savedPosition: null,
        autoSavedPosition: null,
      }),
    });

    __resetCoachMemoryStoreForTests();
    await useCoachMemoryStore.getState().hydrate();

    expect(useCoachMemoryStore.getState().activeOpeningCardId).toEqual({
      white: null,
      black: null,
    });
    expect(useCoachMemoryStore.getState().lastActiveRolodexColor).toBeNull();
  });
});

describe('tryCaptureOpeningIntent', () => {
  it('captures Caro-Kann from a chat message and writes to the store', () => {
    const result = tryCaptureOpeningIntent(
      'Play the Caro-Kann against me as Black.',
      'home-chat',
      'white',
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Caro-Kann Defense');
    expect(result?.color).toBe('black');
    const intent = useCoachMemoryStore.getState().intendedOpening;
    expect(intent?.name).toBe('Caro-Kann Defense');
    expect(intent?.capturedFromSurface).toBe('home-chat');
  });

  it('captures Sicilian and records the surface label', () => {
    const result = tryCaptureOpeningIntent(
      "Let's play the Sicilian.",
      'in-game-chat',
      'black',
    );
    expect(result?.name).toBe('Sicilian Defense');
    expect(useCoachMemoryStore.getState().intendedOpening?.capturedFromSurface).toBe('in-game-chat');
  });

  it('returns null and writes nothing on an unrelated message', () => {
    const result = tryCaptureOpeningIntent('What is my rating?', 'home-chat', 'white');
    expect(result).toBeNull();
    expect(useCoachMemoryStore.getState().intendedOpening).toBeNull();
  });

  it('returns null on an unknown opening name', () => {
    const result = tryCaptureOpeningIntent(
      'play the Totally Made Up Opening against me',
      'home-chat',
      'white',
    );
    expect(result).toBeNull();
    expect(useCoachMemoryStore.getState().intendedOpening).toBeNull();
  });
});

describe('tryCaptureForgetIntent', () => {
  it('clears a prior intent on "forget the Caro-Kann"', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const cleared = tryCaptureForgetIntent('Forget the Caro-Kann.', 'in-game-chat');
    expect(cleared).toBe(true);
    expect(useCoachMemoryStore.getState().intendedOpening).toBeNull();
    const audit = auditCalls.find((c) => c.kind === 'coach-memory-intent-cleared');
    expect(audit?.summary).toMatch(/user-said-forget/);
  });

  it('clears on "play anything"', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Sicilian Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const cleared = tryCaptureForgetIntent("Let's play anything.", 'in-game-chat');
    expect(cleared).toBe(true);
    const audit = auditCalls.find((c) => c.kind === 'coach-memory-intent-cleared');
    expect(audit?.summary).toMatch(/user-said-play-anything/);
  });

  it('returns false when there is no current intent', () => {
    const cleared = tryCaptureForgetIntent('Forget the Caro-Kann.', 'in-game-chat');
    expect(cleared).toBe(false);
  });

  it('returns false on a message that does not ask to forget', () => {
    useCoachMemoryStore.getState().setIntendedOpening({
      name: 'Caro-Kann Defense',
      color: 'black',
      capturedFromSurface: 'test',
    });
    const cleared = tryCaptureForgetIntent('Can you explain this move?', 'in-game-chat');
    expect(cleared).toBe(false);
    expect(useCoachMemoryStore.getState().intendedOpening?.name).toBe('Caro-Kann Defense');
  });
});

describe('useCoachMemoryStore.appendConversationMessage', () => {
  it('appends a coach utterance and emits coach-memory-conversation-appended audit', () => {
    const id = useCoachMemoryStore.getState().appendConversationMessage({
      surface: 'live-coach',
      role: 'coach',
      text: 'Beautiful — that knight maneuver completely rewires your kingside.',
      gameId: 'g-1',
      ply: 14,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      trigger: 'great-move',
    });
    const history = useCoachMemoryStore.getState().conversationHistory;
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(id);
    expect(history[0].surface).toBe('live-coach');
    expect(history[0].trigger).toBe('great-move');
    expect(history[0].timestamp).toBeGreaterThan(0);
    expect(auditCalls.some((c) => c.kind === 'coach-memory-conversation-appended')).toBe(true);
  });

  it('preserves order when called multiple times', () => {
    const store = useCoachMemoryStore.getState();
    store.appendConversationMessage({
      surface: 'live-coach', role: 'coach', text: 'first', trigger: 'great-move',
    });
    store.appendConversationMessage({
      surface: 'live-coach', role: 'coach', text: 'second', trigger: 'opponent-blunder',
    });
    const history = useCoachMemoryStore.getState().conversationHistory;
    expect(history).toHaveLength(2);
    expect(history[0].text).toBe('first');
    expect(history[1].text).toBe('second');
  });

  it('caps the array at 200 entries and drops oldest first', () => {
    const store = useCoachMemoryStore.getState();
    for (let i = 0; i < 205; i++) {
      store.appendConversationMessage({
        surface: 'live-coach',
        role: 'coach',
        text: `msg-${i}`,
        trigger: null,
      });
    }
    const history = useCoachMemoryStore.getState().conversationHistory;
    expect(history).toHaveLength(200);
    // Oldest (msg-0..msg-4) dropped, newest retained.
    expect(history[0].text).toBe('msg-5');
    expect(history[199].text).toBe('msg-204');
  });

  it('persists conversation history through hydrate roundtrip', async () => {
    useCoachMemoryStore.getState().appendConversationMessage({
      surface: 'live-coach', role: 'coach', text: 'Persisted utterance.', trigger: 'great-move',
    });
    await __flushCoachMemoryPersistForTests();

    // Cold-start: in-memory reset, then hydrate from Dexie.
    useCoachMemoryStore.setState({
      intendedOpening: null,
      conversationHistory: [],
      preferences: { likes: [], dislikes: [], style: null },
      hintRequests: [],
      blunderPatterns: [],
      growthMap: [],
      gameHistory: [],
      hydrated: false,
    });
    await useCoachMemoryStore.getState().hydrate();

    const history = useCoachMemoryStore.getState().conversationHistory;
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('Persisted utterance.');
  });

  it('honors caller-supplied id and timestamp when provided', () => {
    const id = useCoachMemoryStore.getState().appendConversationMessage({
      id: 'custom-id-123',
      timestamp: 1_700_000_000_000,
      surface: 'live-coach',
      role: 'coach',
      text: 'pinned',
      trigger: null,
    });
    expect(id).toBe('custom-id-123');
    const stored = useCoachMemoryStore.getState().conversationHistory[0];
    expect(stored.timestamp).toBe(1_700_000_000_000);
  });
});
