/**
 * Registry of in-place HAND-CRAFTED walkthrough trees.
 *
 * ─── DEPRECATED FOR NEW OPENINGS ────────────────────────────────
 *
 * The DB-narration path in
 * `services/openingGenerator.ts > generateOpeningFromDbNarration`
 * is the canonical authoring pattern. It builds the tree skeleton
 * from `openings-lichess.json` (moves are legal by DB construction,
 * FENs are correct by chess.js replay) and asks the LLM only to
 * write narration prose. CLAUDE.md's DON'T BREAK section locks
 * that inversion in.
 *
 * This registry exists only for historical hand-crafted trees that
 * predate the inversion. Currently: Vienna only. New openings
 * should NOT add files here — let DB-narration handle them.
 *
 * Tier 3 architecture cleanup (deferred): once Vienna's DB-narration
 * output reaches parity with the hand-crafted tree, drop the entry
 * from ALL_TREES and route Vienna through the DB path like every
 * other opening. The `vienna.ts` file's header comment describes
 * the migration plan.
 */
import type { WalkthroughTree } from '../../types/walkthroughTree';
import { VIENNA_GAME } from './vienna';

/** Master list of available walkthrough trees. The order doesn't
 *  matter — resolution is by name match. */
const ALL_TREES: WalkthroughTree[] = [VIENNA_GAME];

/** Stop-words stripped during opening-name resolution so phrases
 *  like "the vienna", "vienna please", "the vienna line" all
 *  resolve to "Vienna Game". */
const RESOLUTION_STOPWORDS = new Set([
  'the', 'a', 'an', 'please', 'opening', 'defense', 'defence', 'game',
  'gambit', 'attack', 'variation', 'line', 'system', 'stuff', 'thing',
  'me', 'us', 'my', 'your', 'about', 'on', 'in', 'with',
]);

function tokenize(text: string): string[] {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !RESOLUTION_STOPWORDS.has(w));
}

/** Resolve an opening name (whatever the brain or surface passes) to
 *  a registered walkthrough tree. Match strategy, in order:
 *
 *    1. Exact case-insensitive match on `openingName`.
 *    2. ECO code match (e.g. "C25" → Vienna).
 *    3. Sub-string match (e.g. "Vienna Game" / "Vienna").
 *    4. Word-level match after stopword removal — handles
 *       "the vienna", "vienna please", "the vienna line", etc.
 *       Audit (build 3e2263c) caught "The Vienna" not resolving
 *       under sub-string match because neither "the vienna" nor
 *       "vienna game" is a substring of the other.
 *
 *  Returns `null` when no tree exists for the requested opening. */
export function resolveWalkthroughTree(query: string): WalkthroughTree | null {
  if (!query || !query.trim()) return null;
  const q = query.trim().toLowerCase();

  // 1. Exact name match.
  const exact = ALL_TREES.find((t) => t.openingName.toLowerCase() === q);
  if (exact) return exact;

  // 2. ECO code match.
  const ecoMatch = ALL_TREES.find((t) => t.eco.toLowerCase() === q);
  if (ecoMatch) return ecoMatch;

  // Sub-variation specifier (`:`): the user typed a specific variation
  // ("Vienna Game: Stanley Variation"). Don't fall back to substring
  // / word-level matches — those would hijack the request and route
  // to the BARE static tree, robbing the user of the focused
  // LLM-generated lesson for the specific variation. Production
  // audit (build 00aadcd) found Tier 1 was capturing every
  // "Vienna Game: X" query and routing to the un-specific Vienna
  // walkthrough.
  if (q.includes(':')) return null;

  // 3. Sub-string match.
  const sub = ALL_TREES.find(
    (t) => t.openingName.toLowerCase().includes(q) || q.includes(t.openingName.toLowerCase()),
  );
  if (sub) return sub;

  // 4. Word-level match after stopword removal.
  const queryTokens = tokenize(q);
  if (queryTokens.length === 0) return null;
  const wordMatch = ALL_TREES.find((t) => {
    const treeTokens = tokenize(t.openingName);
    if (treeTokens.length === 0) return false;
    // Resolve if EVERY non-stopword token in the query appears in
    // the tree's name tokens. "vienna" → ["vienna"] → tree "Vienna
    // Game" → ["vienna"] → all query tokens present.
    return queryTokens.every((qt) => treeTokens.includes(qt));
  });
  if (wordMatch) return wordMatch;

  return null;
}

/** List the names of every registered walkthrough — used by surfaces
 *  that want to render "available openings to learn." */
export function listAvailableWalkthroughs(): { name: string; eco: string }[] {
  return ALL_TREES.map((t) => ({ name: t.openingName, eco: t.eco }));
}

/** Infer which side the student plays from an opening name. Used:
 *    1. As a fallback when a tree's `studentSide` isn't set.
 *    2. To pre-flip the board during LLM generation (~30-60s window),
 *       so the student doesn't watch the lesson load with the wrong
 *       orientation.
 *
 *  Conservative heuristic: known black-side openings + the universal
 *  "Defense"/"Defence" suffix → black. Everything else defaults to
 *  white. Wrong inferences get corrected when the tree's actual
 *  studentSide loads. */
export function inferStudentSide(name: string): 'white' | 'black' {
  const lower = name.trim().toLowerCase();
  // Universal black-side suffix.
  if (/\bdefen[cs]e\b/.test(lower)) return 'black';
  // Known black-side openings without "defense" in the name.
  const blackSideKeywords = [
    'sicilian', 'french', 'caro-kann', 'caro kann', 'pirc',
    'modern', 'alekhine', 'scandinavian', 'scandi',
    'king\'s indian', 'kings indian', 'queen\'s indian', 'queens indian',
    'nimzo', 'grunfeld', 'grünfeld', 'benoni', 'benko',
    'dutch', 'philidor', 'petroff', 'petrov',
    'slav', 'semi-slav', 'tarrasch defense', 'two knights',
    'budapest', 'old indian', 'wade defense',
  ];
  for (const kw of blackSideKeywords) {
    if (lower.includes(kw)) return 'black';
  }
  return 'white';
}
