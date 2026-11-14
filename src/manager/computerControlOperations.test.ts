import type {ComputerSettingsDefinition} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import {normalizeComputerSettings as normalizeSettingsForAssertion} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { ManagerLocalComputer } from "./managerLocalComputer.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { ManagerConfigRepository } from "./configRepository.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentRoutes.js";
import { createApiDiscoveryOperations } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js";
import { createLanAgentComputerOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js";


async function fixture(t: import("node:test").TestContext, makeLocal?: (instanceId:string,emit:(event:Record<string,unknown>)=>void,config:ManagerConfigRepository,root:string)=>ManagerLocalComputer, resolveDefinition?:()=>ComputerSettingsDefinition) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"computer-api-"));
 const changedEvents=new EventEmitter();
 const config=new ManagerConfigRepository({rootDir:root,managerPort:1,resolveComputerDefinition:resolveDefinition});
 const authority=new LanAgentAuthority({statePath:path.join(root,"authority.json"),resolveComputerDefinition:resolveDefinition});
 const registry:LanAgentRegistry=new LanAgentRegistry({createLocalComputer:makeLocal ? (id,emit)=>makeLocal(id,emit,config,root) : undefined,statePath:path.join(root,"registry.json"),computerSettingsDefinition:()=>config.getComputerSettingsDefinition(),computerExecutionSettings:id=>id===registry.localInstanceId?config.readComputerExecutionSettings():authority.getComputerExecutionSettings(id),computerSettingsRaw:id=>id===registry.localInstanceId?config.readComputerSettingsRaw():authority.getComputerSettingsRaw(id),onComputerChanged:id=>changedEvents.emit("computer",id),authenticateNode:token=>authority.acquireConnectionLease(token),nodeEnabled:id=>authority.isNodeEnabled(id),computerSettings:(id,refresh)=>id===registry.localInstanceId?config.readComputerSettings(refresh):authority.getComputerSettings(id,refresh),patchComputerSettings:(id,patch,version,paths)=>id===registry.localInstanceId?config.patchComputerSettings(patch,version,paths):authority.patchComputerSettings(id,patch,version,paths)});
 const api=new ManagerPluginRouteRegistry(undefined,{identity:()=>({applicationGenerationId:"fixture-app",managerInstanceId:"fixture-manager",pluginGenerationId:"fixture-plugins"})});
 const context={registry,authority,enabled:()=>true,readJsonBody:async()=>{throw Error("registry owns decoding")},jsonResponse:()=>{},isReleaseRequestAuthorized:()=>false,isManagementRequestAuthorized:()=>false,releases:{} } as unknown as LanAgentRoutesContext;
 const registrations=[api.registerOperations("computer-settings",createLanAgentManagementOperations(context)),api.registerOperations("discovery",createApiDiscoveryOperations(api)),api.registerOperations("computer",createLanAgentComputerOperations(context))];
 const server=http.createServer((request,response)=>{markAuthenticatedConnectionRequest(request);if(!api.handle(request,new URL(request.url!,"http://localhost"),response))response.writeHead(404).end();});
 const detach=registry.attach(server,{getToken:()=>"fixture",enabled:()=>true});
 server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{for(const registration of registrations)await registration.dispose();await registry.stopLocalComputer();detach();registry.close();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});});
 const settingsPath=`/api/lan-agent/instances/${registry.localInstanceId}/computer-settings`;
 return {base,config,authority,registry,api,settingsPath,changedEvents,context,async replaceComputerDefinition(definition:ComputerSettingsDefinition){await registrations[2]!.dispose();registrations[2]=api.registerOperations("computer-B",createLanAgentComputerOperations({...context,computerSettingsDefinition:definition}));}};
}
test("settings HTTP shares original owner, strong ETag and healthy public discovery",async t=>{
 const f=await fixture(t), first=await fetch(f.base+f.settingsPath);assert.equal(first.status,200);const etag=first.headers.get("etag")!;assert.match(etag,/^"sha256:[a-f0-9]{64}"$/);
 const value=await first.json() as any;assert.equal(checkedSettings(value.data).features.input,true);assert.equal(value.data.defaults.annotation.dynamicEnabled,false);assert.ok(value.data.schema.properties.features);
 const changed=await fetch(f.base+f.settingsPath,{method:"PATCH",headers:{"content-type":"application/json","if-match":etag},body:JSON.stringify({features:{files:false}})});assert.equal(changed.status,200,await changed.clone().text());
 assert.equal(checkedSettings(f.config.readComputerSettings()).features.files,false);assert.equal(checkedSettings(f.config.readComputerSettings()).features.input,true);
 const conflict=await fetch(f.base+f.settingsPath,{method:"PATCH",headers:{"content-type":"application/json","if-match":etag},body:JSON.stringify({enabled:false})});assert.equal(conflict.status,409);assert.equal(checkedSettings(f.config.readComputerSettings()).enabled,true);
 const listing=await fetch(f.base+"/api/computers");assert.equal(listing.status,200);assert.equal((await listing.json() as any).data.computers[0].instanceId,f.registry.localInstanceId);
 const {createOperationSdk}=await import(new URL("../../apps/rabi-agent/lib/operation-sdk.mjs",import.meta.url).href);
 const sdk=createOperationSdk({request:async(method:string,url:string,options:any={})=>{const response=await fetch(f.base+url,{method,headers:options.headers,body:options.body});return {ok:response.ok,statusCode:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};}});
 const described=await sdk.describe("manager.lan-agent.computer-settings.read");assert.equal(described.operation.id,"manager.lan-agent.computer-settings.read");
});
test("new work uses feature settings but original receipt and cleanup actions remain available",async t=>{
 const f=await fixture(t);let calls=0;
 const stub={computerExecutionSource:()=>({sourceId:"fixture"}),getComputerSettings:()=>f.config.readComputerSettings(),getComputerSettingsRaw:()=>f.config.readComputerSettingsRaw(),computerCapabilities:()=>["input","annotation","tracking","files"],manageAgent:async()=>{calls++;return {state:"absent"};}};
 const operations=createLanAgentComputerOperations({registry:stub,isManagementRequestAuthorized:()=>true} as any);
 const request=new http.IncomingMessage(new (await import("node:net")).Socket());request.headers={};
 const invoke=async(action:string)=>operations[0]!.handler({request,response:new http.ServerResponse(request),url:new URL("http://fixture/computer"),path:{instanceId:f.registry.localInstanceId},query:{},body:{action,requestId:"original-request"}} as any);
 const version=f.config.readComputerSettings();f.config.patchComputerSettings({enabled:false},version.revision);
 assert.equal((await invoke("file.read")).status,403);assert.equal(calls,0);
 for(const action of ["input.status","input.cancel","control.end","annotation.clear","annotation.track.stop","upload.status"]){const result=await invoke(action);assert.equal(result.status,200,action);}
 assert.equal(calls,6);
});

test("disabled remote computer retains its original authenticated status/cleanup/settings path",async t=>{
 const f=await fixture(t), credential=f.authority.enroll(f.authority.issueBootstrapTicket().ticket,"fixture-node");
 const socket=new WebSocket(f.base.replace("http:","ws:")+"/api/lan-agent/connect"), calls:any[]=[];
 t.after(()=>socket.close());
 const connected=new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.on("open",()=>socket.send(JSON.stringify({type:"authenticate",token:credential.token})));socket.on("message",raw=>{const message=JSON.parse(raw.toString());if(message.type==="authenticated")socket.send(JSON.stringify({type:"hello",node:{nodeId:credential.nodeId,version:"fixture",platform:"win32",agents:[],computerCapabilities:["files","input","annotation","tracking"]}}));if(message.type==="connected")resolve();if(message.type==="manageAgent"){calls.push(message);socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,result:{state:message.operation==="computer.settings"?"applied":"absent"}}));}});});
 await connected; const changed=once(f.changedEvents,"computer");socket.send(JSON.stringify({type:"computerEvent",instanceId:"untrusted-body-target"}));assert.equal((await changed)[0],credential.nodeId,"invalidation target comes from original connection, never the frame body");
 const settingsUrl=`${f.base}/api/lan-agent/instances/${credential.nodeId}/computer-settings`;
 const settings=await fetch(settingsUrl), etag=settings.headers.get("etag")!;
 const disabled=await fetch(settingsUrl,{method:"PATCH",headers:{"content-type":"application/json","if-match":etag},body:JSON.stringify({enabled:false})});assert.equal(disabled.status,200);assert.equal((await disabled.json() as any).data.execution,"applied");
 assert.equal(checkedSettings(f.authority.getComputerSettings(credential.nodeId)).enabled,false);assert.ok(f.authority.acquireConnectionLease(credential.token));
 const url=`${f.base}/api/lan-agent/instances/${credential.nodeId}/computer`;
 const invoke=(body:unknown)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const before=calls.length;assert.equal((await invoke({action:"file.stat",path:"C:/synthetic/blocked-by-setting"})).status,403);assert.equal(calls.length,before);
 for(const action of ["control.status","input.status","input.cancel","control.end","annotation.clear","annotation.track.stop"]){const response=await invoke({action,requestId:"original-request",controlSessionId:"original-session",trackingId:"original-tracking"});assert.equal(response.status,200,await response.clone().text());}
 const selected=calls.filter(value=>value.operation==="computer");assert.equal(selected.length,6);assert.ok(selected.every(value=>value.params._computerContext.settings===undefined),"metadata recovery does not parse or reset authoritative settings");
 const legacy=`${f.base}/api/lan-agent/instances/${credential.nodeId}/enabled`;
 const toggle=async(enabled:boolean,expectedEnabled:boolean)=>fetch(legacy,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled,expectedEnabled})});
 const restored=await toggle(true,false);assert.equal(restored.status,200);assert.equal((await restored.json() as any).data.execution,"applied");
 const stopped=await toggle(false,true);assert.equal(stopped.status,200);assert.equal((await stopped.json() as any).data.execution,"applied");
 assert.deepEqual(calls.filter(value=>value.operation==="computer.settings").map(value=>value.params.settings.enabled),[false,true,false],"legacy total switch reuses the same target-side settings reconciliation");
 assert.ok(f.authority.acquireConnectionLease(credential.token));

});

test("native computer faults preserve uncertainty and conflict instead of becoming settings permissions",async t=>{
 const f=await fixture(t);t.mock.method(f.registry,"computerCapabilities",()=>["input","annotation"]);
 let failure:Error;t.mock.method(f.registry,"manageAgent",async()=>{throw failure;});
 const url=`${f.base}/api/lan-agent/instances/${f.registry.localInstanceId}/computer`;
 const cases=[
  {error:Object.assign(Error("Original input result is unknown"),{code:"COMPUTER_RESULT_UNCERTAIN",uncertain:true}),status:503,uncertain:true},
  {error:Object.assign(Error("Original request content conflicts"),{code:"COMPUTER_REQUEST_CONFLICT"}),status:409,uncertain:undefined},
  {error:Object.assign(Error("Native target is unavailable before dispatch"),{code:"COMPUTER_NATIVE_START_FAILED",uncertain:false,deliveryFrameSent:false}),status:503,uncertain:false}
 ];
 for(const value of cases){failure=value.error;const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"input.execute",requestId:"original-request",controlSessionId:"original-control",actions:[{type:"text",text:"not executed"}]})});const body=await response.json() as any;
 assert.equal(response.status,value.status);assert.equal(body.errorCode,value.error.code);assert.equal(body.uncertain,value.uncertain);assert.notEqual(response.status,403);assert.doesNotMatch(body.repair,/update this target's visible settings/);
 if(value.uncertain)assert.match(body.repair,/original.*Do not repeat/);if(value.error.code==="COMPUTER_NATIVE_START_FAILED")assert.equal(body.mutationOutcome,"not_started");}
 failure=Object.assign(Error("Status lookup unavailable"),{code:"COMPUTER_RESULT_UNCERTAIN",uncertain:true});
 const read=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"input.status",requestId:"original-request"})});const readError=await read.json() as any;
 assert.equal(read.status,503);assert.equal(readError.errorCode,"COMPUTER_RESULT_UNCERTAIN");assert.equal(readError.mutationOutcome,undefined);assert.notEqual(readError.uncertain,true);
});

test("target agentTasks setting guards prepared work and raw threads while original Node metadata/reconcile stay reachable",async t=>{
 const f=await fixture(t),credential=f.authority.enroll(f.authority.issueBootstrapTicket().ticket,"agent-work-node"),calls:any[]=[];
 const socket=new WebSocket(f.base.replace("http:","ws:")+"/api/lan-agent/connect");t.after(()=>socket.close());
 await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.on("open",()=>socket.send(JSON.stringify({type:"authenticate",token:credential.token})));socket.on("message",raw=>{const message=JSON.parse(raw.toString());if(message.type==="authenticated")socket.send(JSON.stringify({type:"hello",node:{nodeId:credential.nodeId,version:"fixture",platform:"fixture",agents:[],agentTypes:["codex"]}}));if(message.type==="connected")resolve();if(message.type==="manageAgent"){calls.push(message);socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,result:{operation:message.operation,params:message.params,state:"observed"}}));}});});
 const current=f.authority.getComputerSettings(credential.nodeId);await f.registry.updateComputerSettings(credential.nodeId,{features:{agentTasks:false}},current.revision);
 const {createOperationSdk}=await import(new URL("../../apps/rabi-agent/lib/operation-sdk.mjs",import.meta.url).href);
 const sdk=createOperationSdk({request:async(method:string,url:string,options:any={})=>{const response=await fetch(f.base+url,{method,headers:options.headers,body:options.body});return {ok:response.ok,statusCode:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};}});
 const invoke=(body:any)=>sdk.call("manager.lan-agent.agents.threads",{pathParams:{instanceId:credential.nodeId,agentId:"fixture-agent"},body:{agentAdapter:"codex",...body}});
 const before=calls.length;for(const body of [{action:"ds_bot_deliver"},{action:"create"},{action:"create_metadata"},{action:"send"},{action:"resolve"},{action:"resolve",createIfMissing:true}]){const response=await invoke(body);assert.equal(response.statusCode,403);assert.equal(response.data.errorCode,"COMPUTER_FEATURE_DISABLED");}assert.equal(calls.length,before);
 assert.throws(()=>f.registry.manageAgent(credential.nodeId,"prepared_delivery",{delivery:{deliveryId:"original",generation:"one"}}),{code:"COMPUTER_FEATURE_DISABLED"});assert.equal(calls.length,before);
 const revision=f.authority.getComputerSettings(credential.nodeId).revision;await f.registry.updateComputerSettings(credential.nodeId,{enabled:false},revision);
 for(const body of [{action:"ds_bot_catalog"},{action:"ds_bot_reconcile",deliveryId:"original"},{action:"list"},{action:"read",threadId:"original-thread"},{action:"creation_status",creationIntent:{callerKey:"agent-"+"a".repeat(64)}},{action:"resolve",title:"Existing",createIfMissing:false}]){const response=await invoke(body);assert.equal(response.statusCode,200,JSON.stringify(response));}
 const recovered=await f.registry.manageAgent(credential.nodeId,"reconcile_prepared_delivery",{delivery:{deliveryId:"original",generation:"one"}}) as any;assert.equal(recovered.operation,"reconcile_prepared_delivery");assert.equal(recovered.params.delivery.deliveryId,"original");
 for(const operation of ["scan","configure","hooks"])assert.throws(()=>f.registry.manageAgent(credential.nodeId,operation,{}),{code:"LAN_AGENT_MANAGEMENT_NOT_SENT"});
 assert.equal(calls.some(value=>value.operation==="prepared_delivery"),false);assert.ok(f.authority.acquireConnectionLease(credential.token));
});
test("raw Core local threads share the target new-work guard without blocking original metadata",async t=>{
 const f=await fixture(t),calls:any[]=[];f.context.manageLocalAgent=async(agentId,operation,body,guard)=>{guard?.();calls.push({agentId,operation,body});return {state:"original-owner",action:body.action};};
 const current=f.config.readComputerSettings();f.config.patchComputerSettings({features:{agentTasks:false}},current.revision);
 const url=`${f.base}/api/lan-agent/instances/${f.registry.localInstanceId}/agents/fixture-agent/threads`;
 const invoke=async(body:any)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentAdapter:"codex",...body})});
 for(const body of [{action:"ds_bot_deliver"},{action:"create"},{action:"create_metadata"},{action:"send"},{action:"resolve"}])assert.equal((await invoke(body)).status,403);assert.equal(calls.length,0);
 f.config.patchComputerSettings({enabled:false},f.config.readComputerSettings().revision);
 for(const body of [{action:"list"},{action:"read",threadId:"accepted-thread"},{action:"creation_status"},{action:"resolve",createIfMissing:false,title:"Existing"}])assert.equal((await invoke(body)).status,200);
 assert.deepEqual(calls.map(value=>value.body.action),["list","read","creation_status","resolve"]);
});
test("Core and local real computer owner return accepted same-ID receipts after settings close, while new IDs inject nothing",async t=>{
 const requests:{action:string;body:any}[]=[];
 const native=Object.assign(new EventEmitter(),{request:async(action:string,body:any={})=>{requests.push({action,body});if(action==="input.execute")return {state:"injected",injectedEvents:1};if(action==="annotation.track.start")return {state:"tracking",trackingId:body.trackingId,targets:body.targets,effective:{rateHz:10}};return {state:action.endsWith("end")?"ended":"visible"};},close:async()=>{}});
 const f=await fixture(t,(id,emit,config,root)=>new ManagerLocalComputer({stateDirectory:path.join(root,"local"),instanceId:id,emit,getSettings:()=>checkedSettings(config.readComputerSettings()),computerServiceOptions:{nativeFactory:()=>native}}));
 t.mock.method(f.registry,"computerCapabilities",()=>["input","annotation","tracking"]);
 f.config.patchComputerSettings({annotation:{dynamicEnabled:true}},f.config.readComputerSettings().revision);
 const url=`${f.base}/api/lan-agent/instances/${f.registry.localInstanceId}/computer`;
 const invoke=async(body:any)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
 const begin={action:"control.begin",requestId:"accepted-control"},opened=await invoke(begin);assert.equal(opened.status,200,JSON.stringify(opened.body));
 const source={instanceId:f.registry.localInstanceId,kind:"desktop",coordinateSpace:"desktop",frameId:"source-frame",width:100,height:100,bounds:{x:0,y:0,width:100,height:100}};
 const input={action:"input.execute",requestId:"accepted-input",controlSessionId:opened.body.data.controlSessionId,actions:[{type:"text",text:"synthetic"}]};
 const show={action:"annotation.show",requestId:"accepted-layer",layerId:"layer",source,objects:[{id:"box",type:"rect",bounds:{x:1,y:1,width:10,height:10}}]};
 const track={action:"annotation.track.start",requestId:"accepted-tracking",layerId:"tracking",source,taskId:"synthetic-task",targets:[{id:"target",bounds:{x:1,y:1,width:10,height:10}}]};
 const accepted=[];for(const body of [input,show,track]){const response=await invoke(body);assert.equal(response.status,200,JSON.stringify(response.body));accepted.push(response.body.data);}
 await f.registry.updateComputerSettings(f.registry.localInstanceId,{enabled:false},f.config.readComputerSettings().revision);
 const count=requests.filter(value=>["control.begin","input.execute","annotation.show","annotation.track.start"].includes(value.action)).length;
 const oldControl=await invoke(begin);assert.equal(oldControl.status,200);assert.equal(oldControl.body.data.controlSessionId,opened.body.data.controlSessionId);
 for(const [index,body] of [input,show,track].entries()){const response=await invoke(body);assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body.data,accepted[index]);}
 for(const body of [begin,input,show,track]){const response=await invoke({...body,requestId:body.requestId+"-new"});assert.equal(response.status,403,JSON.stringify(response.body));}
 assert.equal(requests.filter(value=>["control.begin","input.execute","annotation.show","annotation.track.start"].includes(value.action)).length,count);
});

test("malformed Manager settings leave accepted status/end/clear/upload metadata usable without changing raw bytes",async t=>{
 const native=Object.assign(new EventEmitter(),{request:async(action:string)=>({state:action.endsWith("end")?"ended":"visible"}),close:async()=>{}});
 const f=await fixture(t,(id,emit,config,root)=>new ManagerLocalComputer({stateDirectory:path.join(root,"local"),instanceId:id,emit,getSettings:()=>checkedSettings(config.readComputerSettings()),computerServiceOptions:{nativeFactory:()=>native}}));
 t.mock.method(f.registry,"computerCapabilities",()=>["files","input","annotation"]);
 const post=async(body:any)=>{const response=await fetch(`${f.base}/api/lan-agent/instances/${f.registry.localInstanceId}/computer`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return{response,body:await response.json() as any};};
 const started=await post({action:"control.begin",requestId:"before-invalid-settings"});assert.equal(started.response.status,200);const controlSessionId=started.body.data.controlSessionId;
 await post({action:"annotation.show",requestId:"before-invalid-layer",layerId:"before-invalid-layer",source:{instanceId:f.registry.localInstanceId,kind:"desktop",coordinateSpace:"desktop"},objects:[]});
 const raw=Buffer.from('{"computerSettings":');fs.mkdirSync(path.dirname(f.config.managerConfigPath),{recursive:true});fs.writeFileSync(f.config.managerConfigPath,raw);assert.throws(()=>f.config.readComputerSettings(true));
 for(const body of [{action:"control.status",controlSessionId},{action:"control.end",controlSessionId},{action:"annotation.clear",layerId:"before-invalid-layer"},{action:"upload.status",uploadId:"12345678-1234-4234-8234-123456789abc"}]){const value=await post(body);assert.equal(value.response.status,200,JSON.stringify(value.body));}
 const bad=await post({action:"file.stat",path:"C:/not-read"});assert.notEqual(bad.response.status,200);const get=await fetch(f.base+f.settingsPath);assert.notEqual(get.status,200);assert.deepEqual(fs.readFileSync(f.config.managerConfigPath),raw);
});

test("disabled local and connector DSBot delivers recover same-ID facts without dispatching new work", async t => {
 const f=await fixture(t), credential=f.authority.enroll(f.authority.issueBootstrapTicket().ticket,"ds-bot-node"), calls:string[]=[];
 let state="accepted";
 const receipt=(body:any)=>({statusCode:200,data:{dsBot:{schemaVersion:1,state,botScopeId:body.dsBot.botScopeId,botId:body.dsBot.botId,deliveryId:body.deliveryId,sessionId:"original-part",requestId:body.deliveryId}}});
 f.context.manageLocalAgent=async(_agentId,operation,body,guard)=>{guard?.();assert.equal(operation,"threads");calls.push(String(body.action));assert.equal(body.prompt,"original message");return receipt(body);};
 const socket=new WebSocket(f.base.replace("http:","ws:")+"/api/lan-agent/connect");t.after(()=>socket.close());
 await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.on("open",()=>socket.send(JSON.stringify({type:"authenticate",token:credential.token})));socket.on("message",raw=>{const message=JSON.parse(raw.toString());if(message.type==="authenticated")socket.send(JSON.stringify({type:"hello",node:{nodeId:credential.nodeId,version:"fixture",platform:"fixture",agents:[],agentTypes:["dsh"]}}));if(message.type==="connected")resolve();if(message.type==="manageAgent"){if(message.operation==="threads"){calls.push(message.params.action);assert.equal(message.params.prompt,"original message");}socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,result:message.operation==="threads"?receipt(message.params):{state:"observed"}}));}});});
 const local=f.config.readComputerSettings();f.config.patchComputerSettings({features:{agentTasks:false}},local.revision);
 const remote=f.authority.getComputerSettings(credential.nodeId);await f.registry.updateComputerSettings(credential.nodeId,{features:{agentTasks:false}},remote.revision);
 for(const instanceId of [f.registry.localInstanceId,credential.nodeId]){
  const url=`${f.base}/api/lan-agent/instances/${instanceId}/agents/dsh/threads`;
  for(const originalState of ["accepted","uncertain","conflict","not_found"]){
   state=originalState;
   const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"ds_bot_deliver",agentAdapter:"dsh",dsBot:{botScopeId:"scope",botId:"bot"},deliveryId:"original-id",prompt:"original message"})});
   const body=await response.json() as any;
   assert.equal(response.status,originalState==="not_found"?403:200,JSON.stringify(body));
   if(originalState!=="not_found") assert.equal(body.result.data.dsBot.state,originalState);
   else assert.equal(body.errorCode,"COMPUTER_FEATURE_DISABLED");
  }
 }
 assert.equal(calls.length,8);assert.ok(calls.every(action=>action==="ds_bot_reconcile"));
});


test("an unavailable capability catalog does not preempt the actual owner or original receipts",async t=>{
 const nativeCalls:string[]=[];
 const f=await fixture(t,(instanceId,emit,config,root)=>new ManagerLocalComputer({instanceId,emit,stateDirectory:path.join(root,"local-computer"),getSettings:()=>config.readComputerSettingsRaw(),computerServiceOptions:{nativeFactory:()=>Object.assign(new EventEmitter(),{async request(action:string){nativeCalls.push(action);return action==="capabilities"?{protocolVersion:2}:action==="control.begin"?{visible:true,hotkey:{registered:false}}:{state:"completed",releaseState:"released"};},async close(){}})}}));
 t.mock.method(f.registry,"computerCapabilities",()=>[]);
 const url=f.base+`/api/lan-agent/instances/${f.registry.localInstanceId}/computer`;
 const post=async(body:Record<string,unknown>)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as {data?:Record<string,unknown>;errorCode?:string}};};
 const request={action:"control.begin",requestId:"accepted-with-unavailable-discovery"};
 const first=await post(request);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data?.state,"active");
 const snapshot=f.config.readComputerSettings();f.config.patchComputerSettings({features:{input:false}},snapshot.revision);
 const replay=await post(request);assert.equal(replay.status,200,JSON.stringify(replay.body));
 assert.equal(replay.body.data?.controlSessionId,first.body.data?.controlSessionId);
 const disabled=await post({...request,requestId:"new-disabled-control"});assert.equal(disabled.status,403);assert.equal(disabled.body.errorCode,"COMPUTER_FEATURE_DISABLED");
 assert.equal(nativeCalls.filter(action=>action==="control.begin").length,1);
});

function checkedSettings(read:{settings:unknown;diagnostics?:readonly unknown[]}) {assert.equal(read.diagnostics?.length??0,0);return normalizeSettingsForAssertion(read.settings);}

test("candidate B input contract reaches the actual target with a new backend while Host bootstrap stays A", async t => {
 const {createComputerSettingsDefinition,BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION}=await import("../../apps/rabi-agent/lib/computer-control-contract.mjs");
 const data=JSON.parse(fs.readFileSync(new URL("../plugins/io.rabiroute.manager.core/assets/computer-settings.json",import.meta.url),"utf8"));
 const a=createComputerSettingsDefinition(data,"api-definition-A");
 const beta=structuredClone(data);beta.schema.properties.annotation.properties.backend.enum.push("fixture-backend");beta.schema.properties.annotation.properties.backend.default="fixture-backend";
 const b=createComputerSettingsDefinition(beta,"api-definition-B");
 let selected=a;
 class Native extends EventEmitter {
  calls:Array<{action:string;body:Record<string,unknown>}>=[];
  async request(action:string,body:Record<string,unknown>){this.calls.push({action,body});return action==="annotation.track.start"?{state:"tracking",trackingId:body.trackingId,targets:body.targets}:{state:"completed",visible:true,releaseState:"released"};}
  async close(){}
 }
 const native=new Native();
 const f=await fixture(t,(id,emit,config,root)=>new ManagerLocalComputer({instanceId:id,stateDirectory:path.join(root,"computer"),emit,getSettings:()=>config.readComputerSettingsRaw(),getDefinition:()=>selected,computerServiceOptions:{nativeFactory:()=>native}}),()=>selected);
 const first=await fetch(f.base+f.settingsPath);const etag=first.headers.get("etag")!;
 const enabled=await fetch(f.base+f.settingsPath,{method:"PATCH",headers:{"content-type":"application/json","if-match":etag},body:JSON.stringify({annotation:{dynamicEnabled:true}})});assert.equal(enabled.status,200,await enabled.clone().text());
 const endpoint=f.base+"/api/lan-agent/instances/"+f.registry.localInstanceId+"/computer";
 const request={action:"annotation.track.start",requestId:"api-definition-request",layerId:"api-definition-layer",taskId:"api-definition-fixture-task",backend:"fixture-backend",source:{frameId:"fixture-frame",instanceId:f.registry.localInstanceId,kind:"desktop",coordinateSpace:"capture",width:100,height:100,bounds:{x:0,y:0,width:100,height:100}},targets:[{id:"moving",bounds:{x:1,y:1,width:20,height:20}}]};
 const rejected=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});assert.equal(rejected.status,400);assert.equal(native.calls.filter(row=>row.action==="annotation.track.start").length,0);
 selected=b;await f.replaceComputerDefinition(b);
 const describe=await fetch(f.base+"/api/agent/operations/"+encodeURIComponent("manager.lan-agent.computer.execute")+"?view=input");assert.equal(describe.status,200);assert.match(JSON.stringify(await describe.json()),/fixture-backend/);
 const reply=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
 assert.equal(reply.status,200,await reply.clone().text());
 assert.equal(native.calls.find(row=>row.action==="annotation.track.start")?.body.backend,"fixture-backend");
 assert.equal((BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.defaults.annotation.backend),"kcf");
 assert.equal(BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.data.schema===b.data.schema,false);
 const again=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});assert.equal(again.status,200);
 assert.equal(native.calls.filter(row=>row.action==="annotation.track.start").length,1);
});
