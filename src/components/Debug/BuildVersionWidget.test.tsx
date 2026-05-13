import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test/utils';
import { BuildVersionWidget } from './BuildVersionWidget';

describe('BuildVersionWidget', () => {
  it('renders the truncated build id', () => {
    render(<BuildVersionWidget />);
    const widget = screen.getByTestId('build-version-widget');
    expect(widget).toBeInTheDocument();
    // Text should be at most 7 chars + optional " • refresh" suffix
    // when SW update is pending.
    expect(widget.textContent ?? '').toMatch(/^[a-z0-9]+( • refresh)?$|^copied$/i);
  });

  it('has an aria-label for screen readers', () => {
    render(<BuildVersionWidget />);
    expect(screen.getByLabelText(/Build version/i)).toBeInTheDocument();
  });
});
