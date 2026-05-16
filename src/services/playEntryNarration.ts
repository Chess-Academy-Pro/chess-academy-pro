/**
 * playEntryNarration
 * ------------------
 * Templates for the one-line coach beat that fires on `/coach/play` mount
 * when the user arrived via a rolodex-style deep link (URL carries
 * `?opening=<name>`) — i.e. the student tapped a card that says
 * "practice the Italian Game" and landed in a game.
 *
 * Without this beat the cold-load experience is indistinguishable from
 * a generic `/coach/play` — board at starting position, "vs Stockfish
 * Bot" header, no felt cue the coach knows the chosen opening. The beat
 * is the rolodex's signature ("I see what you tapped").
 *
 * Rules (CLAUDE.md "Narration Voice Rules"):
 *   • Names the pattern (rule 7) + side + a directive.
 *   • No first-person, no meta-coaching (rule 6).
 *   • No "let's", "I'll", "we will".
 *   • No UI references (rule 2).
 *   • No acknowledgments (rule 5) — "good pick" / "great choice" banned.
 *   • Short — under 12 words (rule 10).
 *
 * Why 4 variants? Three is borderline (returning users could hear the
 * same beat back-to-back); five is bloat. Four gives enough rotation
 * across a typical rolodex (Italian / Caro-Kann / Sicilian / Vienna /
 * Queen's Gambit / Ruy Lopez / English / French ...) that any two
 * favorited openings reliably land on different directives.
 *
 * Variant selection: deterministic-by-opening (hash of name → index).
 * Same opening always picks the same directive — that's a feature, not
 * a bug. Across DIFFERENT openings the user gets variation; revisiting
 * the SAME opening gives the same line, reinforcing "this is YOUR
 * Italian Game".
 */

/** Re-export of the `color` field shape from `IntendedOpening`. We
 *  don't import the full interface to keep this template module pure
 *  data — no runtime coupling to the store. */
export type StudentSide = 'white' | 'black';

/** Side-agnostic directives. Order matters — index is the hash modulus. */
const DIRECTIVES = [
  'Show me the main line.',
  'Open with the book moves.',
  'Lead with the principal moves.',
  'Play it through.',
] as const;

export const PLAY_ENTRY_DIRECTIVE_COUNT = DIRECTIVES.length;

function sideLabel(side: StudentSide): 'White' | 'Black' {
  return side === 'white' ? 'White' : 'Black';
}

/** Simple, stable, deterministic 32-bit-ish hash. We don't need
 *  cryptographic strength — just consistent bucketing across opening
 *  names so the variant rotation is reproducible (and testable). */
function hashOpeningName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface PlayEntryNarrationInput {
  openingName: string;
  studentSide: StudentSide;
}

/** Produce the one-line entry beat for a rolodex-driven `/coach/play`
 *  cold load. Caller is responsible for firing exactly once per
 *  session (guard via `useRef`) and routing through both
 *  `useNarration` (voice) and `gameChatRef.injectAssistantMessage`
 *  (chat mirror, survives voice-off). */
export function buildPlayEntryNarration({
  openingName,
  studentSide,
}: PlayEntryNarrationInput): string {
  const trimmedName = openingName.trim();
  const directiveIdx = hashOpeningName(trimmedName) % DIRECTIVES.length;
  const directive = DIRECTIVES[directiveIdx];
  return `${trimmedName} as ${sideLabel(studentSide)}. ${directive}`;
}

/** Internal — exported so tests can assert specific variants without
 *  scraping the module. */
export function _getDirectiveForTest(openingName: string): string {
  const idx = hashOpeningName(openingName.trim()) % DIRECTIVES.length;
  return DIRECTIVES[idx];
}

/** Internal — exported for tests. */
export const _DIRECTIVES_FOR_TEST = DIRECTIVES;
