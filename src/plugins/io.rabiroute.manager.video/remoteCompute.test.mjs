import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VideoService } from "./service.mjs";
import { RemoteVideoCompute } from "./remoteCompute.mjs";
import { VideoAssets } from "./assets.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json",import.meta.url),"utf8"));
const imageModel = catalog.models.find(row=>row.mode==="image");
const command = {model:imageModel.id,prompt:"Paper boat",width:512,height:512,seed:1};
const receipt = "11111111-1111-4111-8111-111111111111";
const png = Buffer.from("89504e470d0a1a0a0000000d", "hex");
async function fixture(t, respond) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(),"rabi-remote-compute-"));
  const calls = []; let localStarts=0;
  const runtime = { stateRoot, alive:()=>false, stop:async()=>{}, start:async()=>{localStarts++;throw new Error("local GPU must not start");},
    peerFetch:async(device,route,init)=>{
      calls.push({device,route,init});
      if (route === "/api/video/compute/status") return Response.json({computeProtocol:1,online:true,availableModels:[imageModel.id],availableWorkflows:[{model:imageModel.id,workflowId:imageModel.id,generateAudio:false}]});
      return respond(route,init);
    }
  };
  const service = new VideoService(runtime,catalog,()=>{}); await service.initialize();
  service.assets = new VideoAssets(runtime); service.remote = new RemoteVideoCompute(runtime,catalog,()=>{}); service.pump=()=>{};
  t.after(async()=>{await service.close();await fs.rm(stateRoot,{recursive:true,force:true});});
  return {service,runtime,calls,localStarts:()=>localStarts};
}
test("uninitialized workspace owns remote jobs and downloaded results; no peer history or project access",async t=>{
  const f = await fixture(t,async(route,init)=>{
    if (route==="/api/video/compute/jobs") {assert.equal(JSON.parse(init.body).model,imageModel.id);return Response.json({id:receipt,status:"running"});}
    if (route===`/api/video/compute/jobs/${receipt}`) return Response.json(init.method==="DELETE"?{removed:true}:{id:receipt,status:"succeeded"});
    if (route===`/api/video/compute/jobs/${receipt}/events`) return new Response(`event: progress\ndata: ${JSON.stringify({id:receipt,status:"succeeded"})}\n\n`,{headers:{"content-type":"text/event-stream"}});
    if (route===`/api/video/compute/jobs/${receipt}/image`) return new Response(png);
    throw new Error(`Unexpected peer request: ${route}`);
  });
  const job=await f.service.submit(command,"workspace-remote-001",undefined,{deviceId:"pc-b"});
  assert.equal(job.computeDeviceId,"pc-b");
  assert.equal(f.service.online,false);
  await f.service.runQueue();
  const local=f.service.jobs.get(job.id);
  assert.equal(local.status,"succeeded");assert.equal(f.localStarts(),0);
  assert.deepEqual(await fs.readFile(await f.service.outputPath(local)),png);
  assert.equal(f.service.view(local).imageUrl,`/api/video/jobs/${job.id}/image`);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.runtime.stateRoot,"jobs",`${job.id}.json`),"utf8")).status,"succeeded");
  const snapshot=await f.service.snapshotFor("pc-b");assert.equal(snapshot.jobs[0].id,job.id);
  f.runtime.peerFetch=async()=>{throw new Error("offline");};
  assert.equal((await f.service.submit(command,"workspace-remote-001",undefined,{deviceId:"pc-b"})).id,job.id);
  await assert.rejects(f.service.submit(command,"workspace-remote-001",undefined,{deviceId:"pc-c"}),/不同参数/);
  assert.ok(f.calls.every(call=>call.device==="pc-b" && call.route.startsWith("/api/video/compute/")));
});
test("unknown remote submission is attempted once, blocks target, and never starts local GPU",async t=>{
  const f=await fixture(t,async route=>{if(route==="/api/video/compute/jobs")throw new Error("receipt lost");throw new Error("Unexpected request");});
  const first=await f.service.submit(command,"uncertain-remote-001",undefined,{deviceId:"pc-b"});
  const second=await f.service.submit(command,"uncertain-remote-002",undefined,{deviceId:"pc-b"});
  await f.service.runQueue();
  assert.equal(f.service.jobs.get(first.id).status,"failed");assert.equal(f.service.jobs.get(second.id).status,"interrupted");
  assert.equal(f.service.jobs.get(first.id).computeOutcome,"unknown");assert.match(f.service.jobs.get(first.id).error,/未确认/);
  assert.equal(f.calls.filter(call=>call.route==="/api/video/compute/jobs").length,1);assert.equal(f.localStarts(),0);
  assert.equal((await f.service.snapshotFor("pc-b")).online,false);
  const restored=new VideoService(f.runtime,catalog,()=>{});await restored.initialize();
  restored.remote=new RemoteVideoCompute(f.runtime,catalog,()=>{},restored.jobs.values());
  assert.equal((await restored.snapshotFor("pc-b")).online,false);
  const original=f.runtime.peerFetch;
  f.runtime.peerFetch=(device,route,init)=>route==="/api/video/compute/runtime/start"?Promise.resolve(Response.json({online:true})):original(device,route,init);
  await restored.startRemote("pc-b");
  const resumed=new VideoService(f.runtime,catalog,()=>{});await resumed.initialize();
  resumed.remote=new RemoteVideoCompute(f.runtime,catalog,()=>{},resumed.jobs.values());
  assert.equal((await resumed.snapshotFor("pc-b")).online,true);
  assert.equal(resumed.jobs.get(first.id).computeOutcome,"unknown");
  await assert.rejects(f.service.submit(command,"uncertain-remote-003",undefined,{deviceId:"pc-b"}),/先启动/);
});

test("explicit workspace read-only mode permits discovery and blocks remote compute mutations before dispatch",async t=>{
  const f=await fixture(t,()=>{throw new Error("No mutation may reach the peer");});
  f.runtime.readOnly=true;
  assert.equal((await f.service.remote.status("pc-b")).online,true);
  const before=f.calls.length;
  await assert.rejects(f.service.remote.start("pc-b"),error=>error.status===423);
  assert.equal(f.calls.length,before);
});
test("compute receipts share the GPU queue but stay outside workspace history and persist separately",async t=>{
  const f=await fixture(t,()=>{throw new Error("No remote request expected");});
  f.service.online=true;f.runtime.alive=()=>true;
  f.service.computeAssets=new VideoAssets({...f.runtime,stateRoot:path.join(f.runtime.stateRoot,"compute")});
  const job=await f.service.submit(command,"ephemeral-compute-001",undefined,{computeOnly:true});
  assert.deepEqual(f.service.snapshot().jobs,[]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.runtime.stateRoot,"compute","jobs",`${job.id}.json`),"utf8")).computeOnly,true);
  await assert.rejects(f.service.removeCompute(job.id),/尚未结束/);
  await f.service.cancel(job.id);await f.service.removeCompute(job.id);
  assert.equal(f.service.jobs.get(job.id).outputPurged,true);
  assert.equal(f.service.jobs.get(job.id).prompt,undefined);
  assert.equal((await f.service.submit(command,"ephemeral-compute-001",undefined,{computeOnly:true})).id,job.id);
  const restored=new VideoService(f.runtime,catalog,()=>{});await restored.initialize();
  assert.equal((await restored.submit(command,"ephemeral-compute-001",undefined,{computeOnly:true})).id,job.id);
});
test("reference validation can use remote inspection while the authoritative asset remains local",async t=>{
  const assetId="22222222-2222-4222-8222-222222222222";
  const f=await fixture(t,async(route,init)=>{
    if(route.startsWith("/api/video/compute/assets?")){assert.equal(init.body.toString(),"input");return Response.json({id:assetId,kind:"image",size:5,width:512,height:512});}
    if(route===`/api/video/compute/assets/${assetId}`){assert.equal(init.method,"DELETE");return Response.json({removed:true});}
    throw new Error("Unexpected request");
  });
  const request=Object.assign((async function*(){yield Buffer.from("input");})(),{headers:{},destroy(){}});
  const asset=await f.service.assets.upload(request,"image",undefined,(kind,file,access)=>f.service.remote.inspect("pc-b",kind,file,access));
  assert.notEqual(asset.id,assetId);assert.equal(asset.width,512);
  assert.equal((await fs.readFile((await f.service.assets.file(asset.id)).file)).toString(),"input");
});
