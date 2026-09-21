import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { readPlansFromStorageInWorker, readPlanPageCatalogInWorker, planPageReadDiagnostics } from "./roleKnowledge.js";
import { planReadFence, invalidatePlanReads } from "./planReadInvalidation.js";
import { presentPlans } from "./roleKnowledgePresentation.js";
import { paginateRolePlans } from "./roleKnowledgePagination.js";

// Opt-in synthetic storage only: never inspect a configured role directory.
test("synthetic 10001-plan page baseline and external mutation visibility", { skip: process.env.RABI_PLAN_BENCHMARK !== "1" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-page-benchmark-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = ensurePersonaPlanWorkflow(root).workflow;
  const active = path.join(root, "plans", "active");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(path.join(root, "plans", "archive"), { recursive: true });
  const count = process.env.RABI_PLAN_BENCHMARK_SMALL === "1" ? 1001 : 10001;
  const instrumented = process.env.RABI_PLAN_BENCHMARK_NO_PROBES !== "1";
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `synthetic-${String(i).padStart(5, "0")}`;
    const directory = path.join(active, id);
    fs.mkdirSync(directory);
    const file = path.join(directory, "plan.json");
    fs.writeFileSync(file, JSON.stringify({ id, title: id, focus: "synthetic baseline", status: "分析中", archiveStatus: "未归档", keywords: ["synthetic"], steps: [{ id: "step", title: "original" }], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
    files.push(file);
  }
  const stat = fs.statSync;
  const read = fs.readFileSync;
  let stats = 0;
  let reads = 0;
  let syncReadMs=0;
  if (instrumented) t.mock.method(fs, "statSync", (...args: Parameters<typeof stat>) => { stats++; return stat(...args); });
  if (instrumented) t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => { reads++; const started=performance.now(); try{return read(...args);}finally{syncReadMs+=performance.now()-started;} });
  let asyncStats=0, asyncReads=0, directories=0;
  const asyncStat=fs.promises.stat, asyncRead=fs.promises.readFile, asyncDirectory=fs.promises.readdir, directory=fs.readdirSync;
  if (instrumented) t.mock.method(fs.promises,"stat",(...args:Parameters<typeof asyncStat>)=>{asyncStats++;return asyncStat(...args);});
  if (instrumented) t.mock.method(fs.promises,"readFile",(...args:Parameters<typeof asyncRead>)=>{asyncReads++;return asyncRead(...args);});
  if (instrumented) t.mock.method(fs.promises,"readdir",(...args:Parameters<typeof asyncDirectory>)=>{directories++;return asyncDirectory(...args);});
  if (instrumented) t.mock.method(fs,"readdirSync",(...args:Parameters<typeof directory>)=>{directories++;return directory(...args);});
  const samples: Array<{ phase: string; ms: number; stats: number; reads: number; asyncStats:number; asyncReads:number; directories:number; reasons:string[]; fenceRevision:number; syncReadMs:number; catalogMs:number; presentationMs:number; paginationMs:number; reconciliation?:Record<string,number> }> = [];
  const fast = process.env.RABI_PLAN_FAST === "1";
  const presentations = new WeakMap<object, ReturnType<typeof presentPlans>>();
  async function page(phase: string, cursor = "", query = "") {
    stats = reads = asyncStats = asyncReads = directories = syncReadMs = 0;
    const start = performance.now();
    const plans = fast ? await readPlanPageCatalogInWorker(root, planReadFence(root)) : readPlansFromStorageInWorker(root);
    const catalogMs=performance.now()-start;
    const presentationStart=performance.now();
    let presented = fast ? presentations.get(plans) : undefined;
    if (!presented) { presented = presentPlans(plans, workflow); presentations.set(plans,presented); }
    const presentationMs=performance.now()-presentationStart;
    const paginationStart=performance.now();
    const result = paginateRolePlans(presented, cursor, 8, { query, includeFacets: true });
    const paginationMs=performance.now()-paginationStart;
    samples.push({ phase, ms: performance.now() - start, stats, reads, asyncStats, asyncReads, directories, reasons:planPageReadDiagnostics(root).reasons, fenceRevision:planReadFence(root).revision, syncReadMs, catalogMs, presentationMs, paginationMs, reconciliation:planPageReadDiagnostics(root).reconciliation });
    if(phase==="cold") console.log(JSON.stringify({coldDiagnostics:planPageReadDiagnostics(root)}));
    return result;
  }
  let result = await page("cold");
  assert.equal(result.total, count);
  for (let i = 0; i < 20; i++) result = await page("continuous", result.nextCursor);
  if (fast && count === 10001) for (let i = 0; i < 3; i++) {
    // Intentional workload spacing, not polling: exercise the reconciliation tail.
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal((await page("spaced-default-facets")).total, 10001);
  }
  const raw = JSON.parse(read(files[0]!, "utf8"));
  fs.writeFileSync(files[0]!, JSON.stringify({ ...raw, focus: "point-update-marker" }));
  if (fast) invalidatePlanReads(root,"synthetic-00000");
  assert.equal((await page("point-update", "", "point-update-marker")).total, 1);
  fs.unlinkSync(files[1]!);
  if (fast) invalidatePlanReads(root,"synthetic-00001");
  assert.equal((await page("delete")).total, count-1);
  const warm = samples.filter(sample => sample.phase === "continuous").map(sample => sample.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ plans: count, instrumented, samples, p50: warm[Math.floor(warm.length * .5)], p95: warm[Math.ceil(warm.length * .95) - 1] }));
});
