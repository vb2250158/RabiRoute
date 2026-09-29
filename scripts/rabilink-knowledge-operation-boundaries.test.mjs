import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {knowledgeOutcome,normalizeKnowledgeIntents} from './rabilink-knowledge-operations.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const key='persist-key';
const receipt={ok:true,statusCode:201,uncertain:false,commitState:'committed',idempotencyKey:key,etag:'"v1"',data:{id:'memory-1',content:'private fixture'}};
const scope={ownerAccountId:'owner',targetDeviceId:'pc',roleId:'example',tool:'recent_memory_create',credentialHash:digest('rbd_first')};
const intent={key,hash:'a'.repeat(64),scope};
test('actual Relay persistence branch returns only uncertain when atomic store write throws',async()=>{
 const source=fs.readFileSync('scripts/rabilink-relay-server.mjs','utf8').replace(/\r\n/g,'\n');
 const start=source.indexOf('      if (authorized.nonReplayable) {\n        let outcome;');
 const end=source.indexOf('      if (!finished.response)',start);
 assert(start>0&&end>start);
 const outputs=[];let writes=0;
 const store={apps:[{id:'app',deviceBindings:[{id:'first',knowledgeIntents:[structuredClone(intent)]}]}]};
 const context={authorized:{nonReplayable:true},result:{structuredContent:receipt},finished:{response:{statusCode:200}},body:{args:{idempotencyKey:key}},match:{app:{id:'app'},deviceBinding:{id:'first',credentialHash:scope.credentialHash}},knowledgeOutcome,normalizeKnowledgeIntents,readAppStore:()=>structuredClone(store),writeAppStore:()=>{writes++;throw new Error('fixture atomic persistence failure');},res:{},sendJson:(_res,status,data)=>{outputs.push({status,data});}};
 await vm.runInNewContext(`(async()=>{${source.slice(start,end)}})()`,context);
 assert.equal(writes,1);assert.equal(outputs.length,1);assert.equal(outputs[0].status,503);assert.equal(outputs[0].data.uncertain,true);assert.equal(outputs[0].data.ok,false);assert.equal(outputs[0].data.code,'KNOWLEDGE_RECEIPT_NOT_PERSISTED');assert(!store.apps[0].deviceBindings[0].knowledgeIntents[0].outcome);
});
test('real HTTP operation lookup isolates bindings and rechecks current owner and target',{timeout:15000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-boundaries-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:directory},stdio:'ignore'});
 async function req(route,method='GET',body,headers={}){const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 try {
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}assert(ready);
  const owner=await req('/manage/api/accounts','POST',{username:'receipt-owner',password:'test-only-safe-password'});
  const created=await req('/manage/api/apps','POST',{name:'receipt-boundaries'},{cookie:owner.cookie});assert.equal(created.status,200);
  const file=path.join(directory,'apps.json');const store=JSON.parse(fs.readFileSync(file,'utf8'));const app=store.apps[0];app.targetDeviceId='pc';
  const row={...intent,scope:{...scope,ownerAccountId:app.ownerAccountId},outcome:knowledgeOutcome({structuredContent:receipt},200,key)};
  const grant={revision:1,grant:{allowedRoles:['example'],allowedTools:['recent_memory_create'],allowWrites:true},operations:[]};
  app.deviceBindings=[{id:'first',serialHash:'first',credentialHash:digest('rbd_first'),knowledgeGrantState:grant,knowledgeIntents:[row]},{id:'second',serialHash:'second',credentialHash:digest('rbd_second'),knowledgeGrantState:grant,knowledgeIntents:[]}];fs.writeFileSync(file,JSON.stringify(store));
  const route='/api/rabilink/device/knowledge/operations/'+key;
  const first=await req(route,'GET',null,{'x-rabilink-token':'rbd_first'});assert.equal(first.body.data.state,'confirmed');
  const second=await req(route,'GET',null,{'x-rabilink-token':'rbd_second'});assert.equal(second.status,200);assert.equal(second.body.data.state,'unknown');assert(!second.body.data.receipt);assert(!JSON.stringify(second.body).includes('private fixture'));
  const original=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const change of [a=>a.ownerAccountId='different-owner',a=>a.targetDeviceId='different-pc']){const changed=structuredClone(original);change(changed.apps[0]);fs.writeFileSync(file,JSON.stringify(changed));const denied=await req(route,'GET',null,{'x-rabilink-token':'rbd_first'});assert.equal(denied.status,403);assert(!JSON.stringify(denied.body).includes('private fixture'));}
 } finally {if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(directory,{recursive:true,force:true});}
});
