import { DEVICE_AGENT_ID_PATTERN, DEVICE_AGENT_LIMITS, type DeviceAgentAction, type DeviceAgentOwner } from './deviceAgentOwner.js';
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from '../manager/apiOperationContract.js';

const text = { type: 'string' }, empty = { type: 'object', additionalProperties: false }, ignored = { type: 'object' };
const identifier = { type: 'string', pattern: DEVICE_AGENT_ID_PATTERN, not: { enum: ['__proto__', 'constructor', 'prototype'] } };
const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties), additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties });
const nullable = (schema: ApiSchema) => ({ anyOf: [schema, { type: 'null' }] });
const session = object({ sessionId: identifier, name: { type: 'string', minLength: 1, maxLength: DEVICE_AGENT_LIMITS.sessionName }, ownerEpoch: text, managerEpoch: text, loaded: { type: 'boolean' }, expiresAt: { type: 'number' }, capabilities: { type: 'array', maxItems: DEVICE_AGENT_LIMITS.capabilities, uniqueItems: true, items: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.capabilityText } } });
const receipt = object({ deliveryId: identifier, status: { enum: ['queued', 'claimed', 'completed', 'failed', 'result-unknown'] }, sessionId: nullable(identifier), ownerEpoch: nullable(text), ownerAccepted: { type: 'boolean' },
  response: nullable(object({ status: text, text: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.response }, errorCode: text }, ['status', 'text'])), wake: object({ status: { enum: ['pending', 'claimed', 'submitted', 'failed'] }, errorCode: nullable(text) }) });
const source = { type: 'object', required: ['type'], properties: { type: { enum: ['agent', 'agent_hook', 'plan', 'message_adapter', 'system'] }, agentAdapter: text, agentType: text, sessionName: text, sessionId: text, workspace: text,
  planName: text, planId: text, sourceAgent: { type: 'object' }, messageAdapter: text, conversationType: text, conversationName: text, conversationId: text, senderName: text, senderId: text, messageId: text, messageGroupId: text,
  eventType: text, eventName: text, eventId: text, actorType: text, actorName: text, actorId: text, routeName: text, routeId: text } };
const blocks = { type: 'array', maxItems: DEVICE_AGENT_LIMITS.blocks, items: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.message } };
const envelope = object({ deliveryId: identifier, messageSource: source, messageContent: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.message }, contextBlocks: blocks, controlBlocks: blocks, escapeMessageContentHeaders: true, sentAt: text }, ['deliveryId', 'messageSource', 'messageContent'], true);
const endpoint = object({ kind: { enum: ['local', 'instance', 'device', 'service'] }, managerInstanceId: text, instanceId: text, nodeId: text, agentId: text, provider: text, sessionId: text, authorizationIncarnation: text }, ['kind', 'managerInstanceId', 'agentId', 'provider', 'sessionId', 'authorizationIncarnation'], true);
const party = { type: 'object', properties: { threadId: text, threadName: text, agentAdapter: text, agentType: text, endpoint } };
const prepared = object({ ledgerOwnerDeviceId: identifier, delivery: object({ deliveryId: identifier, generation: text, source: endpoint, target: endpoint,
  prompt: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.prompt }, promptHash: text, executionOptionsHash: text, executionOptions: { type: 'object' },
  preparation: object({ deliveryId: text, requestId: text, inReplyToRequestId: text, responsePolicy: text, responseInstruction: text, result: text, nextAction: text, source: party, target: party,
    messageProcessingRequirementId: text, planId: text }, ['deliveryId', 'responsePolicy', 'source', 'target'], true),
  state: { enum: ['dispatching', 'committed'] }, callerDeliveryId: text, requestHash: text, receipt: { type: 'object' } }, ['deliveryId', 'generation', 'source', 'target', 'prompt', 'promptHash', 'executionOptionsHash', 'executionOptions', 'preparation', 'state'], true) }, undefined, true);
const preparedReceipt = object({ deliveryId: text, generation: text, endpoint, promptHash: text, executionOptionsHash: text, accepted: { const: true }, action: { const: 'claimed' }, transport: { const: 'device-mailbox' } });
const sessionClaim = object({ sessionId: identifier, ownerEpoch: text }, undefined, true);
const failure = { mediaType: 'application/json', schema: object({ code: text, message: text, uncertain: { const: true } }, ['code', 'message']) };
const headers = { 'cache-control': 'no-store' };
function failed(cause: unknown): ApiOperationResult {
  const error = cause as { statusCode?: number; code?: string; uncertain?: boolean } | null;
  const code = error?.code || 'DEVICE_AGENT_INTERNAL_ERROR';
  return { status: error?.statusCode || 500, headers, body: { code, message: code, ...(error?.uncertain ? { uncertain: true } : {}) } };
}

type Definition = { action: DeviceAgentAction; id: string; method: 'GET' | 'PUT' | 'POST'; suffix: string; response: ApiSchema; body?: ApiSchema; accepted?: boolean };
/** Owns HTTP paths, discovery and structural validation; the native device owner executes business actions. */
export function createDeviceAgentOperations(currentOwner: () => DeviceAgentOwner): readonly ApiOperationDefinition[] {
  const definitions: Definition[] = [
    { action: 'directory', id: 'list', method: 'GET', suffix: '', response: object({ ownerInstanceId: text, recordIssues: {type:'array',items:object({agentId:text,code:text})}, agents: { type: 'array', items: { type: 'object', required: ['agentId', 'name', 'provider', 'enabled', 'model', 'loaded', 'capabilities', 'ownerInstanceId'], properties: { agentId: identifier, name: text, provider: { const: 'deviceAgent' }, enabled: { const: true }, model: { const: 'device-host' }, sessionId: text, configRevision: text, loaded: { type: 'boolean' }, capabilities: { type: 'array', items: text }, ownerInstanceId: text } } } }) },
    { action: 'sessionRead', id: 'session.read', method: 'GET', suffix: '/:agentId/session', response: object({ ownerInstanceId: text, authorizationIncarnation: nullable(text), session: nullable(session) }) },
    { action: 'sessionPublish', id: 'session.publish', method: 'PUT', suffix: '/:agentId/session', body: object({ sessionId: identifier, name: true, loaded: { type: 'boolean' }, ownerEpoch: true, capabilities: { type: 'array', items: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.capabilityText } } }, ['sessionId', 'name', 'loaded', 'capabilities'], true), response: object({ session }) },
    { action: 'pending', id: 'pending.read', method: 'GET', suffix: '/:agentId/pending', response: object({ pending: { type: 'boolean' } }) },
    { action: 'deliveryEnqueue', id: 'deliveries.enqueue', method: 'POST', suffix: '/:agentId/deliveries', body: object({ deliveryId: identifier, envelope }, undefined, true), response: object({ receipt }), accepted: true },
    { action: 'wakeList', id: 'wake-requests.list', method: 'GET', suffix: '/:agentId/wake-requests', response: object({ requests: { type: 'array', items: object({ agentId: identifier, nonce: text, deliveryId: identifier }) } }) },
    { action: 'wakeClaim', id: 'wake-requests.claim', method: 'POST', suffix: '/:agentId/wake-requests/:nonce/claim', body: true, response: object({ nonce: text, claimToken: text }) },
    { action: 'wakeReceipt', id: 'wake-requests.receipt.record', method: 'POST', suffix: '/:agentId/wake-requests/:nonce/receipt', body: object({ claimToken: text, status: { enum: ['submitted', 'failed'] }, errorCode: true }, ['claimToken', 'status'], true), response: object({ receipt }) },
    { action: 'deliveryClaim', id: 'deliveries.claim', method: 'POST', suffix: '/:agentId/deliveries/claim', body: sessionClaim, response: object({ delivery: nullable(object({ deliveryId: identifier, prompt: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.prompt }, envelope, sessionId: identifier, ownerEpoch: text, claimToken: text, ledgerOwnerDeviceId: identifier }, ['deliveryId', 'prompt', 'envelope', 'sessionId', 'ownerEpoch', 'claimToken'])), activeReceipt: receipt, cancelledReceipt: receipt }, ['delivery']) },
    { action: 'deliveryRead', id: 'deliveries.receipt.read', method: 'GET', suffix: '/:agentId/deliveries/:deliveryId', response: object({ receipt: nullable(receipt) }) },
    { action: 'deliveryResponse', id: 'deliveries.response.record', method: 'POST', suffix: '/:agentId/deliveries/:deliveryId/response', body: object({ sessionId: identifier, ownerEpoch: text, claimToken: text, status: { enum: ['completed', 'failed', 'result-unknown'] }, text: { type: 'string', maxLength: DEVICE_AGENT_LIMITS.response }, errorCode: true }, ['sessionId', 'ownerEpoch', 'claimToken', 'status', 'text'], true), response: object({ receipt }) },
    { action: 'preparedEnqueue', id: 'prepared-deliveries.enqueue', method: 'POST', suffix: '/:agentId/prepared-deliveries', body: prepared, response: object({ receipt: nullable(preparedReceipt) }), accepted: true },
    { action: 'preparedReconcile', id: 'prepared-deliveries.reconcile', method: 'POST', suffix: '/:agentId/prepared-deliveries/reconcile', body: prepared, response: object({ receipt: nullable(preparedReceipt) }), accepted: true }
  ];
  return definitions.map(definition => {
    const pathTemplate = '/api/device-agents' + definition.suffix;
    const properties = Object.fromEntries([...definition.suffix.matchAll(/:([A-Za-z]+)/g)].map(match => [match[1], match[1] === 'agentId' ? identifier : text]));
    const write = definition.body !== undefined;
    const bind = async (input: Omit<ApiOperationInput, 'body'>) => {
      try {
        const owner = await currentOwner().prepare(input.request, definition.action, input.path.agentId, input.signal);
        return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
          try { const result = await owner.execute(parsed.body, { nonce: parsed.path.nonce, deliveryId: parsed.path.deliveryId, waitMs: parsed.url.searchParams.get('waitMs') });
            return { status: result.status, headers, body: { code: 0, data: result.data } }; } catch (cause) { return failed(cause); }
        };
      } catch (cause) { return failed(cause); }
    };
    const success = { mediaType: 'application/json', schema: object({ code: { const: 0 }, data: definition.response }) };
    return { contract: { operationId: 'manager.device-agents.' + definition.id, aliases: ['device-agent:' + definition.method + ':' + pathTemplate], contractVersion: '1.0.0', exposure: 'public', transport: 'http', method: definition.method, pathTemplate,
      description: 'Discover the original PC-owned device mailbox, publish the native loaded session, or reconcile a stable delivery. Only that device host executes prompts; HTTP acceptance does not prove an answer.',
      request: { path: Object.keys(properties).length ? object(properties) : empty, query: ignored, headers: ignored, body: write ? { kind: 'json', schema: definition.body!, maxBytes: 0, allowAnyContentType: true,
        ...(definition.body === true ? { emptyValue: {} } : {}) } : { kind: 'none', allowIgnoredBody: true } },
      responses: { '200': success, ...(definition.accepted ? { '202': success } : {}), ...Object.fromEntries([400, 401, 403, 404, 409, 413, 500, 503].map(status => [String(status), failure])) },
      effects: { mode: write ? definition.action === 'preparedReconcile' ? 'read' : 'durable-device-owner-transaction' : 'read', description: 'The original scoped PC journal owns stable delivery receipts, wake nonces and owner epochs. Publishing a device session reports an existing native host; claim/response actions require that exact signed device and loaded session. No PC model, replacement session or alternate Runtime executes the prompt.' },
      recovery: { strategy: 'original-device-receipt', receiptPath: '/api/device-agents/:agentId/deliveries/:deliveryId', description: 'Preserve the original agent/session/ownerEpoch, deliveryId, envelope and prepared generation. Duplicate delivery IDs replay only matching fingerprints. Read or reconcile the original receipt before retrying uncertain operations; 202 and wake submission are not owner acceptance. A missing receipt does not prove no dispatch. Session renewal retains the owner epoch only for the same current owner.' },
      validators: [{ id: 'original-device-authority', description: 'Capture original connection and delivery authority before body parsing. Preserve PC assignment and full session identity; recheck after awaited assignment, ledger and mailbox reads and before writes/disclosure. Authenticated enabled connections need no separate feature grant; device-only claim/response and signed ledger evidence establish ownership/provenance.' },
        { id: 'native-device-mailbox', description: 'Native validation owns rendered envelope/source semantics, UTF-16 limits, 1024 non-evicting deliveries, 45-second loaded-session leases, 16 unique advertised capabilities, 12-second bounded event waits, exact wake/claim tokens, prepared source/target/generation/hash and ledger readback. Unknown JSON fields retain native behavior. Empty JSON body defaults to {} where accepted; no application byte cap is added. Cancellation releases event listeners and timers before registration retirement completes.' }]
    }, prepare: bind, handler: async input => { const prepared = await bind(input); return typeof prepared === 'function' ? prepared(input) : prepared; } };
  });
}
