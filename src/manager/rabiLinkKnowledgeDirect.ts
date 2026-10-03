import { createManagerClient } from '../../apps/rabi-agent/lib/manager-client.mjs';
import { createKnowledgeTools } from '../../packages/rabi-knowledge-contract/tools.mjs';
import type { KnowledgeRequest } from './rabiLinkKnowledgeBridge.js';

export type KnowledgeManagerEndpoint = { managerBaseUrl: string; applicationGenerationId: string; managerInstanceId: string };
export type KnowledgeRuntimeContext = { endpoint(): KnowledgeManagerEndpoint; roleIds(): readonly string[] };
const MAX_META_BYTES = 256 * 1024;
function endpointSnapshot(context: KnowledgeRuntimeContext): KnowledgeManagerEndpoint {
  const endpoint = { ...context.endpoint() };
  const url = new URL(endpoint.managerBaseUrl);
  if (!/^http:\/\/[^/]+\/?$/.test(endpoint.managerBaseUrl) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'http:') throw new Error('KNOWLEDGE_MANAGER_ADDRESS_INVALID');
  if (![endpoint.applicationGenerationId, endpoint.managerInstanceId].every(value => typeof value === 'string' && value.trim())) throw new Error('KNOWLEDGE_MANAGER_IDENTITY_REQUIRED');
  endpoint.managerBaseUrl = url.origin;
  return endpoint;
}
const sameEndpoint = (left: KnowledgeManagerEndpoint, right: KnowledgeManagerEndpoint) => left.managerBaseUrl === right.managerBaseUrl
  && left.applicationGenerationId === right.applicationGenerationId && left.managerInstanceId === right.managerInstanceId;

/** Uses Manager's existing public knowledge API and receipts, with no local MCP process or secret. */
export function createDirectKnowledgeAdapter(context: KnowledgeRuntimeContext, roleIds: readonly string[], fetchImpl: typeof fetch = fetch) {
  const expected = endpointSnapshot(context);
  async function ensure({ diagnostic = false, signal }: { diagnostic?: boolean; signal?: AbortSignal } = {}) {
    if (!sameEndpoint(expected, endpointSnapshot(context))) throw new Error('KNOWLEDGE_MANAGER_IDENTITY_CHANGED');
    const timeout = AbortSignal.timeout(5000);
    const response = await fetchImpl(`${expected.managerBaseUrl}/meta`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } });
    if (!response.ok || !response.body) throw new Error('KNOWLEDGE_MANAGER_META_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_META_BYTES) { await reader.cancel(); throw new Error('KNOWLEDGE_MANAGER_META_INVALID'); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (Object.hasOwn(raw, 'data') && raw.code !== 0)) throw new Error('KNOWLEDGE_MANAGER_META_INVALID');
    const meta = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data as Record<string, unknown> : raw;
    if (meta.applicationGenerationId !== expected.applicationGenerationId || meta.managerInstanceId !== expected.managerInstanceId
      || !sameEndpoint(expected, endpointSnapshot(context))) throw new Error('KNOWLEDGE_MANAGER_IDENTITY_CHANGED');
    const health = meta.health as { live?: boolean; requiredReady?: boolean; state?: string } | undefined;
    if (!diagnostic && (health?.live !== true || health.requiredReady !== true || !['healthy', 'degraded'].includes(health.state || ''))) throw new Error('KNOWLEDGE_MANAGER_NOT_READY');
    return { managerUrl: expected.managerBaseUrl, meta };
  }
  const client = createManagerClient({ managerUrl: expected.managerBaseUrl, endpointSession: { ensure }, localHost: true, timeoutMs: 12000, fetchImpl });
  const tools = createKnowledgeTools({ client, allowedRoles: roleIds, allowWrites: true });
  return Object.freeze({
    // Plugin startup precedes requiredReady. Verify the exact owner without waiting on our own readiness.
    async probe(signal?: AbortSignal) { await ensure({ diagnostic: true, signal }); tools.list(); },
    async request(request: KnowledgeRequest): Promise<unknown> {
      if (request.operation === 'list') {
        await ensure();
        return { tools: tools.list().map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema,
          annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true } })) };
      }
      const receipt = await tools.call(request.name!, request.args!);
      return { isError: receipt.ok !== true || receipt.uncertain, content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt };
    }
  });
}
