import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeGrantEditor} from './rabilink-knowledge-grant-ui.mjs';
import {createKnowledgeGrantService} from './rabilink-knowledge-grant.mjs';
class Node {constructor(){this.children=[];this.style={};this.value='';this.checked=false;this.events={};}appendChild(n){this.children.push(n);}addEventListener(k,f){this.events[k]=f;}click(){if(!this.disabled)return this.events.click();}remove(){this.removed=true;}}
const tick=()=>new Promise(r=>setImmediate(r));
const grant={allowedRoles:['role'],allowedTools:['plan_list'],allowWrites:false};
const view=(revision=1)=>({status:200,data:{revision,grant}});
function fixture(replies, store=new Map(),owner='owner'){
 const calls=[];const env={state:{account:{id:owner},workers:[]},apiBase:'/manage/api',document:{createElement:()=>new Node()},pending:new Set(),storage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},headers:json=>json?{'Content-Type':'application/json'}:{},uuid:()=> 'test-key',fetch:async(path,options)=>{calls.push({path,options});const r=await replies.shift();if(r instanceof Error)throw r;return {ok:r.status<400,status:r.status,json:async()=>({code:0,data:r.data})};}};
 const editor=createKnowledgeGrantEditor(env); const ui=editor.render(new Node(),{id:'app'},'device');return {env,editor,ui,calls,store};
}
test('late owner response cannot reinsert detached pending panel',async()=>{let release;const wait=new Promise(r=>release=r);const f=fixture([view(),wait]);await tick();const saving=f.ui.nodes.save.click();await tick();f.env.state.account={id:'new-owner'};f.env.pending.clear();release({status:200,data:{idempotencyKey:'grant-test-key',revision:2,grant}});await saving;assert.equal(f.store.size,1);assert.equal(f.env.pending.size,0);assert.equal(f.ui.nodes.roles.disabled,true);assert.equal(f.ui.nodes.read.disabled,true);});
test('explicit writes off, CSRF, double click, strict full receipt',async()=>{
 const f=fixture([view(),{status:200,data:{idempotencyKey:'grant-test-key',revision:2,grant}}]);await tick();assert.equal(f.ui.nodes.writes.checked,false);f.ui.nodes.save.click();f.ui.nodes.save.click();await tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.headers['X-RabiLink-Profile-Write'],'1');assert.equal(f.store.size,0);
 assert.equal(f.editor.matches({idempotencyKey:'grant-test-key',revision:2,grant:{...grant,allowWrites:true}},{expectedRevision:1,idempotencyKey:'grant-test-key',grant}),false);
});
test('unknown survives refresh and historical receipt resolves superseded write',async()=>{
 const f=fixture([view(),new Error('lost')]);await tick();await f.ui.nodes.save.click();assert.equal(f.store.size,1);
 const refreshed=fixture([view(3),{status:200,data:{receipt:{idempotencyKey:'grant-test-key',revision:2,grant}}}],f.store);await tick();assert.equal(f.store.size,0);assert.match(refreshed.ui.nodes.status.textContent,/版本：3/);assert.equal(refreshed.calls.every(c=>!c.options.method),true);
});
test('bad receipt and missing history keep pending, other owner never restores',async()=>{
 const f=fixture([view(),{status:200,data:{idempotencyKey:'grant-test-key',revision:2,grant:{bad:true}}}]);await tick();await f.ui.nodes.save.click();assert.equal(f.store.size,1);
 const r=fixture([view(),{status:200,data:{receipt:null}}],f.store);await tick();assert.equal(r.ui.nodes.save.disabled,true);
 const other=fixture([view()],f.store,'other');await tick();assert.equal(other.calls.length,1);assert.equal(other.ui.nodes.save.disabled,false);
});
test('failed storage prevents mutation and unknown fields rejected',async()=>{
 const f=fixture([view()]);await tick();f.env.storage.setItem=()=>{throw new Error('quota');};await f.ui.nodes.save.click();assert.equal(f.calls.length,1);assert.throws(()=>f.editor.grant({...grant,url:'http://host'}));
});
test('inputs freeze until initial read and while pending receipt',async()=>{
  const f=fixture([view(),new Error('lost')]);
  const inputs=()=>[f.ui.nodes.roles,f.ui.nodes.writes,...Object.values(f.ui.nodes.tools)];
  assert(inputs().every(n=>n.disabled));await tick();assert(inputs().every(n=>!n.disabled));
  const saving=f.ui.nodes.save.click();assert(inputs().every(n=>n.disabled));await saving;assert(inputs().every(n=>n.disabled));
});
test('history is owner-scoped and returns original receipt after newer version',()=>{
 let store={apps:[{id:'app',ownerAccountId:'owner',deviceBindings:[{id:'device'}]}]};const service=createKnowledgeGrantService({readStore:()=>store,writeStore:s=>{store=s;}});
 const first=service.save('owner','app','device',{expectedRevision:0,idempotencyKey:'one',grant});service.save('owner','app','device',{expectedRevision:1,idempotencyKey:'two',grant:{...grant,allowWrites:true}});
 assert.deepEqual(service.readOperation('owner','app','device','one'),{receipt:first});assert.throws(()=>service.readOperation('other','app','device','one'),/DEVICE_NOT_FOUND/);assert.deepEqual(service.readOperation('owner','app','device','missing'),{receipt:null});
});
