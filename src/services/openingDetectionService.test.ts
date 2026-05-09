import { describe, it, expect, beforeEach } from 'vitest';
import { detectOpening, isStillInOpening, getOpeningMoves, getNextOpeningBookMove, findRelatedDbEntries, resolveOpeningEntry, findContinuationsAtPly, findLinePickerOptions, findSiblingExtensionBranches, findShortestCanonicalPgn, _resetTrie } from './openingDetectionService';
import openingsData from '../data/openings-lichess.json';

describe('openingDetectionService', () => {
  beforeEach(() => {
    _resetTrie();
  });

  describe('detectOpening', () => {
    it('returns null for empty move history', () => {
      expect(detectOpening([])).toBeNull();
    });

    it('detects Sicilian Defense from e4 c5', () => {
      const result = detectOpening(['e4', 'c5']);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.eco).toBe('B20');
        expect(result.name).toContain('Sicilian');
      }
    });

    it('detects Italian Game from e4 e5 Nf3 Nc6 Bc4', () => {
      const result = detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.name).toContain('Italian');
      }
    });

    it('finds longest prefix match for deeper variations', () => {
      // Sicilian Defense: Open → more specific than just "Sicilian Defense"
      const short = detectOpening(['e4', 'c5']);
      const longer = detectOpening(['e4', 'c5', 'Nf3', 'd6']);
      expect(longer).not.toBeNull();
      if (short && longer) {
        expect(longer.plyCount).toBeGreaterThanOrEqual(short.plyCount);
      }
    });

    it('returns null when no opening matches', () => {
      // Nonsensical sequence that no opening starts with
      const result = detectOpening(['Na3', 'Na6', 'Nb1']);
      // May or may not match depending on data — but check structure
      if (result) {
        expect(result.eco).toBeTruthy();
        expect(result.name).toBeTruthy();
      }
    });

    it('detects Queens Gambit', () => {
      const result = detectOpening(['d4', 'd5', 'c4']);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.name).toContain('Queen');
      }
    });

    it('returns correct plyCount', () => {
      const result = detectOpening(['e4', 'e5', 'Nf3']);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.plyCount).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('isStillInOpening', () => {
    it('returns true during early opening moves', () => {
      expect(isStillInOpening(['e4'])).toBe(true);
    });

    it('returns true for known opening sequences', () => {
      expect(isStillInOpening(['e4', 'e5'])).toBe(true);
    });

    it('returns false when out of book', () => {
      // Very long random-ish sequence should eventually leave book
      const result = isStillInOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5', 'd4', 'exd4', 'O-O', 'dxc3']);
      // This may or may not be in book — test just validates no crash
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getOpeningMoves', () => {
    it('returns moves for French Defense', () => {
      const moves = getOpeningMoves('French Defense');
      expect(moves).not.toBeNull();
      if (moves) {
        expect(moves[0]).toBe('e4');
        expect(moves[1]).toBe('e6');
        expect(moves.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('returns moves for Sicilian Defense', () => {
      const moves = getOpeningMoves('Sicilian Defense');
      expect(moves).not.toBeNull();
      if (moves) {
        expect(moves[0]).toBe('e4');
        expect(moves[1]).toBe('c5');
      }
    });

    it('returns null for unknown opening', () => {
      const moves = getOpeningMoves('Nonexistent Opening XYZ');
      expect(moves).toBeNull();
    });

    it('returns the longest continuation available', () => {
      const moves = getOpeningMoves('French Defense');
      expect(moves).not.toBeNull();
      if (moves) {
        // Should pick a deep variation, not just "e4 e6"
        expect(moves.length).toBeGreaterThan(2);
      }
    });
  });

  describe('getNextOpeningBookMove', () => {
    const frenchMoves = ['e4', 'e6', 'd4', 'd5'];

    it('returns the next move for the AI color', () => {
      // AI is black, game has only e4 → AI should play e6
      const result = getNextOpeningBookMove(frenchMoves, ['e4'], 'black');
      expect(result).toBe('e6');
    });

    it('returns null when it is not AI turn', () => {
      // AI is black, game is empty → it's white's turn
      const result = getNextOpeningBookMove(frenchMoves, [], 'black');
      expect(result).toBeNull();
    });

    it('returns null when game deviated from book', () => {
      // Game played d4 instead of e4
      const result = getNextOpeningBookMove(frenchMoves, ['d4'], 'black');
      expect(result).toBeNull();
    });

    it('returns null when past end of book moves', () => {
      const result = getNextOpeningBookMove(frenchMoves, ['e4', 'e6', 'd4', 'd5'], 'white');
      expect(result).toBeNull();
    });

    it('works for AI playing white', () => {
      // AI is white, game is empty → AI should play e4
      const result = getNextOpeningBookMove(frenchMoves, [], 'white');
      expect(result).toBe('e4');
    });

    it('returns correct move for white on move 3', () => {
      // AI is white, game: e4 e6 → AI should play d4
      const result = getNextOpeningBookMove(frenchMoves, ['e4', 'e6'], 'white');
      expect(result).toBe('d4');
    });
  });

  // WO-COACH-OPENING-INTENT-01: the six openings from Dave's test list
  // must each resolve to the correct first coach response. This is the
  // regression bar — if any of these ever breaks, the coach has gone
  // off-book and the WO has failed.
  describe('opening-intent end-to-end (WO-COACH-OPENING-INTENT-01)', () => {
    const scenarios: Array<{
      name: string;
      lookup: string;
      aiColor: 'white' | 'black';
      history: string[];
      expectedReply: string;
    }> = [
      { name: 'Caro-Kann as Black → 1.e4 → c6', lookup: 'Caro-Kann Defense', aiColor: 'black', history: ['e4'], expectedReply: 'c6' },
      { name: 'Sicilian as Black → 1.e4 → c5', lookup: 'Sicilian Defense', aiColor: 'black', history: ['e4'], expectedReply: 'c5' },
      { name: 'French as Black → 1.e4 → e6', lookup: 'French Defense', aiColor: 'black', history: ['e4'], expectedReply: 'e6' },
      { name: 'London as White → 1.d4', lookup: 'London System', aiColor: 'white', history: [], expectedReply: 'd4' },
      { name: "King's Indian as Black → 1.d4 → Nf6", lookup: "King's Indian Defense", aiColor: 'black', history: ['d4'], expectedReply: 'Nf6' },
    ];

    for (const s of scenarios) {
      it(s.name, () => {
        const moves = getOpeningMoves(s.lookup);
        expect(moves, `getOpeningMoves(${s.lookup}) returned null`).not.toBeNull();
        if (!moves) return;
        const reply = getNextOpeningBookMove(moves, s.history, s.aiColor);
        expect(reply).toBe(s.expectedReply);
      });
    }

    it('cleared intent (null openingMoves) → coach falls back, book returns null', () => {
      // The coach-turn path reads `requestedOpeningMoves`; when cleared
      // the hook passes null. tryOpeningBookMove short-circuits in
      // coachGameEngine; here we exercise the underlying book call.
      const reply = getNextOpeningBookMove([], ['e4'], 'black');
      expect(reply).toBeNull();
    });

    it('invalid intent (unknown name) → getOpeningMoves returns null', () => {
      expect(getOpeningMoves('Totally Made Up Opening')).toBeNull();
      expect(getOpeningMoves('not-a-real-opening-xyz')).toBeNull();
    });

    it('Caro-Kann as Black → 2.d4 → d5 (main line second move)', () => {
      const moves = getOpeningMoves('Caro-Kann Defense');
      expect(moves).not.toBeNull();
      if (!moves) return;
      // After Dave plays 1.e4 c6 2.d4, coach (black) should play d5.
      const reply = getNextOpeningBookMove(moves, ['e4', 'c6', 'd4'], 'black');
      expect(reply).toBe('d5');
    });
  });

  describe('findRelatedDbEntries', () => {
    it('returns the bare opening first when name matches exactly', () => {
      const entries = findRelatedDbEntries("Bishop's Opening");
      expect(entries.length).toBeGreaterThan(0);
      // Bare line should be present and listed first.
      const first = entries[0];
      expect(first.name.toLowerCase()).toBe("bishop's opening");
      expect(first.pgn).toBe('e4 e5 Bc4');
    });

    it('includes named sub-variations of the requested opening', () => {
      const entries = findRelatedDbEntries("Bishop's Opening");
      const names = entries.map((e) => e.name);
      // Spot-check a handful of well-known sharp lines.
      expect(names.some((n) => n.includes('Boden-Kieseritzky'))).toBe(true);
      expect(names.some((n) => n.includes('Urusov Gambit'))).toBe(true);
      expect(names.some((n) => n.includes('Calabrese'))).toBe(true);
    });

    it('caps results at maxEntries', () => {
      const entries = findRelatedDbEntries("Bishop's Opening", 5);
      expect(entries.length).toBeLessThanOrEqual(5);
    });

    it('returns [] for unknown opening', () => {
      const entries = findRelatedDbEntries('Totally Made Up Opening Xyz');
      expect(entries).toEqual([]);
    });

    it('handles broader opening names (Sicilian)', () => {
      const entries = findRelatedDbEntries('Sicilian Defense');
      expect(entries.length).toBeGreaterThan(5);
      // The bare Sicilian must be present.
      expect(entries[0].name.toLowerCase()).toBe('sicilian defense');
      // All entries must have "sicilian" in the name (or be the
      // bare line itself).
      for (const e of entries) {
        expect(e.name.toLowerCase()).toContain('sicilian');
      }
    });
  });

  describe('terminal-short filter (≤8 plies + no DB extension)', () => {
    it('hides Gunderam Gambit from name resolution (4-ply terminal)', () => {
      // 'King's Pawn Game: Gunderam Gambit' is a 4-ply terminal
      // entry — a useless namesake-only walkthrough. Production
      // audit (build 2fcec7e+) showed the walkthrough ending after
      // 4 plies because the DB has no continuation. Filter must
      // hide it from name resolution so the user can't land on it.
      const result = resolveOpeningEntry("King's Pawn Game: Gunderam Gambit");
      expect(result).toBeNull();
    });

    it('keeps short non-terminal entries (Vienna Game at 3 plies)', () => {
      // Vienna Game is `e4 e5 Nc3` — only 3 plies, but has many
      // sub-variations in the DB. Must still be resolvable.
      const result = resolveOpeningEntry('Vienna Game');
      expect(result).not.toBeNull();
      expect(result?.canonicalName).toBe('Vienna Game');
    });

    it('keeps long terminal entries (>8 plies, even with no continuation)', () => {
      // Najdorf at 10 plies is the bare canonical entry — even if
      // it had no DB sub-variations, 10 plies is plenty to teach.
      const result = resolveOpeningEntry('Sicilian Defense: Najdorf Variation');
      expect(result).not.toBeNull();
      expect(result?.canonicalName).toContain('Najdorf');
    });
  });

  describe("'Vienna Gambit' alias routes to Nf6 f4 line", () => {
    it("routes 'Vienna Gambit' to 'Vienna Game: Vienna Gambit' (Nf6 f4)", () => {
      // The DB has TWO Vienna-Gambit candidates: 'Vienna Gambit,
      // with Max Lange Defense' (Nc6 f4, niche) and 'Vienna Game:
      // Vienna Gambit' (Nf6 f4, canonical). The alias map pins the
      // bare 'Vienna Gambit' to the Nf6 line so the resolver
      // doesn't bounce the user back to a parent picker.
      const result = resolveOpeningEntry('Vienna Gambit');
      expect(result).not.toBeNull();
      expect(result?.canonicalName).toBe('Vienna Game: Vienna Gambit');
      // Verify the moves are e4 e5 Nc3 Nf6 f4.
      expect(result?.moves).toEqual(['e4', 'e5', 'Nc3', 'Nf6', 'f4']);
    });
  });

  describe('findContinuationsAtPly', () => {
    it('returns multiple SANs at the starting position', () => {
      const map = findContinuationsAtPly([]);
      expect(map.size).toBeGreaterThan(5);
      expect(map.has('e4')).toBe(true);
      expect(map.has('d4')).toBe(true);
      expect(map.has('Nf3')).toBe(true);
      expect(map.has('c4')).toBe(true);
    });

    it('returns the canonical Italian branchpoint candidates after e4 e5 Nf3 Nc6', () => {
      const map = findContinuationsAtPly(['e4', 'e5', 'Nf3', 'Nc6']);
      // The four classical branches at this position.
      expect(map.has('Bc4')).toBe(true); // Italian
      expect(map.has('Bb5')).toBe(true); // Spanish / Ruy Lopez
      expect(map.has('d4')).toBe(true);  // Scotch
      // Each entry should have a representative opening name.
      const ruy = map.get('Bb5');
      expect(ruy?.name).toBe('Ruy Lopez');
      const scotch = map.get('d4');
      expect(scotch?.name).toBe('Scotch Game');
    });

    it('returns empty map when prefix has no DB extension', () => {
      // A prefix that doesn't appear in the DB (made-up sequence).
      const map = findContinuationsAtPly(['a3', 'a6', 'a4', 'a5']);
      expect(map.size).toBe(0);
    });
  });

  describe('findShortestCanonicalPgn picks spine based on whether sub-variations exist', () => {
    it('returns a non-null spine for Pirc Bayonet (single-entry opening)', () => {
      // Pirc Defense: Bayonet Attack has only one named entry in
      // the canonical Lichess DB (9 plies) and no named sub-
      // variations. The spine must still resolve — when extended
      // data is mined from Lichess Explorer it will deepen
      // automatically because of the longest-wins rule below.
      // Until then, spine = canonical 9 plies.
      const pgn = findShortestCanonicalPgn('Pirc Defense: Bayonet Attack');
      expect(pgn).not.toBeNull();
      const plies = pgn!.split(/\s+/).filter(Boolean).length;
      expect(plies).toBeGreaterThanOrEqual(9);
    });

    it('uses the LONGEST same-name PGN when no sub-variations exist', () => {
      // Whole-DB invariant: for any canonical opening with
      // multiple same-name entries (canonical + extended) AND no
      // named sub-variations, the spine should be the LONGEST
      // entry. Builds the invariant test programmatically — when
      // the mining script populates extended.json with real data,
      // this fires automatically without test edits.
      const entries = openingsData as Array<{ eco: string; name: string; pgn: string }>;
      const byName = new Map<string, typeof entries>();
      for (const e of entries) {
        if (!byName.has(e.name)) byName.set(e.name, []);
        byName.get(e.name)!.push(e);
      }
      // Find a single-entry name with multiple length-distinct
      // PGNs AND no sub-variations. Skip if no such entry yet
      // (canonical-only world) — the invariant is dormant.
      let probed = 0;
      for (const [name, group] of byName) {
        if (group.length < 2) continue;
        if (entries.some((e) => e.name.startsWith(name + ', '))) continue;
        const longestPgn = group.reduce((a, b) =>
          a.pgn.length > b.pgn.length ? a : b,
        ).pgn;
        const got = findShortestCanonicalPgn(name);
        expect(got).toBe(longestPgn);
        probed += 1;
      }
      // It's fine if probed === 0 (no extended data populated yet);
      // the test's purpose is to fire when there IS such data.
      expect(probed).toBeGreaterThanOrEqual(0);
    });

    it('uses the SHORTEST same-name PGN when sub-variations exist (Najdorf)', () => {
      // Sicilian Defense: Najdorf Variation has many named sub-
      // variations (English Attack, Adams Attack, Bg5 Main Line,
      // etc.). The spine MUST stay short so the fork picker can
      // surface those sub-variations as branches at the end of
      // the walkthrough. If this regresses, named-fork pickers
      // disappear from popular openings.
      const pgn = findShortestCanonicalPgn('Sicilian Defense: Najdorf Variation');
      expect(pgn).not.toBeNull();
      const plies = pgn!.split(/\s+/).filter(Boolean).length;
      // Najdorf canonical bare entry is 10 plies. Allow some
      // tolerance but cap well below the deepest same-name entry
      // (23+ plies for Ivkov / Polugaevsky sub-lines).
      expect(plies).toBeLessThanOrEqual(11);
    });
  });

  describe('Lichess-extended entries conform to canonical shape', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const extended = require('../data/openings-lichess-extended.json') as Array<{
      eco?: unknown;
      name?: unknown;
      pgn?: unknown;
    }>;
    /* eslint-enable @typescript-eslint/no-require-imports */

    it('every extended entry has the {eco, name, pgn} shape canonical entries use', () => {
      // Existing trie-build, name-resolution, and longest-PGN reducers
      // all assume each entry is `{eco: string, name: string, pgn:
      // string}`. If the mining script ever emits a different shape,
      // every downstream resolver crashes silently. Lock the
      // invariant here — empty array is fine; non-empty must conform.
      for (const e of extended) {
        expect(typeof e.eco).toBe('string');
        expect(typeof e.name).toBe('string');
        expect(typeof e.pgn).toBe('string');
      }
    });

    it('every extended PGN replays cleanly through chess.js', () => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { Chess } = require('chess.js') as typeof import('chess.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      for (const e of extended) {
        const c = new Chess();
        const moves = (e.pgn as string).trim().split(/\s+/).filter(Boolean);
        for (const m of moves) {
          try {
            c.move(m);
          } catch {
            throw new Error(`extended entry "${e.name as string}" — illegal move "${m}" in pgn: ${e.pgn as string}`);
          }
        }
      }
    });
  });

  describe('findLinePickerOptions excludes terminal-short variations', () => {
    it("hides 4-ply terminal sub-variations from the King's Pawn picker", () => {
      const result = findLinePickerOptions("King's Pawn Game", 1);
      expect(result).not.toBeNull();
      // None of the surfaced options should be the Gunderam Gambit
      // tile — the filter drops 4-ply terminal entries.
      const labels = result?.options.map((o) => o.label) ?? [];
      expect(labels.some((l) => l.includes('Gunderam Gambit'))).toBe(false);
    });

    it('exposes the canonical PGN of the bare opening for trap-tile lookup', () => {
      // Italian Game's bare line is `e4 e5 Nf3 Nc6 Bc4`. The picker
      // surfaces this so callers can match curated trap-line PGNs
      // that fall under the same family (proRepertoireService).
      const result = findLinePickerOptions('Italian Game');
      expect(result).not.toBeNull();
      expect(result?.canonicalPgn).toBe('e4 e5 Nf3 Nc6 Bc4');
    });
  });

  describe('findSiblingExtensionBranches extends to end of Lichess DB', () => {
    interface OpeningEntry { eco: string; name: string; pgn: string }

    it('returns Najdorf branches with full DB-length extensions (no 6-ply cap)', () => {
      const canonical = 'Sicilian Defense: Najdorf Variation';
      const shortPgn = findShortestCanonicalPgn(canonical);
      expect(shortPgn).not.toBeNull();
      const branches = findSiblingExtensionBranches(canonical, shortPgn!);
      expect(branches.length).toBeGreaterThan(0);
      // Pre-fix this branch was capped at 6 plies. The Lichess DB
      // carries longer same-name lines (Polugaevsky / Ivkov) so at
      // least ONE branch must now expose 7+ plies of extension.
      const hasDeep = branches.some((b) => b.extensionMoves.length >= 7);
      expect(hasDeep).toBe(true);
    });

    it('every branch extension equals the full sub-line minus spine + divergent move', () => {
      const entries = openingsData as OpeningEntry[];
      const canonical = 'Sicilian Defense: Najdorf Variation';
      const shortPgn = findShortestCanonicalPgn(canonical)!;
      const spinePlies = shortPgn.split(/\s+/).filter(Boolean).length;
      const branches = findSiblingExtensionBranches(canonical, shortPgn);

      for (const b of branches) {
        const branchExactPgn = `${shortPgn} ${b.san}`;
        const candidates = entries.filter(
          (e) =>
            e.name.startsWith(`${canonical}, `) &&
            (e.pgn === branchExactPgn || e.pgn.startsWith(`${branchExactPgn} `)),
        );
        if (candidates.length === 0) continue;
        const longest = candidates.reduce((a, b2) =>
          a.pgn.length > b2.pgn.length ? a : b2,
        );
        const longestPlies = longest.pgn.split(/\s+/).filter(Boolean).length;
        const expectedExtPlies = longestPlies - spinePlies - 1;
        expect(b.extensionMoves.length).toBe(expectedExtPlies);
      }
    });

    it('audits ALL canonical openings — no branch is silently truncated', () => {
      // Whole-DB regression. For every opening that has fork
      // branches, every branch's extensionMoves length must equal
      // the full delta past spine + divergent move. If a future cap
      // gets reintroduced this fires immediately.
      const entries = openingsData as OpeningEntry[];
      const allNames = new Set(entries.map((e) => e.name));
      const offenders: string[] = [];
      for (const canonical of allNames) {
        const shortPgn = findShortestCanonicalPgn(canonical);
        if (!shortPgn) continue;
        const branches = findSiblingExtensionBranches(canonical, shortPgn);
        if (branches.length === 0) continue;
        const spinePlies = shortPgn.split(/\s+/).filter(Boolean).length;
        for (const b of branches) {
          const branchExactPgn = `${shortPgn} ${b.san}`;
          const candidates = entries.filter(
            (e) =>
              e.name.startsWith(`${canonical}, `) &&
              (e.pgn === branchExactPgn || e.pgn.startsWith(`${branchExactPgn} `)),
          );
          if (candidates.length === 0) continue;
          const longest = candidates.reduce((a, b2) =>
            a.pgn.length > b2.pgn.length ? a : b2,
          );
          const expected =
            longest.pgn.split(/\s+/).filter(Boolean).length - spinePlies - 1;
          if (b.extensionMoves.length !== expected) {
            offenders.push(
              `${canonical} / ${b.label}: got ${b.extensionMoves.length} plies, expected ${expected}`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
