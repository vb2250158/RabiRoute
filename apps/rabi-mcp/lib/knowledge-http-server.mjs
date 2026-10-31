import { getTimeoutMs } from "../../../scripts/lib/timeout-settings.mjs";
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createKnowledgeMcpServer } from './knowledge-mcp-server.mjs';

export const MAX_KNOWLEDGE_HTTP_BODY = 65536;
const digest = value => createHash('sha256').update(value).digest();
function normalizedOrigin(value) {
  if (typeof value !== 'string') throw new Error('Invalid allowed origin.');
  if (value === '*' || value === 'null') return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Invalid allowed origin.');
  return value;
}
/** Bearer authentication is independent of the optional user-configured origin policy. */
export async function startKnowledgeHttpServer({ tools, token, port = 0, host = '127.0.0.1', allowedOrigins, maxBodyBytes = MAX_KNOWLEDGE_HTTP_BODY } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error('A private bearer token of at least 32 characters is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof host !== 'string' || !host.trim() || (allowedOrigins !== undefined && !Array.isArray(allowedOrigins)) || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('Invalid HTTP server configuration.');
  if (typeof tools?.list !== 'function' || typeof tools?.call !== 'function') throw new Error('Knowledge tools are required.');
  const origins = allowedOrigins === undefined ? undefined : new Set(allowedOrigins.map(normalizedOrigin));
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
      if (req.url !== '/mcp') return fail(404, 'Not found.');
      const origin = req.headers.origin;
      if (origins && origin !== undefined && !origins.has('*') && !origins.has(origin)) return fail(403, 'Origin excluded by RABI_MCP_ALLOWED_ORIGINS; edit or remove it in the MCP launch environment.');
      if (typeof origin === 'string') {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');
        res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      // Cookies and host aliases do not alter Bearer authentication.
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      if (!timingSafeEqual(digest(auth), expected)) {
        res.setHeader('www-authenticate', 'Bearer');
        return fail(401, 'Authentication required.');
      }
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return fail(405, 'Stateless transport accepts POST only.'); }
      if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return fail(415, 'JSON required.');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return fail(415, 'Encoded bodies are not supported.');
      if (Number(req.headers['content-length']) > maxBodyBytes) return fail(413, 'Request exceeds RABI_MCP_HTTP_MAX_BODY_BYTES; change it in the MCP launch environment.');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) return fail(413, 'Request exceeds RABI_MCP_HTTP_MAX_BODY_BYTES; change it in the MCP launch environment.');
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
  server.requestTimeout = getTimeoutMs("mcp.http.request",15000); server.headersTimeout = Math.min(server.requestTimeout,getTimeoutMs("mcp.http.headers",10000)); server.keepAliveTimeout = getTimeoutMs("mcp.http.keepAlive",1000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const boundHost = server.address().address;
  const address = `http://${boundHost.includes(':') ? `[${boundHost}]` : boundHost}:${server.address().port}/mcp`;
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
