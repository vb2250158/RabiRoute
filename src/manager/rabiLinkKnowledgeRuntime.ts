import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateKnowledgeArguments } from '../../packages/rabi-knowledge-contract/schema.mjs';
import { createRabiLinkKnowledgeBridge, type KnowledgeBridgeConfig, type KnowledgeDeviceMetadata, type KnowledgeHttpAdapter } from './rabiLinkKnowledgeBridge.js';
export const KNOWLEDGE_PATH = '/__rabilink/knowledge';
export type KnowledgeRuntimeConfig = KnowledgeBridgeConfig & { grants?: Array<{ appId: string; deviceBindingId: string; ownerAccountId: string }> };
export type KnowledgeQueueMetadata = KnowledgeDeviceMetadata & { grant: { allowedRoles: string[]; allowedTools: string[]; allowWrites: boolean } };
export const knowledgeHttpAdapter: KnowledgeHttpAdapter = {
  validate: validateKnowledgeArguments,
  async request(config, request) {
    const client = new Client({ name: 'rabilink-pc-knowledge', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    try {
      await client.connect(transport, { timeout: 12000 });
      if (request.operation === 'list') return await client.listTools({}, { timeout: 12000 });
      validateKnowledgeArguments(request.name!, request.args!);
      return await client.callTool({ name: request.name!, arguments: request.args }, undefined, { timeout: 12000 });
    } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
};
export const isCanonicalKnowledgeDeviceId = (value: string) => /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u.test(value) && !value.includes('--');
const array = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && !!x.trim());
export async function executeKnowledgeQueue(config: KnowledgeRuntimeConfig | undefined, targetDeviceId: string, metadata: KnowledgeQueueMetadata | undefined, request: unknown, nonReplayable: boolean) {
  // Accept only canonical worker IDs; never guess a sanitized/legacy worker identity.
  if (!isCanonicalKnowledgeDeviceId(targetDeviceId)) throw new Error('KNOWLEDGE_CANONICAL_DEVICE_REQUIRED');
  if (!config?.enabled || !metadata || metadata.targetDeviceId !== targetDeviceId || !config.grants?.some(g => g.appId === metadata.appId && g.deviceBindingId === metadata.deviceBindingId && g.ownerAccountId === metadata.ownerAccountId)) throw new Error('KNOWLEDGE_DEVICE_DENIED');
  const grant = metadata.grant;
  if (!grant || !array(grant.allowedRoles) || !array(grant.allowedTools) || typeof grant.allowWrites !== 'boolean') throw new Error('KNOWLEDGE_GRANT_REQUIRED');
  const roles = (config.allowedRoles || []).filter(r => grant.allowedRoles.includes(r));
  const tools = (config.allowedTools || []).filter(t => grant.allowedTools.includes(t));
  const allowWrites = config.allowWrites === true && grant.allowWrites;
  if (!roles.length || !tools.length) throw new Error('KNOWLEDGE_EMPTY_GRANT');
  const r = request as { operation?: unknown; name?: unknown; args?: { kind?: unknown } };
  const mutation = r?.operation === 'call' && (['plan_create','plan_update','recent_memory_create','recent_memory_update'].includes(String(r.name)) || (r.name === 'memory_get' && r.args?.kind === 'recent'));
  if (mutation && nonReplayable !== true) throw new Error('KNOWLEDGE_NONREPLAYABLE_REQUIRED');
  const result = await createRabiLinkKnowledgeBridge({ ...config, allowedRoles: roles, allowedTools: tools, allowWrites }, knowledgeHttpAdapter).execute(metadata, request);
  if (r?.operation !== 'list') return result;
  const catalog = result as { tools: Array<{ inputSchema?: { properties?: Record<string, unknown> } }> };
  for (const tool of catalog.tools) if (tool.inputSchema?.properties) tool.inputSchema.properties.roleId = { type: 'string', enum: roles };
  return { ...catalog, allowedRoles: roles, allowWrites };
}
export async function probeKnowledgeBridge(config?: KnowledgeRuntimeConfig): Promise<boolean> {
  if (!config?.enabled || !config.grants?.length) return false;
  try { createRabiLinkKnowledgeBridge(config, knowledgeHttpAdapter); await knowledgeHttpAdapter.request({ url: config.url!, token: config.token! }, { operation: 'list' }); return true; } catch { return false; }
}
