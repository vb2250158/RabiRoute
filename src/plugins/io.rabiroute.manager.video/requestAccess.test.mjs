import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { checkedFs, checkedReadBody } from "./requestAccess.mjs";
import { VideoProjects } from "./projects.mjs";
import { VideoAssets } from "./assets.mjs";
import { VideoModels } from "./models.mjs";
import { VideoService } from "./service.mjs";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function authority() { let revoked=false, mutated=false; const assert=()=>{if(revoked) throw Object.assign(new Error("revoked"),{code:"VIDEO_REQUEST_FORBIDDEN"});}; return {assert,beforeMutation(){assert();mutated=true;},revoke(){revoked=true;},get mutationStarted(){return mutated;}}; }
async function root(t) { const root=await fs.mkdtemp(path.join(os.tmpdir(),"video-fence-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }

test("body parsing failures cannot replace revocation with a generic parse error",async()=>{
  const access=authority();await assert.rejects(checkedReadBody({readJsonBody:async()=>{access.revoke();throw new Error("malformed");}},null,4096,access),/revoked/);
});
test("filesystem publication rechecks before every dispatch",async t=>{
  const directory=await root(t),access=authority(),guarded=checkedFs(access);await guarded.writeFile(path.join(directory,"partial"),"accepted");access.revoke();
  await assert.rejects(guarded.rename(path.join(directory,"partial"),path.join(directory,"published")),/revoked/);assert.equal(await fs.readFile(path.join(directory,"partial"),"utf8"),"accepted");assert.equal(access.mutationStarted,true);
});
test("project queue checks access after a concurrent mutation completes",async t=>{
  const stateRoot=await root(t),projects=new VideoProjects({stateRoot}),gate=deferred(),access=authority();projects.serial=gate.promise;
  const id=randomUUID(),pending=projects.create({id},access);access.revoke();gate.resolve();await assert.rejects(pending,/revoked/);assert.deepEqual(await projects.list(),[]);
});
test("asset inspection failures preserve sticky revocation and do not publish metadata",async t=>{
  const stateRoot=await root(t),access=authority();const assets=new VideoAssets({stateRoot,installed:async()=>true,inspectAsset:async()=>{access.revoke();throw new Error("bad media");}});
  const request={headers:{},async *[Symbol.asyncIterator](){yield Buffer.from("fixture");}};
  await assert.rejects(assets.upload(request,"image",access),/revoked/);assert.equal((await fs.readdir(path.join(stateRoot,"assets"))).filter(name=>name.endsWith(".json")).length,0);
});
test("model configure does not write settings after asynchronous root validation revocation",async t=>{
  const stateRoot=await root(t),access=authority();const models=new VideoModels({stateRoot,alive:()=>false,validateModelRoot:async()=>{access.revoke();return null;}},{models:[]},()=>{});
  await assert.rejects(models.configure({modelRoot:null,expectedRevision:0},access),/revoked/);assert.deepEqual(await fs.readdir(stateRoot),[]);
});
test("runtime probe retry does not issue another network request or stop after revocation",async()=>{
  const access=authority();let requests=0,stops=0;const runtime={alive:()=>true,start:async()=>"http://fixture.invalid",stop:async()=>{stops++;}};
  const service=new VideoService(runtime,{models:[],states:{}},()=>{}, {fetch:async()=>{requests++;access.revoke();throw new Error("connection failed");}});
  await assert.rejects(service.start(undefined,()=>{},access),/revoked/);assert.equal(requests,1);assert.equal(stops,0);
});
