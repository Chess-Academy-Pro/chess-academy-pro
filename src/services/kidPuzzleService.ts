import { Chess } from 'chess.js';
import { getKidLlmResponse } from './coachApi';
import type { JourneyChapter, JourneyPuzzle, UserProfile } from '../types';

// Kid puzzle generation runs through `getKidLlmResponse`, which pins
// `skipPersonality: true` and prepends a kid-safety system prompt
// — see CLAUDE.md "Kids section non-negotiables" #3 & #17. The
// instructions below are puzzle-shape only; the safety language lives
// in coachApi.ts so it can't be forgotten by any kid caller.
//
// Long-term, this whole "ask the LLM to invent positions" pattern is
// scheduled for inversion (Phase 0.5 + 0.6 of the kid plan) — the DB
// will pick positions and the LLM will only annotate them. Until that
// lands, every output is still validated by chess.js before we render
// it; an invalid FEN or illegal solution drops the puzzle.
const KID_PUZZLE_SYSTEM_PROMPT = `Generate chess puzzles for a child learning to play.

RULES:
- Every FEN must be a LEGAL chess position (both kings present, valid turn indicator)
- The solution must be a SINGLE legal move in standard algebraic notation (SAN)
- Keep positions very simple — 2-6 pieces total (always include both kings)
- Focus on the specific piece/concept requested

RESPONSE FORMAT — JSON array only, no prose:
[
  {
    "fen": "valid FEN string",
    "solution": "single SAN move like e4, Nf3, Bxc6, etc.",
    "hint": "spelled-out hint for the child (no SAN, ≤ 12 words)",
    "successMessage": "short milestone celebration (≤ 8 words)"
  }
]`;

interface RawPuzzleResponse {
  fen: string;
  solution: string;
  hint: string;
  successMessage: string;
}

/**
 * Validates that a FEN represents a legal position and the solution move is legal.
 */
export function validatePuzzleFen(fen: string, solution: string): boolean {
  try {
    const chess = new Chess(fen);
    chess.move(solution);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the AI response JSON, extracting valid puzzle objects.
 */
function parseAiPuzzles(raw: string): RawPuzzleResponse[] {
  // Extract JSON array from response — it may be wrapped in markdown code fences
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item): item is RawPuzzleResponse =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).fen === 'string' &&
        typeof (item as Record<string, unknown>).solution === 'string' &&
        typeof (item as Record<string, unknown>).hint === 'string' &&
        typeof (item as Record<string, unknown>).successMessage === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Generates kid-friendly puzzles for a chapter using the AI coach.
 * Falls back to the chapter's hardcoded puzzles on failure.
 */
export async function generateKidPuzzles(
  chapter: JourneyChapter,
  profile: UserProfile,
): Promise<JourneyPuzzle[]> {
  const conceptDescription = `${chapter.title} — ${chapter.subtitle}`;
  const lessonTopics = chapter.lessons.map((l) => l.title).join(', ');

  const userMessage = `Generate 4 chess puzzles for a child (rating ~${profile.currentRating}, level ${profile.level}).

Chapter: "${chapter.title}"
Concept: ${conceptDescription}
Lesson topics covered: ${lessonTopics}
Chapter piece: ${chapter.id} (the chapter focuses on teaching how this piece moves/captures)

Make each puzzle use only the ${chapter.id} piece concept. The child just finished learning about this piece, so test their understanding with fun positions.`;

  try {
    const response = await getKidLlmResponse(
      [{ role: 'user', content: userMessage }],
      KID_PUZZLE_SYSTEM_PROMPT,
    );

    const rawPuzzles = parseAiPuzzles(response);

    // Validate each puzzle with chess.js
    const validPuzzles: JourneyPuzzle[] = [];
    for (const raw of rawPuzzles) {
      if (validatePuzzleFen(raw.fen, raw.solution)) {
        validPuzzles.push({
          id: `ai-${chapter.id}-${validPuzzles.length + 1}`,
          fen: raw.fen,
          solution: [raw.solution],
          hint: raw.hint,
          successMessage: raw.successMessage,
        });
      }
    }

    // Need at least 2 valid puzzles, otherwise fall back
    if (validPuzzles.length < 2) {
      return chapter.puzzles;
    }

    return validPuzzles;
  } catch {
    return chapter.puzzles;
  }
}
