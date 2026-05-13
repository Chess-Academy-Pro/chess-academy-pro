import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./stockfishEngine', () => ({
  stockfishEngine: {
    analyzePosition: vi.fn(),
  },
}));

import { buildEndgameRecap } from './endgameRecapService';
import { stockfishEngine } from './stockfishEngine';
import type { StudentMoveRecord } from '../hooks/useEndgamePlayout';

// chess.js doesn't matter here — the service feeds the FENs straight
// to Stockfish, and the mock returns whatever eval we want.
const makeMove = (overrides: Partial<StudentMoveRecord> = {}): StudentMoveRecord => ({
  san: 'e4',
  fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  curated: true,
  ...overrides,
});

// Stub the StockfishAnalysis shape — only `evaluation` is read by the
// recap service.
const evalResult = (cp: number) => ({
  bestMove: 'e2e4',
  evaluation: cp,
  isMate: false,
  mateIn: null,
  depth: 12,
  topLines: [],
  nodesPerSecond: 0,
});

describe('buildEndgameRecap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for an empty move log', async () => {
    const r = await buildEndgameRecap([], 'white');
    expect(r).toBeNull();
  });

  it('classifies a clean conversion as best across the board', async () => {
    // Two student moves; eval steady at +200cp for white. Win-percent
    // drop is ~0 → all best.
    vi.mocked(stockfishEngine.analyzePosition).mockResolvedValue(evalResult(200));
    const r = await buildEndgameRecap([makeMove(), makeMove()], 'white');
    expect(r).not.toBeNull();
    expect(r!.counts.best).toBe(2);
    expect(r!.counts.blunder).toBe(0);
    expect(r!.worstMove).toBeNull();
    // Narration should be a clean-conversion stem.
    expect(r!.narration).toMatch(/Clean|Held|percent/);
  });

  it('flags a blunder when the win-percent drop exceeds the threshold', async () => {
    // One move: +400cp before, -400cp after = ~50% drop for white.
    vi.mocked(stockfishEngine.analyzePosition)
      .mockResolvedValueOnce(evalResult(400))
      .mockResolvedValueOnce(evalResult(-400));
    const r = await buildEndgameRecap([makeMove()], 'white');
    expect(r).not.toBeNull();
    expect(r!.counts.blunder).toBe(1);
    expect(r!.moves[0].classification).toBe('blunder');
    expect(r!.worstMove).not.toBeNull();
    expect(r!.narration).toMatch(/blunder/);
  });

  it('inverts win-percent for a black-side student', async () => {
    // Eval drops from -200 (good for black) to -50 (worse for black).
    // For a white-side student this is a tiny drop; for a black-side
    // student it's a bigger drop because black's perspective inverts.
    vi.mocked(stockfishEngine.analyzePosition)
      .mockResolvedValueOnce(evalResult(-200))
      .mockResolvedValueOnce(evalResult(-50));
    const r = await buildEndgameRecap([makeMove()], 'black');
    expect(r).not.toBeNull();
    // From black's POV the eval went from +200 (winning) to +50, a
    // measurable drop — should NOT be classified as best.
    expect(r!.moves[0].classification).not.toBe('best');
  });

  it('tolerates Stockfish errors per-move without crashing', async () => {
    vi.mocked(stockfishEngine.analyzePosition)
      .mockRejectedValueOnce(new Error('worker dead'))
      .mockResolvedValueOnce(evalResult(100));
    const r = await buildEndgameRecap([makeMove()], 'white');
    expect(r).not.toBeNull();
    // The failed analysis defaulted evalBefore to 0; with evalAfter=100,
    // the move shows a slight win-percent gain from white's POV, so
    // accuracy is high and the move is classified best.
    expect(r!.moves[0].evalBefore).toBe(0);
    expect(r!.moves[0].evalAfter).toBe(100);
  });

  it('keeps recap output bounded — never NaN / Infinity / negative accuracy', async () => {
    vi.mocked(stockfishEngine.analyzePosition).mockResolvedValue(evalResult(0));
    const r = await buildEndgameRecap([makeMove(), makeMove(), makeMove()], 'white');
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!.accuracy)).toBe(true);
    expect(r!.accuracy).toBeGreaterThanOrEqual(0);
    expect(r!.accuracy).toBeLessThanOrEqual(100);
    for (const m of r!.moves) {
      expect(Number.isFinite(m.accuracy)).toBe(true);
      expect(m.accuracy).toBeGreaterThanOrEqual(0);
      expect(m.accuracy).toBeLessThanOrEqual(100);
    }
  });
});
