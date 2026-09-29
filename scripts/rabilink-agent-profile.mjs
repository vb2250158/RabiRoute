import { createHash } from 'node:crypto';

export const PROFILE_LIMITS = Object.freeze({ id: 128, name: 128, systemPrompt: 8000, skills: 16, skillContent: 8000, skillTotal: 24000, mcp: 16, operations: 128 });
export class AgentProfileError extends Error {
  constructor(statusCode, code) { super(code); this.statusCode = statusCode; this.code = code; }
}
const fail = (status, code) => { throw new AgentProfileError(status, code); };
function object(v, fields, required = fields) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(400, 'INVALID_OBJECT');
  if (Object.keys(v).some(k => !fields.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail(400, 'INVALID_FIELDS');
}
function text(v, max, empty = false) {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()) || /\u0000/.test(v)) fail(400, 'INVALID_TEXT');
  return v;
}
function id(v) { text(v, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)) fail(400, 'INVALID_ID'); return v; }
function revision(v, zero = false) { if (!Number.isSafeInteger(v) || v < (zero ? 0 : 1)) fail(400, 'INVALID_REVISION'); return v; }
function enabled(v) { if (typeof v !== 'boolean') fail(400, 'INVALID_ENABLED'); return v; }
function list(v, max, parse) {
  if (!Array.isArray(v) || v.length > max) fail(400, 'INVALID_LIST');
  const items = v.map(parse); if (new Set(items.map(x => x.id)).size !== items.length) fail(400, 'DUPLICATE_ID'); return items;
}
/** IDs are references only. No URL, credential, command or runtime override is accepted. */
export function validateAgentProfile(value) {
  object(value, ['revision', 'id', 'name', 'systemPrompt', 'skills', 'mcp']);
  const skills = list(value.skills, 16, s => { object(s, ['id', 'title', 'content', 'enabled']); return { id: id(s.id), title: text(s.title, 128), content: text(s.content, 8000, true), enabled: enabled(s.enabled) }; });
  if (skills.reduce((n, s) => n + s.content.length, 0) > 24000) fail(400, 'SKILLS_TOO_LARGE');
  return { revision: revision(value.revision), id: id(value.id), name: text(value.name, 128), systemPrompt: text(value.systemPrompt, 8000, true), skills,
    mcp: list(value.mcp, 16, m => { object(m, ['id', 'label', 'enabled']); return { id: id(m.id), label: text(m.label, 128), enabled: enabled(m.enabled) }; }) };
}
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = v => structuredClone(v);
function key(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(v)) fail(400, 'INVALID_OPERATION_KEY'); return v; }
function sync(result) { if (result && typeof result.then === 'function') fail(500, 'SYNCHRONOUS_STORE_REQUIRED'); return result; }
/** Single-process synchronous transaction adapter. Inject Relay's existing app store, never another account table.
 * writeStore must atomically commit the full store or throw; integration owns durable storage and process exclusion.
 * Authentication principals below MUST be server-produced, not request-body objects.
 */
export function createAgentProfileService({ readStore, writeStore } = {}) {
  if (typeof readStore !== 'function' || typeof writeStore !== 'function') throw new TypeError('Store adapter required');
  function target(principal, appId, bindingId, management) {
    if (!principal || (management ? principal.kind !== 'account' : principal.kind !== 'device')) fail(403, 'PROFILE_FORBIDDEN');
    const store = clone(sync(readStore()));
    const app = store.apps?.find(a => a.id === appId && a.enabled !== false);
    if (!app || (management ? !principal.accountId || app.ownerAccountId !== principal.accountId : principal.appId !== app.id || principal.bindingId !== bindingId)) fail(404, 'DEVICE_NOT_FOUND');
    const binding = app.deviceBindings?.find(b => b.id === bindingId && b.enabled !== false);
    if (!binding || (!management && (!principal.credentialHash || principal.credentialHash !== binding.credentialHash))) fail(404, 'DEVICE_NOT_FOUND');
    return { store, binding };
  }
  function state(binding) {
    return binding.agentProfileState || { profile: null, applied: null, operations: [] };
  }
  function view(binding) {
    const s = state(binding);
    return clone({ profile: s.profile, applied: s.applied, savedRevision: s.profile?.revision || 0 });
  }
  function transact(principal, appId, bindingId, input, management) {
    object(input, management ? ['expectedRevision', 'idempotencyKey', 'profile'] : ['idempotencyKey', 'appliedRevision', 'status', 'errorCode'], management ? undefined : ['idempotencyKey', 'appliedRevision', 'status']);
    const operationKey = key(input.idempotencyKey);
    const { store, binding } = target(principal, appId, bindingId, management);
    const s = clone(state(binding));
    let payload;
    if (management) payload = { expectedRevision: revision(input.expectedRevision, true), profile: validateAgentProfile(input.profile) };
    else {
      if (!['applied', 'failed'].includes(input.status)) fail(400, 'INVALID_APPLY_STATUS');
      if (input.errorCode !== undefined && !['MODEL_UNAVAILABLE', 'PERSIST_FAILED', 'INVALID_PROFILE', 'TOOLS_UNAVAILABLE', 'APPLY_FAILED'].includes(input.errorCode)) fail(400, 'INVALID_ERROR_CODE');
      if ((input.status === 'failed') !== (input.errorCode !== undefined)) fail(400, 'INVALID_ERROR_CODE');
      payload = { appliedRevision: revision(input.appliedRevision), status: input.status, ...(input.errorCode ? { errorCode: input.errorCode } : {}) };
    }
    // A successful application is permanent for this revision, not a live health signal.
    if (!management && payload.status === 'failed' && s.applied?.status === 'applied' && s.applied.appliedRevision === payload.appliedRevision) fail(409, 'PROFILE_ALREADY_APPLIED');
    const intentHash = hash({ kind: management ? 'save' : 'apply', payload });
    const previous = s.operations.find(o => o.key === operationKey);
    if (previous) { if (previous.intentHash !== intentHash) fail(409, 'IDEMPOTENCY_CONFLICT'); return clone(previous.receipt); }
    if (s.operations.length >= PROFILE_LIMITS.operations) fail(409, 'PROFILE_RECEIPT_CAPACITY'); // Do not evict keys and accidentally reapply old intents.
    const saved = s.profile?.revision || 0;
    if (management) {
      if (payload.expectedRevision !== saved) fail(412, 'PROFILE_REVISION_CONFLICT');
      if (payload.profile.revision !== saved + 1) fail(400, 'PROFILE_REVISION_SEQUENCE');
      s.profile = payload.profile;
    } else {
      if (payload.appliedRevision > saved) fail(409, 'PROFILE_NOT_SAVED');
      if (payload.appliedRevision < (s.applied?.appliedRevision || 0)) fail(409, 'STALE_APPLY_RECEIPT');
      s.applied = payload;
    }
    const receipt = { idempotencyKey: operationKey, savedRevision: s.profile.revision, profile: clone(s.profile), applied: clone(s.applied) };
    s.operations.push({ key: operationKey, intentHash, receipt });
    binding.agentProfileState = s;
    sync(writeStore(store));
    return clone(receipt);
  }
  return Object.freeze({
    readForAccount(principal, appId, bindingId) { return view(target(principal, appId, bindingId, true).binding); },
    readOwn(principal) { return view(target(principal, principal?.appId, principal?.bindingId, false).binding); },
    readOperation(principal, appId, bindingId, operationKey) {
      const binding = target(principal, appId, bindingId, true).binding;
      const operation = state(binding).operations.find(item => item.key === key(operationKey));
      return { receipt: operation ? clone(operation.receipt) : null };
    },
    save(principal, appId, bindingId, input) { return transact(principal, appId, bindingId, input, true); },
    acknowledge(principal, input) { return transact(principal, principal?.appId, principal?.bindingId, input, false); }
  });
}
