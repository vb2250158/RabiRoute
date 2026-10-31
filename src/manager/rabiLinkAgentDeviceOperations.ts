import { PROFILE_ID_PATTERN, PROFILE_OPERATION_ID_PATTERN, PROFILE_LIMITS, PROFILE_SCHEMAS } from '../../packages/rabilink-agent-contract/profile.mjs';
import { PROFILE_DEVICE_ID_PATTERN, type RabiLinkAgentDevices, type RabiLinkPreparedProfiles } from './rabiLinkAgentDevices.js';
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from './apiOperationContract.js';

const ignored = { type: 'object' }, empty = { type: 'object', additionalProperties: false };
const device = { type: 'string', pattern: PROFILE_DEVICE_ID_PATTERN };
const response = (schema: ApiSchema) => ({ mediaType: 'application/json', schema: { type: 'object', required: ['code', 'data'], additionalProperties: false, properties: { code: { const: 0 }, data: schema } } });
const failure = { mediaType: 'application/json', schema: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string' }, uncertain: { const: true } } } };
const headers = { 'cache-control': 'no-store' };
function failed(cause: unknown): ApiOperationResult {
  const value = cause as { statusCode?: number; code?: string; uncertain?: boolean } | null;
  return { status: value?.statusCode || 500, headers, body: { code: value?.code || 'PROFILE_REQUEST_FAILED', ...(value?.uncertain ? { uncertain: true } : {}) } };
}
const pathSchema = (operation = false) => ({ type: 'object', required: operation ? ['deviceId', 'operationId'] : ['deviceId'], additionalProperties: false, properties: { deviceId: device, ...(operation ? { operationId: { type: 'string', pattern: PROFILE_OPERATION_ID_PATTERN } } : {}) } });
const templateSchema = { type: 'object', required: ['roleId'], additionalProperties: false, properties: { roleId: { type: 'string', pattern: PROFILE_ID_PATTERN },
  skillIds: { anyOf: [{ type: 'array', maxItems: PROFILE_LIMITS.skills, uniqueItems: true, items: { type: 'string', pattern: PROFILE_ID_PATTERN } }, { enum: [null, false, 0, ''] }] } } };
const directorySchema = { type: 'object', required: ['devices', 'sourceDeviceId'], additionalProperties: false, properties: { coverage: { type: 'object', required: ['invalidDeviceIds'], additionalProperties: false, properties: { invalidDeviceIds: { type: 'array', items: { type: 'string' } } } }, sourceDeviceId: { type: 'string' }, devices: { type: 'array', items: {
  type: 'object', required: ['id', 'profile', 'applied', 'savedRevision', 'historyPersonas'], additionalProperties: false, properties: { id: device, profile: PROFILE_SCHEMAS.profile,
    applied: { anyOf: [PROFILE_SCHEMAS.applied, { type: 'null' }] }, savedRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    historyPersonas: { type: 'array', items: { type: 'object', required: ['roleId', 'sourceDeviceId', 'name'], additionalProperties: false, properties: {
      roleId: { type: 'string', pattern: PROFILE_ID_PATTERN }, sourceDeviceId: { type: 'string', pattern: PROFILE_ID_PATTERN }, name: { type: 'string' } } } } }
} } } };

/** Definitions install HTTP paths and discovery records together, including persona-template. */
export function createRabiLinkAgentDeviceOperations(currentOwner: () => RabiLinkAgentDevices): readonly ApiOperationDefinition[] {
  const define = (suffix: string, method: ApiOperationContract['method'], pathname: string, path: ApiSchema, body: ApiSchema | undefined,
    data: ApiSchema, execute: (owner: RabiLinkPreparedProfiles, input: ApiOperationInput) => Promise<unknown>, write = false): ApiOperationDefinition => {
    const bind = (input: Omit<ApiOperationInput, 'body'>) => {
      try {
        const prepared = currentOwner().prepare(input.request, input.signal);
        return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
          try { return { status: 200, headers, body: { code: 0, data: await execute(prepared, parsed) } }; } catch (cause) { return failed(cause); }
        };
      } catch (cause) { return failed(cause); }
    };
    return { contract: { operationId: 'manager.rabilink.' + suffix, contractVersion: '1.0.0', method, pathTemplate: pathname, exposure: 'public', transport: 'http',
      description: `PC-owned device Agent profile ${suffix}. Saved configuration and device application acknowledgement are separate facts; no Agent prompt is executed.`,
      request: { path, query: ignored, headers: ignored, body: body ? { kind: 'json', schema: body, maxBytes: 0, allowAnyContentType: true } : { kind: 'none' } },
      responses: { '200': response(data), ...Object.fromEntries([400, 401, 403, 404, 409, 412, 500, 503].map(status => [String(status), failure])) },
      effects: { mode: write ? 'durable-profile-transaction' : 'read', description: write
        ? 'The original scoped PC store atomically saves a complete CAS revision or signed-device acknowledgement and its stable idempotency receipt. No host runtime, model or tool is created.'
        : 'Read the original PC owner, persona source or durable receipt. Template generation reads current persona and selected Skills; it does not save or apply a device profile.' },
      recovery: { strategy: write ? 'native-profile-receipt' : 'repeatable-read', receiptPath: '/api/rabilink/agent-devices/:deviceId/profile/operations/:operationId',
        description: 'Preserve deviceId and body idempotencyKey. Read the original operation receipt before retrying an uncertain write; absent receipt is returned as receipt=null and does not prove the request never ran. Same key/intent replays the native receipt; different intent conflicts. Ordinary reads may be repeated.' },
      validators: [{ id: 'original-profile-owner', description: 'Capture original connection scope, source device, application generation and PC assignment before body parsing; revalidate after awaited reads and before writes/disclosure. Any authenticated enabled connection may manage profiles; only the signed originating device may acknowledge its own application. This is receipt provenance, not a feature grant.' },
        { id: 'native-profile-state', description: `Shared schema and original validator own UTF-16 limits, unique Skill/MCP IDs, total Skill content, CAS sequence, idempotency conflicts, ${PROFILE_LIMITS.operations}-receipt capacity, persona existence and monotonic application status. JSON retains the native absence of an application byte cap. Unknown query/header fields are ignored.` }]
    }, prepare: bind, handler: async input => { const prepared = bind(input); return typeof prepared === 'function' ? prepared(input) : prepared; } };
  };
  const base = '/api/rabilink/agent-devices/:deviceId/profile';
  return [
    define('agent-devices.list', 'GET', '/api/rabilink/agent-devices', empty, undefined, directorySchema, owner => owner.list()),
    define('agent-devices.profile.read', 'GET', base, pathSchema(), undefined, { ...(PROFILE_SCHEMAS.view as Record<string, unknown>), properties: { ...(PROFILE_SCHEMAS.view as { properties: Record<string, unknown> }).properties, timeoutOverrides: { type: 'object', additionalProperties: { type: 'integer', minimum: 1, maximum: 2147483647 } } } }, (owner, input) => owner.read(input.path.deviceId)),
    define('agent-devices.profile.save', 'PUT', base, pathSchema(), PROFILE_SCHEMAS.saveRequest, PROFILE_SCHEMAS.receipt, (owner, input) => owner.save(input.path.deviceId, input.body), true),
    define('agent-devices.profile.receipt.record', 'POST', base + '/receipt', pathSchema(), PROFILE_SCHEMAS.applyRequest, PROFILE_SCHEMAS.receipt, (owner, input) => owner.acknowledge(input.path.deviceId, input.body), true),
    define('agent-devices.profile.operation.read', 'GET', base + '/operations/:operationId', pathSchema(true), undefined, PROFILE_SCHEMAS.operationView, (owner, input) => owner.operation(input.path.deviceId, input.path.operationId)),
    define('persona-template.read', 'POST', '/api/rabilink/persona-template', empty, templateSchema, { type: 'object', required: ['profile'], additionalProperties: false, properties: { profile: PROFILE_SCHEMAS.profile } }, (owner, input) => owner.template(input.body))
  ];
}
