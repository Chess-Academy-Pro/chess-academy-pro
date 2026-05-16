/**
 * puzzlesByOpening
 * ----------------
 * Builds an in-memory index of bundled Lichess puzzles keyed by
 * `openingTags` token, then exposes a family-fallback count
 * function for the rolodex Puzzles row (WO-ROLODEX-PLUMBING-01
 * item 11).
 *
 * Why in-memory (not Dexie):
 *   • `openingTags` is not indexed on the `puzzles` Dexie table
 *     (`src/db/schema.ts` index spec: `id, rating, *themes,
 *     srsDueDate, userRating`). A Dexie `.filter()` would table-
 *     scan 15K rows on every row-mount — slow.
 *   • The bundled `puzzles.json` is the source of truth; building
 *     a `Map<token, puzzleId[]>` at module-load time costs ~50ms
 *     once and gives O(1) family lookups thereafter.
 *   • Per-user mistake / SRS state lives in Dexie, but the rolodex
 *     Puzzles count is "what's available for this opening?" — pure
 *     catalog data. Dexie isn't the right home.
 *
 * Family-fallback ladder (WO item 11):
 *   1. Exact-name match against the canonical Lichess token for
 *      the favorited opening (consulting the alias map for renames
 *      like Petrov's Defense ↔ Russian_Game).
 *   2. Walk up to the family via `getOpeningFamily()` and repeat
 *      step 1's lookup at the family level. Same alias map.
 *   3. Return `{ count: 0, source: 'none' }`.
 *
 * The alias map (`OPENING_TAG_ALIASES` from
 * `src/services/openingTagAliases.ts`) is keyed by DB family name
 * and lists ADDITIONAL Lichess tokens to query alongside the
 * normalized name. ~128 puzzles recovered total — biggest single
 * win is Petrov's Defense ↔ Russian_Game (49).
 */
import puzzleData from '../data/puzzles.json';
import { OPENING_TAG_ALIASES, getAliasedTokens } from './openingTagAliases';
import { getOpeningFamily } from './openingService';

interface BundledPuzzle {
  id: string;
  openingTags: string | null;
}

/** token → set of puzzle IDs. Built lazily on first use. */
let TOKEN_INDEX: Map<string, Set<string>> | null = null;

function buildIndex(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of puzzleData as BundledPuzzle[]) {
    if (!p.openingTags) continue;
    const tokens = p.openingTags.split(' ');
    for (const token of tokens) {
      if (!token) continue;
      let set = map.get(token);
      if (!set) {
        set = new Set();
        map.set(token, set);
      }
      set.add(p.id);
    }
  }
  return map;
}

function getIndex(): Map<string, Set<string>> {
  if (!TOKEN_INDEX) TOKEN_INDEX = buildIndex();
  return TOKEN_INDEX;
}

/** Normalize a DB opening name to Lichess `openingTags` token form.
 *
 *  Drops apostrophes, colons, commas, periods, diacritics, then
 *  converts whitespace to underscores. Matches the convention used
 *  in the puzzle-coverage audit (`docs/audits/puzzle-opening-coverage.md`).
 *
 *  Examples:
 *    "Italian Game"                  → "Italian_Game"
 *    "Italian Game: Two Knights"     → "Italian_Game_Two_Knights"
 *    "Petrov's Defense"              → "Petrovs_Defense"
 *    "St. George Defense"            → "St_George_Defense"
 *      (alias map then bridges to Lichess's `St_George_Defense`)
 *    "Grünfeld Defense"              → "Grunfeld_Defense"
 */
export function normalizeOpeningNameToLichessToken(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/['’]/g, '') // apostrophes (straight + curly)
    .replace(/[:,.]/g, '') // punctuation
    .replace(/\s+/g, '_');
}

/** Sum of unique puzzle IDs across the normalized opening name plus
 *  any aliased tokens for that DB family name. Set-deduped so a
 *  puzzle tagged with both the parent family and a variation token
 *  is counted once. */
function countPuzzlesForName(dbName: string): number {
  const index = getIndex();
  const tokens = [normalizeOpeningNameToLichessToken(dbName), ...getAliasedTokens(dbName)];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!t) continue;
    const ids = index.get(t);
    if (!ids) continue;
    for (const id of ids) seen.add(id);
  }
  return seen.size;
}

/** Source classification for the rolodex Puzzles row. */
export type PuzzlesProgressSource = 'exact' | 'family' | 'none';

export interface PuzzlesProgress {
  count: number;
  source: PuzzlesProgressSource;
  /** Set only when `source === 'family'`. The family name the
   *  fallback resolved to — surface in the chip + nudge copy
   *  ("X puzzles in the {family} family"). */
  family?: string;
}

/** Family-fallback Puzzles count for an opening (WO item 11).
 *
 *  Synchronous — the index is in-memory after the first call. No
 *  loading state needed in the rolodex UI for this row.
 *
 *  WO item 13 discipline: ONLY this selector uses family-fallback.
 *  The other 4 progress hooks (`useOpeningWalkthroughProgress`,
 *  etc.) do exact-name lookups against their own per-opening data
 *  substrates. Family-fallback exists here specifically because
 *  Lichess puzzle tags have ~21% coverage of the opening DB and
 *  the ladder is the cheapest way to surface useful counts on the
 *  ~93% of DB entries that are deep variations.
 */
export function getPuzzlesProgress(openingName: string): PuzzlesProgress {
  const trimmed = openingName.trim();

  // 1. Exact-name attempt
  const exactCount = countPuzzlesForName(trimmed);
  if (exactCount > 0) return { count: exactCount, source: 'exact' };

  // 2. Family-walk attempt — only if the name actually has a
  //    family to walk up to (i.e. it's a colon-delimited variation,
  //    not already a family-level name).
  const family = getOpeningFamily(trimmed);
  if (family !== trimmed) {
    const familyCount = countPuzzlesForName(family);
    if (familyCount > 0) {
      return { count: familyCount, source: 'family', family };
    }
  }

  // 3. No puzzles match at any tier.
  return { count: 0, source: 'none' };
}

/** Test-only — clear the cached index. Lets unit tests verify the
 *  lazy-build path and reset between runs that mock puzzleData. */
export function _resetIndexForTest(): void {
  TOKEN_INDEX = null;
}

// Re-export so consumers don't need a second import for the alias
// shape when wiring the rolodex row.
export { OPENING_TAG_ALIASES };
