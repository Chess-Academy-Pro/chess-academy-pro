/**
 * /api/lichess-tablebase — server-side proxy for the Lichess
 * tablebase service. Mirrors the architecture of
 * /api/lichess-explorer (UA fallback chain, CORS, edge runtime).
 *
 * Why proxy: Lichess's CDN sometimes 401s iOS Safari's default
 * User-Agent. Routing through a Vercel Edge function lets us set
 * `User-Agent` server-side (it's on the forbidden-headers list in
 * the browser fetch API but allowed in edge runtime).
 *
 * Tablebase returns perfect-play results for ≤7-piece positions:
 * WDL category (win/draw/loss), DTM, DTZ, plus the same
 * information per legal move. The Eval Lab quiz uses this to
 * verify hand-curated `result` claims with mathematical
 * certainty.
 *
 * Request shape:
 *   GET /api/lichess-tablebase?fen=<FEN>
 *
 * Response: forwarded JSON from the upstream tablebase API.
 */
export const config = { runtime: 'edge' };

const TABLEBASE_BASE = 'https://tablebase.lichess.ovh';
const TABLEBASE_PATH = '/standard';

const USER_AGENT_FALLBACK_CHAIN = [
  'ChessAcademyPro/1.0 (https://chess-academy-pro.vercel.app; contact: dyahnke@gmail.com)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'curl/8.0.0',
];

const PROXY_TIMEOUT_MS = 8_000;

async function attemptUpstream(
  upstreamUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string; ok: boolean }> {
  const upstream = await fetch(upstreamUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
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
    return new Response(
      JSON.stringify({ error: 'missing fen parameter' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  // Tablebase only accepts standard chess positions with ≤7 pieces.
  // Quick piece count filter to avoid a wasted upstream call when
  // the position is too big.
  const pieceCount = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
  if (pieceCount > 7) {
    return new Response(
      JSON.stringify({
        error: 'tablebase-out-of-range',
        message: `position has ${pieceCount} pieces; tablebase supports ≤7`,
      }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const upstreamParams = new URLSearchParams({ fen });
  const upstreamUrl = `${TABLEBASE_BASE}${TABLEBASE_PATH}?${upstreamParams.toString()}`;

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
      lastBody = result.body;
      lastStatus = result.status;
      if (result.ok) {
        return new Response(result.body, {
          status: result.status,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            // Tablebase results never change for a given FEN, so
            // cache aggressively. 1 day client-side, 1 day CDN.
            'Cache-Control': 'public, max-age=86400, s-maxage=86400',
            'X-Lichess-Tablebase-Ua-Index': String(i),
          },
        });
      }
      const bodyTrim = result.body.trimStart();
      const isLichessJson = bodyTrim.startsWith('{') || bodyTrim.startsWith('[');
      if (isLichessJson) {
        return new Response(result.body, {
          status: result.status,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'X-Lichess-Tablebase-Ua-Index': String(i),
          },
        });
      }
    } catch {
      // Try next UA.
    }
  }
  return new Response(
    JSON.stringify({
      error: 'upstream-blocked',
      lastStatus,
      lastBodySample: lastBody.slice(0, 500),
    }),
    {
      status: lastStatus || 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
    },
  );
}
