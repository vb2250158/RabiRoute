import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { operationIsReadOnly, markOperationEffect, selectedOperationReadOnly } from '../lib/api-operation-effects.mjs';
import { createManagerClient } from '../lib/manager-client.mjs';
const contract={operationId:'fixture.computer',contractVersion:'1.0.0',method:'POST',pathTemplate:'/api/computer',transport:'http',
 request:{body:{kind:'json'}},effects:{mode:'write',request:{bodyPath:['action'],modes:{status:'read',execute:'write'}}}};
const meta={applicationGenerationId:'app',managerInstanceId:'manager',health:{live:true,state:'healthy'}};
const catalog={schemaVersion:'2',...meta,pluginGenerationId:'plugin',catalogRevision:1,catalogDigest:'sha256:'+ 'a'.repeat(64),coverage:{complete:true,gaps:[]},nextCursor:'',
 operations:[{id:contract.operationId,contractDigest:'sha256:'+ 'b'.repeat(64),contract}]};
test('request effect comes from the selected action table; opaque and unknown bodies retain mutation effect',()=>{
 assert.equal(operationIsReadOnly(contract,'POST',{action:'status'}),true);
 assert.equal(operationIsReadOnly(contract,'POST',JSON.stringify({action:'status'})),true);
 for(const body of [{action:'execute'},{action:'other'},undefined,'{'])assert.equal(operationIsReadOnly(contract,'POST',body),false);
 assert.equal(selectedOperationReadOnly({readOnly:true,effect:'read'}),undefined);
 const body={action:'status'};const options=markOperationEffect({body},contract,'POST');body.action='execute';
 assert.equal(options.body,'{"action":"status"}');assert.equal(selectedOperationReadOnly(options),true);
});
for(const action of ['status','execute'])test(`mixed POST ${action} has accurate failed-read/unknown-write outcome and is sent only once`,async()=>{
 let sends=0;const client=createManagerClient({managerUrl:'http://fixture.invalid',credential:'fixture-only',agentType:'codex',sessionId:'fixture',
 fetchImpl:async(url)=>{const target=new URL(url).pathname;
 if(target==='/meta')return Response.json(meta);
 if(target==='/api/agent/help')return Response.json({code:0,data:catalog});
 assert.equal(target,'/api/computer');sends++;throw new Error('fixture interrupted');}});
 const result=await client.catalog.invokeOperation('fixture.computer',{body:{action},readOnly:true});
 assert.equal(sends,1);assert.equal(result.uncertain,action==='execute');assert.equal(result.ok,false);
});
test('GET no-replay is still a failed read when postflight identity changes',async()=>{
 let sent=0,metas=0;const client=createManagerClient({managerUrl:'http://fixture.invalid',credential:'fixture-only',fetchImpl:async url=>{
 if(new URL(url).pathname==='/meta')return Response.json({...meta,managerInstanceId:++metas===1?'manager':'new-manager'});
 sent++;throw new Error('fixture interrupted');}});
 const result=await client.request('GET','/api/readonly',{replaySafe:false});assert.equal(sent,1);assert.equal(result.identityChanged,true);assert.equal(result.uncertain,false);
});

for(const action of ['status','execute'])test(`mixed POST ${action} file output keeps selected effect and never commits partial output`,async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'rabi-effect-output-'));let sends=0;
 try {const client=createManagerClient({managerUrl:'http://fixture.invalid',credential:'fixture-only',fetchImpl:async url=>{
 const target=new URL(url).pathname;if(target==='/meta')return Response.json(meta);if(target==='/api/agent/help')return Response.json({code:0,data:catalog});
 sends++;return new Response('fixture failed',{status:503});}});
 const result=await client.catalog.invokeOperation('fixture.computer',{body:{action},outputPath:path.join(temp,'result.bin')});
 assert.equal(sends,1);assert.equal(result.uncertain,action==='execute');assert.equal(result.outputCommitted,false);
 }finally{await rm(temp,{recursive:true,force:true});}
});
