import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { RecordingArchiveAsrRuntime } from "./recordingArchiveAsrRuntime.js";
import { recordingManifestHash, type RecordingManifest } from "./recordingArchiveContract.js";

async function fixture(t: {after(fn:()=>Promise<unknown>):void}, available=true) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"archive-asr-runtime-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const state=path.join(root,"state"), role=path.join(root,"role"); await fs.mkdir(state); await fs.mkdir(path.join(role,"all-day-recording"),{recursive:true});
 const archive=new RecordingArchiveRuntime({stateDir:state,roleDirectory:()=>role,workerId:()=>"pc",authorizeResources:()=>null,localAdmin:()=>true,readOnly:()=>false});
 const ns=randomUUID(); await archive.bindings.provisionNamespace("role",ns);
 for(const owner of ["a","b"]) {await archive.bindings.configure(owner,"role",ns,0);await archive.restoreOwner(owner);}
 let calls=0,active=0,max=0; const models:string[]=[];
 const fetchImpl=(async (input:any, init:any)=>{
   const url=new URL(String(input)); assert.equal(url.hostname,"127.0.0.1");
   let body:unknown;
   if(url.pathname==="/v1/microphone/status") body={config:{asr_model:"engine/quality",language:"zh",prompt:"frozen"}};
   else if(url.pathname==="/v1/models") body={data:[{id:"engine/quality",provider:"engine",model:"quality",capability:"asr",installed:available,available:true,enabled:true}]};
   else if(url.pathname==="/v1/capabilities") body={providers:{defaults:{asr:"engine"},asr:{engine:{model:"other"}}}};
   else {assert.equal(url.pathname,"/v1/archive/transcriptions");calls++;active++;max=Math.max(max,active);
     assert.equal(init.body.get("prompt"),"frozen"); models.push(init.body.get("model"));
     const bytes=Buffer.from(await init.body.get("file").arrayBuffer());assert.equal(bytes.toString("ascii",0,4),"RIFF"); assert.equal(bytes.length,46);
     await new Promise(r=>setTimeout(r,10));active--;body={text:"",segments:[],provider:"engine",model:"quality"};}
   return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
 const options={archive,localSpeechUrl:()=>"http://127.0.0.1:1",workerId:()=>"pc",instanceId:"instance",fetchImpl};
 const runtime=new RecordingArchiveAsrRuntime(options);t.after(()=>runtime.dispose());
 const make=async(owner:string,policy:RecordingManifest["processingPolicy"]="transcribe")=>{
  const pcm=Buffer.from([1,2]),sha=createHash("sha256").update(pcm).digest("hex");
  const manifest:RecordingManifest={schemaVersion:1,recordId:"record",captureId:"capture",eventId:"event",deviceId:owner,source:"phone",startedAt:100,endedAt:101,timeBasis:"received",format:{codec:"pcm_s16le",sampleRate:16000,channels:1},segments:[{sequence:1,bytes:2,sha256:sha,startedAt:100}],objects:[{sha256:sha,bytes:2,offset:0}],gaps:[],processingPolicy:policy,totalBytes:2,sealed:true};
  await archive.store.putObject(owner,sha,pcm);const receipt=await archive.store.commitManifest(owner,"record",recordingManifestHash(manifest),manifest);
  return {owner,manifest,receipt,processingVersion:"initial"};
 };
 return {archive,runtime,options,make,get calls(){return calls;},get max(){return max;},models};
}
test("all owners share one computation slot; frozen PC model and empty results survive restore",async t=>{
 const f=await fixture(t),a=await f.make("a"),b=await f.make("b");
 await Promise.all([f.runtime.onCommitted(a.owner,a.manifest,a.receipt),f.runtime.onCommitted(b.owner,b.manifest,b.receipt)]);await f.runtime.idle();
 assert.equal(f.calls,2);assert.equal(f.max,1);assert.deepEqual(f.models,["engine/quality","engine/quality"]);
 assert.equal((await f.runtime.readResult(a)).state,"completed");assert.deepEqual((await f.runtime.readResult(a)).result,{text:"",segments:[]});
 await f.runtime.dispose();const restored=new RecordingArchiveAsrRuntime({...f.options,instanceId:"restart"});t.after(()=>restored.dispose());
 assert.deepEqual(await restored.restore(),[{owner:"a",ready:true},{owner:"b",ready:true}]);await restored.idle();assert.equal(f.calls,2);
});
test("unavailable PC model leaves valid archive receipt; non-transcribe policies never run",async t=>{
 const f=await fixture(t,false),a=await f.make("a"),b=await f.make("b","agent");
 await f.runtime.onCommitted(a.owner,a.manifest,a.receipt);assert.equal(await f.runtime.onCommitted(b.owner,b.manifest,b.receipt),undefined);await f.runtime.idle();
 assert.equal(f.calls,0);assert.equal((await f.runtime.readResult(a)).state,"blocked");
 assert.deepEqual(await f.archive.store.readReceipt("a","record",a.receipt.manifestHash),a.receipt);
});
