import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { buildPieceRenderer } from './pieceSetService';

vi.mock('./appAuditor', () => ({
  logAppAudit: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildPieceRenderer', () => {
  it('returns undefined for the default set with no filters', () => {
    expect(buildPieceRenderer('staunton')).toBeUndefined();
  });

  it('produces 12 piece renderers for a configured set', () => {
    const pieces = buildPieceRenderer('alpha');
    expect(pieces).toBeDefined();
    expect(Object.keys(pieces!)).toHaveLength(12);
  });

  it('logs an asset-load-error audit when a piece image fails to load', async () => {
    const auditor = await import('./appAuditor');
    const pieces = buildPieceRenderer('alpha');
    const RenderBishop = pieces!.bB;
    const { container } = render(<RenderBishop />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(auditor.logAppAudit).toHaveBeenCalled();
    const call = (auditor.logAppAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.kind).toBe('asset-load-error');
    expect(call.summary).toContain('bB');
    expect(call.summary).toContain('alpha');
  });
});
