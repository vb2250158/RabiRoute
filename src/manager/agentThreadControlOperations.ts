import { agentAdapterTypes } from '../shared/agentAdapterCapabilities.js';
import type { AgentThreadRequest } from '../agentThreads.js';
import { agentThreadBodyFailure, type AgentThreadControlOwner } from './agentThreadControlRoutes.js';
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from './apiOperationContract.js';

const text = { type: ['string', 'null'] }, ignored = { type: 'object' }, empty = { type: 'object', additionalProperties: false };
const source = { type: 'object', required: ['type'], properties: { type: { enum: ['agent', 'agent_hook', 'plan', 'message_adapter', 'system'] }, agentAdapter: { enum: agentAdapterTypes }, agentType: text,
  sessionName: text, sessionId: text, workspace: text, planName: text, planId: text, sourceAgent: { type: 'object' }, messageAdapter: text, conversationType: text, conversationName: text,
  conversationId: text, senderName: text, senderId: text, messageId: text, messageGroupId: text, routeName: text, routeId: text, eventType: text, eventName: text, eventId: text, actorType: text, actorName: text, actorId: text } };
const strings = { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] };
/** Structure only: adapter-owned semantic validation remains in the original driver and ledger. */
const threadRequest = { type: 'object', properties: {
  action: { enum: ['list', 'read', 'reconcile_delivery', 'open', 'resolve', 'create', 'rename', 'send'] },
  agentAdapter: { enum: [...agentAdapterTypes, '', null] }, agentTargetId: text, instanceBinding: { anyOf: [{ type: 'object', required: ['instanceId', 'agentId'], properties: { instanceId: text, agentId: text } }, { type: 'null' }] },
  query: text, limit: true, offset: true, threadId: text, deliveryId: text, title: text, prompt: text, cwd: text,
  createIfMissing: true, lookupMode: true, sandbox: true, model: text, reasoningEffort: true, imagePaths: strings,
  dshBaseUrl: text, dshAgentPreset: text, dshDeliveryMode: true, grokBotDelivery: { anyOf: [{ type: 'object', properties: { deliveryType: text, sendMode: text, senderAgentId: text } }, { type: 'null' }] },
  messageSource: { anyOf: [source, { type: 'null' }] }, contextBlocks: strings, controlBlocks: strings, sourceThreadId: text, sourceAgentType: text, responsePolicy: text, responseInstruction: text,
  inReplyToRequestId: text, result: text, nextAction: text, messageProcessing: { anyOf: [{ type: 'object', properties: { requirementId: text, outcome: text, targetAgentType: text, planId: text, planTitle: text } }, { type: 'null' }] }
} };
const response = { mediaType: 'application/json', schema: { type: 'object', required: ['code'], properties: { code: { type: 'integer' }, action: { anyOf: [text, { type: 'null' }] },
  agentAdapter: text, threadId: text, query: text, offset: { type: 'number' }, nextOffset: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  threads: { type: 'array', items: { type: 'object', required: ['id', 'title', 'updatedAt'], properties: { id: text, title: text, updatedAt: text, cwd: text, archived: { type: 'boolean' } } } },
  thread: true, resolution: text, ok: { type: 'boolean' }, status: text, message: text, warning: text, communication: { type: 'object' }, delivery: { type: 'object' },
  source: { type: 'object' }, messageSource: source, error: true, handoffReturn: { type: 'object' }, uncertain: { type: 'boolean' } } } };
const headers = { 'cache-control': 'no-store' };
const toResult = (result: { status: number; body: Record<string, unknown> }): ApiOperationResult => ({ ...result, headers });

/** List and action POST are the two actual native HTTP entry points; there is no delete/cancel route. */
export function createAgentThreadControlOperations(owner: AgentThreadControlOwner): readonly ApiOperationDefinition[] {
  const actions = (['GET', 'POST'] as const).map<ApiOperationDefinition>(method => {
    const bind = (input: Omit<ApiOperationInput, 'body'>) => {
      try {
        const prepared = owner.prepare(input.request, input.signal);
        return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
          const body = method === 'GET' ? { action: 'list' as const, query: parsed.url.searchParams.get('query') ?? '', limit: Number(parsed.url.searchParams.get('limit') ?? '100'), offset: Number(parsed.url.searchParams.get('offset') ?? '0') }
            : parsed.body as AgentThreadRequest;
          return toResult(await prepared.execute(body));
        };
      } catch (error) { return toResult(agentThreadBodyFailure(error)); }
    };
    return { contract: { operationId: method === 'GET' ? 'manager.agent.threads.list' : 'manager.agent.threads.action',
      aliases: ['agent:' + method + ':/api/agent/threads'], contractVersion: '1.0.0', method, pathTemplate: '/api/agent/threads', exposure: 'public', transport: 'http',
      description: method === 'GET' ? 'List native owner sessions with full names and opaque IDs, using existing adapter discovery.' : 'Execute the original list/read/reconcile_delivery/open/resolve/create/rename/send action against the actual owner. Unsupported adapter actions remain unsupported; no delete/cancel API is invented.',
      request: { path: empty, query: ignored, headers: ignored, body: method === 'GET' ? { kind: 'none', allowIgnoredBody: true } : { kind: 'json', schema: threadRequest, maxBytes: 0, allowAnyContentType: true, emptyValue: {} } },
      responses: Object.fromEntries([200, 201, 202, 400, 401, 403, 404, 409, 500, 503].map(status => [String(status), response])),
      effects: { mode: method === 'GET' ? 'read' : 'native-owner-action', description: 'Original adapter/driver and Manager ledger own session discovery, exact identity, metadata creation/rename/open, real delivery, prepared reservation and formal reply. Handoff callbacks update the original board and publish events. Only the actual device/Desktop/service owner executes prompts; no fallback Runtime is created by these contracts.' },
      recovery: { strategy: 'original-native-delivery', description: 'Keep the original deliveryId, source session, target endpoint, generation and body. Reconcile/read the original receipt after uncertain delivery or metadata creation, without resending or creating another session. 202, delivery_unconfirmed and delivered_tracking_failed preserve their native meaning. Query list pages by nextOffset; names and saved cwd do not replace a valid full session ID.' },
      validators: [{ id: 'original-thread-ingress', description: 'Capture trusted connector/device identity before body parsing, and recheck the admitted connection and original source after awaited owner work and before tracking updates. Unsaved source sessions may be explicitly attributed to the authenticated connector; saved context is not a feature allowlist. Body remoteSource/callerExecutionOptions/trustedDeviceSource fields cannot create authority.' },
        { id: 'native-thread-request', description: 'Original owner/adapter validates action support, full opaque IDs, workspace/path roots, source message fields, prompt/image bounds, model/tools/approval, creation reservations and idempotency. Explicit caller execution options are frozen before Route defaults. Native list Number coercion, default/clamping/flooring, duplicate query first-value semantics and ignored extension fields remain. Structural schemas do not duplicate adapter-specific business limits.' },
        { id: 'original-thread-lifetime', description: 'Registration stops new admission and joins accepted body/driver work through actual cleanup, even after the HTTP response closes. Cancellation fences prevent new work and tracking; already dispatched native work must settle rather than being reported as cancelled by the registry.' }]
    }, prepare: bind, handler: async input => { const prepared = bind(input); return typeof prepared === 'function' ? prepared(input) : prepared; } };
  });
  const lookup: ApiOperationDefinition = {
    contract: { operationId: 'agent.deliveries.caller.read', aliases: ['agent:GET:/api/agent/deliveries/caller/:callerDeliveryId'],
      contractVersion: '1.0.0', method: 'GET', pathTemplate: '/api/agent/deliveries/caller/:callerDeliveryId', exposure: 'public', transport: 'http',
      description: 'Read the original delivery reservation scoped to the current authenticated source and stable caller ID. Does not dispatch.',
      request: { path: { type: 'object', required: ['callerDeliveryId'], properties: { callerDeliveryId: { type: 'string', minLength: 1 } }, additionalProperties: false },
        query: { type: 'object', properties: { sourceThreadId: text, sourceAgentType: text, agentAdapter: text }, additionalProperties: false },
        headers: ignored, body: { kind: 'none' } },
      responses: Object.fromEntries([200, 400, 404, 409, 503].map(status => [String(status), { mediaType: 'application/json', schema: {
        type: 'object', required: ['code'], properties: { code: { type: 'integer' }, data: { type: 'object' }, message: { type: 'string' },
          errorCode: { type: 'string' }, canSubmitSameIntent: { type: 'boolean' } }, additionalProperties: false } }])),
      effects: { mode: 'read', description: 'Only reads source-scoped durable reservation and receipt; never reconciles or sends.' },
      recovery: { strategy: 'read-original-resource', description: 'Only exact DELIVERY_NOT_RESERVED with canSubmitSameIntent=true proves no reservation. Existing prepared can continue the same frozen intent. Missing evidence, timeout and dispatching do not authorize replay.' },
      validators: [{ id: 'agent.delivery-caller-source', description: 'Uses original admitted connection attribution and authorization incarnation. Local sources require exact provider/session evidence. Request parameters cannot forge a remote principal. Corrupt or unavailable reserved records remain reserved.' }] },
    handler: async input => {
      try {
        const prepared = owner.prepare(input.request, input.signal);
        const sourceThreadId = input.url.searchParams.get('sourceThreadId') ?? undefined;
        const sourceAgentType = input.url.searchParams.get('sourceAgentType') as AgentThreadRequest['sourceAgentType'] ?? undefined;
        const adapter = input.url.searchParams.get('agentAdapter') as AgentThreadRequest['agentAdapter'] ?? undefined;
        return toResult(await prepared.lookupCallerDelivery(input.path.callerDeliveryId!, { sourceThreadId, sourceAgentType,
          ...(adapter && sourceThreadId ? { messageSource: { type: 'agent', agentAdapter: adapter, sessionId: sourceThreadId, sessionName: sourceThreadId } } : {}) }));
      } catch (error) { return toResult({ status: 400, body: { code: -1, message: error instanceof Error ? error.message : String(error) } }); }
    }
  };
  return [...actions, lookup];
}
