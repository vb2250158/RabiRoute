import { errorResponsePresentation } from '../shared/errorPresentation.js';
import { createPlanAdvanceOwner, type PlanAdvanceContext } from './planAdvanceRoutes.js';
import { createPlanAgentStatusOwner, type PlanAgentStatusContext } from './planAgentStatusRoutes.js';
import { createPlanAttachmentOwner } from './planAttachmentRoutes.js';
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiResponseContract } from './apiOperationContract.js';

export type PersonaPlanOperationsContext = PlanAdvanceContext & PlanAgentStatusContext;
const ignored = { type: 'object' };
const none = { kind: 'none' as const, allowIgnoredBody: true };
const failure: ApiResponseContract = { mediaType: 'application/json; charset=utf-8', schema: {
  type: 'object', required: ['code', 'message'], properties: { code: { const: -1 }, message: { type: 'string' }, reason: { type: 'string' }, uncertain: { const: true } }
} };
const json = (data: unknown): ApiResponseContract => ({ mediaType: 'application/json', schema: {
  type: 'object', required: ['code', 'data'], properties: { code: { const: 0 }, data }
} });
const errors = Object.fromEntries([400,403,404,409,413,500].map(status => [String(status), failure]));
const array = (items: unknown = true) => ({ type: 'array', items });
const binding = { type: 'object', required: ['role','configured','agentType','threadId','threadTitle','workspace','working','agentStatus','sessionStatus','canOpen','checkedAt'], properties: {
  role: { enum: ['task','secretary'] }, configured: { type: 'boolean' }, agentType: { type: 'string' }, threadId: { type: 'string' }, threadTitle: { type: 'string' }, workspace: { type: 'string' }, working: { type: 'boolean' }, agentStatus: { enum: ['working','idle','unknown'] }, sessionStatus: { type: 'string' }, canOpen: { type: 'boolean' }, checkedAt: { type: 'string' }, message: { type: 'string' }
} };
const statusData = { type: 'object', required: ['items','missingPlanIds'], properties: {
  items: array({ type: 'object', required: ['planId','checkedAt','taskAgent'], properties: { planId: { type: 'string' }, checkedAt: { type: 'string' }, taskAgent: binding, secretaryAgent: binding } }), missingPlanIds: array({ type: 'string' })
} };
const policy = { type: 'object', required: ['enabled','startup','events','due','rules'], properties: {
  enabled: { type: 'boolean' }, startup: { type: 'boolean' }, events: { type: 'boolean' }, due: { type: 'boolean' }, rules: { type: 'object' }
} };
const page = { type: 'object', required: ['items','total','nextCursor'], properties: {
  items: array({ type: 'object', required: ['planId','title','status','label','fingerprint','reason','eligible','prompt'], properties: {
    planId: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, label: { type: 'string' }, fingerprint: { type: 'string' }, reason: { type: 'string' }, eligible: { type: 'boolean' }, prompt: { type: 'string' }, sessionId: { type: 'string' }, rule: { type: 'object' }, retryAt: { type: 'number' }, lastRun: { type: 'object' }
  } }), total: { type: 'number' }, nextCursor: { type: 'string' }
} };

function failed(error: unknown, attachment: boolean): ApiOperationResult {
  const cause = error as { statusCode?: number; code?: string; uncertain?: boolean };
  const message = error instanceof Error ? error.message : String(error);
  const status = cause?.statusCode ?? (attachment ? cause?.code === 'ENOENT' || /not found|unavailable|managed directories/i.test(message) ? 404 : cause?.code === 'EACCES' || cause?.code === 'EPERM' ? 403 : 500 : 400);
  return { status, headers: attachment ? {} : { 'cache-control': 'no-store' }, body: errorResponsePresentation({ code: -1, message,
    ...(attachment ? { reason: cause?.code || 'attachment_read_failed' } : {}), ...(cause?.uncertain ? { uncertain: true } : {}) }, status) };
}
function define<T>(contract: ApiOperationContract, prepare: (input: Omit<ApiOperationInput,'body'>) => T,
  execute: (owner: T, input: ApiOperationInput) => ApiOperationResult | Promise<ApiOperationResult>, attachment = false): ApiOperationDefinition {
  const bind = (input: Omit<ApiOperationInput,'body'>) => {
    try {
      const owner = prepare(input);
      return async (parsed: ApiOperationInput) => {
        try { return await execute(owner, parsed); }
        catch (error) { parsed.signal?.throwIfAborted(); return failed(error, attachment); }
      };
    } catch (error) { input.signal?.throwIfAborted(); return failed(error, attachment); }
  };
  return { contract, prepare: bind, handler: async input => { const bound = bind(input); return typeof bound === 'function' ? bound(input) : bound; } };
}

/** Eight exact operations; plan persistence, adapter access and reservation lifetime stay with native owners. */
export function createPersonaPlanOperations(context: PersonaPlanOperationsContext): readonly ApiOperationDefinition[] {
  const agents = createPlanAgentStatusOwner(context), advance = createPlanAdvanceOwner(context), attachments = createPlanAttachmentOwner(context);
  const base = (id: string, method: ApiOperationContract['method'], suffix: string, keys: string[], body: ApiOperationContract['request']['body'], responses: ApiOperationContract['responses'], mode: string): ApiOperationContract => ({
    operationId: 'manager.personas.plans.' + id,
    ...(['agents.status','attachment.read'].includes(id) ? { aliases: ['persona:' + method + ':/api/roles/:roleId/' + suffix] } : {}),
    contractVersion: '1.0.0', method, pathTemplate: '/api/roles/:roleId/' + suffix, exposure: 'public', transport: 'http',
    description: 'Use the selected persona’s native plan status, advancement policy/reservations or managed attachment.',
    request: { path: { type: 'object', required: keys, additionalProperties: false, properties: Object.fromEntries(keys.map(key => [key,{ type: 'string', minLength: 1 }])) }, query: ignored, headers: ignored, body },
    responses, effects: { mode, description: mode === 'read' ? 'Read original persisted plans, scoped host inventory and attachment bytes.' : mode === 'navigate' ? 'Open only the plan binding or original server-owned history actor; do not run a prompt.' : 'Use native workspace CAS policy storage, checked fingerprints and durable dispatch reservations. Real work remains in the original bound DSH session.' },
    recovery: { strategy: 'native-plan-readback', description: 'Read the current policy revision before save. Check again before run; identical consumed fingerprints cannot dispatch twice. Keep uncertain delivery receipts and reconcile the original delivery identity. Attachments preserve original managed roots, relocation hash checks, HEAD and byte ranges.' },
    validators: [{ id: 'original-plan-owner', description: 'Capture original selected persona, authenticated connection and Manager identity before consuming the body. Recheck after awaited inventory/storage and before any navigation, reservation or send; no feature grant is added.' }, { id: 'native-plan-contract', description: 'Preserve native requested plan IDs, original history actor, full session ID/title, workspace binding, policy revision, server fingerprint, approval/cooldown limits, grouped session reservation, and post-attempt uncertain cleanup.' }]
  });
  const agentPrepare = (input: Omit<ApiOperationInput,'body'>) => agents.prepare(input.request,input.path.roleId,input.signal);
  const advancePrepare = (input: Omit<ApiOperationInput,'body'>) => advance.prepare(input.request,input.path.roleId,input.signal);
  const entries: ApiOperationDefinition[] = [
    define(base('agents.status','GET','plan-agents/status',['roleId'],none,{'200':json(statusData),...errors},'read'),agentPrepare,async(owner,input)=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.inspect(input.url.searchParams.getAll('planId'))}})),
    define(base('agents.open','POST','plan-agents/:planId/open',['roleId','planId'],{kind:'json',schema:true,maxBytes:8*1024,allowAnyContentType:true,emptyValue:{}},{'202':json({type:'object',required:['opened','agentType','threadId','threadTitle','workspace'],properties:{opened:{const:true},agentType:{type:'string'},threadId:{type:'string'},threadTitle:{type:'string'},workspace:{type:'string'},planId:{type:'string'},role:{enum:['task','secretary']}}}),...errors},'navigate'),agentPrepare,async(owner,input)=>({status:202,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.open(input.path.planId,input.body)}}))
  ];
  for (const [id,method,action] of [['advance.settings.read','GET','settings.read'],['advance.settings.save','PUT','settings.save'],['advance.check','POST','check'],['advance.run','POST','run']] as const) {
    const response = action.startsWith('settings.') ? json({type:'object',required:['policy','revision','statuses','roles'],properties:{policy,revision:{type:'string'},statuses:array(),roles:{type:'object'}}})
      : action==='check' ? json(page) : json({type:'object',required:['items'],properties:{items:array({type:'object',required:['planId','state'],properties:{planId:{type:'string'},state:{enum:['accepted','uncertain','skipped']},reason:{type:'string'}}}),total:{type:'number'},nextCursor:{type:'string'}}});
    entries.push(define(base(id,method,'plan-advance/'+(action.startsWith('settings.')?'settings':action),['roleId'],method==='GET'?none:{kind:'json',schema:{type:'object'},maxBytes:1024*1024,allowAnyContentType:true,emptyValue:{}},{'200':response,...errors},method==='GET'||action==='check'?'read':'native-plan-mutation'),advancePrepare,async(owner,input)=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.execute(action,method==='GET'?{}:input.body,input.url.searchParams.get('workspace'))}})));
  }
  for (const method of ['GET','HEAD'] as const) {
    const binary: ApiResponseContract = { mediaType:'*/*',binary:{maxBytes:Number.MAX_SAFE_INTEGER} };
    entries.push(define(base(method==='GET'?'attachment.read':'attachment.head',method,'plans/:planId/attachments/:attachmentId',['roleId','planId','attachmentId'],none,{'200':binary,'206':binary,'416':{mediaType:'application/octet-stream',schema:true},...errors},'read'),input=>attachments.prepare(input.request,input.path.roleId,input.path.planId,input.path.attachmentId,input.signal),(owner,input)=>{const result=owner.read(typeof input.request.headers.range==='string'?input.request.headers.range:undefined);return {status:result.status,headers:result.headers,body:method==='HEAD'?undefined:result.bytes};},true));
  }
  return entries;
}
