import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { VideoProjects } from "./projects.mjs";
import { WorkbenchRuns } from "./workbenchRuns.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-run-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=path.join(root,"output");await fs.mkdir(output);
  const binding={roots:{runtime:root,output,materials:output},tools:{node:{executable:process.execPath}}};
  const runtime={stateRoot:root,workbenchRuntimeRoot:path.join(root,"runtime"),machineId:"test-machine",generation:"test-generation",workbenchBindings:async()=>({workspaces:{test:binding}}),
    launchWorkbenchProcess(request,output){
      const child=spawn(request.executable,request.argv,{cwd:request.cwd,env:request.env,shell:false,windowsHide:true});
      child.stdout.on("data",chunk=>output("stdout",String(chunk)));child.stderr.on("data",chunk=>output("stderr",String(chunk)));
      const settled=new Promise(resolve=>child.once("close",code=>resolve({exitCode:code,terminated:true})));
      return{id:randomUUID(),settled,cancel:async()=>{child.kill();await settled;}};
    }};
  const projects=new VideoProjects(runtime),project=await projects.createProjectV2({id:randomUUID()}),canvas=await projects.readCanvas(project.id,project.defaultCanvasId);
  canvas.workspaceBindingKey="test";
  const owner=new WorkbenchRuns(runtime,projects,{jobs:new Map()},()=>{});t.after(()=>owner.close());
  const command=(id,text=id)=>({id,kind:"command",config:{toolKey:"node",argv:["-e",`require('fs').writeFileSync(${JSON.stringify(path.join(output,`${id}.txt`))},${JSON.stringify(text)})`]},requirements:[{key:"result",root:"output",path:`${id}.txt`,type:"file",freshness:"produced",required:true}]});
  const edge=(from,to,condition="success")=>({id:randomUUID(),from,to,fromPort:"control",toPort:"control",condition});
  async function run(nodes,edges=[],options={}) {
    const current=await projects.readCanvas(project.id,canvas.id),saved=await projects.saveCanvas(project.id,canvas.id,{...current,workspaceBindingKey:"test",graph:{nodes,edges,groups:[]}});
    const body={id:randomUUID(),revision:saved.revision,...options};
    const record=await owner.start(project.id,canvas.id,body);await owner.flights.get(record.id);return owner.read(record.id);
  }
  return{root,output,owner,projects,project,canvas,run,command,edge};
}
test("real command completion requires every produced artifact, not exit zero or an old file",async t=>{
  const f=await fixture(t),node=f.command("a");
  let run=await f.run([node]);assert.equal(run.state,"succeeded");assert.equal(run.attempts.a.artifacts[0].bytes,1);
  run=await f.run([node]);assert.equal(run.state,"completed_with_errors");assert.match(run.attempts.a.reason,/产物校验失败/);
  const missing={...f.command("b"),requirements:[...f.command("b").requirements,{key:"absent",root:"output",path:"missing.txt",freshness:"produced"}]};
  run=await f.run([missing]);assert.equal(run.state,"completed_with_errors");assert.match(run.attempts.b.reason,/absent/);
});
test("diamond joins, non-gate completed edges and mandatory gate failure use one scheduler",async t=>{
  const f=await fixture(t);
  let run=await f.run([f.command("a"),f.command("b"),f.command("c"),f.command("d")],[f.edge("a","b"),f.edge("a","c"),f.edge("b","d"),f.edge("c","d")]);
  assert.equal(run.state,"succeeded");assert.ok(run.attempts.d.startedAt>=run.attempts.c.finishedAt);
  const fail={id:"bad",kind:"command",config:{toolKey:"node",argv:["-e","process.exit(1)"]}};
  run=await f.run([fail,f.command("diagnostic")],[f.edge("bad","diagnostic","completed")]);assert.equal(run.state,"completed_with_errors");assert.equal(run.attempts.diagnostic.state,"succeeded");
  run=await f.run([{...fail,gate:true},f.command("stopped")],[f.edge("bad","stopped","completed")]);assert.equal(run.state,"failed");assert.equal(run.attempts.stopped.state,"blocked");
});
test("resume reuses matching evidence and invalidates changed nodes and their descendants",async t=>{
  const f=await fixture(t),nodes=[f.command("a"),f.command("b")],edges=[f.edge("a","b")];
  const original=await f.run(nodes,edges),resumed=await f.run(nodes,edges,{resumeRunId:original.id});
  assert.equal(resumed.state,"succeeded");assert.equal(resumed.attempts.a.reusedFromAttemptId,original.attempts.a.id);assert.equal(resumed.attempts.b.reusedFromAttemptId,original.attempts.b.id);
  const changed=await f.run([f.command("a","changed"),f.command("b","changed too")],edges,{resumeRunId:resumed.id});
  assert.equal(changed.state,"succeeded");assert.equal(changed.attempts.b.reusedFromAttemptId,undefined);
});
test("double submission is idempotent and a waiting run retains its resource lease",async t=>{
  const f=await fixture(t),saved=await f.projects.saveCanvas(f.project.id,f.canvas.id,{...f.canvas,graph:{nodes:[{id:"human",kind:"human",config:{}}],edges:[],groups:[]}}),body={id:randomUUID(),revision:saved.revision};
  const first=await f.owner.start(f.project.id,f.canvas.id,body);await f.owner.flights.get(first.id);
  assert.equal((await f.owner.start(f.project.id,f.canvas.id,body)).id,first.id);
  await assert.rejects(f.owner.start(f.project.id,f.canvas.id,{...body,id:randomUUID()}),error=>error.status===409);
  const before=await f.owner.read(first.id);assert.equal(before.state,"waiting_human");
  await f.owner.completeHuman(first.id,{nodeId:"human",attemptId:before.attempts.human.id,identity:"reviewer",evidence:{review:"approved"}});await f.owner.flights.get(first.id);
  assert.equal((await f.owner.read(first.id)).state,"succeeded");
});
test("restart preserves unknown execution locks instead of rerunning",async t=>{
  const f=await fixture(t),run=await f.run([{id:"agent",kind:"agent",config:{target:{provider:"test",sessionId:"original"}}}]);
  assert.equal(run.state,"waiting_agent");
  const next=new WorkbenchRuns(f.owner.runtime,f.projects,{jobs:new Map()},()=>{});await next.initialize();
  assert.equal((await next.read(run.id)).state,"interrupted");
  await assert.rejects(next.start(f.project.id,f.canvas.id,{id:randomUUID(),revision:run.canvasRevision}),error=>error.status===409);
});
test("Agent delivery uncertainty queries the same request and requires a formal completion",async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.output,"brief.txt"),"示例任务书");let sends=0,completed=false,requestId;
  f.owner.runtime.agentTasks={send:async request=>{sends++;requestId=request.deliveryId;assert.equal(request.threadId,"exact-task");throw new Error("response lost");},inspect:async id=>{
    assert.equal(id,requestId);return completed?{deliveryId:"native-receipt",request:{id:"native-request",status:"responded",response:{by:{threadId:"exact-task",agentAdapter:"test"},result:JSON.stringify({status:"succeeded"})}}}:{state:"accepted",request:{status:"awaiting_response"}};
  }};
  const run=await f.run([{id:"agent",kind:"agent",config:{target:{threadId:"exact-task",agentAdapter:"test"},source:{sourceThreadId:"source",sourceAgentType:"codex",threadId:"must-not-override-target"},briefRef:{root:"output",path:"brief.txt"}}}]);
  assert.equal(run.state,"running");assert.equal(sends,1);
  await f.owner.refresh(run.id);await f.owner.flights.get(run.id);assert.equal(sends,1);
  completed=true;await f.owner.refresh(run.id);await f.owner.flights.get(run.id);
  assert.equal((await f.owner.read(run.id)).state,"succeeded");assert.equal(sends,1);
});
test("cancellation waits for real command exit and keeps the durable result",async t=>{
  const f=await fixture(t),saved=await f.projects.saveCanvas(f.project.id,f.canvas.id,{...f.canvas,graph:{nodes:[{id:"long",kind:"command",config:{toolKey:"node",argv:["-e","setTimeout(()=>{},60000)"]}}],edges:[],groups:[]}});
  const run=await f.owner.start(f.project.id,f.canvas.id,{id:randomUUID(),revision:saved.revision});
  for(let tries=0;tries<50&&!f.owner.processes.size;tries++)await new Promise(resolve=>setTimeout(resolve,10));
  const stopped=await f.owner.cancel(run.id);await f.owner.flights.get(run.id);
  assert.equal(stopped.state,"cancelled");assert.equal((await f.owner.read(run.id)).state,"cancelled");
});
test("explicit concurrency overlaps independent branches while shared resource keys serialize",async t=>{
  const f=await fixture(t);let active=0,maximum=0;const launch=f.owner.runtime.launchWorkbenchProcess;
  f.owner.runtime.launchWorkbenchProcess=(...args)=>{active++;maximum=Math.max(active,maximum);const process=launch(...args);process.settled.finally(()=>active--);return process;};
  const nodes=["a","b","c"].map(id=>({id,kind:"command",resourceKey:id==="c"?"other":"shared",config:{toolKey:"node",argv:["-e","setTimeout(()=>{},100)"]}}));
  const result=await f.run(nodes,[],{concurrency:3});assert.equal(result.state,"succeeded");assert.equal(maximum,2);assert.ok(result.attempts.b.startedAt>=result.attempts.a.finishedAt);
});
test("a new command template executes by changing definition data only",async t=>{
  const f=await fixture(t),command=f.command("templated");f.projects.definition=structuredClone(f.projects.definition);
  f.projects.definition.templates.push({id:"example-command",version:1,kind:"command",config:command.config,requirements:command.requirements});
  const result=await f.run([{id:"template-instance",kind:"command",template:{id:"example-command",version:1},config:{}}]);
  assert.equal(result.state,"succeeded");assert.equal(result.snapshot.graph.nodes[0].config.toolKey,"node");
});
test("generate nodes dispatch once through the original media job owner and await its completion",async t=>{
  const f=await fixture(t);let submissions=0;
  f.owner.media.catalog={states:{queued:{terminal:false},succeeded:{terminal:true}}};
  f.owner.media.submit=async()=>{submissions++;const job={id:randomUUID(),status:"queued"};f.owner.media.jobs.set(job.id,job);setTimeout(()=>{job.status="succeeded";f.owner.onMediaChanged(job.id);},20);return job;};
  const result=await f.run([{id:"generate",kind:"generate",config:{command:{model:"fixture",prompt:"example"}}}]);
  assert.equal(result.state,"succeeded");assert.equal(submissions,1);assert.ok(result.attempts.generate.receipt.jobId);
});
test("environment references are redacted across stdout chunk boundaries",async t=>{
  const f=await fixture(t),secret="fixture-only-value-that-must-not-be-logged",previous=process.env.WORKBENCH_TEST_SECRET;
  process.env.WORKBENCH_TEST_SECRET=secret;t.after(()=>{if(previous===undefined)delete process.env.WORKBENCH_TEST_SECRET;else process.env.WORKBENCH_TEST_SECRET=previous;});
  const binding=(await f.owner.runtime.workbenchBindings()).workspaces.test;binding.tools.node.envRefs={WORKBENCH_TEST_SECRET:"WORKBENCH_TEST_SECRET"};
  const run=await f.run([{id:"log",kind:"command",config:{toolKey:"node",argv:["-e","const value=process.env.WORKBENCH_TEST_SECRET;process.stdout.write(value.slice(0,10));setTimeout(()=>console.log(value.slice(10)),10)"]}}]);
  assert.equal(run.state,"succeeded");const logs=await f.owner.logs(run.id);const text=logs.entries.map(row=>row.text).join("\n");assert.ok(!text.includes(secret));assert.match(text,/redacted/);
});
test("an unreadable original run is isolated without releasing its resource lock",async t=>{
  const f=await fixture(t),run=await f.run([{id:"agent",kind:"agent",config:{}}]);
  await fs.writeFile(f.owner.file(run.id),"{broken record");
  const recovered=new WorkbenchRuns(f.owner.runtime,f.projects,{jobs:new Map()},()=>{});await recovered.initialize();
  assert.ok(recovered.recordIssues.some(issue=>issue.id===run.id));
  await assert.rejects(recovered.read(run.id),error=>error.status===409);
  await assert.rejects(recovered.start(f.project.id,f.canvas.id,{id:randomUUID(),revision:run.canvasRevision}),error=>error.status===409);
});
