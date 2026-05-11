/**
 * endgameProgressService tests — verifies mastery is sticky,
 * play counts accumulate, and the lesson aggregation query
 * returns the right records.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/schema';
import {
  getLessonProgress,
  getMasteredCount,
  getProgress,
  progressIdFor,
  recordPlay,
  resetLessonProgress,
} from './endgameProgressService';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('endgameProgressService', () => {
  it('progressIdFor composes the id deterministically', () => {
    expect(progressIdFor('opposition', 'fen-string')).toBe('opposition::fen-string');
  });

  it('getProgress returns null before any record is written', async () => {
    expect(await getProgress('opposition', 'fen-1')).toBeNull();
  });

  it('recordPlay creates a record marked as mastered on first-try-perfect', async () => {
    const rec = await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    expect(rec.mastered).toBe(true);
    expect(rec.timesPlayed).toBe(1);
    expect(rec.totalWrongAttempts).toBe(0);

    const fetched = await getProgress('opposition', 'fen-1');
    expect(fetched?.mastered).toBe(true);
  });

  it('recordPlay creates a NOT-mastered record on imperfect first play', async () => {
    const rec = await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: false,
      wrongAttempts: 3,
    });
    expect(rec.mastered).toBe(false);
    expect(rec.totalWrongAttempts).toBe(3);
  });

  it('a later perfect play upgrades the record to mastered', async () => {
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: false,
      wrongAttempts: 2,
    });
    const second = await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    expect(second.mastered).toBe(true);
    expect(second.timesPlayed).toBe(2);
    expect(second.totalWrongAttempts).toBe(2);
  });

  it('mastery is sticky — a later imperfect play does NOT unset mastered', async () => {
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    const second = await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: false,
      wrongAttempts: 1,
    });
    expect(second.mastered).toBe(true);
    expect(second.timesPlayed).toBe(2);
  });

  it('getLessonProgress returns all positions in a lesson', async () => {
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-2',
      firstTryPerfect: false,
      wrongAttempts: 1,
    });
    await recordPlay({
      lessonId: 'key-squares',
      fen: 'fen-3',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    const oppositionProgress = await getLessonProgress('opposition');
    expect(oppositionProgress).toHaveLength(2);
    expect(oppositionProgress.map((r) => r.fen).sort()).toEqual(['fen-1', 'fen-2']);
  });

  it('getMasteredCount returns the total mastered across all lessons', async () => {
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-2',
      firstTryPerfect: false,
      wrongAttempts: 1,
    });
    await recordPlay({
      lessonId: 'key-squares',
      fen: 'fen-3',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    expect(await getMasteredCount()).toBe(2);
  });

  it('resetLessonProgress wipes only the target lessons records', async () => {
    await recordPlay({
      lessonId: 'opposition',
      fen: 'fen-1',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    await recordPlay({
      lessonId: 'key-squares',
      fen: 'fen-2',
      firstTryPerfect: true,
      wrongAttempts: 0,
    });
    await resetLessonProgress('opposition');
    expect(await getLessonProgress('opposition')).toHaveLength(0);
    expect(await getLessonProgress('key-squares')).toHaveLength(1);
  });
});
