/**
 * srsOpeningService.ts — Spaced repetition opening trainer.
 *
 * One Chessable-style "card" per student-to-move position in an enrolled
 * opening line. Uses SM-2 scheduling (the Anki/SuperMemo classic):
 *
 *   - Card just enrolled: due immediately.
 *   - First correct review: next review in 1 day.
 *   - Second correct: 6 days.
 *   - Subsequent correct: interval × easeFactor.
 *   - Wrong: interval resets to 1 day, ease drops by 0.2 (floored at 1.3).
 *
 * Why SM-2 over FSRS: simpler, proven, no per-user model. With a single-
 * user app and only one card type (opening moves), the FSRS advantage
 * (better calibration from review history) doesn't justify the
 * complexity.
 *
 * Identity: a card's id is `${openingId}::${normalizedFenBefore}`. That
 * way Italian Game transpositions (e2-e4, Nf3, Nc6, Bc4 = e2-e4, Bc4,
 * Nc6, Nf3 — same position) collapse to one card. Re-enrolling an opening
 * is idempotent — existing cards keep their SRS state, new positions get
 * fresh cards.
 */
import { Chess } from 'chess.js';
import { db } from '../db/schema';
import type { OpeningRecord, SrsOpeningCard } from '../types';

/** Normalize a FEN for use as a card-id suffix. Drops the half-move and
 *  fullmove counters at the end (positions are the same chess-wise even
 *  if the move counter differs across transpositions). */
function normalizeFen(fen: string): string {
  const parts = fen.split(' ');
  // Keep board / turn / castling / ep — drop halfmove + fullmove.
  return parts.slice(0, 4).join(' ');
}

/** Strip SAN of decorators so "Nf3+", "Nf3!", "Nf3#" all compare equal
 *  to "Nf3". Promotion piece is kept (Nf3=Q is a different move from
 *  Nf3=R), as is disambiguation (Nbd2 vs Nfd2). */
export function normalizeSan(san: string): string {
  return san.replace(/[+#!?]+$/g, '').trim();
}

function cardId(openingId: string, fenBefore: string): string {
  return `${openingId}::${normalizeFen(fenBefore)}`;
}

/** Walk a PGN, emitting one card per ply where it's the student's side
 *  to move. Returns position + expected SAN + the PGN prefix that got
 *  there. Skips opponent moves (those aren't quizzed — student studies
 *  by predicting their OWN next move, not their opponent's). */
function extractCardsFromPgn(
  pgn: string,
  variationName: string,
  studentColor: 'white' | 'black',
  openingId: string,
  createdAt: number,
): SrsOpeningCard[] {
  const tokens = pgn.trim().split(/\s+/).filter(Boolean);
  const chess = new Chess();
  const cards: SrsOpeningCard[] = [];
  const studentTurn: 'w' | 'b' = studentColor === 'white' ? 'w' : 'b';
  const moveHistory: string[] = [];

  for (const san of tokens) {
    const isStudentTurn = chess.turn() === studentTurn;
    if (isStudentTurn) {
      // Capture the FEN before student plays — that's the card position.
      const fenBefore = chess.fen();
      try {
        const move = chess.move(san);
        if (move) {
          cards.push({
            id: cardId(openingId, fenBefore),
            openingId,
            variationName,
            fenBefore,
            expectedSan: normalizeSan(move.san),
            pgnPrefix: moveHistory.join(' '),
            studentColor,
            ease: 2.5,
            intervalDays: 0,
            nextReviewAt: createdAt,
            successes: 0,
            lapses: 0,
            lastReviewedAt: null,
            createdAt,
          });
          moveHistory.push(move.san);
          continue;
        }
      } catch {
        // Illegal SAN — opening data drift. Stop walking this line.
        return cards;
      }
    } else {
      // Opponent move — just advance the position, no card.
      try {
        const move = chess.move(san);
        if (move) moveHistory.push(move.san);
        else return cards;
      } catch {
        return cards;
      }
    }
  }
  return cards;
}

/** Generate the full set of cards an opening would produce — main line +
 *  every variation. Idempotent — returns cards keyed by stable id so the
 *  caller can dedupe against the DB. */
export function generateCardsForOpening(opening: OpeningRecord): SrsOpeningCard[] {
  const now = Date.now();
  const out: SrsOpeningCard[] = [];

  // Main line — if a PGN is present.
  if (opening.pgn && opening.pgn.trim()) {
    out.push(...extractCardsFromPgn(
      opening.pgn,
      opening.name,
      opening.color,
      opening.id,
      now,
    ));
  }

  // Variations.
  for (const variation of opening.variations ?? []) {
    if (!variation.pgn?.trim()) continue;
    out.push(...extractCardsFromPgn(
      variation.pgn,
      variation.name,
      opening.color,
      opening.id,
      now,
    ));
  }

  // Dedup by id — transpositions across variations collapse.
  const byId = new Map<string, SrsOpeningCard>();
  for (const c of out) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return Array.from(byId.values());
}

/** Enroll an opening: write any cards that don't yet exist in the DB.
 *  Existing cards (by id) are left alone so prior SRS state survives a
 *  re-enroll. Returns counts: { added, alreadyEnrolled }. */
export async function enrollOpening(opening: OpeningRecord): Promise<{
  added: number;
  alreadyEnrolled: number;
}> {
  const cards = generateCardsForOpening(opening);
  if (cards.length === 0) return { added: 0, alreadyEnrolled: 0 };

  const ids = cards.map((c) => c.id);
  const existing = await db.srsOpeningCards.where('id').anyOf(ids).toArray();
  const existingIds = new Set(existing.map((c) => c.id));
  const toAdd = cards.filter((c) => !existingIds.has(c.id));

  if (toAdd.length > 0) {
    await db.srsOpeningCards.bulkAdd(toAdd);
  }
  return { added: toAdd.length, alreadyEnrolled: existing.length };
}

/** Remove all cards for an opening. Used when un-enrolling. */
export async function unenrollOpening(openingId: string): Promise<number> {
  return db.srsOpeningCards.where('openingId').equals(openingId).delete();
}

/** Whether any cards exist for this opening. */
export async function isEnrolled(openingId: string): Promise<boolean> {
  const count = await db.srsOpeningCards.where('openingId').equals(openingId).count();
  return count > 0;
}

/** Cards currently due — nextReviewAt <= now. Sorted by nextReviewAt
 *  ascending so the most-overdue card comes first. The limit caps the
 *  daily session; SRS theory says 20-30 reviews per session is the
 *  retention sweet spot. */
export async function getDueCards(limit = 30): Promise<SrsOpeningCard[]> {
  const now = Date.now();
  return db.srsOpeningCards
    .where('nextReviewAt')
    .belowOrEqual(now)
    .limit(limit)
    .toArray();
}

/** A line grouping for Woodpecker-style review: every card in this
 *  group belongs to the same (openingId, variationName) — i.e. the
 *  same sequence of moves — and at least one of them is due.
 *
 *  `cards` is sorted by `pgnPrefix` length ascending, so iterating
 *  walks the line from move 1 to its end-for-student. The last card's
 *  `pgnPrefix + ' ' + expectedSan` is the full line PGN. */
export interface DueLine {
  openingId: string;
  variationName: string;
  studentColor: 'white' | 'black';
  /** The full line PGN — every ply from move 1 to the student's last
   *  recorded move. Opponent moves are inferred from the cards' shared
   *  pgnPrefix chain. */
  fullPgn: string;
  cards: SrsOpeningCard[];
}

/** Returns a queue of due *lines* for Woodpecker mode. Each line is a
 *  single variation that has at least one card due. The student plays
 *  through the whole line move-by-move; cards inside the line get
 *  SM-2 updates individually based on per-position outcomes.
 *
 *  Limit is in lines, not cards. SRS theory still applies — a
 *  Woodpecker session of 5 lines (≈ 30-50 student plies) lines up with
 *  the per-position cap of ~30. */
export async function getDueLines(limit = 5): Promise<DueLine[]> {
  const now = Date.now();
  const due = await db.srsOpeningCards
    .where('nextReviewAt')
    .belowOrEqual(now)
    .toArray();

  // Group by (openingId, variationName). Pull in any sibling cards from
  // the same variation even if they aren't due themselves — Woodpecker
  // is whole-line; we always replay the full sequence, so we need every
  // student position in the line. Cards not due still get SM-2'd by the
  // outcome of THIS replay, just from a different starting interval.
  const byLine = new Map<string, DueLine>();
  const lineKeys = new Set<string>();
  for (const card of due) {
    lineKeys.add(`${card.openingId}::${card.variationName}`);
  }

  if (lineKeys.size === 0) return [];

  for (const key of lineKeys) {
    const [openingId, variationName] = key.split('::');
    const cards = await db.srsOpeningCards
      .where('openingId')
      .equals(openingId)
      .filter((c) => c.variationName === variationName)
      .toArray();
    if (cards.length === 0) continue;
    cards.sort((a, b) => a.pgnPrefix.length - b.pgnPrefix.length);
    const last = cards[cards.length - 1];
    const fullPgn = last.pgnPrefix
      ? `${last.pgnPrefix} ${last.expectedSan}`.trim()
      : last.expectedSan;
    byLine.set(key, {
      openingId,
      variationName,
      studentColor: cards[0].studentColor,
      fullPgn,
      cards,
    });
  }

  // Sort by most-overdue first card in each line so the line with the
  // hottest review pressure surfaces first.
  return Array.from(byLine.values())
    .sort((a, b) => {
      const aMin = Math.min(...a.cards.map((c) => c.nextReviewAt));
      const bMin = Math.min(...b.cards.map((c) => c.nextReviewAt));
      return aMin - bMin;
    })
    .slice(0, limit);
}

/** Count of cards due (no limit). Drives the "X due today" header. */
export async function getDueCount(): Promise<number> {
  const now = Date.now();
  return db.srsOpeningCards.where('nextReviewAt').belowOrEqual(now).count();
}

/** Total enrolled cards across all openings. */
export async function getTotalEnrolled(): Promise<number> {
  return db.srsOpeningCards.count();
}

/** List the openings the student has enrolled, with per-opening counts. */
export async function getEnrolledOpenings(): Promise<
  { openingId: string; totalCards: number; dueCards: number }[]
> {
  const all = await db.srsOpeningCards.toArray();
  const now = Date.now();
  const byOpening = new Map<string, { totalCards: number; dueCards: number }>();
  for (const c of all) {
    const e = byOpening.get(c.openingId) ?? { totalCards: 0, dueCards: 0 };
    e.totalCards += 1;
    if (c.nextReviewAt <= now) e.dueCards += 1;
    byOpening.set(c.openingId, e);
  }
  return Array.from(byOpening.entries()).map(([openingId, counts]) => ({
    openingId,
    ...counts,
  }));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** SM-2 update. Returns the new card state — caller persists. */
export function applySm2(card: SrsOpeningCard, correct: boolean): SrsOpeningCard {
  const now = Date.now();
  if (correct) {
    let newInterval: number;
    if (card.successes === 0) {
      newInterval = 1; // first correct → 1 day
    } else if (card.successes === 1) {
      newInterval = 6; // second correct → 6 days
    } else {
      newInterval = Math.round(card.intervalDays * card.ease);
    }
    return {
      ...card,
      ease: card.ease, // ease only changes on lapse in vanilla SM-2
      intervalDays: newInterval,
      nextReviewAt: now + newInterval * ONE_DAY_MS,
      successes: card.successes + 1,
      lastReviewedAt: now,
    };
  } else {
    // Lapse: reset interval to 1 day, decrement ease (floor 1.3).
    const newEase = Math.max(1.3, card.ease - 0.2);
    return {
      ...card,
      ease: newEase,
      intervalDays: 1,
      nextReviewAt: now + ONE_DAY_MS,
      successes: card.successes, // unchanged on lapse
      lapses: card.lapses + 1,
      lastReviewedAt: now,
    };
  }
}

/** Apply a review result to a card and persist. */
export async function recordReview(cardId: string, correct: boolean): Promise<SrsOpeningCard | null> {
  const card = await db.srsOpeningCards.get(cardId);
  if (!card) return null;
  const next = applySm2(card, correct);
  await db.srsOpeningCards.put(next);
  return next;
}
