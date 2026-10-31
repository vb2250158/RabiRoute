import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { activate } from "./manager.mjs";
import { PublicationScope } from "@rabiroute/plugin-sdk";
import { register } from "tsx/esm/api";
const loader = register({ namespace: "video-plugin-contract-test" });
after(() => loader.unregister());
const { createVideoOperations } = await loader.import("../../../../src/manager/videoOperations.ts", import.meta.url);
const { ManagerPluginRouteRegistry } = await loader.import("../../../../src/manager/managerPluginRouteRegistry.ts", import.meta.url);
const { EffectScope } = await loader.import("../../../../src/plugin-kernel/effectScope.ts", import.meta.url);

test("HTTP workspace keeps projects, jobs, output and SSE local while invoking typed peer compute",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-video-api-"));
  const catalog=JSON.parse(await fs.readFile(new URL("./catalog.json",import.meta.url),"utf8"));
  const model=catalog.models.find(row=>row.mode==="image");
  const remoteId="33333333-3333-4333-8333-333333333333";
  const projectId="44444444-4444-4444-8444-444444444444";
  const calls=[];const png=Buffer.from("89504e470d0a1a0a0000000d","hex");let cleanup,server;
  const registry=new ManagerPluginRouteRegistry();
  t.after(async()=>{server?.closeAllConnections();await cleanup?.();if(server)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("rabi-video-api-"));await fs.rm(root,{recursive:true,force:true});});
  const runtime={stateRoot:path.join(root,"video"),componentRoot:path.join(root,"component"),defaultModelRoot:path.join(root,"models"),readOnly:false,
    requestAccess:()=>({assert(){},beforeMutation(){}}),localSettingsAllowed:()=>true,
    installed:async()=>false,alive:()=>false,stop:async()=>{},stopMediaProbe:async()=>{},stopInstaller:async()=>{},
    start:async()=>{throw new Error("No local runtime may be started");},
    peerFetch:async(device,route,init)=>{
      calls.push({device,route});assert.equal(device,"compute-b");
      if(route==="/api/video/compute/status")return Response.json({computeProtocol:1,online:true,availableModels:[model.id],availableWorkflows:[{model:model.id,workflowId:model.id,generateAudio:false}]});
      if(route==="/api/video/compute/jobs") {assert.equal(JSON.parse(init.body).model,model.id);return Response.json({id:remoteId,status:"succeeded"});}
      if(route===`/api/video/compute/jobs/${remoteId}/image`)return new Response(png);
      if(route===`/api/video/compute/jobs/${remoteId}` && init.method==="DELETE")return Response.json({removed:true});
      if(route==="/api/video/models")return Response.json({runtimeInstalled:true,models:[],job:null});
      throw new Error(`Unexpected peer path ${route}`);
    }
  };
  const api={publishManagerEvent(){},
    async readJsonBody(req,limit){let body="";for await(const bytes of req){body+=bytes;if(body.length>limit)throw new Error("body too large");}return JSON.parse(body||"{}");}
  };
  const services={"host.manager.http@1":api,"host.manager.video@1":{createRuntime:()=>runtime,createOperations:createVideoOperations},"host.manager.operations@1":{registerOperationsAsync:(definitions,signal)=>registry.registerOperationsAsync("manager:video",definitions,signal),registerHttpProxies:definitions=>registry.registerHttpProxies("manager:video",definitions)}};
  const effects=new EffectScope(),publication=new PublicationScope(effects);cleanup=()=>effects.dispose();
  await activate({identity:{instanceId:"manager:video"},lifecycle:{signal:effects.signal()},services:{require:key=>{assert.ok(services[key],key);return services[key];},provide(){}},contributions:{register(){}},effects,publication});
  await effects.commit();publication.publish();publication.seal()();await publication.afterPublish(Promise.resolve());
  assert.equal(registry.catalogSnapshot().operations.length,35);
  server=http.createServer((req,res)=>{if(!registry.handle(req,new URL(req.url,"http://fixture"),res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,init)=>{const reply=await fetch(base+"/api/video"+route,init);const value=await reply.json();assert.ok(reply.ok,JSON.stringify(value));return value;};
  await request("/projects?computeDeviceId=compute-b",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:projectId})});
  assert.equal((await request("/projects")).projects[0].id,projectId);
  assert.equal((await request("/models?computeDeviceId=compute-b")).runtimeInstalled,true);
  const job=await request("/jobs?computeDeviceId=compute-b",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"http-owner-test-001"},body:JSON.stringify({model:model.id,prompt:"Paper boat",width:512,height:512,seed:1})});
  const conflict=await fetch(base+"/api/video/jobs?computeDeviceId=compute-b",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"http-owner-test-001"},body:JSON.stringify({model:model.id,prompt:"Paper boat",width:512,height:512,seed:2})});assert.equal(conflict.status,409);
  let state=job;
  for(let attempt=0;attempt<30 && state.status!=="succeeded";attempt++){await new Promise(resolve=>setTimeout(resolve,30));state=await request(`/jobs/${job.id}`);}
  assert.equal(state.status,"succeeded");assert.notEqual(job.id,remoteId);
  const output=await fetch(base+state.imageUrl,{headers:{range:"bytes=0-7"}});assert.equal(output.status,206);assert.deepEqual(Buffer.from(await output.arrayBuffer()),png.subarray(0,8));
  assert.equal((await request("/status?computeDeviceId=compute-b")).jobs[0].id,job.id);
  // Direct URL access still reads the addressed workspace's own history.
  const directStatus=await request("/status");
  assert.equal(directStatus.jobs[0].id,job.id);
  assert.equal(directStatus.jobs[0].prompt,"Paper boat");
  assert.equal((await request("/projects")).projects[0].id,projectId);
  assert.ok(calls.every(call=>call.route.startsWith("/api/video/compute/")||call.route==="/api/video/models"));
  const events=await fetch(base+"/api/video/compute/events");const reader=events.body.getReader();const event=Buffer.from((await reader.read()).value).toString();await reader.cancel();
  assert.match(event,/event: compute/);assert.ok(!event.includes(job.id));assert.ok(!event.includes("Paper boat"));
  assert.equal((await fetch(base+`/api/video/compute/jobs/${job.id}`)).status,404);
});
