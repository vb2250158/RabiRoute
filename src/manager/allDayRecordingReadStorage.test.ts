import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAllDayStorage, type AllDayReadJob } from "./allDayRecordingReadStorage.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import type { AllDayCatalog, AllDayEvent } from "../shared/allDayRecording.js";

test("isolated storage reads distinguish dirty, damaged, absent and indexed history without writing originals",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-recording-read-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const job:AllDayReadJob={kind:"catalog",directory:root,mobileRoot:path.join(root,"mobile"),mobileDeviceIds:[],day:"2026-10-11"};
  assert.deepEqual((readAllDayStorage(job) as AllDayCatalog).incompleteDays,[]);
  const originals=path.join(root,"events",job.day!);await fs.mkdir(originals,{recursive:true});
  assert.deepEqual((readAllDayStorage(job) as AllDayCatalog).incompleteDays,[job.day]);
  await fs.mkdir(path.join(root,"events-index"));
  const index=path.join(root,"events-index",`${job.day}.json`);await fs.writeFile(index,"broken");
  assert.deepEqual((readAllDayStorage(job) as AllDayCatalog).incompleteDays,[job.day]);
  const row:AllDayEvent={id:"one",source:"screen",kind:"image",deviceId:"computer",state:"saved",text:"",startedAt:Date.parse(job.day!),endedAt:Date.parse(job.day!)};
  await fs.writeFile(index,JSON.stringify({schemaVersion:2,events:[row]}));
  await fs.writeFile(path.join(root,"events-index",`${job.day}.dirty.json`),"{}");
  const pool=new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:2,timeoutMs:20_000});t.after(()=>pool.stop());
  const catalog=await pool.run<AllDayCatalog>({type:"all_day_recording_read",input:job});
  assert.deepEqual(catalog.events,[row]);assert.deepEqual(catalog.incompleteDays,[job.day]);
  assert.deepEqual(await fs.readdir(originals),[]);
  assert.throws(()=>readAllDayStorage({...job,kind:"media",id:"../outside",extension:"jpg"}),/Invalid media reference/);
});

test("worker reconstruction reads every original across bounded batches and fails on damaged originals",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-recording-scan-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const day="2026-10-11",directory=path.join(root,day);await fs.mkdir(directory);
  const originals=Array.from({length:37},(_,i)=>({id:`event-${i}`,source:"window",kind:"window",deviceId:"computer",state:"saved",text:"",startedAt:Date.parse(day)+i,endedAt:Date.parse(day)+i} as AllDayEvent));
  await Promise.all(originals.map((row,i)=>fs.writeFile(path.join(directory,`${i.toString(16).padStart(64,"0")}.json`),JSON.stringify(row))));
  await fs.writeFile(path.join(directory,"ignored.json"),"unrelated");
  const pool=new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:2,timeoutMs:20_000});t.after(()=>pool.stop());
  const input:AllDayReadJob={kind:"scan",directory:root,day,mobileRoot:"",mobileDeviceIds:[]};
  const rows=await pool.run<AllDayEvent[]>({type:"all_day_recording_read",input});
  assert.deepEqual(rows.sort((a,b)=>a.startedAt-b.startedAt),originals);
  assert.equal((await fs.readdir(directory)).length,38);
  await fs.writeFile(path.join(directory,`${"f".repeat(64)}.json`),"broken");
  await assert.rejects(pool.run({type:"all_day_recording_read",input}),/JSON|Unexpected/);
});
