import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAgentOwner } from './deviceAgentOwner.js';
import { createDeviceAgentAdapter } from './deviceAgentAdapter.js';
import type { RabiDeliveryEnvelope } from '../shared/rabiMessage.js';

async function fixture(run: (f: any) => Promise<void>) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'device-agent-owner-'));
  let revoked=false, assignmentHook=async()=>{}, authorityCalls=0;
  const settings={dataDir:directory,ownerInstanceId:'owner-guid',
    authorize:(request:http.IncomingMessage)=>request.headers.authorization==='device' ? {scope:'scope-one',sourceDeviceId:'glasses-one',deviceOwner:true}
      : request.headers.authorization==='phone' ? {scope:'scope-one',sourceDeviceId:'$application',deviceOwner:false}
      : request.headers.authorization==='other' ? {scope:'scope-two',sourceDeviceId:'glasses-one',deviceOwner:true} : null,
    authorizeDelivery:async(request:http.IncomingMessage)=>{authorityCalls++;return ['managed-route','phone','device'].includes(String(request.headers.authorization)) && !revoked ? {scope:'scope-one'} : null;},
    assertDeviceAssignment:async(scope:string,agentId:string)=>{await assignmentHook();if(scope!=='scope-one' || agentId!=='glasses-one')throw Object.assign(new Error('WRONG_DEVICE_OWNER'),{code:'WRONG_DEVICE_OWNER',statusCode:403});}
  };
  let owner=createDeviceAgentOwner(settings);
  const server=http.createServer(async(request,response)=>{try{const chunks=[];for await(const part of request)chunks.push(part);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;await owner.handle(request,response,new URL(request.url!,'http://fixture.invalid'),body);}catch(error){response.writeHead(500);response.end(JSON.stringify({message:String(error)}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+ (server.address() as any).port;
  const call=async(auth:string,method:string,suffix:string,body?:unknown)=>{const response=await fetch(base+'/api/device-agents'+suffix,{method,headers:{authorization:auth,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json() as any};};
  try{await run({call,owner:()=>owner,restart:()=>{owner=createDeviceAgentOwner(settings);},revoke:()=>{revoked=true;},onAssignment:(hook:()=>Promise<void>)=>{assignmentHook=hook;},authorityCalls:()=>authorityCalls});}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});}
}
const envelope=(deliveryId:string):RabiDeliveryEnvelope=>({deliveryId,sentAt:'2026-01-01T00:00:00Z',messageSource:{type:'system',eventType:'route',eventName:'Route message',eventId:deliveryId,routeId:'route-one'},messageContent:'Original Route input '+deliveryId});
const sessionBody={sessionId:'native-session',name:'Glasses Agent',loaded:true,capabilities:['language-model','rabi-api','asr','tts']};

test('real HTTP Route delivery reaches exactly the loaded device owner and commits its original receipt',async()=>fixture(async f=>{
  const registration=await f.call('device','PUT','/glasses-one/session',sessionBody);
  assert.equal(registration.status,200);const session=registration.data.session;
  let posted!:()=>void;const accepted=new Promise<void>(resolve=>{posted=resolve;});
  const adapter=createDeviceAgentAdapter({instanceId:'owner-guid',agentId:'glasses-one'},{waitMs:3000,request:async(_binding,method,suffix,body)=>{
    const response=await f.call('managed-route',method,suffix.replace('/api/device-agents',''),body);assert.equal(response.code,0);if(method==='POST')posted();return response.data;
  }});
  const delivery=adapter.deliver(envelope('original-one'));await accepted;
  const denied=await f.call('phone','POST','/glasses-one/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});assert.equal(denied.status,403);
  const claimed=await f.call('device','POST','/glasses-one/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch});
  assert.equal(claimed.data.delivery.deliveryId,'original-one');assert.match(claimed.data.delivery.prompt,/Original Route input original-one/);await delivery;
  const response=await f.call('device','POST','/glasses-one/deliveries/original-one/response',{...claimed.data.delivery,status:'completed',text:'Actual owner result'});
  assert.equal(response.data.receipt.status,'completed');
  assert.equal((await f.call('phone','GET','/glasses-one/deliveries/original-one')).data.receipt.response.text,'Actual owner result');
  assert.equal((await f.call('managed-route','POST','/glasses-one/deliveries',{deliveryId:'original-one',envelope:envelope('original-one')})).data.receipt.status,'completed');
  assert.equal((await f.call('device','POST','/glasses-one/deliveries/claim',{sessionId:session.sessionId,ownerEpoch:session.ownerEpoch})).data.delivery,null);
  const second=await f.call('phone','POST','/glasses-one/deliveries',{deliveryId:'original-two',envelope:envelope('original-two')});assert.equal(second.data.receipt.status,'queued');
  assert.equal(f.owner().sessions('scope-one').length,1);assert.equal(f.owner().readSession('scope-one','glasses-one','native-session').deliveries.length,1);
}));

test('unloaded device remains queued, phone wake rejection cannot fabricate owner acceptance, restart never replays a claim',async()=>fixture(async f=>{
  await f.call('managed-route','POST','/glasses-one/deliveries',{deliveryId:'blocked',envelope:envelope('blocked')});
  const wakes=await f.call('phone','GET','/glasses-one/wake-requests');const nonce=wakes.data.requests[0].nonce;
  assert.ok(!JSON.stringify(wakes).includes('Original Route input'));
  const claimedWake=await f.call('phone','POST',`/glasses-one/wake-requests/${nonce}/claim`,{});
  assert.equal((await f.call('phone','POST',`/glasses-one/wake-requests/${nonce}/claim`,{})).status,409);
  await f.call('phone','POST',`/glasses-one/wake-requests/${nonce}/receipt`,{claimToken:claimedWake.data.claimToken,status:'failed',errorCode:'dispatch_security_rejected'});
  const receipt=await f.call('managed-route','GET','/glasses-one/deliveries/blocked');assert.equal(receipt.data.receipt.ownerAccepted,false);assert.equal(receipt.data.receipt.status,'queued');
  const registered=await f.call('device','PUT','/glasses-one/session',sessionBody);
  const claim=await f.call('device','POST','/glasses-one/deliveries/claim',registered.data.session);
  f.restart();assert.equal(f.owner().agents('scope-one')[0].loaded,false);
  assert.equal((await f.call('device','POST','/glasses-one/deliveries/blocked/response',{...claim.data.delivery,status:'completed',text:'stale'})).status,409);
  await f.call('device','PUT','/glasses-one/session',sessionBody);
  assert.equal((await f.call('managed-route','GET','/glasses-one/deliveries/blocked')).data.receipt.status,'result-unknown');
  assert.equal((await f.call('managed-route','POST','/glasses-one/deliveries',{deliveryId:'blocked',envelope:envelope('blocked')})).data.receipt.status,'result-unknown');
}));

test('assignment awaits cannot retain revoked Route authority, scopes and exact URL suffixes fail closed',async()=>fixture(async f=>{
  f.onAssignment(async()=>{f.revoke();});
  assert.equal((await f.call('managed-route','POST','/glasses-one/deliveries',{deliveryId:'revoked',envelope:envelope('revoked')})).status,403);
  assert.ok(f.authorityCalls()>=2);assert.equal(f.owner().readDelivery('scope-one','glasses-one','revoked'),null);
  assert.equal((await f.call('other','PUT','/glasses-one/session',sessionBody)).status,403);
  assert.equal((await f.call('device','POST','/glasses-one/deliveries/claim/extra',sessionBody)).status,404);
  assert.equal((await f.call('device','GET','/constructor/session')).status,400);
}));
