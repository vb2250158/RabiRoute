import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePersonaPlanWorkflow, writePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { invalidatePlanReads, planReadFence } from "./planReadInvalidation.js";
import { readPlanPageCatalogInWorker, publishCommittedRolePlan, readPlansFromStorageInWorker, roleKnowledgeFileCountsInWorker } from "./roleKnowledge.js";
import { ManagerReadWorkerPool, type ManagerReadWorkerChild } from "./manager/managerReadWorkerPool.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"plan-read-fence-"));
  ensurePersonaPlanWorkflow(root);
  fs.mkdirSync(path.join(root,"plans","archive"),{recursive:true});
  const dir = path.join(root,"plans","active","sample"); fs.mkdirSync(dir,{recursive:true});
  const file = path.join(dir,"plan.json");
  const plan = { id:"sample",title:"Sample",focus:"old",status:"分析中",archiveStatus:"未归档",keywords:["sample"],createdAt:"2026-01-01",updatedAt:"2026-01-01" };
  fs.writeFileSync(file,JSON.stringify(plan));
  return {root,file,plan};
}
test("resident catalog hot reads avoid file enumeration; explicit reconciliation sees metadata-preserving writes",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const first=await readPlanPageCatalogInWorker(root,planReadFence(root));
  const stat=t.mock.method(fs,"statSync"); const read=t.mock.method(fs,"readFileSync"); const scan=t.mock.method(fs,"readdirSync");
  const next=await readPlanPageCatalogInWorker(root,planReadFence(root));
  assert.strictEqual(next,first); assert.equal(stat.mock.callCount(),0); assert.equal(read.mock.callCount(),0); assert.equal(scan.mock.callCount(),0);
  const before=fs.statSync(file); fs.writeFileSync(file,JSON.stringify({...plan,focus:"new"})); fs.utimesSync(file,before.atime,before.mtime);
  const fresh=await readPlanPageCatalogInWorker(root,planReadFence(root),true);
  assert.equal(fresh[0]!.focus,"new");
});
test("managed fence refreshes a point write and deletion before returning; epoch changes rebuild",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  fs.writeFileSync(file,JSON.stringify({...plan,focus:"committed"})); invalidatePlanReads(root,"sample");
  assert.equal((await readPlanPageCatalogInWorker(root,planReadFence(root)))[0]!.focus,"committed");
  fs.unlinkSync(file); invalidatePlanReads(root,"sample");
  assert.equal((await readPlanPageCatalogInWorker(root,planReadFence(root))).length,0);
  fs.writeFileSync(file,JSON.stringify(plan));
  assert.equal((await readPlanPageCatalogInWorker(root,{...planReadFence(root),epoch:"another-parent"})).length,1);
});
test("watch dirtiness arriving during an awaited point read is consumed before reply",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const second=path.join(root,"plans","active","second","plan.json");
  fs.mkdirSync(path.dirname(second)); fs.writeFileSync(second,JSON.stringify({...plan,id:"second",focus:"old second"}));
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  fs.writeFileSync(file,JSON.stringify({...plan,focus:"known managed update"})); invalidatePlanReads(root,"sample");
  const read=fs.promises.readFile; let injected=false;
  t.mock.method(fs.promises,"readFile",async(...args:Parameters<typeof read>)=>{
    const result=await read(...args);
    if(String(args[0])===file && !injected) {
      injected=true; fs.writeFileSync(second,JSON.stringify({...plan,id:"second",focus:"external update during awaited managed read"}));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return result;
  });
  const catalog=await readPlanPageCatalogInWorker(root,planReadFence(root));
  assert.equal(catalog.find(item=>item.id==="sample")!.focus,"known managed update");
  assert.equal(catalog.find(item=>item.id==="second")!.focus,"external update during awaited managed read");
});

test("cold read verifies metadata after a body replacement or deletion",async t=>{
  for(const remove of [false,true]) {
    const {root,file,plan}=fixture();
    const original=fs.readFileSync; let once=true;
    const probe=t.mock.method(fs,"readFileSync",(...args:Parameters<typeof original>)=>{
      const text=original(...args);
      if(String(args[0])===file && once) {
        once=false;
        if(remove) fs.unlinkSync(file);
        else fs.writeFileSync(file,JSON.stringify({...plan,focus:"replacement while cold body was read"}));
      }
      return text;
    });
    try {
      const result=await readPlanPageCatalogInWorker(root,planReadFence(root));
      if(remove) assert.equal(result.length,0);
      else assert.equal(result[0]!.focus,"replacement while cold body was read");
    } finally {probe.mock.restore();fs.rmSync(root,{recursive:true,force:true});}
  }
});

test("bounded invalidation gaps require full reconciliation",()=>{
  const role=path.join(os.tmpdir(),"fence-only-synthetic");
  for(let i=0;i<1030;i++) invalidatePlanReads(role,`synthetic-${i}`);
  const fence=planReadFence(role); assert.ok(fence.fullRevision>0); assert.ok(fence.changes.length<1024);
});
test("real resident read pool consumes committed publication and keeps legacy page shape",async t=>{
  const {root,file,plan}=fixture(); const pool=new ManagerReadWorkerPool({maxConcurrency:2,maxQueue:8,timeoutMs:30000});
  t.after(async()=>{await pool.stop();fs.rmSync(root,{recursive:true,force:true});});
  const input={cursor:"",limit:8,query:"",sort:"status" as const,statuses:[],tags:[],includeFacets:true,summary:true};
  type Page={items:Array<{id:string;focus:string}>;total:number;counts:unknown;facets:unknown};
  const first=await pool.queryRolePlanPage<Page>(root,input); assert.equal(first.total,1);
  fs.writeFileSync(file,JSON.stringify({...plan,focus:"committed marker"}));
  publishCommittedRolePlan(root,readPlansFromStorageInWorker(root)[0]!);
  const results=await Promise.all([pool.queryRolePlanPage<Page>(root,{...input,query:"committed marker"}),pool.queryRolePlanPage<Page>(root,{...input,limit:2,query:"committed marker"})]);
  assert.ok(results.every(page=>page.total===1)); assert.ok(results.every(page=>page.counts && page.facets));
  fs.unlinkSync(file); invalidatePlanReads(root,"sample");
  assert.equal((await pool.queryRolePlanPage<Page>(root,input)).total,0);
});

test("archive relocation and workflow revisions invalidate the real page presentation",async t=>{
  const {root,file,plan}=fixture(); const pool=new ManagerReadWorkerPool({maxConcurrency:1,timeoutMs:30000});
  t.after(async()=>{await pool.stop();fs.rmSync(root,{recursive:true,force:true});});
  const input={cursor:"",limit:8,query:"",sort:"status" as const,statuses:[],tags:[],includeFacets:true,summary:true};
  type Page={items:Array<{id:string;presentation:{label:string}}> ;total:number;counts:{archived:number}};
  assert.equal((await pool.queryRolePlanPage<Page>(root,input)).total,1);
  const {workflow}=ensurePersonaPlanWorkflow(root);
  const status=workflow.statuses.find(item=>item.key===plan.status)!;
  status.label="Renamed label";
  writePersonaPlanWorkflow(root,workflow);
  assert.equal((await pool.queryRolePlanPage<Page>(root,input)).items[0]!.presentation.label,"Renamed label");
  const archived=path.join(root,"plans","archive","sample"); fs.mkdirSync(archived);
  fs.writeFileSync(path.join(archived,"plan.json"),JSON.stringify({...plan,archiveStatus:"已归档"}));
  fs.unlinkSync(file); invalidatePlanReads(root,"sample");
  const page=await pool.queryRolePlanPage<Page>(root,{...input,view:"archived"});
  assert.equal(page.total,1); assert.equal(page.counts.archived,1);
});

test("standalone process awaits run and stop then exits without a keepalive wrapper",t=>{
  const {root}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker=path.join(root,"completion.json");
  const moduleUrl=new URL(import.meta.url.endsWith(".ts") ? "./manager/managerReadWorkerPool.ts" : "./manager/managerReadWorkerPool.js",import.meta.url).href;
  const script=`import fs from 'node:fs'; import {ManagerReadWorkerPool} from ${JSON.stringify(moduleUrl)};
    const pool=new ManagerReadWorkerPool({maxConcurrency:1,timeoutMs:10000});
    await pool.run({type:'role_directories',rolesRoot:${JSON.stringify(root)}});
    const start=performance.now(); await pool.stop();
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({completed:true,stopMs:performance.now()-start}));`;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{stdio:"inherit",timeout:15000});
  assert.equal(child.error,undefined); assert.equal(child.status,0);
  const evidence=JSON.parse(fs.readFileSync(marker,"utf8")); assert.equal(evidence.completed,true);
  assert.ok(evidence.stopMs<5000); console.log(JSON.stringify({standaloneStopMs:evidence.stopMs}));
});

test("unknown events reuse reliable metadata; same-mtime replacement and watch error rehydrate",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.utimesSync(file,new Date("2026-01-01"),new Date("2026-01-01"));
  let changed:(event:fs.WatchEventType,name:string|null)=>void=()=>{};
  const watcher=Object.assign(new EventEmitter(),{close(){},unref(){return this;},ref(){return this;}});
  t.mock.method(fs,"watch",(_file:fs.PathLike,_options:unknown,listener:typeof changed)=>{changed=listener;return watcher;});
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  const reads=t.mock.method(fs,"readFileSync");
  changed("change",null);
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  assert.equal(reads.mock.callCount(),0,"an unchanged unknown event must not reread the body");
  for(const atomic of [false,true]) {
    const stat=fs.statSync(file); const content=JSON.stringify({...plan,focus:atomic?"two":"one"});
    if(atomic) {
      const replacement=path.join(root,"replacement.json"); fs.writeFileSync(replacement,content); fs.utimesSync(replacement,stat.atime,stat.mtime);
      fs.renameSync(replacement,file);
    } else {fs.writeFileSync(file,content);fs.utimesSync(file,stat.atime,stat.mtime);}
    assert.equal(fs.statSync(file).size,stat.size);
    assert.equal(fs.statSync(file).mtimeMs,stat.mtimeMs);
    changed("change",null);
    assert.equal((await readPlanPageCatalogInWorker(root,planReadFence(root)))[0]!.focus,atomic?"two":"one");
  }
  const before=reads.mock.callCount(); watcher.emit("error",new Error("synthetic watch overflow"));
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  assert.ok(reads.mock.callCount()>before,"watch errors force content hydration");
});

test("first-screen counts and page bypass an occupied catalog lane and preserve every count field",async t=>{
  const {root}=fixture();
  for(const bucket of ["recent","consolidated","consolidation-runs"]) {
    const directory=path.join(root,"memory",bucket);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,bucket==="consolidation-runs"?"sample.json":"sample.md"),"{}");
  }
  const childEvents=new EventEmitter();
  const child=Object.assign(childEvents,{pid:process.pid,exitCode:null,signalCode:null,connected:true,
    channel:{unref(){}},unref(){},disconnect(){},send(){return true;},kill(){childEvents.emit("close",0,"SIGTERM");return true;}}) as ManagerReadWorkerChild;
  const catalog=new ManagerReadWorkerPool({maxConcurrency:1,workerFactory:()=>child,setWorkerPriority:()=>{},timeoutMs:30000});
  const interactive=new ManagerReadWorkerPool({maxConcurrency:2,maxQueue:4,timeoutMs:10000});
  const occupied=catalog.run({type:"role_knowledge_file_counts",roleDir:root}).catch(error=>error);
  t.after(async()=>{await Promise.all([interactive.stop(),catalog.stop()]);await occupied;fs.rmSync(root,{recursive:true,force:true});});
  const input={cursor:"",limit:8,query:"",view:"current" as const,sort:"status" as const,statuses:[],tags:[],includeFacets:true,summary:true};
  const started=performance.now();
  const [counts,page]=await Promise.all([
    interactive.queryRoleFileCounts(root),
    interactive.queryRolePlanPage<{total:number}>(root,input)
  ]);
  assert.deepEqual(counts,{activePlans:1,archivedPlans:0,recentMemory:1,consolidatedMemory:1,consolidationRuns:1});
  assert.equal(page.total,1); assert.equal(catalog.status().active,1);
  console.log(JSON.stringify({firstScreenCountsAndPageMs:performance.now()-started}));
});

test("interactive plan file counts propagate metadata failure instead of reporting zero",async t=>{
  const {root}=fixture();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  t.mock.method(fs.promises,"stat",async()=>{throw Object.assign(new Error("synthetic permission failure"),{code:"EACCES"});});
  await assert.rejects(roleKnowledgeFileCountsInWorker(root),/synthetic permission failure/);
});

test("watch installation failure uses authoritative scan instead of a stale fast path",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  t.mock.method(fs,"watch",()=>{throw new Error("synthetic watch unavailable");});
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  fs.writeFileSync(file,JSON.stringify({...plan,focus:"different length external content"}));
  assert.equal((await readPlanPageCatalogInWorker(root,planReadFence(root)))[0]!.focus,"different length external content");
});

test("dirty-read failure is explicit and the next request can rebuild",async t=>{
  const {root,file,plan}=fixture(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await readPlanPageCatalogInWorker(root,planReadFence(root));
  fs.writeFileSync(file,JSON.stringify({...plan,focus:"after transient read failure"})); invalidatePlanReads(root,"sample");
  const read=t.mock.method(fs.promises,"readFile",async()=>{throw Object.assign(new Error("synthetic EACCES"),{code:"EACCES"});});
  await assert.rejects(readPlanPageCatalogInWorker(root,planReadFence(root)),/PLAN_CATALOG_REFRESH_UNAVAILABLE/);
  read.mock.restore();
  assert.equal((await readPlanPageCatalogInWorker(root,planReadFence(root)))[0]!.focus,"after transient read failure");
});
