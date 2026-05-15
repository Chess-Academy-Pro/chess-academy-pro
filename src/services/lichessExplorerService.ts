import type { LichessExplorerResult, LichessCloudEval } from '../types';
import { logAppAudit } from './appAuditor';

/** Network timeout for any Lichess call. Keeps slow / unresponsive
 *  Lichess endpoints from stalling the UI — callers that don't wrap
 *  with their own timeout still get protection at the service edge. */
const LICHESS_FETCH_TIMEOUT_MS = 8000;

/** WO-REAL-FIXES — route every Lichess call through our own Edge
 *  proxies (`/api/lichess-explorer`, `/api/lichess-cloud-eval`)
 *  instead of the bare `explorer.lichess.ovh` host.
 *
 *  Why: production audit cycle 6 ran the 3-shape probe (PR #355) and
 *  proved Lichess returns HTTP 401 to a bare GET from iOS Safari's
 *  default User-Agent — `Mozilla/5.0 (iPhone; CPU iPhone OS 18_7…)`.
 *  Every browser-side header trick fails because:
 *    - `User-Agent` is on the fetch forbidden-header list (silently
 *      dropped or thrown by older WebKit)
 *    - any custom header (`X-Client`, etc.) triggers CORS preflight,
 *      which Lichess explorer doesn't advertise
 *  The Edge proxy talks to Lichess from Vercel-side Node, where
 *  `User-Agent` can be set freely; the browser fetches the proxy
 *  same-origin so no CORS / no preflight / no forbidden-header. */
const EXPLORER_PROXY_PATH = '/api/lichess-explorer';
const CLOUD_EVAL_PROXY_PATH = '/api/lichess-cloud-eval';
const GAME_EXPORT_PROXY_PATH = '/api/lichess-game-export';

/** Capacitor needs absolute URLs — the page protocol is
 *  `capacitor://app.chessacademy.pro` which can't relative-resolve
 *  `/api/...`. Web stays on relative paths so the same-origin proxy
 *  CORS short-circuit applies. Mirrors `getTtsUrl()` in
 *  voiceService.ts. */
const VERCEL_ORIGIN = 'https://chess-academy-pro.vercel.app';
function isCapacitor(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'capacitor:';
}
function withApiBase(path: string): string {
  return isCapacitor() ? `${VERCEL_ORIGIN}${path}` : path;
}

export type ExplorerSource = 'lichess' | 'masters';

/** Capture the actual error fields whenever a Lichess fetch fails.
 *  Inherited from PR #355's diagnostic instrumentation — preserves
 *  the `error.name` / `error.cause` / `navigator.onLine` signal that
 *  distinguishes proxy outages from upstream Lichess outages. The
 *  `responseBody` arg captures the upstream response payload (passed
 *  through verbatim by /api/lichess-explorer) so 401 / 429 messages
 *  from Lichess are visible in the audit log instead of being
 *  swallowed by the throw-on-!ok path. */
function emitLichessFailure(
  source: string,
  url: string,
  err: unknown,
  statusIfReachable: number | null,
  responseBody?: string | null,
): void {
  const e = err as { name?: string; message?: string; cause?: unknown } | null;
  const errorName = e?.name ?? 'UnknownError';
  const errorMessage = e?.message ?? (err === null ? 'null' : err instanceof Error ? err.message : JSON.stringify(err));
  const cause =
    e?.cause !== undefined && e?.cause !== null
      ? typeof e.cause === 'string'
        ? e.cause
        : JSON.stringify(e.cause)
      : null;
  // Trim the body to a manageable size — Lichess's HTML 401 page can
  // be many KB; the first ~500 chars are enough to identify the
  // failure mode (Cloudflare challenge page, rate-limit JSON,
  // Lichess auth message, etc.).
  const bodyPreview =
    typeof responseBody === 'string' && responseBody.length > 0
      ? responseBody.slice(0, 500)
      : null;
  void logAppAudit({
    kind: 'lichess-error',
    category: 'subsystem',
    source,
    summary: `url=${url} status=${statusIfReachable ?? 'throw'} error=${errorName}: ${errorMessage}${bodyPreview ? ` body="${bodyPreview.replace(/\s+/g, ' ').slice(0, 80)}"` : ''}`,
    details: JSON.stringify(
      {
        url,
        status: statusIfReachable,
        errorName,
        errorMessage,
        cause,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        responseBodyPreview: bodyPreview,
      },
      null,
      2,
    ),
  });
}

/** Circuit breaker — stop calling /api/lichess-explorer after N
 *  consecutive failures, but auto-retry after CIRCUIT_RESET_AFTER_MS
 *  so a transient burst of 401s doesn't permanently block Lichess
 *  for the rest of the session. Production audit logs show the
 *  explorer endpoint returning HTTP 401 in waves — sometimes a
 *  cluster of 5 in a row, then it clears. Without a time-based
 *  reset, the first 3 failures of a 30-minute coach session would
 *  silently disable Lichess for the next 27 minutes even after the
 *  upstream issue resolves. The circuit also resets on the next
 *  successful fetch. The per-call audit emit is gated behind the
 *  circuit state — failures while the circuit is open log once per
 *  open-cycle instead of on every move. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_RESET_AFTER_MS = 2 * 60 * 1000;
let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenedAt: number | null = null;
let openCircuitLogged = false;

function recordExplorerFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = Date.now();
  }
}

function recordExplorerSuccess(): void {
  consecutiveFailures = 0;
  circuitOpen = false;
  circuitOpenedAt = null;
  openCircuitLogged = false;
}

function isCircuitOpen(): boolean {
  if (!circuitOpen) return false;
  if (circuitOpenedAt !== null && Date.now() - circuitOpenedAt >= CIRCUIT_RESET_AFTER_MS) {
    consecutiveFailures = 0;
    circuitOpen = false;
    circuitOpenedAt = null;
    openCircuitLogged = false;
    void logAppAudit({
      kind: 'lichess-error',
      category: 'subsystem',
      source: 'lichessExplorerService.isCircuitOpen',
      summary: `circuit auto-reset after ${CIRCUIT_RESET_AFTER_MS}ms — retrying Lichess`,
      details: JSON.stringify({ circuitResetAfterMs: CIRCUIT_RESET_AFTER_MS }),
    });
    return false;
  }
  return true;
}

/** Test-only — reset the circuit between unit tests. */
export function _resetLichessCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpen = false;
  circuitOpenedAt = null;
  openCircuitLogged = false;
}

/**
 * Fetch opening explorer data for a FEN position.
 * Returns move statistics (W/D/L) from Lichess games or master games.
 */
export async function fetchLichessExplorer(
  fen: string,
  source: ExplorerSource = 'lichess',
): Promise<LichessExplorerResult> {
  if (isCircuitOpen()) {
    // Log the open-circuit state once per open-cycle so the audit
    // log reflects "we stopped trying" rather than going silent. A
    // fresh open-cycle (after a time-based reset) gets a new emit.
    if (!openCircuitLogged) {
      openCircuitLogged = true;
      const msUntilReset =
        circuitOpenedAt !== null
          ? Math.max(0, CIRCUIT_RESET_AFTER_MS - (Date.now() - circuitOpenedAt))
          : null;
      void logAppAudit({
        kind: 'lichess-error',
        category: 'subsystem',
        source: 'lichessExplorerService.fetchLichessExplorer',
        summary: `circuit open after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures — short-circuiting; retry in ${msUntilReset ?? '?'}ms`,
        details: JSON.stringify({
          consecutiveFailures,
          circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
          circuitResetAfterMs: CIRCUIT_RESET_AFTER_MS,
          msUntilReset,
          fen,
          source,
        }),
      });
    }
    // Return an empty-but-shape-valid result. Callers handle empty
    // explorer data gracefully (no grounded notes are added to the
    // prompt). Throwing would force every caller to add try/catch
    // around a state that's expected.
    throw new Error('lichess-explorer-circuit-open');
  }
  const params = new URLSearchParams({ fen, source });
  if (source === 'lichess') {
    params.set('speeds', 'blitz,rapid,classical');
    params.set('ratings', '1600,1800,2000,2200,2500');
  }
  const url = withApiBase(`${EXPLORER_PROXY_PATH}?${params.toString()}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(LICHESS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    recordExplorerFailure();
    emitLichessFailure('lichessExplorerService.fetchLichessExplorer', url, err, null);
    throw err;
  }
  if (!response.ok) {
    recordExplorerFailure();
    // Read the body so the audit captures Lichess's actual error
    // payload — the proxy passes upstream bodies through verbatim,
    // so 401 / 429 / Cloudflare challenge messages from Lichess
    // land here. Best-effort: a body read failure (already-consumed
    // stream, etc.) just logs null.
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      body = null;
    }
    emitLichessFailure(
      'lichessExplorerService.fetchLichessExplorer',
      url,
      new Error(`HTTP ${response.status}`),
      response.status,
      body,
    );
    throw new Error(`Explorer API error: ${response.status}`);
  }
  recordExplorerSuccess();
  return response.json() as Promise<LichessExplorerResult>;
}

/**
 * Fetch Lichess cloud evaluation for a FEN position.
 * Returns null if no cloud eval is available (404).
 * No auth required.
 */
export async function fetchCloudEval(
  fen: string,
  multiPv: number = 3,
): Promise<LichessCloudEval | null> {
  const params = new URLSearchParams({ fen, multiPv: String(multiPv) });
  const url = withApiBase(`${CLOUD_EVAL_PROXY_PATH}?${params.toString()}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(LICHESS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    emitLichessFailure('lichessExplorerService.fetchCloudEval', url, err, null);
    throw err;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      body = null;
    }
    emitLichessFailure(
      'lichessExplorerService.fetchCloudEval',
      url,
      new Error(`HTTP ${response.status}`),
      response.status,
      body,
    );
    throw new Error(`Cloud eval API error: ${response.status}`);
  }
  return response.json() as Promise<LichessCloudEval>;
}

/**
 * Format a centipawn value as a human-readable eval string (e.g. "+1.23").
 */
export function formatCloudEval(pv: { cp?: number; mate?: number }): string {
  if (pv.mate !== undefined) {
    return pv.mate > 0 ? `M${pv.mate}` : `-M${Math.abs(pv.mate)}`;
  }
  if (pv.cp !== undefined) {
    const pawns = pv.cp / 100;
    return pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
  }
  return '0.00';
}

/**
 * Fetch a master game's PGN by Lichess game ID. Routes through our
 * Edge proxy at /api/lichess-game-export so the iOS Safari fetch
 * forbidden-header issue doesn't bite us. The id is typically
 * sourced from a `lichess_master_games` topGames[].id entry.
 */
export async function fetchLichessGameExport(id: string): Promise<string> {
  const cleaned = id.trim();
  if (!cleaned) throw new Error('id is required');
  const params = new URLSearchParams({ id: cleaned });
  const url = withApiBase(`${GAME_EXPORT_PROXY_PATH}?${params.toString()}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/x-chess-pgn' },
      signal: AbortSignal.timeout(LICHESS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    emitLichessFailure('lichessExplorerService.fetchLichessGameExport', url, err, null);
    throw err;
  }
  if (!response.ok) {
    emitLichessFailure(
      'lichessExplorerService.fetchLichessGameExport',
      url,
      new Error(`HTTP ${response.status}`),
      response.status,
    );
    throw new Error(`Game export API error: ${response.status}`);
  }
  return response.text();
}
