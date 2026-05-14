import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNarration } from './useNarration';

vi.mock('../services/voiceService', () => ({
  voiceService: {
    speakForced: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  },
}));

import { voiceService } from '../services/voiceService';

describe('useNarration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls speakForced when text is set on mount', () => {
    renderHook(() => useNarration({ text: 'Hello board' }));
    expect(voiceService.speakForced).toHaveBeenCalledWith('Hello board');
  });

  it('does NOT call speakForced when text is empty', () => {
    renderHook(() => useNarration({ text: '' }));
    expect(voiceService.speakForced).not.toHaveBeenCalled();
  });

  it('speaks again when text changes', () => {
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useNarration({ text: t }),
      { initialProps: { t: 'first' } },
    );
    expect(voiceService.speakForced).toHaveBeenCalledWith('first');
    rerender({ t: 'second' });
    expect(voiceService.speakForced).toHaveBeenCalledWith('second');
    expect(voiceService.speakForced).toHaveBeenCalledTimes(2);
  });

  it('calls stop() when text becomes empty', () => {
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useNarration({ text: t }),
      { initialProps: { t: 'a thing' } },
    );
    rerender({ t: '' });
    expect(voiceService.stop).toHaveBeenCalled();
  });

  it('calls stop() on unmount (route-change cleanup)', () => {
    const { unmount } = renderHook(() =>
      useNarration({ text: 'leaving soon' }),
    );
    unmount();
    expect(voiceService.stop).toHaveBeenCalled();
  });

  it('is inert when enabled=false', () => {
    renderHook(() => useNarration({ text: 'should not speak', enabled: false }));
    expect(voiceService.speakForced).not.toHaveBeenCalled();
  });

  it('stops in-flight speech when enabled flips to false', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useNarration({ text: 'playing', enabled }),
      { initialProps: { enabled: true } },
    );
    expect(voiceService.speakForced).toHaveBeenCalled();
    vi.clearAllMocks();
    rerender({ enabled: false });
    expect(voiceService.stop).toHaveBeenCalled();
    expect(voiceService.speakForced).not.toHaveBeenCalled();
  });

  it('replay() re-fires the current text', () => {
    const { result } = renderHook(() => useNarration({ text: 'replayed' }));
    vi.clearAllMocks();
    act(() => {
      result.current.replay();
    });
    expect(voiceService.speakForced).toHaveBeenCalledWith('replayed');
  });

  it('stop() cancels speech immediately', () => {
    const { result } = renderHook(() => useNarration({ text: 'stop me' }));
    act(() => {
      result.current.stop();
    });
    expect(voiceService.stop).toHaveBeenCalled();
  });

  it('dedups identical text within the 6s window (re-render with same text)', () => {
    // Live audit (build 7eca7c3) caught the same /coach/endgame
    // narration spoken 5× in 21s. The hook now blocks identical-text
    // re-fires within 6 s. Simulate a re-render loop by re-passing
    // the same text via rerender(); previously this fired multiple
    // speaks even though React's useEffect dep array would also have
    // blocked them — the dedup is a defensive double-guard against
    // upstream remounts / hot-reload edge cases.
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useNarration({ text: t }),
      { initialProps: { t: 'rule of the square' } },
    );
    expect(voiceService.speakForced).toHaveBeenCalledTimes(1);
    // Same text re-passed (simulates parent re-render with stable text);
    // useEffect dep array would also block this, but the dedup is a
    // belt-and-suspenders guard against any caller bug.
    rerender({ t: 'rule of the square' });
    rerender({ t: 'rule of the square' });
    expect(voiceService.speakForced).toHaveBeenCalledTimes(1);
  });

  it('replay() bypasses the dedup window — user-triggered re-fire works', () => {
    const { result } = renderHook(() =>
      useNarration({ text: 'narrate me' }),
    );
    expect(voiceService.speakForced).toHaveBeenCalledTimes(1);
    // Immediate replay (well within 6s) must still speak — user
    // clicked the replay button and EXPECTS to hear it again.
    act(() => {
      result.current.replay();
    });
    expect(voiceService.speakForced).toHaveBeenCalledTimes(2);
    expect(voiceService.speakForced).toHaveBeenLastCalledWith('narrate me');
  });

  it('dedup only blocks immediate-identical fires — A → B → A still speaks A', () => {
    // The dedup is intentionally narrow: it tracks the LAST spoken
    // text only, not an arbitrary recent-history set. So A → B → A
    // speaks all three times because by the time the second A fires,
    // the last-spoken value is B (different). This matches the audit-
    // fix intent — the bug was the SAME narration firing N times in
    // rapid succession (re-render loop), not the user legitimately
    // navigating between distinct lessons.
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useNarration({ text: t }),
      { initialProps: { t: 'first' } },
    );
    expect(voiceService.speakForced).toHaveBeenCalledTimes(1);
    rerender({ t: 'second' });
    expect(voiceService.speakForced).toHaveBeenCalledTimes(2);
    rerender({ t: 'first' });
    expect(voiceService.speakForced).toHaveBeenCalledTimes(3);
  });

  it('bumps token so a stale promise resolution does not re-trigger speak', async () => {
    // Build a controllable speakForced — the first call's promise
    // stays pending forever; we then change text, and assert the
    // first promise's eventual reject does NOT cause a re-speak.
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    vi.mocked(voiceService.speakForced)
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => Promise.resolve());
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useNarration({ text: t }),
      { initialProps: { t: 'first' } },
    );
    // Switch text — supersedes the first speak.
    rerender({ t: 'second' });
    // Resolve the stale promise. The token check inside the hook
    // should make this a no-op.
    resolveFirst();
    await Promise.resolve();
    // speakForced should have been called exactly twice — once for
    // each text value — NOT a third time from the stale resolution.
    expect(voiceService.speakForced).toHaveBeenCalledTimes(2);
  });
});
