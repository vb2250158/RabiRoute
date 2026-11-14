import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRabiApiOwner } from "../src/plugins/io.rabiroute.manager.route-control/src/manager/rabiApi.ts";
import { createSpeechPluginRuntime } from "../src/plugins/io.rabiroute.manager.speech/src/manager/speechPluginRuntime.ts";
import { RabiGlobalConfigStore } from "../src/manager/globalConfig.ts";
import { publicRabiLinkRelayConfig } from "../src/shared/rabiLinkRelayPublicConfig.ts";
import { createPeerSpeechAdapter } from "../src/plugins/io.rabiroute.manager.speech/src/peerTunnel/speechAdapter.ts";
import { createOwnedRuntime } from "../src/plugins/io.rabiroute.manager.rabilink-relay/hostRuntime.mjs";
import { handleAgentReply } from "../src/endpointEgress.fixture.ts";
import { rabiLinkDraftFromMeta, rabiLinkIdentityPatch } from "../ribiwebgui/src/rabiLinkPresentation.ts";

test("managed speech config migrates defaults, preserves explicit endpoints and persists mode", t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"speech-mode-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const owner=new RabiGlobalConfigStore(root);assert.equal(owner.read().rabiLinkRelay.speechServiceMode,"managed");
 for(const [url,mode] of [["http://127.0.0.1:8781","managed"],["http://127.0.0.1:54321","configured"],["https://speech.example.test","configured"]]){
  const raw=JSON.parse(fs.readFileSync(owner.configPath,"utf8"));raw.rabiLinkRelay.speechServiceUrl=url;delete raw.rabiLinkRelay.speechServiceMode;fs.writeFileSync(owner.configPath,JSON.stringify(raw));
  const migrated=new RabiGlobalConfigStore(root);assert.equal(migrated.read().rabiLinkRelay.speechServiceUrl,url);assert.equal(migrated.read().rabiLinkRelay.speechServiceMode,mode);
 }
 const live=new RabiGlobalConfigStore(root);live.patch({rabiLinkRelay:{speechServiceMode:"managed"}});
 live.patch({rabiLinkRelay:{speechServiceUrl:"http://127.0.0.1:8781"}});assert.equal(live.read().rabiLinkRelay.speechServiceMode,"configured");
 live.patch({rabiLinkRelay:{speechServiceMode:"managed"}});live.patch({rabiName:"renamed"});assert.equal(new RabiGlobalConfigStore(root).read().rabiLinkRelay.speechServiceMode,"managed");
 assert.equal(publicRabiLinkRelayConfig(live.read().rabiLinkRelay).speechServiceMode,"managed");
 assert.throws(()=>live.patch({rabiLinkRelay:{speechServiceMode:"invalid"}}),/speechServiceMode/);
});

test("UI configuration saves mode with unrelated settings and retains an explicit endpoint", () => {
 for(const mode of ["managed","configured"]){const draft=rabiLinkDraftFromMeta({rabiName:"fixture",rabiLinkRelay:{speechServiceMode:mode,speechServiceUrl:"http://127.0.0.1:54321"}});draft.rabiName="renamed";
  const patch=rabiLinkIdentityPatch(draft);assert.equal(patch.rabiLinkRelay.speechServiceMode,mode);assert.equal(patch.rabiLinkRelay.speechServiceUrl,"http://127.0.0.1:54321");}
 assert.equal(rabiLinkDraftFromMeta({}).speechServiceMode,"managed");
});

test("peer-only compute stays available without a local READY endpoint", async () => {
 let calls=0,localResolutions=0;const adapter=createPeerSpeechAdapter(()=>({selected:()=>"peer-fixture",fetch:async(_id,_service,pathname)=>{calls++;return Response.json(pathname==="/health"?{ok:true,service:"RabiSpeech"}:{models:[],providers:{tts:{},asr:{}}});}}),undefined,()=>{localResolutions++;throw Object.assign(new Error("owned endpoint unavailable"),{status:409});});
 const result=await adapter.requestJson("","/v1/models");assert.equal(result.status,200);const status=await adapter.inspect("");assert.equal(status.state,"online");assert.equal(status.configuredUrl,"peer:peer-fixture");assert.equal(localResolutions,0);
 await assert.rejects(adapter.requestJson("","/v1/playback/status"),/owned endpoint unavailable/);assert.equal(localResolutions,1);
 const before=calls;await assert.rejects(adapter.requestBinary("","/v1/audio/speech",{method:"POST",body:JSON.stringify({input:"fixture",play:true})}),/owned endpoint unavailable/);assert.equal(calls,before+1);
});

test("ordinary text does not evaluate a managed Speech endpoint", async () => {
 const result=await handleAgentReply({routeProfileId:"main",text:"fixture"},{rootDir:process.cwd(),routeRoot:"data/route",rolesRoot:"data/roles",speechServiceUrl:()=>assert.fail("Text must not resolve Speech"),runtimes:[{id:"main",pipeline:{outputAdapter:"agent",outputPipeline:"agent"}}]});assert.equal(result.ok,true);
});

test("Speech readiness is isolated from Manager and resource peer services", async () => {
 let endpoint="";const ports={rootDir:process.cwd(),path,managerBaseUrl:"http://127.0.0.1:54321",managerInstanceId:"fixture-generation",resourceCacheKey:"fixture-key",currentPluginActivation:()=>({}),rabiLinkRelayConfigForMeta:()=>({deviceId:"fixture"}),createManagerApiOperationsService:()=>({}),prepareManagerPeerRuntime:options=>options,
  speechServiceUrl:()=>{if(!endpoint)throw Object.assign(new Error("not ready"),{status:409});return endpoint;}};
 const runtime=await createOwnedRuntime(ports).createPeerRuntime();const absent=runtime.tunnel.services();assert.ok(absent.manager);assert.ok(absent.resources);assert.equal(absent.speech,undefined);
 endpoint="http://127.0.0.1:54322";assert.equal(runtime.tunnel.services().speech.baseUrl,endpoint);endpoint="http://127.0.0.1:54323";assert.equal(runtime.tunnel.services().speech.baseUrl,endpoint);
});

test("only a successfully committed Speech endpoint change requests automatic reconciliation", async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"speech-save-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new RabiGlobalConfigStore(root);let changes=0;
 const owner=createRabiApiOwner({globalConfig:store,syncRabiLinkRelay:async()=>{},runtimes:()=>[],syncRunningGateways:()=>{},reconcileSpeechConfiguration:()=>{changes++;assert.equal(JSON.parse(fs.readFileSync(store.configPath,"utf8")).rabiLinkRelay.speechServiceMode,store.read().rabiLinkRelay.speechServiceMode);}});
 assert.equal((await owner.updateIdentity({rabiName:"unrelated"},()=>{})).status,200);assert.equal(changes,0);
 assert.equal((await owner.updateIdentity({rabiLinkRelay:{speechServiceUrl:"http://127.0.0.1:54321"}},()=>{})).status,200);assert.equal(changes,1);
 await owner.updateIdentity({rabiLinkRelay:{speechServiceMode:"configured",speechServiceUrl:"http://127.0.0.1:54321"}},()=>{});assert.equal(changes,1);
 await owner.updateIdentity({rabiLinkRelay:{speechServiceMode:"managed"}},()=>{});assert.equal(changes,2);
 assert.equal((await owner.updateIdentity({rabiLinkRelay:{speechServiceMode:"invalid"}},()=>{})).status,400);assert.equal(changes,2);
});

function configurationService(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"speech-handoff-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const services=new Map();const ports={rootDir:root,packageRoot:process.cwd(),currentService:id=>services.get(id),modelChanged:()=>{},reportError:()=>{},peerRuntime:()=>undefined,computeTarget:()=>undefined,control:{serviceUrl:()=>"",personas:()=>[],route:()=>undefined,routes:()=>[],deliverTranscript:async()=>({}),appendRouteLog:()=>{}},api:{}};const service=createSpeechPluginRuntime(ports);services.set("manager.speech@1",service);service.markReady();return service;}

test("configuration handoff drains old work and gates new work through the original runtime owner", async t => {
 const service=configurationService(t),order=[];let release;const gate=new Promise(resolve=>release=resolve);
 service.resources.speechRuntimeControl.reconfigure=async()=>{order.push("reconfigure");};service.resources.speechRuntimeControl.serviceUrl=()=>"http://127.0.0.1:54321";service.resources.speechControl.reconcileMicrophone=async()=>{order.push("microphone");};
 const old=service.runAcceptedWork(async()=>{order.push("old");await gate;order.push("old-complete");});await new Promise(resolve=>setImmediate(resolve));service.reconcileConfiguration();
 const next=service.runAcceptedWork(async()=>{order.push("new");});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,["old"]);
 release();await Promise.all([old,next]);assert.deepEqual(order,["old","old-complete","reconfigure","microphone","new"]);await service.stopResources();
});

test("retired configuration handoff cannot start a late replacement or control an external microphone", async t => {
 const service=configurationService(t);let changes=0,microphones=0;service.resources.speechRuntimeControl.reconfigure=async()=>{changes++;};service.resources.speechRuntimeControl.serviceUrl=()=>"https://speech.example.test";service.resources.speechControl.reconcileMicrophone=async()=>{microphones++;};
 service.reconcileConfiguration();await service.resources.reconfiguration;assert.equal(changes,1);assert.equal(microphones,0);
 let release;const gate=new Promise(resolve=>release=resolve);const accepted=service.runAcceptedWork(()=>gate);await new Promise(resolve=>setImmediate(resolve));service.reconcileConfiguration();const stopping=service.stopResources();release();await Promise.all([accepted,stopping]);assert.equal(changes,1);
});

test("retirement inside a configuration handoff revokes launch authority and joins actual owner cleanup", async t => {
 const service=configurationService(t);let entered,release,late=0,released=0;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 service.resources.speechRuntimeControl.reconfigure=async guard=>{assert.equal(typeof guard,"function");entered();await gate;guard();late++;};
 service.resources.speechRuntimeControl.releaseOwnedRuntime=async()=>{released++;};
 service.reconcileConfiguration();await inside;const pending=service.resources.reconfiguration;const stopping=service.stopResources();release();
 await Promise.all([pending,stopping]);assert.equal(late,0);assert.equal(released,1);
});

test("cancelled configuration work cannot hide an unconfirmed original owner retirement", async t => {
 const service=configurationService(t);let entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 service.resources.speechRuntimeControl.reconfigure=async guard=>{entered();await gate;guard();};
 service.resources.speechRuntimeControl.releaseOwnedRuntime=async()=>{throw new Error("original retirement unconfirmed");};
 service.reconcileConfiguration();await inside;const stopping=service.stopResources();const failed=assert.rejects(stopping,/original retirement unconfirmed/);release();await failed;
});
