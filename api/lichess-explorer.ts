/**
 * /api/lichess-explorer — server-side proxy for the Lichess opening
 * explorer. Production audit cycle 6 confirmed (via the 3-shape probe
 * tool) that Lichess returns HTTP 401 to bare GETs from iOS Safari's
 * default User-Agent — so every client-side header trick we tried
 * (`User-Agent` set in fetch, `X-Client`, no headers) was chasing the
 * wrong root cause. The real fix: route through a Vercel Edge
 * function where User-Agent ISN'T on the forbidden-header list and
 * Lichess is happy to talk to us.
 *
 * Same shape as the upstream endpoint:
 *   GET /api/lichess-explorer?source=masters&fen=<fen>&...
 *
 * Forwards every query parameter except `source` (which selects the
 * upstream path: `masters` | `lichess`). Returns the upstream JSON
 * verbatim so the client-side parser doesn't change.
 */
export const config = { runtime: 'edge' };

const EXPLORER_BASE = 'https://explorer.lichess.ovh';
const ALLOWED_SOURCES = new Set(['masters', 'lichess']);

/** Fallback chain of User-Agent strings. Production audit (build
 *  d9a5f28+) showed Lichess returning a generic nginx 401 page for
 *  this proxy's requests. The contact-email format is what Lichess
 *  recommends, but a CDN/firewall in front of the explorer endpoint
 *  appears to block certain UA patterns or source IPs. We try in
 *  order; first non-401 wins. The audit captures which one worked
 *  so we can refine. */
const USER_AGENT_FALLBACK_CHAIN = [
  // 1. Lichess-recommended contact format.
  'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)',
  // 2. Standard browser UA — sometimes the blocked-pattern is
  //    "anything with our domain"; mimicking a browser bypasses it.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  // 3. Bare curl-style identifier.
  'curl/8.0.0',
];

const PROXY_TIMEOUT_MS = 8_000;

async function attemptUpstream(
  upstreamUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string; ok: boolean }> {
  // LICHESS_API_KEY — optional personal access token from
  // https://lichess.org/account/oauth/token. When set, authenticated
  // requests bypass the nginx IP-block that hits Vercel's edge
  // function range and get higher rate limits. Audit (build 23b9b15)
  // showed all three UA fallbacks 401'd anonymously; auth fixes it.
  // Also accepts the legacy LICHESS_TOKEN name from the first wiring.
  const token = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': userAgent,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const upstream = await fetch(upstreamUrl, {
    headers,
    signal,
  });
  const body = await upstream.text();
  return { status: upstream.status, body, ok: upstream.ok };
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  // Permissive for this read-only public proxy: accept any
  // Chess Academy Pro deployment (production + preview) and the
  // installed PWA Capacitor origin. Preview URLs include random
  // hashes, so a strict allowlist isn't workable; the data is public
  // and no auth is involved, so origin laxity is fine here.
  if (
    origin === 'capacitor://app.chessacademy.pro' ||
    origin === 'https://chess-academy-pro.vercel.app' ||
    /^https:\/\/chess-academy-pro-[a-z0-9-]+-dyahnke-pros-projects\.vercel\.app$/.test(origin) ||
    origin === ''
  ) {
    base['Access-Control-Allow-Origin'] = origin || '*';
    base['Vary'] = 'Origin';
  }
  return base;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get('source') ?? 'lichess';
  if (!ALLOWED_SOURCES.has(source)) {
    return new Response(
      JSON.stringify({ error: `invalid source "${source}"; expected one of ${[...ALLOWED_SOURCES].join(', ')}` }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  // Forward every other param verbatim (fen, speeds, ratings, play, etc.).
  const upstreamParams = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k === 'source') continue;
    upstreamParams.set(k, v);
  }
  const upstreamUrl = `${EXPLORER_BASE}/${source}?${upstreamParams.toString()}`;

  // Try each UA in the fallback chain. Stop on the first non-4xx
  // response (or the first 200, whichever comes first). Capture each
  // attempt's status + a body sample so the client (and the audit
  // log) can see which UA worked or what Lichess actually said.
  const attempts: Array<{ ua: string; status: number; bodySample: string }> = [];
  let lastBody = '';
  let lastStatus = 0;
  for (let i = 0; i < USER_AGENT_FALLBACK_CHAIN.length; i += 1) {
    const ua = USER_AGENT_FALLBACK_CHAIN[i];
    try {
      const result = await attemptUpstream(
        upstreamUrl,
        ua,
        AbortSignal.timeout(PROXY_TIMEOUT_MS),
      );
      attempts.push({
        ua: ua.slice(0, 80),
        status: result.status,
        bodySample: result.body.slice(0, 200),
      });
      lastBody = result.body;
      lastStatus = result.status;
      // Success: pass through verbatim.
      if (result.ok) {
        return new Response(result.body, {
          status: result.status,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, s-maxage=60',
            // Diagnostic: which UA in the chain succeeded. Helps the
            // client confirm we found a working format.
            'X-Lichess-Proxy-Ua-Index': String(i),
          },
        });
      }
      // 401 / 403 from a CDN: try the next UA. 4xx from Lichess
      // itself (legitimate "bad request") would have a JSON body —
      // pass it through immediately so the client sees the real
      // upstream error. Heuristic: nginx HTML body == CDN block;
      // anything starting with `{` or `[` is Lichess's real reply.
      const bodyTrim = result.body.trimStart();
      const isLichessJson = bodyTrim.startsWith('{') || bodyTrim.startsWith('[');
      if (isLichessJson) {
        return new Response(result.body, {
          status: result.status,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'X-Lichess-Proxy-Ua-Index': String(i),
          },
        });
      }
      // Otherwise try the next UA.
    } catch (err) {
      attempts.push({
        ua: ua.slice(0, 80),
        status: 0,
        bodySample: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // All UAs failed. Return the last upstream status + a diagnostic
  // payload so the audit shows what Lichess said for each attempt.
  return new Response(
    JSON.stringify({
      error: 'upstream-blocked',
      lastStatus,
      lastBodySample: lastBody.slice(0, 500),
      attempts,
    }),
    {
      status: lastStatus || 502,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'X-Lichess-Proxy-Ua-Index': 'all-failed',
      },
    },
  );
}
