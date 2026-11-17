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
  async function start(nodes,edges=[],options={},access) {
    const current=await projects.readCanvas(project.id,canvas.id),saved=await projects.saveCanvas(project.id,canvas.id,{...current,workspaceBindingKey:"test",graph:{nodes,edges,groups:[]}});
    const body={id:randomUUID(),revision:saved.revision,...options};
    return owner.start(project.id,canvas.id,body,access);
  }
  async function run(...args) {
    const record=await start(...args);await owner.flights.get(record.id);return owner.read(record.id);
  }
  return{root,output,owner,projects,project,canvas,start,run,command,edge};
}
function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return{promise,resolve};
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
test("cancellation during asynchronous preparation prevents every undispatched side effect",async t=>{
  for(const boundary of ["input fingerprint","artifact baseline","command validation","running persistence","agent brief","agent persistence","media persistence"])await t.test(boundary,async t=>{
    const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());
    let launches=0,sends=0,submissions=0,paused=false;
    f.owner.runtime.launchWorkbenchProcess=()=>{launches++;return{id:randomUUID(),settled:Promise.resolve({exitCode:0}),cancel:async()=>{}};};
    f.owner.runtime.agentTasks={send:async()=>{sends++;return{};},inspect:async()=>({request:{status:"awaiting_response"}})};
    f.owner.media.submit=async()=>{submissions++;return{id:"unexpected-job",status:"succeeded"};};
    f.owner.media.jobs.set("unexpected-job",{id:"unexpected-job",status:"succeeded"});
    const pause=async()=>{paused=true;entered.resolve();await resume.promise;};
    const node={id:"work",kind:"command",config:{toolKey:"node",argv:[]}};
    const input=path.join(f.output,"input.txt");await fs.writeFile(input,"fixture input");
    const canonicalInput=await fs.realpath(input);
    if(boundary==="input fingerprint" || boundary==="artifact baseline") {
      if(boundary==="input fingerprint")node.inputs=[{ref:{root:"output",path:"input.txt"}}];
      else node.requirements=[{key:"existing",root:"output",path:"input.txt",freshness:"reused"}];
      const open=fs.open;let reads=0;
      t.mock.method(fs,"open",async(file,...args)=>{
        if(file===canonicalInput && ++reads===(boundary==="input fingerprint"?2:1))await pause();
        return open(file,...args);
      });
    }
    if(boundary==="command validation")f.owner.runtime.validateWorkbenchExecutable=pause;
    if(boundary.startsWith("agent")) {
      node.kind="agent";node.config={target:{threadId:"original-target",agentAdapter:"test"},source:{sourceThreadId:"source",sourceAgentType:"codex"},briefRef:{root:"output",path:"input.txt"}};
      if(boundary==="agent brief") {
        const readFile=fs.readFile;
        t.mock.method(fs,"readFile",async(file,...args)=>{if(file===canonicalInput&&!paused)await pause();return readFile(file,...args);});
      }
    }
    if(boundary==="media persistence") {node.kind="generate";node.config={command:{model:"fixture",prompt:"example"}};}
    if(boundary.endsWith("persistence")) {
      const persist=f.owner.persist.bind(f.owner);
      f.owner.persist=async run=>{
        await persist(run);
        const attempt=run.attempts.work;
        const matches=boundary==="agent persistence"?attempt.dispatchStarted:boundary==="media persistence"?attempt.mediaRequestStarted:attempt.state==="running";
        if(matches&&!paused)await pause();
      };
    }
    const run=await f.start([node]);await entered.promise;
    await f.owner.cancel(run.id);resume.resolve();await f.owner.flights.get(run.id);
    assert.deepEqual({launches,sends,submissions},{launches:0,sends:0,submissions:0});
    const stopped=await f.owner.read(run.id);assert.equal(stopped.state,"cancelled");assert.equal(stopped.attempts.work.state,"cancelled");
    assert.ok(!stopped.attempts.work.uncertain);
    assert.deepEqual(await fs.readdir(path.join(f.owner.root,"locks")),[]);
  });
});
test("cancel returns while original Agent and media submissions are in flight and retains their locks",async t=>{
  for(const kind of ["agent","generate"])await t.test(kind,async t=>{
    const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());
    let completed=false,calls=0;
    const node={id:"work",kind,config:{}};
    if(kind==="agent") {
      await fs.writeFile(path.join(f.output,"brief.txt"),"fixture brief");
      node.config={target:{threadId:"original-target",agentAdapter:"test"},source:{sourceThreadId:"source",sourceAgentType:"codex"},briefRef:{root:"output",path:"brief.txt"}};
      f.owner.runtime.agentTasks={send:async()=>{calls++;entered.resolve();await resume.promise;return{};},inspect:async()=>({request:{status:completed?"responded":"awaiting_response"}})};
    } else {
      node.config={command:{model:"fixture",prompt:"example"}};
      f.owner.media.catalog={states:{running:{terminal:false},succeeded:{terminal:true}}};
      f.owner.media.submit=async()=>{calls++;entered.resolve();await resume.promise;const job={id:"original-job",status:"running"};f.owner.media.jobs.set(job.id,job);return job;};
      f.owner.media.cancel=async()=>{throw Object.assign(new Error("original job is running"),{status:409});};
    }
    const run=await f.start([node]);await entered.promise;
    assert.equal((await f.owner.cancel(run.id)).state,"cancelling");
    assert.ok((await fs.readdir(path.join(f.owner.root,"locks"))).length>0);
    await assert.rejects(f.owner.start(f.project.id,f.canvas.id,{id:randomUUID(),revision:run.canvasRevision}),error=>error.status===409);
    resume.resolve();
    if(kind==="agent") {
      await f.owner.flights.get(run.id);completed=true;await f.owner.refresh(run.id);
    } else {
      while(!f.owner.media.jobs.has("original-job"))await new Promise(resolve=>setImmediate(resolve));
      assert.equal((await f.owner.read(run.id)).state,"cancelling");
      f.owner.media.jobs.get("original-job").status="succeeded";f.owner.onMediaChanged("original-job");await f.owner.flights.get(run.id);await f.owner.refresh(run.id);
    }
    assert.equal(calls,1);assert.equal((await f.owner.read(run.id)).state,"cancelled");
    assert.deepEqual(await fs.readdir(path.join(f.owner.root,"locks")),[]);
  });
});
test("queued or preparing starts recheck authorization and owner availability before durable acceptance",async t=>{
  for(const boundary of ["queued","bindings","input fingerprint","lock persistence"])for(const restriction of ["revoked","readOnly","closing"])await t.test(`${boundary} ${restriction}`,async t=>{
    const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());
    let revoked=false,blocked=false;
    const access={assert(){},beforeMutation(){if(revoked)throw Object.assign(new Error("fixture authorization revoked"),{status:403});}};
    if(boundary==="queued")f.owner.serial=resume.promise;
    if(boundary==="bindings") {
      const bindings=f.owner.runtime.workbenchBindings;
      f.owner.runtime.workbenchBindings=async()=>{entered.resolve();await resume.promise;return bindings();};
    }
    if(boundary==="lock persistence") {
      const atomic=f.owner.atomic.bind(f.owner);
      f.owner.atomic=async(file,value)=>{await atomic(file,value);if(file.endsWith(`${path.sep}owner.json`)&&!blocked){blocked=true;entered.resolve();await resume.promise;}};
    }
    const node={id:"human",kind:"human",config:{}};
    if(boundary==="input fingerprint") {
      const file=path.join(f.output,"input.txt");await fs.writeFile(file,"fixture input");const canonicalFile=await fs.realpath(file),open=fs.open;
      node.inputs=[{ref:{root:"output",path:"input.txt"}}];
      t.mock.method(fs,"open",async(file,...args)=>{if(file===canonicalFile&&!blocked){blocked=true;entered.resolve();await resume.promise;}return open(file,...args);});
    }
    const current=await f.projects.saveCanvas(f.project.id,f.canvas.id,{...f.canvas,graph:{nodes:[node],edges:[],groups:[]}});
    const id=randomUUID(),pending=f.owner.start(f.project.id,f.canvas.id,{id,revision:current.revision},access);
    const rejected=assert.rejects(pending,error=>error.status===(restriction==="revoked"?403:423));
    if(boundary!=="queued")await entered.promise;
    if(restriction==="revoked")revoked=true;
    else if(restriction==="readOnly")f.owner.runtime.readOnly=true;
    else f.owner.closing=true;
    resume.resolve();await rejected;
    assert.ok(!f.owner.runs.has(id));
    await assert.rejects(fs.stat(f.owner.file(id)),error=>error.code==="ENOENT");
    assert.deepEqual(await fs.readdir(path.join(f.owner.root,"locks")).catch(error=>{if(error.code==="ENOENT")return[];throw error;}),[]);
  });
});
test("an accepted background run retains its original authorization after the requesting client is revoked",async t=>{
  const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());let revoked=false,launches=0;
  const access={assert(){if(revoked)throw new Error("fixture client revoked");},beforeMutation(){this.assert();}};
  f.owner.runtime.validateWorkbenchExecutable=async()=>{entered.resolve();await resume.promise;};
  f.owner.runtime.launchWorkbenchProcess=()=>{launches++;return{id:randomUUID(),settled:Promise.resolve({exitCode:0}),cancel:async()=>{}};};
  const run=await f.start([{id:"work",kind:"command",config:{toolKey:"node",argv:[]}}],[],{},access);
  await entered.promise;revoked=true;resume.resolve();await f.owner.flights.get(run.id);
  assert.equal(launches,1);assert.equal((await f.owner.read(run.id)).state,"succeeded");
});
test("close reconciles a cancelled in-flight media submission with the original job without waiting for generation",async t=>{
  for(const cancellable of [true,false])await t.test(cancellable?"queued cancellation confirmed":"running cancellation unconfirmed",async t=>{
    const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());let submissions=0,cancellations=0;
    f.owner.media.catalog={states:{queued:{terminal:false},running:{terminal:false},cancelled:{terminal:true},succeeded:{terminal:true}}};
    f.owner.media.submit=async()=>{
      submissions++;entered.resolve();await resume.promise;
      const job={id:"original-job",status:cancellable?"queued":"running"};f.owner.media.jobs.set(job.id,job);return job;
    };
    f.owner.media.cancel=async id=>{
      assert.equal(id,"original-job");cancellations++;
      if(!cancellable)throw Object.assign(new Error("original media job already running"),{status:409});
      const job=f.owner.media.jobs.get(id);job.status="cancelled";return job;
    };
    const run=await f.start([{id:"work",kind:"generate",config:{command:{model:"fixture",prompt:"example"}}}]);await entered.promise;
    await f.owner.cancel(run.id);
    const uncertainDuringSubmit=(await f.owner.read(run.id)).attempts.work.uncertain;
    const closing=f.owner.close();resume.resolve();let timer;
    const closed=await Promise.race([closing.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);clearTimeout(timer);
    const beforeCompletion=await f.owner.read(run.id),locksBeforeCompletion=await fs.readdir(path.join(f.owner.root,"locks"));
    // Release the controlled owner even when the old implementation still waits for natural completion.
    f.owner.media.jobs.get("original-job").status="succeeded";f.owner.onMediaChanged("original-job");await closing;await f.owner.refresh(run.id);
    assert.equal(uncertainDuringSubmit,true);assert.equal(closed,true);assert.equal(submissions,1);assert.equal(cancellations,1);
    assert.equal(beforeCompletion.state,cancellable?"cancelled":"cancelling");
    assert.equal(Boolean(beforeCompletion.attempts.work.uncertain),!cancellable);
    assert.equal(locksBeforeCompletion.length>0,!cancellable);
    assert.equal((await f.owner.read(run.id)).state,"cancelled");assert.deepEqual(await fs.readdir(path.join(f.owner.root,"locks")),[]);
  });
});
test("cancelled media submissions preserve unknown receipts and release confirmed rejections",async t=>{
  for(const knownRejected of [false,true])await t.test(knownRejected?"confirmed rejection":"unknown receipt",async t=>{
    const f=await fixture(t),entered=deferred(),resume=deferred();t.after(()=>resume.resolve());let submissions=0;
    f.owner.media.submit=async()=>{submissions++;entered.resolve();await resume.promise;throw Object.assign(new Error("fixture submission outcome"),knownRejected?{status:503}:{});};
    const run=await f.start([{id:"work",kind:"generate",config:{command:{model:"fixture",prompt:"example"}}}]);await entered.promise;
    await f.owner.cancel(run.id);resume.resolve();await f.owner.close();await f.owner.refresh(run.id);
    const stopped=await f.owner.read(run.id);assert.equal(submissions,1);assert.equal(stopped.state,knownRejected?"cancelled":"cancelling");
    assert.equal(Boolean(stopped.attempts.work.uncertain),!knownRejected);
    assert.equal((await fs.readdir(path.join(f.owner.root,"locks"))).length>0,!knownRejected);
  });
});
test("cancellation of an already accepted media job ends this run's waiter while its original job retains the lease",async t=>{
  const f=await fixture(t),entered=deferred();let cancellations=0;
  f.owner.media.catalog={states:{running:{terminal:false},succeeded:{terminal:true}}};
  f.owner.media.submit=async()=>{const job={id:"original-job",status:"running"};f.owner.media.jobs.set(job.id,job);return job;};
  f.owner.media.cancel=async()=>{cancellations++;throw Object.assign(new Error("original job is running"),{status:409});};
  const waitForMedia=f.owner.waitForMedia.bind(f.owner);
  f.owner.waitForMedia=(...args)=>{const waiting=waitForMedia(...args);entered.resolve();return waiting;};
  const run=await f.start([{id:"work",kind:"generate",config:{command:{model:"fixture",prompt:"example"}}}]);await entered.promise;
  await f.owner.cancel(run.id);await f.owner.flights.get(run.id);
  assert.equal(cancellations,1);assert.equal((await f.owner.read(run.id)).state,"cancelling");assert.equal(f.owner.mediaWaiters.size,0);
  assert.ok((await fs.readdir(path.join(f.owner.root,"locks"))).length>0);
  f.owner.media.jobs.get("original-job").status="succeeded";await f.owner.refresh(run.id);
  assert.equal((await f.owner.read(run.id)).state,"cancelled");assert.deepEqual(await fs.readdir(path.join(f.owner.root,"locks")),[]);
});
test("cancelling one canvas isolates its waiter while other canvases observe the original shared media job",async t=>{
  for(const cancellable of [false,true])await t.test(cancellable?"shared job reaches cancelled":"shared job remains running",async t=>{
    const f=await fixture(t),bothWaiting=deferred();let waits=0,cancellations=0;
    const job={id:"shared-job",status:cancellable?"queued":"running"};f.owner.media.jobs.set(job.id,job);
    f.owner.media.catalog={states:{queued:{terminal:false},running:{terminal:false},cancelled:{terminal:true},succeeded:{terminal:true}}};
    f.owner.media.cancel=async id=>{
      assert.equal(id,job.id);cancellations++;
      if(!cancellable)throw Object.assign(new Error("original shared job is running"),{status:409});
      job.status="cancelled";return job;
    };
    const waitForMedia=f.owner.waitForMedia.bind(f.owner);
    f.owner.waitForMedia=(...args)=>{const waiting=waitForMedia(...args);if(++waits===2)bothWaiting.resolve();return waiting;};
    const nodes=[{id:"work",kind:"generate",config:{jobId:job.id}}],first=await f.start(nodes);
    const canvas=await f.projects.createCanvas(f.project.id,{id:randomUUID(),name:"Second observer"});
    const saved=await f.projects.saveCanvas(f.project.id,canvas.id,{...canvas,workspaceBindingKey:"test",graph:{nodes,edges:[],groups:[]}});
    const second=await f.owner.start(f.project.id,canvas.id,{id:randomUUID(),revision:saved.revision});await bothWaiting.promise;
    const secondFlight=f.owner.flights.get(second.id);
    await f.owner.cancel(first.id);await f.owner.flights.get(first.id);
    const beforeCompletion=await f.owner.read(second.id),remainingWaiters=f.owner.mediaWaiters.get(job.id)?.size||0;
    if(!cancellable){job.status="succeeded";f.owner.onMediaChanged(job.id);}
    await secondFlight;await f.owner.refresh(first.id);
    assert.equal(cancellations,1);
    if(!cancellable){assert.equal(beforeCompletion.attempts.work.state,"running");assert.equal(remainingWaiters,1);}
    const completed=await f.owner.read(second.id);assert.equal(completed.state,cancellable?"completed_with_errors":"succeeded");
    assert.equal((await f.owner.read(first.id)).state,"cancelled");assert.equal(f.owner.mediaWaiters.size,0);
  });
});

test('event retry reuses one dated canvas and the accepted original run',async t=>{
 const f=await fixture(t),current=await f.projects.readCanvas(f.project.id,f.canvas.id);
 await f.projects.saveCanvas(f.project.id,f.canvas.id,{...current,workspaceBindingKey:'test',graph:{nodes:[{id:'human',kind:'human',config:{}}],edges:[],groups:[]}});
 const body={id:randomUUID(),date:'2026-11-17'};
 const first=await f.owner.trigger(f.project.id,f.canvas.id,body);await f.owner.flights.get(first.run.id);
 const again=await f.owner.trigger(f.project.id,f.canvas.id,body);assert.equal(again.run.id,first.run.id);assert.equal(again.trigger.canvasId,first.trigger.canvasId);assert.notEqual(first.trigger.canvasId,f.canvas.id);
 await assert.rejects(f.owner.trigger(f.project.id,f.canvas.id,{...body,date:'2026-11-18'}),error=>error.status===409);
 const copied=await f.projects.readCanvas(f.project.id,first.trigger.canvasId);assert.equal(copied.variables.find(row=>row.name==='date').value,'2026-11-17');
});

test('until boundary executes its complete dependency closure and excludes later side effects',async t=>{
 const f=await fixture(t),run=await f.run([f.command('a'),f.command('b'),f.command('later')],[f.edge('a','b'),f.edge('b','later')],{untilNodeId:'b'});
 assert.equal(run.state,'succeeded');assert.deepEqual(run.selected,['b','a']);assert.equal(run.attempts.later,undefined);await assert.rejects(fs.stat(path.join(f.output,'later.txt')),error=>error.code==='ENOENT');
});

test('trusted check document overrides reach the command and preserve unrelated configuration',async t=>{
 const f=await fixture(t),file=path.join(f.output,'checks.json');await fs.writeFile(file,JSON.stringify({group:{items:[{key:'limit',limit:1},{key:'other',limit:9}]}}));
 const original=f.owner.runtime.workbenchBindings;f.owner.runtime.workbenchBindings=async()=>{const value=await original();value.workspaces.test.parameterDocuments={checks:{ref:{root:'output',path:'checks.json'},group:'group'}};return value;};
 const node={id:'check',kind:'command',config:{toolKey:'node',argv:['-e',"const d=JSON.parse(require('fs').readFileSync("+JSON.stringify(file)+",'utf8'));if(d.group.items[0].limit!==3)process.exit(8)"],parameterSchema:[{name:'limit',type:'number',kind:'check',default:1,min:1,max:5}],parameterValues:{limit:3},checkParameterSink:'checks'}};
 const run=await f.run([node]);assert.equal(run.state,'succeeded');const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.group.items[0].limit,3);assert.equal(saved.group.items[1].limit,9);assert.ok(run.attempts.check.parameterDocument.sha256);
});
test('agent binding and structured context deliver only declared fields from the selected input',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.output,'brief.txt'),'Task for this edition');await fs.writeFile(path.join(f.output,'input.json'),JSON.stringify({picks:[{subject:'subject',number:'42',ignored:'must-not-project'}]}));
 const original=f.owner.runtime.workbenchBindings;f.owner.runtime.workbenchBindings=async()=>{const value=await original();value.workspaces.test.agents={reviewer:{target:{agentAdapter:'test',threadId:'original-reviewer'},source:{sourceAgentType:'codex',sourceThreadId:'original-source'}}};return value;};
 let observed;
 f.owner.runtime.agentTasks={send:async req=>{observed=req;return{};},inspect:async()=>({request:{id:'request',status:'responded',response:{by:{threadId:'original-reviewer',agentAdapter:'test'},result:JSON.stringify({status:'succeeded'})}}})};
 const run=await f.run([{id:'agent',kind:'agent',config:{agentBindingKey:'reviewer',briefRef:{root:'output',path:'brief.txt'},contextProjection:{ref:{root:'output',path:'input.json'},list:'picks',fields:['subject','number']}}}]);
 assert.equal(run.state,'succeeded');assert.equal(observed.threadId,'original-reviewer');assert.match(observed.prompt,/42/);assert.doesNotMatch(observed.prompt,/must-not-project/);
});

test('formal Agent events resume the original request and retirement drains the subscription',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.output,'event-brief.txt'),'event-driven task');
 const queued=[],finished=deferred();let wake,closed=false,completed=false,sends=0;
 const push=event=>{queued.push(event);wake?.();wake=undefined;};
 f.owner.runtime.agentTasks={events:()=>({frames:(async function*(){while(!closed){if(queued.length)yield queued.shift();else await new Promise(resolve=>{wake=resolve;});}})(),cancel(){closed=true;wake?.();}}),send:async()=>{sends++;return{};},inspect:async()=>({request:completed?{id:'original',status:'responded',response:{by:{threadId:'target',agentAdapter:'test'},result:JSON.stringify({status:'succeeded'})}}:{status:'awaiting_response'}})};
 f.owner.publish=(_name,event)=>{if(event.state==='succeeded')finished.resolve();};f.owner.observeAgentEvents();
 const run=await f.run([{id:'agent',kind:'agent',config:{target:{threadId:'target',agentAdapter:'test'},source:{sourceThreadId:'source',sourceAgentType:'codex'},briefRef:{root:'output',path:'event-brief.txt'}}}]);
 assert.equal(run.state,'running');completed=true;push({event:'agent_requests_changed',data:{requestId:'original'}});
 let timer;try{await Promise.race([finished.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('completion event did not resume graph')),2000);})]);}finally{clearTimeout(timer);}
 assert.equal((await f.owner.read(run.id)).state,'succeeded');assert.equal(sends,1);
 await f.owner.close();assert.equal(closed,true);assert.equal(f.owner.agentEventFlight,undefined);
});

test("environment references redact multiline values and longer overlapping secrets first", async t => {
  const f = await fixture(t);
  const values = { WORKBENCH_TEST_SHORT: "fixture-prefix", WORKBENCH_TEST_LONG: "fixture-prefix-extended", WORKBENCH_TEST_MULTILINE: "fixture-first-line\nfixture-second-line" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const binding = (await f.owner.runtime.workbenchBindings()).workspaces.test;
  binding.tools.node.envRefs = Object.fromEntries(Object.keys(values).map(key => [key, key]));
  const result = await f.run([{ id: "multiline-log", kind: "command", config: { toolKey: "node", argv: ["-e", "console.log(process.env.WORKBENCH_TEST_LONG);console.log(process.env.WORKBENCH_TEST_MULTILINE)"] } }]);
  assert.equal(result.state, "succeeded");
  const logs = await f.owner.logs(result.id);
  assert.equal(logs.entries.filter(row => row.stream === "stdout").map(row => row.text).join("\n"), "[redacted]\n[redacted]\n[redacted]");
});
