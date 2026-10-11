import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAgentOwner } from '../agentAdapters/deviceAgentOwner.js';
import { createDeviceAgentEndpointBridge } from './deviceAgentEndpointBridge.js';
import { createAgentEndpointDelivery } from './agentEndpointDelivery.js';
import { AgentRequestStore } from '../agentRequests/store.js';
import { executeEndpointAgentDelivery } from '../agentRequests/endpointDelivery.js';
import { LanAgentRegistry } from './lanAgentRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { RabiGlobalConfigStore } from './globalConfig.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';
import { handleAgentDeliveryAuthority } from './agentDeliveryAuthorityRoutes.js';
import { createDeviceAgentPeerAuthority } from './deviceAgentPeerAuthority.js';

async function pair(run:(a:any,b:any)=>Promise<void>,peerEnabled=true) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'device-peer-endpoint-'));
  const nodes:any[]=[];
  for(const name of ['a','b']) {
    const nodeDir=path.join(directory,name),deviceId='pc-'+name,eyeId='eye-'+name;
    const state={scope:'same-application',localDeviceId:deviceId,proofCode:'',authorityFailure:false,peerHook:async(_target:string,_path:string)=>{},assignmentHook:async()=>{}};
    const principal=(request:http.IncomingMessage):RabiLinkAgentPrincipal|null=> ['eye-a','eye-b','pc-a','pc-b'].includes(String(request.headers.authorization))
      ? {scope:state.scope,sourceDeviceId:String(request.headers.authorization),deviceOwner:true} : null;
    const peerRequest=async(target:string,method:'GET'|'POST',url:string,body?:unknown)=>{
      const originalPeerDeviceId=state.localDeviceId;
      await state.peerHook(target,url);
      const node=nodes.find(node=>node.deviceId===target);if(!node)throw new Error('Original peer unavailable');
      const result=await node.call(originalPeerDeviceId,method,url,body);if(result.statusCode>=400) {
        const code=result.body.error || result.body.message || (typeof result.body.code==='string' ? result.body.code : 'DEVICE_AGENT_PEER_HTTP_FAILED');
        throw Object.assign(new Error(code),{code,statusCode:result.statusCode});
      }return result.body;
    };
    const readProof=async(ledgerOwnerDeviceId:string,deliveryId:string,generation:string)=>{
      const response=await peerRequest(ledgerOwnerDeviceId,'GET','/api/agent/delivery-authority?deliveryId='+encodeURIComponent(deliveryId)+'&generation='+encodeURIComponent(generation));
      assert.equal(response.code,0);return response.data;
    };
    const peerAuthority=createDeviceAgentPeerAuthority({scope:()=>state.scope,localDeviceId:()=>state.localDeviceId,authorize:principal,trustedTransport:request=>principal(request)!==null,readProof});
    const owner=createDeviceAgentOwner({dataDir:nodeDir,ownerInstanceId:'guid-'+name,authorize:principal,
      authorizeDelivery:async request=>principal(request) ? {scope:'same-application'} : null,...peerAuthority,
      assertDeviceAssignment:async(scope,id)=>{await state.assignmentHook();if(scope!=='same-application' || id!==eyeId)throw new Error('Wrong actual owner');}});
    const registry=new LanAgentRegistry({statePath:path.join(nodeDir,'registry.json')});
    const bridge=createDeviceAgentEndpointBridge({managerInstanceId:registry.localInstanceId,ownerInstanceId:'guid-'+name,scope:()=>state.scope,owner,
      ...(peerEnabled ? {peer:{localDeviceId:()=>state.localDeviceId,targetDeviceId:async(id:string)=>id==='eye-a'?'pc-a':id==='eye-b'?'pc-b':'',request:peerRequest}} : {}),
      assertDeviceAssignment:async(scope,id)=>{await state.assignmentHook();if(scope!=='same-application' || id!==eyeId)throw new Error('Wrong actual owner');}});
    const store=new AgentRequestStore(path.join(nodeDir,'requests.json'));
    const pipeline=createAgentEndpointDelivery({store,registry,authority:new LanAgentAuthority({statePath:path.join(nodeDir,'authority.json')}),config:new RabiGlobalConfigStore(nodeDir),
      receiptDirectory:path.join(nodeDir,'transport'),device:bridge,readLocal:async()=>{throw new Error('No alternate PC runtime');},localOptions:()=>({allowedWorkspaces:[]})});
    const server=http.createServer(async(request,response)=>{try {
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined,url=new URL(request.url!,'http://fixture.invalid');
      if(state.proofCode && url.pathname===`/api/device-agents/${eyeId}/session` && request.method==='GET') {
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({code:state.proofCode,data:{ownerInstanceId:'guid-'+name,session:{sessionId:'session-'+eyeId,loaded:true}}}));
      } else if(url.pathname==='/api/agent/delivery-authority') {
        if(state.authorityFailure){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:'Original ledger unavailable'}));return;}
        const original=principal(request);if(!original)throw new Error('Unsigned peer');
        await handleAgentDeliveryAuthority(request,url,response,{store,managerInstanceId:registry.localInstanceId,authorize:pipeline.authorize,refreshEndpoints:pipeline.refreshEndpoints,
          assertRequestAuthority:()=>{assert.deepEqual(principal(request),original);},jsonResponse:(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}});
      } else if(url.pathname==='/api/agent/threads') {
        const actor=principal(request);if(!actor)throw new Error('Unsigned connection');
        const fence=()=>{assert.deepEqual(principal(request),actor);};
        const result=await executeEndpointAgentDelivery(body,pipeline.options(undefined,fence,actor));
        response.writeHead(result.statusCode,{'content-type':'application/json'});response.end(JSON.stringify(result.data));
      } else await owner.handle(request,response,url,body);
    } catch(error){response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:String(error)}));}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const pendingCalls=new Set<Promise<any>>();
    const call=(auth:string,method:string,url:string,body?:unknown)=>{
      const pending=fetch(base+url,{method,headers:{authorization:auth,'content-type':'application/json',connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})})
        .then(async response=>({statusCode:response.status,body:await response.json()}));
      pendingCalls.add(pending);void pending.then(()=>pendingCalls.delete(pending),()=>pendingCalls.delete(pending));return pending;
    };
    const queued=()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{release();reject(new Error('Original queue event missing'));},15000);
      const release=owner.onChange(()=>{if(owner.readSession('same-application',eyeId,'session-'+eyeId)?.deliveries.some(row=>row.status==='queued')){clearTimeout(timer);release();resolve();}});});
    nodes.push({deviceId,eyeId,owner,bridge,store,pipeline,registry,server,call,state,queued,pendingCalls,requestPath:path.join(nodeDir,'requests.json')});
    assert.equal((await call(eyeId,'PUT','/api/device-agents/'+eyeId+'/session',{sessionId:'session-'+eyeId,name:eyeId,loaded:true,capabilities:['language-model']})).statusCode,200);
  }
  try{await run(nodes[0],nodes[1]);}finally{await Promise.allSettled(nodes.flatMap(node=>[...node.pendingCalls]));for(const node of nodes){node.registry.close();node.server.closeAllConnections();await new Promise<void>(resolve=>node.server.close(()=>resolve()));}fs.rmSync(directory,{recursive:true,force:true});}
}
const crossRequest={action:'send',agentAdapter:'deviceAgent',sourceThreadId:'session-eye-a',sourceAgentType:'agent',threadId:'session-eye-b',instanceBinding:{instanceId:'guid-b',agentId:'eye-b'},
  messageSource:{type:'agent',agentAdapter:'deviceAgent',sessionId:'session-eye-a',sessionName:'eye-a'},prompt:'Cross Manager original request',responsePolicy:'required',responseInstruction:'Return to original ledger'};

test('independent HTTP Managers require an available native owner proof instead of trusting the source body',async()=>pair(async(a,b)=>{
  const result=await b.call('eye-a','POST','/api/agent/threads',crossRequest);
  assert.equal(result.statusCode,409);assert.match(result.body.error,/DEVICE_AGENT_SESSION_NOT_FOUND/);
  const proof=await a.call('pc-b','GET','/api/device-agents/eye-a/session');assert.equal(proof.statusCode,200);assert.equal(proof.body.data.session.sessionId,'session-eye-a');
  const denied=await a.call('pc-b','POST','/api/device-agents/eye-a/deliveries/claim',proof.body.data.session);
  assert.equal(denied.statusCode,403);assert.equal(fs.existsSync(a.requestPath),false);
},false));

async function claim(node:any) {
  const session=node.owner.sessions('same-application')[0];
  const result=await node.call(node.eyeId,'POST','/api/device-agents/'+node.eyeId+'/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});
  assert.equal(result.statusCode,200,JSON.stringify(result.body));return result.body.data.delivery;
}
test('independent Manager B verifies native A and returns its formal reply through A actual claim with one B ledger',async()=>pair(async(a,b)=>{
  const notice=b.queued(),pending=b.call('eye-a','POST','/api/agent/threads',crossRequest);await notice;
  const original=await claim(b);assert.equal(original.ledgerOwnerDeviceId,'pc-b');
  const sent=await pending;assert.equal(sent.statusCode,200,JSON.stringify(sent.body));
  const record=b.store.get(sent.body.communication.requestId);assert.equal(record.status,'awaiting_response');
  assert.equal(record.source.endpoint.instanceId,'guid-a');assert.equal(record.source.endpoint.managerInstanceId,b.registry.localInstanceId);
  const reply={...crossRequest,sourceThreadId:'session-eye-b',threadId:'session-eye-a',instanceBinding:{instanceId:'guid-a',agentId:'eye-a'},
    messageSource:{type:'agent',agentAdapter:'deviceAgent',sessionId:'session-eye-b',sessionName:'eye-b'},inReplyToRequestId:record.id,prompt:'Reply from B',result:'Native B evidence',nextAction:'Continue original A task',responsePolicy:'none'};
  const incoming=a.queued(),replyPending=b.call('eye-b','POST','/api/agent/threads',reply);await incoming;
  const received=await claim(a);assert.equal(received.ledgerOwnerDeviceId,'pc-b');assert.match(received.prompt,/Native B evidence/);
  const replied=await replyPending;assert.equal(replied.statusCode,200,JSON.stringify(replied.body));assert.equal(b.store.get(record.id).status,'responded');
  assert.equal(fs.existsSync(a.requestPath),false); // A stores mailbox transport evidence; it never copies B's business ledger.
  const reconciled=await b.call('eye-a','POST','/api/agent/threads',{...crossRequest,action:'reconcile_delivery',deliveryId:received.deliveryId});
  assert.equal(reconciled.statusCode,200,JSON.stringify(reconciled.body));assert.equal(a.owner.readSession('same-application','eye-a','session-eye-a').deliveries.length,1);
}));

test('native cross-PC source proof checks business code and actual loaded session before creating a ledger',async()=>pair(async(a,b)=>{
  a.state.proofCode='OWNER_SCOPE_CHANGED';
  assert.equal((await b.call('eye-a','POST','/api/agent/threads',crossRequest)).statusCode,409);assert.equal(fs.existsSync(b.requestPath),false);
  a.state.proofCode='';const session=a.owner.sessions('same-application')[0];
  await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...session,loaded:false,capabilities:['language-model']});
  const rejected=await b.call('eye-a','POST','/api/agent/threads',crossRequest);assert.match(rejected.body.error,/NOT_LOADED/);assert.equal(fs.existsSync(b.requestPath),false);
}));

test('source proof await cannot replace the original calling PC connection',async()=>pair(async(_a,b)=>{
  b.state.peerHook=async()=>{b.state.localDeviceId='replaced-pc';};
  const rejected=await b.call('eye-a','POST','/api/agent/threads',crossRequest);
  assert.match(rejected.body.error,/CONNECTION_CHANGED/);assert.equal(fs.existsSync(b.requestPath),false);
}));

test('source unloading during proof awaits fails closed while an unloaded target still queues its original delivery',async()=>pair(async(a,b)=>{
  const sourceSession=a.owner.sessions('same-application')[0];let queries=0;
  b.state.peerHook=async(_peer:string,url:string)=>{
    if(url.includes('/eye-a/session') && ++queries===2)await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...sourceSession,loaded:false,capabilities:['language-model']});
  };
  const rejected=await b.call('eye-a','POST','/api/agent/threads',crossRequest);
  assert.match(rejected.body.error,/NOT_LOADED/);assert.equal(fs.existsSync(b.requestPath),false);
  b.state.peerHook=async()=>{};
  await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...sourceSession,loaded:true,capabilities:['language-model']});
  const targetSession=b.owner.sessions('same-application')[0];
  await b.call('eye-b','PUT','/api/device-agents/eye-b/session',{...targetSession,loaded:false,capabilities:['language-model']});
  const notice=b.queued(),pending=b.call('eye-a','POST','/api/agent/threads',crossRequest);await notice;
  const row=b.owner.readSession('same-application','eye-b','session-eye-b').deliveries[0];assert.equal(row.status,'queued');assert.equal(row.ownerAccepted,false);
  assert.equal((await b.call('eye-b','POST','/api/device-agents/eye-b/deliveries/claim',targetSession)).statusCode,409);
  await b.call('eye-b','PUT','/api/device-agents/eye-b/session',{...targetSession,loaded:true,capabilities:['language-model']});
  assert.equal((await pending).statusCode,202);const received=await claim(b);assert.equal(received.deliveryId,row.deliveryId);
  const result=await b.call('eye-a','POST','/api/agent/threads',{...crossRequest,action:'reconcile_delivery',deliveryId:row.deliveryId});assert.equal(result.statusCode,200);
}));

test('only an exact cancelled reservation retires the unclaimed transport row and allows the next native delivery',async()=>pair(async(a,b)=>{
  const notice=b.queued(),pending=b.call('eye-a','POST','/api/agent/threads',crossRequest);await notice;await claim(b);
  const result=await pending,record=b.store.get(result.body.communication.requestId);
  const session=a.owner.sessions('same-application')[0];await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...session,loaded:false,capabilities:['language-model']});
  const incoming=a.queued(),replyPending=b.call('eye-b','POST','/api/agent/threads',{...crossRequest,sourceThreadId:'session-eye-b',threadId:'session-eye-a',instanceBinding:{instanceId:'guid-a',agentId:'eye-a'},
    messageSource:{type:'agent',agentAdapter:'deviceAgent',sessionId:'session-eye-b',sessionName:'eye-b'},inReplyToRequestId:record.id,prompt:'Reply',result:'Evidence',nextAction:'Continue',responsePolicy:'none'});await incoming;
  b.store.cancel(record.id,'original request cancelled');
  await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...session,loaded:true,capabilities:['language-model']});
  b.state.authorityFailure=true;
  const rejected=await a.call('eye-a','POST','/api/device-agents/eye-a/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});
  assert.equal(rejected.statusCode,503);assert.equal(a.owner.readSession('same-application','eye-a','session-eye-a').deliveries[0].status,'queued');
  b.state.authorityFailure=false;
  assert.equal((await replyPending).statusCode,202);assert.equal(b.store.get(record.id).status,'cancelled');
  const nextNotice=a.queued(),nextPending=b.call('eye-b','POST','/api/agent/threads',{...crossRequest,sourceThreadId:'session-eye-b',threadId:'session-eye-a',instanceBinding:{instanceId:'guid-a',agentId:'eye-a'},
    messageSource:{type:'agent',agentAdapter:'deviceAgent',sessionId:'session-eye-b',sessionName:'eye-b'},prompt:'Next original request',responsePolicy:'none'});await nextNotice;
  const terminal=await a.call('eye-a','POST','/api/device-agents/eye-a/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});
  assert.equal(terminal.statusCode,200);assert.equal(terminal.body.data.delivery,null);assert.equal(terminal.body.data.cancelledReceipt.response.errorCode,'ledger_cancelled');
  const rows=a.owner.readSession('same-application','eye-a','session-eye-a').deliveries;
  assert.equal(rows[0].ownerAccepted,false);assert.equal(rows[0].status,'result-unknown');assert.equal(rows[1].status,'queued');
  const next=await claim(a);assert.equal(next.deliveryId,rows[1].deliveryId);assert.match(next.prompt,/Next original request/);assert.equal((await nextPending).statusCode,200);
  assert.equal(b.store.get(record.id).status,'cancelled');assert.equal(fs.existsSync(a.requestPath),false);
}));
test('a remote source unload in the target proof await is rejected before any business preparation',async()=>pair(async(a,b)=>{
  const session=a.owner.sessions('same-application')[0];let assignments=0;
  b.state.assignmentHook=async()=>{if(++assignments===2)await a.call('eye-a','PUT','/api/device-agents/eye-a/session',{...session,loaded:false,capabilities:['language-model']});};
  const rejected=await b.call('eye-a','POST','/api/agent/threads',crossRequest);
  assert.equal(rejected.statusCode,409);assert.match(rejected.body.error,/NOT_LOADED/);assert.equal(fs.existsSync(b.requestPath),false);
}));
test('a signed peer cannot change the source or target of another reservation in a prepared body',async()=>pair(async(a,b)=>{
  const notice=b.queued(),pending=b.call('eye-a','POST','/api/agent/threads',crossRequest);await notice;
  const original=await claim(b);await pending;
  const delivery=b.store.getEndpointDelivery(original.deliveryId);
  const source=delivery.source;
  const tampered={...delivery,target:{...source},preparation:{...delivery.preparation,target:delivery.preparation.source}};
  const rejected=await a.call('pc-b','POST','/api/device-agents/eye-a/prepared-deliveries',{ledgerOwnerDeviceId:'pc-b',delivery:tampered});
  assert.equal(rejected.statusCode,403);assert.equal(a.owner.readSession('same-application','eye-a','session-eye-a').deliveries.length,0);
}));
