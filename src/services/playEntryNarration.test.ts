import { describe, it, expect } from 'vitest';
import {
  buildPlayEntryNarration,
  PLAY_ENTRY_DIRECTIVE_COUNT,
  _getDirectiveForTest,
  _DIRECTIVES_FOR_TEST,
} from './playEntryNarration';

describe('playEntryNarration', () => {
  describe('buildPlayEntryNarration', () => {
    it('formats Italian Game as White with one of the directives', () => {
      const line = buildPlayEntryNarration({ openingName: 'Italian Game', studentSide: 'white' });
      expect(line).toMatch(/^Italian Game as White\. /);
      // Directive must be one of the canonical four
      const directive = line.replace(/^Italian Game as White\. /, '');
      expect(_DIRECTIVES_FOR_TEST).toContain(directive);
    });

    it('uses "Black" when studentSide is black (Sicilian)', () => {
      const line = buildPlayEntryNarration({ openingName: 'Sicilian Defense', studentSide: 'black' });
      expect(line).toMatch(/^Sicilian Defense as Black\. /);
    });

    it('trims surrounding whitespace from opening name', () => {
      const line = buildPlayEntryNarration({ openingName: '  Caro-Kann Defense  ', studentSide: 'black' });
      expect(line.startsWith('Caro-Kann Defense as Black.')).toBe(true);
    });

    it('is deterministic — same opening always gets the same directive', () => {
      const a = buildPlayEntryNarration({ openingName: 'Italian Game', studentSide: 'white' });
      const b = buildPlayEntryNarration({ openingName: 'Italian Game', studentSide: 'white' });
      expect(a).toBe(b);
    });

    it('side does NOT change the directive — only the side label', () => {
      const w = buildPlayEntryNarration({ openingName: 'Vienna Game', studentSide: 'white' });
      const b = buildPlayEntryNarration({ openingName: 'Vienna Game', studentSide: 'black' });
      const wDir = w.replace(/^Vienna Game as White\. /, '');
      const bDir = b.replace(/^Vienna Game as Black\. /, '');
      expect(wDir).toBe(bDir);
    });

    it('rotates directives across different openings (typical favorites use ≥2 of the 4)', () => {
      const favorites = [
        'Italian Game',
        'Sicilian Defense',
        'Caro-Kann Defense',
        'French Defense',
        'Queen\'s Gambit',
        'Ruy Lopez',
        'Vienna Game',
        'English Opening',
      ];
      const directives = new Set(favorites.map((n) => _getDirectiveForTest(n)));
      // With 8 openings and 4 directives, hashing should yield ≥2 distinct
      // directives. (Statistically near-impossible for all 8 to bucket the
      // same — would indicate a hash bug or coincidental collision worth
      // investigating.)
      expect(directives.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('content rules (CLAUDE.md Narration Voice Rules)', () => {
    const ALL_LINES = [
      'Italian Game as White. ',
      'Sicilian Defense as Black. ',
    ].flatMap((prefix) => _DIRECTIVES_FOR_TEST.map((d) => prefix + d));

    it('rule 2 — never references the interface', () => {
      for (const line of ALL_LINES) {
        expect(line).not.toMatch(/\b(tap|click|press|button|menu|drawer|toggle)\b/i);
      }
    });

    it('rule 5 — no acknowledgments', () => {
      for (const line of ALL_LINES) {
        expect(line).not.toMatch(/\b(great|excellent|nice|good pick|good choice|well done|correct)\b/i);
      }
    });

    it('rule 6 — no first-person, no meta-coaching in the directive', () => {
      for (const line of ALL_LINES) {
        // The openingName + sideLabel prefix is informative content,
        // not first-person. The directive (second sentence) must stay
        // imperative — no "I" / "me" / "we" / "let's" / "let me".
        const parts = line.split('. ');
        const directive = parts[1] ?? '';
        expect(directive, `directive "${directive}" contains first-person/meta`).not.toMatch(
          /\b(I think|I'll|I will|let's|let me|we'll|we will|show me|tell me|give me|teach me)\b/i,
        );
      }
    });

    it('rule 10 — short (under 12 words)', () => {
      for (const line of ALL_LINES) {
        const wordCount = line.trim().split(/\s+/).length;
        expect(wordCount, `Line too long: "${line}"`).toBeLessThan(12);
      }
    });
  });

  describe('PLAY_ENTRY_DIRECTIVE_COUNT constant', () => {
    it('exports the count for consumers (audit / variant rotation)', () => {
      expect(PLAY_ENTRY_DIRECTIVE_COUNT).toBe(4);
    });
  });
});
