import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {knowledgeOutcome,normalizeKnowledgeIntents} from './rabilink-knowledge-operations.mjs';
const source=fs.readFileSync('scripts/rabilink-relay-server.mjs','utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('      if (authorized.nonReplayable) {\n        let outcome;');
const end=source.indexOf('      if (!finished.response)',start);
assert(start>0&&end>start);
const branch=source.slice(start,end);
const key='fixture-key';
const row={key,hash:'a'.repeat(64),scope:{ownerAccountId:'owner',targetDeviceId:'pc',roleId:'role',tool:'recent_memory_create',credentialHash:'private-scope'}};
function fixture(){
 let durable={apps:[{id:'app',deviceBindings:[{id:'device',knowledgeIntents:[structuredClone(row)]}]}],workers:[]};
 const events=[],responses=[];let writes=0;
 const context={authorized:{nonReplayable:true},request:{id:'knowledge-fixture'},result:{structuredContent:{ok:true,statusCode:201,uncertain:false,commitState:'committed',idempotencyKey:key,etag:'"v1"',data:{id:'memory',content:'private-body'}}},finished:{response:{statusCode:200}},body:{args:{idempotencyKey:key}},match:{app:{id:'app'},deviceBinding:{id:'device',credentialHash:'private-scope'}},knowledgeOutcome,normalizeKnowledgeIntents,readAppStore:()=>structuredClone(durable),writeAppStore:s=>{writes++;durable=structuredClone(s);},writeEvent:(name,data)=>events.push({name,data}),res:{},sendJson:(_r,status,data)=>responses.push({status,data})};
 return {context,events,responses,get durable(){return durable;},get writes(){return writes;},run:()=>vm.runInNewContext(`(async()=>{${branch}})()`,context)};
}
for(const stage of ['validate','read','normalize','lookup','write']) test(`actual persistence ${stage} failure is uncertain with bounded diagnostics`,async()=>{
 const f=fixture(); const error=()=>{throw Object.assign(new Error('private-body private-scope fixture-key'),{code:stage==='write'?'EPERM':'PRIVATE_SECRET'});};
 if(stage==='validate') f.context.knowledgeOutcome=error;
 if(stage==='read') f.context.readAppStore=error;
 if(stage==='normalize') f.context.normalizeKnowledgeIntents=error;
 if(stage==='lookup') f.context.normalizeKnowledgeIntents=()=>[];
 if(stage==='write') f.context.writeAppStore=error;
 await f.run();assert.equal(f.responses.length,1);assert.equal(f.responses[0].status,503);assert.equal(f.responses[0].data.uncertain,true);assert(!f.durable.apps[0].deviceBindings[0].knowledgeIntents[0].outcome);
 assert.equal(f.events.length,1);assert.equal(f.events[0].name,'knowledge_receipt_persistence_failed');assert.deepEqual(JSON.parse(JSON.stringify(f.events[0].data)),{requestId:'knowledge-fixture',stage,code:stage==='write'?'EPERM':'UNKNOWN'});
});
test('diagnostic failure cannot suppress uncertain response or retry storage',async()=>{const f=fixture();let calls=0;f.context.writeAppStore=()=>{calls++;throw new Error('write failed');};f.context.writeEvent=()=>{throw new Error('log failed');};await f.run();assert.equal(calls,1);assert.equal(f.responses[0].status,503);assert.equal(f.responses[0].data.uncertain,true);});
test('confirmed outcome survives actual worker heartbeat store normalization',async()=>{
 const f=fixture();await f.run();assert.equal(f.writes,1);assert.equal(f.durable.apps[0].deviceBindings[0].knowledgeIntents[0].outcome.state,'confirmed');
 const from=source.indexOf('function recordWorkerSeen('),to=source.indexOf('\nfunction recordWorkerDisconnected(',from);assert(from>0&&to>from);
 const ctx={...f.context,sanitizeRabiLinkId:x=>x,stringValue:x=>String(x||''),nowIso:()=> 'fixture-time',normalizeWorkerDeviceKind:x=>x||'',normalizeWorkerCapabilities:x=>x||[],normalizeWorkerPeerUrls:x=>x||[],writeAccountLogForApp:()=>{},relayEventHub:{publish:()=>{}},readAppStore:()=>{const s=structuredClone(f.durable);for(const a of s.apps)for(const b of a.deviceBindings)b.knowledgeIntents=normalizeKnowledgeIntents(b.knowledgeIntents);return s;}};
 vm.runInNewContext(source.slice(from,to)+'\nrecordWorkerSeen("app","pc","PC","",[],[],"pc");',ctx);
 assert.equal(f.writes,2);assert.equal(f.durable.workers.length,1);assert.equal(f.durable.apps[0].deviceBindings[0].knowledgeIntents[0].outcome.state,'confirmed');assert.equal(f.events.length,0);
});
