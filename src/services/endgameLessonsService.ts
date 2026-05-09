/**
 * endgameLessonsService
 * ---------------------
 * Loads the hand-authored endgame lesson catalog: principles, pawn
 * endings, drawn patterns, rook endings. Same architectural spine as
 * `endgameService` (the mating-pattern surface) — every position is
 * chess.js-legal, every solution sequence replay-checked, every word
 * of narration hand-authored. The runtime LLM never authors; it only
 * voices the prose via Polly TTS.
 *
 * David's principle: "lines only come from databases." Here the
 * "database" is the JSON files I wrote — curated, source-cited, FEN-
 * verified at build time (see endgameLessonsService.test.ts).
 */
import principlesData from '../data/endgame-principles.json';
import pawnEndingsData from '../data/pawn-endings.json';
import drawnPatternsData from '../data/drawn-patterns.json';
import rookEndingsData from '../data/rook-endings.json';
import type { EndgameLesson } from '../types/endgameLesson';

const PRINCIPLES = principlesData as EndgameLesson[];
const PAWN_ENDINGS = pawnEndingsData as EndgameLesson[];
const DRAWN_PATTERNS = drawnPatternsData as EndgameLesson[];
const ROOK_ENDINGS = rookEndingsData as EndgameLesson[];

/** Every endgame lesson the app knows about — flat list across all
 *  surface tabs. Use the category-specific accessors below for tab
 *  rendering; this exists for the global search / cache key lookup
 *  use cases. */
export function getAllEndgameLessons(): EndgameLesson[] {
  return [...PRINCIPLES, ...PAWN_ENDINGS, ...DRAWN_PATTERNS, ...ROOK_ENDINGS];
}

/** The 7 universal endgame principles — Activate the King, Push
 *  Passed Pawns, Attack Weak Pawns, Two Weaknesses, Don't Rush,
 *  Rooks Behind Passed Pawns, Trade Pieces When Ahead. Every
 *  topical tab can surface its principle subset. */
export function getEndgamePrinciples(): EndgameLesson[] {
  return PRINCIPLES.slice().sort((a, b) => a.order - b.order);
}

/** Pawn ending lessons — Opposition, Key Squares, Rule of the
 *  Square, Outflanking, Breakthrough, Triangulation. Renders in
 *  the Pawn Endings tab. */
export function getPawnEndings(): EndgameLesson[] {
  return PAWN_ENDINGS.slice().sort((a, b) => a.order - b.order);
}

/** Drawing patterns — Wrong-Rook-Pawn Bishop, OCB, Philidor,
 *  Q vs R Fortress, K+P Opposition, Stalemate Stalking,
 *  Perpetual Check, Insufficient Material. Renders in the
 *  Eval Lab → Drawing Patterns sub-tab. */
export function getDrawingPatterns(): EndgameLesson[] {
  return DRAWN_PATTERNS.slice().sort((a, b) => a.order - b.order);
}

/** Rook ending lessons — Lucena, Philidor, Active Rook, Cutting
 *  Off the King. Renders in the Rook Endings tab. */
export function getRookEndings(): EndgameLesson[] {
  return ROOK_ENDINGS.slice().sort((a, b) => a.order - b.order);
}

/** Look up a lesson by ID across all categories. Used for direct-
 *  link routing (URL has the slug). Returns null when the slug
 *  doesn't match any lesson. */
export function getEndgameLessonById(id: string): EndgameLesson | null {
  for (const lesson of getAllEndgameLessons()) {
    if (lesson.id === id) return lesson;
  }
  return null;
}
