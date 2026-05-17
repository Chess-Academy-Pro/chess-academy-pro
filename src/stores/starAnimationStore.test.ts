import { describe, it, expect, beforeEach } from 'vitest';
import { useStarAnimationStore } from './starAnimationStore';

beforeEach(() => {
  useStarAnimationStore.getState().__resetForTests();
});

describe('starAnimationStore.trigger', () => {
  it('appends a new active entry with a stable id and returns it', () => {
    const id = useStarAnimationStore.getState().trigger({
      sourceRect: { x: 100, y: 200, width: 24, height: 24 },
      openingName: 'Italian Game',
      openingColor: 'white',
    });
    expect(id).toMatch(/^star-anim-/);
    const active = useStarAnimationStore.getState().active;
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id);
    expect(active[0].openingName).toBe('Italian Game');
    expect(active[0].openingColor).toBe('white');
    expect(active[0].startedAt).toBeGreaterThan(0);
  });

  it('supports multiple simultaneous animations (rapid favoriting)', () => {
    const a = useStarAnimationStore.getState().trigger({
      sourceRect: { x: 0, y: 0, width: 24, height: 24 },
      openingName: 'A',
      openingColor: 'white',
    });
    const b = useStarAnimationStore.getState().trigger({
      sourceRect: { x: 50, y: 50, width: 24, height: 24 },
      openingName: 'B',
      openingColor: 'black',
    });
    expect(a).not.toBe(b);
    expect(useStarAnimationStore.getState().active).toHaveLength(2);
  });
});

describe('starAnimationStore.complete', () => {
  it('removes the entry with the matching id', () => {
    const s = useStarAnimationStore.getState();
    const a = s.trigger({
      sourceRect: { x: 0, y: 0, width: 24, height: 24 },
      openingName: 'A',
      openingColor: 'white',
    });
    const b = s.trigger({
      sourceRect: { x: 0, y: 0, width: 24, height: 24 },
      openingName: 'B',
      openingColor: 'black',
    });
    s.complete(a);
    const remaining = useStarAnimationStore.getState().active;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b);
  });

  it('is a no-op for an unknown id (animation already cleaned up)', () => {
    const s = useStarAnimationStore.getState();
    s.trigger({
      sourceRect: { x: 0, y: 0, width: 24, height: 24 },
      openingName: 'A',
      openingColor: 'white',
    });
    s.complete('not-an-id');
    expect(useStarAnimationStore.getState().active).toHaveLength(1);
  });
});
