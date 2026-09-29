import { createHash } from 'node:crypto';
export const KNOWLEDGE_PATH = '/__rabilink/knowledge';
const tools = new Set(['knowledge_search','plan_list','plan_get','plan_statuses','memory_list','memory_get','plan_create','plan_update','recent_memory_create','recent_memory_update']);
const writes = new Set(['plan_create','plan_update','recent_memory_create','recent_memory_update']);
const fail = (statusCode, code) => { throw Object.assign(new Error(code), { statusCode, code }); };
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
function exact(x, keys) { if (!plain(x) || Object.keys(x).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(x,k))) fail(400,'INVALID_KNOWLEDGE_FIELDS'); }
export function validateKnowledgeGrant(v) {
  exact(v,['allowedRoles','allowedTools','allowWrites']);
  for (const k of ['allowedRoles','allowedTools']) if (!Array.isArray(v[k]) || v[k].length > 64 || v[k].some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x)) || new Set(v[k]).size !== v[k].length) fail(400,'INVALID_KNOWLEDGE_GRANT');
  if (typeof v.allowWrites !== 'boolean' || v.allowedTools.some(x => !tools.has(x))) fail(400,'INVALID_KNOWLEDGE_GRANT');
  return structuredClone(v);
}
export function normalizeKnowledgeGrantState(s) {
  if (s === undefined) return undefined;
  exact(s,['revision','grant','operations']);
  if (!Number.isSafeInteger(s.revision) || s.revision < 1 || !Array.isArray(s.operations) || s.operations.length > 128) fail(500,'INVALID_STORED_KNOWLEDGE_GRANT');
  const seen = new Set();
  for (const op of s.operations) { exact(op,['key','hash','revision','grant']); if (!/^[A-Za-z0-9:._-]{1,128}$/.test(op.key) || !/^[a-f0-9]{64}$/.test(op.hash) || seen.has(op.key) || !Number.isSafeInteger(op.revision) || op.revision < 1 || op.revision > s.revision) fail(500,'INVALID_STORED_KNOWLEDGE_GRANT'); seen.add(op.key); validateKnowledgeGrant(op.grant); }
  return {...structuredClone(s),grant:validateKnowledgeGrant(s.grant)};
}
export function createKnowledgeGrantService({readStore,writeStore}) {
  function target(accountId, appId, bindingId) { const store = structuredClone(readStore()); const app = store.apps.find(a=>a.id===appId && a.enabled!==false && a.ownerAccountId===accountId); const binding = app?.deviceBindings?.find(b=>b.id===bindingId && b.enabled!==false); if (!accountId || !binding) fail(404,'DEVICE_NOT_FOUND'); return {store,binding}; }
  function view(binding) { const s=normalizeKnowledgeGrantState(binding.knowledgeGrantState); return s ? {revision:s.revision,grant:s.grant} : {revision:0,grant:{allowedRoles:[],allowedTools:[],allowWrites:false}}; }
  return { read(accountId,appId,bindingId) { return view(target(accountId,appId,bindingId).binding); }, readOperation(accountId,appId,bindingId,key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(key)) fail(400,'INVALID_KNOWLEDGE_MUTATION');
    const state = normalizeKnowledgeGrantState(target(accountId,appId,bindingId).binding.knowledgeGrantState);
    const operation = state?.operations.find(item => item.key === key);
    return {receipt: operation ? {idempotencyKey:operation.key,revision:operation.revision,grant:structuredClone(operation.grant)} : null};
  }, save(accountId,appId,bindingId,input) {
    exact(input,['expectedRevision','idempotencyKey','grant']); if (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!/^[A-Za-z0-9:._-]{1,128}$/.test(input.idempotencyKey)) fail(400,'INVALID_KNOWLEDGE_MUTATION');
    const grant=validateKnowledgeGrant(input.grant); const {store,binding}=target(accountId,appId,bindingId); const prior=normalizeKnowledgeGrantState(binding.knowledgeGrantState); const hash=createHash('sha256').update(JSON.stringify({expectedRevision:input.expectedRevision,grant})).digest('hex'); const old=prior?.operations.find(o=>o.key===input.idempotencyKey);
    if(old) { if(old.hash!==hash) fail(409,'IDEMPOTENCY_CONFLICT'); return {idempotencyKey:old.key,revision:old.revision,grant:old.grant}; }
    if(input.expectedRevision!==(prior?.revision||0)) fail(412,'KNOWLEDGE_REVISION_CONFLICT'); if((prior?.operations.length||0)>=128) fail(409,'KNOWLEDGE_RECEIPT_CAPACITY');
    const revision=(prior?.revision||0)+1; binding.knowledgeGrantState={revision,grant,operations:[...(prior?.operations||[]),{key:input.idempotencyKey,hash,revision,grant}]}; writeStore(store); return {idempotencyKey:input.idempotencyKey,revision,grant};
  }};
}
export function authorizeKnowledgeRequest(app,binding,worker,body) {
  if(!binding || !binding.credentialHash || binding.enabled===false) fail(403,'DEVICE_CREDENTIAL_REQUIRED');
  if(!app.targetDeviceId || !worker || worker.id!==app.targetDeviceId || worker.appId!==app.id) fail(409,'EXPLICIT_KNOWLEDGE_PC_REQUIRED');
  if(!plain(body)||Object.keys(body).some(k=>!['operation','name','args'].includes(k))||Buffer.byteLength(JSON.stringify(body))>65536) fail(400,'INVALID_KNOWLEDGE_REQUEST');
  const state=normalizeKnowledgeGrantState(binding.knowledgeGrantState); const grant=state?.grant;
  if(!grant?.allowedRoles.length||!grant.allowedTools.length) fail(403,'KNOWLEDGE_DISABLED');
  if(body.operation==='list') { exact(body,['operation']); }
  else { exact(body,['operation','name','args']); if(body.operation!=='call'||!grant.allowedTools.includes(body.name)||!plain(body.args)||!grant.allowedRoles.includes(body.args.roleId)) fail(403,'KNOWLEDGE_CALL_DENIED'); }
  const mutation=writes.has(body.name)||(body.name==='memory_get'&&body.args?.kind==='recent');
  if(mutation && (!grant.allowWrites || typeof body.args.idempotencyKey!=='string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(body.args.idempotencyKey))) fail(403,'KNOWLEDGE_WRITE_DENIED');
  return {metadata:{appId:app.id,deviceBindingId:binding.id,ownerAccountId:app.ownerAccountId,targetDeviceId:worker.id},grant:structuredClone(grant),request:structuredClone(body),nonReplayable:mutation};
}
export function rejectReservedKnowledgePath(value) {
  let pathname; try { pathname=decodeURIComponent(new URL(value,'http://reserved.invalid').pathname).replaceAll('\\','/').toLowerCase(); } catch { fail(400,'INVALID_PROXY_PATH'); }
  if(pathname===KNOWLEDGE_PATH||pathname.startsWith(KNOWLEDGE_PATH+'/')) fail(403,'RESERVED_KNOWLEDGE_PATH');
}
