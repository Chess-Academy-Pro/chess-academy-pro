import { describe, it, expect, vi, beforeEach } from 'vitest';
import { completeSession, updateStreak, getRecentSessions } from './sessionGenerator';
import type { UserProfile } from '../types';

const { mockSessionsPut, mockToArray, mockLimit } = vi.hoisted(() => {
  const mockToArray = vi.fn().mockResolvedValue([]);
  const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray });
  return {
    mockSessionsPut: vi.fn().mockResolvedValue(undefined),
    mockToArray,
    mockLimit,
  };
});

vi.mock('../db/schema', () => ({
  db: {
    sessions: {
      put: mockSessionsPut,
      update: vi.fn().mockResolvedValue(undefined),
      orderBy: vi.fn().mockReturnValue({
        reverse: vi.fn().mockReturnValue({
          limit: mockLimit,
        }),
      }),
    },
    profiles: {
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

function createMockProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'main',
    name: 'Test User',
    currentRating: 1200,
    peakRating: 1200,
    puzzleRating: 1200,
    level: 5,
    xp: 500,
    currentStreak: 3,
    longestStreak: 7,
    lastActiveDate: '2026-03-03',
    preferences: {
      dailySessionMinutes: 30,
      theme: 'dark',
      soundEnabled: true,
      pieceSet: 'standard',
      boardTheme: 'green',
      apiKeyEncrypted: '',
      monthlyBudgetCap: null,
      estimatedSpend: 0,
      kidMode: false,
    },
    skillRadar: {
      tactics: 60,
      openings: 50,
      endgames: 40,
      strategy: 55,
      calculation: 45,
    },
    badHabits: [],
    ...overrides,
  } as UserProfile;
}

describe('sessionGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('completeSession', () => {
    it('calculates XP correctly with accuracy bonus', async () => {
      const xp = await completeSession('session-1', {
        puzzlesSolved: 5,
        puzzleAccuracy: 0.85,
        durationMinutes: 25,
      });

      // base 50 + 5*10=50 + accuracy bonus 25 (>=80%) = 125
      expect(xp).toBe(125);
    });

    it('calculates XP with medium accuracy bonus', async () => {
      const xp = await completeSession('session-1', {
        puzzlesSolved: 3,
        puzzleAccuracy: 0.65,
        durationMinutes: 20,
      });

      // base 50 + 3*10=30 + accuracy bonus 10 (>=60%) = 90
      expect(xp).toBe(90);
    });

    it('calculates XP with no accuracy bonus', async () => {
      const xp = await completeSession('session-1', {
        puzzlesSolved: 2,
        puzzleAccuracy: 0.4,
        durationMinutes: 15,
      });

      // base 50 + 2*10=20 + 0 = 70
      expect(xp).toBe(70);
    });
  });

  describe('updateStreak', () => {
    it('returns same streak when already active today', async () => {
      const today = new Date().toISOString().split('T')[0];
      const profile = createMockProfile({ lastActiveDate: today, currentStreak: 5, longestStreak: 10 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(5);
      expect(result.longestStreak).toBe(10);
    });

    it('increments streak when last active yesterday', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const profile = createMockProfile({ lastActiveDate: yesterdayStr, currentStreak: 5, longestStreak: 10 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(6);
      expect(result.longestStreak).toBe(10);
    });

    it('resets streak when gap is more than one day', async () => {
      const profile = createMockProfile({ lastActiveDate: '2026-02-01', currentStreak: 5, longestStreak: 10 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(1);
    });

    it('updates longest streak when current exceeds it', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const profile = createMockProfile({ lastActiveDate: yesterdayStr, currentStreak: 10, longestStreak: 10 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(11);
      expect(result.longestStreak).toBe(11);
    });

    it('resets streak to 1 when lastActiveDate is null (new user)', async () => {
      const profile = createMockProfile({ lastActiveDate: null as unknown as string, currentStreak: 0, longestStreak: 0 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(1);
      expect(result.longestStreak).toBe(1);
    });

    it('transitions streak from 0 to 1 on first day of activity', async () => {
      const profile = createMockProfile({ lastActiveDate: '2025-01-01', currentStreak: 0, longestStreak: 0 });

      const result = await updateStreak(profile);
      // Gap > 1 day so streak resets to 1
      expect(result.currentStreak).toBe(1);
      expect(result.longestStreak).toBe(1);
    });

    it('updates longest streak at exact boundary (current overtakes longest)', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      // currentStreak is 4, longestStreak is 4 — after increment currentStreak becomes 5
      const profile = createMockProfile({ lastActiveDate: yesterdayStr, currentStreak: 4, longestStreak: 4 });

      const result = await updateStreak(profile);
      expect(result.currentStreak).toBe(5);
      expect(result.longestStreak).toBe(5);
    });
  });

  describe('getRecentSessions', () => {
    it('returns sessions sorted by date descending with limit applied', async () => {
      const sessions = Array.from({ length: 10 }, (_, i) => ({
        id: `session-${i}`,
        date: `2026-03-${String(i + 1).padStart(2, '0')}`,
        profileId: 'main',
        durationMinutes: 30,
        plan: { blocks: [], totalMinutes: 30 },
        completed: true,
        puzzlesSolved: i,
        puzzleAccuracy: 0.8,
        xpEarned: 50,
        coachSummary: null,
      }));

      const sortedDesc = [...sessions].sort((a, b) => b.date.localeCompare(a.date));
      const limited = sortedDesc.slice(0, 5);
      mockToArray.mockResolvedValueOnce(limited);

      const result = await getRecentSessions(5);

      expect(result).toHaveLength(5);
      expect(mockLimit).toHaveBeenCalledWith(5);
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].date >= result[i + 1].date).toBe(true);
      }
    });

    it('defaults to limit of 7 when no limit provided', async () => {
      mockToArray.mockResolvedValueOnce([]);

      await getRecentSessions();

      expect(mockLimit).toHaveBeenCalledWith(7);
    });

    it('returns empty array when no sessions exist', async () => {
      mockToArray.mockResolvedValueOnce([]);

      const result = await getRecentSessions(5);

      expect(result).toHaveLength(0);
    });
  });
});
