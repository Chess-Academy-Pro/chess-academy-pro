/**
 * Tactic-claim validator — programmatic G3 check that the coach's
 * response didn't name a tactic outside the pre-computed
 * TacticsLiveContext vocabulary.
 *
 * The system prompt (TACTICAL AWARENESS block in identity.ts) tells
 * the brain not to invent tactics outside the block. This module
 * verifies it actually obeyed by scanning the response for tactic
 * vocabulary and cross-referencing against what was in the block.
 *
 * First-cut behavior (Phase 2.5 of WO-COACH-TACTICAL-AWARENESS):
 *   - Detect violations
 *   - Emit a `coach-tactic-claim-out-of-vocabulary` audit event
 *   - Return the violation list so callers can decide what to do
 *     (audit-only for now; future: trigger regen with strengthened
 *     prompt addendum, mirroring claim-validator-trip for master-play)
 *
 * NEVER mutates the response. Pure read-only G3 instrument.
 */
import type { TacticsLiveContext } from '../coach/types';

/** Canonical tactic vocabulary the brain is allowed to name. Each
 *  entry maps response-text regex matches → the tactic-type key
 *  used in TacticsLiveContext.{immediate,threats,opportunities}. */
const TACTIC_VOCABULARY: Array<{
  type: string;
  patterns: RegExp[];
}> = [
  {
    type: 'fork',
    patterns: [/\bfork(?:ing|s|ed)?\b/i, /\bdouble[- ]attack(?:ing|s|ed)?\b/i],
  },
  {
    type: 'pin',
    patterns: [/\bpin(?:ning|s|ned)?\b/i, /\babsolute[- ]pin\b/i, /\brelative[- ]pin\b/i],
  },
  {
    type: 'skewer',
    patterns: [/\bskewer(?:ing|s|ed)?\b/i],
  },
  {
    type: 'discovery',
    patterns: [/\bdiscovered[- ](?:attack|check)\b/i, /\bdiscovery\b/i],
  },
  {
    type: 'double_check',
    patterns: [/\bdouble[- ]check\b/i],
  },
  {
    type: 'back_rank',
    patterns: [/\bback[- ]rank\b/i, /\bback[- ]rank[- ](?:mate|threat)\b/i],
  },
  {
    type: 'removal_of_guard',
    patterns: [/\bremoval[- ]of[- ](?:the[- ])?guard\b/i, /\bdeflection\b/i],
  },
  {
    type: 'x_ray',
    patterns: [/\bx[- ]ray\b/i],
  },
  {
    type: 'overload',
    patterns: [/\boverload(?:ing|s|ed)?\b/i, /\boverworked piece\b/i],
  },
  {
    type: 'trapped_piece',
    patterns: [/\btrapped piece\b/i, /\bpiece is trapped\b/i],
  },
  {
    type: 'hanging',
    patterns: [/\bhanging piece\b/i, /\bhanging (?:pawn|knight|bishop|rook|queen)\b/i, /\bis hanging\b/i],
  },
];

export interface TacticClaimViolation {
  /** Canonical tactic type the response named. */
  type: string;
  /** The substring from the response that triggered the match. */
  match: string;
  /** Why this is a violation: 'not-in-vocabulary' = no entry with
   *  this type in the bounded context; 'no-context-block' = the
   *  response named a tactic but no context block was sent at all. */
  reason: 'not-in-vocabulary' | 'no-context-block';
}

export interface ValidationResult {
  /** All tactic claims found in the response (whether valid or not). */
  claims: Array<{ type: string; match: string; valid: boolean }>;
  /** Subset that violate G3 (named outside the bounded vocabulary). */
  violations: TacticClaimViolation[];
  /** True when ANY tactic word was mentioned. */
  hasAnyTacticClaim: boolean;
}

/** Scan the brain's response for tactic vocabulary and validate
 *  against the bounded context.
 *
 *  @param response - The raw text the brain returned (after tool-
 *                    markup stripping; the prose the user sees).
 *  @param context  - The TacticsLiveContext that was attached to the
 *                    envelope, or null if no block was sent.
 */
export function validateTacticClaims(
  response: string,
  context: TacticsLiveContext | null,
): ValidationResult {
  const claims: ValidationResult['claims'] = [];
  const violations: TacticClaimViolation[] = [];

  // Build the set of allowed tactic types from the context.
  const allowedTypes = new Set<string>();
  if (context) {
    for (const t of context.immediate) allowedTypes.add(t.type);
    for (const t of context.threats) allowedTypes.add(t.type);
    for (const t of context.opportunities) allowedTypes.add(t.type);
    // Hanging pieces always allowed when the context has any.
    if (context.hanging.length > 0) allowedTypes.add('hanging');
  }

  for (const entry of TACTIC_VOCABULARY) {
    for (const pattern of entry.patterns) {
      const match = pattern.exec(response);
      if (!match) continue;
      const valid = allowedTypes.has(entry.type);
      claims.push({ type: entry.type, match: match[0], valid });
      if (!valid) {
        violations.push({
          type: entry.type,
          match: match[0],
          reason: context ? 'not-in-vocabulary' : 'no-context-block',
        });
      }
    }
  }

  return {
    claims,
    violations,
    hasAnyTacticClaim: claims.length > 0,
  };
}
