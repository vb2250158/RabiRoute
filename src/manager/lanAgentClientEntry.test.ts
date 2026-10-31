import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { createLanAgentReadOperations } from "./lanAgentReadOperations.js";
import { createLanAgentTerminalOperations } from "./lanAgentTerminalRoutes.js";
import { createLanAgentComputerOperations } from "./lanAgentComputerRoutes.js";
import { createLanAgentConnectionOperation } from "./lanAgentConnectionOperation.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

test("first enrollment and real CLI worker provide computer I/O with no Agent binding", {skip:process.platform!=="win32",timeout:90000}, async t => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"rabi-client-entry-")));
  const authority=new LanAgentAuthority({statePath:path.join(root,"authority.json")});
  const registry=new LanAgentRegistry({statePath:path.join(root,"registry.json"),authenticateNode:token=>authority.authenticate(token),});
  const generation=randomUUID(),instance=randomUUID(),guid=randomUUID(),pluginGenerationId=randomUUID();let base="";
  const identity=()=>({guid,rabiGuid:guid,applicationGenerationId:generation,managerInstanceId:instance,pluginGenerationId,managerBaseUrl:base,health:{live:true,requiredReady:true,state:"healthy"}});
  const json=(response:http.ServerResponse,status:number,body:unknown)=>{response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify(body));};
  const api=new ManagerPluginRouteRegistry(undefined,{identity});
  const context:LanAgentRoutesContext={registry,authority,enabled:()=>true,managerIdentity:identity,releases:{} as never,
    isManagementRequestAuthorized:input=>input.headers["x-fixture-controller"]==="verified",isReleaseRequestAuthorized:()=>false,
    readJsonBody:async input=>{let body="";for await(const part of input)body+=part;return JSON.parse(body||"{}");},jsonResponse:json};
  const operations=api.registerOperations("fixture.client-entry",[...createLanAgentReadOperations(context),...createLanAgentManagementOperations(context),
    ...createLanAgentTerminalOperations(context),...createLanAgentComputerOperations(context)]);
  const upgrades=api.registerUpgrades("fixture.client-entry",[createLanAgentConnectionOperation(registry,{getToken:()=>"",enabled:()=>true})]);
  const discovery=api.registerOperations("fixture.discovery",createApiDiscoveryOperations(api));
  const httpDiagnostic:string[]=[];
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url!,"http://fixture.invalid");
    response.once("finish",()=>{httpDiagnostic.push(`${request.method} ${url.pathname} ${response.statusCode}`);});
    if(url.pathname==="/meta"||url.pathname==="/.well-known/rabiroute-manager"){json(response,200,{code:0,data:{...identity(),protocolVersion:"1"}});return;}
    const access=evaluateLanAgentRequest(request,authority,true);
    if(access.kind==="denied"){json(response,access.status,{code:-1,error:access.error});return;}
    registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(url.pathname,body,assertTrustedLanAgentPrincipal(request)?.source));
    if(!api.handle(request,url,response))json(response,404,{code:-1});
  });
  server.on("upgrade",(request,socket,head)=>{if(!api.handleUpgrade(request,new URL(request.url!,"http://fixture.invalid"),socket,head))socket.destroy();});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");base=`http://127.0.0.1:${address.port}`;
  let stopWorker: () => Promise<void> = async () => {};
  t.after(async()=>{await stopWorker();upgrades.stopAccepting();registry.close();server.closeAllConnections();await operations.dispose();await discovery.dispose();await upgrades.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const module=await import(pathToFileURL(path.resolve("apps/rabi-agent/rabi-agent.mjs")).href);
  const configPath=path.join(root,"client/config.json");const ticket=authority.issueBootstrapTicket().ticket;
  const variables:Record<string,string|undefined>={RABI_MANAGER_URL:base,RABI_AGENT_BOOTSTRAP_TICKET:ticket,RABI_AGENT_DEFAULT_CWD:root,
    RABI_AGENT_ALLOWED_CWDS:JSON.stringify([root]),RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256:"a".repeat(64),RABI_NODE_ID:"client-entry-node",RABI_AGENT_TYPE:undefined,RABI_AGENT_CODEX_THREAD_ID:undefined};
  const previous=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));
  try{for(const[key,value]of Object.entries(variables)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await module.__test.bootstrapConfig(configPath);
  }finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  const config=JSON.parse(fs.readFileSync(configPath,"utf8"));assert.deepEqual(config.agents,[]);assert.equal(config.codexDesktop,undefined);
  const help=await(await fetch(`${base}/api/agent/help`,{headers:{"x-fixture-controller":"verified"}})).json();
  assert.equal(help.code,0);assert.equal(help.data.applicationGenerationId,generation);assert.equal(help.data.managerInstanceId,instance);
  assert.equal(help.data.operations.find((entry:{id:string})=>entry.id==="manager.lan-agent.connect")?.contract.transport,"websocket");
  const connectingAt=Date.now();
  const child=spawn(process.execPath,[path.resolve("apps/rabi-agent/rabi-agent.mjs"),"--run","--config",configPath],{windowsHide:true,
    env:{...process.env,RABI_AGENT_SUPERVISED:"1",APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata")},stdio:["ignore","pipe","pipe","ipc"]});
  child.stdout!.resume();let error="",workerEnded=false;child.stderr!.on("data",bytes=>{error=(error+bytes).slice(-2048).replaceAll(config.nodeCredential,"<redacted>");});
  const exited=new Promise<void>(resolve=>{child.once("exit",()=>{workerEnded=true;resolve();});child.once("error",cause=>{error=cause.message.replaceAll(config.nodeCredential,"<redacted>");workerEnded=true;resolve();});});
  stopWorker=async()=>{if(child.connected)child.disconnect();const deadline=setTimeout(()=>child.kill(),6000);try{await exited;
    // OS exit is the worker barrier; release this fixture's diagnostic pipes afterwards.
    child.stdout?.destroy();child.stderr?.destroy();
  }finally{clearTimeout(deadline);}};
  const limit=Date.now()+30000;
  while(!registry.getNode("client-entry-node")?.connected){assert.equal(workerEnded,false,JSON.stringify({error,exitCode:child.exitCode,signalCode:child.signalCode,httpDiagnostic}));if(Date.now()>limit)throw new Error(JSON.stringify({message:"Client CLI did not connect.",error,httpDiagnostic}));await new Promise(resolve=>setTimeout(resolve,30));}
  const connectorReadyMs=Date.now()-connectingAt;
  assert.deepEqual(registry.getNode("client-entry-node")!.agents,[]);
  const terminals=`${base}/api/lan-agent/instances/client-entry-node/terminals`,computer=`${base}/api/lan-agent/instances/client-entry-node/computer`;
  const post=async(url:string,body:unknown)=>{const result=await(await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-fixture-controller":"verified"},body:JSON.stringify(body)})).json();assert.equal(result.code,0,JSON.stringify(result));return result.data;};
  const terminalId=randomUUID();await post(terminals,{action:"open",terminalId,shell:"cmd"});
  await post(terminals,{action:"input",terminalId,sequence:1,data:"echo CLIENT_ENTRY_463\r"});
  let cursor=0,output="";
  const outputDeadline=Date.now()+15000;
  while(!output.includes("CLIENT_ENTRY_463")){
    const result=await(await fetch(`${terminals}/${terminalId}?after=${cursor}&waitMs=5000`,{headers:{"x-fixture-controller":"verified"}})).json();
    assert.equal(result.code,0);cursor=result.data.nextOutputSequence;output+=result.data.outputEvents.map((event:{data?:string})=>event.data||"").join("");
    if(Date.now()>outputDeadline)throw new Error("Client terminal output missing.");
  }
  const bytes=Buffer.alloc(65537,0x97),uploadId=randomUUID(),target=path.join(root,"transferred.bin"),sha256=createHash("sha256").update(bytes).digest("hex");
  await post(computer,{action:"upload.begin",uploadId,path:target,size:bytes.length,sha256});
  for(let offset=0;offset<bytes.length;offset+=65536){const chunk=bytes.subarray(offset,offset+65536);await post(computer,{action:"upload.write",uploadId,offset,data:chunk.toString("base64"),sha256:createHash("sha256").update(chunk).digest("hex")});}
  await post(computer,{action:"upload.commit",uploadId});assert.deepEqual(fs.readFileSync(target),bytes);
  const stat=await post(computer,{action:"file.stat",path:target});const chunk=await post(computer,{action:"file.read",path:target,version:stat.version,offset:0});assert.equal(Buffer.from(chunk.data,"base64").length,65536);
  const capture=await post(computer,{action:"screen.capture",maxWidth:320});assert.equal(capture.mimeType,"image/png");
  await post(terminals,{action:"close",terminalId});
  assert.equal(fs.existsSync(path.join(root,"roles")),false);assert.equal(fs.existsSync(path.join(root,"skills")),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath,"utf8")).agents,[]);
  t.diagnostic(JSON.stringify({base,applicationGenerationId:generation,managerInstanceId:instance,connectorReadyMs,agents:registry.getNode("client-entry-node")!.agents,
    terminalEchoVerified:output.includes("CLIENT_ENTRY_463"),uploadedBytes:bytes.length,readBytes:Buffer.from(chunk.data,"base64").length,captureMime:capture.mimeType}));
});
