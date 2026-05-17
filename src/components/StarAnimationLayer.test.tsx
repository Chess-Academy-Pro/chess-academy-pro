import { describe, it, expect, vi, beforeEach } from 'vitest';

const auditCalls: { kind: string; summary: string }[] = [];
vi.mock('../services/appAuditor', () => ({
  logAppAudit: vi.fn((entry: { kind: string; summary: string }) => {
    auditCalls.push({ kind: entry.kind, summary: entry.summary });
    return Promise.resolve();
  }),
}));

import { act, render, screen } from '../test/utils';
import { StarAnimationLayer } from './StarAnimationLayer';
import { useStarAnimationStore } from '../stores/starAnimationStore';

beforeEach(() => {
  auditCalls.length = 0;
  useStarAnimationStore.getState().__resetForTests();
});

describe('StarAnimationLayer', () => {
  it('renders no ghosts when there are no active animations', () => {
    render(<StarAnimationLayer />);
    expect(document.querySelector('[data-testid^="star-animation-ghost-"]')).toBeNull();
  });

  it('renders a ghost for each triggered animation and emits an audit', () => {
    render(<StarAnimationLayer />);
    act(() => {
      useStarAnimationStore.getState().trigger({
        sourceRect: { x: 100, y: 200, width: 24, height: 24 },
        openingName: 'Italian Game',
        openingColor: 'white',
      });
    });
    const ghost = document.querySelector('[data-testid^="star-animation-ghost-"]');
    expect(ghost).toBeTruthy();
    expect(ghost?.getAttribute('aria-label')).toBe('Favorited Italian Game');
    expect(auditCalls.some((c) => c.kind === 'star-animation-triggered')).toBe(true);
  });

  it('renders multiple ghosts when multiple animations are active', () => {
    render(<StarAnimationLayer />);
    act(() => {
      useStarAnimationStore.getState().trigger({
        sourceRect: { x: 0, y: 0, width: 24, height: 24 },
        openingName: 'A',
        openingColor: 'white',
      });
      useStarAnimationStore.getState().trigger({
        sourceRect: { x: 50, y: 50, width: 24, height: 24 },
        openingName: 'B',
        openingColor: 'black',
      });
    });
    expect(document.querySelectorAll('[data-testid^="star-animation-ghost-"]')).toHaveLength(2);
  });

  it('removes a ghost when its animation completes', () => {
    render(<StarAnimationLayer />);
    let id = '';
    act(() => {
      id = useStarAnimationStore.getState().trigger({
        sourceRect: { x: 0, y: 0, width: 24, height: 24 },
        openingName: 'A',
        openingColor: 'white',
      });
    });
    expect(document.querySelectorAll('[data-testid^="star-animation-ghost-"]')).toHaveLength(1);
    act(() => {
      useStarAnimationStore.getState().complete(id);
    });
    expect(document.querySelectorAll('[data-testid^="star-animation-ghost-"]')).toHaveLength(0);
  });

  it('falls back to a fade-on-source-rect when the Coach nav tab is missing from the DOM', () => {
    // The test render doesn't include AppLayout, so nav-coach-home-tab
    // is absent. The ghost should still render — the fallback animation
    // path keeps the visual feedback alive even without the slide target.
    render(<StarAnimationLayer />);
    act(() => {
      useStarAnimationStore.getState().trigger({
        sourceRect: { x: 100, y: 200, width: 24, height: 24 },
        openingName: 'Italian Game',
        openingColor: 'white',
      });
    });
    expect(screen.queryByLabelText('Favorited Italian Game')).toBeInTheDocument();
  });
});
