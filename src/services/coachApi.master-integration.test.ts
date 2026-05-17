/**
 * coachApi.master-integration.test
 * --------------------------------
 * End-to-end tests for the four-layer master-play grounding pipeline
 * wired into `getCoachChatResponse`. Exercises:
 *
 *   - Layer B (pre-injection): intent detection on the last user
 *     message → master-play context built from cache/local/live →
 *     injected as a system-prompt block.
 *   - Layer D (post-validation): claim validator runs on the LLM's
 *     response; ungrounded SANs / numbers / entities trigger up to
 *     two retries; on exhaustion the stock fallback is served.
 *   - Kid contract: `getKidLlmResponse` does NOT engage grounding;
 *     master-play paths never touch kid LLM calls.
 *   - Non-move-question chat: intent doesn't fire → grounding stays
 *     dormant → streaming behaves as before.
 *
 * Mocks `globalThis.fetch` to intercept both the Lichess explorer
 * proxy and the Anthropic / DeepSeek LLM endpoints. No real network.
 * No `vi.mock()` of the new services (per WO).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCoachChatResponse, getKidLlmResponse } from './coachApi';
import { __resetMasterPlayLookupForTests } from './masterPlayLookup';
import { _resetLichessCircuitBreaker } from './lichessExplorerService';
import { __resetProviderCooldownsForTests } from './coachApi';
import { masterPlayCache } from './masterPlayCache';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STARTING_FEN_4 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

const LICHESS_PAYLOAD = {
  white: 19950,
  draws: 20200,
  black: 9900,
  moves: [
    { uci: 'e2e4', san: 'e4', averageRating: 2480, white: 9000, draws: 8500, black: 4500, game: null },
    { uci: 'd2d4', san: 'd4', averageRating: 2510, white: 7600, draws: 7800, black: 3600, game: null },
    { uci: 'g1f3', san: 'Nf3', averageRating: 2500, white: 2400, draws: 2800, black: 1300, game: null },
    { uci: 'c2c4', san: 'c4', averageRating: 2520, white: 950, draws: 1100, black: 450, game: null },
  ],
  topGames: [
    { id: 'kasp85', white: { name: 'Kasparov, G', rating: 2700 }, black: { name: 'Karpov, A', rating: 2705 }, winner: 'white', year: 1985, month: '1985-10' },
  ],
  opening: null,
};

const EMPTY_LICHESS_PAYLOAD = {
  white: 0, draws: 0, black: 0, moves: [], topGames: [], opening: null,
};

function buildAnthropicResponse(text: string): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** Mock fetch that routes Lichess proxy + Anthropic + DeepSeek to
 *  caller-controlled response sequences. */
interface FetchPlan {
  /** Sequence of Lichess explorer payloads (one per call). */
  lichess?: unknown;
  /** Sequence of LLM text responses. First call gets [0], second [1], etc. */
  llmTexts: string[];
}

function installFetchMock(plan: FetchPlan): { llmCalls: number; lichessCalls: number } {
  const counters = { llmCalls: 0, lichessCalls: 0 };
  let llmIdx = 0;
  let lichessIdx = 0;
  const lichessSeq = Array.isArray(plan.lichess) ? plan.lichess : plan.lichess ? [plan.lichess] : [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/lichess-explorer')) {
      counters.lichessCalls += 1;
      const body = lichessSeq[Math.min(lichessIdx, lichessSeq.length - 1)] ?? EMPTY_LICHESS_PAYLOAD;
      lichessIdx += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.anthropic.com/v1/messages')) {
      counters.llmCalls += 1;
      const text = plan.llmTexts[Math.min(llmIdx, plan.llmTexts.length - 1)] ?? '';
      llmIdx += 1;
      return new Response(JSON.stringify(buildAnthropicResponse(text)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.deepseek.com')) {
      counters.llmCalls += 1;
      // OpenAI-shaped response
      const text = plan.llmTexts[Math.min(llmIdx, plan.llmTexts.length - 1)] ?? '';
      llmIdx += 1;
      const body = {
        id: 'cmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
  return counters;
}

beforeEach(() => {
  __resetMasterPlayLookupForTests();
  _resetLichessCircuitBreaker();
  __resetProviderCooldownsForTests();
  masterPlayCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetMasterPlayLookupForTests();
});

// Helper to drive a single grounded turn.
async function ask(message: string, llmReplies: string[]): Promise<{ response: string; counters: ReturnType<typeof installFetchMock> }> {
  const counters = installFetchMock({ lichess: LICHESS_PAYLOAD, llmTexts: llmReplies });
  const response = await getCoachChatResponse(
    [{ role: 'user', content: message }],
    '',
    undefined,
    'chat_response',
    1024,
    undefined,
    undefined,
    undefined,
    {
      currentFen: STARTING_FEN,
      surface: '/coach/chat',
      sessionId: 'test-session',
    },
  );
  return { response, counters };
}

describe('grounding — intent detection', () => {
  it('does NOT engage on casual chat ("hi")', async () => {
    const counters = installFetchMock({ llmTexts: ['Hello!'] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'hi' }],
      '',
      undefined,
      'chat_response',
      1024,
      undefined,
      undefined,
      undefined,
      { currentFen: STARTING_FEN, surface: '/coach/chat' },
    );
    expect(r).toBe('Hello!');
    expect(counters.lichessCalls).toBe(0); // grounding never built context
  });

  it('does NOT engage on non-move chat ("what is the Sicilian?")', async () => {
    const counters = installFetchMock({ llmTexts: ['The Sicilian is a defense against 1.e4 starting with 1...c5.'] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'what is the Sicilian?' }],
      '',
      undefined,
      'chat_response',
      1024,
      undefined,
      undefined,
      undefined,
      { currentFen: STARTING_FEN, surface: '/coach/chat' },
    );
    expect(r).toContain('Sicilian');
    expect(counters.lichessCalls).toBe(0);
  });

  it('engages on "what should I play here?"', async () => {
    const { counters } = await ask(
      'what should I play here?',
      ['The most popular move here is e4, played in many master games.'],
    );
    expect(counters.lichessCalls).toBeGreaterThan(0);
    expect(counters.llmCalls).toBe(1);
  });

  it('engages on "what do masters play?"', async () => {
    const { counters } = await ask(
      'what do masters play in this position?',
      ['Masters favor e4 here.'],
    );
    expect(counters.lichessCalls).toBeGreaterThan(0);
  });

  it('engages on forceEngage even without intent match', async () => {
    installFetchMock({ lichess: LICHESS_PAYLOAD, llmTexts: ['Sure.'] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'tell me about this' }],
      '',
      undefined,
      'chat_response',
      1024,
      undefined,
      undefined,
      undefined,
      { currentFen: STARTING_FEN, surface: '/coach/chat', forceEngage: true },
    );
    expect(r).toBe('Sure.');
    expect(masterPlayCache.has(STARTING_FEN_4)).toBe(true);
  });
});

describe('grounding — pre-injection + clean validation', () => {
  it('passes through a fully-grounded response on first attempt', async () => {
    // Use only data drawn from context: e4 is in moves; "around 22000
    // games" matches e4's per-move count (white+draws+black = 9000+8500+4500).
    const { response, counters } = await ask(
      'what do masters play here?',
      ['Masters most commonly play e4 — around 22000 master games show the line.'],
    );
    expect(response).toContain('e4');
    expect(counters.llmCalls).toBe(1); // no retry needed
  });
});

describe('grounding — retry on validator trip', () => {
  it('retries when first response invents a SAN, succeeds on attempt 2', async () => {
    const { response, counters } = await ask(
      'what should I play here?',
      [
        'I recommend Nh6 here — masters favor this knight maneuver.', // INVENTED — Nh6 not in context
        'Actually, masters favor e4 or d4 in this position.',         // Clean retry
      ],
    );
    expect(response).toContain('e4');
    expect(counters.llmCalls).toBe(2);
  });

  it('retries twice when validator keeps tripping, then stocks out', async () => {
    const { response, counters } = await ask(
      'what should I play here?',
      [
        'The best move is Nh6.',  // Invented SAN
        'Try Bf6 instead.',         // Still invented
        'Maybe Rf2 is good?',       // Still invented
      ],
    );
    expect(response).toContain("can't verify"); // stock fallback
    expect(counters.llmCalls).toBe(3); // initial + 2 retries
  });

  it('flags invented player names on retry', async () => {
    const { response, counters } = await ask(
      'what do masters play here?',
      [
        'Carlsen plays this often.',  // Carlsen not in our topGames (Kasparov is)
        'Kasparov plays e4 here.',    // Kasparov IS in topGames, plus e4 is in moves
      ],
    );
    expect(counters.llmCalls).toBe(2);
    expect(response).toContain('Kasparov');
  });
});

describe('grounding — no master data (source:none)', () => {
  it('flags any SAN when context has no data', async () => {
    const counters = installFetchMock({ lichess: EMPTY_LICHESS_PAYLOAD, llmTexts: [
      'Try Bb5 here.',
      'How about Nf3?',
      'You should play d4.', // recommendation verb → pawn-move detector fires
    ] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'what should I play here?' }],
      '',
      undefined,
      'chat_response',
      1024,
      undefined,
      undefined,
      undefined,
      { currentFen: STARTING_FEN, surface: '/coach/chat' },
    );
    expect(r).toContain("can't verify"); // stock fallback
    expect(counters.llmCalls).toBe(3);
  });

  it('passes a response that honestly says it cannot verify', async () => {
    installFetchMock({ lichess: EMPTY_LICHESS_PAYLOAD, llmTexts: [
      "I don't have grounded master data for this position. Try the engine.",
    ] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'what should I play here?' }],
      '',
      undefined,
      'chat_response',
      1024,
      undefined,
      undefined,
      undefined,
      { currentFen: STARTING_FEN, surface: '/coach/chat' },
    );
    expect(r).toContain('grounded master data');
  });
});

describe('kid contract — getKidLlmResponse never engages grounding', () => {
  it('does not engage master-play even when kid LLM is asked a move question', async () => {
    const counters = installFetchMock({ lichess: LICHESS_PAYLOAD, llmTexts: ['That\'s the white pawn.'] });
    const r = await getKidLlmResponse(
      [{ role: 'user', content: 'what should I play here?' }],
      '',
      512,
    );
    expect(r).toBe("That's the white pawn.");
    // Lichess should NEVER be called for kid calls.
    expect(counters.lichessCalls).toBe(0);
  });
});

describe('grounding — passes through when grounding is undefined', () => {
  it('keeps the legacy non-grounded path for callers that opt out', async () => {
    const counters = installFetchMock({ llmTexts: ['e4 is a great move!'] });
    const r = await getCoachChatResponse(
      [{ role: 'user', content: 'what should I play here?' }],
      '',
      // no grounding arg
    );
    expect(r).toBe('e4 is a great move!');
    expect(counters.lichessCalls).toBe(0);
  });
});
