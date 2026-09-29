// Browser-compatible pure receipt policy; toString may be embedded in the manage page.
export function createProfileReceiptPolicy() {
  const invalid = () => { throw new Error('INVALID_PROFILE_RECEIPT'); };
  const object = (v, fields) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length || fields.some(k => !Object.prototype.hasOwnProperty.call(v, k))) invalid();
  };
  const text = (v, max, empty = false) => { if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()) || v.includes('\u0000')) invalid(); return v; };
  const id = v => { text(v,128); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)) invalid(); return v; };
  const revision = v => { if (!Number.isSafeInteger(v) || v < 1) invalid(); return v; };
  const boolean = v => { if (typeof v !== 'boolean') invalid(); return v; };
  const list = (v, convert) => { if (!Array.isArray(v) || v.length > 16) invalid(); const next=v.map(convert); if(new Set(next.map(x=>x.id)).size!==next.length)invalid(); return next; };
  function profile(v) {
    object(v,['revision','id','name','systemPrompt','skills','mcp']);
    const skills=list(v.skills,s=>{object(s,['id','title','content','enabled']); return {id:id(s.id),title:text(s.title,128),content:text(s.content,8000,true),enabled:boolean(s.enabled)};});
    if(skills.reduce((sum,s)=>sum+s.content.length,0)>24000)invalid();
    return {revision:revision(v.revision),id:id(v.id),name:text(v.name,128),systemPrompt:text(v.systemPrompt,8000,true),skills,mcp:list(v.mcp,m=>{object(m,['id','label','enabled']);return {id:id(m.id),label:text(m.label,128),enabled:boolean(m.enabled)};})};
  }
  function applied(v, savedRevision) {
    if(v===null)return null;
    if(!v || !['applied','failed'].includes(v.status))invalid();
    object(v,v.status==='failed'?['appliedRevision','status','errorCode']:['appliedRevision','status']);
    if(revision(v.appliedRevision)>savedRevision)invalid();
    if(v.status==='failed'&&!['MODEL_UNAVAILABLE','PERSIST_FAILED','INVALID_PROFILE','TOOLS_UNAVAILABLE','APPLY_FAILED'].includes(v.errorCode))invalid();
    return v;
  }
  function matches(receipt, intent) {
    try {
      object(receipt,['idempotencyKey','savedRevision','profile','applied']);
      if(receipt.idempotencyKey!==intent.idempotencyKey || revision(receipt.savedRevision)!==intent.profile.revision)return false;
      applied(receipt.applied,receipt.savedRevision);
      return JSON.stringify(profile(receipt.profile))===JSON.stringify(profile(intent.profile));
    } catch (_) { return false; }
  }
  // Lookup returns the authenticated HTTP envelope. Missing or uncertain history is never proof of failure.
  async function resolveHistorical(intent, lookup) {
    const response=await lookup(intent.idempotencyKey);
    return Boolean(response && response.status===200 && response.body?.code===0 && matches(response.body.data?.receipt,intent));
  }
  return {profile,applied,matches,resolveHistorical};
}
