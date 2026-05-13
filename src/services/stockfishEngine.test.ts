import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stockfishCache } from './stockfishCache';
import type { StockfishAnalysis } from '../types';

// ---------------------------------------------------------------------------
// Mock Worker infrastructure
// ---------------------------------------------------------------------------

type MessageListener = (event: MessageEvent) => void;

interface MockWorkerHandle {
  instance: Worker;
  emit: (data: string) => void;
  emitError: (message: string) => void;
  postMessageCalls: string[];
}

/**
 * Creates a mock Worker that simulates UCI protocol responses.
 * Supports both onmessage and addEventListener patterns.
 */
function createMockWorker(): MockWorkerHandle {
  const messageListeners: MessageListener[] = [];
  const postMessageCalls: string[] = [];

  const worker = {
    postMessage: vi.fn((msg: string) => {
      postMessageCalls.push(msg);
    }),
    terminate: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') {
        messageListeners.push(listener as MessageListener);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') {
        const idx = messageListeners.indexOf(listener as MessageListener);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }
    }),
    dispatchEvent: vi.fn(() => true),
  } as unknown as Worker;

  function emit(data: string): void {
    const event = { data } as MessageEvent<string>;
    if (worker.onmessage) {
      worker.onmessage(event);
    }
    for (const listener of [...messageListeners]) {
      listener(event);
    }
  }

  function emitError(message: string): void {
    const event = { message } as ErrorEvent;
    if (worker.onerror) {
      worker.onerror(event);
    }
  }

  return { instance: worker, emit, emitError, postMessageCalls };
}

// ---------------------------------------------------------------------------
// Shared mock state — set in beforeEach, used by the Worker class stub
// ---------------------------------------------------------------------------

let mockWorker: MockWorkerHandle;
let workerConstructorCallCount: number;

// Stub the global Worker as a class that can be called with `new`
beforeEach(() => {
  mockWorker = createMockWorker();
  workerConstructorCallCount = 0;
  // The engine populates a module-level FEN cache on bestmove. Clear
  // it between tests so a previous test's analysis result doesn't
  // short-circuit the worker dispatch under test.
  stockfishCache.clear();

  // Use a class so `new Worker(...)` works properly
  vi.stubGlobal(
    'Worker',
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class MockWorkerClass {
      constructor() {
        workerConstructorCallCount++;
        // Return the shared mock instance instead of `this`
        return mockWorker.instance as unknown as MockWorkerClass;
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper: get a fresh engine singleton per test
// ---------------------------------------------------------------------------

async function getEngine(): Promise<{
  stockfishEngine: (typeof import('./stockfishEngine'))['stockfishEngine'];
}> {
  vi.resetModules();
  const mod = await import('./stockfishEngine');
  return { stockfishEngine: mod.stockfishEngine };
}

// ---------------------------------------------------------------------------
// Helper: complete init handshake
// ---------------------------------------------------------------------------

function completeInit(): void {
  queueMicrotask(() => {
    // New init protocol: engine waits for `uciok` before sending
    // setoptions + `isready`. Drive both events from the mock.
    mockWorker.emit('uciok');
    queueMicrotask(() => {
      mockWorker.emit('readyok');
    });
  });
}

async function initEngine(engine: {
  initialize: () => Promise<void>;
}): Promise<void> {
  completeInit();
  await engine.initialize();
}

// ---------------------------------------------------------------------------
// Helper: emit canned analysis data
// ---------------------------------------------------------------------------

function emitAnalysisResponse(options?: {
  mateScore?: { value: number; multipv?: number };
  lines?: Array<{ multipv: number; cp: number; pv: string }>;
  bestmove?: string;
}): void {
  const bestmove = options?.bestmove ?? 'e2e4 ponder e7e5';

  if (options?.mateScore) {
    const mv = options.mateScore.multipv ?? 1;
    mockWorker.emit(
      `info depth 15 multipv ${mv} score mate ${options.mateScore.value} pv e2e4 e7e5 d1h5`,
    );
  }

  if (options?.lines) {
    for (const line of options.lines) {
      mockWorker.emit(
        `info depth 18 multipv ${line.multipv} score cp ${line.cp} pv ${line.pv}`,
      );
    }
  } else if (!options?.mateScore) {
    mockWorker.emit(
      'info depth 18 multipv 1 score cp 30 pv e2e4 e7e5 g1f3 b8c6',
    );
    mockWorker.emit(
      'info depth 18 multipv 2 score cp 20 pv d2d4 d7d5 c2c4',
    );
    mockWorker.emit(
      'info depth 18 multipv 3 score cp 10 pv c2c4 e7e5 b1c3',
    );
  }

  mockWorker.emit(`bestmove ${bestmove}`);
}

/**
 * Hooks into postMessage so that:
 *  - "isready" triggers a deferred "readyok"
 *  - "go ..." triggers deferred analysis info lines + bestmove
 */
function scheduleAnalysisResponse(
  options?: Parameters<typeof emitAnalysisResponse>[0],
): void {
  const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
  pmMock.mockImplementation((msg: string) => {
    mockWorker.postMessageCalls.push(msg);
    if (msg === 'isready') {
      queueMicrotask(() => mockWorker.emit('readyok'));
    }
    if (msg.startsWith('go ')) {
      queueMicrotask(() => emitAnalysisResponse(options));
    }
  });
}

// =========================================================================
// Tests
// =========================================================================

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('StockfishEngine', () => {
  // -----------------------------------------------------------------------
  // initialize
  // -----------------------------------------------------------------------
  describe('initialize', () => {
    it('sends uci and isready commands', async () => {
      const { stockfishEngine } = await getEngine();
      completeInit();
      await stockfishEngine.initialize();

      expect(mockWorker.postMessageCalls).toContain('uci');
      expect(mockWorker.postMessageCalls).toContain('isready');
    });

    it('resolves after readyok is received', async () => {
      const { stockfishEngine } = await getEngine();
      let resolved = false;

      const promise = stockfishEngine.initialize().then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      // New init protocol: emit uciok first so the engine sends
      // setoptions + isready, then emit readyok.
      mockWorker.emit('uciok');
      mockWorker.emit('readyok');
      await promise;

      expect(resolved).toBe(true);
    });

    it('sets MultiPV option to 3 after readyok', async () => {
      const { stockfishEngine } = await getEngine();
      completeInit();
      await stockfishEngine.initialize();

      expect(mockWorker.postMessageCalls).toContain(
        'setoption name MultiPV value 3',
      );
    });

    it('is idempotent — second call returns same promise without creating another worker', async () => {
      const { stockfishEngine } = await getEngine();
      completeInit();

      const p1 = stockfishEngine.initialize();
      const p2 = stockfishEngine.initialize();
      await p1;
      await p2;

      // Only one Worker was created
      expect(workerConstructorCallCount).toBe(1);
    });

    it('creates a Worker instance', async () => {
      const { stockfishEngine } = await getEngine();
      completeInit();
      await stockfishEngine.initialize();

      expect(workerConstructorCallCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // analyzePosition
  // -----------------------------------------------------------------------
  describe('analyzePosition', () => {
    it('sends correct UCI position command', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN, 20);

      expect(mockWorker.postMessageCalls).toContain(
        `position fen ${STARTING_FEN}`,
      );
    });

    it('sends go depth command with specified depth', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN, 20);

      expect(mockWorker.postMessageCalls).toContain('go depth 20');
    });

    it('uses default depth 18 when not specified', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(mockWorker.postMessageCalls).toContain('go depth 18');
    });

    it('parses multipv info lines into topLines array', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        lines: [
          { multipv: 1, cp: 30, pv: 'e2e4 e7e5 g1f3' },
          { multipv: 2, cp: 20, pv: 'd2d4 d7d5' },
          { multipv: 3, cp: 10, pv: 'c2c4 e7e5' },
        ],
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.topLines).toHaveLength(3);
      expect(analysis.topLines[0].evaluation).toBe(30);
      expect(analysis.topLines[1].evaluation).toBe(20);
      expect(analysis.topLines[2].evaluation).toBe(10);
    });

    it('lines are sorted by multipv rank', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        lines: [
          { multipv: 3, cp: 10, pv: 'c2c4 e7e5' },
          { multipv: 1, cp: 30, pv: 'e2e4 e7e5' },
          { multipv: 2, cp: 20, pv: 'd2d4 d7d5' },
        ],
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.topLines[0].rank).toBe(1);
      expect(analysis.topLines[1].rank).toBe(2);
      expect(analysis.topLines[2].rank).toBe(3);
    });

    it('extracts bestMove from bestmove response', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({ bestmove: 'g1f3 ponder d7d5' });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.bestMove).toBe('g1f3');
    });

    it('parses moves array from pv string', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        lines: [
          { multipv: 1, cp: 30, pv: 'e2e4 e7e5 g1f3 b8c6 f1b5' },
        ],
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.topLines[0].moves).toEqual([
        'e2e4',
        'e7e5',
        'g1f3',
        'b8c6',
        'f1b5',
      ]);
    });

    it('sets evaluation from the primary line', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        lines: [{ multipv: 1, cp: 55, pv: 'e2e4 e7e5' }],
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.evaluation).toBe(55);
    });

    it('sets depth from the info lines', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.depth).toBe(18);
    });

    it('sets nodesPerSecond to 0', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.nodesPerSecond).toBe(0);
    });

    it('sends ucinewgame before analysis', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN);

      const ucinewgameIdx =
        mockWorker.postMessageCalls.indexOf('ucinewgame');
      const positionIdx = mockWorker.postMessageCalls.indexOf(
        `position fen ${STARTING_FEN}`,
      );

      expect(ucinewgameIdx).toBeGreaterThanOrEqual(0);
      expect(positionIdx).toBeGreaterThan(ucinewgameIdx);
    });
  });

  // -----------------------------------------------------------------------
  // Mate score handling
  // -----------------------------------------------------------------------
  describe('mate score handling', () => {
    it('sets isMate to true for mate scores', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        mateScore: { value: 3, multipv: 1 },
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.isMate).toBe(true);
    });

    it('sets mateIn to the mate distance', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        mateScore: { value: 3, multipv: 1 },
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.mateIn).toBe(3);
    });

    it('sets negative mateIn for getting mated', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        mateScore: { value: -2, multipv: 1 },
        bestmove: 'e1d1',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.isMate).toBe(true);
      expect(analysis.mateIn).toBe(-2);
    });

    it('sets evaluation to 30000 for positive mate score', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        mateScore: { value: 5, multipv: 1 },
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.evaluation).toBe(30000);
    });

    it('sets evaluation to -30000 for negative mate score', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        mateScore: { value: -3, multipv: 1 },
        bestmove: 'e1d1',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.evaluation).toBe(-30000);
    });

    it('sets isMate to false for centipawn scores', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({
        lines: [{ multipv: 1, cp: 30, pv: 'e2e4 e7e5' }],
        bestmove: 'e2e4',
      });

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis.isMate).toBe(false);
      expect(analysis.mateIn).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getBestMove
  // -----------------------------------------------------------------------
  describe('getBestMove', () => {
    it('sends go movetime command', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg.startsWith('go movetime')) {
          queueMicrotask(() =>
            mockWorker.emit('bestmove d2d4 ponder d7d5'),
          );
        }
      });

      await stockfishEngine.getBestMove(STARTING_FEN, 2000);

      expect(mockWorker.postMessageCalls).toContain('go movetime 2000');
    });

    it('returns best move string', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg.startsWith('go movetime')) {
          queueMicrotask(() =>
            mockWorker.emit('bestmove g1f3 ponder d7d5'),
          );
        }
      });

      const move = await stockfishEngine.getBestMove(STARTING_FEN);

      expect(move).toBe('g1f3');
    });

    it('uses default moveTime of 1000ms', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg.startsWith('go movetime')) {
          queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
        }
      });

      await stockfishEngine.getBestMove(STARTING_FEN);

      expect(mockWorker.postMessageCalls).toContain('go movetime 1000');
    });

    it('sends position fen command before go', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg.startsWith('go movetime')) {
          queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
        }
      });

      const fen =
        'rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2';
      await stockfishEngine.getBestMove(fen);

      expect(mockWorker.postMessageCalls).toContain(`position fen ${fen}`);

      const posIdx = mockWorker.postMessageCalls.indexOf(
        `position fen ${fen}`,
      );
      const goIdx = mockWorker.postMessageCalls.indexOf('go movetime 1000');
      expect(posIdx).toBeLessThan(goIdx);
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------
  describe('stop', () => {
    it('sends stop command to worker', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      stockfishEngine.stop();

      expect(mockWorker.postMessageCalls).toContain('stop');
    });

    it('does nothing if engine not initialized', async () => {
      const { stockfishEngine } = await getEngine();

      stockfishEngine.stop();

      expect(mockWorker.instance.postMessage).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------
  describe('destroy', () => {
    it('terminates the worker', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      stockfishEngine.destroy();

      expect(mockWorker.instance.terminate).toHaveBeenCalled();
    });

    it('resets internal state so isReady is false', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      stockfishEngine.destroy();

      // After destroy, stop() should not send commands (worker is null)
      const callsBefore = mockWorker.postMessageCalls.length;
      stockfishEngine.stop();
      expect(mockWorker.postMessageCalls.length).toBe(callsBefore);
    });

    it('allows re-initialization after destroy', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      stockfishEngine.destroy();

      // Create a new mock worker for re-init
      const newMockWorker = createMockWorker();
      vi.stubGlobal(
        'Worker',
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        class ReInitMockWorker {
          constructor() {
            workerConstructorCallCount++;
            return newMockWorker.instance as unknown as ReInitMockWorker;
          }
        },
      );

      const initPromise = stockfishEngine.initialize();
      queueMicrotask(() => {
        newMockWorker.emit('uciok');
        queueMicrotask(() => newMockWorker.emit('readyok'));
      });
      await initPromise;

      expect(workerConstructorCallCount).toBe(2);
      expect(newMockWorker.postMessageCalls).toContain('uci');
      expect(newMockWorker.postMessageCalls).toContain('isready');
    });

    it('sends stop before terminate', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      stockfishEngine.destroy();

      expect(mockWorker.postMessageCalls).toContain('stop');
      expect(mockWorker.instance.terminate).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent analysis
  // -----------------------------------------------------------------------
  describe('concurrent analysis', () => {
    it('sends stop when a brain analyzePosition interrupts an in-flight prefetch', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      // First (prefetch) analysis: respond to isready but let "go" hang
      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
      });

      const firstAnalysis = stockfishEngine.analyzePosition(
        STARTING_FEN,
        12,
        undefined,
        'prefetch',
      );

      // Let microtasks settle so first analysis is fully set up
      await new Promise((r) => setTimeout(r, 10));

      // Second (brain) analysis: respond to everything
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
        if (msg.startsWith('go depth')) {
          queueMicrotask(() => emitAnalysisResponse({ bestmove: 'd2d4' }));
        }
      });

      const secondFen =
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
      const secondAnalysis = stockfishEngine.analyzePosition(secondFen);

      await expect(firstAnalysis).rejects.toThrow(
        'Analysis interrupted by new request',
      );

      const result = await secondAnalysis;
      expect(result.bestMove).toBe('d2d4');
      expect(mockWorker.postMessageCalls).toContain('stop');
    });

    it('rejects the previous pending prefetch when a brain call arrives', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const pmMock = mockWorker.instance.postMessage as ReturnType<
        typeof vi.fn
      >;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
      });

      const first = stockfishEngine.analyzePosition(
        STARTING_FEN,
        12,
        undefined,
        'prefetch',
      );

      await new Promise((r) => setTimeout(r, 10));

      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
        if (msg.startsWith('go depth')) {
          queueMicrotask(() => emitAnalysisResponse());
        }
      });

      const second = stockfishEngine.analyzePosition(STARTING_FEN);

      await expect(first).rejects.toThrow('interrupted');
      const result = await second;
      expect(result.bestMove).toBe('e2e4');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('worker error event rejects the init promise', async () => {
      const { stockfishEngine } = await getEngine();

      const initPromise = stockfishEngine.initialize();

      mockWorker.emitError('WASM load failed');

      await expect(initPromise).rejects.toThrow('WASM load failed');
    });
  });

  // -----------------------------------------------------------------------
  // onAnalysis handler
  // -----------------------------------------------------------------------
  describe('onAnalysis', () => {
    it('notifies registered handlers when analysis completes', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const handler = vi.fn();
      stockfishEngine.onAnalysis(handler);

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ bestMove: 'e2e4' }),
      );
    });

    it('returns an unsubscribe function', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const handler = vi.fn();
      const unsubscribe = stockfishEngine.onAnalysis(handler);

      unsubscribe();

      scheduleAnalysisResponse();
      await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Analysis result shape
  // -----------------------------------------------------------------------
  describe('analysis result shape', () => {
    it('conforms to StockfishAnalysis interface', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();

      const analysis: StockfishAnalysis =
        await stockfishEngine.analyzePosition(STARTING_FEN);

      expect(analysis).toHaveProperty('bestMove');
      expect(analysis).toHaveProperty('evaluation');
      expect(analysis).toHaveProperty('isMate');
      expect(analysis).toHaveProperty('mateIn');
      expect(analysis).toHaveProperty('depth');
      expect(analysis).toHaveProperty('topLines');
      expect(analysis).toHaveProperty('nodesPerSecond');
      expect(typeof analysis.bestMove).toBe('string');
      expect(typeof analysis.evaluation).toBe('number');
      expect(typeof analysis.isMate).toBe('boolean');
      expect(typeof analysis.depth).toBe('number');
      expect(Array.isArray(analysis.topLines)).toBe(true);
    });

    it('AnalysisLine has correct shape', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse();

      const analysis = await stockfishEngine.analyzePosition(STARTING_FEN);
      const line = analysis.topLines[0];

      expect(line).toHaveProperty('rank');
      expect(line).toHaveProperty('evaluation');
      expect(line).toHaveProperty('moves');
      expect(line).toHaveProperty('mate');
      expect(typeof line.rank).toBe('number');
      expect(typeof line.evaluation).toBe('number');
      expect(Array.isArray(line.moves)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // queueAnalysis
  // -----------------------------------------------------------------------
  describe('queueAnalysis', () => {
    it('resolves with analysis result', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      scheduleAnalysisResponse({ bestmove: 'e2e4' });

      const result = await stockfishEngine.queueAnalysis(STARTING_FEN, 18);
      expect(result.bestMove).toBe('e2e4');
    });

    it('serializes two requests — second waits for first', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      const order: string[] = [];

      const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
        if (msg.startsWith('go depth')) {
          queueMicrotask(() => {
            order.push('analysis');
            emitAnalysisResponse({ bestmove: 'e2e4' });
          });
        }
      });

      // Distinct FENs so the LRU cache can't short-circuit the second
      // analysis — we're testing serialization through the worker, not
      // cache hits. Same FEN at the same depth would be a cache hit on
      // the second request after the first populates the cache.
      const FEN_A = STARTING_FEN;
      const FEN_B =
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
      const p1 = stockfishEngine.queueAnalysis(FEN_A).then((r) => {
        order.push('p1-resolved');
        return r;
      });
      const p2 = stockfishEngine.queueAnalysis(FEN_B).then((r) => {
        order.push('p2-resolved');
        return r;
      });

      await Promise.all([p1, p2]);

      // Both should resolve, p1 before p2
      expect(order).toEqual(['analysis', 'p1-resolved', 'analysis', 'p2-resolved']);
    });

    it('rejects all queued entries on destroy', async () => {
      const { stockfishEngine } = await getEngine();
      await initEngine(stockfishEngine);

      // Block the engine so queue builds up
      const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
      pmMock.mockImplementation((msg: string) => {
        mockWorker.postMessageCalls.push(msg);
        if (msg === 'isready') {
          queueMicrotask(() => mockWorker.emit('readyok'));
        }
        // Don't respond to "go" — hang intentionally
      });

      const p1 = stockfishEngine.queueAnalysis(STARTING_FEN);
      const p2 = stockfishEngine.queueAnalysis(STARTING_FEN);

      // Give the first analysis time to start running
      await new Promise((r) => setTimeout(r, 20));

      stockfishEngine.destroy();

      // p1 is interrupted, p2 is rejected from the queue drain cleanup
      await expect(p1).rejects.toThrow();
      await expect(p2).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkerUrl — runtime detection of multi vs single-threaded variant
// ---------------------------------------------------------------------------

describe('resolveWorkerUrl', () => {
  it('returns single-threaded variant when window is undefined (SSR / no-window)', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const { resolveWorkerUrl } = await import('./stockfishEngine');
    const result = resolveWorkerUrl();
    expect(result.variant).toBe('single');
    expect(result.url).toBe('/stockfish/stockfish-18-lite-single.js');
    expect(result.reason).toBe('no-window');
  });

  it('returns multi-threaded variant when crossOriginIsolated and SharedArrayBuffer are both available', async () => {
    vi.stubGlobal('window', { crossOriginIsolated: true });
    vi.stubGlobal('SharedArrayBuffer', class {});
    vi.resetModules();
    const { resolveWorkerUrl } = await import('./stockfishEngine');
    const result = resolveWorkerUrl();
    expect(result.variant).toBe('multi');
    expect(result.url).toBe('/stockfish/stockfish-18-lite.js');
    expect(result.reason).toContain('crossOriginIsolated');
    expect(result.reason).toContain('SharedArrayBuffer');
  });

  it('falls back to single-threaded variant when crossOriginIsolated is false', async () => {
    vi.stubGlobal('window', { crossOriginIsolated: false });
    vi.stubGlobal('SharedArrayBuffer', class {});
    vi.resetModules();
    const { resolveWorkerUrl } = await import('./stockfishEngine');
    const result = resolveWorkerUrl();
    expect(result.variant).toBe('single');
    expect(result.url).toBe('/stockfish/stockfish-18-lite-single.js');
    expect(result.reason).toContain('multi-thread requirements not met');
    expect(result.reason).toContain('crossOriginIsolated=false');
  });

  it('falls back to single-threaded variant when SharedArrayBuffer is undefined (even with isolation)', async () => {
    vi.stubGlobal('window', { crossOriginIsolated: true });
    vi.stubGlobal('SharedArrayBuffer', undefined);
    vi.resetModules();
    const { resolveWorkerUrl } = await import('./stockfishEngine');
    const result = resolveWorkerUrl();
    expect(result.variant).toBe('single');
    expect(result.url).toBe('/stockfish/stockfish-18-lite-single.js');
    expect(result.reason).toContain('SharedArrayBuffer=false');
  });
});

// ---------------------------------------------------------------------------
// analyzePosition — priority-based contention rules
// ---------------------------------------------------------------------------

describe('analyzePosition priority', () => {
  it('drops an incoming prefetch when a brain eval is in flight', async () => {
    const { stockfishEngine } = await getEngine();
    await initEngine(stockfishEngine);

    // Hook postMessage to defer responses so we can inspect the
    // intermediate state. The brain eval starts but does not resolve
    // until we manually emit bestmove.
    let goSeen = false;
    const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
    pmMock.mockImplementation((msg: string) => {
      mockWorker.postMessageCalls.push(msg);
      if (msg === 'isready') {
        queueMicrotask(() => mockWorker.emit('readyok'));
      }
      if (msg.startsWith('go ')) {
        goSeen = true;
      }
    });

    const brain = stockfishEngine.analyzePosition(STARTING_FEN, 18);
    // Let the brain eval reach `go` so this.pending is set with brain priority.
    await vi.waitFor(() => {
      expect(goSeen).toBe(true);
    });

    // Prefetch arrives while brain is in flight — should be dropped
    // immediately with PrefetchDroppedError.
    await expect(
      stockfishEngine.analyzePosition(STARTING_FEN, 12, undefined, 'prefetch'),
    ).rejects.toThrow(/prefetch dropped/i);

    // Brain eval should still complete normally.
    queueMicrotask(() =>
      mockWorker.emit(
        'info depth 18 multipv 1 score cp 30 pv e2e4 e7e5',
      ),
    );
    queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
    const result = await brain;
    expect(result.bestMove).toBe('e2e4');
  });

  it('cancels an in-flight prefetch when a brain call arrives', async () => {
    const { stockfishEngine } = await getEngine();
    await initEngine(stockfishEngine);

    let goCount = 0;
    const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
    pmMock.mockImplementation((msg: string) => {
      mockWorker.postMessageCalls.push(msg);
      if (msg === 'isready') {
        queueMicrotask(() => mockWorker.emit('readyok'));
      }
      if (msg.startsWith('go ')) {
        goCount++;
      }
    });

    // Start a prefetch that we leave hanging.
    const prefetch = stockfishEngine.analyzePosition(
      STARTING_FEN,
      12,
      undefined,
      'prefetch',
    );
    await vi.waitFor(() => {
      expect(goCount).toBe(1);
    });

    // Brain arrives — should cancel the prefetch.
    const brain = stockfishEngine.analyzePosition(STARTING_FEN, 18);

    await expect(prefetch).rejects.toThrow(/Analysis interrupted/i);

    // Drive brain to completion.
    await vi.waitFor(() => {
      expect(goCount).toBe(2);
    });
    queueMicrotask(() =>
      mockWorker.emit(
        'info depth 18 multipv 1 score cp 30 pv e2e4 e7e5',
      ),
    );
    queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
    const result = await brain;
    expect(result.bestMove).toBe('e2e4');
  });

  it('serializes brain-on-brain — in-flight brain completes before new brain starts', async () => {
    const { stockfishEngine } = await getEngine();
    await initEngine(stockfishEngine);

    const goFens: string[] = [];
    const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
    let lastPositionFen = '';
    pmMock.mockImplementation((msg: string) => {
      mockWorker.postMessageCalls.push(msg);
      if (msg === 'isready') {
        queueMicrotask(() => mockWorker.emit('readyok'));
      }
      const posMatch = /^position fen (.+)$/.exec(msg);
      if (posMatch) {
        lastPositionFen = posMatch[1];
      }
      if (msg.startsWith('go ')) {
        goFens.push(lastPositionFen);
      }
    });

    const FEN_A =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const FEN_B =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

    const brainA = stockfishEngine.analyzePosition(FEN_A, 18);
    // Wait until brainA reaches `go`.
    await vi.waitFor(() => {
      expect(goFens).toEqual([FEN_A]);
    });

    // Brain B arrives while A is in flight. With cancel-on-new
    // behavior it would supersede A; with serialization it must wait.
    const brainB = stockfishEngine.analyzePosition(FEN_B, 18);

    // Give the microtask queue a tick to process. B must NOT have
    // started yet — only A's `go` should be on the wire.
    await Promise.resolve();
    await Promise.resolve();
    expect(goFens).toEqual([FEN_A]);

    // Resolve brainA.
    queueMicrotask(() =>
      mockWorker.emit(
        'info depth 18 multipv 1 score cp 30 pv e2e4 e7e5',
      ),
    );
    queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
    const resultA = await brainA;
    expect(resultA.bestMove).toBe('e2e4');

    // Now B should start.
    await vi.waitFor(() => {
      expect(goFens).toEqual([FEN_A, FEN_B]);
    });
    queueMicrotask(() =>
      mockWorker.emit(
        'info depth 18 multipv 1 score cp 25 pv g1f3 b8c6',
      ),
    );
    queueMicrotask(() => mockWorker.emit('bestmove g1f3'));
    const resultB = await brainB;
    expect(resultB.bestMove).toBe('g1f3');
  });

  it('default priority is brain (no explicit priority arg behaves like brain)', async () => {
    const { stockfishEngine } = await getEngine();
    await initEngine(stockfishEngine);

    let goCount = 0;
    const pmMock = mockWorker.instance.postMessage as ReturnType<typeof vi.fn>;
    pmMock.mockImplementation((msg: string) => {
      mockWorker.postMessageCalls.push(msg);
      if (msg === 'isready') {
        queueMicrotask(() => mockWorker.emit('readyok'));
      }
      if (msg.startsWith('go ')) {
        goCount++;
      }
    });

    // No explicit priority — defaults to 'brain'.
    const first = stockfishEngine.analyzePosition(STARTING_FEN, 18);
    await vi.waitFor(() => {
      expect(goCount).toBe(1);
    });

    // A subsequent prefetch must be dropped — proving the first
    // call was treated as brain priority.
    await expect(
      stockfishEngine.analyzePosition(STARTING_FEN, 12, undefined, 'prefetch'),
    ).rejects.toThrow(/prefetch dropped/i);

    queueMicrotask(() =>
      mockWorker.emit(
        'info depth 18 multipv 1 score cp 30 pv e2e4 e7e5',
      ),
    );
    queueMicrotask(() => mockWorker.emit('bestmove e2e4'));
    await first;
  });
});

// ---------------------------------------------------------------------------
// Runtime fallback — multi-thread bundle fails despite capabilities
// ---------------------------------------------------------------------------

describe('runtime fallback (multi → single)', () => {
  // Helper: install COI + SAB so resolveWorkerUrl picks 'multi', and
  // a Worker stub that captures every URL passed to `new Worker(...)`.
  // Returns the URL log so tests can assert which bundle was spawned.
  function installMultiCapableEnv(): { workerUrls: string[] } {
    vi.stubGlobal('window', {
      crossOriginIsolated: true,
      location: { pathname: '/' },
    });
    vi.stubGlobal('SharedArrayBuffer', class {});

    const workerUrls: string[] = [];
    vi.stubGlobal(
      'Worker',
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class MockWorkerClass {
        constructor(url: string) {
          workerUrls.push(url);
          workerConstructorCallCount++;
          return mockWorker.instance as unknown as MockWorkerClass;
        }
      },
    );

    return { workerUrls };
  }

  it('selects multi-thread when capabilities are present and uciok arrives', async () => {
    const { workerUrls } = installMultiCapableEnv();
    const { stockfishEngine } = await getEngine();

    completeInit();
    await stockfishEngine.initialize();

    expect(workerUrls).toEqual(['/stockfish/stockfish-18-lite.js']);
    expect(workerConstructorCallCount).toBe(1);
    expect(mockWorker.postMessageCalls).toContain(
      'setoption name Threads value 4',
    );
  });

  it('falls back to single when multi-thread worker.onerror fires before uciok', async () => {
    const { workerUrls } = installMultiCapableEnv();
    const { stockfishEngine } = await getEngine();

    const initPromise = stockfishEngine.initialize();

    // Let the multi-thread worker construct and the engine send 'uci'.
    await Promise.resolve();
    await Promise.resolve();
    expect(workerUrls).toEqual(['/stockfish/stockfish-18-lite.js']);

    // Phase 8 — the engine now waits ~100ms after terminate() for
    // the browser to reclaim the multi-thread WASM heap before
    // spawning the single-thread fallback. Fake timers MUST be
    // active before the error fires so the setTimeout call is
    // captured.
    vi.useFakeTimers();
    // Multi-thread bundle throws before responding with uciok.
    mockWorker.emitError('runtime crash in pthread spawn');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();

    // Microtasks settle, fallback kicks off, second worker is spawned.
    await Promise.resolve();
    await Promise.resolve();
    expect(workerUrls).toEqual([
      '/stockfish/stockfish-18-lite.js',
      '/stockfish/stockfish-18-lite-single.js',
    ]);

    // Drive the single-thread handshake to completion.
    queueMicrotask(() => {
      mockWorker.emit('uciok');
      queueMicrotask(() => mockWorker.emit('readyok'));
    });
    await initPromise;

    expect(stockfishEngine.status).toBe('ready');
    // Threads/Hash setoption should NOT have been sent — single-thread
    // skips them.
    expect(mockWorker.postMessageCalls).not.toContain(
      'setoption name Threads value 4',
    );
  });

  it('does not retry the multi bundle on subsequent initialize() calls (sticky fallback)', async () => {
    const { workerUrls } = installMultiCapableEnv();
    const { stockfishEngine } = await getEngine();

    // First initialize: multi fails → fallback to single → success.
    const first = stockfishEngine.initialize();
    await Promise.resolve();
    await Promise.resolve();
    // Phase 8 reclaim delay: fake timers must be active BEFORE the
    // error fires so the setTimeout call is captured.
    vi.useFakeTimers();
    mockWorker.emitError('runtime crash');
    vi.advanceTimersByTime(150);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    queueMicrotask(() => {
      mockWorker.emit('uciok');
      queueMicrotask(() => mockWorker.emit('readyok'));
    });
    await first;
    expect(workerUrls).toEqual([
      '/stockfish/stockfish-18-lite.js',
      '/stockfish/stockfish-18-lite-single.js',
    ]);

    // Force a fresh init by destroying.
    stockfishEngine.destroy();

    // Second initialize: should go straight to single, no multi probe.
    completeInit();
    await stockfishEngine.initialize();

    expect(workerUrls).toEqual([
      '/stockfish/stockfish-18-lite.js',
      '/stockfish/stockfish-18-lite-single.js',
      '/stockfish/stockfish-18-lite-single.js',
    ]);
  });

  it('treats single-thread worker.onerror as a real init failure (no fallback loop)', async () => {
    // Capabilities present so resolveWorkerUrl picks multi, but we
    // immediately push the engine into the single variant by
    // simulating a multi failure first. After fallback succeeds,
    // pretend single also crashes — should NOT try multi again.
    installMultiCapableEnv();
    const { stockfishEngine } = await getEngine();

    const initPromise = stockfishEngine.initialize();
    await Promise.resolve();
    await Promise.resolve();
    // Phase 8 added a reclaim delay before the single-thread spawn.
    // Fake timers must be active BEFORE the error fires.
    vi.useFakeTimers();
    mockWorker.emitError('multi crash');
    vi.advanceTimersByTime(200);
    // Advance past the 500ms dedup window so the next error is
    // processed as a fresh event, not coalesced with the multi crash.
    vi.advanceTimersByTime(600);
    // Now simulate the SINGLE-thread worker also failing — with a
    // non-OOM message so the OOM-retry path doesn't intercept it.
    mockWorker.emitError('single crash too');
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    // Init should reject; no further worker constructions.
    await expect(initPromise).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // Phase 8 — crash hygiene (dedup, reclaim delay, OOM retry)
  // -----------------------------------------------------------------------
  describe('crash hygiene (Phase 8)', () => {
    /** Build a single ErrorEvent-like object that records whether
     *  preventDefault was called. The engine's onerror handler is
     *  expected to call .preventDefault() so worker errors don't
     *  bubble to window.onerror. */
    function makeErrorEvent(message: string): ErrorEvent & { defaultPrevented: boolean } {
      let prevented = false;
      const ev = {
        message,
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as ErrorEvent & { defaultPrevented: boolean };
      Object.defineProperty(ev, 'defaultPrevented', {
        get: () => prevented,
      });
      return ev;
    }

    it('calls preventDefault on worker.onerror to stop bubbling to window.onerror', async () => {
      const { stockfishEngine } = await getEngine();
      const initPromise = stockfishEngine.initialize();
      initPromise.catch(() => undefined); // attach catcher before any reject
      await Promise.resolve();
      const ev = makeErrorEvent('worker boom');
      vi.useFakeTimers();
      mockWorker.instance.onerror?.(ev);
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      expect(ev.defaultPrevented).toBe(true);
    });

    it('coalesces a burst of worker errors into a single fallback path', async () => {
      const { stockfishEngine } = await getEngine();
      const initPromise = stockfishEngine.initialize();
      initPromise.catch(() => undefined);
      await Promise.resolve();

      const beforeBurst = workerConstructorCallCount;
      // Burst of 60 ErrorEvents in the same crash window — same shape
      // as the audit-cycle dbaee3b finding cluster.
      vi.useFakeTimers();
      for (let i = 0; i < 60; i += 1) {
        mockWorker.instance.onerror?.(makeErrorEvent(`burst-${i}`));
      }
      // Drive the reclaim delay so the (single) single-thread spawn
      // actually happens.
      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      await Promise.resolve();

      // Exactly one new worker construction — the single-thread
      // fallback. NOT 60.
      expect(workerConstructorCallCount - beforeBurst).toBeLessThanOrEqual(1);
    });

    it('retries single-thread spawn once on OOM with a backoff', async () => {
      const { stockfishEngine } = await getEngine();
      const initPromise = stockfishEngine.initialize();
      initPromise.catch(() => undefined);
      await Promise.resolve();

      // Multi crashes → fall back to single.
      vi.useFakeTimers();
      mockWorker.instance.onerror?.(makeErrorEvent('multi crash'));
      vi.advanceTimersByTime(200); // reclaim delay
      vi.useRealTimers();
      await Promise.resolve();

      const afterFallbackCount = workerConstructorCallCount;
      // Single-thread spawn ALSO OOMs. Reset the dedup window so the
      // OOM error isn't coalesced with the prior multi error — in
      // production they'd be in different windows naturally.
      vi.useFakeTimers();
      // advance past the dedup window first
      vi.advanceTimersByTime(600);
      mockWorker.instance.onerror?.(
        makeErrorEvent(
          'Uncaught RuntimeError: Aborted(RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance)',
        ),
      );
      // Phase 8 Bug C — engine should retry once after the backoff
      // window. Advance timers past the retry delay.
      vi.advanceTimersByTime(600);
      vi.useRealTimers();
      await Promise.resolve();

      // One additional worker spawned by the retry path.
      expect(workerConstructorCallCount).toBe(afterFallbackCount + 1);
    });

    it('does NOT retry a second time after the retry budget is spent', async () => {
      const { stockfishEngine } = await getEngine();
      const initPromise = stockfishEngine.initialize();
      initPromise.catch(() => undefined);
      await Promise.resolve();

      // Multi crashes → fall back to single.
      vi.useFakeTimers();
      mockWorker.instance.onerror?.(makeErrorEvent('multi crash'));
      vi.advanceTimersByTime(200);

      // Single OOMs → first retry (advance past dedup window first).
      vi.advanceTimersByTime(600);
      mockWorker.instance.onerror?.(
        makeErrorEvent('WebAssembly.instantiate(): Out of memory'),
      );
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const afterRetryCount = workerConstructorCallCount;
      // Retry ALSO OOMs — budget exhausted. Engine should reject the
      // init promise and NOT spawn another worker. Advance past
      // dedup window before emitting so the error is processed.
      vi.advanceTimersByTime(600);
      mockWorker.instance.onerror?.(
        makeErrorEvent('WebAssembly.instantiate(): Out of memory'),
      );
      vi.advanceTimersByTime(600);
      vi.useRealTimers();
      await Promise.resolve();

      expect(workerConstructorCallCount).toBe(afterRetryCount);
      await expect(initPromise).rejects.toThrow();
    });
  });
});
