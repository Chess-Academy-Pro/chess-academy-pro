import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/schema';
import {
  applySm2,
  enrollOpening,
  generateCardsForOpening,
  getDueCards,
  getDueCount,
  getEnrolledOpenings,
  isEnrolled,
  normalizeSan,
  recordReview,
  unenrollOpening,
} from './srsOpeningService';
import type { OpeningRecord, SrsOpeningCard } from '../types';

function makeOpening(overrides: Partial<OpeningRecord> = {}): OpeningRecord {
  return {
    id: 'italian-game',
    name: 'Italian Game',
    eco: 'C50',
    color: 'white',
    pgn: 'e4 e5 Nf3 Nc6 Bc4',
    uci: '',
    fen: '',
    style: '',
    isRepertoire: true,
    overview: '',
    keyIdeas: [],
    traps: null,
    warnings: null,
    variations: null,
    drillAccuracy: 0,
    drillAttempts: 0,
    lastStudied: null,
    woodpeckerReps: 0,
    woodpeckerSpeed: null,
    woodpeckerLastDate: null,
    isFavorite: false,
    ...overrides,
  } as OpeningRecord;
}

function makeCard(overrides: Partial<SrsOpeningCard> = {}): SrsOpeningCard {
  return {
    id: 'italian-game::rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    openingId: 'italian-game',
    variationName: 'Italian Game',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expectedSan: 'e4',
    pgnPrefix: '',
    studentColor: 'white',
    ease: 2.5,
    intervalDays: 0,
    nextReviewAt: 0,
    successes: 0,
    lapses: 0,
    lastReviewedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

describe('srsOpeningService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  describe('normalizeSan', () => {
    it('strips check, mate, and decorator marks', () => {
      expect(normalizeSan('Nf3+')).toBe('Nf3');
      expect(normalizeSan('Qxf7#')).toBe('Qxf7');
      expect(normalizeSan('Bc4!')).toBe('Bc4');
      expect(normalizeSan('e4?!')).toBe('e4');
    });

    it('preserves disambiguation and promotion', () => {
      expect(normalizeSan('Nbd2')).toBe('Nbd2');
      expect(normalizeSan('e8=Q+')).toBe('e8=Q');
    });

    it('trims whitespace', () => {
      expect(normalizeSan('  e4  ')).toBe('e4');
    });
  });

  describe('generateCardsForOpening', () => {
    it('emits one card per student-to-move ply (white)', () => {
      const opening = makeOpening({
        pgn: 'e4 e5 Nf3 Nc6 Bc4',
        color: 'white',
      });
      const cards = generateCardsForOpening(opening);
      // White moves: e4, Nf3, Bc4 — three cards
      expect(cards).toHaveLength(3);
      expect(cards.map((c) => c.expectedSan)).toEqual(['e4', 'Nf3', 'Bc4']);
    });

    it('emits one card per student-to-move ply (black)', () => {
      const opening = makeOpening({
        pgn: 'e4 c5 Nf3 d6',
        color: 'black',
        name: 'Sicilian',
        id: 'sicilian',
      });
      const cards = generateCardsForOpening(opening);
      // Black moves: c5, d6 — two cards
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.expectedSan)).toEqual(['c5', 'd6']);
    });

    it('includes main line + variations', () => {
      const opening = makeOpening({
        pgn: 'e4 e5 Nf3',
        variations: [
          { name: 'Italian Main', pgn: 'e4 e5 Nf3 Nc6 Bc4', explanation: '' },
          { name: 'Italian Mainline-Deep', pgn: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3', explanation: '' },
        ],
      } as Partial<OpeningRecord>);
      const cards = generateCardsForOpening(opening);
      // Main: e4, Nf3 → 2 cards.
      // Italian Main: e4, Nf3, Bc4 — first two dedupe with main.
      // Italian Deep: e4, Nf3, Bc4 (dedupe with Italian Main), c3 — new.
      // Total unique: e4, Nf3, Bc4, c3 → 4 cards.
      expect(cards).toHaveLength(4);
      const sans = cards.map((c) => c.expectedSan).sort();
      expect(sans).toEqual(['Bc4', 'Nf3', 'c3', 'e4']);
    });

    it('dedup keeps the first variation\'s answer when two lines branch at the same position', () => {
      // Single-answer SRS: each position has one "book line." Two variations
      // that diverge at the same position can't both train at that node — the
      // first one to be extracted wins. Drilling both options requires
      // separate openings (which is the Chessable model).
      const opening = makeOpening({
        pgn: '',
        variations: [
          { name: 'Italian', pgn: 'e4 e5 Nf3 Nc6 Bc4', explanation: '' },
          { name: 'Scotch', pgn: 'e4 e5 Nf3 Nc6 d4', explanation: '' },
        ],
      } as Partial<OpeningRecord>);
      const cards = generateCardsForOpening(opening);
      // Italian goes first → Bc4 wins the divergence slot.
      const sans = cards.map((c) => c.expectedSan).sort();
      expect(sans).toContain('Bc4');
      expect(sans).not.toContain('d4');
    });

    it('dedupes transpositions via normalized FEN', () => {
      const opening = makeOpening({
        pgn: 'e4 e5 Nf3 Nc6 Bc4',
        variations: [
          // Italian via different move order — same position.
          // (chess.js plays them in sequence; the e4-then-Bc4 ordering
          // here just reuses the same card for the e4 prompt.)
          { name: 'Italian Alt Order', pgn: 'e4 e5 Bc4 Nc6 Nf3', explanation: '' },
        ],
      } as Partial<OpeningRecord>);
      const cards = generateCardsForOpening(opening);
      // The starting position (white to play e4) appears in both lines
      // → one card. The other prompts differ between move orders so
      // they're separate cards. Just assert no duplicate ids.
      const ids = cards.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('skips invalid SAN gracefully', () => {
      const opening = makeOpening({
        pgn: 'e4 e5 ZZZ',
      });
      const cards = generateCardsForOpening(opening);
      expect(cards).toHaveLength(1); // just e4 — bailed before Nf3
    });

    it('normalizes the expectedSan', () => {
      const opening = makeOpening({
        pgn: 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#',
      });
      const cards = generateCardsForOpening(opening);
      // Qxf7# is white's last move — the # should be stripped.
      const last = cards[cards.length - 1];
      expect(last.expectedSan).toBe('Qxf7');
    });

    it('returns no cards when PGN is empty', () => {
      const opening = makeOpening({ pgn: '' });
      const cards = generateCardsForOpening(opening);
      expect(cards).toHaveLength(0);
    });
  });

  describe('enrollOpening', () => {
    it('writes cards to the DB and reports added count', async () => {
      const opening = makeOpening();
      const result = await enrollOpening(opening);
      expect(result.added).toBeGreaterThan(0);
      expect(result.alreadyEnrolled).toBe(0);
      const dbCount = await db.srsOpeningCards.count();
      expect(dbCount).toBe(result.added);
    });

    it('is idempotent — re-enrolling preserves existing state', async () => {
      const opening = makeOpening();
      const first = await enrollOpening(opening);
      // Mutate one card to simulate review state on disk.
      const firstCard = await db.srsOpeningCards.toCollection().first();
      expect(firstCard).toBeDefined();
      if (!firstCard) return;
      await db.srsOpeningCards.put({
        ...firstCard,
        successes: 5,
        intervalDays: 30,
        ease: 2.7,
      });

      const second = await enrollOpening(opening);
      expect(second.added).toBe(0);
      expect(second.alreadyEnrolled).toBe(first.added);

      const preserved = await db.srsOpeningCards.get(firstCard.id);
      expect(preserved?.successes).toBe(5);
      expect(preserved?.intervalDays).toBe(30);
      expect(preserved?.ease).toBe(2.7);
    });
  });

  describe('unenrollOpening', () => {
    it('removes all cards for the opening', async () => {
      const opening = makeOpening();
      await enrollOpening(opening);
      const removed = await unenrollOpening(opening.id);
      expect(removed).toBeGreaterThan(0);
      const remaining = await db.srsOpeningCards.count();
      expect(remaining).toBe(0);
    });

    it('leaves other openings alone', async () => {
      await enrollOpening(makeOpening({ id: 'italian', name: 'Italian' }));
      await enrollOpening(makeOpening({ id: 'sicilian', name: 'Sicilian', pgn: 'e4 c5 Nf3 d6', color: 'black' }));
      const beforeOther = await db.srsOpeningCards.where('openingId').equals('sicilian').count();
      await unenrollOpening('italian');
      const afterOther = await db.srsOpeningCards.where('openingId').equals('sicilian').count();
      expect(afterOther).toBe(beforeOther);
    });
  });

  describe('isEnrolled', () => {
    it('returns false before enroll', async () => {
      expect(await isEnrolled('italian-game')).toBe(false);
    });
    it('returns true after enroll', async () => {
      await enrollOpening(makeOpening());
      expect(await isEnrolled('italian-game')).toBe(true);
    });
  });

  describe('getDueCards / getDueCount', () => {
    it('returns cards whose nextReviewAt is <= now', async () => {
      const now = Date.now();
      await db.srsOpeningCards.bulkAdd([
        makeCard({ id: 'a', nextReviewAt: now - 1000 }),
        makeCard({ id: 'b', nextReviewAt: now + 60_000 }),
      ]);
      const due = await getDueCards();
      expect(due.map((c) => c.id)).toEqual(['a']);
      expect(await getDueCount()).toBe(1);
    });

    it('respects the limit', async () => {
      const now = Date.now();
      await db.srsOpeningCards.bulkAdd(
        Array.from({ length: 50 }, (_, i) =>
          makeCard({ id: `card-${i}`, nextReviewAt: now - 1000 - i }),
        ),
      );
      const due = await getDueCards(10);
      expect(due).toHaveLength(10);
    });
  });

  describe('getEnrolledOpenings', () => {
    it('aggregates totals and due counts per opening', async () => {
      const now = Date.now();
      await db.srsOpeningCards.bulkAdd([
        makeCard({ id: 'a1', openingId: 'italian', nextReviewAt: now - 1 }),
        makeCard({ id: 'a2', openingId: 'italian', nextReviewAt: now + 60_000 }),
        makeCard({ id: 'b1', openingId: 'sicilian', nextReviewAt: now - 1 }),
      ]);
      const rows = await getEnrolledOpenings();
      const byId = Object.fromEntries(rows.map((r) => [r.openingId, r]));
      expect(byId.italian).toEqual({ openingId: 'italian', totalCards: 2, dueCards: 1 });
      expect(byId.sicilian).toEqual({ openingId: 'sicilian', totalCards: 1, dueCards: 1 });
    });
  });

  describe('applySm2', () => {
    it('first correct → 1-day interval', () => {
      const card = makeCard();
      const next = applySm2(card, true);
      expect(next.intervalDays).toBe(1);
      expect(next.successes).toBe(1);
      expect(next.ease).toBe(2.5);
    });

    it('second correct → 6-day interval', () => {
      const card = makeCard({ successes: 1, intervalDays: 1 });
      const next = applySm2(card, true);
      expect(next.intervalDays).toBe(6);
      expect(next.successes).toBe(2);
    });

    it('subsequent correct → interval × ease', () => {
      const card = makeCard({ successes: 2, intervalDays: 6, ease: 2.5 });
      const next = applySm2(card, true);
      expect(next.intervalDays).toBe(15); // round(6 * 2.5)
      expect(next.successes).toBe(3);
    });

    it('lapse resets interval to 1 day and drops ease by 0.2', () => {
      const card = makeCard({ successes: 5, intervalDays: 30, ease: 2.5, lapses: 0 });
      const next = applySm2(card, false);
      expect(next.intervalDays).toBe(1);
      expect(next.ease).toBeCloseTo(2.3, 5);
      expect(next.lapses).toBe(1);
      expect(next.successes).toBe(5); // unchanged
    });

    it('ease never drops below 1.3', () => {
      const card = makeCard({ ease: 1.3 });
      const next = applySm2(card, false);
      expect(next.ease).toBe(1.3);
    });

    it('schedules nextReviewAt = now + intervalDays', () => {
      const card = makeCard();
      const before = Date.now();
      const next = applySm2(card, true);
      const after = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      expect(next.nextReviewAt).toBeGreaterThanOrEqual(before + dayMs);
      expect(next.nextReviewAt).toBeLessThanOrEqual(after + dayMs);
    });
  });

  describe('recordReview', () => {
    it('applies SM-2 and persists', async () => {
      await db.srsOpeningCards.add(makeCard());
      const next = await recordReview(
        'italian-game::rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
        true,
      );
      expect(next?.successes).toBe(1);
      expect(next?.intervalDays).toBe(1);
      const reloaded = await db.srsOpeningCards.get(
        'italian-game::rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      );
      expect(reloaded?.successes).toBe(1);
    });

    it('returns null for an unknown card id', async () => {
      const result = await recordReview('does-not-exist', true);
      expect(result).toBeNull();
    });
  });
});
