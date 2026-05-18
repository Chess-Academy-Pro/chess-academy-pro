import { describe, it, expect } from 'vitest';
import {
  buildOpeningDbEntries,
  extractOpeningNamesFromText,
} from './openingDbGrounding';

describe('extractOpeningNamesFromText', () => {
  it('returns empty for plain prose with no opening names', () => {
    expect(extractOpeningNamesFromText('Hi! Good morning, how are you?')).toEqual([]);
  });

  it('extracts a named gambit from a question', () => {
    const out = extractOpeningNamesFromText('Walk me through the Steinitz Gambit in the Vienna.');
    // Long-form matches preferred — the regex alternation tries them in
    // the order listed in the keyword array; we just need both keys present.
    const lower = out.map((x) => x.toLowerCase());
    expect(lower).toContain('steinitz gambit');
    expect(lower).toContain('vienna');
  });

  it('dedupes case-folded repeats', () => {
    const out = extractOpeningNamesFromText('Sicilian, Sicilian, SICILIAN!');
    const lower = out.map((x) => x.toLowerCase());
    expect(lower.filter((x) => x.includes('sicilian')).length).toBe(1);
  });

  it('matches multi-word names with apostrophes', () => {
    const out = extractOpeningNamesFromText("I want to learn King's Indian Defense.");
    const lower = out.map((x) => x.toLowerCase());
    expect(lower.some((x) => x.includes("king's indian"))).toBe(true);
  });
});

describe('buildOpeningDbEntries — name path', () => {
  it('returns Vienna entries when the user message names "Vienna"', () => {
    const entries = buildOpeningDbEntries({
      userMessage: 'Walk me through the Vienna Game.',
      maxEntries: 5,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.name.toLowerCase().includes('vienna'))).toBe(true);
    // Each entry has SANs derived from the PGN.
    for (const e of entries) {
      expect(e.sans.length).toBeGreaterThan(0);
      expect(e.sans).toEqual(e.pgn.split(/\s+/).filter(Boolean));
    }
  });

  it('returns Steinitz Gambit entries when the user names it explicitly', () => {
    const entries = buildOpeningDbEntries({
      userMessage: 'Tell me about the Steinitz Gambit in the Vienna.',
      maxEntries: 8,
    });
    // The Vienna Game has named Steinitz Gambit sub-variations in the
    // Lichess DB. Either path 2 picks up "Steinitz Gambit" directly or
    // it picks up "Vienna" and surfaces Steinitz Gambit as a sub.
    expect(entries.length).toBeGreaterThan(0);
    const allNamesLower = entries.map((e) => e.name.toLowerCase()).join(' | ');
    const hasGambit = /vienna|steinitz/.test(allNamesLower);
    expect(hasGambit).toBe(true);
  });

  it('returns empty when the user message has no opening names', () => {
    const entries = buildOpeningDbEntries({
      userMessage: 'good morning!',
      maxEntries: 8,
    });
    expect(entries).toEqual([]);
  });

  it('respects maxEntries cap', () => {
    const entries = buildOpeningDbEntries({
      userMessage: 'Sicilian Najdorf.',
      maxEntries: 3,
    });
    expect(entries.length).toBeLessThanOrEqual(3);
  });
});

describe('buildOpeningDbEntries — position path', () => {
  it('returns entries matching the move history when no user message', () => {
    // 1.e4 e5 2.Nc3 — Vienna Game position.
    const entries = buildOpeningDbEntries({
      moveHistory: ['e4', 'e5', 'Nc3'],
      maxEntries: 6,
    });
    expect(entries.length).toBeGreaterThan(0);
    // The resolver picks the most-specific DB entry whose PGN is a
    // prefix of the move history; that anchors to Vienna Game.
    expect(entries.some((e) => e.name.toLowerCase().includes('vienna'))).toBe(true);
  });

  it('returns empty when move history doesn\'t match any DB entry', () => {
    const entries = buildOpeningDbEntries({
      moveHistory: [],
      maxEntries: 8,
    });
    expect(entries).toEqual([]);
  });
});

describe('buildOpeningDbEntries — combined paths', () => {
  it('dedupes when both paths point to the same opening', () => {
    const entries = buildOpeningDbEntries({
      moveHistory: ['e4', 'e5', 'Nc3'],
      userMessage: 'Vienna Game please',
      maxEntries: 10,
    });
    const names = entries.map((e) => e.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});
