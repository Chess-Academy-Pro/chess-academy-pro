/**
 * coachCommentaryPolicy
 * ---------------------
 * Decides whether the coach should invoke the LLM for per-move
 * commentary during a play-against game. Pure, synchronous, no side
 * effects — safe to call from the hot path after every move.
 *
 * Why gate? Every move firing generateMoveCommentary quickly becomes
 * the largest unit cost of a play session. Most moves don't need
 * LLM-generated commentary — users want rich feedback on the
 * interesting moments (blunders, brilliants, turning points) and
 * brief deterministic feedback on routine moves. Gating cuts
 * per-game LLM spend ~60% without losing the pedagogically valuable
 * commentary.
 */
import type { MoveClassification, UserProfile } from '../types';

/** Move classifications that ALWAYS get LLM commentary in
 *  'key-moments' mode. These are the moves a learner actually gains
 *  from discussing — mistakes that need correction and moments of
 *  brilliance that reinforce good patterns. */
const KEY_MOMENT_CLASSIFICATIONS: ReadonlySet<MoveClassification> = new Set<MoveClassification>([
  'blunder',
  'mistake',
  'brilliant',
  'great',
]);

export type CommentaryVerbosity = NonNullable<UserProfile['preferences']['coachCommentaryVerbosity']>;

/**
 * Resolve the effective verbosity, defaulting to 'key-moments' for
 * any user who hasn't explicitly picked a mode. This is the setting
 * that protects our unit economics at launch.
 *
 * The unified `coachNarration` preference takes precedence: when set
 * to 'silent' → 'off', 'brief' → 'key-moments', 'full' → 'every-move'.
 * Falls back to the legacy `coachCommentaryVerbosity` for older
 * profiles, then 'key-moments' as the safe default.
 */
export function resolveVerbosity(profile: UserProfile | null | undefined): CommentaryVerbosity {
  const unified = profile?.preferences.coachNarration;
  if (unified === 'silent') return 'off';
  if (unified === 'brief') return 'key-moments';
  if (unified === 'full') return 'every-move';
  return profile?.preferences.coachCommentaryVerbosity ?? 'key-moments';
}

/**
 * Should we invoke the LLM for this particular move's
 * key-moment branch?
 *
 * Note: this gates ONLY the key-moment trigger inside CoachGamePage's
 * sparse-cadence decision tree. The full cadence is composed at the
 * call site:
 *
 *   shouldFire = isFirstSeeingOpening || isKeyMoment || userWantsEveryMove
 *
 * Where:
 *   - isFirstSeeingOpening fires the long opening intro once per opening
 *     (gated separately on verbosity !== 'off' in CoachGamePage).
 *   - isKeyMoment is what THIS function returns — true on blunder /
 *     mistake / brilliant / great when verbosity is 'key-moments'
 *     or 'every-move'.
 *   - userWantsEveryMove triggers the legacy chatty mode.
 *
 * So the per-mode behaviors composed at the call site are:
 *   - 'off'         — silent (no opening intro, no key moments, no
 *                     every-move). Deterministic tactic suffix still
 *                     surfaces in chat.
 *   - 'key-moments' — opening intro once + reactive key-moment zingers
 *                     + existing phase-transition narrations. Routine
 *                     book moves silent.
 *   - 'every-move'  — long narration on every move (legacy, expensive).
 */
export function shouldCallLlmForMove(
  verbosity: CommentaryVerbosity,
  classification: MoveClassification,
): boolean {
  if (verbosity === 'off') return false;
  if (verbosity === 'every-move') return true;
  return KEY_MOMENT_CLASSIFICATIONS.has(classification);
}
