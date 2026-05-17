import { db } from '../db/schema';
import { createDefaultSrsFields } from './srsEngine';
import { DEFAULT_THEME_ID } from './themeService';
import type { UserProfile, PuzzleRecord, OpeningRecord, SessionRecord, FlashcardRecord } from '../types';

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getOrCreateMainProfile(): Promise<UserProfile> {
  const defaultProfile: UserProfile = {
    id: 'main',
    name: 'Player',
    isKidMode: false,
    currentRating: 1420,
    puzzleRating: 1400,
    xp: 0,
    level: 1,
    currentStreak: 0,
    longestStreak: 0,
    streakFreezes: 1,
    lastActiveDate: new Date().toISOString().split('T')[0],
    skillRadar: {
      opening: 50,
      tactics: 50,
      endgame: 50,
      memory: 50,
      calculation: 50,
    },
    badHabits: [],
    preferences: {
      theme: DEFAULT_THEME_ID,
      boardColor: 'classic',
      pieceSet: 'staunton',
      showEvalBar: true,
      showEngineLines: false,
      soundEnabled: true,
      voiceEnabled: true,
      dailySessionMinutes: 45,
      aiProvider: 'deepseek',
      apiKeyEncrypted: null,
      apiKeyIv: null,
      anthropicApiKeyEncrypted: null,
      anthropicApiKeyIv: null,
      preferredModel: {
        commentary: 'deepseek-chat',
        analysis: 'deepseek-reasoner',
        reports: 'deepseek-reasoner',
      },
      monthlyBudgetCap: null,
      estimatedSpend: 0,
      elevenlabsKeyEncrypted: null,
      elevenlabsKeyIv: null,
      elevenlabsVoiceId: null,
      pollyEnabled: true,
      pollyVoice: 'ruth',
      voiceSpeed: 1.0,
      kokoroEnabled: true,
      kokoroVoiceId: 'af_bella',
      systemVoiceURI: null,
      highlightLastMove: true,
      showLegalMoves: true,
      showCoordinates: true,
      pieceAnimationSpeed: 'medium' as const,
      boardOrientation: true,
      moveQualityFlash: false,
      showHints: true,
      moveMethod: 'both' as const,
      moveConfirmation: false,
      autoPromoteQueen: true,
      masterAllOff: false,
    },
  };

  // Atomic upsert: StrictMode double-invokes the init effect in dev,
  // and audit-stream caught both invocations racing on db.profiles.add('main')
  // → ConstraintError. Wrapping in a 'rw' transaction serializes the
  // get/add against the same store, so the second caller sees the
  // first caller's row and returns it.
  return db.transaction('rw', db.profiles, async () => {
    const existing = await db.profiles.get('main');
    if (existing) return existing;
    await db.profiles.add(defaultProfile);
    return defaultProfile;
  });
}

export async function updateProfile(
  id: string,
  updates: Partial<UserProfile>,
): Promise<void> {
  await db.profiles.update(id, updates);
}

// ─── Puzzles ──────────────────────────────────────────────────────────────────

export async function getDuePuzzles(limit: number = 20): Promise<PuzzleRecord[]> {
  const today = new Date().toISOString().split('T')[0];
  return db.puzzles
    .where('srsDueDate')
    .belowOrEqual(today)
    .limit(limit)
    .toArray();
}

export async function updatePuzzleSrs(
  id: string,
  srsData: Pick<PuzzleRecord, 'srsInterval' | 'srsEaseFactor' | 'srsRepetitions' | 'srsDueDate' | 'srsLastReview'>,
): Promise<void> {
  await db.puzzles.update(id, srsData);
}

export async function recordPuzzleAttempt(
  id: string,
  correct: boolean,
): Promise<void> {
  const puzzle = await db.puzzles.get(id);
  if (!puzzle) return;

  await db.puzzles.update(id, {
    attempts: puzzle.attempts + 1,
    successes: correct ? puzzle.successes + 1 : puzzle.successes,
  });
}

// ─── Openings ─────────────────────────────────────────────────────────────────

export async function getRepertoireOpenings(): Promise<OpeningRecord[]> {
  return db.openings.filter((o) => o.isRepertoire).toArray();
}

export async function getOpeningById(id: string): Promise<OpeningRecord | undefined> {
  return db.openings.get(id);
}

export async function updateOpeningProgress(
  id: string,
  accuracy: number,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;

  await db.openings.update(id, {
    drillAttempts: opening.drillAttempts + 1,
    drillAccuracy: (opening.drillAccuracy * opening.drillAttempts + accuracy) / (opening.drillAttempts + 1),
    lastStudied: new Date().toISOString(),
  });
}

// ─── Flashcards ───────────────────────────────────────────────────────────────

export async function getDueFlashcards(limit: number = 20): Promise<FlashcardRecord[]> {
  const today = new Date().toISOString().split('T')[0];
  return db.flashcards
    .where('srsDueDate')
    .belowOrEqual(today)
    .limit(limit)
    .toArray();
}

export async function updateFlashcardSrs(
  id: string,
  srsData: Pick<FlashcardRecord, 'srsInterval' | 'srsEaseFactor' | 'srsRepetitions' | 'srsDueDate' | 'srsLastReview'>,
): Promise<void> {
  await db.flashcards.update(id, srsData);
}

export async function generateFlashcardsForOpening(
  openingId: string,
): Promise<void> {
  const opening = await db.openings.get(openingId);
  if (!opening?.variations) return;

  const existing = await db.flashcards.where('openingId').equals(openingId).count();
  if (existing > 0) return; // Already generated

  const srsDefaults = createDefaultSrsFields();
  const cards: FlashcardRecord[] = opening.variations.map((variation, i) => ({
    id: `${openingId}-card-${i}`,
    openingId,
    type: 'best_move' as const,
    questionFen: opening.fen,
    questionText: `What is the key idea in the ${variation.name}?`,
    answerMove: null,
    answerText: variation.explanation,
    srsInterval: srsDefaults.interval,
    srsEaseFactor: srsDefaults.easeFactor,
    srsRepetitions: srsDefaults.repetitions,
    srsDueDate: srsDefaults.dueDate,
    srsLastReview: null,
  }));

  // WO-REAL-FIXES — bulkPut (upsert) instead of bulkAdd. Card ids are
  // deterministic (`${openingId}-card-${i}`), so a re-run of this
  // seeder collides on every existing row. Production audit Findings
  // 178 (cycle 6) + 252 (cycle 1) caught the resulting unhandled
  // ConstraintError. bulkPut makes re-seeding a no-op upsert.
  await db.flashcards.bulkPut(cards);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(session: SessionRecord): Promise<void> {
  await db.sessions.add(session);
}

export async function updateSession(
  id: string,
  updates: Partial<SessionRecord>,
): Promise<void> {
  await db.sessions.update(id, updates);
}

export async function getRecentSessions(limit: number = 30): Promise<SessionRecord[]> {
  return db.sessions
    .orderBy('date')
    .reverse()
    .limit(limit)
    .toArray();
}

// ─── Export / Import ──────────────────────────────────────────────────────────

export async function exportUserData(): Promise<string> {
  const [
    profiles,
    sessions,
    openings,
    flashcards,
    games,
    mistakePuzzles,
    classifiedTactics,
    setupPuzzles,
    openingWeakSpots,
    meta,
  ] = await Promise.all([
    db.profiles.toArray(),
    db.sessions.toArray(),
    // Repertoire openings only — keeps the export tractable for the
    // 3k+ row Lichess catalog. PR-4 adds `isFavorite` as a parallel
    // filter so favorited NON-repertoire openings also sync (the
    // rolodex reads the favorite flag, not isRepertoire).
    db.openings.filter((o) => o.isRepertoire || o.isFavorite).toArray(),
    db.flashcards.toArray(),
    db.games.toArray(),
    db.mistakePuzzles.toArray(),
    db.classifiedTactics.toArray(),
    db.setupPuzzles.toArray(),
    db.openingWeakSpots.toArray(),
    // WO-ROLODEX-UI-01 PR-4: include the meta key-value blob so
    // coachMemoryStore state (intendedOpening, savedPosition, the
    // rolodex's activeOpeningCardId / lastActiveRolodexColor /
    // favoritedAt / userOrderedFavorites, etc.) syncs across
    // devices via pushToCloud → Supabase. Previously stranded.
    db.meta.toArray(),
  ]);

  return JSON.stringify(
    {
      profiles,
      sessions,
      openings,
      flashcards,
      games,
      mistakePuzzles,
      classifiedTactics,
      setupPuzzles,
      openingWeakSpots,
      meta,
    },
    null,
    2,
  );
}
