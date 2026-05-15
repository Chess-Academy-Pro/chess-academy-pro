import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './schema';

// fake-indexeddb is auto-loaded via vitest setup
// Each test gets a fresh in-memory database

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('Database Schema', () => {
  it('opens without errors', () => {
    expect(db.isOpen()).toBe(true);
  });

  it('has the correct schema version', () => {
    expect(db.verno).toBe(25);
  });

  it('has srsOpeningCards table', () => {
    expect(db.tables.map((t) => t.name)).toContain('srsOpeningCards');
  });

  it('has puzzles table', () => {
    expect(db.tables.map((t) => t.name)).toContain('puzzles');
  });

  it('has openings table', () => {
    expect(db.tables.map((t) => t.name)).toContain('openings');
  });

  it('has games table', () => {
    expect(db.tables.map((t) => t.name)).toContain('games');
  });

  it('has flashcards table', () => {
    expect(db.tables.map((t) => t.name)).toContain('flashcards');
  });

  it('has profiles table', () => {
    expect(db.tables.map((t) => t.name)).toContain('profiles');
  });

  it('has sessions table', () => {
    expect(db.tables.map((t) => t.name)).toContain('sessions');
  });

  it('has meta table', () => {
    expect(db.tables.map((t) => t.name)).toContain('meta');
  });

  it('has classifiedTactics table', () => {
    expect(db.tables.map((t) => t.name)).toContain('classifiedTactics');
  });

  it('can write and read from meta table', async () => {
    await db.meta.put({ key: 'test', value: 'hello' });
    const record = await db.meta.get('test');
    expect(record?.value).toBe('hello');
  });
});

describe('Database Index Queries', () => {
  it('queries puzzles by rating index', async () => {
    await db.puzzles.bulkPut([
      { id: 'p1', fen: '', moves: '', rating: 800, themes: ['fork'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 800, attempts: 0, successes: 0 },
      { id: 'p2', fen: '', moves: '', rating: 1200, themes: ['pin'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1200, attempts: 0, successes: 0 },
      { id: 'p3', fen: '', moves: '', rating: 1600, themes: ['skewer'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1600, attempts: 0, successes: 0 },
    ]);

    const easyPuzzles = await db.puzzles.where('rating').below(1000).toArray();
    expect(easyPuzzles).toHaveLength(1);
    expect(easyPuzzles[0].id).toBe('p1');

    const mediumPuzzles = await db.puzzles.where('rating').between(1000, 1500).toArray();
    expect(mediumPuzzles).toHaveLength(1);
    expect(mediumPuzzles[0].id).toBe('p2');
  });

  it('queries puzzles by multi-valued themes index', async () => {
    await db.puzzles.bulkPut([
      { id: 'p1', fen: '', moves: '', rating: 1000, themes: ['fork', 'pin'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1000, attempts: 0, successes: 0 },
      { id: 'p2', fen: '', moves: '', rating: 1200, themes: ['skewer'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1200, attempts: 0, successes: 0 },
      { id: 'p3', fen: '', moves: '', rating: 1400, themes: ['fork', 'discoveredAttack'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1400, attempts: 0, successes: 0 },
    ]);

    const forkPuzzles = await db.puzzles.where('themes').equals('fork').toArray();
    expect(forkPuzzles).toHaveLength(2);
    expect(forkPuzzles.map(p => p.id).sort()).toEqual(['p1', 'p3']);
  });

  it('queries puzzles by srsDueDate index', async () => {
    await db.puzzles.bulkPut([
      { id: 'p1', fen: '', moves: '', rating: 1000, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1000, attempts: 0, successes: 0 },
      { id: 'p2', fen: '', moves: '', rating: 1200, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-06-15', srsLastReview: null, userRating: 1200, attempts: 0, successes: 0 },
      { id: 'p3', fen: '', moves: '', rating: 1400, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-12-31', srsLastReview: null, userRating: 1400, attempts: 0, successes: 0 },
    ]);

    const dueBefore = await db.puzzles.where('srsDueDate').belowOrEqual('2024-06-15').toArray();
    expect(dueBefore).toHaveLength(2);
  });

  it('queries openings by eco index', async () => {
    await db.openings.bulkPut([
      { id: 'o1', eco: 'B20', name: 'Sicilian', pgn: '', uci: '', fen: '', color: 'black', style: '', isRepertoire: true, overview: '', keyIdeas: [], traps: [], warnings: [], variations: null, drillAccuracy: 0, drillAttempts: 0, lastStudied: null, woodpeckerReps: 0, woodpeckerSpeed: null, woodpeckerLastDate: null, isFavorite: false },
      { id: 'o2', eco: 'C50', name: 'Italian', pgn: '', uci: '', fen: '', color: 'white', style: '', isRepertoire: true, overview: '', keyIdeas: [], traps: [], warnings: [], variations: null, drillAccuracy: 0, drillAttempts: 0, lastStudied: null, woodpeckerReps: 0, woodpeckerSpeed: null, woodpeckerLastDate: null, isFavorite: false },
      { id: 'o3', eco: 'B90', name: 'Najdorf', pgn: '', uci: '', fen: '', color: 'black', style: '', isRepertoire: false, overview: '', keyIdeas: [], traps: [], warnings: [], variations: null, drillAccuracy: 0, drillAttempts: 0, lastStudied: null, woodpeckerReps: 0, woodpeckerSpeed: null, woodpeckerLastDate: null, isFavorite: false },
    ]);

    const bOpenings = await db.openings.where('eco').between('B00', 'B99\uffff').toArray();
    expect(bOpenings).toHaveLength(2);
  });

  it('queries openings by color index', async () => {
    await db.openings.bulkPut([
      { id: 'o1', eco: 'B20', name: 'Sicilian', pgn: '', uci: '', fen: '', color: 'black', style: '', isRepertoire: true, overview: '', keyIdeas: [], traps: [], warnings: [], variations: null, drillAccuracy: 0, drillAttempts: 0, lastStudied: null, woodpeckerReps: 0, woodpeckerSpeed: null, woodpeckerLastDate: null, isFavorite: false },
      { id: 'o2', eco: 'C50', name: 'Italian', pgn: '', uci: '', fen: '', color: 'white', style: '', isRepertoire: true, overview: '', keyIdeas: [], traps: [], warnings: [], variations: null, drillAccuracy: 0, drillAttempts: 0, lastStudied: null, woodpeckerReps: 0, woodpeckerSpeed: null, woodpeckerLastDate: null, isFavorite: false },
    ]);

    const whiteOpenings = await db.openings.where('color').equals('white').toArray();
    expect(whiteOpenings).toHaveLength(1);
    expect(whiteOpenings[0].name).toBe('Italian');
  });

  it('queries flashcards by openingId index', async () => {
    await db.flashcards.bulkPut([
      { id: 'f1', openingId: 'sicilian', type: 'best_move', questionFen: '', questionText: 'Q1', answerMove: null, answerText: 'A1', srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null },
      { id: 'f2', openingId: 'sicilian', type: 'explain_idea', questionFen: '', questionText: 'Q2', answerMove: null, answerText: 'A2', srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null },
      { id: 'f3', openingId: 'italian', type: 'best_move', questionFen: '', questionText: 'Q3', answerMove: null, answerText: 'A3', srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null },
    ]);

    const sicilianCards = await db.flashcards.where('openingId').equals('sicilian').toArray();
    expect(sicilianCards).toHaveLength(2);
  });

  it('queries flashcards by srsDueDate index', async () => {
    await db.flashcards.bulkPut([
      { id: 'f1', openingId: 'o1', type: 'best_move', questionFen: '', questionText: '', answerMove: null, answerText: '', srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null },
      { id: 'f2', openingId: 'o1', type: 'best_move', questionFen: '', questionText: '', answerMove: null, answerText: '', srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2025-06-01', srsLastReview: null },
    ]);

    const due = await db.flashcards.where('srsDueDate').belowOrEqual('2024-12-31').toArray();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('f1');
  });

  it('queries games by source index', async () => {
    await db.games.bulkPut([
      { id: 'g1', pgn: '', white: 'A', black: 'B', result: '1-0', date: '2024-01-01', event: '', eco: 'C50', whiteElo: 1500, blackElo: 1400, source: 'lichess', annotations: null, coachAnalysis: null, isMasterGame: false, openingId: null },
      { id: 'g2', pgn: '', white: 'C', black: 'D', result: '0-1', date: '2024-01-02', event: '', eco: 'B20', whiteElo: 1600, blackElo: 1500, source: 'chesscom', annotations: null, coachAnalysis: null, isMasterGame: false, openingId: null },
      { id: 'g3', pgn: '', white: 'E', black: 'F', result: '1/2-1/2', date: '2024-01-03', event: '', eco: 'A00', whiteElo: 2500, blackElo: 2400, source: 'lichess', annotations: null, coachAnalysis: null, isMasterGame: true, openingId: null },
    ]);

    const lichessGames = await db.games.where('source').equals('lichess').toArray();
    expect(lichessGames).toHaveLength(2);
  });

  it('queries sessions by date index', async () => {
    await db.sessions.bulkPut([
      { id: 's1', date: '2024-01-15', profileId: 'main', durationMinutes: 30, plan: { blocks: [], totalMinutes: 30 }, completed: true, puzzlesSolved: 5, puzzleAccuracy: 80, xpEarned: 100, coachSummary: null },
      { id: 's2', date: '2024-02-01', profileId: 'main', durationMinutes: 45, plan: { blocks: [], totalMinutes: 45 }, completed: true, puzzlesSolved: 8, puzzleAccuracy: 90, xpEarned: 150, coachSummary: null },
    ]);

    const sorted = await db.sessions.orderBy('date').toArray();
    expect(sorted[0].date).toBe('2024-01-15');
    expect(sorted[1].date).toBe('2024-02-01');
  });
});

describe('Database Bulk Operations', () => {
  it('bulkPut overwrites existing records', async () => {
    await db.puzzles.put({ id: 'bp1', fen: '', moves: '', rating: 1000, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1000, attempts: 0, successes: 0 });
    await db.puzzles.bulkPut([
      { id: 'bp1', fen: 'updated', moves: '', rating: 1500, themes: ['pin'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1500, attempts: 0, successes: 0 },
    ]);

    const result = await db.puzzles.get('bp1');
    expect(result?.rating).toBe(1500);
    expect(result?.fen).toBe('updated');
    expect(await db.puzzles.count()).toBe(1);
  });

  it('bulkAdd multiple records atomically', async () => {
    await db.games.bulkAdd([
      { id: 'ba1', pgn: '', white: 'A', black: 'B', result: '1-0', date: '2024-01-01', event: '', eco: '', whiteElo: 1500, blackElo: 1400, source: 'lichess', annotations: null, coachAnalysis: null, isMasterGame: false, openingId: null },
      { id: 'ba2', pgn: '', white: 'C', black: 'D', result: '0-1', date: '2024-01-02', event: '', eco: '', whiteElo: 1600, blackElo: 1500, source: 'lichess', annotations: null, coachAnalysis: null, isMasterGame: false, openingId: null },
      { id: 'ba3', pgn: '', white: 'E', black: 'F', result: '1/2-1/2', date: '2024-01-03', event: '', eco: '', whiteElo: 1700, blackElo: 1600, source: 'chesscom', annotations: null, coachAnalysis: null, isMasterGame: false, openingId: null },
    ]);

    expect(await db.games.count()).toBe(3);
  });

  it('delete removes a record', async () => {
    await db.meta.put({ key: 'deleteMe', value: 'temp' });
    expect(await db.meta.get('deleteMe')).toBeDefined();

    await db.meta.delete('deleteMe');
    expect(await db.meta.get('deleteMe')).toBeUndefined();
  });

  it('clear removes all records from a table', async () => {
    await db.meta.bulkPut([
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
    ]);
    expect(await db.meta.count()).toBe(2);

    await db.meta.clear();
    expect(await db.meta.count()).toBe(0);
  });

  it('count returns correct number of records', async () => {
    expect(await db.puzzles.count()).toBe(0);

    await db.puzzles.bulkPut([
      { id: 'c1', fen: '', moves: '', rating: 1000, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1000, attempts: 0, successes: 0 },
      { id: 'c2', fen: '', moves: '', rating: 1200, themes: [], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1200, attempts: 0, successes: 0 },
    ]);

    expect(await db.puzzles.count()).toBe(2);
  });

  it('toCollection modify updates matching records', async () => {
    await db.puzzles.bulkPut([
      { id: 'mod1', fen: '', moves: '', rating: 1000, themes: ['fork'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1000, attempts: 0, successes: 0 },
      { id: 'mod2', fen: '', moves: '', rating: 1200, themes: ['pin'], openingTags: null, popularity: 0, nbPlays: 0, srsInterval: 0, srsEaseFactor: 2.5, srsRepetitions: 0, srsDueDate: '2024-01-01', srsLastReview: null, userRating: 1200, attempts: 0, successes: 0 },
    ]);

    await db.puzzles.toCollection().modify({ srsDueDate: '2025-01-01' });

    const all = await db.puzzles.toArray();
    expect(all.every(p => p.srsDueDate === '2025-01-01')).toBe(true);
  });
});
