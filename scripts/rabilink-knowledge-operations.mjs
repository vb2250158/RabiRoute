// Durable transport receipts, not a second knowledge datastore.
const fail = (statusCode, code) => { throw Object.assign(new Error(code), {statusCode, code}); };
export const validOperationKey = key => typeof key === 'string' && /^[A-Za-z0-9:._-]{1,256}$/.test(key);
const strong = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value);
export function knowledgeOutcome(result, statusCode, key) {
  const unknown = {state:'unknown'};
  try { if (!result || Buffer.byteLength(JSON.stringify(result)) > 32768) return unknown; } catch { return unknown; }
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 500) return unknown;
  const r = result.structuredContent;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return unknown;
  if (r.ok === true) {
    if (!(statusCode >= 200 && statusCode < 300) || !Number.isInteger(r.statusCode) || r.statusCode < 200 || r.statusCode >= 300 || result.isError === true || r.uncertain !== false || r.commitState !== 'committed' || r.idempotencyKey !== key || !strong(r.etag) || typeof r.data?.id !== 'string' || !r.data.id.trim()) return unknown;
    return {state:'confirmed',receipt:{ok:true,statusCode:r.statusCode,uncertain:false,commitState:'committed',idempotencyKey:key,etag:r.etag,data:structuredClone(r.data)}};
  }
  if (r.ok !== false || !Number.isInteger(r.statusCode) || r.statusCode < 200 || r.statusCode >= 500 || typeof r.uncertain !== 'boolean' || r.idempotencyKey !== key) return unknown;
  // Failures never imply that a write did not happen unless the authority says so.
  const receipt = {ok:false,statusCode:r.statusCode,uncertain:r.uncertain, idempotencyKey:key, ...(typeof r.commitState === 'string' ? {commitState:r.commitState} : {}), ...(typeof r.error === 'string' ? {error:r.error.slice(0,512)} : {})};
  return {state: r.uncertain === false && r.commitState === 'not_started' ? 'failed' : 'unknown',receipt};
}
export function normalizeKnowledgeIntents(value) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid knowledge intent ledger');
  const seen = new Set();
  return value.map(x => {
    if (!x || !validOperationKey(x.key) || !/^[a-f0-9]{64}$/.test(x.hash) || seen.has(x.key)) throw new Error('Invalid knowledge intent ledger');
    seen.add(x.key);
    const row = {key:x.key,hash:x.hash};
    if (x.scope !== undefined) {
      const s=x.scope;
      if (!s || ['ownerAccountId','targetDeviceId','roleId','tool','credentialHash'].some(k=>typeof s[k]!=='string'||!s[k]||s[k].length>512)) throw new Error('Invalid knowledge operation scope');
      row.scope=Object.fromEntries(['ownerAccountId','targetDeviceId','roleId','tool','credentialHash'].map(k=>[k,s[k]]));
    }
    if (x.outcome !== undefined) {
      if (!row.scope || !['confirmed','failed','unknown'].includes(x.outcome?.state)) throw new Error('Invalid knowledge outcome');
      if (!x.outcome.receipt) row.outcome={state:'unknown'};
      else {
        const checked=knowledgeOutcome({structuredContent:x.outcome.receipt},200,x.key);
        if(checked.state!==x.outcome.state) throw new Error('Invalid stored knowledge receipt');
        row.outcome=checked;
      }
    }
    return row;
  });
}
export function readKnowledgeOperation(app,binding,key) {
  if(!validOperationKey(key)) fail(400,'INVALID_OPERATION_KEY');
  if(!binding?.credentialHash || binding.enabled===false) fail(403,'DEVICE_CREDENTIAL_REQUIRED');
  const op=normalizeKnowledgeIntents(binding.knowledgeIntents||[]).find(x=>x.key===key);
  const s=op?.scope;
  if(app?.enabled===false || !app?.ownerAccountId || (s && (s.ownerAccountId!==app.ownerAccountId || s.targetDeviceId!==app.targetDeviceId || s.credentialHash!==binding.credentialHash))) fail(403,'KNOWLEDGE_OPERATION_DENIED');
  return {idempotencyKey:key, state:op?.outcome?.state||'unknown', ...(s && op.outcome?.receipt ? {receipt:structuredClone(op.outcome.receipt)} : {})};
}
