import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {VacuumRemoteController,type VacuumRemoteSnapshot} from "./vacuumRemote.js";
import type {XiaomiHomeManagerApiClient,XiaomiHomeResource} from "./managerApi.js";
import type {HomeEntityAction} from "./entityActions.js";
function fixture(initial="idle"){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"vacuum-remote-")),prefix="xiaomi_cn_123_pv11cn",resourceId="home:ha:vacuum."+prefix;
 fs.writeFileSync(path.join(root,"vacuum-remote-bindings.json"),JSON.stringify({schemaVersion:1,bindings:[{resourceId,watchdogResourceId:"home:ha:timer.release"}]}));
 let state=initial,failRelease=false,failRepeat=false,pauseReadback=true,directionDelayMs=0;const actions:Array<{id:string;action:string;parameters:Record<string,unknown>;key:string;at:number}>=[];
 const resource=(id:string):XiaomiHomeResource=>({resourceId:id,entityId:id.slice(8),kind:id.slice(8).split(".")[0]!,displayName:"Test",available:true,stateVersion:"version:"+state,observedAt:new Date().toISOString(),state:id===resourceId?state:id.includes("sensor.")?"0":"idle",attributes:{},capabilities:[]});
 const port:Pick<XiaomiHomeManagerApiClient,"getResource"|"getResourceActions"|"executeAction"|"listDevices">={
  getResource:async id=>resource(id),
  getResourceActions:async id=>({...resource(id),actions:(id.includes("vacuum.")?["pause"]:id.includes("timer.")?["start","cancel"]:id.includes("notify.")?["send_message"]:["press"]).map(action=>({action,revision:"revision:"+action,name:action,description:"",capability:"home.entity.action@1",confirmation:"provider_acceptance",providerSelector:{},argumentsSchema:{}} satisfies HomeEntityAction))}),
  listDevices:async()=>({schemaVersion:1,observedAt:"now",devices:[{deviceId:"test",displayName:"test",model:"xiaomi.vacuum.pv11cn",manufacturer:"test",areaName:"test",resources:[resource(resourceId),...[["button","_enter_remote_a_2_28"],["button","_exit_remote_a_2_29"],["notify","_remote_control_a_2_26"],["sensor","_fault_p_2_3"]].map(([domain,suffix])=>resource("home:ha:"+domain+"."+prefix+suffix))]}],unassignedResources:[]}),
  executeAction:async(request,key)=>{
   const args=request.arguments!,parameters=args.parameters as Record<string,unknown>;actions.push({id:request.resourceId,action:String(args.action),parameters,key,at:performance.now()});
   if(args.action==="pause" && pauseReadback)state="paused";
   const release=Array.isArray(parameters.values) && [2,4,6].includes(Number(parameters.values[0]));
   if(Array.isArray(parameters.values) && [1,3,5].includes(Number(parameters.values[0])) && directionDelayMs)await delay(directionDelayMs);
   return {requestId:key,idempotencyKey:key,resourceId:request.resourceId,capability:request.capability,status:release&&failRelease || failRepeat&&key.endsWith("-down-1")?"failed":"accepted",requestedAt:"now",completedAt:"now",beforeStateVersion:request.expectedStateVersion,provider:"home_assistant"};
  }
 };
 const owner=new VacuumRemoteController(root,()=>port);
 const start=async(key="remote-test-start-01")=>{const c=await owner.capabilities(resourceId);const r=await owner.command("start",{resourceId,expectedStateVersion:c.expectedStateVersion,protocolRevision:c.protocolRevision},key);assert.equal(r.state,"completed");return (r as {result:VacuumRemoteSnapshot}).result;};
 const result=(r:Awaited<ReturnType<typeof owner.command>>)=>{assert.equal(r.state,"completed");return (r as {result:VacuumRemoteSnapshot}).result;};
 return {root,owner,actions,resourceId,start,result,setDirectionDelay:(ms:number)=>{directionDelayMs=ms;},setFailRepeat:()=>{failRepeat=true;},setFailRelease:()=>{failRelease=true;},setPauseUnconfirmed:()=>{pauseReadback=false;},close:async()=>{await owner.shutdown();fs.rmSync(root,{recursive:true,force:true});}};
}
test("shared owner pauses and reads back cleaning before enter; pulse is bounded and replay cannot move twice",async()=>{
 const f=fixture("cleaning");try{
  let s=await f.start();assert.equal(s.state,"ready");assert.equal(f.actions[0]!.action,"pause");assert.ok(f.actions.findIndex(a=>a.id.includes("enter_remote"))>0);
  const body={sessionId:s.sessionId,expectedStateVersion:s.stateVersion,direction:"left",durationMs:100};
  s=f.result(await f.owner.command("pulse",body,"remote-test-pulse-01"));assert.equal(s.state,"ready");
  assert.deepEqual(f.actions.filter(a=>a.action==="send_message").map(a=>a.parameters.values),[[3],[4]]);
  const count=f.actions.length;await f.owner.command("pulse",body,"remote-test-pulse-01");assert.equal(f.actions.length,count);
  s=f.result(await f.owner.command("stop",{sessionId:s.sessionId},"remote-test-stop-01"));assert.equal(s.state,"ready");assert.ok(!f.actions.some(a=>a.id.includes("exit_remote")));
  const newPulse=f.owner.command("pulse",{sessionId:s.sessionId,expectedStateVersion:s.stateVersion,direction:"forward",durationMs:500},"remote-test-pulse-02");
  await delay(30);await f.owner.command("stop",{sessionId:s.sessionId},"remote-test-stop-01"); // replay must not abort the new pulse
  assert.equal(f.owner.status(s.sessionId).state,"moving");
  await f.owner.command("stop",{sessionId:s.sessionId},"remote-test-stop-02");await newPulse;
  s=f.result(await f.owner.command("exit",{sessionId:s.sessionId},"remote-test-exit-01"));assert.equal(s.state,"stopped");assert.ok(f.actions.some(a=>a.id.includes("exit_remote")));
 }finally{await f.close();}
});
test("shutdown during initialization cannot resurrect a ready session; historical status never resumes motion",async()=>{
 const f=fixture();try{
  const starting=f.start();while(!f.actions.some(a=>a.id.includes("enter_remote")))await delay(10);
  await f.owner.shutdown();const s=await starting;assert.equal(s.state,"failed");assert.equal(f.owner.status(s.sessionId).state,"stopped");
  const replacement=new VacuumRemoteController(f.root,()=>{throw Error("historical read must not contact device");});assert.equal(replacement.status(s.sessionId).state,"stopped");
 }finally{await f.close();}
});

test("held pulse repeats sequentially at the verified interval; replay and stop cannot add movement",async()=>{
 const f=fixture();try{
  let s=await f.start();const caps=await f.owner.capabilities(f.resourceId);assert.equal(caps.repeatIntervalMs,200);
  const body={sessionId:s.sessionId,expectedStateVersion:s.stateVersion,direction:"left",durationMs:500},key="remote-repeat-test-pulse-01";
  s=f.result(await f.owner.command("pulse",body,key));assert.equal(s.state,"ready");
  const sent=f.actions.filter(a=>a.key.startsWith(key) && a.action==="send_message");
  assert.deepEqual(sent.map(a=>a.parameters.values),[[3],[3],[3],[4]]);
  assert.deepEqual(sent.map(a=>a.key),[key+"-down",key+"-down-1",key+"-down-2",key+"-up"]);
  assert.ok(sent[1]!.at-sent[0]!.at>=175 && sent[2]!.at-sent[0]!.at>=375);
  const count=f.actions.length;await f.owner.command("pulse",body,key);assert.equal(f.actions.length,count);
  const nextKey="remote-repeat-test-pulse-02",moving=f.owner.command("pulse",{...body,expectedStateVersion:s.stateVersion},nextKey);
  while(!f.actions.some(a=>a.key===nextKey+"-down-1"))await delay(10);
  await f.owner.command("stop",{sessionId:s.sessionId},"remote-repeat-test-stop-01");await moving;
  assert.ok(!f.actions.some(a=>a.key===nextKey+"-down-2"));assert.ok(f.actions.some(a=>a.key===nextKey+"-up"));
  f.setFailRepeat();const failedKey="remote-repeat-test-failure-01";
  const failed=f.result(await f.owner.command("pulse",{...body,expectedStateVersion:f.owner.status(s.sessionId).stateVersion},failedKey));
  assert.equal(failed.state,"failed");assert.ok(!f.actions.some(a=>a.key===failedKey+"-down-2"));assert.ok(f.actions.some(a=>a.key===failedKey+"-up"));
 }finally{await f.close();}
});

test("a slow HA direction reply cannot extend the pulse or replay expired repeat slots",async()=>{
 const f=fixture();try{
  const s=await f.start();f.setDirectionDelay(600);const key="remote-slow-test-pulse-01";
  const r=f.result(await f.owner.command("pulse",{sessionId:s.sessionId,expectedStateVersion:s.stateVersion,direction:"right",durationMs:500},key));assert.equal(r.state,"ready");
  const sent=f.actions.filter(a=>a.key.startsWith(key) && a.action==="send_message");
  assert.deepEqual(sent.map(a=>a.parameters.values),[[5],[6]]);
  assert.ok(sent[1]!.at-sent[0]!.at<950,"release must follow the slow reply without another full pulse wait");
 }finally{await f.close();}
});
test("unconfirmed pause forbids entry; failed release retains the independent HA watchdog",async()=>{
 const paused=fixture("cleaning");try{paused.setPauseUnconfirmed();const s=await paused.start();assert.equal(s.state,"failed");assert.ok(!paused.actions.some(a=>a.id.includes("enter_remote")));}finally{await paused.close();}
 const f=fixture();try{const s=await f.start();f.setFailRelease();const r=f.result(await f.owner.command("pulse",{sessionId:s.sessionId,expectedStateVersion:s.stateVersion,direction:"right",durationMs:100},"remote-test-failure-01"));assert.equal(r.state,"failed");assert.ok(!f.actions.some(a=>a.key==="remote-test-failure-01-watchdog-cancel"));}finally{await f.close();}
});
