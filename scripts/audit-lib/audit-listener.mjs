/**
 * Local audit-stream listener — a tiny in-process HTTP server that
 * stands in for the real /api/audit-stream endpoint during a
 * Playwright audit run. The browser POSTs audit events to the
 * listener (set via auditStreamUrl in localStorage), the listener
 * stores them, and the test harness can GET them back via
 * `getCapturedEvents()`.
 *
 * Why this exists: in the Claude Code sandbox, the prod URL
 * (chess-academy-pro.vercel.app) is host-blocked, and `vercel dev`
 * can't authenticate without internet access to vercel.com. The
 * `page.on('request', ...)` interception catches the POST body
 * before it leaves but doesn't exercise the server-side handler.
 * This sidecar runs the actual receive-side so audits verify the
 * full round-trip locally.
 *
 * Mirrors the prod handler's semantics (timestamp-keyed entries,
 * x-audit-secret check, GET since-filter) so audits written for
 * prod work locally too.
 *
 * Usage:
 *   import { startAuditListener } from './audit-lib/audit-listener.mjs';
 *   const listener = await startAuditListener();
 *   // pass listener.url into the page's localStorage as auditStreamUrl
 *   // ... run audit ...
 *   const events = listener.getCapturedEvents();
 *   await listener.stop();
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const LOCAL_LISTENER_SECRET = randomBytes(16).toString('hex');

export async function startAuditListener({ port = 0 } = {}) {
  const captured = [];

  const server = createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/audit-stream') || url.startsWith('/api/audit-stream')) {
      // Echo CORS so the browser is happy when posting from a
      // different origin (Playwright pages run on localhost:5173,
      // listener on a random port).
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-audit-secret');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const secret = req.headers['x-audit-secret'];
      if (secret !== LOCAL_LISTENER_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad secret' }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const events = Array.isArray(parsed) ? parsed : (parsed.events ?? [parsed]);
            for (const ev of events) {
              captured.push({
                ...ev,
                timestamp: ev.timestamp ?? Date.now(),
                receivedAt: Date.now(),
              });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stored: events.length, storage: 'sidecar' }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed body', detail: String(err).slice(0, 120) }));
          }
        });
        return;
      }

      if (req.method === 'GET') {
        const u = new URL(url, 'http://localhost');
        const since = Number(u.searchParams.get('since') ?? 0);
        const events = captured.filter((e) => (e.timestamp ?? 0) > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, storage: 'sidecar' }));
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/audit-stream`;

  return {
    url,
    secret: LOCAL_LISTENER_SECRET,
    /** All POSTed events captured so far, oldest first. */
    getCapturedEvents() {
      return captured.slice();
    },
    /** Count by `kind` for a quick post-run summary. */
    countByKind() {
      const out = {};
      for (const e of captured) out[e.kind ?? 'unknown'] = (out[e.kind ?? 'unknown'] ?? 0) + 1;
      return out;
    },
    /** Filter helper — events whose `kind` matches the predicate. */
    eventsOfKind(kindOrFn) {
      const f = typeof kindOrFn === 'function'
        ? kindOrFn
        : (e) => e.kind === kindOrFn;
      return captured.filter(f);
    },
    async stop() {
      await new Promise((res) => server.close(() => res()));
    },
  };
}
