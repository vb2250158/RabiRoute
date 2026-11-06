import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { nativeHttpTestFetch } from '../../../../manager/nativeHttpTestClient.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAgentOwner } from '../agentAdapters/deviceAgentOwner.js';
import { createDeviceAgentOperations } from '../agentAdapters/deviceAgentOperations.js';
import { ManagerPluginRouteRegistry } from '../../../../manager/managerPluginRouteRegistry.js';
import { createDeviceAgentEndpointBridge } from './deviceAgentEndpointBridge.js';
import { assertDeviceAgentPreparedAuthority, assertDeviceAgentPreparedClaimAuthority } from '../../../../manager/deviceAgentPreparedAuthority.js';
import { AgentRequestStore } from '../../../../agentRequests/store.js';
import { executeEndpointAgentDelivery } from '../../../../agentRequests/endpointDelivery.js';
import { createAgentEndpointDelivery } from '../../../../manager/agentEndpointDelivery.js';
import { LanAgentRegistry } from '../../../../manager/lanAgentRegistry.js';
import { LanAgentAuthority } from '../../../../manager/lanAgentAuthority.js';
import { RabiGlobalConfigStore } from '../../../../manager/globalConfig.js';
import type { AgentThreadRequest } from '../../../../agentThreads.js';
import type { RabiLinkAgentPrincipal } from '../../../../manager/rabiLinkAgentDevices.js';

async function waitQueued(owner: ReturnType<typeof createDeviceAgentOwner>, scope: string, agentId: string, sessionId: string) {
  const deadline = Date.now() + 15_000;
  while (!owner.readSession(scope, agentId, sessionId)?.deliveries.some(row => row.status === 'queued')) {
    if (Date.now() >= deadline) throw new Error('The original delivery was not queued.');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

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
  const routes=new ManagerPluginRouteRegistry(),registration=routes.registerOperations('fixture-device-endpoint',createDeviceAgentOperations(()=>owner));
  const server=http.createServer(async(request,response)=>{
    try {
      const url=new URL(request.url!,'http://fixture.invalid');
      if(routes.handle(request,url,response))return;
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
      if(url.pathname==='/api/agent/threads') {
        const actor=principal(request);if(!actor)throw new Error('Unauthorized');
        const captured=JSON.stringify(actor);
        const fence=()=>{if(JSON.stringify(principal(request))!==captured)throw new Error('Connection changed');};
        const result=await executeEndpointAgentDelivery(body,pipeline.options(undefined,fence,actor));
        response.writeHead(result.statusCode,{'content-type':'application/json'});response.end(JSON.stringify(result.data));
      } else response.writeHead(404).end();
    } catch(error) {response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const pendingCalls=new Set<Promise<any>>();
  const call=(auth:string,method:string,url:string,body?:unknown)=>{
    const pending=nativeHttpTestFetch(base+url,{method,headers:{authorization:auth,'content-type':'application/json',connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      .then(async response=>({statusCode:response.status,body:await response.json()}));
    pendingCalls.add(pending);void pending.then(()=>pendingCalls.delete(pending),()=>pendingCalls.delete(pending));return pending;
  };
  const queued=(agentId:string)=>waitQueued(owner,'scope-one',agentId,'session-'+agentId);
  try {
    for(const agentId of ['eye-a','eye-b'])assert.equal((await call(agentId,'PUT','/api/device-agents/'+agentId+'/session',{sessionId:'session-'+agentId,name:agentId,loaded:true,capabilities:['language-model','rabi-api','asr','tts']})).statusCode,200);
    await run({call,owner,bridge,store,queued});
  } finally {await Promise.allSettled([...pendingCalls]);await pipeline.recovery.stop();await store.close();registry.close();await registration.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});}
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
  assert.equal(delivered.prompt,(await f.store.readEndpointDelivery(delivered.deliveryId))!.prompt);
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
  assert.equal((await f.call('phone','POST','/api/agent/threads',reply)).statusCode,200);
  assert.equal(f.owner.readSession('scope-one','eye-a','session-eye-a')!.deliveries.length,1,'another admitted caller reconciles the same original intent');
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

test('native source attribution is independent of registration while target epoch replacement stays exact',async()=>fixture(async f=>{
  const source = await f.bridge.resolveSource({...request,sourceThreadId:'unregistered-session'},{scope:'scope-one',sourceDeviceId:'eye-a',deviceOwner:true});
  assert.equal(source?.threadId,'unregistered-session');
  assert.equal(source?.endpoint?.agentId,'eye-a');
  f.bridge.authorize(source!.endpoint!,'source');
  await f.bridge.refresh(source!.endpoint!,'source');
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


test('native source mapping never reads local or remote session owners, loaded state or assignment', async () => {
  const unavailable = () => { throw new Error('Source owner must not be read'); };
  const bridge = createDeviceAgentEndpointBridge({ managerInstanceId:'manager',ownerInstanceId:'owner',scope:()=> 'scope',
    owner: { sessions:unavailable,enqueuePrepared:unavailable,readPreparedReceipt:unavailable,waitReceipt:unavailable },
    assertDeviceAssignment:unavailable,peer:{localDeviceId:()=> 'pc-a',targetDeviceId:unavailable,request:unavailable} });
  const source = await bridge.resolveSource({...request,sourceThreadId:'not-registered'},{scope:'scope',sourceDeviceId:'device',deviceOwner:true});
  assert.equal(source?.threadId,'not-registered'); assert.equal(source?.endpoint?.agentId,'device');
  bridge.authorize(source!.endpoint!,'source'); await bridge.refresh(source!.endpoint!,'source');
});


test('an unregistered source on A receives its formal reply through the actual native owner on B exactly once',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'device-cross-owner-'));
  const scope='scope-one',agentId='eye-a',sessionId='session-eye-a';
  const registry=new LanAgentRegistry({statePath:path.join(directory,'registry.json')});
  const store=new AgentRequestStore(path.join(directory,'a-requests.json'));
  const ledgerProof=async(deliveryId:string)=>{
    const delivery=await store.readEndpointDelivery(deliveryId);assert.ok(delivery);
    store.assertEndpointDeliveryActive(deliveryId);
    return {authorized:true,state:delivery.state,deliveryId:delivery.deliveryId,generation:delivery.generation,
      ledgerManagerInstanceId:registry.localInstanceId,source:delivery.source,endpoint:delivery.target,
      promptHash:delivery.promptHash,executionOptionsHash:delivery.executionOptionsHash,preparation:delivery.preparation};
  };
  const ownerB=createDeviceAgentOwner({dataDir:path.join(directory,'b'),ownerInstanceId:'pc-b',
    authorize:request=>['eye-a','pc-a'].includes(String(request.headers.authorization))
      ? {scope,sourceDeviceId:String(request.headers.authorization),deviceOwner:true}:null,
    authorizeDelivery:async()=>({scope}),assertDeviceAssignment:async(value,id)=>{assert.equal(value,scope);assert.equal(id,agentId);},
    authorizePrepared:async(request,id,input)=>{
      assert.equal(request.headers.authorization,'pc-a');assert.equal(id,agentId);assert.equal(input.ledgerOwnerDeviceId,'pc-a');
      assertDeviceAgentPreparedAuthority(input,await ledgerProof(input.delivery.deliveryId));
      return {scope,ledgerOwnerDeviceId:'pc-a'};
    },
    authorizePreparedClaim:async(request,id,evidence)=>{
      assert.equal(request.headers.authorization,agentId);assert.equal(id,agentId);
      assertDeviceAgentPreparedClaimAuthority(evidence,await ledgerProof(evidence.deliveryId));
    }});
  const routes=new ManagerPluginRouteRegistry(),registration=routes.registerOperations('device-cross-owner',createDeviceAgentOperations(()=>ownerB));
  const server=http.createServer((request,response)=>{if(!routes.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  async function call<T>(auth:string,method:string,url:string,body?:unknown):Promise<{status:number;body:T}> {
    const response=await nativeHttpTestFetch(base+url,{method,headers:{authorization:auth,'content-type':'application/json',connection:'close'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as T};
  }
  let sourceOwnerReads=0,peerRequests=0;
  const unused=()=>{throw new Error('A has no native device mailbox');};
  const bridge=createDeviceAgentEndpointBridge({managerInstanceId:registry.localInstanceId,ownerInstanceId:'pc-a',scope:()=>scope,
    owner:{sessions:()=>{sourceOwnerReads++;return [];},enqueuePrepared:unused,readPreparedReceipt:unused,waitReceipt:unused},
    assertDeviceAssignment:async()=>{throw new Error('The device target owner is B');},
    peer:{localDeviceId:()=> 'pc-a',targetDeviceId:async id=>{assert.equal(id,agentId);return 'pc-b';},request:async(device,method,url,body)=>{
      assert.equal(device,'pc-b');peerRequests++;
      const result=await call<Record<string,unknown>>('pc-a',method,url,body);assert.ok([200,202].includes(result.status),JSON.stringify(result.body));
      return result.body;
    }}});
  const pipeline=createAgentEndpointDelivery({store,registry,authority:new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),
    config:new RabiGlobalConfigStore(directory),receiptDirectory:path.join(directory,'a-receipts'),device:bridge,
    readLocal:async()=>{throw new Error('Source qualification must not read a local native task');},localOptions:()=>({allowedWorkspaces:[]})});
  let pending: ReturnType<typeof executeEndpointAgentDelivery> | undefined;
  try {
    const published=await call<{data:{session:{sessionId:string;ownerEpoch:string}}}>(agentId,'PUT','/api/device-agents/'+agentId+'/session',
      {sessionId,name:'Native device on B',loaded:true,capabilities:['language-model']});
    assert.equal(published.status,200);
    const source=await bridge.resolveSource({action:'send',sourceThreadId:sessionId,messageSource:{type:'agent',agentAdapter:'deviceAgent',sessionId,sessionName:'D'}},
      {scope,sourceDeviceId:agentId,deviceOwner:true});assert.ok(source?.endpoint);
    assert.equal(sourceOwnerReads,0);assert.equal(peerRequests,0);assert.equal(source.endpoint.instanceId,'pc-a');
    const original=await store.prepare({source,target:{agentAdapter:'codex',agentType:'agent',threadId:'native-a',threadName:'A'},
      responsePolicy:'required',responseInstruction:'Return the evidence'});await store.commit(original);
    const queued=waitQueued(ownerB,scope,agentId,sessionId);
    const reply:AgentThreadRequest={action:'send',agentAdapter:'deviceAgent',threadId:sessionId,instanceBinding:{instanceId:'pc-a',agentId},
      sourceThreadId:'native-a',sourceAgentType:'free_sender',messageSource:{type:'agent',agentAdapter:'codex',sessionId:'native-a',sessionName:'A'},
      inReplyToRequestId:original.requestId,prompt:'Reply through the actual owner',result:'Actual result',nextAction:'Read it',responsePolicy:'none',deliveryId:'cross-owner-reply'};
    pending=executeEndpointAgentDelivery(reply,pipeline.options());
    await queued;
    const received=await call<{data:{delivery:{deliveryId:string;prompt:string}|null}}>(agentId,'POST','/api/device-agents/'+agentId+'/deliveries/claim',published.body.data.session);
    assert.equal(received.status,200);assert.ok(received.body.data.delivery);assert.match(received.body.data.delivery.prompt,/Actual result/);
    const result=await pending;assert.equal(result.data.status,'delivered');
    const accepted=store.getEndpointDelivery(received.body.data.delivery.deliveryId)!;
    assert.equal(accepted.target.instanceId,'pc-b');assert.equal(accepted.target.agentId,agentId);assert.equal(accepted.target.sessionId,sessionId);
    assert.notEqual(accepted.target.authorizationIncarnation,source.endpoint.authorizationIncarnation);
    assert.equal(accepted.receipt?.accepted,true);assert.equal(accepted.receipt?.transport,'device-mailbox');
    assert.equal(store.get(original.requestId!)?.status,'responded');
    assert.equal((await executeEndpointAgentDelivery(reply,pipeline.options())).data.status,'delivered');
    assert.equal(ownerB.readSession(scope,agentId,sessionId)!.deliveries.length,1);
  } finally {
    await pending?.catch(() => {});await pipeline.recovery.stop();await store.close();registry.close();await registration.dispose();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});
  }
});
