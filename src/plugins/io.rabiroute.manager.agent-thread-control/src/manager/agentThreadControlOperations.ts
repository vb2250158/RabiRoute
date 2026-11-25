import { createHash } from 'node:crypto';
import { agentAdapterTypes } from '@rabiroute/host-api/shared/agentAdapterCapabilities';
import type { AgentThreadRequest } from '@rabiroute/host-api/agentThreads';
import { agentThreadBodyFailure, type AgentThreadControlOwner } from './agentThreadControlRoutes.js';
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from '@rabiroute/host-api/manager/apiOperationContract';
import { WEB_CHAT_ADAPTER, WEB_CHAT_ATTACHMENT_COUNT, WEB_CHAT_REQUEST_MAX_BYTES } from '../../../../shared/agentWebChat.js';

const text = { type: ['string', 'null'] }, ignored = { type: 'object' }, empty = { type: 'object', additionalProperties: false };
const source = { type: 'object', required: ['type'], properties: { type: { enum: ['agent', 'agent_hook', 'plan', 'message_adapter', 'system'] }, agentAdapter: { type: 'string' }, agentType: text,
  sessionName: text, sessionId: text, workspace: text, planName: text, planId: text, sourceAgent: { type: 'object' }, messageAdapter: text, conversationType: text, conversationName: text,
  conversationId: text, senderName: text, senderId: text, messageId: text, messageGroupId: text, routeName: text, routeId: text, eventType: text, eventName: text, eventId: text, actorType: text, actorName: text, actorId: text } };
const strings = { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] };
/** Structure only: adapter-owned semantic validation remains in the original driver and ledger. */
const threadRequest = { type: 'object', properties: {
  action: { enum: ['list', 'read', 'reconcile_delivery', 'open', 'resolve', 'create', 'rename', 'send', 'ds_bot_catalog', 'ds_bot_deliver', 'ds_bot_reconcile'] },
  agentAdapter: text, agentTargetId: text, ledgerOwnerDeviceId: text, instanceBinding: { anyOf: [{ type: 'object', required: ['instanceId', 'agentId'], properties: { instanceId: text, agentId: text, ownerDeviceId: text } }, { type: 'null' }] },
  dsBot: { type: 'object', required: ['botScopeId', 'botId'], additionalProperties: false, properties: { botScopeId: text, botId: text, scheduledAt: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z$" } } },
  query: text, limit: true, offset: true, threadId: text, deliveryId: text, title: text, prompt: text, cwd: text,
  history: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  createIfMissing: true, lookupMode: true, sandbox: true, model: text, reasoningEffort: true, imagePaths: strings,
  dshBaseUrl: text, dshAgentPreset: text, dshDeliveryMode: true, codexDeliveryMode: { const: 'queue' }, workbuddyDeliveryMode: { enum: ['steer', 'direct'] }, grokBotDelivery: { anyOf: [{ type: 'object', properties: { deliveryType: text, sendMode: text, senderAgentId: text } }, { type: 'null' }] },
  messageSource: { anyOf: [source, { type: 'null' }] }, contextBlocks: strings, controlBlocks: strings, sourceThreadId: text, sourceAgentType: text, responsePolicy: text, responseInstruction: text,
  inReplyToRequestId: text, result: text, nextAction: text, messageProcessing: { anyOf: [{ type: 'object', properties: { requirementId: text, outcome: text, targetAgentType: text, planId: text, planTitle: text } }, { type: 'null' }] }
} };
const response = { mediaType: 'application/json', schema: { type: 'object', required: ['code'], properties: { code: { type: 'integer' }, action: { anyOf: [text, { type: 'null' }] },
  agentAdapter: text, threadId: text, query: text, errorCode: { type: 'string' }, field: { type: 'string' }, repair: { type: 'string' }, offset: { type: 'number' }, nextOffset: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  threads: { type: 'array', items: { type: 'object', required: ['id', 'title', 'updatedAt'], properties: { id: text, title: text, updatedAt: text, cwd: text, archived: { type: 'boolean' } } } },
  dsBot: true, thread: true, history: true, resolution: text, ok: { type: 'boolean' }, status: text, message: text, warning: text, communication: { type: 'object' }, delivery: { type: 'object' },
  source: { type: 'object' }, messageSource: source, error: true, handoffReturn: { type: 'object' }, uncertain: { type: 'boolean' } } } };
const headers = { 'cache-control': 'no-store' };
const toResult = (result: { status: number; body: Record<string, unknown> }): ApiOperationResult => ({ ...result, headers });
const receiptText = { type: 'string' };
const receiptEndpoint = { type: 'object', required: ['kind', 'managerInstanceId', 'agentId', 'provider', 'sessionId', 'authorizationIncarnation'], additionalProperties: false,
  properties: { kind: { enum: ['local', 'instance', 'device', 'service'] }, managerInstanceId: receiptText, agentId: receiptText,
    provider: receiptText, sessionId: receiptText, authorizationIncarnation: receiptText, ownerDeviceId: receiptText, ledgerOwnerDeviceId: receiptText,
    instanceId: receiptText, nodeId: receiptText } };
const callerReceiptData = { type: 'object', required: ['deliveryId', 'state', 'canSubmitSameIntent'], additionalProperties: false,
  properties: { deliveryId: receiptText, state: { enum: ['prepared', 'dispatching', 'committed', 'cancelled'] }, canSubmitSameIntent: { type: 'boolean' },
    detailPath: receiptText,
    receipt: { type: 'object', required: ['deliveryId', 'generation', 'endpoint', 'promptHash', 'executionOptionsHash', 'accepted', 'action', 'transport'], additionalProperties: false,
      properties: { deliveryId: receiptText, generation: receiptText, endpoint: receiptEndpoint, promptHash: receiptText, executionOptionsHash: receiptText,
        accepted: { const: true }, action: receiptText, transport: receiptText } } } };
const callerCreation = { anyOf: [
  { type: 'object', required: ['available', 'state'], additionalProperties: false,
    properties: { available: { const: true }, state: { const: 'absent' } } },
  { type: 'object', required: ['available', 'state', 'intentHash'], additionalProperties: false,
    properties: { available: { const: true }, state: { enum: ['reserved', 'creating', 'uncertain', 'failed_before_create'] },
      intentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, threadId: receiptText } },
  { type: 'object', required: ['available', 'state', 'intentHash', 'threadId'], additionalProperties: false,
    properties: { available: { const: true }, state: { enum: ['thread_created', 'naming', 'initial_turn', 'completed'] },
      intentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, threadId: receiptText } },
  { type: 'object', required: ['available', 'errorCode'], additionalProperties: false,
    properties: { available: { const: false }, errorCode: { const: 'CREATION_EVIDENCE_UNAVAILABLE' } } }
] };

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
      description: method === 'GET' ? 'List native owner sessions with full names and opaque IDs, using existing adapter discovery.' : 'Execute the original list/read/reconcile_delivery/open/resolve/create/rename/send action against the actual owner. read accepts optional history={cursor,limit} to read native history from the same provider and endpoint. Unsupported adapter actions remain unsupported; no delete/cancel API is invented.',
      request: { path: empty, query: ignored, headers: ignored, body: method === 'GET' ? { kind: 'none', allowIgnoredBody: true } : { kind: 'json', schema: threadRequest, maxBytes: 0, allowAnyContentType: true, emptyValue: {} } },
      responses: Object.fromEntries([200, 201, 202, 400, 401, 403, 404, 409, 500, 503].map(status => [String(status), response])),
      effects: { mode: method === 'GET' ? 'read' : 'native-owner-action', description: 'Original adapter/driver and Manager ledger own session discovery, exact identity, metadata creation/rename/open, real delivery, prepared reservation and formal reply. Handoff callbacks update the original board and publish events. Only the actual device/Desktop/service owner executes prompts; no fallback Runtime is created by these contracts.' },
      recovery: { strategy: 'original-native-delivery', description: method === 'GET'
        ? 'Keep the original deliveryId, source session, target endpoint, generation and body. Reconcile/read the original receipt after uncertain delivery or metadata creation, without resending or creating another session. 202, delivery_unconfirmed and delivered_tracking_failed preserve their native meaning. Query list pages by nextOffset; names and saved cwd do not replace a valid full session ID.'
        : 'Keep the original deliveryId, source session, target endpoint, generation and body. After a timeout, 202, delivery_unconfirmed or delivered_tracking_failed, reconcile the original receipt and read the same target session before any resend. '
          + 'In parallel, use the Rabi computer controls to diagnose or restore the bound session owner through its authorized desktop or terminal, even when the Agent adapter is unavailable. On shared computers use the original instance binding and verify the account or Desktop owner. Hostname and IP alone are ambiguous. '
          + 'For a confirmed lightweight connector version gap, use its signed update and verify reconnect and the needed capability. For a full host version gap use the target Host lifecycle. Resume original delivery only when evidence confirms dispatch did not start. Query list pages by nextOffset and retain the full session ID.' },
      validators: [{ id: 'original-thread-ingress', description: 'Capture trusted connector/device identity before body parsing, and recheck the admitted connection and original source after awaited owner work and before tracking updates. Unsaved source sessions may be explicitly attributed to the authenticated connector; saved context is not a feature allowlist. Body remoteSource/callerExecutionOptions/trustedDeviceSource fields cannot create authority.' },
        { id: 'native-thread-request', description: 'Original owner/adapter validates action support, full opaque IDs, workspace/path roots, source message fields, prompt/image bounds, model/tools/approval, creation reservations and idempotency. Explicit caller execution options are frozen before Route defaults. Native list Number coercion, default/clamping/flooring, duplicate query first-value semantics and ignored extension fields remain. Structural schemas do not duplicate adapter-specific business limits.' },
        { id: 'original-thread-lifetime', description: 'Registration stops new admission and joins accepted body/driver work through actual cleanup, even after the HTTP response closes. Cancellation fences prevent new work and tracking; already dispatched native work must settle rather than being reported as cancelled by the registry.' }]
    }, discovery: {
      title: method === 'GET' ? '查询 Agent 会话任务目录' : '查询、读取、创建和投递 Agent 会话任务',
      summary: method === 'GET' ? '查询当前宿主可见的会话名称与完整ID。' : '先按目标 Agent 和电脑查询原会话，再用 read 或 send。投递卡住时查原回执与目标接收记录，同时检查同一电脑的连接、桌面和终端；恢复原会话宿主，确认版本缺口时再走对应更新入口。确认原投递未开始后续投原会话。',
      category:{id:'agents',title:'Agent 协作'}, keywords:['Agent会话','任务列表','读取会话','配置Agent','绑定任务','投递消息','agent sessions','session history','agent configuration',...agentAdapterTypes],
      relatedOperations: method === 'GET'
        ? ['agent.adapters.catalog.get', 'manager.gateway-runtime.config.save', 'agent.deliveries.caller.read']
        : ['agent.adapters.catalog.get', 'manager.gateway-runtime.config.save', 'agent.deliveries.caller.read',
          'manager.rabilink.peer.servers.read', 'manager.rabilink.peer.probe', 'manager.lan-agent.computers.list',
          'manager.lan-agent.computer.execute', 'manager.lan-agent.terminals.list', 'manager.lan-agent.nodes.update'],
      ...(method === 'POST' ? {inputSources:[{field:'body.threadId',operationId:'manager.agent.threads.action',resultPath:'/threads',valuePath:'/id',parameters:{'body.action':{value:'list'},'body.agentAdapter':{from:'body.agentAdapter'},'body.agentTargetId':{from:'body.agentTargetId'}}}],examples:[{title:'查询指定宿主的任务，保留返回的完整ID',input:{body:{action:'list',agentAdapter:'codex',agentTargetId:'local:codex',limit:20}}}]} : {})
    }, prepare: bind, handler: async input => { const prepared = bind(input); return typeof prepared === 'function' ? prepared(input) : prepared; } };
  });
  const lookup: ApiOperationDefinition = {
    discovery:{title:'查询原 Agent 投递或任务创建回执',summary:'使用调用方原deliveryId查询原投递阶段和创建结果，再决定是否能够沿同一意图继续。',category:{id:'agents',title:'Agent 协作'},keywords:['投递回执','创建回执','delivery receipt','creation receipt'],relatedOperations:['manager.agent.threads.action']},
    contract: { operationId: 'agent.deliveries.caller.read', aliases: ['agent:GET:/api/agent/deliveries/caller/:callerDeliveryId'],
      contractVersion: '1.0.0', method: 'GET', pathTemplate: '/api/agent/deliveries/caller/:callerDeliveryId', exposure: 'public', transport: 'http',
      description: 'Read original prompt delivery and separate creation metadata scoped to the current authenticated source and stable caller ID. Does not dispatch.',
      request: { path: { type: 'object', required: ['callerDeliveryId'], properties: { callerDeliveryId: { type: 'string', minLength: 1 } }, additionalProperties: false },
        query: { type: 'object', properties: { sourceThreadId: text, sourceAgentType: text, agentAdapter: text, inReplyToRequestId: text, ledgerOwnerDeviceId: text }, additionalProperties: false },
        headers: ignored, body: { kind: 'none' } },
      responses: Object.fromEntries([200, 400, 404, 409, 503].map(status => [String(status), { mediaType: 'application/json', schema: {
        type: 'object', required: ['code'], properties: { code: { type: 'integer' }, data: callerReceiptData, message: { type: 'string' },
          errorCode: { type: 'string' }, canSubmitSameIntent: { type: 'boolean' }, creation: callerCreation, repair: receiptText }, additionalProperties: false } }])),
      effects: { mode: 'read', description: 'Only reads source-scoped durable reservation and receipt; never reconciles or sends.' },
      recovery: { strategy: 'read-original-resource', description: 'Only exact DELIVERY_NOT_RESERVED with canSubmitSameIntent=true proves no prompt delivery reservation. Inspect creation separately: creation may already be reserved or uncertain. Preserve the original create intent and caller ID. Existing prepared can continue the same frozen intent. Missing evidence, timeout and dispatching do not authorize replay.' },
      validators: [{ id: 'agent.delivery-caller-source', description: 'Uses original admitted connection attribution and authorization incarnation. Local sources require exact provider/session evidence. Request parameters cannot forge a remote principal. Corrupt or unavailable reserved records remain reserved.' }] },
    handler: async input => {
      try {
        const prepared = owner.prepare(input.request, input.signal);
        const sourceThreadId = input.url.searchParams.get('sourceThreadId') ?? undefined;
        const sourceAgentType = input.url.searchParams.get('sourceAgentType') as AgentThreadRequest['sourceAgentType'] ?? undefined;
        const adapter = input.url.searchParams.get('agentAdapter') as AgentThreadRequest['agentAdapter'] ?? undefined;
        return toResult(await prepared.lookupCallerDelivery(input.path.callerDeliveryId!, { sourceThreadId, sourceAgentType,
          inReplyToRequestId: input.url.searchParams.get('inReplyToRequestId') ?? undefined,
          ledgerOwnerDeviceId: input.url.searchParams.get('ledgerOwnerDeviceId') ?? undefined,
          ...(adapter && sourceThreadId ? { messageSource: { type: 'agent', agentAdapter: adapter, sessionId: sourceThreadId, sessionName: sourceThreadId } } : {}) }));
      } catch (error) { return toResult({ status: 400, body: { code: -1, message: error instanceof Error ? error.message : String(error) } }); }
    }
  };
  const bindWebChat = (input: Omit<ApiOperationInput, 'body'>) => {
    try {
      const prepared = owner.prepare(input.request, input.signal);
      return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
        const { agentAdapter, instanceBinding, threadId, dshBaseUrl, deliveryId, prompt, webChatAttachments } = parsed.body as AgentThreadRequest & { threadId: string; deliveryId: string };
        if (!prompt?.trim() && !webChatAttachments?.length) return toResult(agentThreadBodyFailure(new Error('请输入消息或添加附件。')));
        const conversationId = threadId.length <= 300 ? threadId : `sha256:${createHash('sha256').update(threadId).digest('hex')}`;
        return toResult(await prepared.execute({ action: 'send', agentAdapter, instanceBinding,
          ...(!instanceBinding ? { agentTargetId: `local:${agentAdapter}` } : {}), threadId, dshBaseUrl, deliveryId,
          prompt: prompt?.trim() || '请查看随消息发送的附件。', webChatAttachments, responsePolicy: 'none', createIfMissing: false,
          messageSource: { type: 'message_adapter', messageAdapter: WEB_CHAT_ADAPTER, conversationType: 'agent_session',
             conversationId, messageId: deliveryId, senderName: 'WebChat 用户' } }, true));
      };
    } catch (error) { return toResult(agentThreadBodyFailure(error)); }
  };
  const webChat: ApiOperationDefinition = {
    contract: { operationId: 'manager.agent.webchat.send', contractVersion: '1.0.0', method: 'POST',
      pathTemplate: '/api/agent/webchat', exposure: 'public', transport: 'http', description: 'Send text and optional uploaded attachments to an existing Agent session from WebChat.',
      request: { path: empty, query: empty, headers: ignored, body: { kind: 'json', maxBytes: WEB_CHAT_REQUEST_MAX_BYTES, schema: {
        type: 'object', required: ['agentAdapter', 'threadId', 'deliveryId'], additionalProperties: false, properties: {
          agentAdapter: { type: 'string', minLength: 1 }, instanceBinding: threadRequest.properties.instanceBinding,
          threadId: { type: 'string', minLength: 1, maxLength: 4096 }, deliveryId: { type: 'string', minLength: 1, maxLength: 100 },
          dshBaseUrl: text, prompt: { type: 'string', maxLength: 200000 },
          webChatAttachments: {
            type: 'array', maxItems: WEB_CHAT_ATTACHMENT_COUNT,
            items: { type: 'object', required: ['name', 'contentBase64'], additionalProperties: false,
              properties: { name: { type: 'string', maxLength: 255 }, contentBase64: { type: 'string' } } }
          }
        } } } },
      responses: Object.fromEntries([200, 202, 400, 401, 403, 404, 409, 413, 500, 503].map(status => [String(status), response])),
      effects: { mode: 'native-owner-action', description: 'Use the original session owner and caller delivery ledger. Store uploaded bytes only for the local Agent before dispatch.' },
      recovery: { strategy: 'read-original-resource', receiptPath: '/api/agent/deliveries/caller/:callerDeliveryId', description: 'Read the original caller receipt after an uncertain send.' },
      validators: [{ id: 'webchat-original-session', description: 'Require a message or attachments and deliver to the existing session through the original authenticated owner.' }] },
    discovery: { title: '向现有 Agent 会话发送 WebChat 消息', summary: '直接发送网页消息和附件到指定会话。', category: { id: 'agents', title: 'Agent 协作' },
      relatedOperations: ['manager.agent.threads.action', 'agent.deliveries.caller.read'] },
    prepare: bindWebChat,
    handler: input => { const prepared = bindWebChat(input); return typeof prepared === 'function' ? prepared(input) : prepared; }
  };
  return [...actions, lookup, webChat];
}
