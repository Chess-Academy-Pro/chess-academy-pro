// kidRatingService — per-piece adaptive rating for kid mode.
//
// Each ChessPiece carries its own Elo-style number on the active
// profile, starting at 100 (sub-Lichess floor). Correct puzzle: +25.
// Incorrect: -15. Capped to [MIN_RATING, MAX_RATING]. Read with a
// default fallback so a profile pre-dating schema v26 (or one whose
// upgrade hasn't fired yet) still works.
//
// Consumers:
//   - Phase 8's per-piece puzzle picker (filters puzzles.json +
//     training-puzzles.json by `rating ∈ [r - 50, r + 50]`).
//   - Future audit script that walks the kid puzzle session and
//     verifies +25 / -15 deltas land in the DB.
//
// Non-negotiable #8 ("adaptive difficulty per-piece, persisted in
// Dexie, never lost on session end") is what this file implements.

import { db } from '../db/schema';
import type { ChessPiece, UserProfile } from '../types';

/** Starting rating. David's call ("Start at 100 elo"). */
export const DEFAULT_KID_RATING = 100;
/** Floor — matches the lowest training-pool puzzle. */
export const MIN_KID_RATING = 100;
/** Ceiling — well above the kid section's target audience. */
export const MAX_KID_RATING = 2000;
/** Reward for a correct solve. */
export const RATING_GAIN_ON_CORRECT = 25;
/** Penalty for an incorrect solve. */
export const RATING_LOSS_ON_INCORRECT = 15;

const KID_PIECES: readonly ChessPiece[] = [
  'king', 'queen', 'rook', 'bishop', 'knight', 'pawn',
];

/** Read the kid's current rating for a specific piece. Falls back to
 *  100 when (a) no active profile, (b) the profile hasn't been
 *  migrated to schema v26 yet, or (c) the piece slot is missing. */
export async function getKidRating(piece: ChessPiece): Promise<number> {
  const profile = await db.profiles.get('main');
  return profile?.kidRatingByPiece?.[piece] ?? DEFAULT_KID_RATING;
}

/** Read the entire per-piece rating map. Missing pieces get the
 *  default. Used by the puzzle picker when it needs every band at
 *  once (e.g. to render the hub progress). */
export async function getAllKidRatings(): Promise<Record<ChessPiece, number>> {
  const profile = await db.profiles.get('main');
  const map = profile?.kidRatingByPiece ?? {};
  const out: Record<ChessPiece, number> = {
    king: DEFAULT_KID_RATING,
    queen: DEFAULT_KID_RATING,
    rook: DEFAULT_KID_RATING,
    bishop: DEFAULT_KID_RATING,
    knight: DEFAULT_KID_RATING,
    pawn: DEFAULT_KID_RATING,
  };
  for (const p of KID_PIECES) {
    const v = map[p];
    if (typeof v === 'number') out[p] = v;
  }
  return out;
}

/** Apply a +25 / -15 update to the kid's rating for `piece` and
 *  persist. Returns the new rating. No-ops (returns default) if no
 *  active profile — same shape as `getKidRating`. */
export async function bumpKidRating(piece: ChessPiece, correct: boolean): Promise<number> {
  const profile = await db.profiles.get('main');
  if (!profile) return DEFAULT_KID_RATING;
  const current = profile.kidRatingByPiece?.[piece] ?? DEFAULT_KID_RATING;
  const delta = correct ? RATING_GAIN_ON_CORRECT : -RATING_LOSS_ON_INCORRECT;
  const next = Math.max(MIN_KID_RATING, Math.min(MAX_KID_RATING, current + delta));
  const nextMap: Partial<Record<ChessPiece, number>> = {
    ...(profile.kidRatingByPiece ?? {}),
    [piece]: next,
  };
  const updated: UserProfile = { ...profile, kidRatingByPiece: nextMap };
  await db.profiles.put(updated);
  return next;
}

/** Reset all kid ratings for the active profile back to 100. Hooked
 *  to a future "start over" affordance in Settings. */
export async function resetKidRatings(): Promise<void> {
  const profile = await db.profiles.get('main');
  if (!profile) return;
  const seeded: Partial<Record<ChessPiece, number>> = {};
  for (const p of KID_PIECES) seeded[p] = DEFAULT_KID_RATING;
  await db.profiles.put({ ...profile, kidRatingByPiece: seeded });
}
