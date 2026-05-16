import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/schema';
import {
  isDatabaseSeeded,
  seedDatabase,
  loadEcoData,
  loadRepertoireData,
  computePosition,
  reconcileProRepertoires,
} from './dataLoader';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock chess.js to avoid heavy chess computation in unit tests.
// We just need to verify the data loader logic, not FEN accuracy.
vi.mock('chess.js', () => {
  class Chess {
    private _fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    move(san: string): { from: string; to: string; promotion: string | undefined } {
      // Return a fake Move object — from/to derived from first two chars of SAN
      const from = san.length >= 2 ? san[0] + san[1] : 'a1';
      const to = san.length >= 4 ? san[2] + san[3] : 'a2';
      this._fen = `mock-fen-after-${san}`;
      return { from, to, promotion: undefined };
    }
    fen(): string {
      return this._fen;
    }
  }
  return { Chess };
});

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('computePosition', () => {
  it('returns fen and uci for a valid pgn', () => {
    const result = computePosition('e4 e5 Nc3');
    expect(result.fen).toBeTruthy();
    expect(result.uci).toBeTruthy();
    // UCI should have moves joined by spaces
    expect(result.uci.split(' ')).toHaveLength(3);
  });

  it('handles empty pgn gracefully', () => {
    const result = computePosition('');
    expect(result.fen).toBeTruthy();
    expect(result.uci).toBe('');
  });

  it('handles single move pgn', () => {
    const result = computePosition('e4');
    expect(result.uci.split(' ')).toHaveLength(1);
  });
});

describe('isDatabaseSeeded', () => {
  it('returns false for an empty database', async () => {
    const seeded = await isDatabaseSeeded();
    expect(seeded).toBe(false);
  });

  it('returns true after seeding', async () => {
    await db.meta.put({ key: 'db_seeded_v12', value: 'true' });
    const seeded = await isDatabaseSeeded();
    expect(seeded).toBe(true);
  });
});

describe('loadEcoData', () => {
  it('loads ECO data into the openings table', async () => {
    await loadEcoData();
    const count = await db.openings.count();
    // Lichess chess-openings database has ~3,641 entries
    expect(count).toBeGreaterThan(3000);
  }, 30000);

  it('marks all loaded ECO entries as isRepertoire: false', async () => {
    await loadEcoData();
    const all = await db.openings.toArray();
    const nonRepertoire = all.filter((o) => !o.isRepertoire);
    expect(nonRepertoire.length).toBe(all.length);
  }, 30000);

  it('each entry has a non-empty eco code', async () => {
    await loadEcoData();
    const all = await db.openings.toArray();
    for (const opening of all) {
      expect(opening.eco).toBeTruthy();
    }
  }, 30000);

  it('is idempotent — second run does not duplicate records', async () => {
    await loadEcoData();
    const countFirst = await db.openings.count();
    await loadEcoData();
    const countSecond = await db.openings.count();
    expect(countSecond).toBe(countFirst);
  }, 300000);
});

describe('loadRepertoireData', () => {
  it('loads repertoire data into the openings table', async () => {
    await loadRepertoireData();
    const count = await db.openings.count();
    expect(count).toBeGreaterThan(0);
  }, 30000);

  it('marks all repertoire entries as isRepertoire: true', async () => {
    await loadRepertoireData();
    const all = await db.openings.toArray();
    const repertoire = all.filter((o) => o.isRepertoire);
    expect(repertoire.length).toBe(all.length);
  }, 30000);

  it('loads exactly 40 repertoire openings', async () => {
    await loadRepertoireData();
    const count = await db.openings.count();
    expect(count).toBe(40);
  }, 30000);

  it('each repertoire opening has overview and keyIdeas', async () => {
    await loadRepertoireData();
    const all = await db.openings.toArray();
    for (const opening of all) {
      expect(opening.overview).toBeTruthy();
      expect(opening.keyIdeas?.length).toBeGreaterThan(0);
    }
  }, 30000);

  it('includes both white and black openings', async () => {
    await loadRepertoireData();
    const whites = await db.openings.where('color').equals('white').toArray();
    const blacks = await db.openings.where('color').equals('black').toArray();
    expect(whites.length).toBe(15);
    expect(blacks.length).toBe(25);
  }, 30000);

  it('is idempotent — second run does not duplicate records', async () => {
    await loadRepertoireData();
    const countFirst = await db.openings.count();
    await loadRepertoireData();
    const countSecond = await db.openings.count();
    expect(countSecond).toBe(countFirst);
  }, 30000);
});

describe('seedDatabase', () => {
  it('seeds the database and marks it as seeded', async () => {
    await seedDatabase();
    const seeded = await isDatabaseSeeded();
    expect(seeded).toBe(true);
  }, 60000);

  it('second call is a no-op (does not double-seed)', async () => {
    await seedDatabase();
    const countAfterFirst = await db.openings.count();
    await seedDatabase();
    const countAfterSecond = await db.openings.count();
    expect(countAfterSecond).toBe(countAfterFirst);
  }, 60000);

  it('seeds both ECO and repertoire data', async () => {
    await seedDatabase();
    const total = await db.openings.count();
    // Lichess entries (~3,641) + repertoire entries (40, some overlap via bulkPut)
    expect(total).toBeGreaterThan(3000);
  }, 60000);

  it('generates flashcards for repertoire openings', async () => {
    await seedDatabase();
    const flashcardCount = await db.flashcards.count();
    expect(flashcardCount).toBeGreaterThan(0);
  }, 60000);
});

describe('reconcileProRepertoires — pick up JSON updates without wiping progress', () => {
  it('preserves user-progress fields when refreshing static content', async () => {
    await seedDatabase();
    // Pick a pro opening that should exist in the seeded data.
    const id = 'pro-firouzja-ruy-lopez';
    const before = await db.openings.get(id);
    expect(before).toBeDefined();
    if (!before) return;

    // Simulate the user having drilled this opening + marked it as
    // a personal repertoire + favorite. Plus woodpecker reps.
    await db.openings.put({
      ...before,
      isRepertoire: true,
      isFavorite: true,
      drillAccuracy: 0.85,
      drillAttempts: 17,
      lastStudied: '2026-05-15T10:00:00Z',
      woodpeckerReps: 3,
      woodpeckerSpeed: 42,
      woodpeckerLastDate: '2026-05-15',
    });

    // Force a reconcile run by clearing the revision-key meta.
    await db.meta.delete('pro_data_revision');
    await reconcileProRepertoires();

    const after = await db.openings.get(id);
    expect(after).toBeDefined();
    if (!after) return;

    // User-progress fields preserved.
    expect(after.isRepertoire).toBe(true);
    expect(after.isFavorite).toBe(true);
    expect(after.drillAccuracy).toBe(0.85);
    expect(after.drillAttempts).toBe(17);
    expect(after.lastStudied).toBe('2026-05-15T10:00:00Z');
    expect(after.woodpeckerReps).toBe(3);
    expect(after.woodpeckerSpeed).toBe(42);
    expect(after.woodpeckerLastDate).toBe('2026-05-15');

    // Static content fields refreshed (still present, not nulled).
    expect(after.name).toBe(before.name);
    expect(after.trapLines).toBeTruthy();
    expect(after.trapLines!.length).toBeGreaterThan(0);
  }, 60000);

  it('inserts brand-new pro entries with default progress fields', async () => {
    await seedDatabase();
    // Wipe a known pro entry to simulate it being added in this revision.
    const id = 'pro-firouzja-ruy-lopez';
    await db.openings.delete(id);
    expect(await db.openings.get(id)).toBeUndefined();

    // Force reconcile.
    await db.meta.delete('pro_data_revision');
    await reconcileProRepertoires();

    const after = await db.openings.get(id);
    expect(after).toBeDefined();
    if (!after) return;
    expect(after.drillAccuracy).toBe(0);
    expect(after.drillAttempts).toBe(0);
    expect(after.isFavorite).toBe(false);
    expect(after.isRepertoire).toBe(false);
  }, 60000);

  it('is a no-op when revision matches (no Dexie writes)', async () => {
    await seedDatabase();
    const before = await db.openings.get('pro-firouzja-ruy-lopez');
    expect(before).toBeDefined();
    if (!before) return;

    // Mark this opening to detect whether reconcile rewrote it. The
    // marker is in a static field that reconcile WOULD overwrite if
    // it ran — so an unchanged value proves no-op behavior.
    await db.openings.put({ ...before, style: 'TEST-MARKER-DO-NOT-OVERWRITE' });

    // Second call — revision is current, should no-op.
    await reconcileProRepertoires();

    const after = await db.openings.get('pro-firouzja-ruy-lopez');
    expect(after?.style).toBe('TEST-MARKER-DO-NOT-OVERWRITE');
  }, 60000);
});
