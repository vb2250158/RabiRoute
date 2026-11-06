import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { terminalListSchema } from "../lib/interactive-protocol.mjs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { TerminalService } from "../lib/terminal-service.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 15000) { const end = Date.now() + timeoutMs; while(Date.now() < end){if(check())return;await delay(40);}throw new Error("Terminal fixture timed out."); }
const alive = pid => {try{process.kill(pid,0);return true;}catch{return false;}};
for(const shell of ["cmd","powershell"]) test(`${shell}: native session, Unicode, input receipts, query and owned exit`, {skip:process.platform!=="win32"}, async t=>{
  const events=[]; let sequence=1;
  const service=new TerminalService({defaultCwd:os.tmpdir(),emit:e=>events.push(e)});
  t.after(()=>service.stop());
  const terminalId=randomUUID();
  const session=await service.execute({action:"open",terminalId,shell});
  assert.match(service.sessions.get(terminalId).child.spawnfile,/RabiAgent\.Terminal\.exe$/,"the formal Windows entry uses the branded native host");
  assert.equal(session.state,"running");assert.equal(alive(session.pid),true);
  const openedAgain=await service.execute({action:"open",terminalId,shell});
  assert.equal(openedAgain.pid,session.pid);
  assert.equal((await service.execute({action:"list"})).sessions.length,1);
  const input=async data=>service.execute({action:"input",terminalId,sequence:sequence++,data});
  const command=shell==="cmd"?'echo TERM_\x32\x31\x37\x39\r':"[Console]::WriteLine('TERM_' + (2100+79))\r";
  await input(command);
  await waitFor(()=>events.map(e=>e.data||"").join("").includes("TERM_2179"));
  const receipt=await service.execute({action:"input",terminalId,sequence:1,data:command});
  assert.equal(receipt.nextInputSequence,2);
  await assert.rejects(service.execute({action:"input",terminalId,sequence:1,data:"changed"}),/conflict/);
  await service.execute({action:"resize",terminalId,cols:110,rows:30});
  if(shell==="powershell"){
    await input("[Console]::WriteLine([string][char]0x4e2d+[string][char]0x6587)\r");
    await waitFor(()=>events.map(e=>e.data||"").join("").includes("中文"));
    await input("[Console]::WriteLine('SLEEP_' + (500+12)); Start-Sleep 300\r");
    await waitFor(()=>events.map(e=>e.data||"").join("").includes("SLEEP_512"));
    const before=events.length;
    await input("\x03");
    await waitFor(()=>events.slice(before).map(e=>e.data||"").join("").includes(">"));
    await input("[Console]::WriteLine('AFTER_' + (90+7))\r");
    await waitFor(()=>events.map(e=>e.data||"").join("").includes("AFTER_97"));
  }
  const closed=await service.execute({action:"close",terminalId});
  assert.equal(closed.state,"exited");assert.equal(alive(session.pid),false);
  assert.equal((await service.execute({action:"get",terminalId})).state,"exited");
});

test("main-process death closes native hosts, shells and detached descendants", {skip:process.platform!=="win32"}, async t=>{
  const moduleUrl=new URL("../lib/terminal-service.mjs", import.meta.url).href;
  const descendant="$child=Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep 300' -WindowStyle Hidden -PassThru;[Console]::WriteLine(('DESC_'+$child.Id))";
  const encoded=Buffer.from(descendant,"utf16le").toString("base64");
  const fixture=`import {TerminalService} from ${JSON.stringify(moduleUrl)};import {randomUUID} from 'node:crypto';const id=randomUUID();let transcript='';let terminal;const service=new TerminalService({emit:e=>{transcript+=e.data||'';const match=transcript.match(/DESC_(\\d+)/);if(match&&terminal){console.log(JSON.stringify({pid:terminal.pid,descendant:Number(match[1]),host:service.sessions.get(id).child.pid}));transcript='';}}});terminal=await service.execute({action:'open',terminalId:id,shell:'cmd'});await service.execute({action:'input',terminalId:id,sequence:1,data:${JSON.stringify(`powershell.exe -NoProfile -EncodedCommand ${encoded}\r`)}});setInterval(()=>{},1000);`;
  const owner=spawn(process.execPath,["--input-type=module","-e",fixture],{cwd:packageRoot,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="";owner.stdout.on("data",data=>{output+=data;});
  owner.stderr.resume();const closed=new Promise(resolve=>owner.once("close",resolve));
  t.after(async()=>{if(alive(owner.pid))owner.kill();await closed;});
  // Startup includes the native host (up to 30 s), followed by two nested
  // PowerShell processes. Keep the separate post-kill cleanup deadline at 15 s.
  await waitFor(()=>output.includes('"descendant"'), 75000);
  const pids=JSON.parse(output.trim().split("\n")[0]);
  assert.equal(alive(pids.descendant),true);
  owner.kill("SIGKILL");await closed;
  await waitFor(()=>!alive(pids.pid)&&!alive(pids.descendant)&&!alive(pids.host));
});

test("active terminals are not rejected by an arbitrary count or history window",async()=>{
 const service=new TerminalService({defaultCwd:os.tmpdir(),emit:()=>{}});
 service.start=item=>{item.state="running";item.ready=Promise.resolve();};
 try{for(let i=0;i<70;i++)await service.execute({action:"open",terminalId:randomUUID(),shell:service.shells[0]});
 assert.equal(service.activeCount,70);assert.equal(service.sessions.size,70);
 const listed=await service.execute({action:"list"});
 const validate=new Ajv({strict:false}).compile(terminalListSchema);
 assert.equal(listed.sessions.length,70);
 assert.deepEqual(listed.sessions.map(item=>item.terminalId),[...service.sessions.keys()]);
 assert.equal(validate(listed),true,JSON.stringify(validate.errors));
 assert.equal(validate({...listed,sessions:[{...listed.sessions[0],terminalId:"invalid id"}]}),false,"session identities remain schema-validated");
 }finally{service.sessions.clear();}
});
test("archive failure retains original exited history without blocking a new terminal",async()=>{
 const service=new TerminalService({defaultCwd:os.tmpdir(),emit:()=>{}}),ids=[];
 service.start=item=>{item.state="running";item.ready=Promise.resolve();};
 service.history.save=async()=>{throw Object.assign(new Error("fixture archive unavailable"),{code:"ENOSPC"});};
 for(let i=0;i<64;i++){const id=randomUUID();ids.push(id);service.sessions.set(id,{id,shell:service.shells[0],cwd:os.tmpdir(),state:"exited",createdAt:new Date().toISOString(),nextInputSequence:1,inputs:new Map(),exitCode:0});}
 try{const created=await service.execute({action:"open",terminalId:randomUUID(),shell:service.shells[0]});assert.equal(created.state,"running");assert(ids.every(id=>service.sessions.has(id)));assert(service.historyDiagnostics.some(d=>d.code==="ENOSPC"));}finally{service.sessions.clear();}
});

for (const repeatedId of [false, true]) test(`terminal admission accepts 70 queued ${repeatedId ? "same-ID retries" : "independent opens"} without using the history threshold`, async t => {
  const service = new TerminalService({ defaultCwd: os.tmpdir(), emit: () => {} });
  let enter, release, reads = 0, starts = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  service.history.read = async () => { if (++reads === 1) { enter(); await gate; } return undefined; };
  service.start = item => { starts++; item.state = "running"; item.pid = starts; item.ready = Promise.resolve(); };
  t.after(async () => { release(); service.sessions.clear(); await service.stop(); });
  const sharedId = randomUUID();
  const ids = Array.from({ length: 70 }, () => repeatedId ? sharedId : randomUUID());
  const opening = Promise.allSettled(ids.map(terminalId => service.execute({ action: "open", terminalId, shell: service.shells[0] })));
  await entered;
  release();
  const results = await opening;
  assert.equal(results.filter(result => result.status === "rejected").length, 0, "the hot history window is not an admission limit");
  assert.equal(starts, repeatedId ? 1 : 70);
  assert.equal(service.pendingOpens, 0);
  if (repeatedId) assert.equal(new Set(results.map(result => result.value.pid)).size, 1, "all retries return the original owner");
});
