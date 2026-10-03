import { definitions, validateKnowledgeArguments } from '../packages/rabi-knowledge-contract/schema.mjs';
import { knowledgeToolIsMutation } from '../packages/rabi-knowledge-contract/tools.mjs';

export const KNOWLEDGE_PATH = '/__rabilink/knowledge';
const fail = (statusCode, code) => { throw Object.assign(new Error(code), { statusCode, code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identity = value => typeof value === 'string' && !!value.trim();

/** Authentication is owned by the Relay credential lookup, never by request fields.
 * A bound member uses all knowledge operations provided by its application's selected PC.
 */
export function authorizeKnowledgeRequest(app, binding, worker, body) {
  if (!identity(app?.id) || !identity(app.ownerAccountId) || app.enabled === false
    || !identity(binding?.id) || !identity(binding.credentialHash) || binding.enabled === false
    || !app.deviceBindings?.some(member => member.id === binding.id && member.enabled !== false
      && member.credentialHash === binding.credentialHash)) fail(403, 'DEVICE_CREDENTIAL_REQUIRED');
  if (!identity(app.targetDeviceId) || !worker || worker.id !== app.targetDeviceId
    || worker.appId !== app.id) fail(409, 'EXPLICIT_KNOWLEDGE_PC_REQUIRED');
  if (!plain(body) || Object.keys(body).some(key => !['operation', 'name', 'args'].includes(key))
    || Buffer.byteLength(JSON.stringify(body)) > 65536) fail(400, 'INVALID_KNOWLEDGE_REQUEST');
  if (body.operation === 'list') {
    if (Object.keys(body).length !== 1) fail(400, 'INVALID_KNOWLEDGE_REQUEST');
  } else {
    if (body.operation !== 'call' || typeof body.name !== 'string' || !Object.hasOwn(definitions, body.name)
      || !plain(body.args)) fail(400, 'INVALID_KNOWLEDGE_REQUEST');
    try { validateKnowledgeArguments(body.name, body.args); }
    catch { fail(400, 'INVALID_KNOWLEDGE_ARGUMENTS'); }
  }
  const mutation = body.operation === 'call' && knowledgeToolIsMutation(body.name, body.args);
  if (mutation && (typeof body.args.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9:._-]{1,200}$/.test(body.args.idempotencyKey))) fail(400, 'STABLE_BUSINESS_KEY_REQUIRED');
  return {
    metadata: { appId: app.id, deviceBindingId: binding.id, ownerAccountId: app.ownerAccountId, targetDeviceId: worker.id },
    request: structuredClone(body), nonReplayable: mutation
  };
}

export function rejectReservedKnowledgePath(value) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(value, 'http://reserved.invalid').pathname).replaceAll('\\', '/').toLowerCase(); }
  catch { fail(400, 'INVALID_PROXY_PATH'); }
  if (pathname === KNOWLEDGE_PATH || pathname.startsWith(KNOWLEDGE_PATH + '/')) fail(403, 'RESERVED_KNOWLEDGE_PATH');
}
