import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const safeError = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message) ? error.message : 'ASSISTANT_OPERATION_FAILED';
/** Local control plane. A browser connection never owns or stops resident audio. */
export async function openAssistantServer({ host, messages, directory, port = 0, onExit = () => {} }) {
  const token = randomBytes(32).toString('base64url');
  let origin, closing = false;
  const allowed = value => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const server = createServer(async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'ASSISTANT_ORIGIN_REJECTED' });
      const path = new URL(request.url, origin).pathname;
      if (path.startsWith('/api/')) {
        if (!allowed(request.headers.authorization?.replace(/^Bearer /, ''))) return send(401, { error: 'ASSISTANT_AUTH_REQUIRED' });
        if (closing) return send(503, { error: 'ASSISTANT_CLOSED' });
        if (path === '/api/state' && request.method === 'GET') return send(200, await host.state());
        if (path === '/api/messages' && request.method === 'GET') return send(200, messages());
        if (path !== '/api/command' || request.method !== 'POST') return send(404, { error: 'ASSISTANT_ROUTE_UNKNOWN' });
        if (request.headers['content-type'] !== 'application/json') return send(415, { error: 'ASSISTANT_CONTENT_TYPE_INVALID' });
        let size = 0, chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 65536) { send(413, { error: 'ASSISTANT_REQUEST_TOO_LARGE' }); return; } chunks.push(chunk); }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'ASSISTANT_REQUEST_INVALID' }); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(400, { error: 'ASSISTANT_REQUEST_INVALID' });
        if (value.action === 'exit') { closing = true; await host.dispose(); send(200, { stopped: true }); setImmediate(() => { void close().then(onExit); }); return; }
        return send(200, await host.command(value));
      }
      if (request.method !== 'GET' || !['/', '/app.js', '/app.css', '/voice.png'].includes(path)) return send(404, { error: 'ASSISTANT_ROUTE_UNKNOWN' });
      const file = path === '/' ? 'index.html' : path.slice(1);
      const data = await readFile(join(directory, file));
      response.writeHead(200, { 'Content-Type': ({ 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8', 'voice.png': 'image/png' })[file] });
      response.end(data);
    } catch (error) { if (!response.headersSent) send(400, { error: safeError(error) }); else response.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  function close() { return new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); }
  return { origin, url: origin + '/#' + token, close };
}
