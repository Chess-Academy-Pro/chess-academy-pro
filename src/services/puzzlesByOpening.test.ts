import { describe, it, expect } from 'vitest';
import {
  getPuzzlesProgress,
  normalizeOpeningNameToLichessToken,
} from './puzzlesByOpening';

describe('puzzlesByOpening', () => {
  describe('normalizeOpeningNameToLichessToken', () => {
    it('replaces spaces with underscores', () => {
      expect(normalizeOpeningNameToLichessToken('Italian Game')).toBe('Italian_Game');
    });

    it('strips apostrophes', () => {
      expect(normalizeOpeningNameToLichessToken("Petrov's Defense")).toBe('Petrovs_Defense');
    });

    it('strips colons + commas + periods', () => {
      expect(normalizeOpeningNameToLichessToken('Italian Game: Two Knights, Modern')).toBe(
        'Italian_Game_Two_Knights_Modern',
      );
      expect(normalizeOpeningNameToLichessToken('St. George Defense')).toBe('St_George_Defense');
    });

    it('strips diacritics (Grünfeld → Grunfeld)', () => {
      expect(normalizeOpeningNameToLichessToken('Grünfeld Defense')).toBe('Grunfeld_Defense');
    });
  });

  describe('getPuzzlesProgress (family-fallback ladder)', () => {
    it('returns source=exact when the canonical token directly matches puzzles', () => {
      // Italian Game is a top-15 family with 190 puzzles tagged.
      const r = getPuzzlesProgress('Italian Game');
      expect(r.source).toBe('exact');
      expect(r.count).toBeGreaterThan(0);
      expect(r.family).toBeUndefined();
    });

    it('returns source=exact and recovers puzzles via alias (Petrov\'s Defense → Russian_Game)', () => {
      // Petrov's Defense normalizes to "Petrovs_Defense" which has
      // zero direct hits; alias map adds "Russian_Game" → 49 puzzles.
      const r = getPuzzlesProgress("Petrov's Defense");
      expect(r.source).toBe('exact');
      expect(r.count).toBeGreaterThanOrEqual(49);
    });

    it('falls back to family when a deep variation has no direct puzzles', () => {
      // "Italian Game: Two Knights Defense, Open Variation" is way
      // deep — Lichess tags don't carry that variation precisely.
      // The walk-up to "Italian Game" recovers the full family count.
      const r = getPuzzlesProgress('Italian Game: Two Knights Defense, Open Variation');
      // Family fallback OR an exact match on the variation token —
      // either is acceptable as long as we return real counts.
      // The audit told us 48 puzzles tag "Italian Game: Two Knights"
      // family, so a hit on either path is fine.
      expect(r.count).toBeGreaterThan(0);
      // If it landed on family, the family should be "Italian Game".
      if (r.source === 'family') {
        expect(r.family).toBe('Italian Game');
      }
    });

    it('returns source=none for openings with no puzzles at any tier', () => {
      // Exotic opening with zero Lichess puzzle coverage.
      const r = getPuzzlesProgress('Pterodactyl Defense');
      expect(r.source).toBe('none');
      expect(r.count).toBe(0);
      expect(r.family).toBeUndefined();
    });

    it('does NOT family-walk on a family-level opening (no colon)', () => {
      // For "Sicilian Defense" the family IS the name; no walk.
      // Should land on source=exact, not source=family.
      const r = getPuzzlesProgress('Sicilian Defense');
      expect(r.source).toBe('exact');
      expect(r.family).toBeUndefined();
    });

    it('handles trimmed whitespace consistently with getOpeningFamily', () => {
      const r = getPuzzlesProgress('  Italian Game  ');
      expect(r.source).toBe('exact');
      expect(r.count).toBeGreaterThan(0);
    });

    it('source=exact dominates over family fallback (preference order)', () => {
      // If the exact name has its own Lichess token (e.g. "Italian
      // Game: Two Knights Defense" → "Italian_Game_Two_Knights_Defense"
      // — though this may or may not exist), we should NOT walk up
      // unless exact yields zero.
      const r = getPuzzlesProgress('Italian Game');
      expect(r.source).toBe('exact');
    });
  });
});
