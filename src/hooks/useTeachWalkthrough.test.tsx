/**
 * Smoke tests for useTeachWalkthrough — verifies the state machine
 * transitions correctly on a small synthetic tree. Voice is mocked
 * (we can't await real Polly in unit tests) and resolves immediately
 * so transitions fire without timing flakiness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { WalkthroughTree } from '../types/walkthroughTree';

vi.mock('../services/voiceService', () => ({
  voiceService: {
    speakForced: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../services/appAuditor', () => ({
  logAppAudit: vi.fn(),
}));

import { useTeachWalkthrough } from './useTeachWalkthrough';

// Synthetic tree:
//   root → 1.e4 → 1...e5 → FORK { 2.Nc3 → leaf , 2.Nf3 → leaf }
const SMOKE_TREE: WalkthroughTree = {
  openingName: 'Smoke',
  eco: 'Z00',
  intro: 'intro line',
  outro: 'outro line',
  root: {
    san: null,
    movedBy: null,
    idea: '',
    children: [
      {
        node: {
          san: 'e4',
          movedBy: 'white',
          idea: 'one e4',
          children: [
            {
              node: {
                san: 'e5',
                movedBy: 'black',
                idea: 'one e5',
                children: [
                  {
                    label: '2.Nc3',
                    forkSubtitle: 'vienna',
                    node: { san: 'Nc3', movedBy: 'white', idea: 'two nc3', children: [] },
                  },
                  {
                    label: '2.Nf3',
                    forkSubtitle: 'italian/spanish',
                    node: { san: 'Nf3', movedBy: 'white', idea: 'two nf3', children: [] },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

describe('useTeachWalkthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useTeachWalkthrough());
    expect(result.current.phase).toBe('idle');
    expect(result.current.isActive).toBe(false);
  });

  it('advances through linear moves and pauses at the first fork', async () => {
    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => {
      result.current.start(SMOKE_TREE);
    });
    // Wait for: intro narration → root → e4 narration → e5 narration → fork.
    // Each narration calls speakForced which resolves immediately
    // (mocked), then a 400ms post-buffer fires.
    await waitFor(
      () => {
        expect(result.current.phase).toBe('fork');
      },
      { timeout: 5000 },
    );
    expect(result.current.forkOptions.length).toBe(2);
    expect(result.current.forkOptions[0].label).toBe('2.Nc3');
    expect(result.current.forkOptions[1].label).toBe('2.Nf3');
    // FEN should be the position after 1.e4 e5.
    expect(result.current.fen).toContain('rnbqkbnr/pppp1ppp/8/4p3/4P3/');
  });

  it('picking a fork advances down the chosen branch and lands on a leaf', async () => {
    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => {
      result.current.start(SMOKE_TREE);
    });
    await waitFor(() => expect(result.current.phase).toBe('fork'), { timeout: 5000 });
    act(() => {
      result.current.pickFork(0); // 2.Nc3 — Vienna
    });
    await waitFor(() => expect(result.current.phase).toBe('leaf'), { timeout: 5000 });
    expect(result.current.pathSans).toEqual(['e4', 'e5', 'Nc3']);
    expect(result.current.canBacktrack).toBe(true);
    expect(result.current.leafOutro).toBe('outro line');
  });

  it('backtrackToLastFork restores the fork phase and trims the path', async () => {
    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => result.current.start(SMOKE_TREE));
    await waitFor(() => expect(result.current.phase).toBe('fork'), { timeout: 5000 });
    act(() => result.current.pickFork(0));
    await waitFor(() => expect(result.current.phase).toBe('leaf'), { timeout: 5000 });
    act(() => result.current.backtrackToLastFork());
    expect(result.current.phase).toBe('fork');
    expect(result.current.pathSans).toEqual(['e4', 'e5']);
  });

  it('stop returns to idle and clears the tree', async () => {
    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => result.current.start(SMOKE_TREE));
    await waitFor(() => expect(result.current.isActive).toBe(true), { timeout: 5000 });
    act(() => result.current.stop());
    expect(result.current.phase).toBe('idle');
    expect(result.current.tree).toBeNull();
    expect(result.current.currentNode).toBeNull();
  });

  it('segmented narration sets arrows per segment as voice speaks each piece', async () => {
    // Validates the "real-time arrows in time with narration"
    // contract: each segment's arrows appear BEFORE that segment's
    // text starts speaking, replacing whatever was visible from the
    // previous segment, and clear when the node finishes.
    const { voiceService } = await import('../services/voiceService');
    const tree = {
      openingName: 'Arrow Smoke',
      eco: 'Z00',
      intro: '',
      outro: 'done',
      root: {
        san: null,
        movedBy: null,
        idea: '',
        children: [
          {
            node: {
              san: 'e4',
              movedBy: 'white' as const,
              idea: 'fallback prose',
              narration: [
                {
                  text: 'first beat',
                  arrows: [{ from: 'e2', to: 'e4', color: 'green' as const }],
                },
                {
                  text: 'second beat',
                  arrows: [{ from: 'd1', to: 'h5', color: 'blue' as const }],
                  highlights: [{ square: 'f7', color: 'red' as const }],
                },
              ],
              children: [],
            },
          },
        ],
      },
    } as const;

    // Resolve speakForced manually so we control segment-boundary timing.
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;
    let callIndex = 0;
    vi.mocked(voiceService.speakForced).mockImplementation(() => {
      if (callIndex === 0) {
        callIndex += 1;
        return new Promise((res) => {
          resolveFirst = res;
        });
      }
      callIndex += 1;
      return new Promise((res) => {
        resolveSecond = res;
      });
    });

    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => result.current.start(tree));

    // Segment 1's arrows land BEFORE its voice promise resolves.
    await waitFor(
      () => {
        expect(result.current.narrationArrows).toEqual([
          { from: 'e2', to: 'e4', color: 'green' },
        ]);
      },
      { timeout: 3000 },
    );
    expect(result.current.narrationHighlights).toEqual([]);

    // Resolve segment 1's voice; segment 2 starts and swaps arrows.
    act(() => {
      resolveFirst?.();
    });
    await waitFor(
      () => {
        expect(result.current.narrationArrows).toEqual([
          { from: 'd1', to: 'h5', color: 'blue' },
        ]);
        expect(result.current.narrationHighlights).toEqual([
          { square: 'f7', color: 'red' },
        ]);
      },
      { timeout: 3000 },
    );

    // Resolve segment 2; node completes; arrows clear; leaf reached.
    act(() => {
      resolveSecond?.();
    });
    await waitFor(
      () => {
        expect(result.current.narrationArrows).toEqual([]);
        expect(result.current.narrationHighlights).toEqual([]);
        expect(result.current.phase).toBe('leaf');
      },
      { timeout: 3000 },
    );
  });

  it('pause stops voice and freezes phase at "paused"; resume re-narrates', async () => {
    // Re-apply the speakForced promise implementation. The prior
    // 'segmented narration' test installed a custom mockImplementation
    // that returns a pending promise (vi.mocked(...).mockImplementation
    // on line 180). vi.clearAllMocks in beforeEach clears call history
    // but NOT custom implementations — so this test inherited that
    // pending-promise mock, the start()→narrate() chain never resolved,
    // and the waitFor for phase='fork' timed out at 5s.
    const { voiceService } = await import('../services/voiceService');
    vi.mocked(voiceService.speakForced).mockResolvedValue(undefined);

    const { result } = renderHook(() => useTeachWalkthrough());
    act(() => result.current.start(SMOKE_TREE));
    await waitFor(() => expect(result.current.phase).toBe('fork'), { timeout: 10000 });
    act(() => result.current.pickFork(1));
    // We may be in 'narrating' or already 'leaf' depending on timing —
    // pause from either state should land on 'paused'.
    act(() => result.current.pause());
    expect(result.current.phase).toBe('paused');
    act(() => result.current.resume());
    // After resume, we re-narrate; phase becomes 'narrating' then
    // either 'leaf' (since Nf3 has no children).
    await waitFor(
      () => expect(['narrating', 'leaf']).toContain(result.current.phase),
      { timeout: 10000 },
    );
  }, 15000);
});
