/**
 * Single source of truth for "how much should the coach speak right now."
 *
 * Reads the unified `coachNarration` preference if set; otherwise
 * derives an equivalent value from the three legacy per-surface
 * controls (`coachCommentaryVerbosity`, `phaseNarrationVerbosity`,
 * `coachVerbosity`) so existing user profiles keep their effective
 * verbosity without a one-shot migration.
 *
 * Mapping precedence: any one legacy field at its silent value wins
 * 'silent'. Otherwise any one at a brief-equivalent wins 'brief'.
 * Otherwise 'full'. This intentionally biases toward the quieter end
 * — if a user previously gated even one surface to off/brief, the
 * unified default should respect that, not regress to verbose.
 */
import type { CoachNarration, PhaseNarrationVerbosity, UserPreferences } from '../types';

export function resolveCoachNarration(
  prefs: Pick<
    UserPreferences,
    | 'coachNarration'
    | 'coachCommentaryVerbosity'
    | 'phaseNarrationVerbosity'
    | 'coachVerbosity'
  > | undefined
  | null,
): CoachNarration {
  if (!prefs) return 'full';
  if (prefs.coachNarration) return prefs.coachNarration;

  const silentSignals = [
    prefs.coachCommentaryVerbosity === 'off',
    prefs.phaseNarrationVerbosity === 'off',
    prefs.coachVerbosity === 'none',
  ];
  if (silentSignals.some(Boolean)) return 'silent';

  const briefSignals = [
    prefs.coachCommentaryVerbosity === 'key-moments',
    prefs.phaseNarrationVerbosity === 'brief',
    prefs.coachVerbosity === 'fast',
  ];
  if (briefSignals.some(Boolean)) return 'brief';

  return 'full';
}

/**
 * Maps the unified setting back to a narration length for the
 * pickNarrationText helper. 'silent' → caller should skip the speak
 * call entirely; 'brief' → walkthrough steps use shortNarration when
 * present; 'full' → use the long narration text.
 */
export function coachNarrationToLength(
  v: CoachNarration,
): 'silent' | 'short' | 'full' {
  if (v === 'silent') return 'silent';
  if (v === 'brief') return 'short';
  return 'full';
}

/**
 * Resolves the phase-transition narration verbosity. Mirrors
 * `resolveVerbosity` in coachCommentaryPolicy: the unified
 * `coachNarration` preference wins; falls back to the legacy
 * `phaseNarrationVerbosity` field, then 'standard' as default.
 */
export function resolvePhaseNarrationVerbosity(
  prefs: Pick<
    UserPreferences,
    'coachNarration' | 'phaseNarrationVerbosity'
  > | undefined
  | null,
): PhaseNarrationVerbosity {
  if (!prefs) return 'standard';
  if (prefs.coachNarration === 'silent') return 'off';
  if (prefs.coachNarration === 'brief') return 'brief';
  if (prefs.coachNarration === 'full') return 'standard';
  return prefs.phaseNarrationVerbosity ?? 'standard';
}

/**
 * Resolves the LLM-output-length knob (legacy `coachVerbosity`) for
 * per-move commentary on /coach/play. Tied to the unified
 * `coachNarration` setting so Brief actually produces SHORT LLM
 * output instead of full-length prose:
 *
 *   - coachNarration='silent' → 'none'   (short-circuits the LLM call)
 *   - coachNarration='brief'  → 'fast'   (LLM gets the brief-length cap in its prompt)
 *   - coachNarration='full'   → legacy `coachVerbosity` (default 'unlimited')
 *
 * Audit (CoachGamePage.tsx:2662) caught this: `narrationDensity` was
 * being read straight from `coachVerbosity` and defaulted to
 * 'unlimited' on every profile that never touched the legacy dial.
 * That meant Brief-mode key-moment narrations still came back as
 * full-length prose — same three-way-verbosity confusion the unified
 * setting was supposed to fix, just hiding one level deeper.
 */
export function resolveLlmNarrationDensity(
  prefs: Pick<UserPreferences, 'coachNarration' | 'coachVerbosity'> | undefined | null,
): 'none' | 'fast' | 'medium' | 'slow' | 'unlimited' {
  if (!prefs) return 'unlimited';
  if (prefs.coachNarration === 'silent') return 'none';
  if (prefs.coachNarration === 'brief') return 'fast';
  // 'full' or unset → legacy coachVerbosity (for old profiles that
  // touched the dial pre-unification) or 'unlimited' default.
  return prefs.coachVerbosity ?? 'unlimited';
}
