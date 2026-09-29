// Pure policy only. No host, HTTP, crypto, storage or physical-input adapter is installed here.
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(code); };
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) fail('INVALID_TEXT');
  return value;
}
function scopeOf(value) {
  if (!value || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1) fail('INVALID_SCOPE');
  return {deviceScope:text(value.deviceScope,256),profileRevision:value.profileRevision,roleId:text(value.roleId,128),targetDeviceId:text(value.targetDeviceId,256)};
}
function bodyOf(value) {
  if (!value || Object.keys(value).some(k=>!['title','focus','keywords','content'].includes(k))) fail('INVALID_BODY');
  if (!Array.isArray(value.keywords) || value.keywords.length < 1 || value.keywords.length > 8) fail('INVALID_KEYWORDS');
  const focus=text(value.focus,120);if(/[\r\n]/.test(focus))fail('INVALID_FOCUS');
  return {title:text(value.title,80),focus,keywords:value.keywords.map(k=>text(k,80)),content:text(value.content,1000)};
}
export function createKnowledgeWriteConfirmation({now,createKey,persist,send,validateReceipt,capabilities}={}) {
  if ([now,createKey,persist,send,validateReceipt].some(fn=>typeof fn!=='function')) fail('DEPENDENCIES_REQUIRED');
  // These flags declare adapter obligations; they are NOT evidence of host/device verification.
  const capable=()=>capabilities?.secureRandom===true && capabilities?.atomicPersistence===true && capabilities?.explicitUserConfirmation===true;
  let record=null,epoch=0,busy=false,visible=true,currentScope=null;
  const snapshot=()=>record?clone(record):null;
  const clock=()=>{const n=now();if(!Number.isFinite(n))fail('INVALID_CLOCK');return n;};
  function prepare(body,scope) {
    if(busy || ['dispatching','uncertain'].includes(record?.state))fail('UNRESOLVED_OPERATION');
    if(!visible)fail('BACKGROUND');
    const nextScope=scopeOf(scope),nextBody=bodyOf(body),time=clock();
    currentScope=nextScope;epoch++;
    record={state:'awaiting-confirmation',scope:nextScope,body:nextBody,expiresAt:time+60000};return snapshot();
  }
  function cancel(reason='cancelled') {
    epoch++;
    if(record?.state==='awaiting-confirmation') record.state=reason==='expired'?'expired':'cancelled';
    // Once dispatch intent is persisted, cancellation cannot claim rollback.
    else if(record?.state==='dispatching') record.state='uncertain';
    return snapshot();
  }
  function setContext(scope,isVisible=true) {
    const next=scopeOf(scope);
    if(!isVisible || JSON.stringify(next)!==JSON.stringify(currentScope))cancel();
    currentScope=next;visible=isVisible===true;return snapshot();
  }
  async function confirm() {
    if(busy || record?.state!=='awaiting-confirmation')fail('NOT_CONFIRMABLE');
    if(!capable())fail('ADAPTER_CONTRACT_REQUIRED');
    if(!visible || JSON.stringify(currentScope)!==JSON.stringify(record.scope))fail('SCOPE_CHANGED');
    if(clock()>=record.expiresAt){cancel('expired');fail('EXPIRED');}
    busy=true;const selected=record,token=epoch;
    try {
      const key=await createKey();
      if(token!==epoch || !visible || clock()>=selected.expiresAt){if(token===epoch)cancel('expired');return snapshot();}
      if(typeof key!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(key))fail('INVALID_OPERATION_KEY');
      selected.idempotencyKey=key;selected.state='dispatching';
      try {await persist(clone(selected));}
      catch {selected.state='uncertain';selected.error='PERSISTENCE_UNCERTAIN';return snapshot();}
      if(token!==epoch || !visible || clock()>=selected.expiresAt){selected.state='uncertain';return snapshot();}
      let result;
      try {result=await send({tool:'recent_memory_create',scope:clone(selected.scope),idempotencyKey:key,body:clone(selected.body)});}
      catch {selected.state='uncertain';return snapshot();}
      let terminal='uncertain';
      try {if(validateReceipt(result,clone(selected))===true)terminal='confirmed';}catch {}
      // Do not publish success before durable acknowledgement; recheck after every await.
      if(token!==epoch || !visible)terminal='uncertain';
      try {
        await persist({...clone(selected),state:terminal});
        selected.state=token===epoch && visible?terminal:'uncertain';
      } catch {selected.state='uncertain';selected.error='PERSISTENCE_UNCERTAIN';}
      return snapshot();
    } finally {busy=false;}
  }
  function restore(value) {
    if(busy || record)fail('ALREADY_INITIALIZED');
    if(!value || !['dispatching','uncertain','confirmed'].includes(value.state))fail('INVALID_RECORD');
    const scope=scopeOf(value.scope),body=bodyOf(value.body);
    if(typeof value.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(value.idempotencyKey))fail('INVALID_OPERATION_KEY');
    record={state:'uncertain',scope,body,idempotencyKey:value.idempotencyKey,expiresAt:0};currentScope=scope;epoch++;return snapshot();
  }
  return {prepare,confirm,cancel,setContext,restore,snapshot};
}
