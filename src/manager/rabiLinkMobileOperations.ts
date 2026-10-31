import { MOBILE_OWNER_LIMITS, MOBILE_OPERATION_KEY_PATTERN, type RabiLinkMobileOwner, type RabiLinkPreparedMobile } from './rabiLinkMobileOwner.js';
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from './apiOperationContract.js';

const empty = { type: 'object', additionalProperties: false }, ignored = { type: 'object' };
import { object, proof, asr, status } from "./rabiLinkMobileContract.js";
const string = { type: "string" };
const failure = { mediaType: 'application/json', schema: object({ code: string, ok: { const: false }, uncertain: { const: true } }, ['code', 'ok']) };
const headers = { 'cache-control': 'no-store' };
function failed(cause: unknown): ApiOperationResult {
  const error = cause as { code?: string; statusCode?: number; uncertain?: boolean } | null;
  return { status: error?.statusCode || 500, headers, body: { code: error?.code || 'MOBILE_OWNER_FAILED', ok: false, ...(error?.uncertain ? { uncertain: true } : {}) } };
}

/** The same declarations install all seven native routes and publish their actual DTOs. */
export function createRabiLinkMobileOperations(currentOwner: () => RabiLinkMobileOwner): readonly ApiOperationDefinition[] {
  const define = (suffix: string, method: ApiOperationContract['method'], path: string, response: ApiSchema,
    execute: (owner: RabiLinkPreparedMobile, input: ApiOperationInput) => Promise<unknown>, body?: ApiSchema): ApiOperationDefinition => {
    const write = body !== undefined;
    const bind = (input: Omit<ApiOperationInput, 'body'>) => {
      try {
        const owner = currentOwner().prepare(input.request, input.signal);
        return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
          try { return { status: 200, headers, body: await execute(owner, parsed) }; } catch (cause) { return failed(cause); }
        };
      } catch (cause) { return failed(cause); }
    };
    return { contract: { operationId: 'manager.rabilink.' + suffix, contractVersion: '1.0.0', exposure: 'public', transport: 'http', method, pathTemplate: path,
      description: 'Read or update the existing PC-owned mobile state. Configuration, device-reported status and submitted proof are distinct from physical-device acceptance.',
      request: { path: empty, query: ignored, headers: write ? { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', pattern: MOBILE_OPERATION_KEY_PATTERN } } } : ignored,
        body: write ? { kind: 'json', schema: body!, maxBytes: 0, allowAnyContentType: true, ...(body === true ? { emptyValue: {} } : {}) } : { kind: 'none', allowIgnoredBody: true } },
      responses: { '200': { mediaType: 'application/json', schema: response }, ...Object.fromEntries([400, 401, 409, 500, 503].map(code => [String(code), failure])) },
      effects: { mode: write ? 'durable-mobile-transaction' : 'read', description: write
        ? 'The original scoped PC store atomically saves the native value and stable receipt. It never starts an ASR worker, executes an Agent prompt or verifies a physical device.'
        : 'Read the current native PC state or worker observations without changing selection or device settings.' },
      recovery: { strategy: write ? 'native-idempotency-replay' : 'repeatable-read', idempotencyHeader: 'Idempotency-Key', description:
        'Retain the original connection scope, request body and Idempotency-Key. Identical action/body replays the native receipt; changed intent conflicts. ASR replay retains the saved priority with current workers; status replay retains receivedAt and recalculates age; proof replay retains the original UUID. A missing current value cannot prove an uncertain request never ran.' },
      validators: [{ id: 'original-mobile-owner', description: 'Retain the original connection, source device and PC generation before decoding the body. Recheck after owner/peer reads and before persistence or disclosure. Already authenticated enabled connections need no additional capability grant.' },
        { id: 'native-mobile-state', description: `Native rules own ${MOBILE_OWNER_LIMITS.priority} unique ASR worker IDs, ${MOBILE_OWNER_LIMITS.operations} non-evicting operation receipts and ${MOBILE_OWNER_LIMITS.proofs} proofs. Battery aliases use original Number coercion and rounding. Proof aliases and truncation are native; unknown body fields are ignored but remain part of the fingerprint. Proof limit uses Number/default 20/clamp 1..100 and fractional Array.slice semantics. Native JSON decoding has no application byte cap.` }]
    }, prepare: bind, handler: input => { const prepared = bind(input); return typeof prepared === 'function' ? prepared(input) : prepared; } };
  };
  const base = '/api/rabilink/mobile/';
  return [
    define('mobile.asr-settings.read', 'GET', base + 'asr-settings', asr, owner => owner.readAsr()),
    define('mobile.asr-settings.save', 'PATCH', base + 'asr-settings', asr, (owner, input) => owner.saveAsr(input.body), { type: 'object', required: ['priority'], properties: { priority: { type: 'array', maxItems: MOBILE_OWNER_LIMITS.priority, uniqueItems: true, items: string } } }),
    define('mobile.device-status.read', 'GET', base + 'device-status', status, owner => owner.readDeviceStatus()),
    define('mobile.device-status.record', 'POST', base + 'device-status', status, (owner, input) => owner.saveDeviceStatus(input.body), true),
    define('mobile.proof.record', 'POST', base + 'proof', object({ code: { const: 0 }, ok: { const: true }, proof }), (owner, input) => owner.recordProof(input.body), true),
    define('mobile.proofs.list', 'GET', base + 'proofs', object({ code: { const: 0 }, ok: { const: true }, proofs: { type: 'array', maxItems: MOBILE_OWNER_LIMITS.proofPage, items: proof }, invalidRecords: { type: 'integer', minimum: 0 } }), (owner, input) => owner.listProofs(input.url.searchParams.get('limit'))),
    define('devices.health-capabilities.read', 'GET', '/api/rabilink/devices/health-capabilities', object({ rabilinkWearableObservation: object({ processingPolicies: { const: ['transcribe', 'agent'] }, expectedWorkerFencing: { const: true }, processingPolicyFrozen: { const: true } }) }), owner => owner.healthCapabilities())
  ];
}
