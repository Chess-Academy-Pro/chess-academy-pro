/**
 * endgameService
 * --------------
 * Endgame teaching surface — same DB-as-brain spine as the rest of
 * Learn. Mating-pattern lessons combine:
 *
 *   1. Hand-crafted narration from `src/data/mating-patterns.json`
 *      (intro + recognition + history + tip per pattern). Voice-first
 *      prose authored by the developer; read aloud via Polly TTS at
 *      runtime. The LLM has zero authorial role here.
 *
 *   2. The Lichess puzzle DB (`src/data/puzzles.json`, 15K curated
 *      entries) as the practice corpus. Filtered by the pattern's
 *      `puzzleThemeTag` AND multi-move mate themes (mateIn2/3/4/5 —
 *      explicitly NOT mateIn1, per David's "user needs to practice
 *      setting them up from several moves out" directive).
 *
 * Volume: most popular patterns have 18-280 puzzles available. The
 * service returns ALL matching puzzles sorted by rating ascending so
 * the lesson opens with a difficulty ladder. Within each rating tier
 * we randomly shuffle so re-entry feels fresh — same difficulty
 * curve, different positions each session.
 */
import { Chess } from 'chess.js';
import matingPatternsData from '../data/mating-patterns.json';
import puzzlesData from '../data/puzzles.json';
import type {
  MatingPattern,
  MatingLessonPosition,
} from '../types/matingPattern';
import type {
  WalkthroughTree,
  WalkthroughTreeNode,
  WalkthroughTreeChild,
} from '../types/walkthroughTree';

interface RawPuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
  openingTags: string | string[] | null;
  popularity: number;
  nbPlays: number;
}

const MULTI_MOVE_MATE_THEMES = new Set([
  'mateIn2',
  'mateIn3',
  'mateIn4',
  'mateIn5',
]);

/** Difficulty tiers tied to puzzle rating bands. The tiering matches
 *  the rough Lichess rating distribution — Beginner is ~lowest 10%,
 *  Expert is ~top 10% — and gives the lesson a natural progression
 *  ramp instead of a flat "all mates" grind. */
export type EndgameTier = 'beginner' | 'intermediate' | 'advanced' | 'expert' | 'mixed';

const TIER_BANDS: Record<Exclude<EndgameTier, 'mixed'>, [number, number]> = {
  beginner: [0, 1100],
  intermediate: [1100, 1600],
  advanced: [1600, 2100],
  expert: [2100, 4000],
};

export function getAllPatterns(): MatingPattern[] {
  return matingPatternsData as MatingPattern[];
}

export function getPatternById(id: string): MatingPattern | null {
  const found = (matingPatternsData as MatingPattern[]).find((p) => p.id === id);
  return found ?? null;
}

/** The recognition position is the first lessonPosition with
 *  movesToMate === 1 — the "what does the finished pattern look like"
 *  diagnostic shown briefly while the intro narration plays. */
export function getRecognitionPosition(
  pattern: MatingPattern,
): MatingLessonPosition | null {
  return pattern.lessonPositions.find((p) => p.movesToMate === 1) ?? null;
}

interface PracticePuzzleOptions {
  /** Difficulty tier. 'mixed' returns all available puzzles regardless
   *  of rating, ascending. Default 'mixed'. */
  tier?: EndgameTier;
  /** Random seed for the within-tier shuffle. Pass a session-stable
   *  value (e.g. timestamp) so the same student in the same session
   *  sees a stable order; pass a fresh value on re-entry to surface
   *  unseen puzzles. */
  seed?: number;
  /** Cap on puzzles returned. Default unlimited — caller can paginate. */
  limit?: number;
  /** Minimum popularity. Default 50 — filters out the weirdest
   *  community-flagged puzzles without being too picky. */
  minPopularity?: number;
  /** Minimum number of plays. Default 80 — protects against
   *  novelty / under-tested entries. */
  minPlays?: number;
}

/** Return all practice puzzles for a pattern from the Lichess puzzle
 *  DB, filtered to multi-move mates only (David's directive: setups,
 *  not mate-in-1 recognition). Sorted by rating ascending so the
 *  lesson begins with the easiest puzzles in the chosen tier; within
 *  each rating bucket the order is randomized via a seeded shuffle so
 *  re-entry surfaces different positions even at the same difficulty.
 */
export function getPracticePuzzles(
  pattern: MatingPattern,
  options: PracticePuzzleOptions = {},
): RawPuzzle[] {
  const tier = options.tier ?? 'mixed';
  const minPopularity = options.minPopularity ?? 50;
  const minPlays = options.minPlays ?? 80;
  const seed = options.seed ?? Date.now();
  const themeTag = pattern.puzzleThemeTag;
  // No Lichess theme tag → no practice corpus available for this
  // pattern. Returning [] instead of falling back to the full
  // multi-move mate corpus prevents misleading 2,653-puzzle "Légal's
  // Mate" sets that contain zero actual Légal positions. Patterns
  // without tags (Damiano, Lolli, Anderssen, Réti, Légal, Triangle,
  // and all piece-mate fundamentals) surface as recognition-only in
  // the UI; future work can hand-curate puzzle sets for them.
  if (!themeTag) return [];
  const puzzles = puzzlesData as RawPuzzle[];

  const matching = puzzles.filter((p) => {
    if (!p.themes.includes(themeTag)) return false;
    if (!p.themes.some((t) => MULTI_MOVE_MATE_THEMES.has(t))) return false;
    if (p.popularity < minPopularity) return false;
    if (p.nbPlays < minPlays) return false;
    if (tier !== 'mixed') {
      const [min, max] = TIER_BANDS[tier];
      if (p.rating < min || p.rating >= max) return false;
    }
    return true;
  });

  // Sort: rating ascending (difficulty ladder). Within a rating band
  // (puzzles within ±50 of each other), shuffle deterministically by
  // seed so re-entry surfaces a different ordering at the same tier.
  matching.sort((a, b) => {
    const bucketA = Math.floor(a.rating / 50);
    const bucketB = Math.floor(b.rating / 50);
    if (bucketA !== bucketB) return bucketA - bucketB;
    // Within the same 50-rating bucket, deterministic-shuffle by seed.
    const hashA = mulberryHash(seed, a.id);
    const hashB = mulberryHash(seed, b.id);
    return hashA - hashB;
  });

  if (options.limit && matching.length > options.limit) {
    return matching.slice(0, options.limit);
  }
  return matching;
}

/** Compact deterministic hash — Mulberry32-style integer mixing.
 *  Used to seed the within-tier shuffle so each session has a stable
 *  but different order from the last. */
function mulberryHash(seed: number, key: string): number {
  let h = seed | 0;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return h ^ (h >>> 16);
}

interface BuildLessonOptions {
  /** Difficulty tier. Default 'beginner' — the lesson opens with the
   *  easiest puzzles and progresses up. Caller can override per
   *  re-entry (e.g. 'intermediate' for a returning student). */
  tier?: EndgameTier;
  /** Session seed for within-tier shuffle. */
  seed?: number;
  /** Zero-based index into the practice corpus. The page renders
   *  one puzzle per lesson and bumps this index on "Practice more"
   *  to advance through the difficulty ladder. */
  puzzleIndex?: number;
  /** Specific Lichess puzzle ID to build the tree from — bypasses
   *  the tier+index lookup entirely. Used by the adaptive drill
   *  flow where the puzzle is chosen by the adaptive session.
   *  When set and the id resolves, tier/seed/puzzleIndex are
   *  ignored. */
  specificPuzzleId?: string;
}

/** Convert a UCI move ("e2e4", "e7e8q") to SAN by playing it on the
 *  given Chess instance. Mutates `chess`. Returns null if illegal. */
function uciToSan(chess: Chess, uci: string): string | null {
  if (uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  try {
    const move = chess.move({ from, to, promotion });
    return move.san;
  } catch {
    return null;
  }
}

/** Score a candidate distractor SAN — captures, checks, and central
 *  knight/bishop development rank high; edge pawn shuffles and king
 *  moves rank low. Same scoring used by the punish-stage inversion. */
function scoreDistractor(san: string): number {
  let score = 0;
  if (san.includes('x')) score += 3;
  if (san.includes('+') || san.includes('#')) score += 2;
  if (/^[NB]/.test(san)) {
    const dest = san.match(/[a-h][1-8]/g)?.slice(-1)[0];
    if (dest) {
      const file = dest[0];
      const rank = parseInt(dest[1], 10);
      if (['d', 'e'].includes(file) && rank >= 3 && rank <= 6) score += 2;
      else if (['c', 'd', 'e', 'f'].includes(file)) score += 1;
      else if (['a', 'h'].includes(file)) score -= 1;
    }
  }
  if (/^K[a-h]/.test(san) && !san.startsWith('O-O')) score -= 2;
  if (/^[ah][2-7]$/.test(san)) score -= 2;
  return score;
}

interface PreparedPuzzle {
  startFen: string;
  studentSans: string[];
  opponentSans: string[];
  rating: number;
  movesToMate: number;
}

/** Walk a Lichess puzzle into a clean find-the-mate skeleton.
 *  - puzzle.fen is the position before the OPPONENT's setup move.
 *  - puzzle.moves[0] is the opponent's last move (auto-played).
 *  - puzzle.moves[1] is the first move the student must find.
 *  - Subsequent odd-indexed moves are student moves; even ones are
 *    opponent's forced replies (auto-played in the runtime).
 *  Returns null if the UCI sequence doesn't replay cleanly. */
function preparePuzzleForLesson(p: RawPuzzle): PreparedPuzzle | null {
  const ucis = p.moves.split(/\s+/).filter(Boolean);
  if (ucis.length < 2) return null;
  const chess = new Chess(p.fen);
  // Apply opponent's setup move.
  const setupSan = uciToSan(chess, ucis[0]);
  if (!setupSan) return null;
  const startFen = chess.fen();
  const studentSans: string[] = [];
  const opponentSans: string[] = [];
  // Alternate: ucis[1] = student, ucis[2] = opponent, ucis[3] = student, ...
  for (let i = 1; i < ucis.length; i += 1) {
    const san = uciToSan(chess, ucis[i]);
    if (!san) return null;
    if ((i - 1) % 2 === 0) studentSans.push(san);
    else opponentSans.push(san);
  }
  if (studentSans.length === 0) return null;
  return {
    startFen,
    studentSans,
    opponentSans,
    rating: p.rating,
    movesToMate: studentSans.length,
  };
}

/** Pick 2-3 distractor SANs at the given FEN, excluding the puzzle
 *  solution. Tempting alternatives (captures, checks, central
 *  developing moves) score highest. */
function pickDistractors(fen: string, correctSan: string): string[] {
  try {
    const probe = new Chess(fen);
    const legal = probe.moves();
    const candidates = legal
      .filter((s) => s !== correctSan)
      .map((s) => ({ san: s, score: scoreDistractor(s) }))
      .sort((a, b) => b.score - a.score);
    return candidates.slice(0, 3).map((c) => c.san);
  } catch {
    return [];
  }
}

/** Build a single-puzzle find-the-mate lesson for a mating pattern.
 *  The walkthrough engine can't replay across FEN jumps, so we do
 *  one puzzle per tree. The page advances the puzzleIndex and
 *  rebuilds the tree to chain multiple puzzles in a session.
 *
 *  Tree shape:
 *    - startFen = puzzle position right before the student's first move
 *    - root → fork (correct mating move + 2-3 chess.js distractors)
 *      - correct → opponent's forced reply → next fork → ... → mate (leaf)
 *      - each distractor → leaf with "not the mate, try again" outro
 *
 *  Intro narration combines the hand-crafted geometry/recognition/
 *  history/tip prose from `mating-patterns.json`. Read aloud once
 *  at lesson start via the existing voiceService.
 *
 *  Returns null when no practice puzzles are available in any tier
 *  for this pattern (untagged patterns surface as recognition-only
 *  in the UI rather than calling this builder). */
export function buildMatingPatternLesson(
  pattern: MatingPattern,
  options: BuildLessonOptions = {},
): { tree: WalkthroughTree; puzzleIndex: number; totalAvailable: number; rating: number; movesToMate: number } | null {
  const tier = options.tier ?? 'beginner';
  const seed = options.seed ?? Date.now();
  const puzzleIndex = options.puzzleIndex ?? 0;
  let rawPuzzle: RawPuzzle | undefined;
  let candidates: RawPuzzle[] = [];
  let wrappedIndex = 0;

  if (options.specificPuzzleId) {
    // Adaptive flow: caller has already chosen a specific puzzle.
    // Look it up in the full pattern pool (mixed tier so we don't
    // exclude it on rating-band grounds).
    candidates = getPracticePuzzles(pattern, { tier: 'mixed', seed });
    rawPuzzle = candidates.find((p) => p.id === options.specificPuzzleId);
    wrappedIndex = rawPuzzle ? candidates.indexOf(rawPuzzle) : 0;
  }
  if (!rawPuzzle) {
    // Tier fallback: if the requested tier has no puzzles, walk up.
    const tierOrder: EndgameTier[] = tier === 'mixed'
      ? ['mixed']
      : [tier, 'intermediate', 'advanced', 'expert', 'mixed'];
    for (const t of tierOrder) {
      candidates = getPracticePuzzles(pattern, { tier: t, seed });
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) return null;
    // Wrap puzzleIndex around so the user can keep tapping "Practice
    // more" indefinitely without running out.
    wrappedIndex = puzzleIndex % candidates.length;
    rawPuzzle = candidates[wrappedIndex];
  }
  const puzzle = preparePuzzleForLesson(rawPuzzle);
  if (!puzzle) {
    // Try the next one if this puzzle had a UCI parse error.
    return buildMatingPatternLesson(pattern, {
      ...options,
      puzzleIndex: puzzleIndex + 1,
    });
  }

  const studentSide: 'white' | 'black' =
    new Chess(puzzle.startFen).turn() === 'w' ? 'white' : 'black';
  const opponentSide: 'white' | 'black' = studentSide === 'white' ? 'black' : 'white';

  // Build the find-the-mate move-chain from the END backwards. The
  // last student move is mate; preceding moves alternate with the
  // opponent's forced replies which auto-animate (single-child
  // straight-line nodes with brief narration).
  let chainTail: WalkthroughTreeChild[] = [];
  for (let i = puzzle.studentSans.length - 1; i >= 0; i -= 1) {
    const correctSan = puzzle.studentSans[i];
    const isMatingMove = i === puzzle.studentSans.length - 1;
    // FEN at this prompt: replay setup + first i student/opponent move pairs.
    const probe = new Chess(puzzle.startFen);
    for (let j = 0; j < i; j += 1) {
      probe.move(puzzle.studentSans[j]);
      if (j < puzzle.opponentSans.length) probe.move(puzzle.opponentSans[j]);
    }
    const promptFen = probe.fen();

    // Opponent reply chains as a single-child sequel after the
    // correct move (skipped on the mating move).
    let afterCorrect: WalkthroughTreeChild[] = chainTail;
    if (i < puzzle.opponentSans.length) {
      const oppSan = puzzle.opponentSans[i];
      afterCorrect = [
        {
          node: {
            san: oppSan,
            movedBy: opponentSide,
            // Empty idea — the board's auto-played reply is self-evident
            // and the prior "X — the only legal reply." voice line was
            // heard on every opponent move, which got annoying fast.
            idea: '',
            children: chainTail,
          },
        },
      ];
    }

    const distractorSans = pickDistractors(promptFen, correctSan);
    // Correct child — empty narration on non-mating moves, brief
    // "Mate." on the final move. The board's piece-move is the
    // signal; voice repetition adds noise, not value.
    const correctChild: WalkthroughTreeChild = {
      label: correctSan,
      forkSubtitle: isMatingMove ? 'Mate' : 'Right move — keep the sequence going',
      node: {
        san: correctSan,
        movedBy: studentSide,
        // Mating-move cue: just name the pattern. Previously
        // "{san} — checkmate. The {pattern.name} pattern completes."
        // — three sentences for one payoff. The pattern name IS
        // the educational moment; everything else is filler.
        // Per CLAUDE.md narration voice rules.
        idea: isMatingMove ? `${pattern.name}.` : '',
        children: afterCorrect,
      },
    };
    // Distractors are dead-end leaves with a brief incorrect cue.
    // Previous prose "X is legal but doesn't deliver the {pattern}.
    // Tap a different move." was voiced on every wrong attempt and
    // got irritating; "Try again." is the same info, said once.
    const distractorChildren: WalkthroughTreeChild[] = distractorSans.map((d) => ({
      label: d,
      forkSubtitle: 'Not the mate',
      node: {
        san: d,
        movedBy: studentSide,
        idea: 'Try again.',
        children: [],
      },
    }));
    // Sort the fork children alphabetically by label so the correct
    // move isn't always at index 0 (anti-tell measure shared with
    // the punish stage's fork rendering).
    const forkChildren = [correctChild, ...distractorChildren].sort((a, b) =>
      (a.label ?? '').localeCompare(b.label ?? ''),
    );
    chainTail = forkChildren;
  }

  // Intro: combine the hand-crafted prose into one read-aloud script.
  const introParts = [
    pattern.narration.intro,
    pattern.narration.recognition,
    pattern.narration.history,
    pattern.narration.tip,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  // Only narrate the full intro on the first puzzle of a session;
  // subsequent puzzles get a brief "next position" lead-in.
  const isFirstOfSession = puzzleIndex === 0;
  const intro = isFirstOfSession
    ? introParts.join(' ')
    : `Next position — ${pattern.name}, mate in ${puzzle.movesToMate}.`;
  // Outro: just name the pattern. The previous version embedded UI
  // references ("Tap Practice more...") into the spoken script,
  // which violates the voice rule that the narrator never references
  // the interface. CLAUDE.md narration voice rules.
  const outro = `That's ${pattern.name}.`;

  const root: WalkthroughTreeNode = {
    san: null,
    movedBy: null,
    idea: '',
    children: chainTail,
  };

  const tree: WalkthroughTree = {
    openingName: pattern.name,
    eco: '',
    studentSide,
    startFen: puzzle.startFen,
    intro,
    outro,
    root,
  };

  return {
    tree,
    puzzleIndex: wrappedIndex,
    totalAvailable: candidates.length,
    rating: puzzle.rating,
    movesToMate: puzzle.movesToMate,
  };
}

/** Counts of available practice puzzles per pattern, for the picker
 *  UI to show "X positions, increasing difficulty". Cheap — runs
 *  once at module load. */
let _puzzleCountCache: Map<string, number> | null = null;
export function getPracticePuzzleCount(pattern: MatingPattern): number {
  if (!_puzzleCountCache) {
    _puzzleCountCache = new Map();
    const all = getAllPatterns();
    for (const p of all) {
      _puzzleCountCache.set(
        p.id,
        getPracticePuzzles(p, { seed: 0, minPopularity: 50, minPlays: 80 }).length,
      );
    }
  }
  return _puzzleCountCache.get(pattern.id) ?? 0;
}
