import { db } from '../db/schema';
import type { OpeningNarration } from '../types';

// ─── Match Result ──────────────────────────────────────────────────────────

interface NarrationMatch {
  narration: OpeningNarration;
  matchType: 'fen' | 'opening_move' | 'move_only';
}

// ─── Core Lookup ───────────────────────────────────────────────────────────

/**
 * Find the best matching narration from the database.
 *
 * Priority:
 *  1. Exact FEN match (position-specific, highest confidence)
 *  2. Opening name + move SAN match
 *  3. Move SAN only (lowest confidence, rarely useful)
 *
 * Returns null if no approved narration is found.
 */
export async function getBestNarration(
  fen: string,
  lastMoves: string[],
  openingName?: string,
): Promise<NarrationMatch | null> {
  const currentMove = lastMoves.length > 0 ? lastMoves[lastMoves.length - 1] : null;
  if (!currentMove) return null;

  // 1. Try exact FEN match (strongest signal) — BUT only if the matched
  //    narration belongs to the SAME opening family. Without this check,
  //    every 1.e4 walkthrough (Caro-Kann, Sicilian, French, Pirc, etc.)
  //    pulls the seeded "Italian Game with e4" narration because they all
  //    share `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b ...`. The
  //    2026-05-17 Fantasy Caro audit caught the leak — overrode 6 plies
  //    of Caro walkthrough text with Italian Game prose. Opening-name
  //    compatibility is a substring check (lowercased) so
  //    "Fantasy Variation vs Caro-Kann" matches the seed entry whose
  //    `openingName` is "Caro-Kann Defense".
  const fenMatch = await db.openingNarrations
    .where('fen')
    .equals(fen)
    .and((n) => n.approved)
    .first();

  if (fenMatch && isOpeningNameCompatible(fenMatch.openingName, openingName)) {
    return { narration: fenMatch, matchType: 'fen' };
  }

  // 2. Try opening name + move SAN match
  if (openingName) {
    const normalizedName = openingName.toLowerCase();
    const openingMatches = await db.openingNarrations
      .where('moveSan')
      .equals(currentMove)
      .and((n) => n.approved && n.openingName.toLowerCase() === normalizedName)
      .toArray();

    if (openingMatches.length > 0) {
      // Prefer variation-specific match if available
      const variationMatch = openingMatches.find((n) => n.variation.length > 0);
      return {
        narration: variationMatch ?? openingMatches[0],
        matchType: 'opening_move',
      };
    }
  }

  // 3. Fallback: move SAN only (weak match — used sparingly)
  const moveMatch = await db.openingNarrations
    .where('moveSan')
    .equals(currentMove)
    .and((n) => n.approved)
    .first();

  if (moveMatch) {
    return { narration: moveMatch, matchType: 'move_only' };
  }

  return null;
}

// ─── Opening-name compatibility ───────────────────────────────────────────

/**
 * Decide whether a seeded narration's openingName is compatible with the
 * active opening name. Compatibility is a *substring* check in either
 * direction (case-insensitive, after normalising). This handles three
 * cases the 2026-05-17 audit surfaced:
 *
 *  - "Fantasy Variation vs Caro-Kann (GothamChess)" should match
 *    a seed entry tagged "Caro-Kann Defense" (the seed is a generic
 *    family-level narration; the variation is the more specific name).
 *  - "Italian Game" seed should NOT match a Caro-Kann walkthrough
 *    even though both reach the same 1.e4 FEN.
 *  - Empty / missing openingName means we conservatively reject the
 *    seeded narration. Without an opening name we can't verify
 *    compatibility, and silently accepting any FEN match is exactly
 *    the bug we're fixing.
 *
 * The substring direction matters: we accept if the seed's openingName
 * appears in the active openingName OR vice-versa, normalising both to
 * canonical form (strip parenthesised attributions, collapse
 * whitespace, lowercase). This is a permissive check by design — the
 * goal is to stop CROSS-FAMILY leaks (Italian → Caro), not to enforce
 * exact-variant matching.
 */
export function isOpeningNameCompatible(
  seedOpeningName: string,
  activeOpeningName?: string,
): boolean {
  if (!activeOpeningName) return false;
  const seed = normaliseOpeningName(seedOpeningName);
  const active = normaliseOpeningName(activeOpeningName);
  if (!seed || !active) return false;
  if (seed === active) return true;
  if (active.includes(seed)) return true;
  if (seed.includes(active)) return true;
  // Strip the leading family token from the active name (everything
  // before the first colon or space-hyphen) and retry. This lets
  // "fantasy variation vs caro-kann" match "caro-kann defense" once we
  // strip the leading "fantasy variation vs" qualifier.
  const activeFamily = active.replace(/^[^a-z]*(?:fantasy|advance|classical|main line|exchange|panov|tarrasch|winawer|english|french|caro|kid|sicilian)?\s*(?:variation|defense|attack|gambit)?\s*(?:vs|against)?\s+/i, '');
  if (activeFamily !== active && (activeFamily.includes(seed) || seed.includes(activeFamily))) return true;
  return false;
}

function normaliseOpeningName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // strip "(GothamChess)" / "(by Naroditsky)"
    .replace(/[^a-z0-9 ]+/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Fallback Decision ────────────────────────────────────────────────────

/**
 * Decides whether to fall back to Claude for annotation.
 *
 * Returns true (use Claude) when:
 *  - No narration match at all
 *  - Match is move-only (too weak to be reliable)
 *  - Narration has no approved entries
 */
export function shouldUseClaudeFallback(match: NarrationMatch | null): boolean {
  if (!match) return true;
  if (match.matchType === 'move_only') return true;
  if (!match.narration.approved) return true;
  if (match.narration.narrations.length === 0) return true;
  return false;
}

// ─── Narration Selection ──────────────────────────────────────────────────

/**
 * Pick one narration string from the available set.
 * Rotates through narrations to provide variety across sessions.
 */
export function pickNarration(narration: OpeningNarration): string {
  if (narration.narrations.length === 0) return '';
  if (narration.narrations.length === 1) return narration.narrations[0];
  const index = Math.floor(Math.random() * narration.narrations.length);
  return narration.narrations[index];
}

// ─── Seed Helpers ─────────────────────────────────────────────────────────

/**
 * Bulk-insert curated narrations into the database.
 * Uses bulkPut for idempotent seeding (safe to call multiple times).
 */
export async function seedNarrations(narrations: OpeningNarration[]): Promise<void> {
  await db.openingNarrations.bulkPut(narrations);
}
