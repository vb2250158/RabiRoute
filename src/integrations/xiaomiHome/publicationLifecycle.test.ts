import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createPluginTestHarness,PublicationScope } from '@rabiroute/plugin-sdk';
import { GenerationRuntime } from '../../plugin-kernel/generationRuntime.js';
import type { PluginCandidate } from '../../plugin-kernel/types.js';
import { ManagerPluginRouteRegistry } from '../../manager/managerPluginRouteRegistry.js';
import { XiaomiHomeArtifactStore } from './artifactStore.js';
import { XiaomiHomeSettingsStore,XiaomiHomeRuntimeController } from './settingsRuntime.js';
import { XiaomiHomeEventMonitor } from './eventMonitor.js';
import { HomeAssistantActivityMonitor } from './activityMonitor.js';
import { XiaomiHomeClipCaptureWorker } from './clipCapture.js';
import { markAuthenticatedConnectionRequest } from '../../manager/connectionRequestAccess.js';
import { createXiaomiHomeManagerOperations } from './managerOperations.js';
import type { XiaomiHomeManagerRoutesContext } from './managerRoutes.js';
// @ts-expect-error Plain ESM builtin entry deliberately has no declaration file.
import { activate } from '../../../plugins/builtin/io.rabiroute.manager.xiaomi-home/1.0.0/manager.mjs';

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(t:test.TestContext,readOnly=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaomi-publication-')),directory=path.join(root,'runtime');
  const contexts:XiaomiHomeManagerRoutesContext[]=[],controllers:ControlledController[]=[],counts={deployment:0,subscribed:0,unsubscribed:0,activation:0,retired:0};
  const behavior:{stop?:()=>Promise<void>;failSubscribe?:boolean}={};
  class ControlledController extends XiaomiHomeRuntimeController{
    constructor(...args:ConstructorParameters<typeof XiaomiHomeRuntimeController>){super(...args);controllers.push(this);const stop=this.deployment.stop.bind(this.deployment);this.deployment.start=()=>{counts.deployment++;};this.deployment.stop=async()=>{await behavior.stop?.();await stop();};}
    override async activate(signal?:AbortSignal){counts.activation++;await super.activate(signal);}
  }
  const runtime={managerReadOnly:readOnly,XiaomiHomeArtifactStore,XiaomiHomeSettingsStore,XiaomiHomeRuntimeController:ControlledController,
    lifecycleFence:{applicationGenerationId:'fixture-generation',managerInstanceId:'fixture-manager'},deliverXiaomiHomeEvent:async()=>{throw new Error('Real Agent delivery is outside this fixture.');},webguiLanRequestAllowed:()=>true,
    homeAssistantActivity:{subscribe(listener:(request:null)=>void){if(behavior.failSubscribe)throw new Error('Controlled subscription failure');counts.subscribed++;listener(null);let active=true;return()=>{if(active){active=false;counts.unsubscribed++;}};},receive:async()=>false,report:()=>{}},
    managerPluginRoutes:new ManagerPluginRouteRegistry(),createXiaomiHomeManagerOperations(context:XiaomiHomeManagerRoutesContext){contexts.push(context);return createXiaomiHomeManagerOperations(context);}};
  const closures:Array<()=>Promise<unknown>>=[];
  t.after(async()=>{for(const close of closures.reverse())await close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('xiaomi-publication-'));fs.rmSync(root,{recursive:true,force:true});});
  const prepared=async()=>{const harness=createPluginTestHarness({config:{runtimeDir:directory,eventMonitorEnabled:false},services:[['host.manager.xiaomi-home@1',runtime]]});const publication=new PublicationScope(harness.effects);await activate({...harness.context,publication});await harness.effects.commit();closures.push(()=>harness.dispose());return {harness,publication,context:contexts.at(-1)!,controller:controllers.at(-1)!};};
  const candidate=(revision:string):PluginCandidate=>({instanceId:'manager:xiaomi-home',revision,config:{runtimeDir:directory,eventMonitorEnabled:false},entry:{execution:'in_process',path:'fixture.mjs'},manifest:{schemaVersion:2,id:'io.test.xiaomi',version:'1.0.0',entries:{manager:{execution:'in_process',module:'./fixture.mjs'}},provides:['manager.xiaomi-home@1'],requires:['host.manager.xiaomi-home@1'],optional:[],permissions:[]},policy:{restart:{mode:'never',maxAttempts:0,windowMs:1,initialBackoffMs:1,maximumBackoffMs:1},resources:{maxChildProcesses:0,shutdownTimeoutMs:1000}}});
  return {root,directory,runtime,counts,contexts,controllers,behavior,prepared,candidate,closures};
}
function seed(store:XiaomiHomeArtifactStore,id:string){const occurredAt='2026-10-21T00:00:00Z',localPath=store.allocateMediaPath(id,occurredAt,'.jpg'),bytes=Buffer.from([255,216,255,217]);fs.writeFileSync(localPath,bytes);return store.register({sourceEventId:id,resourceId:'home:ha:camera.fixture',eventKind:'camera_motion_detected',occurredAt,mediaKind:'image/jpeg',localPath,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length});}

test('candidate effects and synchronous publication perform no persistence or background work; activation refreshes original predecessor records',async t=>{
  const f=fixture(t),p=await f.prepared();assert.equal(fs.existsSync(f.directory),false);assert.equal(f.counts.deployment,0);assert.equal(f.counts.subscribed,0);assert.throws(()=>p.context.assertRuntimeAvailable!(),(error:any)=>error.status===503);
  p.publication.publish();p.publication.seal()();const previous=gate();const startup=p.publication.afterPublish(previous.promise);await tick();assert.equal(fs.existsSync(f.directory),false);assert.equal(f.counts.activation,0);
  const original=new XiaomiHomeArtifactStore(f.directory),record=seed(original,'predecessor-late-record');const settings=new XiaomiHomeSettingsStore(f.directory,{eventMonitorEnabled:false});settings.write({...settings.read().settings,eventDeliveryMode:'all'},settings.read().revision);
  previous.release();await startup;assert.equal(f.counts.activation,1);assert.equal(f.counts.deployment,1);assert.equal(f.counts.subscribed,1);p.context.assertRuntimeAvailable!();assert.equal(p.controller.artifacts.get(record.artifactId)?.artifactId,record.artifactId);assert.equal(p.controller.settings().settings.eventDeliveryMode,'all');assert.equal(fs.existsSync(path.join(f.directory,'artifacts/index.json')),true);
});
test('optional downstream publication failure leaves Xiaomi Home healthy and preserves its artifact index',async t=>{
  const f=fixture(t);const kernel=new GenerationRuntime({host:'manager',hostServices:[{capability:'host.manager.xiaomi-home@1',value:f.runtime}],executor:{prepare:async candidate=>candidate.instanceId==='zz:failure'?{activate(context){context.services.provide('test.failure@1',{});context.publication.add({publish(){throw new Error('Controlled publish failure');},rollback(){}});}}:{activate}}});f.closures.push(()=>kernel.dispose());
  await kernel.switch([f.candidate('old')]);const original=kernel.current(),old=f.controllers[0],record=seed(old.artifacts,'original-record'),file=path.join(f.directory,'artifacts/index.json'),before=fs.readFileSync(file);
  const bad:PluginCandidate={...f.candidate('failure'),instanceId:'zz:failure',manifest:{schemaVersion:2,id:'io.test.failure',version:'1.0.0',entries:{manager:{execution:'in_process',module:'./fixture.mjs'}},provides:['test.failure@1'],requires:['manager.xiaomi-home@1'],optional:[],permissions:[]}};
  const {generation}=await kernel.switch([f.candidate('new'),bad],{readyRequires:['manager.xiaomi-home@1']});
  assert.notEqual(kernel.current(),original);assert.equal(generation.readiness.state,'degraded');assert.deepEqual(generation.readiness.missingCapabilities,[]);
  const failure=generation.records.find(item=>item.identity.instanceId==='zz:failure');assert.equal(failure?.status,'failed');assert.equal(failure?.error?.code,'publication_failed');assert.match(failure?.error?.message??'',/Controlled publish failure/);
  assert.equal(generation.services.services.has('test.failure@1'),false);assert.equal(generation.services.services.has('manager.xiaomi-home@1'),true);
  assert.equal(generation.records.find(item=>item.identity.instanceId==='manager:xiaomi-home')?.status,'active');
  assert.equal(f.counts.deployment,2);assert.equal(f.counts.subscribed,2);assert.equal(f.counts.unsubscribed,1);assert.deepEqual(fs.readFileSync(file),before);
  assert.throws(()=>f.contexts[0].assertRuntimeAvailable!());f.contexts[1].assertRuntimeAvailable!();assert.equal(f.controllers[1].artifacts.get(record.artifactId)?.artifactId,record.artifactId);
});
test('cancelled publication waiting for predecessor retirement cannot activate or initialize artifacts',async t=>{
  const f=fixture(t),p=await f.prepared();p.publication.publish();p.publication.seal()();const previous=gate();const work=p.publication.afterPublish(previous.promise);const rejected=assert.rejects(work);await p.harness.dispose();previous.release();await rejected;assert.equal(f.counts.activation,0);assert.equal(f.counts.deployment,0);assert.equal(f.counts.subscribed,0);assert.equal(fs.existsSync(f.directory),false);
});
test('a rejected predecessor retirement cannot initialize artifacts or start any native background owner',async t=>{
  const f=fixture(t),p=await f.prepared();p.publication.publish();p.publication.seal()();await assert.rejects(p.publication.afterPublish(Promise.reject(new Error('Original owner release unconfirmed'))),/release unconfirmed/);assert.equal(f.counts.activation,0);assert.equal(f.counts.deployment,0);assert.equal(f.counts.subscribed,0);assert.equal(fs.existsSync(f.directory),false);
});
test('published readiness gates native work while authenticated non-Lan connections retain public read and write access',async t=>{
  const f=fixture(t),p=await f.prepared();const server=http.createServer((request,response)=>{Object.defineProperty(request.socket,'remoteAddress',{value:'192.0.2.25',configurable:true});markAuthenticatedConnectionRequest(request,()=>{});if(!f.runtime.managerPluginRoutes.handle(request,new URL(request.url!,'http://fixture'),response))response.writeHead(404).end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(method='GET',body?:unknown)=>new Promise<{status:number;body:any}>((resolve,reject)=>{const request=http.request(base+'/api/agent/xiaomi-home/settings',{method,headers:{'x-rabilink-tunnel-local':'original-tunnel','content-type':'application/json','x-rabiroute-expected-application-generation-id':'fixture-generation','x-rabiroute-expected-manager-instance-id':'fixture-manager'}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  assert.equal((await call()).status,503);assert.equal(fs.existsSync(f.directory),false);p.publication.publish();p.publication.seal()();const previous=gate(),work=p.publication.afterPublish(previous.promise);assert.equal((await call()).status,503);previous.release();await work;
  const read=await call();assert.equal(read.status,200);const write=await call('PUT',{settings:read.body.data.settings,revision:read.body.data.revision});assert.equal(write.status,200);assert.equal(write.body.data.source,'runtime');
});
test('explicit Manager read-only mode publishes read contracts without initialization, recovery or subscription',async t=>{
  const f=fixture(t,true),p=await f.prepared();p.publication.publish();p.publication.seal()();await p.publication.afterPublish(Promise.resolve());p.context.assertRuntimeAvailable!();assert.equal(f.runtime.managerPluginRoutes.catalogSnapshot().operations.length,53);assert.equal(fs.existsSync(f.directory),false);assert.equal(f.counts.deployment,0);assert.equal(f.counts.subscribed,0);
});
test('real generation handoff awaits actual previous retirement and old cleanup cannot stop its replacement',async t=>{
  const f=fixture(t);const kernel=new GenerationRuntime({host:'manager',hostServices:[{capability:'host.manager.xiaomi-home@1',value:f.runtime}],executor:{prepare:async()=>({activate})}});f.closures.push(()=>kernel.dispose());
  await kernel.switch([f.candidate('old')]);assert.equal(f.counts.deployment,1);const old=f.controllers[0],entered=gate(),release=gate();f.behavior.stop=async()=>{entered.release();await release.promise;};
  const pending=kernel.switch([f.candidate('new')]);await entered.promise;assert.equal(f.controllers.length,2);assert.equal(f.counts.deployment,1);assert.throws(()=>f.contexts[1].assertRuntimeAvailable!());release.release();f.behavior.stop=undefined;await pending;
  assert.equal(f.counts.deployment,2);assert.equal(f.counts.subscribed,2);assert.equal(f.counts.unsubscribed,1);await old.stop();assert.equal(f.counts.unsubscribed,1);f.contexts[1].assertRuntimeAvailable!();
});
test('post-publication startup failure joins this activation resources without restoring a retired owner',async t=>{
  const f=fixture(t),p=await f.prepared();f.behavior.failSubscribe=true;p.publication.publish();p.publication.seal()();await assert.rejects(p.publication.afterPublish(Promise.resolve()),/Controlled subscription failure/);await p.harness.dispose();assert.equal(f.counts.deployment,1);assert.equal(f.counts.subscribed,0);assert.throws(()=>p.context.assertRuntimeAvailable!());
});

test('synchronously throwing route cleanup still joins every own registration and slow native retirement before rejecting the same disposal',async t=>{
  const f=fixture(t),failure=new Error('Controlled synchronous registration cleanup failure'),release=gate();let routeCalls=0,stopCalls=0,settled=false;
  const register=f.runtime.managerPluginRoutes.registerOperationsAsync.bind(f.runtime.managerPluginRoutes),registerProxies=f.runtime.managerPluginRoutes.registerHttpProxies.bind(f.runtime.managerPluginRoutes);
  f.runtime.managerPluginRoutes.registerOperationsAsync=async(...args)=>{const registration=await register(...args);return {...registration,dispose(){routeCalls++;void registration.dispose().catch(()=>{});throw failure;}};};
  f.runtime.managerPluginRoutes.registerHttpProxies=(...args)=>{const registration=registerProxies(...args);return {...registration,dispose(){routeCalls++;return registration.dispose();}};};
  const p=await f.prepared();f.closures.pop();f.closures.push(async()=>{release.release();await p.controller.stop();await p.harness.dispose().catch(()=>{});});
  p.publication.publish();p.publication.seal()();await p.publication.afterPublish(Promise.resolve());assert.equal(f.counts.subscribed,1);
  f.behavior.stop=async()=>{stopCalls++;await release.promise;};
  const disposal=p.harness.effects.dispose(),again=p.harness.effects.dispose();assert.equal(again,disposal);const rejected=assert.rejects(disposal,(error:any)=>error instanceof AggregateError&&error.errors.includes(failure));void disposal.then(()=>{settled=true;},()=>{settled=true;});
  await tick();assert.equal(routeCalls,2);assert.equal(stopCalls,1);assert.equal(f.counts.unsubscribed,1);assert.equal(settled,false);
  release.release();await rejected;assert.equal(settled,true);await assert.rejects(p.harness.effects.dispose(),(error:any)=>error instanceof AggregateError&&error.errors.includes(failure));assert.equal(stopCalls,1);assert.equal(routeCalls,2);
});

class DelayedSocket extends EventEmitter{sent:string[]=[];closeRequested=false;send(value:string){this.sent.push(value);}close(){this.closeRequested=true;}closed(){this.emit('close');}message(value:unknown){this.emit('message',JSON.stringify(value));}}
test('event retirement waits accepted delivery, capture and socket close and never dispatches a completed old capture',async()=>{
  const socket=new DelayedSocket(),delivery=gate(),capture=gate();let deliveries=0,captures=0;const owner=new XiaomiHomeEventMonitor({agentRoleId:'FixtureRole'}, {credentialToken:'controlled-fixture-only',createSocket:()=>socket,deliverEvent:async()=>{deliveries++;await delivery.promise;},captureMotionClip:async()=>{captures++;await capture.promise;return {artifactId:'original-artifact'} as any;}});
  try {
    assert.equal(owner.start(),true);socket.message({type:'event',id:1,event:{event_type:'state_changed',data:{new_state:{entity_id:'camera.fixture',state:'idle',attributes:{motion_video_latest:'https://media.example/fixture.m3u8',motion_video_time:1_700_000_000}}}}});assert.equal(deliveries,1);assert.equal(captures,1);
    let ended=false;const stopped=owner.stop().then(()=>{ended=true;});delivery.release();capture.release();await tick();assert.equal(ended,false);assert.equal(deliveries,1);socket.message({type:'event',id:1,event:{event_type:'state_changed',data:{new_state:{entity_id:'switch.fixture',state:'unavailable'}}}});assert.equal(deliveries,1);socket.closed();await stopped;assert.equal(ended,true);
  } finally {
    delivery.release();capture.release();const stopped=owner.stop();socket.closed();await stopped;
  }
});
test('Activity retirement joins accepted storage and actual socket close without a replacement subscription',async()=>{
  const socket=new DelayedSocket(),storage=gate();let listener!:(request:any)=>void,unsubscribed=0,received=0;const owner=new HomeAssistantActivityMonitor('http://127.0.0.1:8123',{credentialToken:'controlled-fixture-only',createSocket:()=>socket as any,port:{subscribe(callback){listener=callback;return()=>{unsubscribed++;};},receive:async()=>{received++;await storage.promise;return true;},report:()=>{}}});
  owner.start();const now=Date.now();listener({roleId:'Example',startedAt:now-1000});socket.message({type:'event',id:2,event:{events:[{when:now/1000,state:'on',entity_id:'switch.fixture'}]}});await tick();assert.equal(received,1);let ended=false;const stopped=owner.stop().then(()=>{ended=true;});storage.release();await tick();assert.equal(ended,false);assert.equal(unsubscribed,1);socket.closed();await stopped;assert.equal(ended,true);
});
test('native clip owner closes new admission and waits an accepted controlled fetch without spawning media tools',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaomi-clip-retire-')),entered=gate(),release=gate();const store=new XiaomiHomeArtifactStore(path.join(root,'runtime'));
  const worker=new XiaomiHomeClipCaptureWorker({cameraClipCaptureEnabled:true,cameraClipAllowedHosts:['media.example']},store,async()=>{entered.release();await release.promise;return new Response('#EXTM3U\n',{status:200});});
  t.after(async()=>{release.release();await worker.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('xiaomi-clip-retire-'));fs.rmSync(root,{recursive:true,force:true});});
  const input={sourceEventId:'original-event',resourceId:'home:ha:camera.fixture',resourceName:'Fixture',occurredAt:'2026-10-21T00:00:00Z',eventType:'motion',playlistUrl:'https://media.example/fixture.m3u8'};
  const pending=worker.capture(input),rejected=assert.rejects(pending);await entered.promise;let ended=false;const closing=worker.close().then(()=>{ended=true;});await tick();assert.equal(ended,false);await assert.rejects(worker.capture({...input,sourceEventId:'different-event'}),/owner has stopped/);release.release();await rejected;await closing;assert.equal(ended,true);assert.equal(fs.existsSync(path.join(root,'runtime')),false);
});
