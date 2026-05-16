import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildPuzzlesFamilyFallbackPrompt,
  requestPuzzlesFamilyFallbackVoice,
} from './puzzlesFamilyFallbackNotify';

vi.mock('../coach/coachService', () => ({
  coachService: {
    ask: vi.fn(),
  },
}));

// Eslint-aware import — `coachService` resolves to the mocked module.
import { coachService } from '../coach/coachService';

describe('puzzlesFamilyFallbackNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildPuzzlesFamilyFallbackPrompt', () => {
    it('includes the favorited opening, family, and count', () => {
      const prompt = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'Italian Game: Two Knights Defense',
        family: 'Italian Game',
        count: 48,
      });
      expect(prompt).toContain('Italian Game: Two Knights Defense');
      expect(prompt).toContain('Italian Game');
      expect(prompt).toContain('48');
    });

    it('handles singular "puzzle" when count is 1', () => {
      const prompt = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'Rare Variation',
        family: 'Rare Family',
        count: 1,
      });
      expect(prompt).toContain('1 tagged puzzle ');
      expect(prompt).not.toContain('1 tagged puzzles');
    });

    it('uses plural "puzzles" when count is not 1', () => {
      const p2 = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'X', family: 'Y', count: 2,
      });
      const p0 = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'X', family: 'Y', count: 0,
      });
      expect(p2).toContain('2 tagged puzzles');
      expect(p0).toContain('0 tagged puzzles');
    });

    it('instructs the brain to respond in one coach-voice sentence', () => {
      const prompt = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'X', family: 'Y', count: 10,
      });
      expect(prompt).toMatch(/ONE coach-voice sentence/i);
      // Sanity: bans the patterns we want avoided
      expect(prompt.toLowerCase()).toContain('no first-person');
      expect(prompt.toLowerCase()).toContain('no ui references');
    });

    it('framing itself avoids UI words — brain mimics example phrasing more than rule lists', () => {
      // The brain follows the framing's phrasing more than the rules
      // it's told to follow. "The student tapped their card" leaks
      // UI vocabulary into the response even with an explicit "no UI
      // references" instruction. Keep the framing subject-matter only.
      const prompt = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'Italian Game', family: 'Italian Game', count: 192,
      });
      const factual = prompt.split(/Respond in/i)[0] ?? '';
      // The rules section may legitimately mention UI words in the
      // ban list ("no UI references"); only the factual framing
      // before "Respond in..." must stay UI-free.
      expect(factual.toLowerCase()).not.toMatch(/\b(tap|tapped|card|rolodex|click|button|screen|page)\b/);
    });

    it('includes the librarian-vs-coach tone anchor', () => {
      const prompt = buildPuzzlesFamilyFallbackPrompt({
        favoritedOpening: 'X', family: 'Y', count: 10,
      });
      expect(prompt.toLowerCase()).toContain('coach pointing');
      expect(prompt.toLowerCase()).toContain('librarian');
    });
  });

  describe('requestPuzzlesFamilyFallbackVoice', () => {
    it('passes the standalone-chat surface to coachService.ask', async () => {
      vi.mocked(coachService.ask).mockResolvedValueOnce({
        text: 'No puzzles tagged the exact Two Knights variation; here are 48 in the Italian family.',
        toolCallIds: [],
        provider: 'anthropic',
      });
      await requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: 'Italian Game: Two Knights Defense',
        family: 'Italian Game',
        count: 48,
      });
      expect(coachService.ask).toHaveBeenCalledTimes(1);
      const callArg = vi.mocked(coachService.ask).mock.calls[0][0];
      expect(callArg.surface).toBe('standalone-chat');
      expect(callArg.liveState.surface).toBe('standalone-chat');
    });

    it('returns the trimmed brain text on success', async () => {
      vi.mocked(coachService.ask).mockResolvedValueOnce({
        text: '   Sicilian as Black, full family — 491 puzzles to dig into.   ',
        toolCallIds: [],
        provider: 'deepseek',
      });
      const result = await requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: 'Sicilian Defense: Najdorf',
        family: 'Sicilian Defense',
        count: 491,
      });
      expect(result).toBe('Sicilian as Black, full family — 491 puzzles to dig into.');
    });

    it('returns null on empty brain response', async () => {
      vi.mocked(coachService.ask).mockResolvedValueOnce({
        text: '',
        toolCallIds: [],
        provider: 'anthropic',
      });
      const result = await requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: 'X', family: 'Y', count: 5,
      });
      expect(result).toBeNull();
    });

    it('returns null on brain throw (network error, provider 500, etc.)', async () => {
      vi.mocked(coachService.ask).mockRejectedValueOnce(new Error('network'));
      const result = await requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: 'X', family: 'Y', count: 5,
      });
      expect(result).toBeNull();
    });

    it('includes all three facts in the ask payload', async () => {
      vi.mocked(coachService.ask).mockResolvedValueOnce({
        text: 'ok',
        toolCallIds: [],
        provider: 'anthropic',
      });
      await requestPuzzlesFamilyFallbackVoice({
        favoritedOpening: 'Caro-Kann Defense: Advance, Short Variation',
        family: 'Caro-Kann Defense',
        count: 184,
      });
      const ask = vi.mocked(coachService.ask).mock.calls[0][0].ask;
      expect(ask).toContain('Caro-Kann Defense: Advance, Short Variation');
      expect(ask).toContain('Caro-Kann Defense');
      expect(ask).toContain('184');
    });
  });
});
