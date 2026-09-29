import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const safeFailure = () => ({
  isError: true,
  content: [{ type: 'text', text: 'Knowledge operation failed or was rejected. Check the allowed tool, arguments and permissions. Do not automatically retry a state-changing request.' }]
});

/** MCP is a protocol adapter, not an authorization or business-state owner. */
export function createKnowledgeMcpServer({ tools } = {}) {
  if (typeof tools?.list !== 'function' || typeof tools?.call !== 'function') {
    throw new TypeError('A knowledge tools object is required.');
  }
  const server = new Server({ name: 'rabi-knowledge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return { tools: tools.list().map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description: `${description || 'Access Rabi Manager knowledge under the configured role and write policy.'} Annotations describe behavior only; they do not grant permission.`,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly === true,
        destructiveHint: readOnly !== true,
        // A stateful read can update timestamps; no blanket idempotency claim.
        idempotentHint: readOnly === true,
        openWorldHint: true
      }
    })) }; } catch {
      throw new McpError(ErrorCode.InternalError, 'Knowledge tool catalog is unavailable.');
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      // Enforce the advertised catalog as well as the tools object's own policy.
      if (!tools.list().some(tool => tool.name === request.params.name)) return safeFailure();
      const receipt = await tools.call(request.params.name, request.params.arguments ?? {});
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return safeFailure();
      return {
        isError: receipt.ok !== true || receipt.uncertain === true,
        content: [{ type: 'text', text: JSON.stringify(receipt) }],
        structuredContent: receipt
      };
    } catch {
      // Never forward exception messages/stacks, arguments, credentials or request bodies.
      return safeFailure();
    }
  });
  return server;
}

/** The caller owns shutdown via server.close(); stdout is reserved for SDK frames. */
export async function startKnowledgeMcpStdio(options) {
  const server = createKnowledgeMcpServer(options);
  try {
    await server.connect(new StdioServerTransport());
    return server;
  } catch {
    await server.close().catch(() => {});
    throw new Error('Knowledge MCP stdio startup failed.');
  }
}
