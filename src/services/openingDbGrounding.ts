/**
 * openingDbGrounding
 * ------------------
 * Builds canonical opening DB entries (from `openings-lichess.json`)
 * to attach to the coach's master-play grounding context as a SECOND
 * source. The claim validator consults these alongside live master-play
 * data, so SANs and player-name attributions that are CANON in book
 * theory (Vienna Steinitz Gambit, Marshall Attack, Najdorf English
 * Attack, …) but NOT in the current Lichess explorer top-N for the
 * exact position no longer trip the "stock fallback" path.
 *
 * Two grounding paths:
 *
 *   1. POSITION-BASED — when the surface passes `moveHistory`, resolve
 *      the current opening via `findOpeningByPgnPrefix`. Pull the bare
 *      opening + its named sub-variations from the DB.
 *
 *   2. NAME-BASED — scan the user's most recent message for known
 *      opening keywords (Vienna, Sicilian, Steinitz Gambit, Najdorf, …).
 *      For each match, resolve via `resolveOpeningEntry` and pull the
 *      bare opening + sub-variations.
 *
 * The two paths can both fire on the same turn — e.g. user is on the
 * Vienna Game position AND types "walk me through the Steinitz Gambit".
 * Path 1 finds Vienna Game entries; Path 2 finds Steinitz Gambit
 * entries; both attach. Deduplication by canonical name.
 *
 * Entry shape (`OpeningDbEntry`):
 *   eco   — ECO classification, e.g. "C24"
 *   name  — canonical name from the Lichess DB
 *   pgn   — space-separated SAN sequence
 *   sans  — SANs derived from pgn (for fast contains-checks)
 *
 * Empty array when no entries match — caller falls back to master-play
 * grounding only.
 */

import {
  findOpeningByPgnPrefix,
  findRelatedDbEntries,
  resolveOpeningEntry,
} from './openingDetectionService';
import type { OpeningDbEntry } from './masterPlayTypes';

/** Common opening / variation keywords scanned in user messages.
 *  Conservative — we only treat a message as a "named opening
 *  reference" when one of these tokens appears. Each matched token
 *  is then handed to `resolveOpeningEntry`, which does fuzzy
 *  alias-aware resolution against `openings-lichess.json`. Keywords
 *  here don't need to be the canonical name — they just need to be a
 *  recognizable hook the resolver can turn into a DB entry. */
const OPENING_NAME_KEYWORDS: ReadonlyArray<string> = [
  // ─── 1.e4 e5 open games ────────────────────────────────────────────
  'Vienna Gambit', 'Vienna Game', 'Vienna',
  'Steinitz Gambit', 'Steinitz Defense', 'Steinitz Variation',
  'Ruy Lopez', 'Spanish Game', 'Berlin Defense', 'Berlin Wall',
  'Marshall Attack', 'Anti-Marshall', 'Open Spanish', 'Closed Ruy',
  'Italian Game', 'Italian', 'Giuoco Piano', 'Giuoco Pianissimo',
  'Two Knights Defense', 'Two Knights', 'Fried Liver', 'Lolli Attack',
  'Evans Gambit', 'Hungarian Defense',
  'Scotch Game', 'Scotch Gambit', 'Scotch',
  'King\'s Gambit', 'Kings Gambit', 'Kieseritzky', 'Muzio Gambit',
  'Falkbeer Counter-Gambit', 'Falkbeer',
  'Bishop\'s Opening', 'Bishops Opening',
  'Petroff', 'Petrov',
  'Petrov\'s Defense', 'Russian Game',
  'Stafford Gambit', 'Stafford',
  'Latvian Gambit',
  'Philidor', 'Philidor Defense',
  // ─── Sicilian family ───────────────────────────────────────────────
  'Sicilian Defense', 'Sicilian',
  'Najdorf', 'Najdorf Variation', 'English Attack',
  'Dragon', 'Yugoslav Attack', 'Accelerated Dragon',
  'Sveshnikov', 'Lasker-Pelikan',
  'Scheveningen', 'Keres Attack',
  'Taimanov', 'Kan Variation', 'Kan',
  'Classical Sicilian', 'Richter-Rauzer',
  'Alapin', 'Alapin Variation', 'Smith-Morra', 'Smith-Morra Gambit',
  'Rossolimo', 'Closed Sicilian', 'Grand Prix', 'Grand Prix Attack',
  'Open Sicilian', 'Anti-Sicilian',
  // ─── French family ─────────────────────────────────────────────────
  'French Defense', 'French',
  'Winawer', 'Tarrasch French', 'Tarrasch Variation',
  'Advance Variation', 'Advance Caro', 'Advance French',
  'Exchange French', 'Exchange Variation',
  'Classical French',
  'Burn Variation', 'McCutcheon',
  'Milner-Barry Gambit',
  // ─── Caro-Kann family ──────────────────────────────────────────────
  'Caro-Kann', 'Caro Kann', 'Caro-Kann Defense',
  'Fantasy Variation', 'Fantasy Caro', 'Fantasy',
  'Classical Caro', 'Classical Caro-Kann',
  'Karpov Variation', 'Bronstein-Larsen', 'Steinitz Caro',
  'Advance Caro-Kann', 'Two Knights Caro',
  // ─── Other 1.e4 ────────────────────────────────────────────────────
  'Pirc Defense', 'Pirc', 'Austrian Attack',
  'Modern Defense', 'Modern',
  'Alekhine\'s Defense', 'Alekhine Defense', 'Alekhine',
  'Scandinavian', 'Scandinavian Defense', 'Center Counter',
  'Nimzowitsch Defense', 'Owen\'s Defense',
  // ─── Closed games (1.d4) ───────────────────────────────────────────
  'Queen\'s Gambit', 'Queens Gambit', 'QGA', 'QGD',
  'Queen\'s Gambit Accepted', 'Queen\'s Gambit Declined',
  'Slav Defense', 'Slav', 'Semi-Slav', 'Semi-Slav Defense',
  'Catalan', 'Catalan Opening',
  'London System', 'London',
  'Trompowsky Attack', 'Trompowsky',
  'Torre Attack', 'Colle System', 'Colle',
  'Veresov Attack', 'Stonewall Attack', 'Stonewall',
  'Jobava London',
  // ─── 1.d4 Indian systems ───────────────────────────────────────────
  'King\'s Indian Defense', 'King\'s Indian', 'Kings Indian', 'KID',
  'Saemisch Variation', 'Saemisch', 'Mar del Plata', 'Bayonet Attack',
  'Classical King\'s Indian', 'Fianchetto KID',
  'Nimzo-Indian', 'Nimzo Indian', 'Nimzo-Indian Defense',
  'Rubinstein Variation', 'Classical Nimzo',
  'Queen\'s Indian Defense', 'Queens Indian', 'Queen\'s Indian',
  'Grünfeld', 'Grunfeld', 'Grunfeld Defense', 'Grünfeld Defense',
  'Exchange Grünfeld', 'Russian Variation Grünfeld',
  'Benoni Defense', 'Benoni', 'Modern Benoni', 'Czech Benoni',
  'Benko Gambit', 'Volga Gambit',
  'Old Indian Defense', 'Old Indian',
  'Budapest Gambit', 'Budapest Defense',
  'Dutch Defense', 'Dutch', 'Leningrad Dutch', 'Stonewall Dutch',
  'Classical Dutch',
  // ─── 1.c4 / 1.Nf3 / others ─────────────────────────────────────────
  'English Opening', 'English',
  'Botvinnik System', 'Symmetrical English',
  'Reti Opening', 'Réti', 'Reti',
  'King\'s Indian Attack', 'KIA',
  'Bird\'s Opening', 'Birds Opening', 'Bird Opening',
  'Larsen\'s Opening', 'Larsen Opening',
  'Englund Gambit',
  // ─── Named traps / mating patterns (legacy attribution) ───────────
  'Legal\'s Mate', 'Legal Mate', 'Légal Mate',
  'Scholar\'s Mate', 'Scholars Mate', 'Fool\'s Mate', 'Fools Mate',
  'Anastasia\'s Mate', 'Anastasia Mate', 'Boden\'s Mate',
  'Greek Gift', 'Greek Gift Sacrifice',
  'Lucena Position', 'Lucena', 'Philidor Position', 'Vancura',
  'Noah\'s Ark Trap', 'Noahs Ark', 'Mortimer Trap',
  'Berlin Tarrasch Trap', 'Open Tarrasch Trap', 'Bird\'s Defense Refutation',
  'Premature d5', 'Premature ...d5',
  // ─── Player names commonly used as shorthand for variations ───────
  'Carlsen', 'Kasparov', 'Karpov', 'Fischer', 'Tal',
  'Capablanca', 'Lasker', 'Alekhine', 'Steinitz',
  'Marshall', 'Pirc', 'Stafford', 'Najdorf', 'Petrov',
  'Naroditsky', 'Caruana', 'Nakamura', 'Anand', 'Praggnanandhaa',
  'Firouzja', 'Erigaisi', 'Hikaru', 'Botvinnik',
  // ─── Generic but useful single-word hooks ─────────────────────────
  'Gambit', 'Counter-Gambit', 'Countergambit',
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a single regex once per module load. Word-boundary on both
 *  sides so "Vienna" doesn't match "Vienna Sausage Recipe", and case-
 *  insensitive so casing in the user message doesn't matter. */
const OPENING_NAME_RE = new RegExp(
  `\\b(${OPENING_NAME_KEYWORDS.map(escapeForRegex).join('|')})\\b`,
  'gi',
);

/** Extract candidate opening-name strings from a free-text user
 *  message. Returns each distinct match (case-folded for dedup) in
 *  order of first appearance. Empty when no keyword fires. */
export function extractOpeningNamesFromText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  OPENING_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPENING_NAME_RE.exec(text))) {
    const name = m[1];
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out;
}

export interface BuildOpeningDbEntriesOptions {
  /** SAN move history that produced the current position. When
   *  supplied, the position-based path resolves the current opening
   *  via `findOpeningByPgnPrefix` and pulls related sub-variations. */
  moveHistory?: ReadonlyArray<string>;
  /** Free text from the user's most recent message. Scanned for
   *  opening name keywords; matches are resolved via `resolveOpeningEntry`. */
  userMessage?: string;
  /** Cap on returned entries so the system prompt block stays compact.
   *  Default 8. */
  maxEntries?: number;
}

/** Build the opening-DB grounding entries for this turn. Combines the
 *  position-based and name-based paths, dedupes by canonical name,
 *  caps at `maxEntries`. */
export function buildOpeningDbEntries(
  opts: BuildOpeningDbEntriesOptions,
): ReadonlyArray<OpeningDbEntry> {
  const maxEntries = opts.maxEntries ?? 8;
  if (maxEntries <= 0) return [];
  const seen = new Set<string>();
  const out: OpeningDbEntry[] = [];

  const pushFromName = (name: string): void => {
    if (out.length >= maxEntries) return;
    const related = findRelatedDbEntries(name, maxEntries * 2);
    for (const e of related) {
      if (out.length >= maxEntries) return;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const sans = e.pgn.split(/\s+/).filter(Boolean);
      out.push({ eco: e.eco, name: e.name, pgn: e.pgn, sans });
    }
  };

  // ── Path 1: position-based via move history ─────────────────────
  if (opts.moveHistory && opts.moveHistory.length > 0) {
    const detected = findOpeningByPgnPrefix([...opts.moveHistory]);
    if (detected) pushFromName(detected.canonicalName);
  }

  // ── Path 2: name-based from the user message ────────────────────
  if (opts.userMessage && out.length < maxEntries) {
    const candidates = extractOpeningNamesFromText(opts.userMessage);
    for (const candidate of candidates) {
      if (out.length >= maxEntries) break;
      const resolved = resolveOpeningEntry(candidate);
      if (!resolved) continue;
      pushFromName(resolved.canonicalName);
    }
  }

  return out;
}
