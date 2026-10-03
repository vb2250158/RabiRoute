import { definitions } from '../../packages/rabi-knowledge-contract/schema.mjs';
import { knowledgeToolIsMutation } from '../../packages/rabi-knowledge-contract/tools.mjs';

export type KnowledgeDeviceMetadata = { appId: string; deviceBindingId: string; ownerAccountId: string; targetDeviceId: string };
export type KnowledgeRequest = { operation: 'list' | 'call'; name?: string; args?: Record<string, unknown> };
export type KnowledgeAdapter = {
  validate(name: string, args: Record<string, unknown>): void;
  request(request: KnowledgeRequest): Promise<unknown>;
};
const names = new Set<string>(Object.keys(definitions));
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function reject(code: string): never { throw new Error(code); }

/** The Relay owns app/device authentication. Body fields never establish that identity.
 * Queue writers preserve the original business key/body and never replay uncertain writes.
 */
export function createRabiLinkKnowledgeBridge(roleIds: readonly string[], adapter: KnowledgeAdapter) {
  if (!Array.isArray(roleIds) || roleIds.some(roleId => typeof roleId !== 'string' || !roleId.trim())) reject('INVALID_KNOWLEDGE_CATALOG');
  const roles = new Set(roleIds);
  return Object.freeze({ async execute(metadata: KnowledgeDeviceMetadata, value: unknown) {
    if (!plain(metadata) || Object.keys(metadata).some(key => !['appId', 'deviceBindingId', 'ownerAccountId', 'targetDeviceId'].includes(key))
      || (['appId', 'deviceBindingId', 'ownerAccountId', 'targetDeviceId'] as const).some(key => typeof metadata[key] !== 'string' || !metadata[key].trim())) reject('MISSING_TRUSTED_METADATA');
    if (!plain(value) || Object.keys(value).some(key => !['operation', 'name', 'args'].includes(key))) reject('INVALID_KNOWLEDGE_REQUEST');
    const request = structuredClone(value);
    if (request.operation === 'list') {
      if (request.name !== undefined || request.args !== undefined) reject('INVALID_KNOWLEDGE_REQUEST');
      const result = await adapter.request({ operation: 'list' });
      if (!plain(result) || !Array.isArray(result.tools)) reject('INVALID_TOOL_CATALOG');
      return { tools: result.tools.filter(tool => plain(tool) && typeof tool.name === 'string' && names.has(tool.name)) };
    }
    if (request.operation !== 'call' || typeof request.name !== 'string' || !names.has(request.name) || !plain(request.args)) reject('KNOWLEDGE_TOOL_DENIED');
    const name = request.name, args = request.args;
    adapter.validate(name, args);
    if (typeof args.roleId !== 'string' || !roles.has(args.roleId)) reject('KNOWLEDGE_ROLE_DENIED');
    const mutation = knowledgeToolIsMutation(name, args);
    if (mutation && (typeof args.idempotencyKey !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(args.idempotencyKey))) reject('STABLE_BUSINESS_KEY_REQUIRED');
    try { return await adapter.request({ operation: 'call', name, args }); }
    catch { return { ok: false, uncertain: mutation, code: mutation ? 'KNOWLEDGE_OUTCOME_UNCERTAIN' : 'KNOWLEDGE_TRANSPORT_FAILED' }; }
  } });
}
