import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { DEFAULT_ALL_DAY_SETTINGS,type AllDayEvent } from '../shared/allDayRecording.js';
import { createAllDayRecording } from './allDayRecordingRoutes.js';
import { readAllDayStorage } from './allDayRecordingReadStorage.js';
import { createPersonaRecordingOwner,type PersonaRecordingContext } from './personaRecordingOwner.js';
import { createPersonaRecordingOperations } from './personaRecordingOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { assertTrustedLanAgentPrincipal,evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { ManagerReadWorkerPool } from './managerReadWorkerPool.js';
import { AllDayRecordingReadModel } from './allDayRecordingReadModel.js';
const settings={...DEFAULT_ALL_DAY_SETTINGS,sources:{...DEFAULT_ALL_DAY_SETTINGS.sources,homeAssistant:true}};
const jpeg=Buffer.from([255,216,255,217]),wav=Buffer.from('RIFForiginal-audio');
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(t:test.TestContext,nativeWorker=false){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-recording-contract-')),root={value:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'};
  const cleanup=()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-recording-contract-'));fs.rmSync(directory,{recursive:true,force:true});};
  const pool=nativeWorker?new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:4,timeoutMs:5000}):undefined;
  const connection={local:true,enabled:true,version:1};
  const mobile:unknown[]=[],repairs:unknown[]=[],behavior:{media?:()=>Promise<Buffer>}={};
  const runtime=createAllDayRecording({roleDirectory:role=>path.join(root.value,role),hostId:'original-host',mobileRoot:path.join(directory,'mobile'),speechUrl:()=>{throw new Error('Real speech is outside this fixture');},changed:()=>{},mobileAudio:async(owner,chunks,authorize)=>{authorize?.();mobile.push({owner,chunks});return wav;},runRead:async(job,signal)=>pool?pool.run({type:'all_day_recording_read',input:job},{signal}):readAllDayStorage(job)});
  const nativeMedia=runtime.reads.media.bind(runtime.reads);runtime.reads.media=async(...args)=>behavior.media?behavior.media():nativeMedia(...args);
  runtime.reads.timeline=async(role,since,until)=>({events:await runtime.store.timeline(role,since,until),loading:false,pendingDays:[],readError:undefined});
  runtime.audio=async(recordId,authorize)=>{authorize?.();assert.equal(recordId,'original-speech-record');return {status:200,contentType:'audio/wav',headers:{},body:wav};};
  const nativeRepair=runtime.repairIndex.bind(runtime);runtime.repairIndex=(role,day)=>{repairs.push({role,day});nativeRepair(role,day);};
  const context:PersonaRecordingContext={runtime,roleDirectory:role=>path.join(root.value,role),identity:()=>identity,local:()=>connection.local,readOnly:()=>false};
  const definitions=createPersonaRecordingOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('recording-fixture',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(request.headers['x-fixture-connection']==='rabilink'){Object.defineProperty(request.socket,'remoteAddress',{value:'192.0.2.25',configurable:true});const version=connection.version;markAuthenticatedConnectionRequest(request,()=>{if(!connection.enabled||connection.version!==version)throw Object.assign(new Error('Original RabiLink connection expired'),{statusCode:403});});assert.equal(assertTrustedLanAgentPrincipal(request),undefined);}else{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);}registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await runtime.dispose();await pool?.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));cleanup();});
  const call=(suffix='',method='GET',body?:unknown,prefix='/api/roles',headers:Record<string,string>={})=>new Promise<{status:number;body:any;bytes:Buffer;contentType:string}>((resolve,reject)=>{const request=http.request(base+prefix+'/Example/all-day-recording'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',...headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);response.on('end',()=>{const bytes=Buffer.concat(chunks),contentType=String(response.headers['content-type']);resolve({status:response.statusCode!,body:contentType.startsWith('application/json')?JSON.parse(bytes.toString()):undefined,bytes,contentType});});});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  const time=Date.now()-1000,day=new Date(time).toISOString().slice(0,10),image:AllDayEvent={id:'original-image',startedAt:time,endedAt:time,source:'screen',deviceId:'original-host',kind:'image',text:'Original frame',state:'saved'};
  return {directory,context,runtime,root,identity,connection,definitions,call,behavior,repairs,mobile,time,day,image,pool};
}
test('all twenty-four recording operations succeed through original native owners for an authenticated empty node',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,24);await f.runtime.store.append('Example',f.image,jpeg);
  await f.runtime.store.append('Example',{...f.image,id:'original-audio',kind:'audio',source:'microphone',text:'Original transcript',speechRecordId:'original-speech-record'});
  const hash=createHash('sha256').update(f.image.id).digest('hex');
  for(const prefix of ['/api/roles','/roles']){
    const configured=await f.call('/settings','PUT',settings,prefix);assert.equal(configured.status,200,JSON.stringify(configured.body));assert.equal(configured.body.data.settings.sources.homeAssistant,true);
    for(const suffix of ['', '/recent','/catalog?summary=1','/page?direction=older&time='+Date.now(),'/transcripts?since='+(f.time-1)+'&until='+(f.time+1),'/events?since='+(f.time-1)+'&until='+(f.time+1)])assert.equal((await f.call(suffix,'GET',undefined,prefix)).status,200,suffix);
    const media=await f.call('/media/'+f.day+'/'+hash+'.jpg','GET',undefined,prefix);assert.equal(media.status,200);assert.deepEqual(media.bytes,jpeg);
    const audio=await f.call('/audio?since='+(f.time-1)+'&until='+(f.time+1)+'&id=original-audio','GET',undefined,prefix);assert.equal(audio.status,200);assert.deepEqual(audio.bytes,wav);
    const started=await f.call('/start','POST',undefined,prefix);assert.equal(started.status,200);assert.equal(started.body.data.running,true);assert.equal((await f.call('/start','POST',undefined,prefix)).body.data.startedAt,started.body.data.startedAt);
    const stopped=await f.call('/stop','POST',undefined,prefix);assert.equal(stopped.status,200);assert.equal(stopped.body.data.running,false);
    assert.equal((await f.call('/index-repair/'+f.day,'POST',undefined,prefix)).body.data.queued,true);
  }
  assert.equal(f.repairs.length,2);
});
test('phone media uses the selected native timeline event owner and chunks rather than Agent-supplied identity',async t=>{
  const f=await fixture(t),phone='original-phone-owner',chunks=['a'.repeat(64)];await f.runtime.store.receiveMobile(phone,{id:'phone-event',startedAt:f.time,endedAt:f.time,text:'Phone transcript',chunks});
  const deviceId=createHash('sha256').update(phone).digest('hex');await f.runtime.store.configure('Example',{...settings,mobileDeviceIds:[deviceId]});
  const events=await f.runtime.store.timeline('Example',f.time-1,f.time+1),event=events.find(item=>item.source==='mobile')!;
  const audio=await f.call('/audio?since='+(f.time-1)+'&until='+(f.time+1)+'&id='+encodeURIComponent(event.id)+'&owner=forged');assert.equal(audio.status,200);assert.deepEqual(audio.bytes,wav);assert.deepEqual(f.mobile,[{owner:phone,chunks}]);
  await f.runtime.store.configure('Example',settings);assert.equal((await f.call('/audio?since='+(f.time-1)+'&until='+(f.time+1)+'&id='+encodeURIComponent(event.id))).status,404);
});
test('original JSON controls, bounds, loading and opaque audio status survive executable registration',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/settings','PUT',{},'/api/roles',{'content-type':'text/plain'})).status,415);assert.equal((await f.call('/settings','PUT',{})).status,400);assert.equal((await f.call('/events?since=0&until=999999999')).status,400);assert.equal((await f.call('/page?direction=invalid&time=1')).status,400);
  f.runtime.reads.timeline=async()=>({events:[],loading:true,pendingDays:[f.day],readError:undefined});assert.equal((await f.call('/audio?since=1&until=2&id=missing')).status,409);
  f.runtime.reads.timeline=async()=>({events:[{...f.image,id:'audio',kind:'audio',speechRecordId:'original-speech-record'}],loading:false,pendingDays:[],readError:undefined});
  f.runtime.audio=async()=>({status:502,contentType:'text/plain',headers:{},body:Buffer.from('original speech failure')});const upstream=await f.call('/audio?since=1&until=2&id=audio');assert.equal(upstream.status,502);assert.equal(upstream.bytes.toString(),'original speech failure');
});
test('native recording settings and projection caches distinguish changed role roots, and prepared writes reject the old root',async t=>{
  const f=await fixture(t);await f.runtime.store.configure('Example',settings);await f.runtime.store.append('Example',f.image,jpeg);
  const initial=await f.call('/media/'+f.day+'/'+createHash('sha256').update(f.image.id).digest('hex')+'.jpg');assert.equal(initial.status,200);
  const owner=createPersonaRecordingOwner(f.context),socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});const request=new http.IncomingMessage(socket);request.headers={'content-type':'application/json',host:'127.0.0.1'};const old=owner.prepare(request,'Example','settings');
  f.root.value=path.join(f.directory,'replacement');await assert.rejects(old.execute(settings,new URLSearchParams()),/owner changed/);assert.equal(old.mutationOutcome(),'not_started');assert.deepEqual(await f.runtime.store.settings('Example'),DEFAULT_ALL_DAY_SETTINGS);
  assert.equal((await f.call('/media/'+f.day+'/'+createHash('sha256').update(f.image.id).digest('hex')+'.jpg')).status,400);
});
test('media cancellation joins the original read before retiring the operation and generation changes withhold its bytes',async t=>{
  const f=await fixture(t),entered=gate(),wait=gate();f.behavior.media=async()=>{entered.release();await wait.promise;return jpeg;};
  const pending=f.call('/media/'+f.day+'/'+'b'.repeat(64)+'.jpg');await entered.promise;f.identity.applicationGenerationId='replacement-generation';wait.release();const response=await pending;assert.equal(response.status,409);assert.notDeepEqual(response.bytes,jpeg);
  const signal=new AbortController(),socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});const request=new http.IncomingMessage(socket);request.headers.host='127.0.0.1';const bound=createPersonaRecordingOwner(f.context).prepare(request,'Example','media',signal.signal);
  const accepted=gate(),release=gate();let returned=false;f.behavior.media=async()=>{accepted.release();await release.promise;return jpeg;};const work=bound.execute(undefined,new URLSearchParams(),{day:f.day,file:'b'.repeat(64)+'.jpg'}).finally(()=>{returned=true;});await accepted.promise;signal.abort(new Error('Controlled cancellation'));await Promise.resolve();assert.equal(returned,false);release.release();await assert.rejects(work,/Controlled cancellation/);
});
test('native recording media uses a real isolated read worker and the original pool confirms process release',async t=>{
  const f=await fixture(t,true);await f.runtime.store.append('Example',f.image,jpeg);const hash=createHash('sha256').update(f.image.id).digest('hex');
  // A fresh projection represents a cold Manager read; committed frames otherwise use the legitimate hot cache.
  const cold=new AllDayRecordingReadModel({directory:role=>f.runtime.store.directory(role),mobileRoot:f.runtime.store.mobileRoot,settings:role=>f.runtime.store.settings(role),ready:()=>{},run:(input,signal)=>f.pool!.run({type:'all_day_recording_read',input},{signal})});
  f.runtime.reads.media=cold.media.bind(cold);t.after(()=>cold.dispose());
  const result=await f.call('/media/'+f.day+'/'+hash+'.jpg');assert.equal(result.status,200);assert.deepEqual(result.bytes,jpeg);
  assert.ok(f.pool!.status().spawnedWorkers>=1);assert.equal(f.pool!.status().active,0);assert.equal(f.pool!.status().queued,0);
  await f.runtime.dispose();await f.pool!.stop();assert.deepEqual(f.pool!.status().workerPids,[]);assert.equal(f.pool!.status().active,0);assert.equal(f.pool!.status().queued,0);
});
test('recording playback persistence combines the original capture session with its caller assertion',async t=>{
  const f=await fixture(t);await f.runtime.store.configure('Example',settings);await f.runtime.service.start('Example');let checks=0;
  await assert.rejects(f.runtime.service.savePlayback('Example','original-playback',f.time,f.time+1,'Original playback',wav,()=>{if(++checks>=4)throw new Error('Original request changed');}),/Original request changed/);
  assert.equal(await f.runtime.store.hasEvent('Example',{...f.image,id:'systemPlayback:original-playback'}),false);
});
test('runtime disposal joins accepted reconstruction and queued repair cannot follow a changed root',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-recording-repair-')),root={value:directory},entered=gate(),release=gate(),scanned:string[]=[];
  const runtime=createAllDayRecording({roleDirectory:role=>path.join(root.value,role),hostId:'original-host',mobileRoot:path.join(directory,'mobile'),speechUrl:()=>{throw new Error('No speech');},changed:()=>{},mobileAudio:async()=>wav,runRead:async job=>{if(job.kind==='scan'){scanned.push(job.directory);entered.release();await release.promise;}return readAllDayStorage(job);}});
  t.after(async()=>{release.release();await runtime.dispose();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-recording-repair-'));fs.rmSync(directory,{recursive:true,force:true});});
  const time=Date.parse('2026-10-10'),event:AllDayEvent={id:'original-event',startedAt:time,endedAt:time,source:'window',deviceId:'original-host',kind:'window',text:'Original',state:'saved'};await runtime.store.append('Example',event);
  const first=runtime.store.repairIndex('Example','2026-10-10');await entered.promise;const queued=runtime.store.repairIndex('Example','2026-10-11'),rejected=assert.rejects(queued,/directory changed/);
  root.value=path.join(directory,'replacement');let stopped=false;const disposal=runtime.dispose().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);release.release();await first;await rejected;await disposal;
  assert.equal(stopped,true);assert.equal(scanned.length,1);assert.ok(scanned[0].startsWith(directory));assert.equal(fs.existsSync(root.value),false);
});
test('a remote authenticated RabiLink connection without a Lan principal has public recording reads and writes and cannot replace its original guard',async t=>{
  const f=await fixture(t);f.connection.local=false;const headers={authorization:'','x-fixture-connection':'rabilink','x-rabilink-tunnel-local':'original-tunnel'};
  const call=(suffix='',method='GET',body?:unknown)=>f.call(suffix,method,body,'/api/roles',headers);
  assert.equal((await call()).status,200);assert.equal((await call('/settings','PUT',settings)).status,200);assert.equal((await call('/start','POST')).body.data.running,true);assert.equal((await call('/stop','POST')).body.data.running,false);
  const entered=gate(),wait=gate();f.behavior.media=async()=>{entered.release();await wait.promise;return jpeg;};const pending=call('/media/'+f.day+'/'+'a'.repeat(64)+'.jpg');await entered.promise;f.connection.enabled=false;f.connection.version++;f.connection.enabled=true;wait.release();const denied=await pending;assert.equal(denied.status,403);assert.notDeepEqual(denied.bytes,jpeg);
  const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:'192.0.2.25'});const original=new http.IncomingMessage(socket);original.headers={'content-type':'application/json','x-rabilink-tunnel-local':'original-tunnel'};
  let valid=true;markAuthenticatedConnectionRequest(original,()=>{if(!valid)throw new Error('Original connection revoked');});const bound=createPersonaRecordingOwner(f.context).prepare(original,'Example','settings');valid=false;
  await assert.rejects(bound.execute(settings,new URLSearchParams()),(error:any)=>error.statusCode===403);assert.equal(bound.mutationOutcome(),'not_started');
});
