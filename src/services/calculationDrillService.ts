/**
 * calculationDrillService
 * -----------------------
 * Filters the local Lichess puzzle DB (`puzzles.json`, 15K curated)
 * by theme tags for the six calculation skill drills:
 *   1. Find the Mate (mateIn2/3/4/5)
 *   2. Quiet Move (winning move isn't a check/capture)
 *   3. Forcing Sequence (long-calculation puzzles)
 *   4. Defensive Calc (find the only defense)
 *   5. Race Calculation (pawn races + promotion)
 *   6. Tactical Pattern (sacrifice / attraction / deflection)
 *
 * Same architectural contract as everywhere else — moves come from
 * the puzzle DB, the runtime LLM is voice-only. Each drill returns
 * up to N puzzles sorted by rating ascending so the difficulty
 * ladder opens easy and ramps up.
 *
 * Per-skill puzzle counts confirmed at build time via the test
 * suite — every skill must have ≥50 puzzles to be useful.
 */
import puzzlesData from '../data/puzzles.json';

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

const PUZZLES = puzzlesData as RawPuzzle[];

/** A single calculation skill drill — what the picker tile shows. */
export interface CalculationSkill {
  /** URL-safe slug, used as cache key + route param. */
  id: string;
  /** Display name on the tile. */
  name: string;
  /** One-line description of what the skill teaches. */
  description: string;
  /** Hand-authored "why this matters" text — the lesson layer
   *  before the drill starts. */
  rationale: string;
  /** Lichess puzzle DB theme tags this drill filters by. ANY-of
   *  match — a puzzle qualifies if it has at least one of these
   *  themes. */
  themes: string[];
  /** Optional: themes to EXCLUDE. Used to keep mate-in-1 puzzles
   *  out of multi-move-mate drills, etc. */
  excludeThemes?: string[];
}

const SKILLS: CalculationSkill[] = [
  {
    id: 'find-the-mate',
    name: 'Find the Mate',
    description: 'Calculate forced mating sequences — depth ladder from mate-in-2 up.',
    rationale:
      "Mate is the cleanest calculation training ground: every move is forced, every variation ends in mate or doesn't. Start at mate-in-2 (4 plies of calculation), graduate to 3, 4, and 5. Each rank up the ladder doubles the calculation tree — the same skill, more depth.",
    themes: ['mateIn2', 'mateIn3', 'mateIn4', 'mateIn5'],
    excludeThemes: ['mateIn1'],
  },
  {
    id: 'quiet-move',
    name: 'Quiet Move',
    description: "The winning move isn't a check or a capture. Look harder.",
    rationale:
      "Most amateurs only consider checks and captures when calculating. Quiet-move puzzles break that habit — the right move is positional, sometimes a retreat, sometimes a king move that creates a multi-move threat. Drill these and you'll start seeing winning moves your opponent doesn't.",
    themes: ['quietMove'],
  },
  {
    id: 'forcing-sequence',
    name: 'Forcing Sequence',
    description: 'Long forced lines — calculate four plies in a row without losing the thread.',
    rationale:
      "Calculation depth is a stamina muscle. These puzzles require seeing 4-8 plies of forced play to find the win — every move forces a single response, and you need to track the tree without flinching. Lichess tags these as 'long' precisely because they reward the calculator who doesn't quit at move 3.",
    themes: ['long'],
  },
  {
    id: 'defensive-calc',
    name: 'Defensive Calc',
    description: 'Find the only move that holds. Defense is calculation under pressure.',
    rationale:
      "Defensive puzzles are easier to play once you find the move — but harder to find. Every other candidate loses immediately; only one move works. Drill these to build the precision needed in lost-on-paper positions where one half-step saves the game.",
    themes: ['defensiveMove'],
  },
  {
    id: 'race-calculation',
    name: 'Race Calculation',
    description: 'Pawn races and promotions — count tempi, decide who wins.',
    rationale:
      "When both sides race pawns to promote, the position is decided by exact tempo math: who promotes first, who promotes with check, who can stop the other. These puzzles drill the counting muscle directly, with the answer always concrete (the pawn either queens or it doesn't).",
    themes: ['advancedPawn', 'promotion'],
  },
  {
    id: 'tactical-pattern',
    name: 'Tactical Pattern',
    description: 'Recognize the motif (sacrifice / attraction / deflection), then calculate the line.',
    rationale:
      "Tactics aren't pure calculation — they're pattern recognition followed by calculation. A sacrifice is a calculated investment; an attraction lures the king; a deflection breaks a defender. Drill the named patterns and your calculation gets a head start: you know what shape you're calculating before you start counting.",
    themes: ['sacrifice', 'attraction', 'deflection'],
  },
];

/** All available calculation skills — picker tile data. */
export function getCalculationSkills(): CalculationSkill[] {
  return SKILLS;
}

/** Look up a skill by slug. Returns null when no match. */
export function getCalculationSkillById(id: string): CalculationSkill | null {
  return SKILLS.find((s) => s.id === id) ?? null;
}

interface DrillOptions {
  /** How many puzzles to return. Defaults to 5 — enough for a
   *  short focused drill without grinding. */
  limit?: number;
  /** Minimum popularity (Lichess puzzle popularity score, range
   *  -100..+100). Defaults to 50 — filters out novelty / under-
   *  tested puzzles. */
  minPopularity?: number;
  /** Minimum number of plays. Defaults to 80. */
  minPlays?: number;
  /** Deterministic shuffle seed for the within-rating-band order.
   *  Same seed = same puzzle order, so re-entry is reproducible. */
  seed?: number;
}

/** Get drill puzzles for a calculation skill — filtered by the
 *  skill's theme set, popularity-floor gated, sorted by rating
 *  ascending so the drill opens easy and ramps up.
 *
 *  Within each 50-rating bucket, the order is shuffled
 *  deterministically by seed so re-entry feels fresh at the same
 *  difficulty. */
export function getDrillPuzzles(
  skillId: string,
  options: DrillOptions = {},
): RawPuzzle[] {
  const skill = getCalculationSkillById(skillId);
  if (!skill) return [];
  const limit = options.limit ?? 5;
  const minPopularity = options.minPopularity ?? 50;
  const minPlays = options.minPlays ?? 80;
  const seed = options.seed ?? Date.now();
  const themeSet = new Set(skill.themes);
  const excludeSet = new Set(skill.excludeThemes ?? []);
  const matching = PUZZLES.filter((p) => {
    if (p.popularity < minPopularity) return false;
    if (p.nbPlays < minPlays) return false;
    if (skill.excludeThemes && p.themes.some((t) => excludeSet.has(t))) return false;
    return p.themes.some((t) => themeSet.has(t));
  });
  matching.sort((a, b) => {
    const bucketA = Math.floor(a.rating / 50);
    const bucketB = Math.floor(b.rating / 50);
    if (bucketA !== bucketB) return bucketA - bucketB;
    // Within bucket: deterministic shuffle by seed.
    const ha = mulberryHash(seed, a.id);
    const hb = mulberryHash(seed, b.id);
    return ha - hb;
  });
  return matching.slice(0, limit);
}

/** Total puzzle count available for a skill — used by the picker
 *  to surface "X puzzles available" on the tile. */
export function getDrillPuzzleCount(skillId: string): number {
  return getDrillPuzzles(skillId, { limit: 100000, minPopularity: 50, minPlays: 80 }).length;
}

/** Fast deterministic hash for shuffle stability. Mulberry32-style
 *  PRNG seeded by (sessionSeed XOR id-hash). */
function mulberryHash(seed: number, id: string): number {
  let s = seed >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    s = (s + id.charCodeAt(i)) >>> 0;
    s = Math.imul(s ^ (s >>> 15), s | 1);
  }
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
