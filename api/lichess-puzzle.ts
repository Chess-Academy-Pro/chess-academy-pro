/**
 * /api/lichess-puzzle — server-side proxy for the Lichess puzzle
 * single-fetch endpoint. Returns the full puzzle record including the
 * source game PGN + `initialPly` so the client can reconstruct the
 * exact move sequence that led to the puzzle position. Used by the
 * Opening Traps "Show the opening" walkthrough.
 *
 *   GET /api/lichess-puzzle?id=<5-char puzzle id>
 *
 * Upstream: `https://lichess.org/api/puzzle/{id}` (public, JSON).
 * Same rationale as the other Lichess proxies — iOS Safari's UA gets
 * 401'd by Lichess's gateway. Edge function sets a friendlier UA.
 */
export const config = { runtime: 'edge' };

const UPSTREAM_BASE = 'https://lichess.org/api/puzzle';
const UPSTREAM_USER_AGENT =
  'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)';
const PROXY_TIMEOUT_MS = 8_000;

/** Lichess puzzle IDs are 5-char base62. Reject anything else as a
 *  defensive measure — a wide-open passthrough proxy could be used
 *  to fetch arbitrary Lichess paths. */
const ID_RE = /^[a-zA-Z0-9]{5}$/;

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
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
  const id = url.searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) {
    return new Response(
      JSON.stringify({ error: `invalid id "${id}"; expected 5-char base62 Lichess puzzle id` }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
  const upstreamUrl = `${UPSTREAM_BASE}/${id}`;

  // Optional LICHESS_API_KEY — when set, authenticated requests
  // bypass the IP-based nginx block that hits Vercel's edge IPs and
  // get higher rate limits. See lichess-explorer.ts. Also accepts
  // the legacy LICHESS_TOKEN name.
  const token = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
  const upstreamHeaders: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': UPSTREAM_USER_AGENT,
  };
  if (token) upstreamHeaders.Authorization = `Bearer ${token}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        // Puzzles are immutable — cache a full day.
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'upstream-fetch-failed',
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
}
