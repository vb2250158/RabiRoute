import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { CompanionActivity,readCompanionPresets,recordCompanionInteraction,type CompanionPorts } from './companionActivity.js';
import { CompanionContinuationStore } from './companionContinuation.js';
import { createPersonaCompanionOwner,type PersonaCompanionContext } from './companionActivityRoutes.js';
import { createPersonaCompanionOperations } from './personaCompanionOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { assertTrustedLanAgentPrincipal,evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
const jpeg=Buffer.from([255,216,255,217]);
const start={requestId:'original-request',presetId:'adaptive',title:'Original activity',autoReview:false,voice:false,observationOwner:'desktop'};
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-companion-contract-')),root={value:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'};
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-companion-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const connection={local:true,enabled:true,version:1};
  const behavior:{context?:()=>Promise<string>;saveDefault?:()=>Promise<boolean>}={},delivered:unknown[]=[],spoken:unknown[]=[],records:unknown[]=[];
  const ports:CompanionPorts={presets:readCompanionPresets({presets:[{id:'adaptive',label:'Adaptive',labelEn:'Adaptive',reviewSeconds:25,replyAgeSeconds:30,guidance:'Observe'}]}),changed:()=>{},reaction:()=>{},context:async()=>behavior.context?behavior.context():'Original role context',deliver:async(session,review)=>{delivered.push({session,review});},speak:async(_session,text)=>{spoken.push(text);},cancelSpeech:async()=>{},save:async session=>{records.push(session);}};
  const service=new CompanionActivity(ports),continuation=new CompanionContinuationStore(path.join(directory,'continuation'));
  const context:PersonaCompanionContext={service,continuation,roleDirectory:role=>path.join(root.value,role),identity:()=>identity,local:()=>connection.local,readOnly:()=>false,verifyGateway:()=> 'original-route',saveSummaryDefault:async()=>behavior.saveDefault?behavior.saveDefault():false,last:async()=>({id:'original-summary'})};
  const definitions=createPersonaCompanionOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('companion-fixture',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'auth.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(request.headers['x-fixture-connection']==='rabilink'){Object.defineProperty(request.socket,'remoteAddress',{value:'192.0.2.25',configurable:true});const version=connection.version;markAuthenticatedConnectionRequest(request,()=>{if(!connection.enabled||connection.version!==version)throw Object.assign(new Error('Original RabiLink connection expired'),{statusCode:403});});assert.equal(assertTrustedLanAgentPrincipal(request),undefined);}else{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);}registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await service.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const call=(suffix='',method='GET',body?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;body:any;bytes:Buffer;contentType:string}>((resolve,reject)=>{const request=http.request(base+'/api/roles/Example/companion'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',...headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);response.on('end',()=>{const bytes=Buffer.concat(chunks),contentType=String(response.headers['content-type']);resolve({status:response.statusCode!,body:contentType.startsWith('application/json')?JSON.parse(bytes.toString()):undefined,bytes,contentType});});});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  return {context,root,identity,connection,behavior,service,ports,continuation,definitions,call,delivered,spoken,records};
}
test('all eight companion operations succeed for an empty authenticated node through original native activity and frame owner',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,8);
  assert.equal((await f.call()).body.data.session,null);assert.equal((await f.call('/last')).body.data.id,'original-summary');
  const accepted=await f.call('/start','POST',start);assert.equal(accepted.status,200,JSON.stringify(accepted.body));const session=accepted.body.data.session;assert.equal(session.gatewayId,'original-route');
  const replay=await f.call('/start','POST',start);assert.equal(replay.body.data.session.id,session.id);assert.equal((await f.continuation.read('Example'))?.gatewayId,'original-route');
  const observed=await f.call('/observation','POST',{sessionId:session.id,revision:session.revision,observation:{sequence:1,capturedAt:Date.now(),source:'window',jpeg:jpeg.toString('base64')}});assert.equal(observed.status,200);
  const review=await f.call('/review','POST',{sessionId:session.id,revision:session.revision,text:''});assert.equal(review.status,200);const reviewId=review.body.data.session.review.id;assert.equal(f.delivered.length,1);
  const frame=await f.call('/frame?reviewId='+reviewId);assert.equal(frame.status,200);assert.equal(frame.contentType,'image/jpeg');assert.deepEqual(frame.bytes,jpeg);
  const input={sessionId:session.id,revision:session.revision,reviewId,text:'Original reply',activityKind:'watch'};
  const reply=await f.call('/reply','POST',input);assert.equal(reply.status,200);assert.equal(reply.body.data.session.notes.length,1);assert.equal((await f.call('/reply','POST',input)).body.data.session.notes.length,1);
  const stopped=await f.call('/command','POST',{sessionId:session.id,revision:session.revision,action:'stop'});assert.equal(stopped.status,200);assert.equal(await f.continuation.read('Example'),null);assert.equal((await f.call('/frame?reviewId='+reviewId)).status,404);
});
test('companion native revisions, input bounds, content type and request fingerprint remain authoritative',async t=>{
  const f=await fixture(t);const accepted=await f.call('/start','POST',start),session=accepted.body.data.session;
  assert.equal((await f.call('/start','POST',{...start,title:'Different intent'})).status,409);
  assert.equal((await f.call('/command','POST',{sessionId:session.id,revision:999,action:'stop'})).status,409);
  assert.equal((await f.call('/review','POST',{}, {'content-type':'text/plain'})).status,415);
  assert.equal((await f.call('/review','POST',{text:'x'.repeat(3*1024*1024)})).status,413);
  assert.equal(f.service.snapshot('Example').session!.id,session.id);
});
test('companion roots and generation are captured before defaults and before queued native start',async t=>{
  const f=await fixture(t),owner=createPersonaCompanionOwner(f.context),request=()=>{const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});const input=new http.IncomingMessage(socket);input.headers={'host':'127.0.0.1','content-type':'application/json'};return input;},bound=owner.prepare(request(),'Example','start');
  f.root.value+='/replacement';await assert.rejects(bound.execute(start,new URLSearchParams()),/owner changed/);assert.equal(f.service.snapshot('Example').session,null);
  f.root.value=path.dirname(f.context.roleDirectory('Example')).replace('/replacement','');
  const entered=gate(),wait=gate();f.behavior.saveDefault=async()=>{entered.release();await wait.promise;return false;};
  const pending=f.call('/start','POST',start);await entered.promise;f.identity.applicationGenerationId='replacement-generation';wait.release();assert.equal((await pending).status,409);assert.equal(f.service.snapshot('Example').session,null);
});
test('original review context completion cannot dispatch after generation replacement and native request cleanup is joined',async t=>{
  const f=await fixture(t),session=(await f.call('/start','POST',start)).body.data.session;
  await f.call('/observation','POST',{sessionId:session.id,revision:session.revision,observation:{sequence:1,capturedAt:Date.now(),source:'window',jpeg:jpeg.toString('base64')}});
  const entered=gate(),wait=gate();f.behavior.context=async()=>{entered.release();await wait.promise;return 'Original context';};
  const pending=f.call('/review','POST',{sessionId:session.id,revision:session.revision,text:''});await entered.promise;f.identity.applicationGenerationId='replacement-generation';wait.release();const response=await pending;
  assert.equal(response.status,409);assert.equal(response.body.uncertain,true);assert.equal(f.delivered.length,0);
});
test('native companion persistence ports carry the original assertion across their own async work',async t=>{
  const f=await fixture(t),entered=gate(),wait=gate();let callbackObserved=false;
  f.ports.record=async(session,assertCurrent)=>{callbackObserved=typeof assertCurrent==='function';entered.release();await wait.promise;await recordCompanionInteraction(f.context.roleDirectory(session.roleId),session,assertCurrent);};
  const original=f.root.value,pending=f.call('/start','POST',{...start,saveSummary:true});await entered.promise;f.root.value=path.join(original,'replacement');wait.release();const response=await pending;
  assert.equal(callbackObserved,true);assert.equal(response.status,409);assert.equal(response.body.uncertain,true);assert.equal(fs.existsSync(path.join(original,'Example','companion')),false);assert.equal(fs.existsSync(path.join(f.root.value,'Example','companion')),false);
});
test('continuation atomic writes revalidate before filesystem publication without creating a new checkpoint',async t=>{
  const f=await fixture(t),session=(await f.service.start('Example',{...start,observationOwner:'desktop',gatewayId:'original-route',saveSummary:false})).session!;
  let checks=0;await assert.rejects(f.continuation.save(session,()=>{if(++checks>=3)throw new Error('Original connection changed');}),/Original connection changed/);
  assert.equal(await f.continuation.read('Example'),null);assert.equal(fs.existsSync(path.join(f.root.value,'continuation','Example.json')),false);
});
test('a remote authenticated RabiLink connection without a Lan principal can read and write and retains its original revocation guard',async t=>{
  const f=await fixture(t);f.connection.local=false;
  const headers={authorization:'','x-fixture-connection':'rabilink','x-rabilink-tunnel-local':'original-tunnel'};
  const call=(suffix='',method='GET',body?:unknown)=>f.call(suffix,method,body,headers);
  assert.equal((await call()).status,200);const accepted=await call('/start','POST',start);assert.equal(accepted.status,200);const session=accepted.body.data.session;
  assert.equal((await call('/observation','POST',{sessionId:session.id,revision:session.revision,observation:{sequence:1,capturedAt:Date.now(),source:'window',jpeg:jpeg.toString('base64')}})).status,200);
  const entered=gate(),wait=gate();f.behavior.context=async()=>{entered.release();await wait.promise;return 'Original context';};
  const pending=call('/review','POST',{sessionId:session.id,revision:session.revision,text:''});await entered.promise;f.connection.enabled=false;f.connection.version++;f.connection.enabled=true;wait.release();const denied=await pending;
  assert.equal(denied.status,403);assert.equal(f.delivered.length,0);f.behavior.context=undefined;
  assert.equal((await call('/command','POST',{sessionId:session.id,revision:session.revision,action:'stop'})).status,200);
  const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'192.0.2.25'});const original=new http.IncomingMessage(socket);original.headers={'x-rabilink-tunnel-local':'original-tunnel'};
  let valid=true;markAuthenticatedConnectionRequest(original,()=>{if(!valid)throw new Error('Original connection revoked');});const bound=createPersonaCompanionOwner(f.context).prepare(original,'Example','snapshot');valid=false;
  await assert.rejects(bound.execute(undefined,new URLSearchParams()),(error:any)=>error.statusCode===403);assert.equal(bound.mutationOutcome(),'not_started');
});
