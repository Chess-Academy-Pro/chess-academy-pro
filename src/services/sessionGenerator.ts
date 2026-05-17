import { db } from '../db/schema';
import type { SessionRecord, UserProfile } from '../types';

// WO-ROLODEX-UI-01 PR-1 deleted the LLM-driven session-plan
// generation path (`generateDailySession`, `createSession`,
// `generateCoachSession`) when the rolodex took over `/coach/plan`.
// Streak tracking still feeds Dashboard; `completeSession` /
// `getRecentSessions` were already unused at PR-1 time but stay
// pending a separate dead-code sweep.

export async function completeSession(
  sessionId: string,
  stats: { puzzlesSolved: number; puzzleAccuracy: number; durationMinutes: number },
): Promise<number> {
  // Calculate XP: base 50 + 10 per puzzle + accuracy bonus
  const baseXp = 50;
  const puzzleXp = stats.puzzlesSolved * 10;
  const accuracyBonus = stats.puzzleAccuracy >= 0.8 ? 25 : stats.puzzleAccuracy >= 0.6 ? 10 : 0;
  const totalXp = baseXp + puzzleXp + accuracyBonus;

  await db.sessions.update(sessionId, {
    completed: true,
    durationMinutes: stats.durationMinutes,
    puzzlesSolved: stats.puzzlesSolved,
    puzzleAccuracy: stats.puzzleAccuracy,
    xpEarned: totalXp,
  });

  return totalXp;
}

export async function updateStreak(profile: UserProfile): Promise<{
  currentStreak: number;
  longestStreak: number;
}> {
  const today = new Date().toISOString().split('T')[0];
  const lastActive = profile.lastActiveDate;

  let currentStreak = profile.currentStreak;

  if (lastActive === today) {
    // Already active today
    return { currentStreak, longestStreak: profile.longestStreak };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (lastActive === yesterdayStr) {
    currentStreak += 1;
  } else {
    currentStreak = 1;
  }

  const longestStreak = Math.max(currentStreak, profile.longestStreak);

  await db.profiles.update(profile.id, {
    currentStreak,
    longestStreak,
    lastActiveDate: today,
  });

  return { currentStreak, longestStreak };
}

export async function getRecentSessions(limit: number = 7): Promise<SessionRecord[]> {
  return db.sessions
    .orderBy('date')
    .reverse()
    .limit(limit)
    .toArray();
}
