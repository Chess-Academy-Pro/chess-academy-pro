import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveCoachPlayState,
  loadCoachPlayState,
  clearCoachPlayState,
  saveCoachPlayChat,
  loadCoachPlayChat,
} from './coachPlayPersistence';
import { db } from '../db/schema';
import type { ChatMessage } from '../types';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('coachPlayPersistence', () => {
  beforeEach(async () => {
    await db.table('meta').clear();
  });

  it('returns null when nothing is saved', async () => {
    expect(await loadCoachPlayState()).toBeNull();
  });

  it('round-trips a saved state', async () => {
    const state = {
      fen: STARTING_FEN,
      playerColor: 'white' as const,
      difficulty: 'medium' as const,
      subject: 'Sicilian Najdorf',
      halfMoveCount: 4,
      updatedAt: Date.now(),
    };
    await saveCoachPlayState(state);
    const loaded = await loadCoachPlayState();
    expect(loaded).toEqual(state);
  });

  it('overwrites the previous snapshot on repeat save', async () => {
    await saveCoachPlayState({
      fen: STARTING_FEN,
      playerColor: 'white',
      difficulty: 'easy',
      subject: null,
      halfMoveCount: 0,
      updatedAt: Date.now() - 1000,
    });
    const later = {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      playerColor: 'white' as const,
      difficulty: 'easy' as const,
      subject: null,
      halfMoveCount: 1,
      updatedAt: Date.now(),
    };
    await saveCoachPlayState(later);
    const loaded = await loadCoachPlayState();
    expect(loaded?.fen).toBe(later.fen);
    expect(loaded?.halfMoveCount).toBe(1);
  });

  it('clearCoachPlayState drops the snapshot', async () => {
    await saveCoachPlayState({
      fen: STARTING_FEN,
      playerColor: 'black',
      difficulty: 'hard',
      subject: null,
      halfMoveCount: 0,
      updatedAt: Date.now(),
    });
    await clearCoachPlayState();
    expect(await loadCoachPlayState()).toBeNull();
  });

  it('drops stale snapshots (> 7 days old)', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await saveCoachPlayState({
      fen: STARTING_FEN,
      playerColor: 'white',
      difficulty: 'medium',
      subject: null,
      halfMoveCount: 10,
      updatedAt: eightDaysAgo,
    });
    expect(await loadCoachPlayState()).toBeNull();
    // And the stale record should have been cleared as a side-effect.
    const record = await db.table('meta').get('coachPlayActive.v1');
    expect(record).toBeUndefined();
  });

  it('keeps fresh snapshots (< 7 days old)', async () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    await saveCoachPlayState({
      fen: STARTING_FEN,
      playerColor: 'white',
      difficulty: 'medium',
      subject: null,
      halfMoveCount: 4,
      updatedAt: oneDayAgo,
    });
    const loaded = await loadCoachPlayState();
    expect(loaded).not.toBeNull();
    expect(loaded?.halfMoveCount).toBe(4);
  });

  // ───── in-game chat transcript (regression — PR #273) ─────
  // GameChatPanel's initialMessages + onMessagesUpdate hooks existed
  // but CoachGamePage wasn't wiring them — chat was lost on every
  // reload. saveCoachPlayChat / loadCoachPlayChat wired persistence
  // via a separate meta key so corruption can't break the main
  // resume flow.

  describe('chat transcript persistence', () => {
    const sampleChat = (): ChatMessage[] => [
      { id: '1', role: 'user', content: 'what is a fork?', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'a move that hits two pieces', timestamp: 2 },
    ];

    it('returns [] when nothing is saved', async () => {
      expect(await loadCoachPlayChat()).toEqual([]);
    });

    it('round-trips a saved transcript', async () => {
      const chat = sampleChat();
      await saveCoachPlayChat(chat);
      expect(await loadCoachPlayChat()).toEqual(chat);
    });

    it('caps persisted transcript at 200 newest messages', async () => {
      const huge: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
        id: String(i),
        role: (i % 2 === 0 ? 'user' : 'assistant'),
        content: `msg ${i}`,
        timestamp: i,
      }));
      await saveCoachPlayChat(huge);
      const loaded = await loadCoachPlayChat();
      expect(loaded).toHaveLength(200);
      // First retained message should be #50 (indexed 50), since
      // we keep the newest 200.
      expect(loaded[0].content).toBe('msg 50');
      expect(loaded[199].content).toBe('msg 249');
    });

    it('clearCoachPlayState drops the chat transcript alongside the snapshot', async () => {
      await saveCoachPlayChat(sampleChat());
      await clearCoachPlayState();
      expect(await loadCoachPlayChat()).toEqual([]);
    });
  });
});
