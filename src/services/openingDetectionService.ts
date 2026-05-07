import openingsData from '../data/openings-lichess.json';
import type { DetectedOpening } from '../types';

interface OpeningEntry {
  eco: string;
  name: string;
  pgn: string;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  opening: OpeningEntry | null;
}

let cachedTrie: TrieNode | null = null;

function buildTrie(entries: OpeningEntry[]): TrieNode {
  const root: TrieNode = { children: new Map(), opening: null };

  for (const entry of entries) {
    const moves = entry.pgn.split(/\s+/).filter(Boolean);
    let node = root;

    for (const move of moves) {
      if (!node.children.has(move)) {
        node.children.set(move, { children: new Map(), opening: null });
      }
      const child = node.children.get(move);
      if (!child) break;
      node = child;
    }
    // Always overwrite — longer PGN entries that share a prefix will
    // set their own node deeper in the trie, so the deepest match wins.
    node.opening = entry;
  }

  return root;
}

function getTrie(): TrieNode {
  if (!cachedTrie) {
    cachedTrie = buildTrie(openingsData as OpeningEntry[]);
  }
  return cachedTrie;
}

/**
 * Detect the opening from a list of SAN moves (e.g. from chess.js .history()).
 * Returns the longest matching opening, or null if no match found.
 */
export function detectOpening(moveHistory: string[]): DetectedOpening | null {
  const trie = getTrie();
  let node = trie;
  let lastMatch: { opening: OpeningEntry; plyCount: number } | null = null;

  for (let i = 0; i < moveHistory.length; i++) {
    const move = moveHistory[i];
    const child = node.children.get(move);
    if (!child) break;

    node = child;
    if (node.opening) {
      lastMatch = { opening: node.opening, plyCount: i + 1 };
    }
  }

  if (!lastMatch) return null;

  return {
    eco: lastMatch.opening.eco,
    name: lastMatch.opening.name,
    plyCount: lastMatch.plyCount,
  };
}

/**
 * Check if the current move sequence is still within known opening theory.
 */
export function isStillInOpening(moveHistory: string[]): boolean {
  const trie = getTrie();
  let node = trie;

  for (const move of moveHistory) {
    const child = node.children.get(move);
    if (!child) return false;
    node = child;
  }

  return node.children.size > 0;
}

/**
 * Given an opening name (e.g. "French Defense"), find the main-line PGN moves.
 * Returns the longest (most specific) matching line as an array of SAN moves,
 * or null if no match. If `preferMainLine` is true (default), picks the
 * canonical shortest match (e.g. "e4 e6" for French Defense) to start the
 * opening and then the longest continuation to guide play deeper.
 */
/** Normalize an opening-name string for tolerant matching:
 *    - lowercase
 *    - strip diacritics (Réti → reti, Grünfeld → grunfeld)
 *    - strip apostrophes (King's → kings)
 *    - replace hyphens with spaces (Caro-Kann → caro kann)
 *    - collapse whitespace
 *  Production audit (build c081450) caught 27 of 116 legitimate
 *  user inputs being rejected by pre-flight because the DB names
 *  use canonical apostrophes / diacritics / hyphens but users
 *  typically don't. This normalization makes the match tolerant. */
function normalizeNameForMatch(s: string): string {
  return s
    .normalize('NFKD')                  // decomposes Réti → R + e + combining
    .replace(/[̀-ͯ]/g, '')    // strips combining diacritical marks
    .toLowerCase()
    // BEFORE stripping all apostrophes: kill the possessive 's so
    // "King's Gambit" / "Bird's Opening" / "Alekhine's Defense" all
    // collapse to forms that match the DB's apostrophe-less or
    // apostrophe-ful entries either way.
    .replace(/[‘’'`]s\b/g, '')
    .replace(/[‘’'`]/g, '')   // remaining apostrophes (straight + curly)
    .replace(/-/g, ' ')                 // hyphens to space
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}

/** Token-set match: does `target` contain every meaningful token
 *  from `query`? Used as the word-order-insensitive fallback.
 *  "Najdorf Sicilian" → tokens [najdorf, sicilian] both appear in
 *  "sicilian defense: najdorf variation" (tokens [sicilian, defense,
 *  najdorf, variation]). 2-letter tokens dropped to avoid false
 *  positives on "of", "to", etc. */
function tokensMatchTarget(query: string, target: string): boolean {
  const qNorm = normalizeNameForMatch(query);
  const tNorm = normalizeNameForMatch(target);
  const qTokens = qNorm.split(' ').filter((t) => t.length >= 3);
  if (qTokens.length === 0) return false;
  const tTokens = new Set(tNorm.split(' '));
  return qTokens.every((t) => tTokens.has(t));
}

/** Aliases for acronyms + common alt-names the DB doesn't index.
 *  Keys are lowercase normalized inputs; values are canonical names
 *  that DO exist in the DB. Pre-flight aliases the input before
 *  attempting match against the DB. */
const NAME_ALIASES: Record<string, string> = {
  kid: "King's Indian Defense",
  nid: 'Nimzo-Indian Defense',
  qid: "Queen's Indian Defense",
  qga: "Queen's Gambit Accepted",
  qgd: "Queen's Gambit Declined",
  'center counter': 'Scandinavian Defense',
  'centre counter': 'Scandinavian Defense',
  // Spelling variants the DB doesn't index under both forms.
  petroff: "Petrov's Defense",
  saemisch: 'Sämisch',
  // "Spanish" is the European name for Ruy Lopez — DB uses Ruy Lopez.
  spanish: 'Ruy Lopez',
  'spanish opening': 'Ruy Lopez',
  // The Vienna sub-line is spelled "Hamppe-Allgaier" in the DB
  // (double-p) but commonly written single-p in coaching books.
  'hampe-allgaier': 'Hamppe-Allgaier Gambit',
  'hampe allgaier': 'Hamppe-Allgaier Gambit',
  // Possessive forms typed without apostrophe. The DB inconsistently
  // uses apostrophes for some openings ("King's Gambit") and not for
  // others ("Bird Opening"), so a single normalization rule can't fix
  // both. Explicit aliases for the common no-apostrophe inputs:
  'kings gambit': "King's Gambit",
  'bishops opening': "Bishop's Opening",
  'queens gambit': "Queen's Gambit",
  'queens gambit accepted': "Queen's Gambit Accepted",
  'queens gambit declined': "Queen's Gambit Declined",
  'kings indian': "King's Indian Defense",
  'kings indian defense': "King's Indian Defense",
  'queens indian': "Queen's Indian Defense",
  'queens indian defense': "Queen's Indian Defense",
  'birds opening': 'Bird Opening',
  'bird opening': 'Bird Opening',
  "bird's opening": 'Bird Opening',
  'alekhines defense': 'Alekhine Defense',
  "alekhine's defense": 'Alekhine Defense',
};

export function getOpeningMoves(openingName: string): string[] | null {
  const entries = openingsData as OpeningEntry[];
  const trimmed = openingName.trim();
  if (!trimmed) return null;

  // Apply alias map first (KID → King's Indian Defense, etc.).
  const aliased = NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const queryNorm = normalizeNameForMatch(aliased);

  // 1. Exact match (case + diacritic + apostrophe + hyphen insensitive).
  //    "Kings Gambit" → matches "King's Gambit" entry.
  const exact = entries.filter(
    (e) => normalizeNameForMatch(e.name) === queryNorm,
  );
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (a.pgn.length > b.pgn.length ? a : b));
    return best.pgn.split(/\s+/).filter(Boolean);
  }

  // 2. Prefix match (normalized) — "Kings Indian" → "King's Indian
  //    Defense" / "King's Indian Attack".
  const prefix = entries.filter((e) =>
    normalizeNameForMatch(e.name).startsWith(queryNorm),
  );
  if (prefix.length > 0) {
    const bare = prefix.find((e) => normalizeNameForMatch(e.name) === queryNorm);
    const best = bare ?? prefix.reduce((a, b) => {
      if (a.name.length !== b.name.length) return a.name.length < b.name.length ? a : b;
      return a.pgn.length > b.pgn.length ? a : b;
    });
    return best.pgn.split(/\s+/).filter(Boolean);
  }

  // 3. Substring match (normalized).
  const sub = entries.filter((e) =>
    normalizeNameForMatch(e.name).includes(queryNorm),
  );
  if (sub.length > 0) {
    const best = sub.reduce((a, b) => {
      if (a.name.length !== b.name.length) return a.name.length < b.name.length ? a : b;
      return a.pgn.length > b.pgn.length ? a : b;
    });
    return best.pgn.split(/\s+/).filter(Boolean);
  }

  // 4. Token-set match — word-order-insensitive. "Najdorf Sicilian"
  //    matches "Sicilian Defense: Najdorf Variation" (tokens najdorf
  //    + sicilian both present, order doesn't matter).
  const tokenMatches = entries.filter((e) =>
    tokensMatchTarget(aliased, e.name),
  );
  if (tokenMatches.length === 0) return null;
  const best = tokenMatches.reduce((a, b) => {
    if (a.name.length !== b.name.length) return a.name.length < b.name.length ? a : b;
    return a.pgn.length > b.pgn.length ? a : b;
  });
  return best.pgn.split(/\s+/).filter(Boolean);
}

/** Find ALL Lichess-DB entries related to an opening name. Returns
 *  the bare main line PLUS every named variation / sub-line that
 *  shares an ECO code or whose PGN extends the bare line.
 *
 *  Used by the LLM-grounding flow: instead of asking the LLM to
 *  invent move sequences from training memory (which has been the
 *  cause of every "illegal SAN" error in production audits), we
 *  pass the DB-verified PGN sequences in as the source of truth.
 *  The LLM picks lines from this list and writes pedagogy on top.
 *
 *  Caps result length at maxEntries (default 30) — enough coverage
 *  without blowing the prompt token budget. Sorted by:
 *    1. Bare opening first (shortest PGN with an exact name match)
 *    2. Then sub-variations sorted by name length (broader names first) */
export function findRelatedDbEntries(
  openingName: string,
  maxEntries: number = 30,
): OpeningEntry[] {
  const entries = openingsData as OpeningEntry[];
  const lower = openingName.toLowerCase();

  // 1. Find the bare opening — exact name match prefers shortest PGN
  //    (the canonical entry; longest sub-variation otherwise).
  const exactMatches = entries.filter(
    (e) => e.name.toLowerCase() === lower,
  );
  const bare = exactMatches.length > 0
    ? exactMatches.reduce((a, b) => (a.pgn.length < b.pgn.length ? a : b))
    : null;

  // 2. Identify the ECO range from the bare entry.
  const ecoRoot = bare?.eco;

  // 3. Collect candidates by SUBSTRING match on name. The Lichess
  //    DB names sub-variations with the bare name as prefix (e.g.
  //    "Bishop's Opening: Boden-Kieseritzky Gambit"), so an exact
  //    substring match captures all sub-lines of the requested
  //    opening WITHOUT pulling in unrelated openings that just
  //    happen to share a token (e.g. token "bishop" would catch
  //    "Modern Defense: Bishop Attack" — wrong).
  const candidates = entries.filter((e) => {
    if (e === bare) return false; // listed separately first
    const nameLower = e.name.toLowerCase();
    if (nameLower.includes(lower)) return true;
    // Same-ECO PGN extension catches unnamed transpositions.
    if (
      ecoRoot &&
      e.eco === ecoRoot &&
      bare &&
      e.pgn.startsWith(bare.pgn + ' ')
    ) {
      return true;
    }
    return false;
  });

  // Dedupe by name — the Lichess DB often has the SAME variation
  // name listed at multiple depths (e.g. "Sicilian Defense: Open"
  // appears 4 times with progressively longer PGNs as the line
  // continues). Keep the shortest-PGN entry per name so we cover
  // more distinct variations within maxEntries.
  const byName = new Map<string, OpeningEntry>();
  for (const c of candidates) {
    const existing = byName.get(c.name);
    if (!existing || c.pgn.length < existing.pgn.length) {
      byName.set(c.name, c);
    }
  }
  const deduped = Array.from(byName.values());

  // Sort: shorter PGN first (trunk-near variations like 2.Nc3
  // come before deep sub-lines like Najdorf English Attack at
  // ply 12). Within same PGN length, shorter name first.
  deduped.sort((a, b) => {
    if (a.pgn.length !== b.pgn.length) return a.pgn.length - b.pgn.length;
    return a.name.length - b.name.length;
  });

  const result: OpeningEntry[] = [];
  if (bare) result.push(bare);
  for (const c of deduped) {
    if (result.length >= maxEntries) break;
    result.push(c);
  }
  return result;
}


/** A line-picker option: a named sub-variation the user can choose
 *  to focus the LLM gen on, with a style tag for color-coding. */
export interface LinePickerOption {
  /** Display label (e.g. "Najdorf Variation"). */
  label: string;
  /** Full opening name to send to the gen path (e.g. "Sicilian
   *  Defense: Najdorf Variation") — produces a specific deep-dive. */
  fullName: string;
  /** ECO code, shown as a small badge. */
  eco: string;
  /** Style tag matching one of the keys in neonColors.STYLE_COLORS
   *  ('sharp', 'solid', 'positional', 'tactical', 'gambit',
   *  'classical', 'hypermodern', 'aggressive', etc.). Drives tile
   *  glow color. */
  style: string;
  /** Move count (PGN plies) — surface as a "depth: N moves" hint. */
  pgnLength: number;
  /** Which side the student plays in this line. Driven by the
   *  PARENT opening's nature — defenses (Sicilian, French, Pirc,
   *  KID, etc.) and Black-named openings put the student as Black;
   *  everything else as White. The picker uses this to surface a
   *  small color/icon hint on each tile so the student knows which
   *  side they'll be playing before tapping in. */
  studentSide: 'white' | 'black';
  /** Which side actually "named" this variation per the Lichess DB
   *  PGN — i.e. who moved last in the canonical line. Independent
   *  of the parent opening's studentSide. Examples:
   *    - "Sicilian Defense: Najdorf Variation" (1.e4 c5 … 5...a6) →
   *      leadingSide=black (even ply count)
   *    - "Sicilian Defense: Alapin Variation" (1.e4 c5 2.c3) →
   *      leadingSide=white (odd ply count, White's deflection)
   *    - "Pirc Defense: Austrian Attack" (1.e4 d6 … 4.f4) →
   *      leadingSide=white (White's chosen attack against the Pirc)
   *  UI uses this to label each tile with a small W/B chip so the
   *  student can see whether they'll be following a same-side plan
   *  or learning to face an opposite-side attack. */
  leadingSide: 'white' | 'black';
}

/** Classify a variation's style from name keywords. Falls through to
 *  'classical' as the neutral default. Production heuristic — not
 *  authoritative, but good enough to color-code tiles distinctly so
 *  the user can recognize sharp vs solid lines at a glance.
 *
 *  Keys returned MUST exist in neonColors.STYLE_COLORS so the UI
 *  can look them up via getNeonColor(). */
export function classifyVariationStyle(name: string): string {
  const lower = name.toLowerCase();
  // Hardcoded mappings for major variations whose keyword would
  // misfire on the heuristic below.
  if (/\b(najdorf|dragon|sveshnikov|taimanov|sicilian|hampe.allgaier|frankenstein.dracula)\b/.test(lower)) {
    return 'sharp';
  }
  if (/\b(berlin|petrov|petroff|slav|london|exchange|caro.kann)\b/.test(lower)) {
    return 'solid';
  }
  if (/\b(catalan|qgd|queen'?s gambit declined|nimzo.indian|tarrasch)\b/.test(lower)) {
    return 'positional';
  }
  if (/\b(smith.morra|alapin|grand prix|fried liver)\b/.test(lower)) {
    return 'aggressive';
  }
  if (/\b(king'?s indian|grunfeld|grünfeld|benoni|benko|dutch|alekhine|pirc|modern)\b/.test(lower)) {
    return 'hypermodern';
  }
  if (/\b(scandinavian|center counter)\b/.test(lower)) {
    return 'classical';
  }
  // Heuristic by keyword in the variation suffix.
  if (/\bgambit\b/.test(lower)) return 'gambit';
  if (/\battack\b/.test(lower)) return 'aggressive';
  if (/\bclosed\b/.test(lower)) return 'positional';
  if (/\bopen\b/.test(lower)) return 'open';
  if (/\bclassical\b/.test(lower)) return 'classical';
  if (/\bmodern\b/.test(lower)) return 'hypermodern';
  if (/\bcounter|countergambit\b/.test(lower)) return 'tactical';
  return 'classical';
}

/** When the user types a BROAD opening name (e.g. "Sicilian", "French
 *  Defense", "King's Indian"), the LLM-gen path otherwise spreads the
 *  output budget across many variations and produces a shallow
 *  overview. The line picker intercepts this case: detect that the
 *  query matches a top-level opening with named sub-variations, and
 *  return those variations so the UI can ask the user which one to
 *  deep-dive on. The chosen variation gets the full token budget for
 *  real theoretical depth.
 *
 *  Returns null when:
 *    - The input isn't a broad opening (it's already a specific
 *      variation like "Najdorf Sicilian", or it doesn't resolve in
 *      the DB at all).
 *    - The DB has fewer than `minVariations` sub-variations for the
 *      input (not enough to make a picker worthwhile). */
export function findLinePickerOptions(
  query: string,
  minVariations: number = 5,
): { canonicalName: string; options: LinePickerOption[] } | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Resolve through the alias map first so "KID" / "Caro Kann" work.
  const aliased = NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const queryNorm = normalizeNameForMatch(aliased);

  // Find the BARE entry — broad opening typed exactly. We use
  // normalized matching so apostrophes / diacritics / hyphens don't
  // block it. Also accept the queryNorm as a strict prefix of the
  // bare name when it ends in "Defense" / "Game" / "Opening" — so
  // user typing "Sicilian" matches the bare "Sicilian Defense".
  // When multiple candidates match (e.g. "King's Indian Defense"
  // AND "King's Indian Attack" both strip to "kings indian"),
  // prefer Defense > Game > Opening > Attack (defense is the most
  // commonly-meant when a user types just the family name).
  const entries = openingsData as OpeningEntry[];
  const bareCandidates = entries.filter((e) => {
    const eNorm = normalizeNameForMatch(e.name);
    if (eNorm === queryNorm) return true;
    const eStripped = eNorm
      .replace(/\s+(defense|defence|game|opening|attack)$/i, '')
      .trim();
    return eStripped === queryNorm && !e.name.includes(':');
  });
  if (bareCandidates.length === 0) return null;
  const SUFFIX_PRIORITY = ['defense', 'defence', 'game', 'opening', 'attack', ''];
  const bareCandidate = bareCandidates.reduce((a, b) => {
    const ar = SUFFIX_PRIORITY.findIndex((s) =>
      a.name.toLowerCase().endsWith(s),
    );
    const br = SUFFIX_PRIORITY.findIndex((s) =>
      b.name.toLowerCase().endsWith(s),
    );
    return ar <= br ? a : b;
  });

  // The bare entry should be at low PGN depth (top-level opening).
  // If we matched something that's already a sub-variation deep in
  // the tree, the user already specified — no picker needed.
  const barePlies = bareCandidate.pgn.split(/\s+/).filter(Boolean).length;
  if (barePlies > 6 || bareCandidate.name.includes(':')) return null;

  // Enumerate sub-variations: entries whose name starts with
  // bareCandidate.name + ":" — those are the named children.
  const prefix = bareCandidate.name + ':';
  const children = entries.filter((e) => e.name.startsWith(prefix));

  // Dedupe by everything-after-the-colon (DB lists same variation at
  // multiple PGN depths). Keep shortest PGN per unique sub-name.
  // Also tally how many entries fall under each top-level sub-name —
  // a popularity proxy that surfaces real main lines (Najdorf, Dragon,
  // Sveshnikov) over obscure 4-ply sidelines (Brussels Gambit) which
  // would otherwise win on a pure trunk-distance sort.
  const byName = new Map<string, OpeningEntry>();
  const popularity = new Map<string, number>();
  for (const c of children) {
    const subName = c.name.slice(prefix.length).trim();
    // Only the FIRST sub-variation segment (split on ',' — DB nests
    // sub-sub-variations after a comma). "Najdorf Variation, English
    // Attack" becomes just "Najdorf Variation" for the picker.
    const topSub = subName.split(',')[0].trim();
    const fullName = `${bareCandidate.name}: ${topSub}`;
    popularity.set(topSub, (popularity.get(topSub) ?? 0) + 1);
    const existing = byName.get(topSub);
    if (!existing || c.pgn.length < existing.pgn.length) {
      byName.set(topSub, { ...c, name: fullName });
    }
  }

  // Determine which side the student plays for this opening family.
  // Driven by the PARENT name — defenses + Black-named openings put
  // the student as Black; everything else as White. We use the same
  // heuristic as the existing inferStudentSide so picker labels align
  // with the board orientation when the lesson actually loads.
  const parentLower = bareCandidate.name.toLowerCase();
  const isBlackOpening =
    /\bdefen[cs]e\b/.test(parentLower) ||
    /\b(sicilian|french|caro|pirc|modern|alekhine|scandinavian|king.s indian|queen.s indian|nimzo|grunfeld|grünfeld|benoni|benko|dutch|philidor|petroff|petrov|slav|two knights)\b/.test(parentLower);
  const studentSide: 'white' | 'black' = isBlackOpening ? 'black' : 'white';

  // Trust the Lichess DB: every named sub-variation in
  // openings-lichess.json is a real chess opening worth learning.
  // No filtering — both Black-led variations (Najdorf, Dragon) and
  // White-led variations (Austrian Attack vs Pirc, Closed vs Sicilian)
  // belong in the picker. Earlier builds tried to filter by ply-parity
  // and broke Pirc (all variations are White-led there). The user's
  // word: "use the Lichess DB to determine if the line is black or
  // white led" — i.e. trust what's in the DB and let the student pick.
  // Per-variation led-by is exposed via the leadingSide field below
  // so the UI can render a small W/B chip on each tile.
  const options: LinePickerOption[] = Array.from(byName.values())
    .map((e) => {
      const label = e.name.slice(prefix.length).trim();
      const pgnLength = e.pgn.split(/\s+/).filter(Boolean).length;
      // The actual led-by side from the variation's own PGN —
      // odd ply = White moved last, even = Black. Independent of
      // the parent opening's studentSide (which is parent-derived).
      const leadingSide: 'white' | 'black' = pgnLength % 2 === 1 ? 'white' : 'black';
      return {
        label,
        fullName: e.name,
        eco: e.eco,
        // Classify by the sub-variation label ALONE, not the full
        // "Parent: Sub" string. Otherwise "Sicilian Defense:
        // Alapin Variation" would inherit the parent's "sharp" tag
        // and every variation would be sharp. We want each tile
        // colored by ITS character, not the parent's.
        style: classifyVariationStyle(label),
        pgnLength,
        studentSide,
        leadingSide,
      };
    })
    // Sort by popularity descending (count of DB entries falling under
    // this top-level sub-name — a proxy that surfaces real main lines
    // like Najdorf / Dragon / Sveshnikov over 4-ply curiosities like
    // Brussels Gambit). Tie-break: shorter PGN first (trunk-near),
    // then alphabetically.
    .sort((a, b) => {
      const popA = popularity.get(a.label) ?? 0;
      const popB = popularity.get(b.label) ?? 0;
      if (popA !== popB) return popB - popA;
      if (a.pgnLength !== b.pgnLength) return a.pgnLength - b.pgnLength;
      return a.label.localeCompare(b.label);
    });

  if (options.length < minVariations) return null;

  // Cap at 15 options — beyond that the picker becomes overwhelming.
  // The 15 trunk-near variations cover what a 1200-1600 rated player
  // would reasonably encounter.
  const MAX_OPTIONS = 15;
  return {
    canonicalName: bareCandidate.name,
    options: options.slice(0, MAX_OPTIONS),
  };
}

/**
 * Given a requested opening's move list and the current game history,
 * return the next book move the AI should play, or null if we've left the book.
 * Only returns a move if it's the AI's turn according to the opening line.
 *
 * @param openingMoves - Full SAN move list for the opening (from getOpeningMoves)
 * @param gameHistory - Current game SAN history (from chess.js .history())
 * @param aiColor - 'white' | 'black' — which side the AI is playing
 */
export function getNextOpeningBookMove(
  openingMoves: string[],
  gameHistory: string[],
  aiColor: 'white' | 'black',
): string | null {
  const nextPly = gameHistory.length;

  // Check that all game moves so far match the opening line
  for (let i = 0; i < gameHistory.length; i++) {
    if (i >= openingMoves.length) return null; // Past the book
    if (gameHistory[i] !== openingMoves[i]) return null; // Deviated from book
  }

  // Check if the next move is in the book
  if (nextPly >= openingMoves.length) return null;

  // Check if it's the AI's turn (ply 0 = white, ply 1 = black, etc.)
  const isWhiteTurn = nextPly % 2 === 0;
  const isAiTurn = (aiColor === 'white' && isWhiteTurn) || (aiColor === 'black' && !isWhiteTurn);
  if (!isAiTurn) return null;

  return openingMoves[nextPly];
}

/** Reset cached trie (for testing). */
export function _resetTrie(): void {
  cachedTrie = null;
}
