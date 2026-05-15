import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../test/utils';
import { ConsistentChessboard } from './ConsistentChessboard';
import type { ChessboardOptions } from 'react-chessboard';

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options = {} }: { options?: ChessboardOptions }): JSX.Element => (
    <div
      data-testid="mock-chessboard"
      data-position={typeof options.position === 'string' ? options.position : JSON.stringify(options.position ?? '')}
      data-orientation={options.boardOrientation ?? 'white'}
      data-draggable={String(options.allowDragging ?? true)}
      data-anim={String(options.animationDurationInMs ?? '')}
      data-arrows={JSON.stringify(options.arrows ?? [])}
      data-square-styles={JSON.stringify(options.squareStyles ?? {})}
    />
  ),
}));

const playMoveSoundMock = vi.fn();
vi.mock('../../hooks/usePieceSound', () => ({
  usePieceSound: () => ({
    playMoveSound: playMoveSoundMock,
    playCelebration: vi.fn(),
    playEncouragement: vi.fn(),
    playErrorPing: vi.fn(),
    playSuccessChime: vi.fn(),
  }),
}));

describe('ConsistentChessboard (static mode)', () => {
  const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const IN_CHECK = '4k3/4R3/8/8/8/8/8/4K3 b - - 1 1';

  beforeEach(() => {
    playMoveSoundMock.mockClear();
  });

  it('renders the position FEN', () => {
    render(<ConsistentChessboard fen={FEN} />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-position')).toBe(FEN);
  });

  it('defaults to non-interactive (no dragging)', () => {
    render(<ConsistentChessboard fen={FEN} />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-draggable')).toBe('false');
  });

  it('allows dragging when interactive=true', () => {
    render(<ConsistentChessboard fen={FEN} interactive />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-draggable')).toBe('true');
  });

  it('applies arrows when provided', () => {
    const arrows = [{ startSquare: 'e2', endSquare: 'e4', color: 'green' }];
    render(<ConsistentChessboard fen={FEN} arrows={arrows} />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-arrows')).toBe(JSON.stringify(arrows));
  });

  it('uses the standard 200ms animation by default', () => {
    render(<ConsistentChessboard fen={FEN} />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-anim')).toBe('200');
  });

  it('honors a custom animation duration when given', () => {
    render(<ConsistentChessboard fen={FEN} animationDurationInMs={400} />);
    const board = screen.getByTestId('mock-chessboard');
    expect(board.getAttribute('data-anim')).toBe('400');
  });

  it('renders the overlay node above the board', () => {
    render(
      <ConsistentChessboard
        fen={FEN}
        overlay={<div data-testid="my-overlay">flash</div>}
      />,
    );
    expect(screen.getByTestId('my-overlay')).toBeInTheDocument();
  });

  it('renders inside a static-mode wrapper div', () => {
    render(<ConsistentChessboard fen={FEN} />);
    expect(screen.getByTestId('consistent-chessboard-static')).toBeInTheDocument();
  });

  it('plays move sound when FEN changes via detected move', () => {
    const { rerender } = render(<ConsistentChessboard fen={FEN} />);
    expect(playMoveSoundMock).not.toHaveBeenCalled();
    rerender(<ConsistentChessboard fen={AFTER_E4} />);
    expect(playMoveSoundMock).toHaveBeenCalledTimes(1);
    expect(playMoveSoundMock.mock.calls[0][0]).toBe('e4');
  });

  it('does NOT play sound when enableMoveSound is false', () => {
    const { rerender } = render(
      <ConsistentChessboard fen={FEN} enableMoveSound={false} />,
    );
    rerender(<ConsistentChessboard fen={AFTER_E4} enableMoveSound={false} />);
    expect(playMoveSoundMock).not.toHaveBeenCalled();
  });

  it('does NOT play sound on initial mount (no prior FEN)', () => {
    render(<ConsistentChessboard fen={FEN} />);
    expect(playMoveSoundMock).not.toHaveBeenCalled();
  });

  it('does NOT play sound on a position reset (many pieces changed)', () => {
    const { rerender } = render(<ConsistentChessboard fen={FEN} />);
    const other = '8/8/8/4k3/8/8/8/4K3 w - - 0 1';
    rerender(<ConsistentChessboard fen={other} />);
    expect(playMoveSoundMock).not.toHaveBeenCalled();
  });

  it('applies last-move cyan highlight on detected from/to squares', () => {
    const { rerender } = render(<ConsistentChessboard fen={FEN} />);
    rerender(<ConsistentChessboard fen={AFTER_E4} />);
    const styles = JSON.parse(
      screen.getByTestId('mock-chessboard').getAttribute('data-square-styles') ?? '{}',
    );
    expect(styles.e2).toBeDefined();
    expect(styles.e4).toBeDefined();
    expect(styles.e4.background).toContain('rgba(0, 229, 255');
  });

  it('omits last-move highlight when showLastMoveHighlight is false', () => {
    const { rerender } = render(
      <ConsistentChessboard fen={FEN} showLastMoveHighlight={false} />,
    );
    rerender(
      <ConsistentChessboard fen={AFTER_E4} showLastMoveHighlight={false} />,
    );
    const styles = JSON.parse(
      screen.getByTestId('mock-chessboard').getAttribute('data-square-styles') ?? '{}',
    );
    expect(styles.e4?.background ?? '').not.toContain('rgba(0, 229, 255');
  });

  it('applies red check-square highlight when side to move is in check', () => {
    render(<ConsistentChessboard fen={IN_CHECK} />);
    const styles = JSON.parse(
      screen.getByTestId('mock-chessboard').getAttribute('data-square-styles') ?? '{}',
    );
    expect(styles.e8?.background ?? '').toContain('rgba(255,48,48');
  });

  it('omits check highlight when showCheckHighlight is false', () => {
    render(<ConsistentChessboard fen={IN_CHECK} showCheckHighlight={false} />);
    const styles = JSON.parse(
      screen.getByTestId('mock-chessboard').getAttribute('data-square-styles') ?? '{}',
    );
    expect(styles.e8?.background ?? '').not.toContain('rgba(255,48,48');
  });

  it('preserves caller squareStyles on top of derived chrome', () => {
    const { rerender } = render(<ConsistentChessboard fen={FEN} />);
    const callerStyles = { e4: { background: 'rgba(251, 191, 36, 0.55)' } };
    rerender(
      <ConsistentChessboard fen={AFTER_E4} squareStyles={callerStyles} />,
    );
    const styles = JSON.parse(
      screen.getByTestId('mock-chessboard').getAttribute('data-square-styles') ?? '{}',
    );
    expect(styles.e4.background).toBe('rgba(251, 191, 36, 0.55)');
  });
});
