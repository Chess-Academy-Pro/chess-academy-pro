import { describe, it, expect } from 'vitest';
import { OPENING_TAG_ALIASES, getAliasedTokens } from './openingTagAliases';

describe('openingTagAliases', () => {
  it('exposes the Petrov ↔ Russian Game bridge (biggest single win)', () => {
    expect(OPENING_TAG_ALIASES["Petrov's Defense"]).toContain('Russian_Game');
  });

  it('routes Englund Gambit Complex variants under Englund Gambit', () => {
    const tokens = OPENING_TAG_ALIASES['Englund Gambit'];
    expect(tokens).toContain('Englund_Gambit_Complex');
    expect(tokens).toContain('Englund_Gambit_Complex_Declined');
  });

  it('bridges the St. George period mismatch', () => {
    expect(OPENING_TAG_ALIASES['St. George Defense']).toEqual(['St_George_Defense']);
  });

  it('folds Rat Defense under Modern Defense', () => {
    expect(OPENING_TAG_ALIASES['Modern Defense']).toContain('Rat_Defense');
  });

  it('folds Giuoco Piano under Italian Game', () => {
    expect(OPENING_TAG_ALIASES['Italian Game']).toContain('Giuoco_Piano');
  });

  it('does not include single-puzzle flukes (Bronstein, Kings_Pawn)', () => {
    // The audit identified these but the WO scope deliberately skips them.
    const allTokens = Object.values(OPENING_TAG_ALIASES).flat();
    expect(allTokens).not.toContain('Bronstein_Gambit');
    expect(allTokens).not.toContain('Kings_Pawn');
  });

  describe('getAliasedTokens helper', () => {
    it('returns the configured tokens for a known family', () => {
      expect(getAliasedTokens("Petrov's Defense")).toEqual(['Russian_Game']);
    });

    it('returns an empty array (not undefined) for unknown families', () => {
      const result = getAliasedTokens('Definitely Not A Real Opening');
      expect(result).toEqual([]);
      // Important for downstream `.concat()` usage — must be array-like.
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns the same reference for repeat lookups (no copy)', () => {
      // Implementation detail — but worth pinning so callers don't accidentally
      // mutate the canonical array. If we ever switch to defensive copies,
      // this test will catch the change.
      const a = getAliasedTokens("Petrov's Defense");
      const b = getAliasedTokens("Petrov's Defense");
      expect(a).toBe(b);
    });
  });

  it('every alias value is a non-empty array of non-empty strings', () => {
    for (const [family, tokens] of Object.entries(OPENING_TAG_ALIASES)) {
      expect(tokens, `Empty token array for ${family}`).not.toHaveLength(0);
      for (const token of tokens) {
        expect(typeof token, `Non-string token in ${family}`).toBe('string');
        expect(token.length, `Empty-string token in ${family}`).toBeGreaterThan(0);
        // Lichess tokens use underscores; spaces would indicate a bug.
        expect(token, `Token contains space in ${family}: "${token}"`).not.toMatch(/ /);
      }
    }
  });
});
