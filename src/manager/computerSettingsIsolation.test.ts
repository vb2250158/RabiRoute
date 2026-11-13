import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { ComputerService } from "../../apps/rabi-agent/lib/computer-service.mjs";
import { normalizeComputerSettings, type ComputerExecutionContext } from "../../apps/rabi-agent/lib/computer-control-contract.mjs";

class FixtureNative extends EventEmitter {
  begins = 0;
  async request(action: string) {
    if (action === "control.begin") { this.begins++; return { visible: true }; }
    return { state: "completed", releaseState: "released" };
  }
  async close() {}
}
test("remote old same-ID receipt crosses raw settings without bypassing new-work policy", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-settings-isolation-"));
  const native = new FixtureNative();
  const computer = new ComputerService({ instanceId: "fixture-node", receiptRoot: path.join(directory,"receipts"), nativeFactory: () => native });
  const input = { action: "control.begin", requestId: randomUUID() };
  const valid = normalizeComputerSettings();
  const original = await computer.execute(input,{sourceId:"manager",settings:valid}) as {controlSessionId:string};
  assert.equal(native.begins,1);
  const raw = { enabled:false, annotation:{tracking:{matchThreshold:"broken"}}, performance:{memoryBudgetBytes:"broken"} };
  let fullReads = 0, frames = 0;
  const registry = new LanAgentRegistry({statePath:path.join(directory,"registry.json"),
    computerSettingsRaw:()=>raw, computerSettings:()=>{fullReads++;throw Error("full settings must not be parsed before original receipt");}});
  const server=http.createServer();registry.attach(server,{enabled:()=>true,getToken:()=>"fixture-token"});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;
  const socket=new WebSocket("ws://127.0.0.1:"+port+"/api/lan-agent/connect");
  const receive=(type:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.off("message",read);reject(Error("fixture message timeout "+type));},5000);
    const read=(data:WebSocket.RawData)=>{const message=JSON.parse(String(data));if(message.type===type){clearTimeout(timer);socket.off("message",read);resolve(message);}};
    socket.on("message",read);
  });
  t.after(async()=>{socket.close();registry.close();await computer.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});});
  await once(socket,"open");
  let reply=receive("authenticated");socket.send(JSON.stringify({type:"authenticate",token:"fixture-token"}));await reply;
  reply=receive("connected");socket.send(JSON.stringify({type:"hello",node:{nodeId:"fixture-node",hostname:"Fixture Node",version:"0.4.1",platform:"win32-x64",agentTypes:[],computerCapabilities:["input"]}}));await reply;
  socket.on("message",async data=>{
    const message=JSON.parse(String(data));
    if(message.type!=="manageAgent")return;
    frames++;
    const {_computerContext,...request}=message.params;
    try { const result=await computer.execute(request,_computerContext as ComputerExecutionContext);socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,result})); }
    catch(error){socket.send(JSON.stringify({type:"managementResult",requestId:message.requestId,error:error instanceof Error?error.message:String(error),errorCode:error instanceof Error&&"code" in error?error.code:undefined}));}
  });
  const duplicate=await registry.manageAgent("fixture-node","computer",input) as {controlSessionId:string};
  assert.equal(duplicate.controlSessionId,original.controlSessionId);
  await assert.rejects(registry.manageAgent("fixture-node","computer",{...input,requestId:randomUUID()}),error=>error instanceof Error&&"code" in error&&error.code==="COMPUTER_FEATURE_DISABLED");
  assert.equal(fullReads,0);assert.equal(frames,2);assert.equal(native.begins,1);
});
