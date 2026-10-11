import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAgentOwner } from '../agentAdapters/deviceAgentOwner.js';
import { createDeviceAgentEndpointBridge } from './deviceAgentEndpointBridge.js';
import { AgentRequestStore } from '../agentRequests/store.js';
import { executeEndpointAgentDelivery } from '../agentRequests/endpointDelivery.js';
import { createAgentEndpointDelivery } from './agentEndpointDelivery.js';
import { LanAgentRegistry } from './lanAgentRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { RabiGlobalConfigStore } from './globalConfig.js';
import type { AgentThreadRequest } from '../agentThreads.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';

async function fixture(run: (fixture: {
  call(auth:string,method:string,url:string,body?:unknown):Promise<any>;
  owner:ReturnType<typeof createDeviceAgentOwner>;
  bridge:ReturnType<typeof createDeviceAgentEndpointBridge>;
  store:AgentRequestStore;
  queued(agentId:string):Promise<void>;
})=>Promise<void>) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'device-endpoint-'));
  const principal=(request:http.IncomingMessage):RabiLinkAgentPrincipal|null => ['eye-a','eye-b'].includes(String(request.headers.authorization))
    ? {scope:'scope-one',sourceDeviceId:String(request.headers.authorization),deviceOwner:true}
    : request.headers.authorization==='phone' ? {scope:'scope-one',sourceDeviceId:'application',deviceOwner:false} : null;
  const assertDeviceAssignment=async(scope:string,id:string)=>{if(scope!=='scope-one' || !['eye-a','eye-b'].includes(id))throw new Error('Wrong device owner');};
  const owner=createDeviceAgentOwner({dataDir:directory,ownerInstanceId:'pc-owner',authorize:principal,
    authorizeDelivery:async request=>principal(request) ? {scope:'scope-one'} : null,assertDeviceAssignment});
  const registry=new LanAgentRegistry({statePath:path.join(directory,'registry.json')});
  const bridge=createDeviceAgentEndpointBridge({managerInstanceId:registry.localInstanceId,ownerInstanceId:'pc-owner',scope:()=> 'scope-one',owner,assertDeviceAssignment});
  const store=new AgentRequestStore(path.join(directory,'requests.json'));
  const pipeline=createAgentEndpointDelivery({store,registry,authority:new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),config:new RabiGlobalConfigStore(directory),
    receiptDirectory:path.join(directory,'transport'),device:bridge,readLocal:async()=>{throw new Error('Native device must not use a PC model or workspace resolver');},localOptions:()=>({allowedWorkspaces:[]})});
  const server=http.createServer(async(request,response)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
      const url=new URL(request.url!,'http://fixture.invalid');
      if(url.pathname==='/api/agent/threads') {
        const actor=principal(request);if(!actor)throw new Error('Unauthorized');
        const captured=JSON.stringify(actor);
        const fence=()=>{if(JSON.stringify(principal(request))!==captured)throw new Error('Connection changed');};
        const result=await executeEndpointAgentDelivery(body,pipeline.options(undefined,fence,actor));
        response.writeHead(result.statusCode,{'content-type':'application/json'});response.end(JSON.stringify(result.data));
      } else await owner.handle(request,response,url,body);
    } catch(error) {response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const pendingCalls=new Set<Promise<any>>();
  const call=(auth:string,method:string,url:string,body?:unknown)=>{
    const pending=fetch(base+url,{method,headers:{authorization:auth,'content-type':'application/json',connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      .then(async response=>({statusCode:response.status,body:await response.json()}));
    pendingCalls.add(pending);void pending.then(()=>pendingCalls.delete(pending),()=>pendingCalls.delete(pending));return pending;
  };
  const queued=(agentId:string)=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{release();reject(new Error('Queue event missing'));},15000);
    const release=owner.onChange(()=>{const row=owner.readSession('scope-one',agentId,'session-'+agentId);if(row?.deliveries.some(row=>row.status==='queued')){clearTimeout(timer);release();resolve();}});
  });
  try {
    for(const agentId of ['eye-a','eye-b'])assert.equal((await call(agentId,'PUT','/api/device-agents/'+agentId+'/session',{sessionId:'session-'+agentId,name:agentId,loaded:true,capabilities:['language-model','rabi-api','asr','tts']})).statusCode,200);
    await run({call,owner,bridge,store,queued});
  } finally {await Promise.allSettled([...pendingCalls]);registry.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});}
}
const source=(id:string)=>({type:'agent' as const,agentAdapter:'deviceAgent' as const,sessionId:'session-'+id,sessionName:id});
const request:AgentThreadRequest={action:'send',agentAdapter:'deviceAgent',sourceThreadId:'session-eye-a',sourceAgentType:'agent',threadId:'session-eye-b',
  instanceBinding:{instanceId:'pc-owner',agentId:'eye-b'},messageSource:source('eye-a'),prompt:'Original native request',responsePolicy:'required',responseInstruction:'Return formal evidence'};
async function claim(f:{call:(auth:string,method:string,url:string,body?:unknown)=>Promise<any>;owner:ReturnType<typeof createDeviceAgentOwner>},agentId:string) {
  const session=f.owner.sessions('scope-one').find(row=>row.agentId===agentId)!;
  const result=await f.call(agentId,'POST','/api/device-agents/'+agentId+'/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});
  assert.equal(result.statusCode,200);return result.body.data.delivery;
}

test('real native HTTP claim commits the shared request ledger and formal reply reverses exact sessions without cwd',async()=>fixture(async f=>{
  const notice=f.queued('eye-b'),pending=f.call('eye-a','POST','/api/agent/threads',request);await notice;
  const delivered=await claim(f,'eye-b');assert.match(delivered.prompt,/Original native request/);
  assert.equal(delivered.prompt,f.store.getEndpointDelivery(delivered.deliveryId)!.prompt);
  const result=await pending;assert.equal(result.statusCode,200);assert.equal(result.body.ok,true);
  const record=f.store.get(result.body.communication.requestId)!;assert.equal(record.status,'awaiting_response');
  assert.equal(record.source.workspace,undefined);assert.equal(record.target.workspace,undefined);
  const reply:AgentThreadRequest={...request,sourceThreadId:'session-eye-b',threadId:'session-eye-a',instanceBinding:{instanceId:'pc-owner',agentId:'eye-a'},
    messageSource:source('eye-b'),inReplyToRequestId:record.id,prompt:'Native formal reply',result:'Actual evidence',nextAction:'Continue original request',responsePolicy:'none'};
  const replyNotice=f.queued('eye-a'),replyPending=f.call('eye-b','POST','/api/agent/threads',reply);await replyNotice;
  const received=await claim(f,'eye-a');assert.match(received.prompt,/Actual evidence/);
  assert.equal((await replyPending).statusCode,200);assert.equal(f.store.get(record.id)!.status,'responded');
  const reconciled=await f.call('eye-b','POST','/api/agent/threads',{...reply,action:'reconcile_delivery',deliveryId:received.deliveryId});
  assert.equal(reconciled.body.ok,true);assert.equal(f.owner.readSession('scope-one','eye-a','session-eye-a')!.deliveries.length,1);
  assert.equal((await f.call('phone','POST','/api/agent/threads',reply)).statusCode,409);
}));

test('phone wake submission cannot commit native delivery; original claim reconciles without another enqueue',async()=>fixture(async f=>{
  const session=f.owner.sessions('scope-one').find(row=>row.agentId==='eye-b')!;
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{...session,loaded:false,capabilities:['language-model']});
  const notice=f.queued('eye-b'),pending=f.call('eye-a','POST','/api/agent/threads',request);await notice;
  const wakes=await f.call('phone','GET','/api/device-agents/eye-b/wake-requests');
  assert.equal(JSON.stringify(wakes).includes('Original native request'),false);
  const wake=wakes.body.data.requests[0];
  const wakeClaim=await f.call('phone','POST',`/api/device-agents/eye-b/wake-requests/${wake.nonce}/claim`,{});
  await f.call('phone','POST',`/api/device-agents/eye-b/wake-requests/${wake.nonce}/receipt`,{claimToken:wakeClaim.body.data.claimToken,status:'submitted'});
  const uncertain=await pending;assert.equal(uncertain.statusCode,202);assert.equal(uncertain.body.ok,false);
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{...session,loaded:true,capabilities:['language-model']});
  const received=await claim(f,'eye-b');assert.equal(received.deliveryId,uncertain.body.delivery.deliveryId);
  const reconciled=await f.call('eye-a','POST','/api/agent/threads',{...request,action:'reconcile_delivery',deliveryId:received.deliveryId});
  assert.equal(reconciled.body.ok,true);assert.equal(f.owner.readSession('scope-one','eye-b','session-eye-b')!.deliveries.length,1);
}));

test('native source impersonation and asynchronous epoch replacement never write a prepared delivery',async()=>fixture(async f=>{
  await assert.rejects(f.bridge.resolveSource({...request,sourceThreadId:'session-eye-b'},{scope:'scope-one',sourceDeviceId:'eye-a',deviceOwner:true}),/SESSION_NOT_FOUND/);
  const target=(await f.bridge.resolveTarget(request))!.endpoint!;
  const session=f.owner.sessions('scope-one').find(row=>row.agentId==='eye-b')!;
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{...session,loaded:false,capabilities:['language-model']});
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{sessionId:'replacement',name:'eye-b',loaded:true,capabilities:['language-model']});
  assert.throws(()=>f.bridge.authorize(target),/SESSION_NOT_FOUND|ENDPOINT_CHANGED/);
  assert.equal(f.owner.readSession('scope-one','eye-b','replacement')!.deliveries.length,0);
}));

test('a queued formal delivery stays bound to its original epoch and is never claimed by a replacement owner',async()=>fixture(async f=>{
  const session=f.owner.sessions('scope-one').find(row=>row.agentId==='eye-b')!;
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{...session,loaded:false,capabilities:['language-model']});
  const notice=f.queued('eye-b'),pending=f.call('eye-a','POST','/api/agent/threads',request);await notice;
  const queuedRow=f.owner.readSession('scope-one','eye-b','session-eye-b')!.deliveries[0];
  assert.equal(queuedRow.ownerAccepted,false);
  await f.call('eye-b','PUT','/api/device-agents/eye-b/session',{sessionId:'replacement',name:'eye-b',loaded:true,capabilities:['language-model']});
  assert.equal((await pending).statusCode,202);
  assert.equal(f.owner.readDelivery('scope-one','eye-b',queuedRow.deliveryId)!.status,'result-unknown');
  assert.equal(await claim(f,'eye-b'),null);
  const original=f.store.getEndpointDelivery(queuedRow.deliveryId)!;
  assert.equal(original.target.sessionId,'session-eye-b');assert.equal(original.state,'dispatching');
}));
