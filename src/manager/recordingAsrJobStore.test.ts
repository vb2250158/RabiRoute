import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RecordingArchiveStore } from "./recordingArchiveStore.js";
import { recordingManifestHash, type RecordingManifest } from "./recordingArchiveContract.js";
import { recordingAsrJobKey } from "./recordingAsrJobs.js";
import { RecordingAsrJobStore } from "./recordingAsrJobStore.js";
import type { EffectiveAsrSelection } from "./recordingAsrSelection.js";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const selection: EffectiveAsrSelection = {provider:"test",model:"test/model",language:null,prompt:null,selectionSource:"pc-microphone-config",configFingerprint:"a".repeat(64)};
async function fixture(t: {after(fn:()=>Promise<unknown>):void}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"asr-job-store-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target={root,storageNamespaceId:randomUUID()}, base={resolveOwner:async()=>target,workerId:()=>"pc"};
 const archive=new RecordingArchiveStore(base); await archive.provision(target);
 const pcm=Buffer.from([1,2]); const hash=sha(pcm);
 const manifest:RecordingManifest={schemaVersion:1,recordId:"r",captureId:"c",eventId:"e",deviceId:"phone",source:"phone",startedAt:100,endedAt:101,timeBasis:"received",format:{codec:"pcm_s16le",sampleRate:16000,channels:1},segments:[{sequence:1,bytes:2,sha256:hash,startedAt:100}],objects:[{sha256:hash,bytes:2,offset:0}],gaps:[],processingPolicy:"transcribe",totalBytes:2,sealed:true};
 await archive.putObject("phone",hash,pcm); const receipt=await archive.commitManifest("phone","r",recordingManifestHash(manifest),manifest);
 const ref={owner:"phone",manifest,receipt,processingVersion:"v1"}, jobKey=recordingAsrJobKey(ref);
 let now=1000; const options={...base,owner:"phone",instanceId:"one",clock:()=>now,leaseMs:1000};
 const a=new RecordingAsrJobStore(options), b=new RecordingAsrJobStore({...options,instanceId:"two"});
 const input={jobKey,ref,state:"queued" as const,attempt:0,updatedAt:now};
 const ready=async()=>{ const j=await a.create(input); return (await a.update(jobKey,j.revision,{selection,updatedAt:now}))!; };
 return {root,target,a,b,options,input,jobKey,ready,setNow:(v:number)=>now=v};
}
test("independent writers CAS create/update/claim and atomic empty result survive restart",async t=>{
 const f=await fixture(t); const initial=await Promise.all([f.a.create(f.input),f.b.create(f.input)]); assert.equal(initial[0].revision,initial[1].revision);
 const changed=await Promise.all([f.a.update(f.jobKey,"1",{selection}),f.b.update(f.jobKey,"1",{selection})]); assert.equal(changed.filter(Boolean).length,1);
 const revision=(await f.a.get(f.jobKey))!.revision;
 const leases=await Promise.all([f.a.claim(f.jobKey,revision,1000),f.b.claim(f.jobKey,revision,1000)]); assert.equal(leases.filter(Boolean).length,1);
 const winner=leases[0]?f.a:f.b, lease=leases.find(Boolean)!;
 const results=await Promise.all([winner.commitResult(lease,{text:""},1001),winner.commitResult(lease,{text:"other"},1001)]); assert.equal(results.filter(Boolean).length,1);
 assert.equal(await winner.commitResult(lease,{text:results[0]?"":"other"},1002),true);
 assert.equal(await winner.commitResult(lease,{text:"conflict"},1002),false);
 const restarted=new RecordingAsrJobStore(f.options); assert.equal((await restarted.get(f.jobKey))!.state,"completed"); assert.deepEqual(await restarted.readResult(f.jobKey),{text:results[0]?"":"other"});
 assert.equal(await restarted.update(f.jobKey,(await restarted.get(f.jobKey))!.revision,{state:"queued"}),undefined);
});
test("expired leases become ambiguous by CAS and cannot publish late results",async t=>{
 const f=await fixture(t), j=await f.ready(), lease=(await f.a.claim(f.jobKey,j.revision,1000))!;
 const running=(await f.a.get(f.jobKey))!;
 assert.equal(await f.b.commitResult(lease,{text:"wrong instance"},1001),false);
 assert.equal(await f.b.recoverAmbiguous(f.jobKey,running.revision,1001),false);
 f.setNow(2001);
 const races=await Promise.all([f.a.commitResult(lease,{text:"late"},2001),f.b.recoverAmbiguous(f.jobKey,running.revision,2001)]);
 assert.deepEqual(races,[false,true]); assert.equal(await f.a.readResult(f.jobKey),undefined);
 assert.equal((await f.a.get(f.jobKey))!.state,"ambiguous");
});
test("frozen ref/selection, owner/namespace and authoritative receipt fail closed",async t=>{
 const f=await fixture(t), j=await f.ready();
 await assert.rejects(f.a.update(f.jobKey,j.revision,{selection:{...selection,model:"test/changed"}}),/Frozen/);
 await assert.rejects(f.a.create({...f.input,jobKey:"b".repeat(64)}));
 const other=new RecordingAsrJobStore({...f.options,owner:"other"}); await assert.rejects(other.create(f.input));
 await assert.rejects(new RecordingAsrJobStore({...f.options,workerId:()=>"other-pc"}).create(f.input));
 const modified={...f.input,ref:{...f.input.ref,receipt:{...f.input.ref.receipt,committedAt:99}}}; await assert.rejects(f.a.create(modified),/authoritative/);
 f.target.storageNamespaceId=randomUUID(); await assert.rejects(f.a.get(f.jobKey),/namespace/);
});
test("partial writes are ignored; explicit recovery pages intents; missing NAS is not recreated",async t=>{
 const f=await fixture(t); const j=await f.ready();
 const dir=path.join(f.root,"jobs",sha("phone"),f.jobKey);
 await fs.writeFile(path.join(dir,"000000000003.json.crash.partial"),"broken");
 assert.equal((await f.a.get(f.jobKey))!.revision,j.revision);
 const page=await f.a.recoverable(); assert.equal(page.jobs.length,1); assert.equal(page.nextCursor,undefined);
 await fs.rm(path.join(f.root,"namespace.json")); await assert.rejects(f.a.get(f.jobKey)); await assert.rejects(f.a.recoverable());
});
test("claim result races finish via same next slot and failed retry keeps selection",async t=>{
 const f=await fixture(t), j=await f.ready(), lease=(await f.a.claim(f.jobKey,j.revision,1000))!;
 const outcomes=await Promise.all([f.a.finish(lease,"failed","not_dispatched",1001),f.a.commitResult(lease,{text:"x"},1001)]);
 assert.equal(outcomes.filter(Boolean).length,1);
 const current=(await f.a.get(f.jobKey))!;
 if(current.state==="failed") { const retry=await f.a.update(f.jobKey,current.revision,{state:"queued",error:""}); assert.deepEqual(retry!.selection,selection); }
 else assert.equal(current.state,"completed");
});
