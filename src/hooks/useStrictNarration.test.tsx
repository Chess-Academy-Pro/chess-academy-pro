import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Promise-based mock of voiceService. Each `speak` returns a controllable
// promise so tests can assert on supersession ordering.
type SpeakRecord = {
  text: string;
  resolve: () => void;
  reject: (err: Error) => void;
};
const speakRecords: SpeakRecord[] = [];
let stopCount = 0;

vi.mock('../services/voiceService', () => ({
  voiceService: {
    speak: vi.fn((text: string) => {
      return new Promise<void>((resolve, reject) => {
        speakRecords.push({ text, resolve, reject });
      });
    }),
    stop: vi.fn(() => {
      stopCount++;
    }),
  },
}));

import { useStrictNarration } from './useStrictNarration';

beforeEach(() => {
  speakRecords.length = 0;
  stopCount = 0;
});

const STEPS = [
  { narration: 'Step zero narration.' },
  { narration: 'Step one narration.' },
  { narration: 'Step two narration.' },
];

function defaultProps(overrides: Partial<Parameters<typeof useStrictNarration>[0]> = {}): Parameters<typeof useStrictNarration>[0] {
  return {
    stepCount: STEPS.length,
    applyStep: vi.fn(),
    getNarration: vi.fn((idx: number) => STEPS[idx]?.narration ?? ''),
    postNarrationDelayMs: 10,
    voiceEnabled: true,
    ...overrides,
  };
}

describe('useStrictNarration', () => {
  it('applies the initial step and starts speaking it', async () => {
    const props = defaultProps();
    renderHook(() => useStrictNarration(props));

    expect(props.applyStep).toHaveBeenCalledWith(0);
    await waitFor(() => expect(speakRecords).toHaveLength(1));
    expect(speakRecords[0].text).toBe('Step zero narration.');
  });

  it('manual next() cancels in-flight speech and supersedes the previous token', async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useStrictNarration(props));

    await waitFor(() => expect(speakRecords).toHaveLength(1));
    const stale = speakRecords[0];

    act(() => {
      result.current.next();
    });

    expect(stopCount).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(speakRecords).toHaveLength(2));
    expect(speakRecords[1].text).toBe('Step one narration.');

    // Resolving the stale promise must NOT trigger any further speech
    const beforeLen = speakRecords.length;
    await act(async () => {
      stale.resolve();
      await Promise.resolve();
    });
    expect(speakRecords.length).toBe(beforeLen);
  });

  it('auto-play does not advance until the speech promise resolves', async () => {
    const props = defaultProps({ postNarrationDelayMs: 5 });
    const { result } = renderHook(() => useStrictNarration(props));

    await waitFor(() => expect(speakRecords).toHaveLength(1));

    act(() => {
      result.current.toggleAutoPlay();
    });
    // Toggling on restarts speech for the current step (token bumps); the
    // previous record is stale.
    await waitFor(() => expect(speakRecords.length).toBeGreaterThanOrEqual(2));
    const activeIdx = speakRecords.length - 1;

    // Wait long enough that any naive fallback timer would have fired
    await new Promise((r) => setTimeout(r, 200));
    expect(speakRecords.length).toBe(activeIdx + 1);
    expect(props.applyStep).toHaveBeenLastCalledWith(0);

    // Now resolve the active speech → next step should play
    await act(async () => {
      speakRecords[activeIdx].resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(speakRecords.length).toBeGreaterThan(activeIdx + 1));
    expect(props.applyStep).toHaveBeenCalledWith(1);
  });

  it('auto-play stops after the final step', async () => {
    // Start one before the end so a single advance lands on the final step.
    const props = defaultProps({ postNarrationDelayMs: 5, initialStepIndex: 1 });
    const { result } = renderHook(() => useStrictNarration(props));

    await waitFor(() => expect(speakRecords).toHaveLength(1));

    act(() => {
      result.current.toggleAutoPlay();
    });
    expect(result.current.isAutoPlaying).toBe(true);

    // Toggling on restarts the current step; resolve the latest record to advance.
    await waitFor(() => expect(speakRecords.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      speakRecords[speakRecords.length - 1].resolve();
      await Promise.resolve();
    });

    // The advance into step 2 fires after postNarrationDelayMs.
    await waitFor(() => expect(speakRecords.length).toBeGreaterThanOrEqual(3));

    // Resolve the final-step speech → auto-play should turn off.
    await act(async () => {
      speakRecords[speakRecords.length - 1].resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isAutoPlaying).toBe(false));
  });

  it('toggleAutoPlay from the end rewinds to step 0', async () => {
    const props = defaultProps({ initialStepIndex: 2 });
    const { result } = renderHook(() => useStrictNarration(props));
    await waitFor(() => expect(speakRecords).toHaveLength(1));

    act(() => {
      result.current.toggleAutoPlay();
    });
    expect(result.current.isAutoPlaying).toBe(true);
    expect(result.current.currentStep).toBe(0);
  });

  it('toggling auto-play OFF cancels pending advance and stops speech', async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useStrictNarration(props));
    await waitFor(() => expect(speakRecords).toHaveLength(1));

    act(() => {
      result.current.toggleAutoPlay();
    });
    const stopsBefore = stopCount;

    act(() => {
      result.current.toggleAutoPlay();
    });

    expect(stopCount).toBeGreaterThan(stopsBefore);
    expect(result.current.isAutoPlaying).toBe(false);
    expect(result.current.isSpeaking).toBe(false);

    // Resolving the now-stale promise must not advance
    await act(async () => {
      speakRecords[0].resolve();
      await Promise.resolve();
    });
    expect(props.applyStep).not.toHaveBeenCalledWith(1);
  });

  it('skips speech entirely when getNarration returns empty (drill mode)', async () => {
    const props = defaultProps({
      getNarration: vi.fn(() => ''),
      postNarrationDelayMs: 5,
    });
    const { result } = renderHook(() => useStrictNarration(props));

    expect(props.applyStep).toHaveBeenCalledWith(0);
    expect(speakRecords).toHaveLength(0);

    act(() => {
      result.current.toggleAutoPlay();
    });

    await waitFor(() => expect(props.applyStep).toHaveBeenCalledWith(1));
  });

  it('prev() cancels speech and goes back', async () => {
    const props = defaultProps({ initialStepIndex: 1 });
    const { result } = renderHook(() => useStrictNarration(props));

    await waitFor(() => expect(speakRecords).toHaveLength(1));
    const stopsBefore = stopCount;

    act(() => {
      result.current.prev();
    });

    expect(stopCount).toBeGreaterThan(stopsBefore);
    expect(result.current.currentStep).toBe(0);
    await waitFor(() => expect(speakRecords).toHaveLength(2));
    expect(speakRecords[1].text).toBe('Step zero narration.');
  });
});
