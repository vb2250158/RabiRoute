import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { createVideoRuntime, createVideoRequestAccess } from "./videoRuntime.js";
import type { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
// @ts-ignore Plugin modules are tested through their published JavaScript interface.
import { dispatchVideoRequest } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/manager.mjs";
// @ts-ignore Plugin modules are tested through their published JavaScript interface.
import { VideoService } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/service.mjs";
// @ts-ignore Plugin modules are tested through their published JavaScript interface.
import { VideoModels } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/models.mjs";
// @ts-ignore Plugin modules are tested through their published JavaScript interface.
import { checkedReadBody } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/requestAccess.mjs";
// @ts-ignore Plugin modules are tested through their published JavaScript interface.
import { streamMedia } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/media.mjs";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const jsonResponse = (response: http.ServerResponse, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
type Mode = "disable" | "agent-aba" | "global-aba" | "node-aba";
async function fixture(t: TestContext, handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root); config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
  authority.registerAgentCatalog(credential.token, [binding]);
  const server = http.createServer((request, response) => {
    const admission = evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy());
    if (admission.kind !== "agent") { jsonResponse(response,403,{error:"denied"}); return; }
    handler(request,response);
  });
  const endpoint = await listenManagerEndpoint({server,host:"127.0.0.1",policy:{mode:"auto"}});
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await fs.rm(root,{recursive:true,force:true}); });
  return {root, url:endpoint.baseUrl, headers:{authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-id":"worker"}, revoke(mode:Mode) {
    if(mode === "global-aba") { config.patch({webguiLan:{enabled:false}});config.patch({webguiLan:{enabled:true}}); }
    else if(mode === "node-aba") { authority.revokeNode("fixture-node");const replacement=authority.enroll(authority.issueBootstrapTicket().ticket,"fixture-node");authority.registerAgentCatalog(replacement.token,[binding]); }
    else { authority.setAgentEnabled("fixture-node","worker",false);if(mode === "agent-aba")authority.setAgentEnabled("fixture-node","worker",true); }
  }};
}

for (const mode of ["disable","agent-aba","global-aba","node-aba"] as Mode[]) {
  for (const boundary of ["body","queue","preflight","stream","probe","network"] as const) {
    test(`video ${boundary} blocks original request dispatch after ${mode}`, {timeout:10000}, async t => {
      const entered=deferred(), gate=deferred();t.after(gate.resolve);let dispatches=0;
      const service=new VideoService({alive:()=>true,stop:async()=>{},start:async()=>{dispatches++;return "http://fixture.invalid";}},{models:[],states:{}},()=>{});
      const originalRead=fs.readFile;
      const f=await fixture(t,(request,response)=>{
        const runtime = boundary === "probe" ? createVideoRuntime(f.root, {} as never, { launch(){dispatches++;throw new Error("Unexpected process launch");} } as unknown as ProcessLeaseRegistry) : {requestAccess:createVideoRequestAccess};
        dispatchVideoRequest(runtime,{jsonResponse},request,response,async(access: ReturnType<typeof createVideoRequestAccess>)=>{
          response.setHeader("etag","sensitive-etag");response.setHeader("idempotency-key","sensitive-key");
          if(boundary === "body") await checkedReadBody({readJsonBody:async()=>{entered.resolve();await gate.promise;return {secret:"private-command"};}},request,4096,access);
          if(boundary === "queue") { service.serial=gate.promise;entered.resolve();await service.exclusive(()=>{dispatches++;},access); }
          if(boundary === "network") {
            service.fetch=async()=>{entered.resolve();await gate.promise;return {ok:true,json:async()=>{dispatches++;return {secret:"private-command"};}};};
            await service.request("/object_info",{},access);
          }
          if(boundary === "preflight") await service.start(undefined,async()=>{entered.resolve();await gate.promise;},access);
          if(boundary === "stream") { await streamMedia(request,response,"private-path","video/mp4",undefined,access,{fs:{stat:async()=>{entered.resolve();await gate.promise;return {size:123456};}},createReadStream:()=>{dispatches++;throw new Error("Unexpected raw stream");}});return; }
          if(boundary === "probe") await (runtime as ReturnType<typeof createVideoRuntime>).inspectAsset("00000000-0000-0000-0000-000000000000","image",access);
          access.assert();dispatches++;jsonResponse(response,200,{secret:"private-command"});
        });
      });
      if(boundary === "probe") { fs.readFile=(async (...args: Parameters<typeof fs.readFile>)=>{if(String(args[0]).endsWith("runtime.json")){entered.resolve();await gate.promise;return JSON.stringify({pythonExecutable:path.join(f.root,"python.exe")});}return originalRead(...args);}) as typeof fs.readFile;t.after(()=>{fs.readFile=originalRead;}); }
      const pending=fetch(`${f.url}/api/video/status`,{headers:f.headers,method:boundary === "stream" ? "GET" : "POST"});
      await entered.promise;f.revoke(mode);gate.resolve();const response=await pending;const body=await response.text();
      assert.equal(response.status,403);assert.equal(dispatches,0);assert.equal(response.headers.get("etag"),null);assert.equal(response.headers.get("idempotency-key"),null);
      assert.doesNotMatch(body,/private-command|private-path|sensitive-|123456/);if(boundary!=="stream")assert.equal(JSON.parse(body).mutation,"not_started");
      assert.equal(response.headers.get("cache-control"),"no-store");
    });
  }
}

test("accepted background model operation does not retain initiating request access", {timeout:10000}, async t=>{
  const entered=deferred(),gate=deferred();let model:any, dispatches=0;
  const f=await fixture(t,(request,response)=>dispatchVideoRequest({requestAccess:createVideoRequestAccess},{jsonResponse},request,response,async(access: ReturnType<typeof createVideoRequestAccess>)=>{
    model=new VideoModels({readOnly:false,alive:()=>false,stateRoot:f.root},{models:[]},()=>{});
    const job=model.begin("models",async()=>{entered.resolve();await gate.promise;dispatches++;},access);access.assert();jsonResponse(response,200,job);
  }));
  const response=await fetch(`${f.url}/api/video/models`,{headers:f.headers,method:"POST"});assert.equal(response.status,200);await entered.promise;f.revoke("agent-aba");gate.resolve();await model.flight;assert.equal(dispatches,1);assert.equal(model.job.state,"completed");
});

test("video denial is sticky and reports unknown once a mutation was dispatched", {timeout:10000},async t=>{
  const entered=deferred(),gate=deferred();let captured:any;
  const f=await fixture(t,(request,response)=>dispatchVideoRequest({requestAccess:createVideoRequestAccess},{jsonResponse},request,response,async(access: ReturnType<typeof createVideoRequestAccess>)=>{
    captured=access;access.beforeMutation();entered.resolve();await gate.promise;assert.equal(createVideoRuntime(f.root,{} as never,{} as ProcessLeaseRegistry).localSettingsAllowed(request),false);try {access.assert();}catch {} throw new Error("private-command");
  }));
  const pending=fetch(`${f.url}/api/video/jobs`,{headers:f.headers,method:"POST"});await entered.promise;f.revoke("agent-aba");gate.resolve();const response=await pending;assert.equal(response.status,403);assert.equal((await response.json()).mutation,"unknown");assert.throws(()=>captured.assert(),/Video request forbidden/);
});

test("enabled Agent retains local-equivalent model access despite nonlocal browser headers", {timeout:10000},async t=>{
  const f=await fixture(t,(request,response)=>{
    const runtime=createVideoRuntime(f.root,{} as never,{} as ProcessLeaseRegistry);
    dispatchVideoRequest(runtime,{jsonResponse},request,response,(access: ReturnType<typeof createVideoRequestAccess>)=>{
      assert.equal(runtime.localSettingsAllowed(request),true);access.assert();jsonResponse(response,200,{allowed:true});
    });
  });
  const response=await fetch(`${f.url}/api/video/models/settings`,{headers:{...f.headers,origin:"https://external.invalid",forwarded:"for=192.0.2.10",host:"external.invalid"}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{allowed:true});
});

test("video model browser exemptions remain socket Host Origin and forwarding constrained",()=>{
  const runtime=createVideoRuntime("fixture",{} as never,{} as ProcessLeaseRegistry);
  const allowed=(address:string,headers:http.IncomingHttpHeaders)=>runtime.localSettingsAllowed({socket:{remoteAddress:address},headers} as http.IncomingMessage);
  assert.equal(allowed("127.0.0.1",{host:"localhost:8000",origin:"http://localhost:8000"}),true);
  for(const [address,headers] of [
    ["192.0.2.10",{host:"localhost:8000"}],
    ["127.0.0.1",{host:"external.invalid"}],
    ["127.0.0.1",{host:"localhost:8000",origin:"https://external.invalid"}],
    ["127.0.0.1",{host:"localhost:8000",forwarded:"for=192.0.2.10"}],
    ["127.0.0.1",{host:"localhost:8000","x-forwarded-for":"192.0.2.10"}],
    ["127.0.0.1",{host:"localhost:8000","sec-fetch-site":"cross-site"}],
    ["127.0.0.1",{host:"localhost:8000","x-rabiroute-agent-id":"forged"}]
  ] as [string,http.IncomingHttpHeaders][])assert.equal(allowed(address,headers),false);
});

test("accepted generation dispatch continues without capturing the initiating authorization",{timeout:10000},async t=>{
  const entered=deferred(),gate=deferred();let service:any,dispatches=0;t.after(gate.resolve);
  const catalog=JSON.parse(await fs.readFile(new URL("../../plugins/builtin/io.rabiroute.manager.video/1.0.0/catalog.json",import.meta.url),"utf8"));
  const f=await fixture(t,(request,response)=>dispatchVideoRequest({requestAccess:createVideoRequestAccess},{jsonResponse},request,response,async(access: ReturnType<typeof createVideoRequestAccess>)=>{
    service=new VideoService({stateRoot:f.root,alive:()=>true,stop:async()=>{}},catalog,()=>{});await service.initialize();service.online=true;
    service.runQueue=async()=>{entered.resolve();await gate.promise;await service.request("/prompt",{method:"POST"});};
    service.fetch=async()=>{dispatches++;return {ok:true,json:async()=>({prompt_id:"fixture"})};};
    const job=await service.submit({model:catalog.models[0].id,prompt:"fixture",width:512,height:512,frames:22,seed:1},"generation-fixture-001",access);access.assert();jsonResponse(response,202,job);
  }));
  const response=await fetch(`${f.url}/api/video/jobs`,{headers:f.headers,method:"POST"});assert.equal(response.status,202);await entered.promise;f.revoke("global-aba");gate.resolve();await service.active;assert.equal(dispatches,1);
});
