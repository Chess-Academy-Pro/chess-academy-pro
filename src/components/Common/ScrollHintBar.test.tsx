import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { ScrollHintBar } from './ScrollHintBar';

vi.mock('../../services/appAuditor', () => ({
  logAppAudit: vi.fn(() => Promise.resolve()),
}));

function TestHost({ overflow }: { overflow: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div
        ref={ref}
        style={{ width: 100, overflowX: 'auto' }}
        data-testid="scroll-host"
      >
        <div style={{ width: overflow ? 500 : 50 }} />
      </div>
      <ScrollHintBar targetRef={ref} axis="x" />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ScrollHintBar', () => {
  it('renders the gold track even when the target does not overflow', () => {
    render(<TestHost overflow={false} />);
    const bar = screen.getByTestId('scroll-hint-x');
    expect(bar).toBeInTheDocument();
  });

  it('emits a scroll-hint-state audit on mount', async () => {
    const auditor = await import('../../services/appAuditor');
    render(<TestHost overflow={false} />);
    expect(auditor.logAppAudit).toHaveBeenCalled();
    const last = (auditor.logAppAudit as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(last?.kind).toBe('scroll-hint-state');
  });

  it('exposes its comet state via data-comet attribute', () => {
    render(<TestHost overflow={false} />);
    const bar = screen.getByTestId('scroll-hint-x');
    expect(bar.getAttribute('data-comet')).toBe('false');
  });
});
