// Pure helpers for picking the right narration text (and auxiliary fields)
// for a walkthrough step.
//
// The data model supports embedded narration fields on OpeningMoveAnnotation:
//   - `narration`        — the canonical voice script for this move
//   - `shortNarration`   — a trimmed version for higher speed tiers
//   - `coachHint`        — a short coaching tip for drill mode / hint button
//
// Old annotations (no narration field) keep working: we derive a spoken
// script from `annotation` using the same sentence-trim rule that
// WalkthroughMode used before this refactor.
//
// Callers should ALWAYS go through these helpers rather than reading
// annotation fields directly, so the fallback chain stays centralized.

import type { OpeningMoveAnnotation } from '../types';

/**
 * Patterns used by the offline annotation generator when it couldn't
 * produce real commentary. These are baked into thousands of move
 * entries across the opening annotation JSON files (albin, alekhine,
 * benoni, birds, catalan, etc.) and produce noise like:
 *   "Bg2 by White. The position is heading toward the critical moment."
 *   "d6 by Black. The position is becoming uncomfortable — careful defense is needed."
 *   "Nf6 brings the knight into the game. Development with purpose — the knight on f6 eyes important squares."
 *   "Black plays e6, developing normally. The opponent may not see what's coming."
 * Treat matches as "no annotation" so both the AnnotationCard and the
 * voice service stay silent rather than reading filler.
 *
 * Each pattern targets a distinctive templated phrase — not just any
 * sentence containing a chess term — so real curated annotations that
 * happen to mention "development" or "pawn structure" are preserved.
 */
const GENERIC_ANNOTATION_PATTERNS: RegExp[] = [
  // ─── "Position state" filler ────────────────────────────────────────
  /\bposition is heading toward the critical moment\b/i,
  /\bposition is becoming uncomfortable\b/i,
  /\bcareful defense is needed\b/i,
  /\bposition is roughly (equal|balanced)\b/i,
  /\bboth sides have chances\b/i,
  /\bThe position is sharp and requires precise play from this point forward\b/i,
  /\bThe key moment is approaching\b/i,
  /\bThe critical moment is approaching\b/i,
  /\bcritical moment in the trap\b/i,
  /\bcritical moment in the opening( battle)?\b/i,
  /\bThis is a critical moment where precise play is essential to exploit the tactical opportunity\b/i,
  /\bThis is a critical moment where precise play is essential\b/i,

  // ─── Bare move fragments ─────────────────────────────────────────────
  /^\s*[A-Za-z][\w+#=!?-]*\s+by\s+(?:White|Black)\.\s*$/i,

  // ─── "Development" filler ────────────────────────────────────────────
  /\bDevelopment with purpose\s*[—–-]\s*the \w+ on \w+ eyes important squares\b/i,
  /\bThe \w+ on \w+ improves (?:White|Black)'?s piece coordination and flexibility\b/i,
  /\bThis move contributes to (?:White|Black)'?s opening development and fight for central control\b/i,
  /\b(?:White|Black) improves piece placement heading into the critical phase of the game\b/i,
  /\bConnecting the rooks is a priority\b/i,
  /\bThe rook now enters the game on a central file\b/i,

  // ─── "Central control" filler ────────────────────────────────────────
  /\bCentral pawns control space and restrict the opponent'?s piece activity\b/i,
  /\bThis central advance fights for space and control of key squares\b/i,
  /\bControlling the center is the foundation of a strong position\b/i,
  /\bThis pawn move supports a future d-pawn advance, a key central plan\b/i,

  // ─── "Flank/space" filler ────────────────────────────────────────────
  /\bGaining space here creates potential targets and restricts the opponent'?s counterplay\b/i,
  /\bA flank pawn advance, creating space on the (?:queenside|kingside)\b/i,
  /\bpawn advance gains space and can support a future attack toward the enemy king\b/i,
  /\bAn aggressive pawn advance, signaling kingside intentions and opening lines\b/i,

  // ─── "Piece placement" filler ────────────────────────────────────────
  /\bwas less effective on \w+ and moves to \w+ where it serves the plan better\b/i,

  // ─── "Exchange" filler ───────────────────────────────────────────────
  /\bThis exchange changes the balance\s*[—–-]\s*(?:White|Black) reconfigures the pawn structure or gains material\b/i,

  // ─── "Thematic move" filler ──────────────────────────────────────────
  /\bA thematic move in this position, maintaining (?:White|Black)'?s initiative\b/i,
  /\bThe fianchettoed bishop rakes the long diagonal, exerting pressure from a distance\b/i,

  // ─── "Trap warning" filler — appears throughout trap lines ──────────
  /\bdeveloping normally\.\s*The opponent may not see what'?s coming\b/i,
  /\bopponent (?:may|might|won[\u2019']?t|will not|doesn[\u2019']?t)(?:\s+not)? (?:see|notice|spot|catch) what[\u2019']?s coming\b/i,
  /\bopponent may not see what'?s coming\b/i,
  /\bThis move looks reasonable but allows the trap to unfold\b/i,
  /\bThis looks natural,? but it walks into the trap\b/i,
  /\bThis is the problematic continuation you need to recognize\b/i,
  // Loosened: the generator emits "The trap is being set up —
  // watch the next few moves carefully" but the bare "trap is
  // being set" also appears 577× across the corpus, usually as
  // "the trap is being set in motion" / "… and the trap is being
  // set". Catch the shorter stem so they all trigger the LLM
  // replacement.
  /\bthe trap is being set\b/i,
  /\b(?:White|Black) must be careful here\s*[—–-]\s*the position contains hidden dangers\b/i,
  /\bWatch out\s*[—–-]\s*a mistake here would be very costly\b/i,
  /^\s*Be alert\.?\s*$/i,

  // ─── Subline generator filler — from scripts/generate-subline-annotations.mjs ──
  // Warning-line openers / setup sentences
  /\bThis is the natural continuation that leads into the warning line\b/i,
  /\bThis sequence leads to the dangerous line\b/i,
  /\bThe position looks normal so far\b/i,
  /\bthis capture changes the character of the position\.\s*Be alert\b/i,
  /\bCheck forces a response\.\s*This is where the danger begins\b/i,
  // Warning-line payoff sentences
  /\bThis is the position you must avoid\b/i,
  /\bThe damage is done\s*[—–-]\s*this is the result you want to prevent\b/i,
  /\bThis is the uncomfortable position that results from this line\b/i,
  /\bNow that you'?ve seen it, you'?ll know to avoid the pitfall\b/i,
  /\bThis is the move that causes all the trouble\b/i,
  /\bCheck\s*[—–-]\s*and the position is very dangerous for the defending side\b/i,
  /\bThe position is now very difficult\.\s*This is the warning\b/i,
  /\bdon'?t let your opponent reach this\b/i,
  /\bWe'?re approaching the critical position\b/i,
  /\bPay close attention to the next moves\s*[—–-]\s*this is where the danger lies\b/i,

  // Trap-line setup / middle / payoff sentences
  /\bpreparing for the middlegame while the trap is being set\b/i,
  /\bThis exchange is part of the trap setup\b/i,
  /\bestablishing the position\.\s*The key moment is approaching\b/i,
  /\bThis is a critical moment in the trap\b/i,
  /\bThe position looks safe, but danger lurks\b/i,
  /\band this is the final blow\b/i,
  /\bMemorize this pattern\b/i,
  /\bThe trap is complete\b/i,
  /\bRemember this pattern\s*[—–-]\s*your opponents will fall for it\b/i,
  /\bThe trap is sprung\b/i,
  /\bThis is the key takeaway from the\b/i,
  /\bNow the trap is revealed\b/i,
  /\bThe trap is sprung\s*[—–-]\s*there'?s no good defense here\b/i,
  /\bThis is the critical move that springs the trap\b/i,
  /\bThe opponent is in serious trouble\b/i,
  /\bThis is where the trap begins\b/i,
  /\bThe next two moves are the key sequence you need to memorize\b/i,

  // Bare "Side plays SAN." stubs the generator falls back to when no
  // template applies. Match the whole line so we don't suppress real
  // annotations that merely contain the words "White plays" mid-sentence.
  /^\s*(?:White|Black)\s+plays\s+[A-Za-z][\w+#=!?-]*\.?\s*$/i,

  // Bare-SAN annotations — "10. Nxd5", "Nxd5", "10...c5", "1. e4".
  // Reported in the field: a Catalan subline showed literally "10. Nxd5"
  // as the only narration. These are pure move stubs, not teaching
  // content, so the LLM narrator should replace them.
  /^\s*\d+\.+\s*(?:\.\.\.\s*)?[NBRQK]?[a-h]?[1-8]?[x-]?[a-h][1-8](?:=[NBRQ])?[+#!?]*\s*$/,
  /^\s*[NBRQK]?[a-h]?[1-8]?[x-]?[a-h][1-8](?:=[NBRQ])?[+#!?]*\s*$/,
  /^\s*O-O(?:-O)?[+#!?]*\s*$/,

  // ─── "Castling" filler — single-sentence stubs ──────────────────────
  /\bCastles to safety, connecting the rooks and tucking the king away\b/i,
  /\bGets the king to safety with castling, an essential step before the middlegame battle begins\b/i,
  /\bCastles, completing king safety and activating the rook\b/i,
  /\b(?:White|Black) castles, but the position requires careful play\b/i,

  // ─── Generic "improving coordination / winning material" stubs ──────
  /\bimproving piece coordination and maintaining pressure\b/i,
  /\bwinning material or improving the position\b/i,

  // ─── Offline-generator templates with HARDCODED piece names ─────────
  //
  // 2026-05-18 deep-walk audit caught 81 instances where the curated
  // annotation file embeds these templates with a piece name that
  // DOESN'T match the move actually played on that ply. Examples:
  //   - "White moves the bishop to e3."  played as g4 (pawn)
  //   - "Black develops the queen to h4." played as Ne7 (knight)
  //   - "White moves the queen to f2."    played as Re1 (rook)
  // The template's hardcoded piece is a relic of the offline generator
  // walking the wrong PGN — the generator filled in piece + square
  // from a different line's ply N. Catching the templated phrasing
  // suppresses the wrong content so the LLM enricher can replace it.
  /\b(?:The |White's |Black's )?(?:queen|rook|bishop|knight|king)\s+takes up an influential position on [a-h][1-8](?:,\s*eyeing multiple targets)?\b/i,
  /\b(?:The |White's |Black's )?(?:queen|rook|bishop|knight)\s+on [a-h][1-8] controls key (?:diagonal|file|rank|square) squares\b/i,
  /\b(?:The |White's |Black's )?(?:queen|rook|bishop|knight)\s+on [a-h][1-8] (?:controls key diagonal squares and )?maintains active piece play\b/i,
  /\b(?:White|Black)\s+moves the (?:queen|rook|bishop|knight) to [a-h][1-8]\.\s*The (?:queen|rook|bishop|knight)/i,
  /\b(?:White|Black)\s+takes on [a-h][1-8],\s*removing (?:White's|Black's) (?:queen|rook|bishop|knight)\b/i,
  /\b(?:White|Black)\s+wins the piece on [a-h][1-8],\s*removing (?:White's|Black's) (?:queen|rook|bishop|knight)\b/i,
  /\bThis also (?:gives|delivers) check, disrupting the opponent's coordination\b/i,
  /\bThe rook takes up a powerful position on the [a-h][-\s]?file, pressuring (?:White|Black)'s position\b/i,

  // ─── Offline-generator "thematic exchange" filler ───────────────────
  // "fxe5 captures the pawn. This exchange is thematic in the X — it
  //  defines the resulting pawn structure and piece activity."
  // The first sentence is templated SAN narration, the second is
  // boilerplate. Both lifted from the offline generator template pool.
  /\b[A-Za-z][\w+#=!?-]*\s+captures the pawn\.\s+This exchange is thematic in the\b/i,
  /\bThis exchange is thematic in the .{1,80}—\s*it defines the resulting pawn structure and piece activity\b/i,

  // ─── "Bishop on safe square / preparing to castle" template ─────────
  // Generated on plies that aren't bishop moves — the template carried
  // over from the wrong ply during offline generation.
  /\b(?:Black|White) develops the bishop to a safe square, preparing to castle (?:king|queen)side\.\s*The bishop on [a-h][1-8] is somewhat passive but solid\b/i,
  /\bthis move completes (?:Black|White)[’']s basic development and prepares to challenge (?:White|Black)[’']s central control\b/i,
];

/**
 * Returns true when the supplied annotation text is a generic template
 * filler from the offline annotation generator rather than real
 * curated commentary. Used to suppress meaningless narration instead
 * of speaking "this is the critical moment" on every single move.
 */
export function isGenericAnnotationText(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return GENERIC_ANNOTATION_PATTERNS.some((re) => re.test(trimmed));
}

/** Same check against an annotation object — convenience wrapper. */
export function hasMeaningfulAnnotation(
  step: OpeningMoveAnnotation | null,
): boolean {
  if (!step) return false;
  const text = step.narration ?? step.annotation ?? '';
  return text.length > 0 && !isGenericAnnotationText(text);
}

export type NarrationLength = 'full' | 'short' | 'silent';

/**
 * Trim text to a max number of sentences. Mirrors the previous
 * WalkthroughMode helper. Exported for reuse in derived-short-form
 * generators and tests.
 */
export function trimToSentences(text: string, maxSentences: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences || sentences.length <= maxSentences) return text;
  return sentences.slice(0, maxSentences).join('').trim();
}

/**
 * Approximate word count — used to decide whether a first sentence is
 * already short enough for drill mode or whether we need to trim
 * further.
 */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Returns the text the voice service should speak for this step.
 *
 * - `silent` → empty string (caller should skip narration entirely)
 * - `short`  → `shortNarration` if present, else a derived short form from
 *              `narration`/`annotation` (first sentence; further trimmed if
 *              that single sentence is very long).
 * - `full`   → `narration` if present, else `annotation` (full text).
 *
 * Guarantees a non-empty return for any annotation that has either
 * `narration` or `annotation` text.
 */
export function pickNarrationText(
  step: OpeningMoveAnnotation | null,
  length: NarrationLength,
): string {
  if (!step || length === 'silent') return '';

  const fullText = step.narration ?? step.annotation ?? '';
  if (!fullText) return '';

  // Drop generic template filler rather than reading it aloud. The
  // annotation JSON files contain thousands of auto-generated stub
  // lines that the voice service would otherwise monotonously
  // repeat across every opening.
  if (isGenericAnnotationText(fullText)) return '';

  if (length === 'full') return fullText;

  // length === 'short'
  if (step.shortNarration) return step.shortNarration;
  const oneSentence = trimToSentences(fullText, 1);
  // If the first sentence is still a mouthful (> 28 words), cut at the
  // first comma or em-dash so drill mode feels quick.
  if (wordCount(oneSentence) > 28) {
    const earlyBreak = oneSentence.match(/^[^,—–;:]*[,—–;:]/);
    if (earlyBreak) {
      return earlyBreak[0].replace(/[,—–;:]\s*$/, '.').trim();
    }
  }
  return oneSentence;
}

/**
 * Returns a short coach hint for drill mode / the hint button.
 *
 * Priority:
 *   1. Explicit `coachHint` field on the annotation.
 *   2. First item from `plans[]`.
 *   3. `null` when neither is available (caller should hide the hint UI
 *      rather than paint generic text).
 */
export function pickCoachHint(step: OpeningMoveAnnotation | null): string | null {
  if (!step) return null;
  if (step.coachHint && step.coachHint.trim().length > 0) {
    return step.coachHint.trim();
  }
  const firstPlan = step.plans?.[0];
  if (firstPlan && firstPlan.trim().length > 0) return firstPlan.trim();
  return null;
}

/**
 * Picks the evaluation (centipawns) for a step when present. Returns
 * null when the annotation doesn't carry one — callers that want an
 * eval for UI (e.g. eval chip) should query Stockfish as a fallback.
 */
export function pickEvaluation(step: OpeningMoveAnnotation | null): number | null {
  if (!step) return null;
  return typeof step.evaluation === 'number' ? step.evaluation : null;
}
