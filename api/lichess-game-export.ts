/**
 * /api/lichess-game-export — server-side proxy for the Lichess
 * single-game export endpoint. Returns the PGN of a master game by
 * Lichess game ID. Same rationale as the other Lichess proxies:
 * the upstream gateway 401s bare GETs from iOS Safari's User-Agent;
 * we route through a Vercel Edge function where User-Agent isn't
 * on the forbidden-header list.
 *
 *   GET /api/lichess-game-export?id=<8-char id>
 *
 * The Lichess endpoint is `https://lichess.org/game/export/{id}` and
 * accepts `Accept: application/x-chess-pgn` to get plain PGN. We
 * forward that and return the body verbatim.
 */
export const config = { runtime: 'edge' };

const UPSTREAM_BASE = 'https://lichess.org/game/export';
const UPSTREAM_USER_AGENT =
  'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)';
const PROXY_TIMEOUT_MS = 8_000;

/** Lichess game IDs are 8-char base62. Reject anything else as a
 *  defensive measure — a wide-open passthrough proxy could be used
 *  to fetch arbitrary Lichess paths. */
const ID_RE = /^[a-zA-Z0-9]{8}$/;

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
      JSON.stringify({ error: `invalid id "${id}"; expected 8-char base62 Lichess game id` }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
  const upstreamUrl = `${UPSTREAM_BASE}/${id}`;

  // Optional LICHESS_API_KEY — see lichess-explorer.ts. Also accepts
  // the legacy LICHESS_TOKEN name.
  const token = process.env.LICHESS_API_KEY ?? process.env.LICHESS_TOKEN;
  const upstreamHeaders: Record<string, string> = {
    Accept: 'application/x-chess-pgn',
    'User-Agent': UPSTREAM_USER_AGENT,
  };
  if (token) upstreamHeaders.Authorization = `Bearer ${token}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const body = await upstream.text();
    // Pass through status. PGN content-type so the client can render
    // it directly. Edge cache 1h — master games are immutable.
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': 'application/x-chess-pgn; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
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
