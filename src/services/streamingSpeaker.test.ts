import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock voiceService BEFORE importing streamingSpeaker (the module
// imports voiceService at top-level). The mock just counts calls so
// we can assert each unique sentence speaks exactly once.
const speakIfFreeMock = vi.fn(async (_text: string) => undefined);
const speakForcedMock = vi.fn(async (_text: string) => undefined);
const isPlayingMock = vi.fn(() => false);

vi.mock('./voiceService', () => ({
  voiceService: {
    speakIfFree: (text: string) => speakIfFreeMock(text),
    speakForced: (text: string) => speakForcedMock(text),
    isPlaying: () => isPlayingMock(),
  },
}));

const { createStreamingDispatcher, createStreamingSpeaker } = await import(
  './streamingSpeaker'
);
const { SENTENCE_END_RE } = await import('./sanitizeCoachText');

beforeEach(() => {
  speakIfFreeMock.mockClear();
  speakForcedMock.mockClear();
  isPlayingMock.mockReturnValue(false);
});

describe('createStreamingDispatcher — no duplicate dispatches across chunks', () => {
  it('speaks each sentence exactly once when chunks accumulate', async () => {
    const d = createStreamingDispatcher(SENTENCE_END_RE);

    // Simulate the LLM stream growing chunk-by-chunk.
    d.push('Hello there.');
    d.push('Hello there. This is the plan.');
    d.push('Hello there. This is the plan. Let us begin.');

    // Allow the speaker chain to flush.
    await new Promise((r) => setTimeout(r, 0));

    const spoken = [
      ...speakIfFreeMock.mock.calls.map((c) => c[0]),
      ...speakForcedMock.mock.calls.map((c) => c[0]),
    ];

    // No repeats — each sentence appears exactly once.
    expect(spoken).toEqual([
      'Hello there.',
      'This is the plan.',
      'Let us begin.',
    ]);
  });

  it('handles incomplete sentence trailing the chunk', async () => {
    const d = createStreamingDispatcher(SENTENCE_END_RE);

    d.push('First sentence.');
    d.push('First sentence. Second mid'); // mid-sentence
    d.push('First sentence. Second mid-flight.'); // completes
    d.push('First sentence. Second mid-flight. Third.'); // adds another

    await new Promise((r) => setTimeout(r, 0));

    const spoken = [
      ...speakIfFreeMock.mock.calls.map((c) => c[0]),
      ...speakForcedMock.mock.calls.map((c) => c[0]),
    ];
    expect(spoken).toEqual([
      'First sentence.',
      'Second mid-flight.',
      'Third.',
    ]);
  });

  it('is a no-op when push is called with no new text', async () => {
    const d = createStreamingDispatcher(SENTENCE_END_RE);
    d.push('Hello there.');
    d.push('Hello there.'); // identical
    d.push('Hello there.'); // identical
    await new Promise((r) => setTimeout(r, 0));

    const spoken = [
      ...speakIfFreeMock.mock.calls.map((c) => c[0]),
      ...speakForcedMock.mock.calls.map((c) => c[0]),
    ];
    expect(spoken).toEqual(['Hello there.']);
  });

  it('count() reflects total sentences dispatched, not push() calls', () => {
    const d = createStreamingDispatcher(SENTENCE_END_RE);
    d.push('One.');
    d.push('One. Two.');
    d.push('One. Two. Three.');
    expect(d.count()).toBe(3);
  });
});
