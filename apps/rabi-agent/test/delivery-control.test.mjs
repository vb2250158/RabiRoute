import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { __test } from "../rabi-agent.mjs";
import { requestDeliveryControl, submitDeliveryToOwner } from "../lib/delivery-control.mjs";
import { createManagerClient } from "../lib/manager-client.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 8000; while (Date.now() < deadline) { if (await check()) return; await delay(20); } throw new Error("Delivery fixture timed out"); }

test("short CLI submits through the existing authenticated launcher; the same owner resumes disk intents after restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-control-"));
  const configPath = path.join(root, "config.json"), entry = path.join(root, "worker.mjs"), marker = path.join(root, "ready"), online = path.join(root, "online");
  const catalogOnline = path.join(root, "catalog-online");
  fs.writeFileSync(catalogOnline, "fixture catalogue available");
  fs.writeFileSync(configPath, JSON.stringify({ nodeId: "fixture-node", managerUrl: "http://manager.invalid", managerGuid: "fixture-guid", nodeCredential: "fixture-only" }));
  const ownerModule = new URL("../lib/delivery-owner.mjs", import.meta.url).href;
  const controlModule = new URL("../lib/delivery-control.mjs", import.meta.url).href;
  const cliModule = new URL("../lib/manager-cli.mjs", import.meta.url).href;
  fs.writeFileSync(entry, `import fs from 'node:fs';
import {DeliveryOwner} from ${JSON.stringify(ownerModule)};
import {runDeliveryCommand} from ${JSON.stringify(controlModule)};
import {runManagerCommand} from ${JSON.stringify(cliModule)};
const configPath=${JSON.stringify(configPath)};
const identity={applicationGenerationId:'fixture-generation',managerInstanceId:'fixture-instance'};
const fetchImpl=async url=>{
 if(!fs.existsSync(${JSON.stringify(catalogOnline)}))throw new Error('fixture discovery offline');
 const route=new URL(url).pathname;
 if(route==='/.well-known/rabiroute-manager'||route==='/api/lan-agent/self')return Response.json({code:0,data:{...identity,guid:'fixture-guid',protocolVersion:1,nodeId:'fixture-node'}});
 if(route==='/meta')return Response.json({code:0,data:{...identity,rabiGuid:'fixture-guid',health:{live:true,requiredReady:true,state:'healthy'}}});
 if(route==='/api/agent/help')return Response.json({code:0,data:{schemaVersion:'2',...identity,pluginGenerationId:'plugins',catalogRevision:1,catalogDigest:'sha256:'+'c'.repeat(64),nextCursor:'',operations:[{id:'fixture.verified-agent-send',contractDigest:'sha256:'+'d'.repeat(64),contract:{operationId:'fixture.verified-agent-send',aliases:['fixture:POST:/verified'],method:'POST',pathTemplate:'/api/agent/threads',contractVersion:'1.0.0',transport:'http'}}]}});
 throw new Error('direct business network bypass was used');
};
if(process.argv.includes('--delivery-submit')||process.argv.includes('--api')||process.argv.includes('--operation')) {
 const readInput=async()=>{const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8')};
 const result=process.argv.includes('--delivery-submit')?await runDeliveryCommand(process.argv.slice(2),configPath,readInput):await runManagerCommand(process.argv.slice(2),configPath,{readInput,fetchImpl,discover:async()=>null});
 console.log(JSON.stringify(result));
} else {
 const owner=new DeliveryOwner({configPath,config:{nodeId:'fixture-node'},sendEvent:()=>false,client:()=>({request:async(method)=>{
  if(!fs.existsSync(${JSON.stringify(online)}))throw new Error('fixture offline');
  return {ok:true,statusCode:200,body:JSON.stringify(method==='GET'?{code:0,data:{state:'committed',deliveryId:'internal',receipt:{accepted:true}}}:{status:'delivered',delivery:{status:'accepted',deliveryId:'internal'}})};
 }})});
 process.on('message',message=>{
  if(message.type!=='deliveryControl')return;
  try {const result=message.operation==='submit'?owner.submit(message.params):{ok:true,...owner.query(message.params)};process.send({type:'deliveryControlResult',requestId:message.requestId,result});}
  catch(error){process.send({type:'deliveryControlResult',requestId:message.requestId,result:{ok:false,error:error.message}});}
 });
 process.on('SIGTERM',async()=>{await owner.close();process.exit(0)});
 process.on('disconnect',async()=>{await owner.close();process.exit(0)});
 owner.start();fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);
}`);
  __test.writeCurrentRelease(configPath, entry, "a".repeat(64));
  const launcher = __test.writeLauncher(configPath, { baseDelayMs: 50, maxDelayMs: 100, maxRestarts: 2, stableMs: 60000 });
  const children = [];
  const run = (args = [], stdin) => {
    const child = spawn(process.execPath, [launcher, "--config", configPath, ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout.on("data", part => { output += part; }); child.stderr.on("data", part => { errors += part; });
    const closed = new Promise(resolve => child.on("close", code => resolve({ code, output, errors })));
    child.stdin.end(stdin); children.push({ child, closed }); return { child, closed, errors: () => errors };
  };
  t.after(async () => {
    for (const item of children) if (item.child.exitCode === null) item.child.kill("SIGKILL");
    await Promise.all(children.map(item => item.closed));
    await delay(100); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const first = run(); await until(() => { if (first.child.exitCode !== null) throw new Error(first.errors()); return fs.existsSync(marker); }); const firstWorker = fs.readFileSync(marker, "utf8");
  const input = { intentId: "stable-fixture", agentType: "codex", sessionId: "source", request: { action: "send", deliveryId: "stable-fixture", sourceThreadId: "source", threadId: "target", prompt: "fixture" } };
  const cli = run(["--delivery-submit"], JSON.stringify(input));
  const accepted = await cli.closed; assert.equal(accepted.code, 0, accepted.errors);
  assert.equal(JSON.parse(accepted.output).acceptance, "local-durable");
  assert.equal(fs.readFileSync(marker, "utf8"), firstWorker, "no competing worker was spawned by CLI");
  const api = run(["--api", "POST", "/api/agent/threads", "--body-stdin", "--agent-type", "codex", "--id", "source"], JSON.stringify({ action: "send", threadId: "target", prompt: "Unicode任务😀".repeat(20000) }));
  const apiAccepted = await api.closed; assert.equal(apiAccepted.code, 0, apiAccepted.errors);
  assert.equal(JSON.parse(apiAccepted.output).acceptance, "local-durable"); assert.match(JSON.parse(apiAccepted.output).intentId, /^[a-f0-9-]{36}$/i);
  assert.equal(JSON.parse(apiAccepted.output).statusCode, 202); assert.equal(JSON.parse(JSON.parse(apiAccepted.output).body).status, "queued");
  for (const bodyFlag of ["--raw-stdin", "--body-file"]) {
    const body = JSON.stringify({ action: "send", threadId: "target-" + bodyFlag, prompt: "JSON body format fixture" });
    const bodyFile = path.join(root, "body.json"); fs.writeFileSync(bodyFile, body);
    const args = ["--api", "POST", "/api/agent/threads", "--agent-type", "codex", "--id", "source", bodyFlag, ...(bodyFlag === "--body-file" ? [bodyFile] : [])];
    const result = await run(args, bodyFlag === "--raw-stdin" ? body : undefined).closed;
    assert.equal(result.code, 0, result.errors); assert.equal(JSON.parse(result.output).statusCode, 202); assert.equal(JSON.parse(result.output).acceptance, "local-durable");
  }
  const sdk = createManagerClient({ configPath, agentType: "codex", sessionId: "source", fetchImpl: () => { throw new Error("SDK must not use business network before durable acceptance"); } });
  for (const method of ["request", "invoke"]) {
    const receipt = await sdk[method]("POST", "/api/agent/threads", { body: { action: "send", threadId: "target-sdk-" + method, prompt: "SDK fixture" } });
    assert.equal(receipt.statusCode, 202); assert.equal(JSON.parse(receipt.body).status, "queued");
  }
  for (const format of ["bodyText", "bodyBytes", "bodyStream"]) {
    const bytes = Buffer.from(JSON.stringify({ action: "send", threadId: "sdk-" + format, prompt: "SDK字节😀" }));
    const body = format === "bodyText" ? bytes.toString("utf8") : format === "bodyBytes" ? bytes : (async function* () { yield bytes.subarray(0, 10); yield bytes.subarray(10); })();
    const receipt = await sdk.request("POST", "/api/agent/threads", { [format]: body });
    assert.equal(receipt.statusCode, 202); assert.equal(JSON.parse(receipt.body).status, "queued");
  }
  await assert.rejects(sdk.request("POST", "/api/agent/threads", { bodyBytes: Buffer.from([255]) }), /valid UTF-8 JSON/);
  const operationArgs = ["--operation", "fixture.verified-agent-send", "--body-stdin", "--agent-type", "codex", "--id", "source"];
  const warm = await run(operationArgs, JSON.stringify({ action: "send", threadId: "warm-target", prompt: "verified descriptor fixture" })).closed;
  assert.equal(warm.code, 0, warm.errors); assert.equal(JSON.parse(warm.output).statusCode, 202);
  fs.unlinkSync(catalogOnline);
  const cold = await run(operationArgs, JSON.stringify({ action: "send", threadId: "cold-target", prompt: "cold offline fixture" })).closed;
  assert.equal(cold.code, 0, cold.errors); assert.equal(JSON.parse(cold.output).statusCode, 202);
  const directOperation = await sdk.invokeOperation("fixture.verified-agent-send", { body: { action: "send", threadId: "sdk-operation-target", prompt: "SDK offline operation fixture" } });
  assert.equal(directOperation.statusCode, 202);
  const aliasOperation = await sdk.catalog.invokeOperation("fixture:POST:/verified", { bodyText: JSON.stringify({ action: "send", threadId: "sdk-alias-target", prompt: "SDK cached alias fixture" }) });
  assert.equal(aliasOperation.statusCode, 202);
  const coldFile = path.join(root, "cold-operation.json"); fs.writeFileSync(coldFile, JSON.stringify({ action: "send", threadId: "cold-file-target", prompt: "cold file operation fixture" }));
  const coldFileResult = await run(["--operation", "fixture.verified-agent-send", "--body-file", coldFile, "--agent-type", "codex", "--id", "source"]).closed;
  assert.equal(coldFileResult.code, 0, coldFileResult.errors); assert.equal(JSON.parse(coldFileResult.output).statusCode, 202);
  const unknown = await run(["--operation", "unverified.unknown", "--body-stdin", "--agent-type", "codex", "--id", "source"], JSON.stringify({ action: "send", threadId: "never-target", prompt: "must not be accepted" })).closed;
  assert.notEqual(unknown.code, 0); assert.equal(unknown.output.includes("local-durable"), false);
  const stop = run(["--stop"]); assert.equal((await stop.closed).code, 0); await first.closed;
  fs.unlinkSync(marker); fs.writeFileSync(online, "fixture recovered");
  run(); await until(() => fs.existsSync(marker));
  await until(async () => (await requestDeliveryControl(configPath, "query", { action: "get", intentId: "stable-fixture" })).item?.state === "received");
  const secondStop = run(["--stop"]); assert.equal((await secondStop.closed).code, 0);
});

test("automatically generated intent ID remains observable after an uncertain local IPC result", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-key-")), configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, "{}"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = await submitDeliveryToOwner(configPath, { agentType: "codex", sessionId: "source", request: { action: "send", threadId: "target", prompt: "fixture" } });
  assert.equal(receipt.ok, false); assert.equal(receipt.accepted, null); assert.match(receipt.intentId, /^[a-f0-9-]{36}$/i); assert.equal(receipt.deliveryId, receipt.intentId);
});
