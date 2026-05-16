import { db } from '../db/schema';
import type { OpeningRecord, DrillAttempt } from '../types';
import { fuzzyScore } from '../utils/fuzzySearch';

// ─── Opening name helpers ────────────────────────────────────────────────────

/** Derive the family-level name from a (possibly deep) opening name.
 *
 *  The openings DB names variations as `<Family>: <Variation>` (e.g.
 *  `"Italian Game: Two Knights Defense"`). The family is everything
 *  before the first colon. Family-level openings have no colon and
 *  return their own name unchanged.
 *
 *  Used by the rolodex Puzzles selector (WO-ROLODEX-PLUMBING-01
 *  item 11) for family-fallback: when a deep variation has no
 *  exact-name puzzle matches, walk up to the family and query
 *  there. `OpeningRecord` has no parent/family field — this is the
 *  derivation. */
export function getOpeningFamily(name: string): string {
  const colonIdx = name.indexOf(':');
  if (colonIdx === -1) return name.trim();
  return name.slice(0, colonIdx).trim();
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Returns all repertoire openings, optionally filtered by color, sorted by mastery (weakest first). */
export async function getRepertoireOpenings(
  color?: 'white' | 'black',
): Promise<OpeningRecord[]> {
  const all = await db.openings.filter((o) => o.isRepertoire).toArray();
  const filtered = color ? all.filter((o) => o.color === color) : all;
  return filtered.sort((a, b) => getMasteryPercent(a) - getMasteryPercent(b));
}

/** Returns a single opening by its ID. */
export async function getOpeningById(
  id: string,
): Promise<OpeningRecord | undefined> {
  return db.openings.get(id);
}

/** Returns all openings matching a given ECO code. */
export async function getOpeningByEco(eco: string): Promise<OpeningRecord[]> {
  return db.openings.where('eco').equals(eco).toArray();
}

/**
 * Full-text search over opening names (case-insensitive substring match).
 * Also matches on ECO code prefix.
 */
export async function searchOpenings(query: string): Promise<OpeningRecord[]> {
  if (!query.trim()) return [];
  const lower = query.toLowerCase();

  const all = await db.openings.toArray();

  // Score every opening and keep matches
  const scored: Array<{ opening: OpeningRecord; score: number }> = [];
  for (const o of all) {
    // ECO prefix match (always exact)
    if (o.eco.toLowerCase().startsWith(lower)) {
      scored.push({ opening: o, score: -1 });
      continue;
    }
    // Fuzzy name match
    const s = fuzzyScore(query, o.name);
    if (s !== null) {
      scored.push({ opening: o, score: s });
    }
  }

  // Sort by score (lower = better), then alphabetically
  scored.sort((a, b) => a.score - b.score || a.opening.name.localeCompare(b.opening.name));
  return scored.map((s) => s.opening);
}

/** Returns all openings (both repertoire and ECO reference), sorted by ECO code. */
export async function getAllOpenings(): Promise<OpeningRecord[]> {
  const all = await db.openings.toArray();
  return all.sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));
}

/** Returns openings whose ECO code starts with the given letter (A, B, C, D, or E). */
export async function getOpeningsByEcoLetter(letter: string): Promise<OpeningRecord[]> {
  const upper = letter.toUpperCase();
  const all = await db.openings.toArray();
  return all
    .filter((o) => o.eco.startsWith(upper))
    .sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));
}

// ─── Progress ─────────────────────────────────────────────────────────────────

/**
 * Records a drill attempt and updates rolling accuracy and lastStudied.
 *
 * @param correct  whether the attempt was correct
 * @param timeSeconds  seconds taken to complete the main line (Woodpecker tracking)
 */
export async function updateDrillProgress(
  id: string,
  correct: boolean,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;

  const attempts = opening.drillAttempts + 1;
  const accuracy =
    (opening.drillAccuracy * opening.drillAttempts + (correct ? 1 : 0)) /
    attempts;

  const updates: Partial<OpeningRecord> = {
    drillAttempts: attempts,
    drillAccuracy: accuracy,
    lastStudied: new Date().toISOString(),
  };

  await db.openings.update(id, updates);
}

/**
 * Updates Woodpecker Method tracking fields after a full drill-through of the
 * main line.
 */
export async function updateWoodpecker(
  id: string,
  timeSeconds: number,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;

  const reps = opening.woodpeckerReps + 1;
  const prevSpeed = opening.woodpeckerSpeed;
  // Rolling average speed
  const newSpeed =
    prevSpeed === null ? timeSeconds : (prevSpeed * (reps - 1) + timeSeconds) / reps;

  await db.openings.update(id, {
    woodpeckerReps: reps,
    woodpeckerSpeed: newSpeed,
    woodpeckerLastDate: new Date().toISOString().split('T')[0],
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Returns the repertoire openings with the weakest drill accuracy.
 * Openings never drilled (drillAttempts === 0) are ranked last to encourage
 * exploration.
 */
export async function getWeakestOpenings(
  limit: number = 5,
  color?: 'white' | 'black',
): Promise<OpeningRecord[]> {
  const repertoire = await getRepertoireOpenings(color);

  return repertoire
    .slice()
    .sort((a, b) => {
      // Never-drilled openings sort after drilled ones but before well-drilled
      const aScore = a.drillAttempts === 0 ? 0.5 : a.drillAccuracy;
      const bScore = b.drillAttempts === 0 ? 0.5 : b.drillAccuracy;
      return aScore - bScore;
    })
    .slice(0, limit);
}

/**
 * Returns openings due for Woodpecker review — those not drilled in the
 * last N days or never drilled.
 */
export async function getWoodpeckerDue(
  daysSince: number = 7,
  color?: 'white' | 'black',
): Promise<OpeningRecord[]> {
  const repertoire = await getRepertoireOpenings(color);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysSince);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  return repertoire.filter(
    (o) =>
      o.woodpeckerLastDate === null || o.woodpeckerLastDate <= cutoffStr,
  );
}

// ─── Mastery ─────────────────────────────────────────────────────────────────

/**
 * Calculates mastery percentage (0-100) from the last 10 drill attempts.
 * Falls back to drillAccuracy if no drillHistory exists.
 * Returns 0 if never drilled.
 */
export function getMasteryPercent(opening: OpeningRecord): number {
  if (opening.drillHistory && opening.drillHistory.length > 0) {
    const recent = opening.drillHistory.slice(-10);
    const correct = recent.filter((a) => a.correct).length;
    return Math.round((correct / recent.length) * 100);
  }
  if (opening.drillAttempts === 0) return 0;
  return Math.round(opening.drillAccuracy * 100);
}

/** Returns true when mastery is below 70%. */
export function needsReview(opening: OpeningRecord): boolean {
  if (opening.drillAttempts === 0) return false;
  return getMasteryPercent(opening) < 70;
}

/**
 * Records a drill attempt to the rolling drillHistory (max 10 entries).
 */
export async function recordDrillAttempt(
  id: string,
  correct: boolean,
  timeSeconds: number,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;

  const entry: DrillAttempt = {
    correct,
    time: timeSeconds,
    date: new Date().toISOString(),
  };

  const history = [...(opening.drillHistory ?? []), entry].slice(-10);

  await db.openings.update(id, { drillHistory: history });
  // Also update legacy drillAccuracy/drillAttempts for backward compat
  await updateDrillProgress(id, correct);
}

// ─── Line Tracking (Chess Reps style) ────────────────────────────────────────

/** Marks a variation as "discovered" (learned). Idempotent. */
export async function markLineDiscovered(
  id: string,
  variationIndex: number,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;
  const discovered = opening.linesDiscovered ? [...opening.linesDiscovered] : [];
  if (!discovered.includes(variationIndex)) {
    discovered.push(variationIndex);
    await db.openings.update(id, { linesDiscovered: discovered });
  }
}

/** Marks a variation as "perfected" (practiced without errors). Idempotent. */
export async function markLinePerfected(
  id: string,
  variationIndex: number,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening) return;
  const perfected = opening.linesPerfected ? [...opening.linesPerfected] : [];
  if (!perfected.includes(variationIndex)) {
    perfected.push(variationIndex);
    await db.openings.update(id, { linesPerfected: perfected });
  }
}

/** Returns count of discovered lines for an opening. */
export function getLinesDiscovered(opening: OpeningRecord): number {
  return opening.linesDiscovered?.length ?? 0;
}

/** Returns count of perfected lines for an opening. */
export function getLinesPerfected(opening: OpeningRecord): number {
  return opening.linesPerfected?.length ?? 0;
}

/** Returns total number of lines (variations) for an opening. */
export function getTotalLines(opening: OpeningRecord): number {
  return opening.variations?.length ?? 0;
}

/**
 * Updates per-variation mastery tracking.
 */
export async function updateVariationProgress(
  id: string,
  variationIndex: number,
  correct: boolean,
): Promise<void> {
  const opening = await db.openings.get(id);
  if (!opening || !opening.variations) return;
  if (variationIndex < 0 || variationIndex >= opening.variations.length) return;

  const accuracy = opening.variationAccuracy
    ? [...opening.variationAccuracy]
    : new Array<number>(opening.variations.length).fill(0);

  // Ensure array is long enough
  while (accuracy.length < opening.variations.length) {
    accuracy.push(0);
  }

  // Rolling update: weight previous value 80%, new result 20%
  const prev = accuracy[variationIndex];
  accuracy[variationIndex] = prev * 0.8 + (correct ? 1 : 0) * 0.2;

  await db.openings.update(id, { variationAccuracy: accuracy });
}

// ─── Gambits ────────────────────────────────────────────────────────────────

/** Returns all gambit openings, sorted by ECO code. */
export async function getGambitOpenings(): Promise<OpeningRecord[]> {
  const all = await db.openings.filter((o) => o.isGambit === true).toArray();
  return all.sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));
}

// ─── Favorites (WO-3) ───────────────────────────────────────────────────────

/** Toggles the isFavorite flag on an opening. Returns the new value. */
export async function toggleFavorite(id: string): Promise<boolean> {
  const opening = await db.openings.get(id);
  if (!opening) return false;
  const newValue = !opening.isFavorite;
  await db.openings.update(id, { isFavorite: newValue });
  return newValue;
}

/** Returns all favorited repertoire openings. */
export async function getFavoriteOpenings(): Promise<OpeningRecord[]> {
  return db.openings.filter((o) => o.isFavorite).toArray();
}
