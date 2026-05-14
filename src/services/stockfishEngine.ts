import type { StockfishAnalysis, AnalysisLine } from '../types';
import { MATE_EVAL_VALUE } from './engineConstants';
import { stockfishCache } from './stockfishCache';
import { logAppAudit } from './appAuditor';

type StockfishMessageHandler = (analysis: StockfishAnalysis) => void;
type StockfishStatus = 'idle' | 'loading' | 'ready' | 'error';
type StatusChangeHandler = (status: StockfishStatus, error?: string) => void;

export type AnalysisPriority = 'brain' | 'prefetch';

/** Surface error thrown when a `priority='prefetch'` analysis is
 *  dropped because a `priority='brain'` analysis is already in flight.
 *  Callers (the speculative-prefetch path) should catch and ignore. */
export class PrefetchDroppedError extends Error {
  constructor() {
    super('prefetch dropped: brain eval in flight');
    this.name = 'PrefetchDroppedError';
  }
}

interface PendingAnalysis {
  resolve: (analysis: StockfishAnalysis) => void;
  reject: (error: Error) => void;
  lines: Map<number, AnalysisLine>;
  bestMove: string;
  depth: number;
  blackToMove: boolean;
  /** Caller's priority. Used by `analyzePosition`'s contention rules:
   *  brain calls preempt prefetch; prefetch is dropped when a brain
   *  eval is already in flight; brain-on-brain serializes via the
   *  brain mutex instead of cancelling. */
  priority: AnalysisPriority;
  /** FEN + requested depth, captured so the bestmove handler can
   *  populate the LRU cache once analysis completes. Skipped when
   *  the call carried per-analysis options (Skill Level, etc.). */
  cacheFen?: string;
  cacheDepth?: number;
}

interface QueueEntry {
  fen: string;
  depth: number;
  resolve: (analysis: StockfishAnalysis) => void;
  reject: (error: Error) => void;
}

const INIT_TIMEOUT_MS = 45_000;
const STOCKFISH_MT_URL = '/stockfish/stockfish-18-lite.js';
const STOCKFISH_ST_URL = '/stockfish/stockfish-18-lite-single.js';
/** WO-STOCKFISH-SWAP — lila-stockfish-web bridge worker. ES module
 *  worker that imports `sf16-7` (Lichess's known-iOS-compatible
 *  Stockfish 16 build) and adapts the `engine.uci()` /
 *  `engine.listen` API to the classic postMessage worker contract
 *  the rest of this engine speaks. Used on iOS Safari where
 *  `stockfish-18-lite` crashes with `RuntimeError: call_indirect to
 *  a signature that does not match` (audit cycle 6 Findings 10, 20,
 *  29, 47, 55, 79, 97, 109, 117, 120). */
const LILA_BRIDGE_URL = '/stockfish/lila-bridge.worker.js';
const MAX_CRASH_RETRIES = 3;
/** How long to wait after spawning the multi-threaded worker before
 *  declaring it broken. The bundle hangs / throws inside pthread
 *  spawn very quickly when the host environment can't actually run
 *  it, so 5s is enough to catch real failures while still allowing
 *  slow first-load WASM compilation to finish. */
const MT_EARLY_FAILURE_WINDOW_MS = 5_000;

export type StockfishVariant = 'multi' | 'single' | 'lila';

export interface ResolvedWorker {
  url: string;
  variant: StockfishVariant;
  reason: string;
  /** WO-STOCKFISH-SWAP — `lila` variant uses a module worker; the
   *  others use classic workers. Caller passes this through to
   *  `new Worker(url, { type })`. */
  workerType?: 'module' | 'classic';
}

/** WO-STOCKFISH-SWAP — iOS Safari User-Agent detection. The
 *  `stockfish-18-lite` bundles (multi AND single) crash with
 *  `RuntimeError: call_indirect to a signature that does not match`
 *  on iOS Safari 26+ (audit cycle 6 confirmed across 10+ findings).
 *  iOS Safari is detected by UA tokens that don't match other
 *  WebKit-based engines (Chrome on iOS lies and reports Safari, but
 *  ALSO has CriOS / FxiOS / EdgiOS in the UA — exclude those).
 *  When detected, route to lila-stockfish-web's sf16-7 instead.
 *  Capacitor on iOS reports user agent containing "iPhone" /
 *  "iPad" too — same crash applies; same path applies. */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  // iPad Safari masquerades as Mac on iPadOS 13+ — also check
  // maxTouchPoints to catch that.
  const looksIos =
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) &&
      typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 1);
  if (!looksIos) return false;
  // Exclude Chrome, Firefox, Edge on iOS — they don't have the WASM
  // crash and shouldn't take the lila path. They all still hit
  // `Mozilla/5.0 ... Safari/...` but inject their own token.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export function resolveWorkerUrl(): ResolvedWorker {
  if (typeof window === 'undefined') {
    return { url: STOCKFISH_ST_URL, variant: 'single', reason: 'no-window', workerType: 'classic' };
  }
  // WO-STOCKFISH-SWAP — iOS Safari is the only host where
  // stockfish-18-lite is known to crash; route it to lila first.
  if (isIosSafari()) {
    return {
      url: LILA_BRIDGE_URL,
      variant: 'lila',
      reason: 'iOS Safari detected — using lila-stockfish-web sf16-7 (stockfish-18-lite crashes on this host)',
      workerType: 'module',
    };
  }
  const isolated =
    (window as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
  if (isolated && sabAvailable) {
    return {
      url: STOCKFISH_MT_URL,
      variant: 'multi',
      reason: 'crossOriginIsolated + SharedArrayBuffer available',
      workerType: 'classic',
    };
  }
  return {
    url: STOCKFISH_ST_URL,
    variant: 'single',
    reason: `multi-thread requirements not met (crossOriginIsolated=${isolated}, SharedArrayBuffer=${sabAvailable})`,
    workerType: 'classic',
  };
}

/** Phase 8 — Stockfish crash hygiene constants. */
/** Delay between `worker.terminate()` and the single-thread fallback
 *  spawn, in milliseconds. `terminate()` is synchronous but the
 *  browser's WASM page reclamation is async; spawning the fallback
 *  immediately can OOM because the multi-thread heap hasn't been
 *  freed yet. 100ms is enough on Chrome 120 in the wild (audit cycle
 *  dbaee3b confirmed the OOM came ~95ms after the multi crash). */
const WASM_RECLAIM_DELAY_MS = 100;
/** Backoff delay before retrying a single-thread spawn that OOM'd.
 *  Most WASM OOMs are transient memory pressure that recovers
 *  within a second; one retry after this delay clears the majority
 *  of cases without making the user wait too long if the retry
 *  also fails. */
const SINGLE_THREAD_RETRY_DELAY_MS = 500;
/** How long after the FIRST worker error we keep coalescing further
 *  errors into the same audit-log entry. A crashing multi-thread
 *  bundle emits 60+ ErrorEvents in ~100ms; we want one summary log,
 *  not 60 IndexedDB writes blocking the main thread. */
const WORKER_ERROR_DEDUP_WINDOW_MS = 500;
/** localStorage key for the persisted "multi-thread is broken on
 *  this host" flag. Per audit cycle ccd0057: multi-thread crashes
 *  reliably on David's machine. Without persistence, every new
 *  session re-probes multi-thread → crashes → falls back, wasting
 *  ~2 s of init on every page load. With the flag persisted, we
 *  skip multi entirely after the first failure on a given device. */
const MULTI_FALLBACK_LS_KEY = 'sfx.multi-fallback-attempted.v1';

function readPersistedMultiFallback(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(MULTI_FALLBACK_LS_KEY) === '1';
  } catch {
    return false;
  }
}

function writePersistedMultiFallback(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MULTI_FALLBACK_LS_KEY, '1');
  } catch {
    // localStorage can throw (private browsing, quota, etc.) —
    // not worth surfacing; we just don't get persistence.
  }
}

class StockfishEngine {
  private worker: Worker | null = null;
  private isReady = false;
  private pending: PendingAnalysis | null = null;
  private messageHandlers: Set<StockfishMessageHandler> = new Set();
  private statusHandlers: Set<StatusChangeHandler> = new Set();
  private initPromise: Promise<void> | null = null;
  private _status: StockfishStatus = 'idle';
  private _error: string | null = null;
  // Analysis queue — serializes requests so they don't cancel each other
  private _queue: QueueEntry[] = [];
  private _queueRunning = false;
  // Gate to ignore stale bestmove/info from a stopped analysis
  private _analysisStarted = false;
  // Worker-crash retry counter; resets on successful initialize.
  private _crashRetries = 0;
  // Set true once the engine has surfaced "engine unavailable" so we
  // don't keep trying to reinit on every analyze call.
  private _permanentlyUnavailable = false;
  // Which Stockfish bundle the current worker was spawned from. Used
  // to gate multi-thread-only setoptions during the init handshake.
  private workerVariant: StockfishVariant = 'single';
  // Serialization chain for brain-priority analyses. Each new brain
  // call appends a fresh promise; the previous one is awaited before
  // the new call enters its handshake. Prefetch calls bypass the
  // mutex (they are dropped when a brain is in flight, or supersede
  // an in-flight prefetch).
  private _brainMutex: Promise<void> = Promise.resolve();
  // Sticky once the multi-thread bundle has failed at runtime in
  // this app session OR on this device in a previous session. Once
  // true, every subsequent initialize() call goes straight to the
  // single-threaded variant. Persisted to localStorage on first
  // failure so a fresh page load doesn't re-probe a known-broken
  // multi-thread bundle (saves ~2 s of init on every load on
  // affected devices).
  private _runtimeFallbackAttempted = readPersistedMultiFallback();
  // Phase 8 — coalesce worker error spam. Multi-thread crashes can
  // emit 60+ ErrorEvents in ~100ms; we want one audit-log row, not
  // 60. Tracks the first error timestamp + count in the current
  // dedup window.
  private _workerErrorWindow: { startedAt: number; count: number } | null = null;
  // Phase 8 — single-thread OOM retry budget. Capped at one retry
  // per session to avoid a tight spin if the host is genuinely out
  // of memory. Reset on successful init.
  private _singleThreadOomRetryUsed = false;

  get status(): StockfishStatus {
    return this._status;
  }

  get error(): string | null {
    return this._error;
  }

  private setStatus(status: StockfishStatus, error?: string): void {
    this._status = status;
    this._error = error ?? null;
    this.statusHandlers.forEach((h) => h(status, error));
  }

  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // Init-failure cooldown. When the worker init throws (commonly:
  // `WebAssembly.Memory(): could not allocate memory` on a memory-
  // pressured device), subsequent callers should fail-fast for a
  // window instead of re-entering the init flow and re-OOMing. The
  // audit (2026-05-14 scenario 25 + 26) captured 1.3M browser-level
  // pageerror events when consumer-side useEffects re-called
  // analyzePosition in a tight loop after each OOM. The 30s window
  // bounds the cascade to "a few errors then silent fail-fast" and
  // recovers on its own when the memory pressure clears.
  private _initFailedAt: number | null = null;
  private static readonly INIT_COOLDOWN_MS = 30_000;

  async initialize(): Promise<void> {
    if (this._permanentlyUnavailable) {
      throw new Error('Stockfish engine unavailable (exhausted crash retries)');
    }
    if (this._initFailedAt !== null && Date.now() - this._initFailedAt < StockfishEngine.INIT_COOLDOWN_MS) {
      throw new Error('Stockfish init cooldown — try again in a few seconds');
    }
    if (this.initPromise) return this.initPromise;

    this.setStatus('loading');
    console.log('[Stockfish] Initializing worker...');

    this.initPromise = new Promise((resolve, reject) => {
      const overallTimeoutId = setTimeout(() => {
        const msg = 'Stockfish initialization timed out after 45s';
        console.error('[Stockfish]', msg);
        this.setStatus('error', msg);
        reject(new Error(msg));
      }, INIT_TIMEOUT_MS);

      const threadCount =
        (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      const hashMb = 64;

      // Track the early-failure timer for the multi-thread variant so
      // we can clear it once uciok is received OR when fallback runs.
      let earlyFailureTimer: ReturnType<typeof setTimeout> | null = null;

      const tryStart = (forceSingle: boolean): void => {
        let resolved: ResolvedWorker;
        if (forceSingle) {
          resolved = {
            url: STOCKFISH_ST_URL,
            variant: 'single',
            reason: 'runtime fallback after multi-thread bundle failure',
            workerType: 'classic',
          };
        } else if (this._runtimeFallbackAttempted) {
          // Sticky: a previous initialize() in this session already
          // discovered that multi-thread is broken on this host. Skip
          // probing it again.
          resolved = {
            url: STOCKFISH_ST_URL,
            variant: 'single',
            reason: 'sticky fallback (multi previously failed at runtime)',
            workerType: 'classic',
          };
        } else {
          resolved = resolveWorkerUrl();
        }

        this.workerVariant = resolved.variant;
        console.log(
          `[Stockfish] Using ${resolved.variant}-threaded variant: ${resolved.reason}`,
        );
        void logAppAudit({
          kind: 'stockfish-variant-resolved',
          category: 'subsystem',
          source: 'stockfishEngine.initialize',
          summary: `variant=${resolved.variant} reason=${resolved.reason}`,
        });

        // Fallback is only meaningful for the multi-thread variant; if
        // we're already on single, a failure is a real init failure.
        const handleEarlyMultiFailure = (reason: string): void => {
          if (this.workerVariant !== 'multi') return;
          if (this._runtimeFallbackAttempted) return;
          this._runtimeFallbackAttempted = true;
          // Persist so a fresh page load on this device doesn't
          // re-probe the known-broken multi-thread bundle.
          writePersistedMultiFallback();
          if (earlyFailureTimer !== null) {
            clearTimeout(earlyFailureTimer);
            earlyFailureTimer = null;
          }
          const totalErrors = this._workerErrorWindow?.count ?? 1;
          console.warn(
            `[Stockfish] Multi-thread variant failed at runtime (${totalErrors} error event${
              totalErrors === 1 ? '' : 's'
            }), falling back to single-threaded`,
          );
          void logAppAudit({
            kind: 'stockfish-variant-fallback',
            category: 'subsystem',
            source: 'stockfishEngine.initialize',
            summary: `multi failed at runtime, fell back to single (reason: ${reason}; ${totalErrors} error event${
              totalErrors === 1 ? '' : 's'
            } coalesced)`,
          });
          this.worker?.terminate();
          this.worker = null;
          // Phase 8 Bug B — give the browser time to reclaim the
          // multi-thread WASM heap BEFORE spawning the single-thread
          // worker. Without this delay, the single-thread spawn OOMs
          // because the multi-thread pages haven't been freed yet.
          // ~100ms is enough on Chrome 120 (audit confirmed the
          // single-thread OOM came ~95ms after the multi crash).
          setTimeout(() => tryStart(true), WASM_RECLAIM_DELAY_MS);
        };

        try {
          // WO-STOCKFISH-SWAP — module worker shape for the lila
          // bridge (which uses ES module imports); classic worker
          // for the legacy stockfish-18-lite bundle.
          this.worker = resolved.workerType === 'module'
            ? new Worker(resolved.url, { type: 'module' })
            : new Worker(resolved.url);

          this.worker.onmessage = (event: MessageEvent<string>) => {
            this.handleMessage(event.data);
          };

          this.worker.onerror = (error) => {
            const msg =
              error.message ||
              'Uncaught RuntimeError or worker load failure';
            // Phase 8 Bug A — suppress the bubble to window.onerror.
            // A crashing multi-thread bundle emits 60+ ErrorEvents
            // in ~100ms; if any of those reach the global error
            // handler, installGlobalErrorHooks logs each one to
            // IndexedDB and blocks the main thread for hundreds of
            // ms. preventDefault() + the dedup window below cap
            // worker-crash audit volume at 1 row per ~500ms.
            error.preventDefault?.();
            // Coalesce console + audit logging within the dedup
            // window so we don't spam either.
            const now = Date.now();
            const inWindow =
              this._workerErrorWindow !== null &&
              now - this._workerErrorWindow.startedAt <
                WORKER_ERROR_DEDUP_WINDOW_MS;
            if (inWindow && this._workerErrorWindow) {
              this._workerErrorWindow.count += 1;
              return true;
            }
            this._workerErrorWindow = { startedAt: now, count: 1 };
            console.error('[Stockfish] worker.onerror:', msg);
            // Multi-thread bundle failed early — try the runtime
            // fallback before treating this as a fatal init error.
            if (
              this.workerVariant === 'multi' &&
              !this._runtimeFallbackAttempted
            ) {
              handleEarlyMultiFailure(msg);
              return true;
            }
            // Phase 8 Bug C — single-thread also OOM'd. Retry once
            // after a backoff so a transient memory-pressure event
            // doesn't leave the engine permanently unavailable.
            // Detect OOM by message content (WebAssembly.instantiate
            // throws "Out of memory: Cannot allocate Wasm memory").
            const isOom =
              /out of memory|cannot allocate wasm memory/i.test(msg);
            if (
              this.workerVariant === 'single' &&
              isOom &&
              !this._singleThreadOomRetryUsed
            ) {
              this._singleThreadOomRetryUsed = true;
              console.warn(
                `[Stockfish] Single-thread spawn OOM; retrying after ${SINGLE_THREAD_RETRY_DELAY_MS}ms`,
              );
              void logAppAudit({
                kind: 'stockfish-variant-fallback',
                category: 'subsystem',
                source: 'stockfishEngine.initialize',
                summary: `single-thread OOM; retry-with-backoff (${SINGLE_THREAD_RETRY_DELAY_MS}ms)`,
              });
              this.worker?.terminate();
              this.worker = null;
              if (earlyFailureTimer !== null) {
                clearTimeout(earlyFailureTimer);
                earlyFailureTimer = null;
              }
              setTimeout(() => tryStart(true), SINGLE_THREAD_RETRY_DELAY_MS);
              return true;
            }
            clearTimeout(overallTimeoutId);
            if (earlyFailureTimer !== null) {
              clearTimeout(earlyFailureTimer);
              earlyFailureTimer = null;
            }
            this.setStatus('error', msg);
            this.initPromise = null;
            reject(new Error(msg));
            return true;
          };

          // 5-second early-failure window. If multi-thread doesn't
          // reach `uciok` in that time, the bundle is hung in pthread
          // spawn — fall back instead of waiting for the 45s overall
          // timeout. Single-threaded init has no early window; it
          // either initializes within 45s or it doesn't.
          if (resolved.variant === 'multi') {
            earlyFailureTimer = setTimeout(() => {
              handleEarlyMultiFailure('no uciok within 5s of spawn');
            }, MT_EARLY_FAILURE_WINDOW_MS);
          }

          const initHandler = (event: MessageEvent<string>): void => {
            if (event.data === 'uciok') {
              // uciok received — multi is past the danger zone.
              if (earlyFailureTimer !== null) {
                clearTimeout(earlyFailureTimer);
                earlyFailureTimer = null;
              }
              if (this.workerVariant === 'multi') {
                this.send(`setoption name Threads value ${threadCount}`);
                this.send(`setoption name Hash value ${hashMb}`);
                console.log(
                  `[Stockfish] threads=${threadCount} hash=${hashMb}MB`,
                );
              } else {
                console.log(
                  '[Stockfish] single-threaded variant — skipping Threads/Hash setup',
                );
              }
              this.send('setoption name MultiPV value 3');
              this.send('isready');
              return;
            }
            if (event.data === 'readyok') {
              clearTimeout(overallTimeoutId);
              this.worker?.removeEventListener('message', initHandler);
              this.isReady = true;
              this._crashRetries = 0;
              this._initFailedAt = null; // clear cooldown on success
              // Reset Phase 8 retry budgets on successful ready.
              this._singleThreadOomRetryUsed = false;
              this._workerErrorWindow = null;
              console.log(
                `[Stockfish] Engine ready (${this.workerVariant}-threaded WASM)`,
              );
              this.setStatus('ready');
              resolve();
            }
          };

          this.worker.addEventListener('message', initHandler);
          this.send('uci');
        } catch (error) {
          // Synchronous throw during worker construction (rare, e.g.
          // the worker URL itself is malformed). Multi-thread gets
          // the runtime-fallback chance; single-thread cannot.
          if (
            this.workerVariant === 'multi' &&
            !this._runtimeFallbackAttempted
          ) {
            handleEarlyMultiFailure(
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          clearTimeout(overallTimeoutId);
          if (earlyFailureTimer !== null) {
            clearTimeout(earlyFailureTimer);
            earlyFailureTimer = null;
          }
          const msg = error instanceof Error ? error.message : String(error);
          console.error('[Stockfish] Init error:', msg);
          this.setStatus('error', msg);
          this.initPromise = null;
          reject(error instanceof Error ? error : new Error(msg));
        }
      };

      tryStart(false);
    });

    return this.initPromise.catch((err) => {
      // Surface init failures as crash events so the retry path can run.
      // ALSO record the failure timestamp so subsequent initialize()
      // calls in the next 30s fail-fast instead of re-OOMing.
      this._initFailedAt = Date.now();
      this.handleWorkerCrash(err instanceof Error ? err.message : String(err));
      throw err;
    });
  }

  /**
   * Wipe the broken worker and try once more, up to MAX_CRASH_RETRIES.
   * After the cap, mark the engine permanently unavailable so callers
   * (the brain, post-game review, hint system) can degrade gracefully.
   */
  private handleWorkerCrash(reason: string): void {
    // Record the failure for the init cooldown gate (idempotent —
    // initialize()'s own catch sets this too; covering both paths).
    this._initFailedAt = Date.now();
    this._crashRetries += 1;
    console.error(
      `[Stockfish] Worker crashed (attempt ${this._crashRetries}/${MAX_CRASH_RETRIES}): ${reason}`,
    );
    if (this.pending) {
      this.pending.reject(new Error(`worker crashed: ${reason}`));
      this.pending = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
    this.initPromise = null;
    if (this._crashRetries >= MAX_CRASH_RETRIES) {
      this._permanentlyUnavailable = true;
      this.setStatus(
        'error',
        'engine unavailable, coaching from position only',
      );
      // Reject every queued analysis so no caller hangs forever.
      for (const entry of this._queue) {
        entry.reject(new Error('engine unavailable'));
      }
      this._queue = [];
      this._queueRunning = false;
      return;
    }
    console.log('[Stockfish] Worker crashed, reinitializing...');
    // Don't await — let the next analyze call drive reinit naturally.
  }

  async analyzePosition(
    fen: string,
    depth: number = 18,
    options?: Record<string, string | number>,
    priority: AnalysisPriority = 'brain',
  ): Promise<StockfishAnalysis> {
    // FEN cache short-circuit — if we've already analyzed this exact
    // position+depth, return the cached result without invoking the
    // worker. Per-analysis `options` (e.g. Skill Level overrides) are
    // intentionally NOT part of the key — those callers should bypass
    // by passing a cache-skip sentinel if needed. Today only the brain
    // and prefetch path call without options.
    if (!options) {
      const hit = stockfishCache.get(fen, depth);
      if (hit) {
        void logAppAudit({
          kind: 'stockfish-cache-hit',
          category: 'subsystem',
          source: 'stockfishCache',
          summary: `fen=${fen.slice(0, 30)}... depth=${depth}`,
        });
        return hit;
      }
      void logAppAudit({
        kind: 'stockfish-cache-miss',
        category: 'subsystem',
        source: 'stockfishCache',
        summary: `fen=${fen.slice(0, 30)}... depth=${depth}`,
      });
    }

    // Priority contention rules:
    //   1. Incoming brain call cancels any in-flight prefetch.
    //   2. Incoming prefetch is DROPPED if a brain call is in flight
    //      (real coaching work must not be preempted by speculative
    //      warming).
    //   3. Brain-on-brain serializes via `_brainMutex` — the in-flight
    //      brain eval runs to completion before the new one starts,
    //      since both are providing real coaching value.
    if (priority === 'prefetch' && this.pending?.priority === 'brain') {
      throw new PrefetchDroppedError();
    }

    if (priority === 'brain') {
      // Append to the brain serialization chain. The previous entry
      // resolves either when the prior brain eval finishes or when it
      // fails — either way we're cleared to start. Prefetch in-flight
      // is fine; the Promise body below cancels it on entry.
      const prev = this._brainMutex;
      let release!: () => void;
      this._brainMutex = new Promise<void>((r) => {
        release = r;
      });
      try {
        await prev;
      } catch {
        /* prior brain rejected — we still proceed */
      }
      try {
        return await this._dispatchAnalysis(fen, depth, options, priority);
      } finally {
        release();
      }
    }

    return this._dispatchAnalysis(fen, depth, options, priority);
  }

  private async _dispatchAnalysis(
    fen: string,
    depth: number,
    options: Record<string, string | number> | undefined,
    priority: AnalysisPriority,
  ): Promise<StockfishAnalysis> {
    await this.initialize();

    return new Promise((resolve, reject) => {
      // If a previous analysis is pending, stop it and wait for bestmove
      // before starting the new one. With priority gating, the only
      // remaining cases here are:
      //   - incoming brain over in-flight prefetch (cancel prefetch)
      //   - incoming prefetch over in-flight prefetch (newer move's
      //     prefetch supersedes)
      //   - incoming brain after another brain's mutex released but
      //     before this entry runs (race; cancel)
      if (this.pending) {
        const oldPending = this.pending;
        this.pending = null;
        this.send('stop');
        oldPending.reject(new Error('Analysis interrupted by new request'));
      }

      const blackToMove = fen.split(' ')[1] === 'b';

      // Mark analysis as not yet started so stale bestmove from a
      // previously-stopped analysis is ignored (see handleMessage gate).
      this._analysisStarted = false;

      this.pending = {
        resolve,
        reject,
        lines: new Map(),
        bestMove: '',
        depth: 0,
        blackToMove,
        priority,
        cacheFen: options ? undefined : fen,
        cacheDepth: options ? undefined : depth,
      };

      this.send('ucinewgame');
      this.send('isready');

      // Wait for readyok before starting new analysis to avoid race with stop
      const readyHandler = (event: MessageEvent<string>): void => {
        if (event.data === 'readyok') {
          this.worker?.removeEventListener('message', readyHandler);
          // Apply per-analysis options (e.g. Skill Level) after ucinewgame reset
          if (options) {
            for (const [key, value] of Object.entries(options)) {
              this.send(`setoption name ${key} value ${value}`);
            }
          }
          this.send(`position fen ${fen}`);
          this.send(`go depth ${depth}`);
          this._analysisStarted = true;
        }
      };
      this.worker?.addEventListener('message', readyHandler);
    });
  }

  async getBestMove(fen: string, moveTimeMs: number = 1000): Promise<string> {
    await this.initialize();

    return new Promise((resolve) => {
      const handler = (event: MessageEvent<string>): void => {
        const match = /^bestmove (\S+)/.exec(event.data);
        if (match) {
          this.worker?.removeEventListener('message', handler);
          resolve(match[1]);
        }
      };

      this.worker?.addEventListener('message', handler);
      this.send(`position fen ${fen}`);
      this.send(`go movetime ${moveTimeMs}`);
    });
  }

  /**
   * Queue an analysis request. Unlike `analyzePosition` (which cancels any
   * in-flight analysis), `queueAnalysis` serializes requests — each one waits
   * for the previous to finish before starting. Useful for background tasks
   * (e.g. coach analysis) that should not interfere with the analysis board.
   */
  queueAnalysis(fen: string, depth: number = 18): Promise<StockfishAnalysis> {
    return new Promise<StockfishAnalysis>((resolve, reject) => {
      this._queue.push({ fen, depth, resolve, reject });
      void this._drainQueue();
    });
  }

  private async _drainQueue(): Promise<void> {
    if (this._queueRunning) return;
    this._queueRunning = true;
    while (this._queue.length > 0) {
      const entry = this._queue.shift();
      if (!entry) break;
      try {
        const result = await this.analyzePosition(entry.fen, entry.depth);
        entry.resolve(result);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this._queueRunning = false;
  }

  stop(): void {
    if (this.worker && this.isReady) {
      this.send('stop');
    }
  }

  /**
   * WO-STOCKFISH-SWAP-AND-PERF (part 5): brain-facing budgeted eval.
   *
   * 1. Cache hit → return synchronously via a resolved promise.
   * 2. Cache miss → fire `analyzePosition` and start a budget timer.
   *    When the timer fires, send `stop` to Stockfish so it emits
   *    `bestmove` with whatever depth it reached. The engine's
   *    bestmove handler resolves the underlying promise normally —
   *    the budget just cuts the deepening search short.
   *
   * The budget intentionally affects the engine globally (any
   * concurrent analysis will be interrupted). Brain calls go through
   * here; UI eval calls (post-game review, hint system) keep
   * `analyzePosition` directly so they aren't budget-capped.
   */
  async analyzeWithBudget(
    fen: string,
    depth: number,
    budgetMs: number = 300,
  ): Promise<StockfishAnalysis> {
    const cached = stockfishCache.get(fen, depth);
    if (cached) {
      void logAppAudit({
        kind: 'stockfish-cache-hit',
        category: 'subsystem',
        source: 'stockfishEngine.analyzeWithBudget',
        summary: `fen=${fen.slice(0, 30)}... depth=${depth}`,
      });
      return cached;
    }
    const promise = this.analyzePosition(fen, depth);
    const timer = setTimeout(() => {
      // Force Stockfish to emit bestmove from current best line.
      this.stop();
    }, budgetMs);
    try {
      const result = await promise;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  destroy(): void {
    this.stop();
    // Reject the currently running analysis, if any
    if (this.pending) {
      this.pending.reject(new Error('Engine destroyed'));
      this.pending = null;
    }
    // Reject all queued analyses
    for (const entry of this._queue) {
      entry.reject(new Error('Engine destroyed'));
    }
    this._queue = [];
    this._queueRunning = false;
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
    this.initPromise = null;
    this.setStatus('idle');
  }

  onAnalysis(handler: StockfishMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  private send(command: string): void {
    this.worker?.postMessage(command);
  }

  private handleMessage(data: string): void {
    if (!this.pending || !this._analysisStarted) return;

    // Parse info lines (MultiPV)
    const infoMatch = /^info /.exec(data);
    if (infoMatch) {
      const multipvMatch = /multipv (\d+)/.exec(data);
      const depthMatch = /depth (\d+)/.exec(data);
      const scoreMatch = /score (cp|mate) (-?\d+)/.exec(data);
      const pvMatch = / pv (.+)$/.exec(data);

      if (multipvMatch && depthMatch && scoreMatch && pvMatch) {
        const rank = parseInt(multipvMatch[1]);
        const depth = parseInt(depthMatch[1]);
        const scoreType = scoreMatch[1];
        const scoreValue = parseInt(scoreMatch[2]);
        const moves = pvMatch[1].trim().split(' ');

        this.pending.depth = depth;

        const line: AnalysisLine = {
          rank,
          evaluation: scoreType === 'cp' ? scoreValue : (scoreValue > 0 ? MATE_EVAL_VALUE : -MATE_EVAL_VALUE),
          moves,
          mate: scoreType === 'mate' ? scoreValue : null,
        };

        this.pending.lines.set(rank, line);
      }
    }

    // Best move signal
    const bestMoveMatch = /^bestmove (\S+)/.exec(data);
    if (bestMoveMatch) {
      const bestMove = bestMoveMatch[1];
      const topLines = Array.from(this.pending.lines.values())
        .sort((a, b) => a.rank - b.rank);

      // Cast to include undefined — TypeScript omits it without noUncheckedIndexedAccess
      const primaryLine = topLines[0] as AnalysisLine | undefined;
      // Stockfish returns score from side-to-move's perspective; normalize to white's perspective
      const flip = this.pending.blackToMove ? -1 : 1;
      const evaluation = (primaryLine?.evaluation ?? 0) * flip;
      const isMate = primaryLine?.mate !== null && primaryLine?.mate !== undefined;
      const mateIn = primaryLine?.mate !== null && primaryLine?.mate !== undefined
        ? primaryLine.mate * flip
        : null;

      // Normalize all lines to white's perspective
      const normalizedLines = topLines.map((line) => ({
        ...line,
        evaluation: line.evaluation * flip,
        mate: line.mate !== null ? line.mate * flip : null,
      }));

      const analysis: StockfishAnalysis = {
        bestMove,
        evaluation,
        isMate,
        mateIn,
        depth: this.pending.depth,
        topLines: normalizedLines,
        nodesPerSecond: 0,
      };

      if (this.pending.cacheFen !== undefined && this.pending.cacheDepth !== undefined) {
        stockfishCache.set(this.pending.cacheFen, this.pending.cacheDepth, analysis);
      }

      this.pending.resolve(analysis);
      this.pending = null;

      this.messageHandlers.forEach((h) => h(analysis));
    }
  }
}

// Singleton
export const stockfishEngine = new StockfishEngine();
