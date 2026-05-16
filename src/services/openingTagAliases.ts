/**
 * openingTagAliases
 * -----------------
 * Bridges naming-convention mismatches between the openings DB
 * (`src/data/openings-lichess.json`, ~3,641 entries) and Lichess
 * puzzle `openingTags` strings (`src/data/puzzles.json`, ~3,207
 * tagged of 15,000 total).
 *
 * The puzzle-coverage audit (`/docs/audits/puzzle-opening-coverage.md`)
 * identified 13 Lichess family tokens that do not normalize-match any
 * DB opening name. This file captures the 8 worth special-casing —
 * collectively recovering ~128 puzzles that would otherwise be
 * invisible to the rolodex Puzzles row.
 *
 * Single-puzzle flukes (Bronstein_Gambit, Kings_Pawn) are skipped:
 * not worth a special case for 1 puzzle.
 *
 * SHAPE
 * -----
 * Keys: family-level opening NAMES as they appear after the
 *       `getOpeningFamily()` helper in `openingService.ts` would
 *       produce them (i.e. `name.split(':')[0].trim()`).
 * Values: arrays of Lichess `openingTags` tokens — additional tokens
 *         to query when matching puzzles for this family. The selector
 *         (item 11 in WO-ROLODEX-PLUMBING-01) consults this map during
 *         BOTH the exact-match step and the family-walk step.
 *
 * Some entries are belt-and-suspenders (Torre Attack and King's
 * Gambit Declined would be caught by name normalization anyway via
 * `getOpeningFamily()` on their children). They are kept here for
 * discoverability — future devs reading this file see the full set
 * of name-bridges in one place.
 */
export const OPENING_TAG_ALIASES: Record<string, string[]> = {
  // Lichess uses "Russian_Game" for what the DB calls "Petrov's Defense".
  // Pure rename. Biggest single win in this map.
  "Petrov's Defense": ['Russian_Game'], // +49 puzzles

  // DB has children only ("King's Gambit Declined: Classical Variation"
  // etc), no parent row. `getOpeningFamily()` derives "King's Gambit
  // Declined" from any child, and that normalizes to the Lichess token
  // — so this entry is technically redundant. Kept for documentation.
  "King's Gambit Declined": ['Kings_Gambit_Declined'], // +30 puzzles (belt-and-suspenders)

  // Lichess uses "Englund_Gambit_Complex" + "Englund_Gambit_Complex_Declined"
  // where the DB just has "Englund Gambit". Both tokens fall under the
  // same DB family.
  'Englund Gambit': ['Englund_Gambit_Complex', 'Englund_Gambit_Complex_Declined'], // +25 puzzles

  // Most C50 puzzles get tagged Italian_Game directly. A small handful
  // use the older Giuoco_Piano family token. Fold them in.
  'Italian Game': ['Giuoco_Piano'], // +2 puzzles

  // Same belt-and-suspenders shape as King's Gambit Declined — Torre
  // Attack lives in the DB as children only ("Torre Attack: ..."),
  // family-walk + normalization would catch it, but listing here keeps
  // the bridge explicit.
  'Torre Attack': ['Torre_Attack'], // +6 puzzles (belt-and-suspenders)

  // Lichess's `Danish_Gambit_Declined` token has no DB parent of that
  // exact name; route it under the regular Danish Gambit family.
  'Danish Gambit': ['Danish_Gambit_Declined'], // +1 puzzle

  // The Rat Defense is a Modern Defense sub-line (1.d4 d6 2.e4 g6 with
  // king fianchetto) that Lichess tags as its own family. Fold into
  // Modern Defense so users favoriting Modern see the 9 Rat puzzles.
  'Modern Defense': ['Rat_Defense'], // +9 puzzles

  // DB name "St. George Defense" has a period that the normalizer
  // preserves; Lichess token has no period. Alias bridges the period
  // mismatch.
  'St. George Defense': ['St_George_Defense'], // +6 puzzles
};

/**
 * Look up Lichess tokens to include when matching puzzles for a given
 * DB family name. Returns the empty array (not undefined) when no
 * alias is configured — convenient for `.concat()` patterns.
 */
export function getAliasedTokens(familyName: string): string[] {
  return OPENING_TAG_ALIASES[familyName] ?? [];
}
