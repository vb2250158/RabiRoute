import { createManagerClient } from './lib/manager-client.mjs';
import { createHostEndpointSession } from './lib/host-endpoint.mjs';
import { createKnowledgeTools } from './lib/knowledge-tools.mjs';
import { startKnowledgeMcpStdio } from './lib/knowledge-mcp-server.mjs';
import { startKnowledgeHttpServer } from './lib/knowledge-http-server.mjs';

// Configuration belongs to the launching MCP host, never to tool arguments.
async function main() {
  const rawRoles = process.env.RABI_MCP_ALLOWED_ROLES;
  if (!rawRoles) throw new Error('Missing allowed roles.');
  const allowedRoles = JSON.parse(rawRoles);
  const writeSetting = process.env.RABI_MCP_ALLOW_WRITES || 'false';
  if (!['true', 'false'].includes(writeSetting)) throw new Error('Invalid write setting.');
  const endpointSession = createHostEndpointSession({ hostExecutable: process.env.RABIROUTE_HOST_EXE });
  const endpoint = await endpointSession.ensure({ diagnostic: true });
  const client = createManagerClient({ managerUrl: endpoint.managerUrl, endpointSession, localHost: true, timeoutMs: 12000 });
  const tools = createKnowledgeTools({ client, allowedRoles, allowWrites: writeSetting === 'true' });
  const transport = process.env.RABI_MCP_TRANSPORT || 'stdio';
  if (transport === 'stdio') {
    await startKnowledgeMcpStdio({ tools });
  } else if (transport === 'http') {
    const portText = process.env.RABI_MCP_HTTP_PORT || '0';
    if (!/^(0|[1-9][0-9]{0,4})$/.test(portText)) throw new Error('Invalid port.');
    const server = await startKnowledgeHttpServer({ tools, token: process.env.RABI_MCP_HTTP_TOKEN, port: Number(portText) });
    process.stdout.write(JSON.stringify({ event: 'READY', transport: 'http', address: server.address }) + '\n');
    const close = () => { server.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else throw new Error('Unsupported transport.');
}
main().catch(() => {
  process.stderr.write('Rabi knowledge MCP could not start. Check Host readiness, the configured executable, allowed roles and write setting. No business operation was sent.\n');
  process.exitCode = 1;
});
