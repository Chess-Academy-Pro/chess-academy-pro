import { Chess } from 'chess.js';
import type {
  JourneyChapter,
  JourneyChapterId,
  JourneyPuzzle,
  UserProfile,
  PuzzleRecord,
  ChessPiece,
} from '../types';
import { getKidPiecePuzzles, seedPuzzles } from './puzzleService';
import { getKidRating } from './kidRatingService';

// Per CLAUDE.md non-negotiable #17 ("The DB is the source of truth in
// kid mode. The LLM only writes prose."), this service now PICKS
// puzzles from the curated DB (puzzles.json + training-puzzles.json)
// instead of asking the LLM to invent FENs and solutions. The earlier
// LLM-invents path is gone — no callers can get an AI-fabricated
// position back, even when the safety wrapper is in place.
//
// Chapter id → ChessPiece:
//   pawn / rook / bishop / knight / queen / king map 1:1
//   tactics / first-game fall back to the chapter's hand-authored
//   puzzles (these aren't piece-specific so the DB picker doesn't
//   apply).
//
// Hint + success message are static templates per piece — kid-safe by
// construction (no LLM round-trip means no slang / personality leak).
// A future PR can optionally LLM-annotate (hint TEXT ONLY, never
// FEN/solution) through getKidLlmResponse if richer prose is wanted.

const CHESS_PIECE_CHAPTERS: ReadonlySet<JourneyChapterId> = new Set<JourneyChapterId>([
  'pawn', 'rook', 'bishop', 'knight', 'queen', 'king',
]);

const PIECE_HINT: Record<ChessPiece, string> = {
  king:   'Find the safest move for the king.',
  queen:  'Look for a queen move that wins material.',
  rook:   'Slide your rook to attack or capture.',
  bishop: 'Find the bishop move that takes a piece.',
  knight: 'Hop the knight to attack or capture.',
  pawn:   'Find the pawn move that wins.',
};

const PIECE_SUCCESS: Record<ChessPiece, string> = {
  king:   'The king is safe!',
  queen:  'Queen captures clean!',
  rook:   'Rook takes the prize!',
  bishop: 'Bishop slides through!',
  knight: 'Knight hops to the win!',
  pawn:   'Pawn pushes through!',
};

const PUZZLE_COUNT_PER_CHAPTER = 4;

/**
 * Validates that a FEN represents a legal position and the solution
 * move is legal. Kept exported for test parity with the prior service.
 */
export function validatePuzzleFen(fen: string, solution: string): boolean {
  try {
    const chess = new Chess(fen);
    const m = chess.move(solution);
    return m !== null;
  } catch {
    return false;
  }
}

function uciFirstMoveToSan(fen: string, uciMoves: string): string | null {
  const first = uciMoves.split(/\s+/)[0];
  if (!first || first.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: first.slice(0, 2),
      to: first.slice(2, 4),
      promotion: first.length === 5 ? first[4] : undefined,
    });
    return move?.san ?? null;
  } catch {
    return null;
  }
}

function puzzleRecordToJourneyPuzzle(
  record: PuzzleRecord,
  piece: ChessPiece,
): JourneyPuzzle | null {
  const san = uciFirstMoveToSan(record.fen, record.moves);
  if (!san) return null;
  return {
    id: `db-${record.id}`,
    fen: record.fen,
    solution: [san],
    hint: PIECE_HINT[piece],
    successMessage: PIECE_SUCCESS[piece],
  };
}

/**
 * Pick puzzles for a chapter. Returns DB-sourced puzzles for the 6
 * piece chapters; falls back to the chapter's hand-authored puzzles
 * for `tactics` and `first-game` (non-piece chapters) and as a safety
 * net when the DB filter returns too few entries.
 *
 * The kid rating drives the puzzle band — fresh profile starts at 100
 * (sub-Lichess floor → training-pool puzzles). As the kid solves
 * puzzles the rating climbs and the band shifts upward into the
 * Lichess pool.
 */
export async function generateKidPuzzles(
  chapter: JourneyChapter,
  _profile: UserProfile, // kept for signature compat; future PR will use it for stricter band overrides
): Promise<JourneyPuzzle[]> {
  if (!CHESS_PIECE_CHAPTERS.has(chapter.id)) {
    // Non-piece chapters (tactics, first-game) use their hand-authored
    // puzzle bank unchanged. Those puzzles are statically validated by
    // scripts/audit-kid-puzzles-static.mjs at build time.
    return chapter.puzzles;
  }

  const piece = chapter.id as ChessPiece;
  try {
    await seedPuzzles();
    const kidRating = await getKidRating(piece);
    const dbPuzzles = await getKidPiecePuzzles(piece, kidRating, PUZZLE_COUNT_PER_CHAPTER * 3);
    const converted: JourneyPuzzle[] = [];
    for (const p of dbPuzzles) {
      if (converted.length >= PUZZLE_COUNT_PER_CHAPTER) break;
      const jp = puzzleRecordToJourneyPuzzle(p, piece);
      if (jp) converted.push(jp);
    }
    // Need at least 2 DB-sourced puzzles to consider the pull successful.
    // Otherwise fall back to the hand-authored chapter puzzles (also
    // DB-anchored — they live in journeyChapters.ts / fairyTaleChapters.ts).
    if (converted.length < 2) return chapter.puzzles;
    return converted;
  } catch {
    return chapter.puzzles;
  }
}
