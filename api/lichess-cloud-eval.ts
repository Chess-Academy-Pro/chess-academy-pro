/**
 * /api/lichess-cloud-eval — server-side proxy for Lichess's cloud
 * eval endpoint. Same rationale as `/api/lichess-explorer`: iOS
 * Safari's default User-Agent is gateway-blocked at Lichess; a
 * Vercel Edge function can set a real `User-Agent` that the gateway
 * accepts, so the client-side fetch routes through us instead.
 *
 *   GET /api/lichess-cloud-eval?fen=<fen>&multiPv=<n>
 *
 * Returns the upstream JSON verbatim. 404 from upstream (position
 * not in the cloud) is passed through so the client's
 * `if (status === 404) return null` path keeps working unchanged.
 */
export const config = { runtime: 'edge' };

const UPSTREAM = 'https://lichess.org/api/cloud-eval';
const UPSTREAM_USER_AGENT =
  'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)';
const PROXY_TIMEOUT_MS = 8_000;

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
  const fen = url.searchParams.get('fen');
  if (!fen) {
    return new Response(JSON.stringify({ error: 'fen is required' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  const upstreamParams = new URLSearchParams();
  for (const [k, v] of url.searchParams) upstreamParams.set(k, v);
  const upstreamUrl = `${UPSTREAM}?${upstreamParams.toString()}`;

  // Optional LICHESS_API_KEY — see lichess-explorer.ts. Also accepts
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
        // Cloud-eval entries are deterministic per FEN; cache 60s.
        'Cache-Control': 'public, max-age=60, s-maxage=60',
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
