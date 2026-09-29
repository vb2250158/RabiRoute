import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateKnowledgeArguments } from './knowledge-tools.mjs';

/** The URL and secret must come from trusted local configuration, never device arguments. */
export const knowledgeHttpAdapter = Object.freeze({
  validate: validateKnowledgeArguments,
  async request({ url, token }, request) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(url) || !new URL(url).port || Number(new URL(url).port) > 65535) throw new Error('Invalid local MCP endpoint.');
    if (typeof token !== 'string' || token.length < 32) throw new Error('Missing local MCP credential.');
    const client = new Client({ name: 'rabilink-knowledge-bridge', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
    });
    try {
      await client.connect(transport, { timeout: 12000 });
      if (request.operation === 'list') return await client.listTools({}, { timeout: 12000 });
      if (request.operation !== 'call') throw new Error('Invalid bridge operation.');
      validateKnowledgeArguments(request.name, request.args);
      return await client.callTool({ name: request.name, arguments: request.args }, undefined, { timeout: 12000 });
    } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
});
