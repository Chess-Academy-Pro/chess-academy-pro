/**
 * puzzlesFamilyFallbackNotify
 * ---------------------------
 * Coach-voice acknowledgment for the rolodex Puzzles row when the
 * family-fallback path activates (WO-ROLODEX-PLUMBING-01 item 11
 * — "no puzzles tagged for that exact variation, but here are <N>
 * puzzles in the <family> family that'll teach you the same ideas.")
 *
 * Locked scope (Dave 2026-05-16):
 *   • Full brain call. No templated fast-path. The brain composes
 *     the line in its own voice. Costs one LLM round-trip per row
 *     tap; firehose-first stance acceptable for v1.
 *   • Fire-and-forget. The rolodex navigates immediately on row
 *     tap; voice plays when the brain responds. Caller passes
 *     callbacks so the resolved text can be routed to voiceService
 *     + the chat injection without this module owning any of those
 *     surfaces directly. Keeps this file UI-agnostic and testable.
 *
 * Why standalone-chat surface tag:
 *   The CoachSurface union doesn't currently have a 'rolodex' value
 *   (would require envelope.ts updates — out of scope for PR-C, a
 *   data-plumbing PR). 'standalone-chat' is the closest existing
 *   value: brain treats it as a conversational off-main-flow ask,
 *   adds voice context per envelope.ts:429, and returns prose in
 *   the same register as the rolodex row needs.
 */
import { coachService } from '../coach/coachService';
import type { CoachSurface } from '../coach/types';

const FALLBACK_SURFACE: CoachSurface = 'standalone-chat';

export interface PuzzlesFamilyFallbackInput {
  /** The opening the student favorited (the deep variation that
   *  yielded zero exact-match puzzles). */
  favoritedOpening: string;
  /** The family that the fallback resolved to (one tier up from
   *  the favorited opening via `getOpeningFamily`). */
  family: string;
  /** The puzzle count available in the family — surfaces in the
   *  brain's response. */
  count: number;
}

/** Build the prompt the brain receives. Plain-string composition so
 *  the brain has exactly the three facts (favorited opening, family,
 *  count) without ambient context bleeding in.
 *
 *  Carefully avoids UI references ("tapped a card", "the rolodex")
 *  in the FRAMING — the brain mimics example phrasing more than it
 *  follows rule lists, and a UI-flavored framing leaks through to
 *  the response even with explicit bans. Instead: the student "is
 *  studying" the opening and "wants to practice." Pure subject-
 *  matter language.
 *
 *  The tone anchor ("coach pointing forward, not librarian
 *  explaining the catalog") shifts the register from informational
 *  to instructional — meaningful one-line lever per Dave's review. */
export function buildPuzzlesFamilyFallbackPrompt(
  input: PuzzlesFamilyFallbackInput,
): string {
  const { favoritedOpening, family, count } = input;
  return [
    `The student is studying the ${favoritedOpening} and wants to practice puzzles.`,
    `No Lichess puzzles are tagged with that exact variation, but the broader ${family} family has ${count} tagged puzzle${count === 1 ? '' : 's'} available.`,
    'Respond in ONE coach-voice sentence acknowledging the fallback and pointing the student at the family puzzles.',
    'Concrete, no first-person, no UI references, no "good choice" pleasantries.',
    'Speak like a coach pointing the student forward, not like a librarian explaining a catalog.',
  ].join(' ');
}

/** Fire-and-forget brain ask. Resolves to the one-line coach voice
 *  acknowledgment OR `null` on any failure (network, provider 500,
 *  empty response). Caller decides whether to speak / inject the
 *  text on success and whether to fall back to a templated string
 *  on null (recommended: render the row but skip voice on null).
 *
 *  The brain call is intentionally NOT awaited inside React render
 *  paths — consumers (the rolodex UI) should fire this from a row-
 *  tap handler and chain `.then(text => speakAndInject(text))` so
 *  the navigation happens immediately and voice arrives whenever
 *  the LLM resolves. */
export async function requestPuzzlesFamilyFallbackVoice(
  input: PuzzlesFamilyFallbackInput,
): Promise<string | null> {
  try {
    const ask = buildPuzzlesFamilyFallbackPrompt(input);
    const answer = await coachService.ask({
      surface: FALLBACK_SURFACE,
      ask,
      liveState: { surface: FALLBACK_SURFACE },
    });
    const text = answer.text.trim();
    if (!text) return null;
    return text;
  } catch {
    // Brain failure shouldn't break the rolodex card. The Puzzles
    // row still renders with the family chip; voice just doesn't
    // fire for this tap.
    return null;
  }
}
