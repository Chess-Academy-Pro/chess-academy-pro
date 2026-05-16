import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MotionConfig } from 'framer-motion';
import { GhostPieceOverlay, getPieceImageUrl } from './GhostPieceOverlay';
import type { GhostMoveData } from '../../types';

// Stub ResizeObserver for jsdom
const resizeCallback = vi.fn();
vi.stubGlobal(
  'ResizeObserver',
  class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      resizeCallback.mockImplementation(this.cb);
    }
    observe(): void {
      // Fire immediately with a mock entry
      this.cb(
        [{ contentRect: { width: 400, height: 400 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  },
);

function renderOverlay(ghostMove: GhostMoveData, orientation: 'white' | 'black' = 'white', pieceSet = 'staunton'): ReturnType<typeof render> {
  return render(
    <MotionConfig transition={{ duration: 0 }}>
      <div style={{ width: 400, height: 400, position: 'relative' }}>
        <GhostPieceOverlay
          ghostMove={ghostMove}
          boardOrientation={orientation}
          pieceSet={pieceSet}
        />
      </div>
    </MotionConfig>,
  );
}

describe('GhostPieceOverlay', () => {
  const sampleGhost: GhostMoveData = {
    fromSquare: 'e2',
    toSquare: 'e4',
    piece: 'wP',
    capturedSquare: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the overlay container', () => {
    renderOverlay(sampleGhost);
    expect(screen.getByTestId('ghost-piece-overlay')).toBeDefined();
  });

  it('renders origin and destination elements', () => {
    renderOverlay(sampleGhost);
    expect(screen.getByTestId('ghost-origin')).toBeDefined();
    expect(screen.getByTestId('ghost-destination')).toBeDefined();
  });

  it('has pointer-events-none on the container', () => {
    renderOverlay(sampleGhost);
    const overlay = screen.getByTestId('ghost-piece-overlay');
    expect(overlay.className).toContain('pointer-events-none');
  });

  it('renders piece images with correct src', () => {
    renderOverlay(sampleGhost);
    const images = screen.getByTestId('ghost-piece-overlay').querySelectorAll('img');
    expect(images).toHaveLength(2);
    // Both images should point to the same piece
    const expectedUrl = getPieceImageUrl('wP', 'staunton');
    expect(images[0].src).toContain(expectedUrl);
    expect(images[1].src).toContain(expectedUrl);
  });

  it('origin has low opacity style', () => {
    renderOverlay(sampleGhost);
    const origin = screen.getByTestId('ghost-origin');
    expect(origin.style.opacity).toBe('0.25');
  });

  it('renders correctly with black orientation', () => {
    renderOverlay(sampleGhost, 'black');
    // Should still render both elements
    expect(screen.getByTestId('ghost-origin')).toBeDefined();
    expect(screen.getByTestId('ghost-destination')).toBeDefined();
  });

  it('renders correctly with a capture move', () => {
    const captureGhost: GhostMoveData = {
      fromSquare: 'd4',
      toSquare: 'e5',
      piece: 'wN',
      capturedSquare: 'e5',
    };
    renderOverlay(captureGhost);
    expect(screen.getByTestId('ghost-origin')).toBeDefined();
    expect(screen.getByTestId('ghost-destination')).toBeDefined();
  });
});

describe('getPieceImageUrl', () => {
  it('returns lichess CDN URL for non-default piece set', () => {
    const url = getPieceImageUrl('wN', 'neo');
    expect(url).toBe('https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/companion/wN.svg');
  });

  it('returns lichess CDN URL for alpha set', () => {
    const url = getPieceImageUrl('bQ', 'alpha');
    expect(url).toBe('https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/alpha/bQ.svg');
  });

  it('returns fallback URL for default staunton set', () => {
    const url = getPieceImageUrl('wK', 'staunton');
    expect(url).toContain('wK');
  });

  it('returns fallback URL for unknown piece set', () => {
    const url = getPieceImageUrl('wP', 'nonexistent');
    expect(url).toContain('wP');
  });
});
