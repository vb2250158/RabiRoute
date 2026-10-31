import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createPersonaHealthOperations } from './personaHealthOperations.js';
import { createPersonaHealthOwner,type PersonaHealthContext } from './wearableHealthRoute.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { queryWearableHealthHistory,wearableHealthEventsDir } from '../wearableHealth.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-health-contract-')),roleDir=path.join(directory,'Example');fs.mkdirSync(roleDir);fs.writeFileSync(path.join(roleDir,'persona.md'),'# Example');
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-health-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const root={current:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'},host={current:{...identity} as typeof identity|null};
  const deliveries:unknown[]=[],behavior:{deliver?:()=>Promise<void>}={};let port=0;
  const context:PersonaHealthContext={roleDirectory:()=>path.join(root.current,'Example'),identity:()=>identity,get lifecycleFence(){return host.current;},get managerPort(){return port;},deliverAlert:async(role,alert,details)=>{deliveries.push({role,alert,details});await behavior.deliver?.();return [{status:'routed',matchedRuleCount:1,sentPacketCount:1}];}};
  const definitions=createPersonaHealthOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('health-fixture',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as {port:number}).port;const base='http://127.0.0.1:'+port;
  const headers=()=>({'x-rabiroute-expected-application-generation-id':identity.applicationGenerationId,'x-rabiroute-expected-manager-instance-id':identity.managerInstanceId});
  const call=(suffix:string,method='GET',body?:unknown,prefix='/api/roles',fence:Record<string,string>=headers())=>new Promise<{status:number;body:any}>((resolve,reject)=>{const request=http.request(base+prefix+'/Example/'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',...fence}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  return {directory,roleDir,root,identity,host,context,definitions,deliveries,behavior,headers,call,port};
}
const observation=(id='sample-original',value=72)=>({eventId:'event-original',sourceDeviceId:'device-original',capturedAt:new Date().toISOString(),samples:[{id,metric:'heart_rate',value,recordedAt:new Date().toISOString(),unit:'bpm',metadata:{quality:1,synthetic:true,label:'example'}}]});
const request=(headers:Record<string,string>)=>{const input=new http.IncomingMessage(new Socket());input.headers=headers;return input;};

test('all fourteen health operations allow an authenticated empty node and preserve native config/state/history/summary/replay',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,14);const input=observation();
  for(const prefix of ['/api/roles','/roles']){
    assert.equal((await f.call('health/config','GET',undefined,prefix)).status,200);
    const config=await f.call('health/config','PATCH',{defaultPolicy:{heartRateHighBpm:140}},prefix);assert.equal(config.status,200);assert.equal(config.body.data.defaultPolicy.heartRateHighBpm,140);
    const saved=await f.call('health/observations','POST',input,prefix);assert.equal(saved.status,202);assert.equal(saved.body.data.accepted.length,prefix==='/api/roles'?1:0);assert.equal(saved.body.data.deduplicated.length,prefix==='/roles'?1:0);
    const state=await f.call('health/state?sourceDeviceId=device-original','GET',undefined,prefix);assert.equal(state.status,200);assert.equal(state.body.data.latestHeartRate.id,'sample-original');
    const history=await f.call('health/history?metric=unknown&metric=heart_rate,sleep_state&order=asc','GET',undefined,prefix);assert.equal(history.status,200);assert.equal(history.body.data.length,1);assert.equal(history.body.data[0].metadata.synthetic,true);
    for(const suffix of ['health','health/summary']){const summary=await f.call(suffix,'GET',undefined,prefix);assert.equal(summary.status,200);assert.equal(summary.body.data.heartRate.count,1);}
  }
  assert.equal(f.deliveries.length,0);
});

test('observation lifecycle headers retain before-body 400/409/503 failures without mutating the native store',async t=>{
  const f=await fixture(t);
  for(const [fence,status,state] of [[{},400,'invalid_lifecycle_fence'],[{'x-rabiroute-expected-application-generation-id':'old','x-rabiroute-expected-manager-instance-id':f.identity.managerInstanceId},409,'stale_lifecycle_fence'],[{'x-rabiroute-expected-application-generation-id':f.identity.applicationGenerationId+',other','x-rabiroute-expected-manager-instance-id':f.identity.managerInstanceId},400,'invalid_lifecycle_fence']] as const){const result=await f.call('health/observations','POST',observation(),'/api/roles',fence);assert.equal(result.status,status);assert.equal(result.body.state,state);}
  f.host.current=null;const unavailable=await f.call('health/observations','POST',observation());assert.equal(unavailable.status,503);assert.equal(unavailable.body.state,'host_generation_unavailable');assert.equal(fs.existsSync(wearableHealthEventsDir(f.roleDir)),false);
  assert.equal((await f.call('health/config')).status,200);
});

test('nested native health fields retain precedence and alerts route only after persistence when explicitly requested',async t=>{
  const f=await fixture(t),flat=observation('sample-alert',72),nested=observation('sample-alert',132);
  const body={...flat,health:{...nested,sourceDeviceId:'nested-device',policy:{heartRateHighBpm:120}}};
  const result=await f.call('health/observations?deliverAlerts=yes','POST',body);assert.equal(result.status,202);assert.equal(result.body.data.accepted[0].value,132);assert.equal(result.body.data.accepted[0].sourceDeviceId,'nested-device');assert.equal(result.body.data.delivery.results[0].results[0].status,'routed');assert.equal(f.deliveries.length,1);
  const dispatched=f.deliveries[0] as {details:{managerPort:number;sourceDeviceId:string}};assert.equal(dispatched.details.managerPort,f.port);assert.equal(dispatched.details.sourceDeviceId,'nested-device');
  const replay=await f.call('health/observations?deliverAlerts=1','POST',body);assert.equal(replay.status,202);assert.equal(replay.body.data.deduplicated.length,1);assert.equal(f.deliveries.length,1);
});

test('failed optional alert delivery retains the already committed native sample and uncertainty for readback',async t=>{
  const f=await fixture(t);f.behavior.deliver=async()=>{throw new Error('Controlled alert delivery failure');};
  const response=await f.call('health/observations?deliverAlerts=1','POST',observation('sample-committed',132));assert.equal(response.status,400);assert.equal(response.body.uncertain,true);
  assert.equal(queryWearableHealthHistory(f.roleDir)[0].id,'sample-committed');assert.equal(f.deliveries.length,1);
});

test('caller cancellation joins original alert delivery before finishing and never re-ingests its persisted sample',async t=>{
  const f=await fixture(t),wait=gate(),entered=gate();t.after(wait.release);f.behavior.deliver=async()=>{entered.release();await wait.promise;};
  const controller=new AbortController(),bound=createPersonaHealthOwner(f.context).prepare(request(f.headers()),'Example','observations',controller.signal);
  const pending=bound.mutate(observation('sample-cancelled',132),new URLSearchParams('deliverAlerts=1'));let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
  await entered.promise;controller.abort(new Error('Controlled caller cancellation'));await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(queryWearableHealthHistory(f.roleDir).length,1);
  wait.release();await assert.rejects(pending,/Controlled caller cancellation/);assert.equal(f.deliveries.length,1);assert.equal(queryWearableHealthHistory(f.roleDir).length,1);
});

test('prepared health owners reject replaced role directories and Host generations before native ingest',async t=>{
  const f=await fixture(t),owner=createPersonaHealthOwner(f.context),bound=owner.prepare(request(f.headers()),'Example','observations');
  f.host.current={...f.identity,applicationGenerationId:'replacement-generation'};
  await assert.rejects(bound.mutate(observation(),new URLSearchParams()),(error:any)=>error.statusCode===409&&error.state==='stale_lifecycle_fence');
  f.host.current={...f.identity};const moved=owner.prepare(request(f.headers()),'Example','config.patch');f.root.current=path.join(f.directory,'replacement');
  await assert.rejects(moved.mutate({defaultPolicy:{enabled:false}},new URLSearchParams()),(error:any)=>error.statusCode===409);assert.equal(moved.mutationOutcome(),'not_started');assert.equal(fs.existsSync(wearableHealthEventsDir(f.roleDir)),false);
});
