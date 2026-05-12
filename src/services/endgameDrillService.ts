/**
 * endgameDrillService
 * -------------------
 * Mines the local Lichess puzzle DB for drill positions per
 * endgame lesson. Same architectural contract as everywhere else:
 *
 *   - Positions and moves come from `src/data/puzzles.json` (15K
 *     curated Lichess puzzles). Every FEN is real, every move is
 *     verified by Lichess.
 *   - Each lesson's drill set is filtered by its `practiceThemes`
 *     (Lichess theme tags like `pawnEndgame`, `rookEndgame`,
 *     `zugzwang`, ...) plus quality floors.
 *   - The puzzle's UCI move list is converted to SAN by chess.js
 *     so the playout runner can verify student moves directly.
 *
 * The runtime LLM is not consulted. The DB IS the brain.
 *
 * Drills augment the hand-authored keystones — they're not a
 * replacement. The keystone introduces the technique with a
 * named theoretical position; the drills test the same technique
 * in different geometries from real games.
 */
import { Chess } from 'chess.js';
import puzzlesData from '../data/puzzles.json';
import type { EndgameLesson, EndgameLessonPosition } from '../types/endgameLesson';

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

/** Difficulty tier for the per-lesson drill picker. Each tier maps to
 *  a Lichess-rating band; the student picks one to scope the drill
 *  pool. 'mixed' returns drills across all bands sorted asc — the
 *  default before the student narrows their target. */
export type DrillTier = 'beginner' | 'intermediate' | 'advanced' | 'mixed';

const TIER_BANDS: Record<Exclude<DrillTier, 'mixed'>, [number, number]> = {
  beginner: [0, 1300],
  intermediate: [1300, 1700],
  advanced: [1700, 4000],
};

interface DrillOptions {
  /** Max drill positions to return per lesson. Default 3 — gives
   *  each lesson a 4-6 position depth (1-2 keystones + 3 drills)
   *  without overwhelming the picker. */
  limit?: number;
  /** Minimum popularity — filters out novelty puzzles. */
  minPopularity?: number;
  /** Minimum plays — filters under-tested puzzles. */
  minPlays?: number;
  /** Difficulty tier. Maps to a rating band per TIER_BANDS. Default
   *  'mixed' — no rating filter. */
  tier?: DrillTier;
  /** Direct rating-band override. Takes precedence over `tier`. */
  ratingBand?: [number, number];
  /** Deterministic shuffle seed for within-rating-band ordering.
   *  Same seed = same drill order. */
  seed?: number;
}

/** Convert a UCI move (e2e4 / e7e8q) to SAN at the given position.
 *  Mutates the chess.js instance. Returns null on illegal. */
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

/** Build an EndgameLessonPosition from a Lichess puzzle by applying
 *  the puzzle's "setup move" (UCI[0]) to its starting FEN, then
 *  converting the remaining UCI sequence into SAN moves. The first
 *  remaining move is the student's solution; alternating moves are
 *  opponent replies.
 *
 *  Returns null when the UCI sequence doesn't replay cleanly. */
function puzzleToLessonPosition(p: RawPuzzle, _lessonName: string): EndgameLessonPosition | null {
  const ucis = p.moves.split(/\s+/).filter(Boolean);
  if (ucis.length < 2) return null;
  const chess = new Chess(p.fen);
  // Apply setup move — the position after this is what the student sees.
  const setupSan = uciToSan(chess, ucis[0]);
  if (!setupSan) return null;
  const startFen = chess.fen();
  const sanSequence: string[] = [];
  for (let i = 1; i < ucis.length; i += 1) {
    const san = uciToSan(chess, ucis[i]);
    if (!san) return null;
    sanSequence.push(san);
  }
  if (sanSequence.length === 0) return null;
  // Student plays sanSequence[0]. Their side is the side to move
  // in startFen.
  const studentSide = startFen.split(' ')[1] === 'w' ? 'white' : 'black';
  // A successful Lichess puzzle solution means the student wins
  // material/mates from this position. So the side to move (=
  // student) is winning — except when the puzzle's theme set
  // explicitly includes 'drawn'-style themes (which would surface
  // as a draw position rather than a win).
  const result: EndgameLessonPosition['result'] =
    studentSide === 'white' ? 'white-wins' : 'black-wins';
  return {
    fen: startFen,
    // Short, non-templated title. Used to be "Drill — rating XXXX"
    // which voiced as "Drill, rating fourteen hundred" on every
    // single drill; got monotonous fast. The rating already
    // surfaces in the source citation below.
    title: 'Drill',
    // No prose explanation — the position itself is the lesson at
    // this point; the previous "{Side} to play. Play the N-move
    // sequence from {lesson} — every move is forced." was voiced
    // verbatim across every DB-sourced drill and tuned out.
    explanation: '',
    result,
    bestMove: sanSequence[0],
    solution: sanSequence,
    source: `Lichess puzzle #${p.id} (rating ${p.rating})`,
  };
}

/** Return drill positions for a lesson, sourced from the Lichess
 *  puzzle DB and filtered by the lesson's `practiceThemes`.
 *
 *  Empty array when the lesson has no `practiceThemes`, no
 *  matching puzzles, or all matching puzzles fail to convert
 *  cleanly to SAN. The runtime should handle empty drill sets
 *  gracefully — the lesson still works with its keystones. */
export function getDrillPositionsForLesson(
  lesson: EndgameLesson,
  options: DrillOptions = {},
): EndgameLessonPosition[] {
  const themes = lesson.practiceThemes ?? [];
  if (themes.length === 0) return [];
  const limit = options.limit ?? 3;
  const minPopularity = options.minPopularity ?? 50;
  const minPlays = options.minPlays ?? 80;
  const seed = options.seed ?? 0;
  const themeSet = new Set(themes);

  // Resolve the rating band — explicit `ratingBand` override wins,
  // otherwise the tier maps to a band, otherwise unbounded.
  const tier = options.tier ?? 'mixed';
  const band: [number, number] | null = options.ratingBand
    ?? (tier !== 'mixed' ? TIER_BANDS[tier] : null);

  const matching = PUZZLES.filter((p) => {
    if (p.popularity < minPopularity) return false;
    if (p.nbPlays < minPlays) return false;
    if (band) {
      const [min, max] = band;
      if (p.rating < min || p.rating >= max) return false;
    }
    return p.themes.some((t) => themeSet.has(t));
  });

  // Sort: rating ascending so the easiest drill comes first.
  // Within a 100-rating bucket, deterministic-shuffle by seed.
  matching.sort((a, b) => {
    const bucketA = Math.floor(a.rating / 100);
    const bucketB = Math.floor(b.rating / 100);
    if (bucketA !== bucketB) return bucketA - bucketB;
    const ha = mulberryHash(seed, a.id);
    const hb = mulberryHash(seed, b.id);
    return ha - hb;
  });

  // Convert puzzles to lesson positions; skip any that fail to
  // replay (defensive — the build-time invariant should keep this
  // empty in practice).
  const out: EndgameLessonPosition[] = [];
  for (const puzzle of matching) {
    if (out.length >= limit) break;
    const pos = puzzleToLessonPosition(puzzle, lesson.name);
    if (pos) out.push(pos);
  }
  return out;
}

/** Pick a single drill position at (approximately) the given
 *  target rating, excluding any puzzles already played. Used by
 *  the adaptive-difficulty session: after each drill, the host
 *  passes the current target + played-ids, and we hand back the
 *  closest-to-target unplayed puzzle.
 *
 *  Tolerance starts tight (±50 cp) and widens progressively until
 *  a candidate is found. Returns null only when the entire theme
 *  pool is exhausted. */
export function getPuzzleAtRating(
  lesson: EndgameLesson,
  targetRating: number,
  excludeIds: ReadonlySet<string>,
  options: { minPopularity?: number; minPlays?: number } = {},
): EndgameLessonPosition | null {
  const themes = lesson.practiceThemes ?? [];
  if (themes.length === 0) return null;
  const minPopularity = options.minPopularity ?? 50;
  const minPlays = options.minPlays ?? 80;
  const themeSet = new Set(themes);

  // Eligible pool — theme match + popularity floor + not already played.
  const eligible = PUZZLES.filter((p) => {
    if (excludeIds.has(p.id)) return false;
    if (p.popularity < minPopularity) return false;
    if (p.nbPlays < minPlays) return false;
    return p.themes.some((t) => themeSet.has(t));
  });
  if (eligible.length === 0) return null;

  // Pick the unplayed puzzle whose rating is closest to target.
  let best: RawPuzzle | null = null;
  let bestDistance = Infinity;
  for (const p of eligible) {
    const d = Math.abs(p.rating - targetRating);
    if (d < bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  if (!best) return null;
  return puzzleToLessonPosition(best, lesson.name);
}

/** Total available drill puzzle count for a lesson — used by the
 *  picker to surface "X drills available" on the tile. Pass a
 *  tier to count only that tier's pool. */
export function getDrillPuzzleCount(lesson: EndgameLesson, tier: DrillTier = 'mixed'): number {
  const themes = lesson.practiceThemes ?? [];
  if (themes.length === 0) return 0;
  const themeSet = new Set(themes);
  const band: [number, number] | null = tier !== 'mixed' ? TIER_BANDS[tier] : null;
  let count = 0;
  for (const p of PUZZLES) {
    if (p.popularity < 50) continue;
    if (p.nbPlays < 80) continue;
    if (band) {
      const [min, max] = band;
      if (p.rating < min || p.rating >= max) continue;
    }
    if (p.themes.some((t) => themeSet.has(t))) count += 1;
  }
  return count;
}

/** Deterministic hash for shuffle stability. */
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
