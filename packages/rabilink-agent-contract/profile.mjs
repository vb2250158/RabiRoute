import { createHash } from 'node:crypto';

export const PROFILE_LIMITS = Object.freeze({ id: 128, name: 128, systemPrompt: 8000, skills: 16, skillContent: 8000, skillTotal: 24000, mcp: 16, operations: 128 });
export const PROFILE_ID_PATTERN = `^[A-Za-z0-9][A-Za-z0-9._-]{0,${PROFILE_LIMITS.id - 1}}$`;
export const PROFILE_OPERATION_ID_PATTERN = `^[A-Za-z0-9:._-]{1,${PROFILE_LIMITS.id}}$`;
export const PROFILE_APPLY_STATUSES = Object.freeze(['applied', 'failed']);
export const PROFILE_APPLY_ERRORS = Object.freeze(['MODEL_UNAVAILABLE', 'PERSIST_FAILED', 'INVALID_PROFILE', 'TOOLS_UNAVAILABLE', 'APPLY_FAILED']);
const profileIdPattern = new RegExp(PROFILE_ID_PATTERN), operationIdPattern = new RegExp(PROFILE_OPERATION_ID_PATTERN);
const freezeSchema = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeSchema); return Object.freeze(value);
};
const stringSchema = (limit, empty = false) => ({ type: 'string', maxLength: limit, not: { pattern: '\\u0000' },
  ...(empty ? {} : { minLength: 1, pattern: '\\S' }), description: `Native validation counts at most ${limit} UTF-16 code units; JSON Schema maxLength is only a necessary code-point bound. Values are preserved without trimming.` });
const profileIdSchema = { type: 'string', pattern: PROFILE_ID_PATTERN };
const operationIdSchema = { type: 'string', pattern: PROFILE_OPERATION_ID_PATTERN };
const positiveRevisionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const zeroRevisionSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const personaRefSchema = { type: 'object', required: ['roleId', 'sourceDeviceId'], additionalProperties: false, properties: { roleId: profileIdSchema, sourceDeviceId: profileIdSchema } };
const skillSchema = { type: 'object', required: ['id', 'title', 'content', 'enabled'], additionalProperties: false,
  properties: { id: profileIdSchema, title: stringSchema(PROFILE_LIMITS.name), content: stringSchema(PROFILE_LIMITS.skillContent, true), enabled: { type: 'boolean' } } };
const mcpSchema = { type: 'object', required: ['id', 'label', 'enabled'], additionalProperties: false,
  properties: { id: profileIdSchema, label: stringSchema(PROFILE_LIMITS.name), enabled: { type: 'boolean' } } };
const profileSchema = { type: 'object', required: ['revision', 'id', 'name', 'systemPrompt', 'skills', 'mcp'], additionalProperties: false, properties: {
  revision: positiveRevisionSchema, id: profileIdSchema, name: stringSchema(PROFILE_LIMITS.name), systemPrompt: stringSchema(PROFILE_LIMITS.systemPrompt, true),
  skills: { type: 'array', maxItems: PROFILE_LIMITS.skills, items: skillSchema, description: `Unique native IDs and at most ${PROFILE_LIMITS.skillTotal} total UTF-16 content units are checked by the owner.` },
  mcp: { type: 'array', maxItems: PROFILE_LIMITS.mcp, items: mcpSchema, description: 'Unique native IDs; references only, with no URL, credential or command fields.' },
  personaRef: { anyOf: [personaRefSchema, { type: 'null' }] }
} };
const applyProperties = { appliedRevision: positiveRevisionSchema, status: { enum: PROFILE_APPLY_STATUSES }, errorCode: { enum: PROFILE_APPLY_ERRORS } };
const applyCondition = [
  { properties: { status: { const: 'applied' }, errorCode: false } },
  { properties: { status: { const: 'failed' }, errorCode: { enum: PROFILE_APPLY_ERRORS } }, required: ['errorCode'] }
];
const appliedSchema = { type: 'object', required: ['appliedRevision', 'status'], additionalProperties: false, properties: applyProperties, oneOf: applyCondition };
const nullableProfile = { anyOf: [profileSchema, { type: 'null' }] }, nullableApplied = { anyOf: [appliedSchema, { type: 'null' }] };
const receiptSchema = { type: 'object', required: ['idempotencyKey', 'savedRevision', 'profile', 'applied'], additionalProperties: false,
  properties: { idempotencyKey: operationIdSchema, savedRevision: positiveRevisionSchema, profile: profileSchema, applied: nullableApplied } };
export const PROFILE_SCHEMAS = freezeSchema({
  profile: profileSchema, personaRef: personaRefSchema, applied: appliedSchema,
  saveRequest: { type: 'object', required: ['expectedRevision', 'idempotencyKey', 'profile'], additionalProperties: false,
    properties: { expectedRevision: zeroRevisionSchema, idempotencyKey: operationIdSchema, profile: profileSchema } },
  applyRequest: { type: 'object', required: ['idempotencyKey', 'appliedRevision', 'status'], additionalProperties: false,
    properties: { idempotencyKey: operationIdSchema, ...applyProperties }, oneOf: applyCondition },
  view: { type: 'object', required: ['profile', 'applied', 'savedRevision'], additionalProperties: false, properties: { profile: nullableProfile, applied: nullableApplied, savedRevision: zeroRevisionSchema } },
  receipt: receiptSchema,
  operationView: { type: 'object', required: ['receipt'], additionalProperties: false, properties: { receipt: { anyOf: [receiptSchema, { type: 'null' }] } } }
});

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
function id(v) { text(v, PROFILE_LIMITS.id); if (!profileIdPattern.test(v)) fail(400, 'INVALID_ID'); return v; }
function revision(v, zero = false) { if (!Number.isSafeInteger(v) || v < (zero ? 0 : 1)) fail(400, 'INVALID_REVISION'); return v; }
function enabled(v) { if (typeof v !== 'boolean') fail(400, 'INVALID_ENABLED'); return v; }
function list(v, max, parse) {
  if (!Array.isArray(v) || v.length > max) fail(400, 'INVALID_LIST');
  const items = v.map(parse); if (new Set(items.map(x => x.id)).size !== items.length) fail(400, 'DUPLICATE_ID'); return items;
}
/** IDs are references only. No URL, credential, command or runtime override is accepted. */
export function validateAgentProfile(value) {
  object(value, Object.keys(PROFILE_SCHEMAS.profile.properties), PROFILE_SCHEMAS.profile.required);
  if (value.personaRef !== undefined && value.personaRef !== null) {
    object(value.personaRef, Object.keys(personaRefSchema.properties)); id(value.personaRef.roleId); id(value.personaRef.sourceDeviceId);
  }
  const skills = list(value.skills, PROFILE_LIMITS.skills, s => { object(s, Object.keys(skillSchema.properties)); return { id: id(s.id), title: text(s.title, PROFILE_LIMITS.name), content: text(s.content, PROFILE_LIMITS.skillContent, true), enabled: enabled(s.enabled) }; });
  if (skills.reduce((n, s) => n + s.content.length, 0) > PROFILE_LIMITS.skillTotal) fail(400, 'SKILLS_TOO_LARGE');
  return { revision: revision(value.revision), id: id(value.id), name: text(value.name, PROFILE_LIMITS.name), systemPrompt: text(value.systemPrompt, PROFILE_LIMITS.systemPrompt, true), skills,
    mcp: list(value.mcp, PROFILE_LIMITS.mcp, m => { object(m, Object.keys(mcpSchema.properties)); return { id: id(m.id), label: text(m.label, PROFILE_LIMITS.name), enabled: enabled(m.enabled) }; }),
    ...(value.personaRef === undefined ? {} : { personaRef: value.personaRef === null ? null : { roleId: value.personaRef.roleId, sourceDeviceId: value.personaRef.sourceDeviceId } }) };
}
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = v => structuredClone(v);
function key(v) { if (typeof v !== 'string' || !operationIdPattern.test(v)) fail(400, 'INVALID_OPERATION_KEY'); return v; }
function sync(result) { if (result && typeof result.then === 'function') fail(500, 'SYNCHRONOUS_STORE_REQUIRED'); return result; }
/** Single-process synchronous transaction adapter. Inject the authenticated owner's device store.
 * writeStore must atomically commit the full store or throw; integration owns durable storage and process exclusion.
 * Authentication principals below MUST be server-produced, not request-body objects.
 */
export function createAgentProfileService({ readStore, writeStore } = {}) {
  if (typeof readStore !== 'function' || typeof writeStore !== 'function') throw new TypeError('Store adapter required');
  function target(principal, appId, bindingId, management) {
    if (!principal || (management ? !['account', 'application'].includes(principal.kind) : principal.kind !== 'device')) fail(403, 'PROFILE_FORBIDDEN');
    const store = clone(sync(readStore()));
    const app = store.apps?.find(a => a.id === appId && a.enabled !== false);
    if (!app || (management ? principal.kind === 'application' ? principal.appId !== app.id : !principal.accountId || app.ownerAccountId !== principal.accountId : principal.appId !== app.id || principal.bindingId !== bindingId)) fail(404, 'DEVICE_NOT_FOUND');
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
    const shape = management ? PROFILE_SCHEMAS.saveRequest : PROFILE_SCHEMAS.applyRequest;
    object(input, Object.keys(shape.properties), shape.required);
    const operationKey = key(input.idempotencyKey);
    const { store, binding } = target(principal, appId, bindingId, management);
    const s = clone(state(binding));
    let payload;
    if (management) payload = { expectedRevision: revision(input.expectedRevision, true), profile: validateAgentProfile(input.profile) };
    else {
      if (!PROFILE_APPLY_STATUSES.includes(input.status)) fail(400, 'INVALID_APPLY_STATUS');
      if (input.errorCode !== undefined && !PROFILE_APPLY_ERRORS.includes(input.errorCode)) fail(400, 'INVALID_ERROR_CODE');
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
    readForApplication(principal, bindingId) { if (principal?.kind !== 'application') fail(403, 'PROFILE_FORBIDDEN'); return view(target(principal, principal.appId, bindingId, true).binding); },
    saveForApplication(principal, bindingId, input) { if (principal?.kind !== 'application') fail(403, 'PROFILE_FORBIDDEN'); return transact(principal, principal.appId, bindingId, input, true); },
    readOperationForApplication(principal, bindingId, operationKey) {
      if (principal?.kind !== 'application') fail(403, 'PROFILE_FORBIDDEN');
      const binding = target(principal, principal.appId, bindingId, true).binding;
      const operation = state(binding).operations.find(item => item.key === key(operationKey));
      return { receipt: operation ? clone(operation.receipt) : null };
    },
    acknowledge(principal, input) { return transact(principal, principal?.appId, principal?.bindingId, input, false); }
  });
}
