import { isStrongEtag, stableKey, knowledgeReceipt } from './receipt.mjs';

import { definitions, validate } from './schema.mjs';
export { validateKnowledgeArguments } from './schema.mjs';
function segment(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\\/\u0000-\u0020\u007f%?#:]/.test(value) || value === '.' || value === '..') throw new TypeError('Invalid resource identifier.');
  return encodeURIComponent(value);
}
const descriptions = {
  knowledge_search: 'Search plan and memory summaries by keywords or full text. Follow returned cursors; an unavailable index is not an empty result.',
  plan_list: 'List bounded plan summaries for an allowed role. Follow the returned cursor to continue.',
  plan_get: 'Read one exact plan and its ETag before preparing an update.',
  plan_statuses: 'Read the current role-specific marker status catalog before choosing markerStatus.',
  memory_list: 'List bounded memory summaries without updating view timestamps.',
  memory_get: 'Read an exact consolidated memory. Recent details require write permission and a stable idempotencyKey because they update viewedAt.',
  plan_create: 'Create a plan using current activationStatus and markerStatus. Save a stable idempotencyKey before calling; never retry automatically after an uncertain result.',
  plan_update: 'Update a plan using its exact current strong ETag and a saved stable idempotencyKey. On 412 reread and confirm intent; on uncertainty preserve body and key.',
  recent_memory_create: 'Create one focused recent memory with keywords and a saved stable idempotencyKey. Uncertain results require authoritative readback, not a new create.',
  recent_memory_update: 'Update a recent memory with its exact strong ETag and a saved stable idempotencyKey; consolidated memory cannot be modified.'
};
const writes = new Set(['plan_create', 'plan_update', 'recent_memory_create', 'recent_memory_update']);
export function knowledgeToolIsMutation(name, args) {
  return writes.has(name) || (name === 'memory_get' && args?.kind === 'recent');
}
/** client must provide authenticated identity-fenced invoke and honor replaySafe:false. */
export function createKnowledgeTools({ client, allowedRoles, allowWrites = false } = {}) {
  if (typeof client?.invoke !== 'function' || !Array.isArray(allowedRoles) || typeof allowWrites !== 'boolean') throw new TypeError('A client and fixed allowedRoles are required.');
  allowedRoles.forEach(segment);
  const roles = new Set(allowedRoles);
  function list() {
    return Object.entries(definitions).filter(([name]) => allowWrites || !writes.has(name)).map(([name, definition]) => {
      const inputSchema = structuredClone(definition);
      if (name === 'memory_get' && !allowWrites) {
        inputSchema.properties.kind = { enum: ['consolidated'] };
        delete inputSchema.properties.idempotencyKey;
      }
      return { name, description: descriptions[name], inputSchema, readOnly: !writes.has(name) && (name !== 'memory_get' || !allowWrites) };
    });
  }
  async function call(name, args) {
    if (!Object.hasOwn(definitions, name)) throw new TypeError('Unknown knowledge operation.');
    validate(args, definitions[name]);
    // Clone validated values before awaiting a client, so callers cannot change the intent in flight.
    const a = structuredClone(args);
    if (!roles.has(a.roleId)) throw new Error('Role is not allowed.');
    // Writable Manager accepts an explicit touch key and echoes it with a revision.
    // A read-only Manager takes a pure-read branch without that receipt: deliberately
    // do not confirm it under this stricter stateful-read contract. Never replay GET.
    const touch = name === 'memory_get' && a.kind === 'recent';
    const mutation = writes.has(name) || touch;
    if (mutation && !allowWrites) throw new Error('Knowledge writes are disabled (recent memory detail also updates viewedAt).');
    const base = `/api/roles/${segment(a.roleId)}`;
    if (a.id !== undefined) segment(a.id);
    let method = 'GET', target, body;
    const options = { replaySafe: !mutation };
    const query = fields => {
      const values = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) values.set(key, String(value));
      return `?${values}`;
    };
    switch (name) {
      case 'knowledge_search': target = `${base}/knowledge/search${query({ query: a.query || '', mode: a.mode || 'keywords', kind: a.kind, archived: a.archived ? 1 : 0, limit: a.limit || 10, cursor: a.cursor })}`; break;
      case 'plan_list': target = `${base}/plans${query({ detail: 'summary', limit: a.limit || 20, query: a.query, cursor: a.cursor })}`; break;
      case 'plan_get': target = `${base}/plans/${segment(a.id)}`; break;
      case 'plan_statuses': target = `${base}/plan-marker-statuses`; break;
      case 'memory_list': target = `${base}/memory${query({ kind: a.kind, limit: a.limit || 20, query: a.query, cursor: a.cursor })}`; break;
      case 'memory_get': target = `${base}/memory/${a.kind}/${segment(a.id)}`; if (!touch && a.idempotencyKey !== undefined) throw new TypeError('Consolidated reads do not take a mutation key.'); break;
      default:
        body = a.body;
        if (!Object.keys(body).length) throw new TypeError('Empty patches are not allowed.');
        if (body.focus !== undefined && /[\r\n]/.test(body.focus)) throw new TypeError('focus must be a single line.');
        if (body.steps && new Set(body.steps.map(item => item.id)).size !== body.steps.length) throw new TypeError('Step IDs must be unique.');
        method = name.endsWith('_create') ? 'POST' : 'PATCH';
        target = `${base}/${name.startsWith('plan_') ? 'plans' : 'memory/recent'}${method === 'PATCH' ? `/${segment(a.id)}` : ''}`;
    }
    if (mutation) {
      stableKey(a.idempotencyKey);
      options.headers = { 'Idempotency-Key': a.idempotencyKey };
      if (method === 'PATCH') {
        if (!isStrongEtag(a.etag)) throw new TypeError('An exact strong ETag is required.');
        options.headers['If-Match'] = a.etag;
      }
    }
    if (body !== undefined) options.body = body;
    let receipt;
    try { receipt = await client.invoke(method, target, options); }
    catch { receipt = { statusCode: 0, ok: false, uncertain: mutation }; }
    return knowledgeReceipt(receipt, { mutation, idempotencyKey: mutation ? a.idempotencyKey : undefined, resourceId: a.id });
  }
  return Object.freeze({ list, call });
}
