import test from "node:test";
import assert from "node:assert/strict";
import { AllDayRecordingReadModel } from "./allDayRecordingReadModel.js";
import { DEFAULT_ALL_DAY_SETTINGS, type AllDayCatalog, type AllDayEvent } from "../shared/allDayRecording.js";
const row=(id:string):AllDayEvent=>({id,startedAt:Date.parse("2026-10-11"),endedAt:Date.parse("2026-10-11"),source:"screen",kind:"image",deviceId:"host",state:"saved",text:"",media:`media/2026-10-11/${id}.jpg`});

test("cold NAS reads acknowledge pending immediately and coalesce; committed frames survive a late snapshot",async()=>{
 let release!:(value:AllDayCatalog)=>void, calls=0;
 const pending=new Promise<AllDayCatalog>(resolve=>{release=resolve;});
 const ready:unknown[]=[];
 const model=new AllDayRecordingReadModel({directory:()=>"/private/role",mobileRoot:"/private/mobile",settings:async()=>DEFAULT_ALL_DAY_SETTINGS,
  run:async()=>{calls++;return pending;},ready:(_role,event)=>{ready.push(event);}});
 const first=await model.catalog("one","2026-10-11");
 assert.equal(first.loading,true); assert.deepEqual(first.events,[]);
 assert.equal((await model.catalog("one","2026-10-11")).loading,true); assert.equal(calls,1);
 model.committed("one",row("new"),Buffer.from("saved"),true);
 release({events:[row("old")],days:["2026-10-11"],incompleteDays:[]});
 await new Promise(resolve=>setImmediate(resolve));
 const loaded=await model.catalog("one","2026-10-11");
 assert.equal(loaded.loading,false); assert.deepEqual(loaded.events.map(x=>x.id).sort(),["new","old"]);
 assert.equal(ready.length,1);
 assert.deepEqual(await model.media("one","2026-10-11","new","jpg"),Buffer.from("saved"));
 model.dispose();
});

test("unavailable sources remain explicit and cannot become complete empty history",async()=>{
 const model=new AllDayRecordingReadModel({directory:()=>"/private/role",mobileRoot:"/private/mobile",settings:async()=>DEFAULT_ALL_DAY_SETTINGS,
  run:async()=>{throw new Error("NAS unavailable");},ready:()=>{}});
 await model.catalog("one","2026-10-11"); await new Promise(resolve=>setImmediate(resolve));
 const failed=await model.catalog("one","2026-10-11");
 assert.match(failed.readError!,/NAS unavailable/); assert.deepEqual(failed.incompleteDays,["2026-10-11"]);
 model.dispose();
});

test("pending adjacent history cannot declare the first event or skip an unloaded day",async()=>{
 const model=new AllDayRecordingReadModel({directory:()=>"/private/role",mobileRoot:"/private/mobile",settings:async()=>DEFAULT_ALL_DAY_SETTINGS,
  run:async job=>job.kind==="catalog"&&!job.day?{events:[],days:["2026-10-10","2026-10-11"],incompleteDays:[]}:new Promise(()=>{}),ready:()=>{}});
 await model.catalog("one"); await new Promise(resolve=>setImmediate(resolve));
 const page=await model.page("one","older",{time:Date.parse("2026-10-12"),id:""});
 assert.equal(page.loading,true); assert.equal(page.hasMore,true); assert.deepEqual(page.pendingDays,["2026-10-11"]);
 model.dispose();
});

test("an invalidated late response cannot replace the new persona snapshot",async()=>{
 const pending:Array<(value:AllDayCatalog)=>void>=[];
 const ready:unknown[]=[];
 const model=new AllDayRecordingReadModel({directory:role=>`/private/${role}`,mobileRoot:"/private/mobile",settings:async()=>DEFAULT_ALL_DAY_SETTINGS,
  run:()=>new Promise(resolve=>pending.push(resolve)),ready:(_role,event)=>ready.push(event)});
 await model.catalog("one","2026-10-11");model.invalidate("one");await model.catalog("one","2026-10-11");
 pending[1]({events:[row("new")],days:["2026-10-11"],incompleteDays:[]});await new Promise(resolve=>setImmediate(resolve));
 pending[0]({events:[row("old")],days:["2026-10-11"],incompleteDays:[]});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual((await model.catalog("one","2026-10-11")).events.map(row=>row.id),["new"]);
 assert.equal(ready.length,1);model.dispose();
});
