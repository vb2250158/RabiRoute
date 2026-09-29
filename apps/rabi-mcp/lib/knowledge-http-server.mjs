import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createKnowledgeMcpServer } from './knowledge-mcp-server.mjs';

export const MAX_KNOWLEDGE_HTTP_BODY = 65536;
const digest = value => createHash('sha256').update(value).digest();
function normalizedOrigin(value) {
  if (typeof value !== 'string') throw new Error('Invalid allowed origin.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Invalid allowed origin.');
  return value;
}
/** Local authenticated bridge only; a remote device needs an independently authorized Relay/PC proxy. */
export async function startKnowledgeHttpServer({ tools, token, port = 0, allowedOrigins = [] } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error('A private bearer token of at least 32 characters is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Array.isArray(allowedOrigins)) throw new Error('Invalid HTTP server configuration.');
  if (typeof tools?.list !== 'function' || typeof tools?.call !== 'function') throw new Error('Knowledge tools are required.');
  const origins = new Set(allowedOrigins.map(normalizedOrigin));
  const expected = digest(`Bearer ${token}`);
  const active = new Set();
  let closing = false, closePromise;
  const server = http.createServer(async (req, res) => {
    const fail = (status, message) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      res.end(message);
    };
    try {
      if (closing) return fail(503, 'Service closing.');
      if (req.socket.remoteAddress !== '127.0.0.1') return fail(403, 'Local access required.');
      if (req.url !== '/mcp') return fail(404, 'Not found.');
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host) return fail(403, 'Invalid host.');
      // Do not trust forwarded headers or browser cookies as identity.
      if (req.headers.cookie !== undefined) return fail(403, 'Cookies are not supported.');
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      if (!timingSafeEqual(digest(auth), expected)) {
        res.setHeader('www-authenticate', 'Bearer');
        return fail(401, 'Authentication required.');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !origins.has(origin))) return fail(403, 'Origin denied.');
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return fail(405, 'Stateless transport accepts POST only.'); }
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return fail(415, 'JSON required.');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return fail(415, 'Encoded bodies are not supported.');
      if (Number(req.headers['content-length']) > MAX_KNOWLEDGE_HTTP_BODY) return fail(413, 'Request too large.');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_KNOWLEDGE_HTTP_BODY) return fail(413, 'Request too large.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'Invalid JSON.'); }
      // A fresh official SDK server/transport per POST: no cross-request MCP session state.
      const mcp = createKnowledgeMcpServer({ tools });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let released = false;
      const release = async () => {
        if (released) return;
        released = true; active.delete(release);
        await mcp.close().catch(() => {});
      };
      active.add(release);
      res.once('finish', release); res.once('close', release);
      try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
      catch { fail(500, 'MCP request failed.'); await release(); }
    } catch { fail(400, 'Request could not be processed.'); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${server.address().port}/mcp`;
  return Object.freeze({ address, close() {
    if (!closePromise) closePromise = (async () => {
      closing = true;
      const stopped = new Promise(resolve => server.close(resolve));
      await Promise.all([...active].map(release => release()));
      server.closeAllConnections();
      await stopped;
    })();
    return closePromise;
  } });
}
