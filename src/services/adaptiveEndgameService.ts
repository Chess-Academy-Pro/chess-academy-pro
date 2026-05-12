/**
 * adaptiveEndgameService
 * ----------------------
 * Adaptive difficulty for endgame puzzles. Reuses the same
 * convention as the puzzle-trainer tab (adaptivePuzzleService +
 * puzzleService.calculateRatingDelta) but pulls puzzles from the
 * endgame theme pool (puzzles.json filtered by Lichess endgame
 * theme tags) and persists to its own `UserProfile.endgameRating`
 * field — kept separate from the general tactic rating so endgame
 * solves don't shift the puzzleRating shown in the tactics tab.
 *
 * Algorithm:
 *   - Session rating starts at `UserProfile.endgameRating ?? 1200`.
 *   - Each correct attempt: sessionRating += STEP_CORRECT.
 *   - Each wrong attempt: sessionRating -= STEP_WRONG (with extra
 *     penalty per consecutive miss).
 *   - Next puzzle picked from the closest unplayed entry in the
 *     lesson's practiceThemes pool within `±BAND_WIDTH` of session
 *     rating. Band widens progressively when none match.
 *   - Persistent user endgameRating updated via classic Elo
 *     (K=32) against the just-played puzzle's rating.
 *
 * The session adjustment drives the NEXT puzzle's difficulty
 * target; the Elo update is what the Stats page will display as
 * the player's endgame puzzle strength.
 */
import puzzlesData from '../data/puzzles.json';
import { calculateRatingDelta } from './puzzleService';
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

// Session step sizes — mirror the medium-tier values from
// adaptivePuzzleService.ts so the endgame ramp matches the
// tactic-puzzle ramp the user is used to.
const STEP_CORRECT = 60;
const STEP_WRONG = 35;
const EXTRA_PENALTY_PER_CONSECUTIVE_WRONG = 25;
const RATING_FLOOR = 400;
const RATING_CEILING = 3000;
const BAND_WIDTH = 150;

/** Default starting rating when a profile has no persisted
 *  endgameRating. Matches the puzzleRating default. */
export const DEFAULT_ENDGAME_RATING = 1200;

export interface AdaptiveEndgameState {
  /** Current target rating — moves with each attempt. */
  sessionRating: number;
  /** Persistent user rating that gets Elo-updated; carried in
   *  state so the host can flush to Dexie on each attempt. */
  userRating: number;
  /** Puzzles solved this session. */
  solved: number;
  /** Puzzles failed this session. */
  failed: number;
  /** Current correct-answer streak. */
  streak: number;
  /** Best streak this session. */
  bestStreak: number;
  /** Number of wrong attempts in a row right now — drives the
   *  extra-penalty bump on wrong attempts. */
  consecutiveWrong: number;
  /** Last adjustment direction; surfaces in the UI as an up/down
   *  arrow on the rating chip. */
  lastAdjustment: 'up' | 'down' | null;
  /** Lichess puzzle ids the student has already played this
   *  session — feed into puzzle selection to avoid repeats. */
  playedIds: Set<string>;
}

export function createAdaptiveEndgameState(initialUserRating?: number): AdaptiveEndgameState {
  const rating = clamp(initialUserRating ?? DEFAULT_ENDGAME_RATING);
  return {
    sessionRating: rating,
    userRating: rating,
    solved: 0,
    failed: 0,
    streak: 0,
    bestStreak: 0,
    consecutiveWrong: 0,
    lastAdjustment: null,
    playedIds: new Set(),
  };
}

export interface AdaptiveEndgameOutcome {
  /** Did the student solve the puzzle on the FIRST try (no hint,
   *  no reveal, no wrong move)? */
  firstTryPerfect: boolean;
  /** The just-played puzzle's Lichess rating — used for the Elo
   *  update on the persistent user rating. */
  puzzleRating: number;
  /** Lichess puzzle id — added to playedIds so it isn't re-served. */
  puzzleId: string;
}

/** Apply an outcome: step the session target, update the user's
 *  persistent Elo, increment counters. Returns a NEW state — the
 *  input is not mutated. */
export function applyAdaptiveOutcome(
  state: AdaptiveEndgameState,
  outcome: AdaptiveEndgameOutcome,
): AdaptiveEndgameState {
  const next: AdaptiveEndgameState = {
    ...state,
    playedIds: new Set(state.playedIds),
  };
  next.playedIds.add(outcome.puzzleId);

  if (outcome.firstTryPerfect) {
    next.sessionRating = clamp(state.sessionRating + STEP_CORRECT);
    next.solved = state.solved + 1;
    next.streak = state.streak + 1;
    next.bestStreak = Math.max(state.bestStreak, next.streak);
    next.consecutiveWrong = 0;
    next.lastAdjustment = 'up';
  } else {
    const penalty = STEP_WRONG + state.consecutiveWrong * EXTRA_PENALTY_PER_CONSECUTIVE_WRONG;
    next.sessionRating = clamp(state.sessionRating - penalty);
    next.failed = state.failed + 1;
    next.streak = 0;
    next.consecutiveWrong = state.consecutiveWrong + 1;
    next.lastAdjustment = 'down';
  }

  // Persistent user-rating Elo update (K=32) — same formula as
  // the puzzle tab uses against the tactic pool.
  const delta = calculateRatingDelta(state.userRating, outcome.puzzleRating, outcome.firstTryPerfect);
  next.userRating = clamp(state.userRating + delta);

  return next;
}

/** Pick the next puzzle for an adaptive endgame session. Filters
 *  by the lesson's `practiceThemes` (when present), then by the
 *  rating band around sessionRating, excluding played ids.
 *
 *  Returns the closest-rated unplayed puzzle. Widens the band
 *  progressively when no candidates qualify. Null only when the
 *  entire theme pool is exhausted. */
export function pickAdaptivePuzzle(
  state: AdaptiveEndgameState,
  options: {
    themes?: ReadonlyArray<string>;
    minPopularity?: number;
    minPlays?: number;
  } = {},
): RawPuzzle | null {
  const themes = options.themes ?? [];
  const minPopularity = options.minPopularity ?? 50;
  const minPlays = options.minPlays ?? 80;
  const themeSet = themes.length > 0 ? new Set(themes) : null;

  const eligible = PUZZLES.filter((p) => {
    if (state.playedIds.has(p.id)) return false;
    if (p.popularity < minPopularity) return false;
    if (p.nbPlays < minPlays) return false;
    if (themeSet && !p.themes.some((t) => themeSet.has(t))) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Progressive band widening: try 1×, 2×, 3×.
  for (let mult = 1; mult <= 3; mult += 1) {
    const bw = BAND_WIDTH * mult;
    const min = state.sessionRating - bw;
    const max = state.sessionRating + bw;
    const inBand = eligible.filter((p) => p.rating >= min && p.rating <= max);
    if (inBand.length === 0) continue;
    // Pick the puzzle closest to target rating; among the top 5
    // closest, pick a random one for variety.
    inBand.sort(
      (a, b) =>
        Math.abs(a.rating - state.sessionRating) - Math.abs(b.rating - state.sessionRating),
    );
    const pool = inBand.slice(0, Math.min(5, inBand.length));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // No band match — fall through to closest overall.
  eligible.sort(
    (a, b) =>
      Math.abs(a.rating - state.sessionRating) - Math.abs(b.rating - state.sessionRating),
  );
  return eligible[0];
}

/** Convert a Lichess puzzle into an `EndgameLessonPosition` so it
 *  can be driven by the existing playout runner. Same shape as
 *  endgameDrillService.puzzleToLessonPosition — applies the setup
 *  move first so the start FEN has the student to move. */
export function adaptivePuzzleToLessonPosition(
  p: RawPuzzle,
  lesson?: EndgameLesson,
): EndgameLessonPosition | null {
  const ucis = p.moves.split(/\s+/).filter(Boolean);
  if (ucis.length < 2) return null;
  // We can't import Chess from chess.js at module top because this
  // file is consumed by tests without a chess instance — lazy via
  // dynamic require for runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Chess } = require('chess.js');
  const chess = new Chess(p.fen);
  try {
    chess.move({
      from: ucis[0].slice(0, 2),
      to: ucis[0].slice(2, 4),
      promotion: ucis[0].length > 4 ? ucis[0][4] : undefined,
    });
    const startFen: string = chess.fen();
    const sans: string[] = [];
    for (let i = 1; i < ucis.length; i += 1) {
      const m = chess.move({
        from: ucis[i].slice(0, 2),
        to: ucis[i].slice(2, 4),
        promotion: ucis[i].length > 4 ? ucis[i][4] : undefined,
      });
      sans.push(m.san);
    }
    if (sans.length === 0) return null;
    const stmAfterSetup: string = startFen.split(' ')[1];
    const studentSide = stmAfterSetup === 'w' ? 'white' : 'black';
    return {
      fen: startFen,
      title: 'Drill',
      explanation: '',
      result: studentSide === 'white' ? 'white-wins' : 'black-wins',
      bestMove: sans[0],
      solution: sans,
      source: `Lichess puzzle #${p.id} (rating ${p.rating})${
        lesson ? ` · ${lesson.name}` : ''
      }`,
    };
  } catch {
    return null;
  }
}

function clamp(rating: number): number {
  return Math.max(RATING_FLOOR, Math.min(RATING_CEILING, rating));
}
