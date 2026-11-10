import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {once,EventEmitter} from "node:events";
import {WebSocket} from "ws";
import {normalizeComputerSettings} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import {ComputerService} from "../../apps/rabi-agent/lib/computer-service.mjs";
import {ManagerLocalComputer} from "./managerLocalComputer.js";
import {LanAgentRegistry} from "./lanAgentRegistry.js";
import {LanAgentAuthority} from "./lanAgentAuthority.js";
import {ManagerConfigRepository} from "./configRepository.js";
import {ManagerPluginRouteRegistry} from "./managerPluginRouteRegistry.js";
import {createLanAgentComputerOperations} from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js";
import {evaluateLanAgentRequest,assertTrustedLanAgentPrincipal} from "./lanAgentRequestAccess.js";
import {captureTrustedLanAgentSource,getTrustedLanAgentSource} from "./lanAgentBodyAuthority.js";
import {markAuthenticatedConnectionRequest} from "./connectionRequestAccess.js";
import {computerAgentSourceId} from "./computerTaskLifecycle.js";

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve};};
test("source Node replacement cleans only its original connection scope across local and another Node",{timeout:15000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"computer-source-scope-")),gate=deferred(),events=new EventEmitter(),errors:unknown[]=[],sources:WebSocket[]=[];
 let hold=false,targetSocket:WebSocket|undefined;const nativeCalls:Array<{target:string;action:string;body:any}>=[];
 const broker=(target:string)=>Object.assign(new EventEmitter(),{request:async(action:string,body:any={})=>{nativeCalls.push({target,action,body});if(hold&&action==="annotation.clear"&&String(body.layerId).startsWith("old-"))await gate.promise;return{state:action.endsWith("end")?"ended":"visible"};},close:async()=>{}});
 const config=new ManagerConfigRepository({rootDir:root,managerPort:1}),authority=new LanAgentAuthority({statePath:path.join(root,"authority.json")});
 const source=authority.enroll(authority.issueBootstrapTicket().ticket,"source-node"),target=authority.enroll(authority.issueBootstrapTicket().ticket,"target-node"),httpOnly=authority.enroll(authority.issueBootstrapTicket().ticket,"http-only-node");
 let remoteSettings=normalizeComputerSettings();
 const remote=new ComputerService({instanceId:target.nodeId,uploadHistoryRoot:path.join(root,"remote-uploads"),nativeFactory:()=>broker("remote")});
 const registry:LanAgentRegistry=new LanAgentRegistry({statePath:path.join(root,"registry.json"),authenticateNode:token=>authority.acquireConnectionLease(token),nodeEnabled:id=>authority.isNodeEnabled(id),computerSettings:id=>id===registry.localInstanceId?config.readComputerSettings():authority.getComputerSettings(id),
  patchComputerSettings:(id,patch,revision)=>id===registry.localInstanceId?config.patchComputerSettings(patch,revision):authority.patchComputerSettings(id,patch,revision),
  createLocalComputer:(id,emit)=>new ManagerLocalComputer({instanceId:id,stateDirectory:path.join(root,"local"),emit,getSettings:()=>config.readComputerSettings().settings,computerServiceOptions:{nativeFactory:()=>broker("local")}}),
  onComputerSourceCleanupError:(id,error)=>errors.push({id,error}),executionSource:request=>{const value=getTrustedLanAgentSource(request);assert.ok(value);return{sourceId:computerAgentSourceId(value.nodeId,value.provider,value.sessionId),taskId:value.sessionId,connectionId:registry.computerConnectionId(value.nodeId)};}});
 const api=new ManagerPluginRouteRegistry(),registration=api.registerOperations("computer",createLanAgentComputerOperations({registry,isManagementRequestAuthorized:()=>false}));
 const server=http.createServer((request,response)=>{const access=evaluateLanAgentRequest(request,authority,true);if(access.kind!=="agent"){response.writeHead(401).end();return;}markAuthenticatedConnectionRequest(request,()=>{assertTrustedLanAgentPrincipal(request)});captureTrustedLanAgentSource(request,"scope-fixture");if(!api.handle(request,new URL(request.url!,"http://localhost"),response))response.writeHead(404).end();});
 const detach=registry.attach(server,{getToken:()=>"fixture",enabled:()=>true});server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{gate.resolve();await registry.stopComputerSourceLifecycle();await registry.stopLocalComputer();detach();registry.close();targetSocket?.close();sources.forEach(socket=>socket.close());await registration.dispose();await new Promise<void>(done=>server.close(()=>done()));await remote.stop();fs.rmSync(root,{recursive:true,force:true});});
 const connect=async(credential:{nodeId:string;token:string},computer=false)=>{const socket=new WebSocket(base.replace("http:","ws:")+"/api/lan-agent/connect");await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.on("open",()=>socket.send(JSON.stringify({type:"authenticate",token:credential.token})));socket.on("message",raw=>{const message=JSON.parse(raw.toString());if(message.type==="authenticated")socket.send(JSON.stringify({type:"hello",node:{nodeId:credential.nodeId,version:"fixture",platform:"win32",agents:[],computerCapabilities:computer?["files","input","annotation"]:[]}}));if(message.type==="connected")resolve();if(message.type==="manageAgent")void(async()=>{let result:unknown;if(message.operation==="computer"){const{_computerContext,...body}=message.params;remoteSettings=normalizeComputerSettings(_computerContext.settings);result=await remote.execute(body,{..._computerContext,getSettings:()=>remoteSettings});}else if(message.operation==="computer.settings"){remoteSettings=normalizeComputerSettings(message.params.settings);await remote.reconcileSettings({getSettings:()=>remoteSettings});result={state:"applied"};}else if(message.operation==="computer.source.end"){const pending=remote.endSource(message.params.connectionId);events.emit("cleanup",message.params.connectionId);result=await pending;}else throw Error("Unexpected fixture management operation");if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,result}));})().catch(error=>{if(error.code!=="COMPUTER_FEATURE_DISABLED")errors.push(error);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,error:String(error),...(typeof error.code==="string"?{errorCode:error.code}:{}),...(typeof error.uncertain==="boolean"?{uncertain:error.uncertain}:{}),...(typeof error.field==="string"?{errorField:error.field}:{}),...(error.deliveryFrameSent===false?{deliveryFrameSent:false}:{}),...(["not_started","unknown"].includes(error.mutationOutcome)?{mutationOutcome:error.mutationOutcome}:{})}));});});});return socket;};
 targetSocket=await connect(target,true);sources.push(await connect(source));const firstScope=registry.computerConnectionId(source.nodeId);assert.ok(firstScope);assert.equal(registry.computerConnectionId(httpOnly.nodeId),undefined);
 const headers=(credential:typeof source)=>({authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-type":"codex","x-rabiroute-session-id":"same-source-session","content-type":"application/json"});
 const post=async(instanceId:string,credential:typeof source,body:any)=>{const response=await fetch(`${base}/api/lan-agent/instances/${instanceId}/computer`,{method:"POST",headers:headers(credential),body:JSON.stringify(body)});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value.data;};
 const show=(instanceId:string,layerId:string)=>({action:"annotation.show",requestId:layerId,layerId,durationMs:null,source:{instanceId,kind:"desktop",coordinateSpace:"desktop"},objects:[{id:"box",type:"rect",bounds:{x:1,y:1,width:10,height:10}}]});
 for(const instanceId of [registry.localInstanceId,target.nodeId])await post(instanceId,source,show(instanceId,instanceId===target.nodeId?"old-remote":"old-local"));
 await post(target.nodeId,httpOnly,show(target.nodeId,"http-only"));
 hold=true;const cleaning=once(events,"cleanup");sources.push(await connect(source));assert.equal((await cleaning)[0],firstScope);
 const nextScope=registry.computerConnectionId(source.nodeId);assert.ok(nextScope);assert.notEqual(nextScope,firstScope,"a new socket with the same credential gets a new ownership scope");
 for(const instanceId of [registry.localInstanceId,target.nodeId])await post(instanceId,source,show(instanceId,instanceId===target.nodeId?"new-remote":"new-local"));
 let joined=false;const stopping=registry.stopComputerSourceLifecycle().then(()=>{joined=true});await new Promise<void>(done=>setImmediate(done));assert.equal(joined,false,"source owner joins accepted cross-target cleanup");gate.resolve();await stopping;
 const remoteStatus=await post(target.nodeId,source,{action:"annotation.status"});const localStatus=await post(registry.localInstanceId,source,{action:"annotation.status"});
 const layers=(value:any)=>value.layers as Array<{layerId:string;state:string}>;
 assert.equal(layers(remoteStatus).some(row=>row.layerId==="old-remote"),false);assert.equal(layers(localStatus).some(row=>row.layerId==="old-local"),false);
 assert.equal(layers(remoteStatus).find(row=>row.layerId==="new-remote")!.state,"visible");assert.equal(layers(localStatus).find(row=>row.layerId==="new-local")!.state,"visible");assert.equal(layers(remoteStatus).find(row=>row.layerId==="http-only")!.state,"visible","HTTP without a source socket remains usable and is not cleared as another socket");
 assert.deepEqual(errors,[]);assert.ok(nativeCalls.filter(value=>value.action==="annotation.clear").every(value=>String(value.body.layerId).startsWith("old-")));
 const remoteVersion=authority.getComputerSettings(target.nodeId).revision;await registry.updateComputerSettings(target.nodeId,{features:{annotation:false}},remoteVersion);
 const accepted=await post(target.nodeId,source,show(target.nodeId,"new-remote"));assert.equal(accepted.layerId,"new-remote","remote final once returns the accepted original receipt after closure");
 const shown=nativeCalls.filter(value=>value.action==="annotation.show").length;
 const blocked=await fetch(`${base}/api/lan-agent/instances/${target.nodeId}/computer`,{method:"POST",headers:headers(source),body:JSON.stringify({...show(target.nodeId,"new-remote"),requestId:"new-remote-blocked"})});const blockedBody=await blocked.json() as any;
 assert.equal(blocked.status,403,JSON.stringify(blockedBody));assert.equal(blockedBody.errorCode,"COMPUTER_FEATURE_DISABLED");assert.equal(blockedBody.field,"features.annotation");assert.equal(nativeCalls.filter(value=>value.action==="annotation.show").length,shown);
 const rawAuthority=JSON.parse(fs.readFileSync(path.join(root,"authority.json"),"utf8"));rawAuthority.nodes.find((row:any)=>row.nodeId===target.nodeId).computerSettings={features:{input:"invalid-saved-field"}};fs.writeFileSync(path.join(root,"authority.json"),JSON.stringify(rawAuthority));const rawBytes=fs.readFileSync(path.join(root,"authority.json"));assert.throws(()=>authority.getComputerSettings(target.nodeId,true));
 const reads=()=>{throw Error("recovery must not read bad target settings or its enabled callback");};t.mock.method(authority,"isNodeEnabled",reads);
 for(const body of [{action:"control.status"},{action:"control.end",controlSessionId:"original-absent-control"},{action:"annotation.clear",layerId:"http-only"},{action:"upload.status",uploadId:"12345678-1234-4234-8234-123456789abc"}])await post(target.nodeId,source,body);
 assert.deepEqual(fs.readFileSync(path.join(root,"authority.json")),rawBytes);


});
