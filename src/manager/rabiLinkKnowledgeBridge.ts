export type KnowledgeDeviceMetadata = { appId: string; deviceBindingId: string; ownerAccountId: string; targetDeviceId: string };
export type KnowledgeBridgeConfig = { enabled?: boolean; url?: string; token?: string; allowedRoles?: string[]; allowedTools?: string[]; allowWrites?: boolean };
export type KnowledgeHttpAdapter = {
  validate(name: string, args: Record<string, unknown>): void;
  request(config: { url: string; token: string }, request: { operation: 'list' | 'call'; name?: string; args?: Record<string, unknown> }): Promise<unknown>;
};
const names = new Set(['knowledge_search', 'plan_list', 'plan_get', 'plan_statuses', 'memory_list', 'memory_get', 'plan_create', 'plan_update', 'recent_memory_create', 'recent_memory_update']);
const writes = new Set(['plan_create', 'plan_update', 'recent_memory_create', 'recent_memory_update']);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function reject(code: string): never { throw new Error(code); }
/** Metadata MUST be authenticated and authorized by the caller; this module does not authenticate it.
 * Queue writers must durably preserve the same business key/body and reconcile uncertain responses.
 */
export function createRabiLinkKnowledgeBridge(input: KnowledgeBridgeConfig, adapter: KnowledgeHttpAdapter) {
  const config = structuredClone(input);
  if (config.allowedRoles !== undefined && (!Array.isArray(config.allowedRoles) || config.allowedRoles.some(x => typeof x !== 'string' || !x.trim()))) reject('INVALID_KNOWLEDGE_POLICY');
  if (config.allowedTools !== undefined && !Array.isArray(config.allowedTools)) reject('INVALID_KNOWLEDGE_POLICY');
  if (config.allowWrites !== undefined && typeof config.allowWrites !== 'boolean') reject('INVALID_KNOWLEDGE_POLICY');
  const roles = new Set(config.allowedRoles || []), allowed = new Set(config.allowedTools || []);
  if (config.enabled === true) {
    if (typeof config.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(config.url)) reject('INVALID_KNOWLEDGE_URL');
    const url = new URL(config.url!);
    if (!url.port || Number(url.port) > 65535) reject('INVALID_KNOWLEDGE_URL');
    if (typeof config.token !== 'string' || config.token.length < 32) reject('INVALID_KNOWLEDGE_TOKEN');
    if (!roles.size || !allowed.size || [...allowed].some(name => !names.has(name))) reject('INVALID_KNOWLEDGE_POLICY');
  }
  return Object.freeze({ async execute(metadata: KnowledgeDeviceMetadata, value: unknown) {
    if (config.enabled !== true) reject('KNOWLEDGE_DISABLED');
    if (!plain(metadata) || (['appId','deviceBindingId','ownerAccountId','targetDeviceId'] as const).some(k => typeof metadata[k] !== 'string' || !(metadata[k] as string).trim())) reject('MISSING_TRUSTED_METADATA');
    if (!plain(value) || Object.keys(value).some(k => !['operation','name','args'].includes(k))) reject('INVALID_KNOWLEDGE_REQUEST');
    const request = structuredClone(value);
    if (request.operation === 'list') {
      if (request.name !== undefined || request.args !== undefined) reject('INVALID_KNOWLEDGE_REQUEST');
      const result = await adapter.request({url: config.url!, token: config.token!}, {operation: 'list'});
      if (!plain(result) || !Array.isArray(result.tools)) reject('INVALID_TOOL_CATALOG');
      return { tools: result.tools.filter(t => plain(t) && typeof t.name === 'string' && allowed.has(t.name) && (config.allowWrites === true || !writes.has(t.name))).map(t => {
        const tool = structuredClone(t) as Record<string, unknown>;
        // Server annotations are not authorization. Calls are revalidated locally.
        if (tool.name === 'memory_get' && config.allowWrites !== true && plain(tool.inputSchema) && plain(tool.inputSchema.properties)) {
          tool.inputSchema.properties.kind = { enum: ['consolidated'] }; delete tool.inputSchema.properties.idempotencyKey;
        }
        return tool;
      }) };
    }
    if (request.operation !== 'call' || typeof request.name !== 'string' || !allowed.has(request.name) || !names.has(request.name) || !plain(request.args)) reject('KNOWLEDGE_TOOL_DENIED');
    const name = request.name as string, args = request.args as Record<string, unknown>;
    adapter.validate(name, args); // Existing authoritative tool schema, no duplicated Manager implementation.
    if (typeof args.roleId !== 'string' || !roles.has(args.roleId)) reject('KNOWLEDGE_ROLE_DENIED');
    const mutation = writes.has(name) || (name === 'memory_get' && args.kind === 'recent');
    if (mutation && config.allowWrites !== true) reject('KNOWLEDGE_WRITE_DENIED');
    if (mutation && (typeof args.idempotencyKey !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(args.idempotencyKey))) reject('STABLE_BUSINESS_KEY_REQUIRED');
    try { return await adapter.request({url: config.url!, token: config.token!}, {operation: 'call', name, args}); }
    catch { return { ok: false, uncertain: mutation, code: mutation ? 'KNOWLEDGE_OUTCOME_UNCERTAIN' : 'KNOWLEDGE_TRANSPORT_FAILED' }; }
  } });
}
