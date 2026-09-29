// Self-contained browser factory: injected dependencies avoid secrets and a second state store.
export function createKnowledgeGrantEditor(env) {
  const names = ['knowledge_search','plan_list','plan_get','plan_statuses','memory_list','memory_get','plan_create','plan_update','recent_memory_create','recent_memory_update'];
  function grant(value) {
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'allowWrites,allowedRoles,allowedTools') throw new Error('INVALID_GRANT');
    for (const key of ['allowedRoles','allowedTools']) if (!Array.isArray(value[key]) || value[key].length > 64 || value[key].some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x)) || new Set(value[key]).size !== value[key].length) throw new Error('INVALID_GRANT');
    if (typeof value.allowWrites !== 'boolean' || value.allowedTools.some(x => !names.includes(x))) throw new Error('INVALID_GRANT');
    return {allowedRoles:[...value.allowedRoles].sort(),allowedTools:[...value.allowedTools].sort(),allowWrites:value.allowWrites};
  }
  function matches(receipt,input) {
    try { return receipt && Object.keys(receipt).sort().join(',') === 'grant,idempotencyKey,revision' && receipt.idempotencyKey === input.idempotencyKey && receipt.revision === input.expectedRevision+1 && JSON.stringify(grant(receipt.grant)) === JSON.stringify(grant(input.grant)); } catch { return false; }
  }
  function render(container, app, bindingId) {
    const owner=env.state.account?.id, panel=env.document.createElement('div');
    panel.className='tile'; panel.profileOwnerId=owner;
    if (!owner) return;
    const endpoint=env.apiBase+'/apps/'+encodeURIComponent(app.id)+'/devices/'+encodeURIComponent(bindingId)+'/knowledge-grant';
    const key='rabilink-grant-pending:'+JSON.stringify([owner,app.id,bindingId]);
    const nodes={};
    function node(tag,text,parent=panel) { const n=env.document.createElement(tag); if(text)n.textContent=text; parent.appendChild(n); return n; }
    node('h3','眼镜知识授权');
    const worker=env.state.workers?.find(w=>w.id===app.targetDeviceId && w.appId===app.id);
    node('p',!app.targetDeviceId?'尚未明确选择 PC，知识调用不可用。':!worker?.capabilities?.some(x=>String(x).toLowerCase()==='knowledgebridge')?'所选 PC 的知识桥未就绪。':'PC 已广告知识桥；仍须核对本机设备授权，保存不等于已生效。');
    node('p','仅配置角色与工具授权。PC 地址、Token 和连接凭据由 PC 本机管理。实际权限取设备授权、本机授权与 MCP 服务授权的交集。');
    const roleLabel=node('label','允许的角色 ID（空格或逗号分隔；需与 PC 已有角色一致）'); nodes.roles=node('textarea','',roleLabel); nodes.roles.rows=3; nodes.roles.style.width='100%';
    function checkRow(label) { Object.assign(label.style,{display:'flex',alignItems:'center',gap:'8px',minHeight:'44px',overflowWrap:'anywhere'}); }
    function checkInput(input) { Object.assign(input.style,{flexShrink:'0',width:'20px',height:'20px'}); input.type='checkbox'; input.checked=false; }
    nodes.tools={}; names.forEach(name=>{const label=node('label');checkRow(label);const input=node('input','',label);checkInput(input);node('span',name,label);nodes.tools[name]=input;});
    const writeLabel=node('label');checkRow(writeLabel);nodes.writes=node('input','',writeLabel);checkInput(nodes.writes);node('span','允许写入（默认关闭）：可创建或修改计划、记忆；近期记忆详情也会更新阅读时间。',writeLabel);
    nodes.status=node('p'); nodes.status.setAttribute?.('role','status');
    nodes.save=node('button','保存授权'); nodes.read=node('button','回读 / 刷新'); nodes.close=node('button','关闭');
    let revision=null,pending=null,busy=false,blocked=false;
    function lock(value) { busy=value; const ownerChanged=env.state.account?.id!==owner; if(pending&&!ownerChanged)env.pending.add(panel);else env.pending.delete(panel); const frozen=ownerChanged||value||blocked||pending!==null||revision===null; nodes.roles.disabled=frozen; Object.values(nodes.tools).forEach(input=>{input.disabled=frozen;}); nodes.writes.disabled=frozen; nodes.save.disabled=frozen; nodes.read.disabled=value||ownerChanged; nodes.close.disabled=value||pending!==null; }
    const status=text=>{nodes.status.textContent=text;};
    const clear=()=>{env.storage.removeItem(key);pending=null;};
    async function get(path) { const response=await env.fetch(path,{headers:env.headers(false),credentials:'same-origin'}); const body=await response.json(); if(!response.ok||body.code!==0)throw new Error('READ_FAILED'); return body.data; }
    async function read() {
      if(busy)return; lock(true);
      try {
        const view=await get(endpoint); if(env.state.account?.id!==owner)throw new Error('OWNER_CHANGED');
        if(!Number.isSafeInteger(view.revision)||view.revision<0)throw new Error('INVALID_REVISION'); const value=grant(view.grant);
        if(!pending) { const raw=env.storage.getItem(key); if(raw) { const saved=JSON.parse(raw); if(saved.owner!==owner||saved.appId!==app.id||saved.bindingId!==bindingId)throw new Error('OWNER_CHANGED'); const input=JSON.parse(saved.body); grant(input.grant); if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!/^grant-[A-Za-z0-9-]+$/.test(input.idempotencyKey))throw new Error('INVALID_PENDING'); pending=input; } }
        if(pending) { const history=await get(endpoint+'/operations/'+encodeURIComponent(pending.idempotencyKey)); if(env.state.account?.id!==owner)throw new Error('OWNER_CHANGED'); if(!matches(history.receipt,pending)){status('原授权写入尚未确认，保留原键与正文；只回读，不自动重发。');return;} }
        clear(); revision=view.revision; nodes.roles.value=value.allowedRoles.join(', '); names.forEach(name=>{nodes.tools[name].checked=value.allowedTools.includes(name);}); nodes.writes.checked=value.allowWrites;
        status('已保存授权版本：'+revision+'；权限生效尚未验证，本机 grant 仍必需。刷新会覆盖未保存编辑。');
      } catch { status('回读失败或原操作尚未确认，保留当前内容；请核对登录和网络。'); try { if(!pending && env.storage.getItem(key))blocked=true; } catch { blocked=true; } } finally {lock(false);}
    }
    async function save() {
      if(busy||pending||blocked||revision===null||env.state.account?.id!==owner)return;
      let input; try {input={expectedRevision:revision,idempotencyKey:'grant-'+env.uuid(),grant:grant({allowedRoles:nodes.roles.value.split(/[\s,，]+/u).filter(Boolean),allowedTools:names.filter(name=>nodes.tools[name].checked),allowWrites:nodes.writes.checked})};}catch{status('角色 ID 或授权字段无效，未发送。');return;}
      const body=JSON.stringify(input); pending=input;
      try {env.storage.setItem(key,JSON.stringify({owner,appId:app.id,bindingId,body}));if(JSON.parse(env.storage.getItem(key)).body!==body)throw new Error();}catch{pending=null;blocked=true;status('无法保存原请求，未发送。');lock(false);return;}
      lock(true);
      try {
        const response=await env.fetch(endpoint,{method:'PUT',credentials:'same-origin',headers:{...env.headers(true),'X-RabiLink-Profile-Write':'1'},body}); const result=await response.json();
        if(env.state.account?.id!==owner){status('账号已变化，保留原请求等待同账号回读。');return;}
        if(response.status===412){clear();revision=null;status('版本冲突，请回读后重新确认。');return;}
        if(response.ok&&result.code===0&&matches(result.data,input)){clear();revision=result.data.revision;status('授权已保存，版本 '+revision+'；尚未验证 PC 本机授权和实际调用。');return;}
        if(response.status>=400&&response.status<500){clear();status(result.code==='KNOWLEDGE_RECEIPT_CAPACITY'||result.message==='KNOWLEDGE_RECEIPT_CAPACITY'?'128 条回执容量已满，禁止换键重试，请联系维护者。':'授权被拒绝，未自动重试。');return;}
        status('回执不完整或结果未知；保留原请求，只回读，不重发或换键。');
      }catch{status('网络异常，结果未知；原请求保存在当前标签页会话，刷新可恢复，关闭标签页可能丢失。');}finally{lock(false);}
    }
    nodes.save.addEventListener('click',save);nodes.read.addEventListener('click',read);nodes.close.addEventListener('click',()=>{if(!busy&&!pending)panel.remove();});
    container.appendChild(panel);lock(false);void read();return {panel,nodes};
  }
  return {render,grant,matches};
}
