import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createGatewayListenerPublicationHost } from "./gatewayListenerPublication.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginCandidate, PluginContext, PluginModule } from "../plugin-kernel/types.js";

const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" };
const childCode = `
  import http from 'node:http';
  import {createInterface} from 'node:readline';
  import {getGatewayListenerRuntime,GATEWAY_LISTENER_PUBLICATION_PREFIX} from ${JSON.stringify(new URL("../runtime/gatewayListenerRuntime.ts", import.meta.url).href)};
  import {fixtureApiContract} from ${JSON.stringify(new URL("./apiOperationContractFixtures.ts", import.meta.url).href)};
  const runtime=getGatewayListenerRuntime(); let lease;
  const server=http.createServer((request,response)=>lease.handle(request,new URL(request.url,'http://native'),response));
  server.listen(0,'127.0.0.1',()=>{
    lease=runtime.registerExternalListener('fixture-native-owner',{
      listenerId:runtime.operationId('listener'),address:{protocol:'http',hostname:'127.0.0.1',port:server.address().port},
      protocol:'fixture-native',invocation:'native',authentication:{kind:'none',description:'Original native owner.'}
    });
    lease.registerHttpProxies([{contract:fixtureApiContract({operationId:runtime.operationId('message'),pathTemplate:'/native',
      request:{path:true,query:true,headers:true,body:{kind:'passthrough'}},
      httpProxy:{wire:{dataFrameBytes:1024,streamWindowBytes:4096,maxConcurrentStreams:2},completion:'Response closes.',cancellation:'Close native response.'},
      responses:{default:{mediaType:'*/*',passthrough:true}}}),async handler(input){
      let body=''; for await(const bytes of input.request)body+=Buffer.from(bytes).toString('utf8');
      input.prepareResponse(200,{'content-type':'application/json'});
      input.response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({body,nodeBearerPresent:input.request.headers.authorization!==undefined,pid:process.pid}));
    }}]);
  });
  let customRevision=100,tail;
  const customLine=()=>GATEWAY_LISTENER_PUBLICATION_PREFIX+JSON.stringify({schemaVersion:1,gatewayId:process.env.GATEWAY_ID,
    gatewayGenerationId:process.env.RABIROUTE_GATEWAY_GENERATION_ID,pid:process.pid,revision:customRevision++,listeners:[{
      ...lease.publication(),binding:{...lease.binding,authentication:{kind:'none',description:'原进程缓存状态'}}
    }]})+'\\n';
  const commands=createInterface({input:process.stdin,terminal:false}); commands.on('line',async command=>{
    if(command==='half'){
      const bytes=Buffer.from(customLine());const split=bytes.indexOf(Buffer.from('原'))+1;
      process.stdout.write(bytes.subarray(0,split));tail=bytes.subarray(split);process.send?.({kind:'half-written'});
    }
    if(command==='tail'){if(tail){process.stdout.write(tail);tail=undefined;}process.send?.({kind:'tail-written'});}
    if(command==='valid'){process.stdout.write(customLine());console.log('fixture-valid-emitted');}
    if(command==='bad'){process.stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX+'{broken\\n');console.log('fixture-bad-emitted');}
    if(command==='log'){console.log('普通中文日志🙂');console.log('fixture-log-emitted');}
    if(command==='wrongpid'){
      process.stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX+JSON.stringify({schemaVersion:1,gatewayId:process.env.GATEWAY_ID,
        gatewayGenerationId:process.env.RABIROUTE_GATEWAY_GENERATION_ID,pid:process.pid+1,revision:99999,listeners:[]})+'\\n');
      console.log('fixture-wrongpid-emitted');
    }
    if(command==='oldrevision'){
      process.stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX+JSON.stringify({schemaVersion:1,gatewayId:process.env.GATEWAY_ID,
        gatewayGenerationId:process.env.RABIROUTE_GATEWAY_GENERATION_ID,pid:process.pid,revision:1,listeners:[]})+'\\n');
      console.log('fixture-oldrevision-emitted');
    }
    if(command==='stale'){
      process.stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX+JSON.stringify({schemaVersion:1,gatewayId:process.env.GATEWAY_ID,
        gatewayGenerationId:'retired-generation',pid:process.pid,revision:99999,listeners:[]})+'\\n');
      console.log('fixture-stale-emitted');
    }
    if(command==='retire'){lease.stopAccepting();await lease.dispose();console.log('fixture-retired');}
    if(command==='quit'){await runtime.dispose();server.close(()=>process.exit(0));}
  });
`;
async function until(predicate: () => boolean, diagnostic?: () => unknown) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Controlled Gateway publication did not reach expected state." + (diagnostic ? JSON.stringify(diagnostic()) : "")); await new Promise(resolve => setTimeout(resolve, 10)); }
}

type RevisionOptions = {
  entered?: { resolve(): void }; wait?: Promise<void>; failPrepare?: boolean; failPublish?: boolean;
  disposed?(): void; rolledBack?(): void;
};
function generationFixture(existing?: ManagerPluginRouteRegistry) {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const runtime = new GenerationRuntime({ host: "manager", executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const registry = existing ?? new ManagerPluginRouteRegistry(() => new Set(runtime.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId)), { identity: () => identity });
  const publication = createGatewayListenerPublicationHost(registry);
  function revision(name: string, options: RevisionOptions = {}): PluginCandidate {
    const candidate: PluginCandidate = { instanceId: "gateway-runtime", revision: name, config: {},
      entry: { execution: "in_process", path: "controlled-gateway-plugin.mjs" },
      manifest: { schemaVersion: 2, id: "io.test.gateway-runtime", version: "1.0.0", entries: { manager: { execution: "in_process", module: "controlled-gateway-plugin.mjs" } },
        provides: ["test.gateway-runtime@1"], requires: [], optional: [], permissions: [] } };
    modules.set(candidate, { activate(context: PluginContext) {
      context.services.provide("test.gateway-runtime@1", name);
      context.effects.add(async () => {
        assert.equal(currentPluginActivation()?.activationId, context.identity.activationId);
        const projection = publication.project();
        try {
          options.entered?.resolve(); if (options.wait) await options.wait;
          if (options.failPrepare) throw new Error("controlled candidate prepare failure");
          return () => { projection.dispose(); options.disposed?.(); };
        } catch (error) { projection.dispose(); options.disposed?.(); throw error; }
      });
      context.publication.add({ publish() { if (options.failPublish) throw new Error("controlled candidate publish failure"); }, rollback() { options.rolledBack?.(); } });
    } });
    return candidate;
  }
  return { runtime, registry, publication, revision };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }

async function managedChild(t: TestContext, publication: ReturnType<typeof createGatewayListenerPublicationHost>, generation = "fixture-generation") {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
    env: { ...process.env, GATEWAY_ID: "fixture-gateway", RABIROUTE_GATEWAY_GENERATION_ID: generation }, stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  const processIdentity = { gatewayId: "fixture-gateway", gatewayGenerationId: generation };
  const detach = publication.attach(child, processIdentity);
  let output = "", errors = "", receivedBytes = 0;
  child.stdout!.on("data", bytes => { receivedBytes += bytes.length; output += String(bytes); });
  child.stderr!.on("data", bytes => { errors += String(bytes); });
  t.after(async () => { detach(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); } });
  await until(() => output.split("\n").filter(line => line.startsWith("RABIROUTE_GATEWAY_LISTENERS ")).length >= 2 || child.exitCode !== null);
  assert.equal(child.exitCode, null, errors);
  return { child, detach, processIdentity, command(value: string) { child.stdin!.write(value + "\n"); },
    output: () => output, receivedBytes: () => receivedBytes,
    publicationCount: () => output.split("RABIROUTE_GATEWAY_LISTENERS ").length - 1 };
}
function bindingOperation(registry: ManagerPluginRouteRegistry) {
  return registry.catalogSnapshot().operations.find(operation => operation.binding)!;
}

test("real Gateway child publishes native contracts through its owned stdout generation into Manager discovery and retires atomically", async t => {
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const { runtime, publication, revision } = generationFixture(registry);
  await runtime.switch([revision("initial")]);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
    env: { ...process.env, GATEWAY_ID: "fixture-gateway", RABIROUTE_GATEWAY_GENERATION_ID: "fixture-generation" }, stdio: ["pipe", "pipe", "pipe"]
  });
  const detach = publication.attach(child, { gatewayId: "fixture-gateway", gatewayGenerationId: "fixture-generation" });
  let output = "", errors = ""; child.stdout!.on("data", bytes => { output += String(bytes); }); child.stderr!.on("data", bytes => { errors += String(bytes); });
  const discovery = registry.registerOperations("fixture-discovery", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-node"); const url = new URL(request.url!, "http://manager");
    if (url.pathname === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    detach(); await runtime.dispose(); publication.dispose();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await until(() => Boolean(registry.catalogSnapshot().operations.find(value => value.binding)) || child.exitCode !== null);
  assert.equal(child.exitCode, null, errors);
  const operation = registry.catalogSnapshot().operations.find(value => value.binding)!;
  assert.ok(operation); assert.equal(registry.catalogSnapshot().listeners.length, 1);
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = createManagerClient({ managerUrl: origin, credential: "fixture-node", fetchImpl: (url, options) => {
    assert.equal(new URL(url instanceof Request ? url.url : url).origin, origin); return fetch(url, options);
  } });
  const receipt = await client.invokeOperation(operation.contract.operationId, { bodyText: "original-native-payload" });
  assert.equal(receipt.ok, true); assert.equal(receipt.uncertain, false);
  assert.deepEqual(JSON.parse(receipt.body!), { body: "original-native-payload", nodeBearerPresent: false, pid: child.pid });
  child.stdin!.write("stale\n"); await until(() => output.includes("fixture-stale-emitted"));
  assert.equal(registry.catalogSnapshot().listeners.length, 1, "Wrong-generation stdout cannot replace the current owner.");
  child.stdin!.write("retire\n"); await until(() => output.includes("fixture-retired"));
  assert.equal(child.exitCode, null); assert.equal(registry.catalogSnapshot().listeners.length, 0);
  assert.equal(registry.catalogSnapshot().operations.some(value => value.binding), false);
  child.stdin!.write("quit\n"); await once(child, "exit");
});

test("successful real plugin replacement inherits verified cache without child stdout replay or restart", async t => {
  const { runtime, registry, publication, revision } = generationFixture();
  t.after(async () => { await runtime.dispose(); publication.dispose(); });
  const native = await managedChild(t, publication);
  assert.equal(registry.catalogSnapshot().operations.length, 0, "A process cache is not an unowned plugin source.");
  let retired = 0;
  await runtime.switch([revision("old", { disposed() { retired++; } })]);
  const old = bindingOperation(registry), before = native.publicationCount();
  assert.equal(old.owner.revision, "old"); const childPid = native.child.pid;
  const switched = await runtime.switch([revision("new")]);
  assert.equal(switched.generation.records[0]?.identity.revision, "new", JSON.stringify(switched.generation.records[0]?.error));
  assert.equal(registry.catalogSnapshot().listeners[0]!.owner.revision, "new", "The trusted source projection has the real new activation.");
  const next = bindingOperation(registry);
  assert.equal(next.owner.revision, "new", JSON.stringify({ retired, records: runtime.current().records, owner: next.owner })); assert.notEqual(next.owner.activationId, old.owner.activationId);
  assert.equal(next.binding!.leaseId, old.binding!.leaseId); assert.equal(next.contractDigest, old.contractDigest);
  assert.equal(next.binding!.address.port, old.binding!.address.port); assert.equal(retired, 1);
  assert.equal(native.child.pid, childPid); assert.equal(native.child.exitCode, null);
  assert.equal(native.publicationCount(), before, "The original process did not emit another publication.");
  assert.equal(registry.catalogSnapshot().listeners.length, 1);
  const receipt = await fetch(`http://127.0.0.1:${next.binding!.address.port}/native`, { method: "POST", body: "same-process-after-handoff" });
  assert.deepEqual(await receipt.json(), { body: "same-process-after-handoff", nodeBearerPresent: false, pid: childPid });
});

test("failed real candidate preparation and publication rollback preserve original child cache and activation", async t => {
  const { runtime, registry, publication, revision } = generationFixture();
  const release = gate();
  t.after(async () => { release.resolve(); await runtime.dispose(); publication.dispose(); });
  const native = await managedChild(t, publication); let oldRetired = 0, failedRetired = 0, rolledBack = 0;
  await runtime.switch([revision("old", { disposed() { oldRetired++; } })]);
  const old = bindingOperation(registry); const originalGeneration = runtime.current().id, count = native.publicationCount();
  const entered = gate();
  const preparing = runtime.switch([revision("bad-prepare", { entered, wait: release.promise, failPrepare: true, disposed() { failedRetired++; } })]);
  await entered.promise;
  assert.equal(bindingOperation(registry).owner.activationId, old.owner.activationId);
  release.resolve(); const result = await preparing;
  assert.equal(result.generation.records[0]?.error?.code, "update_failed_using_previous_revision");
  assert.equal(bindingOperation(registry).owner.activationId, old.owner.activationId); assert.equal(failedRetired, 1);
  const beforePublishFailure = runtime.current();
  await assert.rejects(runtime.switch([revision("bad-publish", { failPublish: true, disposed() { failedRetired++; }, rolledBack() { rolledBack++; } })]), /controlled candidate publish failure/);
  assert.equal(runtime.current(), beforePublishFailure);
  assert.equal(bindingOperation(registry).owner.activationId, old.owner.activationId);
  assert.equal(bindingOperation(registry).binding!.leaseId, old.binding!.leaseId);
  assert.equal(oldRetired, 0); assert.equal(failedRetired, 2); assert.equal(rolledBack, 1);
  assert.equal(native.child.exitCode, null); assert.equal(native.publicationCount(), count);
  assert.ok(originalGeneration);
});

test("UTF-8 half-line and last verified publication survive projection retirement, reattach and a new activation", async t => {
  const { runtime, registry, publication, revision } = generationFixture();
  t.after(async () => { await runtime.dispose(); publication.dispose(); });
  const native = await managedChild(t, publication); await runtime.switch([revision("old")]);
  const old = bindingOperation(registry); const before = native.receivedBytes();
  const halfWritten = once(native.child, "message"); native.command("half");
  assert.deepEqual((await halfWritten)[0], { kind: "half-written" });
  await until(() => native.receivedBytes() > before);
  const dataObservers = native.child.stdout!.listenerCount("data");
  assert.equal(publication.attach(native.child, native.processIdentity), native.detach, "Re-observing the same process must retain its parser.");
  assert.equal(native.child.stdout!.listenerCount("data"), dataObservers);
  assert.throws(() => publication.attach(native.child, { ...native.processIdentity, gatewayGenerationId: "forged-generation" }), /captured identity/);
  await runtime.switch([]);
  assert.equal(registry.catalogSnapshot().operations.length, 0); assert.equal(native.child.exitCode, null);
  await runtime.switch([revision("replacement")]);
  assert.equal(bindingOperation(registry).binding!.leaseId, old.binding!.leaseId, "A new activation immediately sees the verified pre-half-line cache.");
  native.command("tail");
  await until(() => registry.catalogSnapshot().listeners[0]?.binding.authentication.description === "原进程缓存状态");
  assert.equal(bindingOperation(registry).owner.revision, "replacement"); assert.equal(native.child.exitCode, null);
  assert.equal(registry.catalogSnapshot().listeners[0]!.binding.authentication.description.includes("�"), false);
});

test("replacing a captured process during candidate preparation survives rollback and ignores late old stdout and detach", async t => {
  const { runtime, registry, publication, revision } = generationFixture();
  const release = gate();
  t.after(async () => { release.resolve(); await runtime.dispose(); publication.dispose(); });
  const oldChild = await managedChild(t, publication, "old-child-generation"); await runtime.switch([revision("active")]);
  const old = bindingOperation(registry), entered = gate();
  const candidate = runtime.switch([revision("failed-replacement", { entered, wait: release.promise, failPublish: true })]);
  await entered.promise;
  const currentChild = await managedChild(t, publication, "new-child-generation");
  await until(() => bindingOperation(registry)?.binding?.address.port !== old.binding!.address.port);
  const current = bindingOperation(registry);
  assert.equal(current.owner.activationId, old.owner.activationId); assert.notEqual(current.binding!.leaseId, old.binding!.leaseId);
  release.resolve(); await assert.rejects(candidate, /controlled candidate publish failure/);
  const output = oldChild.output(); oldChild.command("valid"); await until(() => oldChild.output() !== output);
  oldChild.detach();
  assert.equal(bindingOperation(registry).binding!.leaseId, current.binding!.leaseId);
  assert.equal(registry.catalogSnapshot().listeners.length, 1);
  assert.equal(oldChild.child.exitCode, null); assert.equal(currentChild.child.exitCode, null);
  assert.equal(oldChild.child.stdout!.listenerCount("data"), 1, "Only the test observer remains on the retired process.");
  const response = await fetch(`http://127.0.0.1:${current.binding!.address.port}/native`, { method: "POST", body: "replacement-child" });
  assert.equal((await response.json() as { pid: number }).pid, currentChild.child.pid);
});

test("wrong identity and stale revisions cannot replace cache; invalid state and lost pipe fail closed across activation changes", async t => {
  const { runtime, registry, publication, revision } = generationFixture();
  t.after(async () => { await runtime.dispose(); publication.dispose(); });
  const native = await managedChild(t, publication); await runtime.switch([revision("old")]);
  const original = bindingOperation(registry);
  for (const command of ["stale", "wrongpid", "oldrevision", "log"]) {
    native.command(command); await until(() => native.output().includes(`fixture-${command === "stale" ? "stale" : command}-emitted`));
    assert.equal(bindingOperation(registry).binding!.leaseId, original.binding!.leaseId);
    assert.equal(registry.catalogSnapshot().coverage.gaps.length, 0);
  }
  native.command("bad"); await until(() => registry.catalogSnapshot().coverage.gaps.length === 1);
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  await runtime.switch([revision("new")]);
  assert.equal(registry.catalogSnapshot().operations.length, 0); assert.equal(registry.catalogSnapshot().coverage.gaps.length, 1);
  native.command("valid"); await until(() => Boolean(bindingOperation(registry)), () => ({ catalog: registry.catalogSnapshot(), output: native.output().slice(-2000), exited: native.child.exitCode }));
  assert.equal(bindingOperation(registry).owner.revision, "new");
  assert.equal(registry.catalogSnapshot().coverage.gaps.length, 0);
  native.child.stdout!.destroy(); await until(() => registry.catalogSnapshot().coverage.gaps.length === 1);
  assert.equal(registry.catalogSnapshot().operations.length, 0); assert.equal(native.child.exitCode, null);
  const exited = once(native.child, "exit"); native.child.kill(); await exited;
  assert.equal(registry.catalogSnapshot().coverage.gaps.length, 0); assert.equal(registry.catalogSnapshot().listeners.length, 0);
});

test("projection requires a real plugin activation even before the first process is attached", () => {
  const registry = new ManagerPluginRouteRegistry(), publication = createGatewayListenerPublicationHost(registry);
  try { assert.throws(() => publication.project(), /actual plugin activation/); assert.equal(registry.catalogSnapshot().operations.length, 0); }
  finally { publication.dispose(); }
});
