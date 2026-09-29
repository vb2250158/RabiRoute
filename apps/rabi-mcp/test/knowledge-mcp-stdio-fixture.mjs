import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';
import { startKnowledgeMcpStdio } from '../lib/knowledge-mcp-server.mjs';

// No network, Host discovery or filesystem business storage is used by this fixture.
const tools = createKnowledgeTools({
  allowedRoles: ['fixture-role'],
  client: {
    async invoke(method, target) {
      if (method !== 'GET' || !target.startsWith('/api/roles/fixture-role/knowledge/search?')) throw new Error('Unexpected fixture operation.');
      return { statusCode: 200, ok: true, uncertain: false, headers: {}, body: JSON.stringify({ code: 0, data: { items: [{ id: 'fixture-plan', title: 'Fixture only' }] } }) };
    }
  }
});
const server = await startKnowledgeMcpStdio({ tools });
process.stdin.once('end', () => { server.close().catch(() => { process.exitCode = 1; }); });
