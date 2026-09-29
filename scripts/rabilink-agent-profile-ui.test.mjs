import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createProfileReceiptPolicy} from './rabilink-agent-profile-ui-receipt.mjs';
import {createProfileMcpEditor} from './rabilink-profile-mcp-editor.mjs';
import {createProfileSkillsEditor} from './rabilink-profile-skills-editor.mjs';
const source = await fs.readFile(new URL('./rabilink-relay-server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('    function renderAgentProfileEditor(');
const code = source.slice(start, source.indexOf('\n    function render() {', start));
const profile = revision => ({revision,id:'assistant',name:'<img src=x onerror=alert(1)>',systemPrompt:'Prompt',skills:[],mcp:[]});
const settle = () => new Promise(resolve => setImmediate(resolve));
// Minimal DOM harness, no external dependencies. Executes the actual page helper;
// it is not a browser/layout test. innerHTML is captured separately from value/text.
class Element {
 constructor() { this.fields=new Map(); this.children=[]; this.listeners={}; this.style={}; this.disabled=false; this.value=''; this.textContent=''; }
 set innerHTML(value) { this.html=value; for(const match of value.matchAll(/class="profile-([a-z]+)"/g)) this.fields.set(match[1],new Element()); }
 querySelector(selector) { return this.fields.get(selector.replace('.profile-','')) || null; }
 querySelectorAll() { return [...this.fields.values()]; }
 addEventListener(name,fn) { this.listeners[name]=fn; }
 click() { if(!this.disabled) return this.listeners.click?.(); }
 appendChild(node) { this.children.push(node); }
 remove() { this.removed=true; }
 replaceChildren(){this.children=[];}
 setAttribute(){}
}
function storage() { const map=new Map(); return {map,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}; }
function fixture(replies,{owner='owner',store=storage()}={}) {
 const container=new Element(),calls=[];
 const context=vm.createContext({createProfileReceiptPolicy,createProfileSkillsEditor,createProfileMcpEditor,state:{account:{id:owner}},sessionStorage:store,pendingProfileWrites:new Set(),document:{createElement:()=>new Element()},apiBase:'/manage/api',headers:()=>({}),crypto:{randomUUID:()=> 'stable-key'},fetch:async(path,options)=>{calls.push({path,options}); const item=await replies.shift(); if(item instanceof Error)throw item; return {ok:item.status<400,status:item.status,json:async()=>item.body};},container});
 vm.runInContext(code+'\nrenderAgentProfileEditor(container,"app/a","binding");',context);
 return {context,calls,store,panel:container.children[0],find:s=>container.children[0].querySelector('.profile-'+s)};
}
test('late save from previous owner retains intent without blocking new account',async()=>{let release;const delayed=new Promise(r=>release=r);const f=fixture([read(1),delayed]);await settle();const saving=f.find('save').click();await settle();assert.equal(f.find('id').disabled,true);f.context.state.account={id:'new-owner'};f.context.pendingProfileWrites.clear();release({status:200,body:{code:0,data:{idempotencyKey:'profile-stable-key',savedRevision:2,profile:profile(2),applied:null}}});await saving;assert.equal(f.store.map.size,1);assert.equal(f.context.pendingProfileWrites.size,0);assert.equal(f.find('save').disabled,true);assert.match(f.find('state').textContent,/账号已变化/);});
test('empty MCP label and invalid advanced JSON send no PUT',async()=>{const f=fixture([read()]);await settle();const box=f.find('mcp');const visual=box.children[2];const enabled=visual.children[1].children[0];enabled.checked=true;enabled.listeners.change();const label=visual.children[2].children[0];label.value='';label.listeners.input();f.find('save').click();await settle();assert.equal(f.calls.length,1);box.children[3].click();box.children[4].value='[';f.find('save').click();await settle();assert.equal(f.calls.length,1);assert.equal(box.children[4].value,'[');});
const read = (revision=0)=>({status:200,body:{code:0,data:{savedRevision:revision,profile:revision?profile(revision):null,applied:null}}});
test('safe values, frozen body, CSRF header and double-click prevention',async()=>{
 const f=fixture([read(1),{status:200,body:{code:0,data:{idempotencyKey:'profile-stable-key',savedRevision:2,profile:profile(2),applied:null}}}]); await settle();
 assert.ok(!f.panel.html.includes('<img')); assert.match(f.find('name').value,/<img/);
 f.find('save').click(); f.find('save').click(); await settle();
 assert.equal(f.calls.length,2); assert.equal(f.calls[1].options.headers['X-RabiLink-Profile-Write'],'1'); assert.equal(JSON.parse(f.calls[1].options.body).expectedRevision,1); assert.equal(f.store.map.size,0);
});
test('uncertain writes survive hard refresh and never replay',async()=>{
 const store=storage(); const f=fixture([read(1),new Error('network')],{store}); await settle(); f.find('save').click(); await settle();
 assert.equal(store.map.size,1); const frozen=[...store.map.values()][0]; assert.equal(f.find('save').disabled,true);
 const refresh=fixture([read(1),{status:200,body:{code:0,data:{receipt:null}}},read(3),{status:200,body:{code:0,data:{receipt:{idempotencyKey:'profile-stable-key',savedRevision:2,profile:profile(2),applied:null}}}}],{store}); await settle(); assert.equal(refresh.find('save').disabled,true); assert.equal(refresh.calls.length,2); assert.equal([...store.map.values()][0],frozen);
 refresh.find('read').click(); await settle(); assert.equal(store.map.size,0); assert.equal(refresh.find('save').disabled,false); assert.equal(refresh.calls.length,4); assert.match(refresh.find('state').textContent,/已保存版本：3/); assert.match(refresh.calls[3].path,/operations\/profile-stable-key$/);
});
test('bad successful receipt keeps frozen pending intent',async()=>{
 for(const bad of [{revision:2,name:'WRONG'},{...profile(2),name:'WRONG'}]) {
  const f=fixture([read(1),{status:200,body:{code:0,data:{idempotencyKey:'profile-stable-key',savedRevision:2,profile:bad,applied:null}}}]);
  await settle(); f.find('save').click(); await settle(); assert.equal(f.store.map.size,1); assert.equal(f.find('save').disabled,true); assert.match(f.find('state').textContent,/不确定/);
 }
});
test('other owners cannot restore or expose an existing pending draft',async()=>{
 const store=storage(); const f=fixture([read(1),new Error('network')],{store}); await settle(); f.find('save').click(); await settle();
 const other=fixture([read()],{store,owner:'other'}); await settle(); assert.equal(other.find('name').value,'眼镜助手'); assert.equal(other.find('save').disabled,false); assert.equal(store.map.size,1);
 const denied=fixture([{status:403,body:{code:403}}],{store}); await settle(); assert.equal(denied.find('name').value,''); assert.equal(denied.find('save').disabled,true);
});
test('session storage failure prevents sending any mutation',async()=>{
 const store=storage(); store.setItem=()=>{throw new Error('quota')}; const f=fixture([read()],{store}); await settle(); f.find('save').click(); await settle(); assert.equal(f.calls.length,1); assert.equal(f.find('save').disabled,true); assert.match(f.find('state').textContent,/未发送/);
});
test('412 requires fresh read; capacity explains limit and clears refused draft',async()=>{
 const f=fixture([read(),{status:412,body:{code:'PROFILE_REVISION_CONFLICT'}},read(1),{status:409,body:{code:'PROFILE_RECEIPT_CAPACITY'}}]); await settle(); f.find('save').click(); await settle(); assert.equal(f.find('save').disabled,true); assert.equal(f.store.map.size,0);
 f.find('read').click(); await settle(); f.find('save').click(); await settle(); assert.match(f.find('state').textContent,/128/); assert.equal(f.store.map.size,0);
});
