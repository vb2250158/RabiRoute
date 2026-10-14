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
import { handleLanAgentApi } from "./lanAgentRoutes.js";

test("first enrollment and real CLI worker provide computer I/O with no Agent binding", {skip:process.platform!=="win32",timeout:90000}, async t => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"rabi-client-entry-")));
  const authority=new LanAgentAuthority({statePath:path.join(root,"authority.json")});
  const registry=new LanAgentRegistry({statePath:path.join(root,"registry.json"),authenticateNode:token=>authority.authenticate(token),
    registerAgentCatalog:(token,agents)=>authority.registerAgentCatalog(token,agents),isAgentEnabled:(node,agent)=>authority.isAgentEnabled(node,agent)});
  const generation=randomUUID(),instance=randomUUID(),guid=randomUUID();let base="";
  const identity=()=>({guid,rabiGuid:guid,applicationGenerationId:generation,managerInstanceId:instance,managerBaseUrl:base,health:{live:true,requiredReady:true,state:"healthy"}});
  const json=(response:http.ServerResponse,status:number,body:unknown)=>{response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify(body));};
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url!,"http://fixture.invalid");
    if(url.pathname==="/meta"||url.pathname==="/.well-known/rabiroute-manager"){json(response,200,{code:0,data:{...identity(),protocolVersion:"1"}});return;}
    if(!handleLanAgentApi(request,url,response,{registry,authority,enabled:()=>true,managerIdentity:identity,releases:{} as never,
      isManagementRequestAuthorized:input=>input.headers["x-fixture-controller"]==="verified",isReleaseRequestAuthorized:()=>false,
      readJsonBody:async input=>{let body="";for await(const part of input)body+=part;return JSON.parse(body||"{}");},jsonResponse:json})){json(response,404,{code:-1});}
  });
  const detach=registry.attach(server,{getToken:()=>"",enabled:()=>true});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");base=`http://127.0.0.1:${address.port}`;
  const module=await import(pathToFileURL(path.resolve("apps/rabi-agent/rabi-agent.mjs")).href);
  const configPath=path.join(root,"client/config.json");const ticket=authority.issueBootstrapTicket().ticket;
  const variables:Record<string,string|undefined>={RABI_MANAGER_URL:base,RABI_AGENT_BOOTSTRAP_TICKET:ticket,RABI_AGENT_DEFAULT_CWD:root,
    RABI_AGENT_ALLOWED_CWDS:JSON.stringify([root]),RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256:"a".repeat(64),RABI_NODE_ID:"client-entry-node",RABI_AGENT_TYPE:undefined,RABI_AGENT_CODEX_THREAD_ID:undefined};
  const previous=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));
  try{for(const[key,value]of Object.entries(variables)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await module.__test.bootstrapConfig(configPath);
  }finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  const config=JSON.parse(fs.readFileSync(configPath,"utf8"));assert.deepEqual(config.agents,[]);assert.equal(config.codexDesktop,undefined);
  const child=spawn(process.execPath,[path.resolve("apps/rabi-agent/rabi-agent.mjs"),"--run","--config",configPath],{windowsHide:true,
    env:{...process.env,RABI_AGENT_SUPERVISED:"1",APPDATA:path.join(root,"appdata"),LOCALAPPDATA:path.join(root,"localappdata")},stdio:["ignore","pipe","pipe","ipc"]});
  child.stdout!.resume();let error="";child.stderr!.on("data",bytes=>{error=(error+bytes).slice(-2048);});
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
  t.after(async()=>{if(child.connected)child.disconnect();const deadline=setTimeout(()=>child.kill(),6000);await exited;clearTimeout(deadline);detach();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const limit=Date.now()+30000;
  while(!registry.getNode("client-entry-node")?.connected){assert.equal(child.exitCode,null,error);if(Date.now()>limit)throw new Error("Client CLI did not connect.");await new Promise(resolve=>setTimeout(resolve,30));}
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
});
