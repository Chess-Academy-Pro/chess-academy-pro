import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./openingService', () => ({
  searchOpenings: vi.fn(),
}));
vi.mock('./annotationService', () => ({
  loadAnnotations: vi.fn(),
  loadSubLineAnnotations: vi.fn(),
}));

// API-leak guard (WO-TEST-CLEANUP-01 Part A) — intercept the
// 6 network-wrapping exports of coachApi + the modern coachService
// brain entry point. Spread-original-override preserves type
// exports, constants, and helpers so transitive imports stay intact;
// only the calls that hit Anthropic / DeepSeek are replaced with
// vi.fn() resolves so this test runs free of API credits.
vi.mock('../coach/coachService', () => ({
  coachService: {
    ask: vi.fn().mockResolvedValue({ text: '', toolCallIds: [], provider: 'deepseek' }),
  },
}));
vi.mock('./coachApi', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./coachApi')>();
  return {
    ...orig,
    getCoachCommentary: vi.fn().mockResolvedValue(''),
    getCoachChatResponse: vi.fn().mockResolvedValue(''),
    getCoachStructuredResponse: vi.fn().mockResolvedValue({}),
    getKidLlmResponse: vi.fn().mockResolvedValue(''),
    callAnthropicWithTool: vi.fn().mockResolvedValue({}),
    callDeepseekWithTool: vi.fn().mockResolvedValue({}),
  };
});

import { searchOpenings } from './openingService';
import { loadAnnotations, loadSubLineAnnotations } from './annotationService';
import {
  matchOpeningForSubject,
  resolveWalkthroughSession,
} from './walkthroughResolver';
import { buildOpeningRecord } from '../test/factories';

const sicilian = buildOpeningRecord({
  id: 'sicilian',
  name: 'Sicilian Defense',
  pgn: 'e4 c5',
  color: 'black',
  variations: [
    { name: 'Najdorf Variation', pgn: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', explanation: '' },
    { name: 'Dragon Variation', pgn: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6', explanation: '' },
  ],
});

describe('matchOpeningForSubject', () => {
  beforeEach(() => {
    vi.mocked(searchOpenings).mockReset();
  });

  it('returns null for empty subject', async () => {
    const match = await matchOpeningForSubject('   ');
    expect(match).toBeNull();
  });

  it('returns the first fuzzy match', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([sicilian]);
    const match = await matchOpeningForSubject('Sicilian');
    expect(match?.opening.id).toBe('sicilian');
    expect(match?.variation).toBeUndefined();
  });

  it('returns null when no opening matches', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([]);
    const match = await matchOpeningForSubject('Flibbertigibbet');
    expect(match).toBeNull();
  });

  it('picks the matching variation when the subject contains its name', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([sicilian]);
    const match = await matchOpeningForSubject('Sicilian Najdorf');
    expect(match?.opening.id).toBe('sicilian');
    expect(match?.variation?.name).toBe('Najdorf Variation');
    expect(match?.variationIndex).toBe(0);
  });

  it('leaves variation undefined when subject is only the opening name', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([sicilian]);
    const match = await matchOpeningForSubject('Sicilian');
    expect(match?.variation).toBeUndefined();
  });
});

describe('resolveWalkthroughSession', () => {
  beforeEach(() => {
    vi.mocked(searchOpenings).mockReset();
    vi.mocked(loadAnnotations).mockReset();
    vi.mocked(loadSubLineAnnotations).mockReset();
  });

  it('returns null when no opening matches', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([]);
    const session = await resolveWalkthroughSession({ subject: 'noop' });
    expect(session).toBeNull();
  });

  it('builds a main-line session with loaded annotations', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([sicilian]);
    vi.mocked(loadAnnotations).mockResolvedValueOnce([
      { san: 'e4', annotation: 'Central thrust.' },
      { san: 'c5', annotation: 'Sicilian reply.' },
    ]);
    const session = await resolveWalkthroughSession({ subject: 'Sicilian' });
    expect(session).not.toBeNull();
    expect(session!.title).toBe('Sicilian Defense');
    expect(session!.steps.length).toBe(2);
    expect(session!.orientation).toBe('black');
  });

  it('builds a variation session when subject matches a variation', async () => {
    vi.mocked(searchOpenings).mockResolvedValueOnce([sicilian]);
    vi.mocked(loadSubLineAnnotations).mockResolvedValueOnce([
      { san: 'e4', annotation: 'A.' },
    ]);
    const session = await resolveWalkthroughSession({
      subject: 'Sicilian Najdorf',
    });
    expect(session).not.toBeNull();
    expect(session!.title).toContain('Najdorf');
    expect(loadSubLineAnnotations).toHaveBeenCalledWith(
      'sicilian',
      'variation-0',
    );
  });
});
