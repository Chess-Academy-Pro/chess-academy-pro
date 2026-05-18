import { describe, it, expect } from 'vitest';
import { validateTacticClaims } from './tacticClaimValidator';
import type { TacticsLiveContext } from '../coach/types';

const EMPTY_CTX: TacticsLiveContext = {
  immediate: [],
  hanging: [],
  threats: [],
  opportunities: [],
  lookaheadDepth: 4,
};

function ctxWith(allowed: Array<{ type: string; description: string; squares?: string[]; depthAhead?: number; line?: string[] }>): TacticsLiveContext {
  return {
    immediate: allowed.map((a) => ({
      type: a.type,
      description: a.description,
      squares: a.squares ?? [],
    })),
    hanging: [],
    threats: [],
    opportunities: [],
    lookaheadDepth: 4,
  };
}

describe('validateTacticClaims', () => {
  it('returns empty results when the response has no tactic vocabulary', () => {
    const r = validateTacticClaims('Solid developmental move. Both sides finish development naturally.', EMPTY_CTX);
    expect(r.claims).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.hasAnyTacticClaim).toBe(false);
  });

  it('flags a fork claim as a violation when no fork is in the context', () => {
    const r = validateTacticClaims('Watch out — Black has a fork on c7 after Nb5.', EMPTY_CTX);
    expect(r.hasAnyTacticClaim).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].type).toBe('fork');
    expect(r.violations[0].reason).toBe('not-in-vocabulary');
  });

  it('accepts a fork claim when fork is in immediate vocabulary', () => {
    const ctx = ctxWith([{ type: 'fork', description: 'Knight on d5 forks queen and rook' }]);
    const r = validateTacticClaims('Knight on d5 forks the queen and rook.', ctx);
    expect(r.violations).toHaveLength(0);
    expect(r.claims.some((c) => c.type === 'fork' && c.valid)).toBe(true);
  });

  it('accepts hanging-piece mention when context.hanging is populated', () => {
    const ctx: TacticsLiveContext = {
      ...EMPTY_CTX,
      hanging: [{ square: 'd7', piece: 'q', color: 'b' }],
    };
    const r = validateTacticClaims('Black queen on d7 is hanging — Nxd7 wins material.', ctx);
    expect(r.violations).toHaveLength(0);
  });

  it('flags hanging-piece claim when no piece is actually hanging in context', () => {
    const r = validateTacticClaims('Black queen on d7 is hanging — Nxd7 wins material.', EMPTY_CTX);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].type).toBe('hanging');
  });

  it('uses "no-context-block" reason when context is null', () => {
    const r = validateTacticClaims('Black has a pin on the e-file.', null);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].reason).toBe('no-context-block');
  });

  it('handles multiple distinct tactic words in one response', () => {
    const ctx = ctxWith([
      { type: 'fork', description: 'fork on c7' },
      { type: 'pin', description: 'pin on e-file' },
    ]);
    const r = validateTacticClaims(
      'Pin on the e-file. Fork is also on the table. Skewer would lose tempo.',
      ctx,
    );
    expect(r.claims.length).toBeGreaterThanOrEqual(3);
    // fork + pin valid, skewer is a violation
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].type).toBe('skewer');
  });

  it('treats "double attack" as a fork synonym', () => {
    const r = validateTacticClaims('White creates a double attack on the knight and bishop.', EMPTY_CTX);
    expect(r.claims.some((c) => c.type === 'fork')).toBe(true);
  });

  it('treats "deflection" as removal-of-guard', () => {
    const r = validateTacticClaims('Nice deflection — the rook drops.', EMPTY_CTX);
    expect(r.claims.some((c) => c.type === 'removal_of_guard')).toBe(true);
  });

  it('flags back-rank claim when not in context', () => {
    const r = validateTacticClaims('Back rank is weak — be careful of mate on the back rank.', EMPTY_CTX);
    expect(r.violations.some((v) => v.type === 'back_rank')).toBe(true);
  });
});
