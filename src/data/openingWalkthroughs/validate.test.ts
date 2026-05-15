/**
 * Validates every registered opening tree against the structural +
 * style rules in `validate.ts`. Acts as the "rubric" — any new
 * opening that ships into the registry must pass these checks.
 *
 * Move QUALITY (Stockfish-backed) is in `auditMoveQuality.ts` and
 * NOT run here (too slow for the regular test suite).
 */
import { describe, it, expect } from 'vitest';
import { VIENNA_GAME } from './vienna';
import {
  validateWalkthroughTree,
  validateMoveLegality,
  formatIssues,
  spokenForm,
  stripSanAnnotations,
} from './validate';

describe('walkthrough tree validation', () => {
  describe('Vienna Game', () => {
    const issues = validateWalkthroughTree(VIENNA_GAME);

    it('has zero ERRORS', () => {
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        // Surfacing the actual messages in the test output makes
        // CI failures debuggable without re-running locally.
         
        console.log(formatIssues(errors));
      }
      expect(errors).toEqual([]);
    });

    it('every SAN sequence in concepts/findMove/drill/punish is legal', () => {
      const legalityIssues = validateMoveLegality(VIENNA_GAME);
      const errors = legalityIssues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
         
        console.log(formatIssues(errors));
      }
      expect(errors).toEqual([]);
    });

    it('has fewer than 25 warnings (style sanity)', () => {
      const warnings = issues.filter((i) => i.severity === 'warning');
      if (warnings.length >= 25) {
         
        console.log(formatIssues(warnings));
      }
      expect(warnings.length).toBeLessThan(25);
    });
  });

  describe('spokenForm SAN-to-prose helper', () => {
    it('translates piece moves to spoken form', () => {
      expect(spokenForm('Nc3')).toBe('knight to c3');
      expect(spokenForm('Bc4')).toBe('bishop to c4');
      expect(spokenForm('Rxe4')).toBe('rook to e4');
      expect(spokenForm('Qxd5')).toBe('queen to d5');
      expect(spokenForm('Kxe2')).toBe('king to e2');
    });

    it('preserves castle notation', () => {
      expect(spokenForm('O-O')).toBe('O-O');
      expect(spokenForm('O-O-O')).toBe('O-O-O');
    });

    it('preserves pawn moves as-is (SAN already lowercase letter)', () => {
      expect(spokenForm('e4')).toBe('e4');
      expect(spokenForm('exd5')).toBe('exd5');
      expect(spokenForm('d4')).toBe('d4');
    });

    it('handles disambiguated piece moves (e.g. Nbxd5)', () => {
      // The destination square is what gets spoken.
      expect(spokenForm('Nbxd5')).toBe('knight to d5');
      expect(spokenForm('R1xe4')).toBe('rook to e4');
    });
  });

  describe('stripSanAnnotations', () => {
    it('strips trailing ? annotation marks', () => {
      expect(stripSanAnnotations('g4?')).toBe('g4');
      expect(stripSanAnnotations('Bg5?')).toBe('Bg5');
      expect(stripSanAnnotations('f4?')).toBe('f4');
    });

    it('strips trailing ! annotation marks', () => {
      expect(stripSanAnnotations('Qxh5!')).toBe('Qxh5');
      expect(stripSanAnnotations('Bxf7+!')).toBe('Bxf7+');
    });

    it('strips compound annotation marks (??, !!, !?, ?!)', () => {
      expect(stripSanAnnotations('Nf6??')).toBe('Nf6');
      expect(stripSanAnnotations('Bb5!!')).toBe('Bb5');
      expect(stripSanAnnotations('h3!?')).toBe('h3');
      expect(stripSanAnnotations('a4?!')).toBe('a4');
    });

    it('strips leading move-number prefix', () => {
      expect(stripSanAnnotations('1.e4')).toBe('e4');
      expect(stripSanAnnotations('1...d5')).toBe('d5');
      expect(stripSanAnnotations('15.Nf3')).toBe('Nf3');
    });

    it('preserves check/mate suffixes (legal SAN)', () => {
      expect(stripSanAnnotations('Qxd8+')).toBe('Qxd8+');
      expect(stripSanAnnotations('Qh7#')).toBe('Qh7#');
    });

    it('returns clean SAN unchanged', () => {
      expect(stripSanAnnotations('e4')).toBe('e4');
      expect(stripSanAnnotations('Nc3')).toBe('Nc3');
      expect(stripSanAnnotations('O-O-O')).toBe('O-O-O');
    });
  });
});
