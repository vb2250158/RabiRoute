import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { RabiLinkRelayRuntime } from '../src/manager/rabiLinkRelayRuntime.js';
// @ts-ignore independent MCP application fixture
import { startKnowledgeHttpServer } from '../apps/rabi-mcp/lib/knowledge-http-server.mjs';

test('device HTTP -> real Relay worker -> official MCP HTTP -> device result', {timeout:30000}, async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-e2e-')); const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(r=>listener.close(()=>r()));const base=`http://127.0.0.1:${port}`;
 const abortDevice=new AbortController();
 let calls=0, writeCalls=0;const token='fixture-only-knowledge-e2e-token-123456789';
 const mcp=await startKnowledgeHttpServer({token,tools:{list:()=>[{name:'plan_list',description:'fixture',inputSchema:{type:'object',properties:{roleId:{type:'string'}},required:['roleId']},annotations:{readOnlyHint:true}},{name:'recent_memory_create',description:'fixture write',inputSchema:{type:'object',properties:{roleId:{type:'string'},idempotencyKey:{type:'string'},body:{type:'object'}},required:['roleId','idempotencyKey','body']}}],call:async(name:string,args:any)=>{if(name==='recent_memory_create'){writeCalls++;if(args.idempotencyKey==='confirmed-key') { abortDevice.abort(); return {ok:true,statusCode:201,uncertain:false,commitState:'committed',idempotencyKey:args.idempotencyKey,etag:'"fixture-etag"',data:{id:'fixture-memory',content:'fixture only'}};}return {ok:false,uncertain:true,code:'FIXTURE_WRITE_UNKNOWN'};}calls++;return {ok:true,plans:[{id:'fixture-plan'}]};}}});
 let child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:directory},stdio:'ignore'});
 const runtime=new RabiLinkRelayRuntime({channelRetryDelayMs:30});
 async function req(route:string,method='GET',body?:unknown,headers:Record<string,string>={}){const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};}
 try {
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready);
  const owner=await req('/manage/api/accounts','POST',{username:'e2e-owner',password:'test-only-safe-password'});const created=await req('/manage/api/apps','POST',{name:'e2e-fixture'},{cookie:owner.cookie});assert.equal(created.status,200);
  const app=created.body.app;const file=path.join(directory,'apps.json');const store=JSON.parse(fs.readFileSync(file,'utf8'));const accountId=store.apps[0].ownerAccountId;
  store.apps[0].targetDeviceId='fixture-pc';store.apps[0].deviceBindings=[{id:'glass',serialHash:'fixture-serial',credentialHash:createHash('sha256').update('rbd_e2e').digest('hex'),knowledgeGrantState:{revision:1,grant:{allowedRoles:['example'],allowedTools:['plan_list','recent_memory_create'],allowWrites:true},operations:[]}}];fs.writeFileSync(file,JSON.stringify(store));
  await runtime.sync({enabled:true,url:base,token:app.token,deviceId:'fixture-pc',deviceGuid:'different-guid',deviceName:'Fixture PC',claimWaitMs:50,localWebguiUrl:'http://127.0.0.1:1',speechProxyEnabled:false,localSpeechUrl:'',knowledgeBridge:{enabled:true,url:mcp.address,token,allowedRoles:['example'],allowedTools:['plan_list','recent_memory_create'],allowWrites:true,grants:[{appId:app.id,deviceBindingId:'glass',ownerAccountId:accountId}]}});
  for(let i=0;i<100;i++){const state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.workers?.some((w:any)=>w.capabilities?.includes('knowledgebridge')))break;await new Promise(r=>setTimeout(r,40));}
  const headers={'x-rabilink-token':'rbd_e2e'};assert.equal((await req('/api/rabilink/device/knowledge','POST',{operation:'list'},{'x-rabilink-token':app.token})).status,403);
  const listed=await req('/api/rabilink/device/knowledge','POST',{operation:'list'},headers);assert.equal(listed.status,200,JSON.stringify(listed.body));assert.ok(JSON.stringify(listed.body).includes('plan_list'));
  const result=await req('/api/rabilink/device/knowledge','POST',{operation:'call',name:'plan_list',args:{roleId:'example'}},headers);assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(JSON.stringify(result.body).includes('fixture-plan'));assert.equal(calls,1);
  assert.equal((await req('/api/rabilink/device/knowledge','POST',{operation:'call',name:'plan_list',args:{roleId:'other'}},headers)).status,403);assert.equal(calls,1);
  const mutation={operation:'call',name:'recent_memory_create',args:{roleId:'example',idempotencyKey:'write-original-key',body:{title:'Fixture',focus:'fixture',keywords:['test'],content:'Synthetic fixture only'}}};
  const unknown=await req('/api/rabilink/device/knowledge','POST',mutation,headers);assert.equal(unknown.status,502,JSON.stringify(unknown.body));assert.equal(unknown.body.uncertain,true);assert.equal(writeCalls,1);
  const replay=await req('/api/rabilink/device/knowledge','POST',mutation,headers);assert.equal(replay.status,409);assert.equal(replay.body.uncertain,true);assert.equal(writeCalls,1);
  const changed=await req('/api/rabilink/device/knowledge','POST',{...mutation,args:{...mutation.args,body:{...mutation.args.body,content:'different'}}},headers);assert.equal(changed.status,409);assert.equal(changed.body.code,'IDEMPOTENCY_CONFLICT');assert.equal(writeCalls,1);
  const confirmedMutation={...mutation,args:{...mutation.args,idempotencyKey:'confirmed-key'}};
  await assert.rejects(fetch(base+'/api/rabilink/device/knowledge',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(confirmedMutation),signal:abortDevice.signal}),/abort/i);
  // Observe the actual client recovery API, not filesystem notifications. This does not establish the cause of earlier timeouts.
  const recoveryDeadline=Date.now()+5000;let recoveryConfirmed=false;
  for(let attempt=0;attempt<100&&Date.now()<recoveryDeadline;attempt++){
   const response=await fetch(base+'/api/rabilink/device/knowledge/operations/confirmed-key',{headers,signal:AbortSignal.timeout(Math.max(1,recoveryDeadline-Date.now()))});
   assert.equal(response.status,200);const status=await response.json();
   if(status.data?.state==='confirmed'){recoveryConfirmed=true;break;}
   assert.equal(status.data?.state,'unknown');
   await new Promise(r=>setTimeout(r,Math.min(50,Math.max(0,recoveryDeadline-Date.now()))));
  }
  assert.ok(recoveryConfirmed,'receipt API recovery timeout');
  const cacheCheck=await fetch(base+'/api/rabilink/device/knowledge/operations/confirmed-key',{headers});assert.match(cacheCheck.headers.get('cache-control')||'',/no-store/);
  const recovered=await req('/api/rabilink/device/knowledge/operations/confirmed-key','GET',undefined,headers);
  assert.equal(recovered.body.data.state,'confirmed');assert.equal(recovered.body.data.receipt.data.id,'fixture-memory');assert.equal(writeCalls,2);
  assert.equal((await req('/api/rabilink/device/knowledge/operations/confirmed-key','GET',undefined,{'x-rabilink-token':app.token})).status,403);
  await runtime.stop();const stopped=once(child,'exit');child.kill();await stopped;
  child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:directory},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
  const afterRestart=await req('/api/rabilink/device/knowledge','POST',mutation,headers);assert.equal(afterRestart.status,409,JSON.stringify(afterRestart.body));assert.equal(afterRestart.body.uncertain,true);assert.equal(writeCalls,2);
  assert.equal((await req('/api/rabilink/device/knowledge/operations/confirmed-key','GET',undefined,headers)).body.data.state,'confirmed');
  assert.equal((await req('/api/rabilink/device/knowledge/operations/write-original-key','GET',undefined,headers)).body.data.state,'unknown');
  const revoked=JSON.parse(fs.readFileSync(file,'utf8'));revoked.apps[0].deviceBindings[0].knowledgeGrantState.grant.allowedRoles=[];fs.writeFileSync(file,JSON.stringify(revoked));
  assert.equal((await req('/api/rabilink/device/knowledge/operations/confirmed-key','GET',undefined,headers)).status,403);
 } catch (failure) {
  // Best-effort bounded diagnostics; event append is asynchronous, not a durability guarantee.
  try {
   const eventsFile=path.join(directory,'events.jsonl');
   if(fs.existsSync(eventsFile)&&fs.statSync(eventsFile).size<=262144){
    for(const line of fs.readFileSync(eventsFile,'utf8').split('\n')){try{const event=JSON.parse(line);if(JSON.stringify(event).includes('knowledge_receipt_persistence_failed'))console.error('SAFE_PERSISTENCE_DIAGNOSTIC',JSON.stringify({stage:event.stage??event.data?.stage,code:event.code??event.data?.code,requestId:event.requestId??event.data?.requestId}));}catch{}}
   } else console.error('SAFE_PERSISTENCE_DIAGNOSTIC_UNAVAILABLE');
   const saved=JSON.parse(fs.readFileSync(path.join(directory,'apps.json'),'utf8'));
   console.error('SAFE_FINAL_STATES',JSON.stringify((saved.apps?.[0]?.deviceBindings?.[0]?.knowledgeIntents||[]).map((x:any)=>({key:x.key,state:x.outcome?.state}))));
  } catch { console.error('SAFE_DIAGNOSTIC_READ_FAILED'); }
  throw failure;
 } finally {await runtime.stop();await mcp.close();if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}fs.rmSync(directory,{recursive:true,force:true});}
});
