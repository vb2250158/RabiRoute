import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagerClient } from "../apps/rabi-agent/lib/manager-client.mjs";
import { WebSocket, WebSocketServer } from "ws";
import http from "node:http";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function pollFixture(read, predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}.`);
}

function fixtureChildCommand(worker, kind, payload) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off("message", receive); reject(new Error(`Compiled fixture command ${kind} did not finish.`)); }, 25_000);
    const receive = message => {
      if (message?.kind !== kind || message.id !== id) return;
      clearTimeout(timer); worker.off("message", receive); resolve(message);
    };
    worker.on("message", receive);
    worker.send({ kind, id, ...payload }, error => {
      if (!error) return;
      clearTimeout(timer); worker.off("message", receive); reject(error);
    });
  });
}

async function startBuiltManager(t, readOnly = true, bridgeFixture, peerFixture, contractFixture, nativeFixture) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "api-contract-built-manager-"));
  const stateRoot = path.join(root, "state"); await fs.mkdir(stateRoot);
  const generation = randomUUID();
  const controlToken = randomUUID();
  // Build a private fixture profile from the published dependency graph. It includes
  // readiness dependencies only, avoiding unrelated post-READY device activation.
  const profile = JSON.parse(await fs.readFile(path.join(packageRoot, "dist/plugins/profiles/desktop.json"), "utf8"));
  if (bridgeFixture) profile.readyRequires = [...new Set([...profile.readyRequires, "manager.remote-agent@1"])];
  if (peerFixture) profile.readyRequires = [...new Set([...profile.readyRequires, "manager.rabilink-relay@1", "manager.remote-agent@1"])];
  if (contractFixture) profile.readyRequires = [...new Set([...profile.readyRequires, ...contractFixture.capabilities])];
  if (nativeFixture) profile.readyRequires = [...new Set([...profile.readyRequires, "manager.gateway-runtime@1"])];
  const providers = new Map();
  await Promise.all(profile.instances.filter(instance => instance.enabled !== false || contractFixture).map(async instance => {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "dist/plugins/packages", instance.package, instance.version, "rabi.plugin.json"), "utf8"));
    if (instance.enabled === false) {
      if (!manifest.provides.some(capability => contractFixture.capabilities.includes(capability))) return;
      // Explicit test-only selection; the published desktop profile remains unchanged.
      instance.enabled = true;
    }
    for (const capability of manifest.provides) {
      assert.equal(providers.has(capability), false, `Ambiguous fixture capability: ${capability}`);
      providers.set(capability, { instance, manifest });
    }
  }));
  const selected = new Set(), pending = [...profile.readyRequires];
  while (pending.length) {
    const capability = pending.pop(), provider = providers.get(capability);
    if (!provider) { assert.ok(!capability.startsWith("manager."), `Missing fixture dependency: ${capability}`); continue; }
    if (selected.has(provider.instance.id)) continue;
    selected.add(provider.instance.id); pending.push(...provider.manifest.requires);
  }
  profile.instances = profile.instances.filter(instance => selected.has(instance.id));
  // Watch only the fixture profile directory; runtime logs and config writes in
  // sibling directories must not spuriously reconcile away a controlled candidate.
  const profilePath = path.join(root, "profile", "desktop.json");
  await fs.mkdir(path.dirname(profilePath)); await fs.writeFile(profilePath, JSON.stringify(profile));
  // Only discovery is simulated. The compiled native Hub still owns the actual
  // HMAC handshake, socket dispatch, task state, file storage and callback lifetime.
  let prelude = bridgeFixture ? `const {RemoteAgentHub}=await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/messageEndpoints/remoteAgentManager.js")).href)}); RemoteAgentHub.prototype.discoverRemoteAgents=async()=>[${JSON.stringify(bridgeFixture)}];` : "";
  if (nativeFixture) {
    const { ManagerConfigRepository } = await import(pathToFileURL(path.join(packageRoot, "dist/manager/configRepository.js")).href);
    await fs.mkdir(path.join(root, "roles", "CompiledNativeRole"), { recursive: true });
    await fs.writeFile(path.join(root, "roles", "CompiledNativeRole", "persona.md"), "# Isolated native listener fixture\n");
    const repository = new ManagerConfigRepository({ rootDir: stateRoot, managerPort: 0,
      routeRoot: path.join(root, "routes"), rolesRoot: path.join(root, "roles") });
    repository.writeConfig({ gateways: [{ id: "CompiledNativeRole__main", configName: "CompiledNativeRole__main", enabled: true,
      agentRoleId: "CompiledNativeRole", messageAdapters: ["webhook"], gatewayPort: nativeFixture.port,
      webhookPort: nativeFixture.port, webhookPath: "/compiled-native", notificationRules: [], automationRules: [], agentAdapters: [] }] });
    const originalModule = pathToFileURL(path.join(packageRoot, "dist/plugins/packages/io.rabiroute.manager.gateway-runtime/1.0.0/manager.mjs")).href;
    for (const mode of ["fail-prepare", "fail-publish", "replace"]) {
      await fs.writeFile(path.join(root, `gateway-${mode}.mjs`), `import {activate as originalActivate} from ${JSON.stringify(originalModule)};
        export async function activate(context){ await originalActivate(context);
          ${mode === "fail-prepare" ? 'context.effects.add(()=>{throw new Error("compiled candidate prepare failure")});' : ""}
          ${mode === "fail-publish" ? 'context.publication.add({publish(){throw new Error("compiled candidate publish failure")},rollback(){}});' : ""}
        }`);
    }
    // Only candidate selection is controlled through this private child IPC. The real
    // compiled kernel, Gateway plugin, supervisor spawn, stdout and native owner run.
    prelude += `const {GenerationRuntime}=await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/plugin-kernel/generationRuntime.js")).href)});
      const nativeSwitch=GenerationRuntime.prototype.switch;let nativeKernel,nativeCandidates,nativeSwitchOptions;
      GenerationRuntime.prototype.switch=function(candidates,options){
        if(candidates.some(candidate=>candidate.manifest.id==='io.rabiroute.manager.gateway-runtime')){
          nativeKernel=this;nativeCandidates=candidates;nativeSwitchOptions=options;
        }return nativeSwitch.call(this,candidates,options);
      };
      process.on('message',async message=>{if(message?.kind!=='compiled-native-candidate')return;
        const diagnostic=()=>{const current=nativeKernel?.current();const record=current?.records.find(value=>value.manifest.id==='io.rabiroute.manager.gateway-runtime');
          return {generationId:current?.id,readiness:current?.readiness.state,record:record&&{status:record.status,error:record.error,activationId:record.identity.activationId,revision:record.identity.revision}}};
        try{if(!nativeKernel)throw Error('Original Manager kernel not captured');
          const candidates=nativeCandidates.map(candidate=>candidate.manifest.id==='io.rabiroute.manager.gateway-runtime'
            ? {...candidate,revision:'compiled-'+message.mode,entry:{...candidate.entry,path:${JSON.stringify(root)}+'/gateway-'+message.mode+'.mjs'}}:candidate);
          const result=await nativeSwitch.call(nativeKernel,candidates,nativeSwitchOptions);
          process.send?.({kind:message.kind,id:message.id,ok:true,changed:result.changed,...diagnostic()});
        }catch(error){process.send?.({kind:message.kind,id:message.id,ok:false,error:String(error),...diagnostic()})}
      });`;
  }
  if (peerFixture) {
    await fs.mkdir(path.join(stateRoot, "data"), { recursive: true });
    await fs.writeFile(path.join(stateRoot, "data/Config.json"), JSON.stringify({ rabiName: "Fixture source", rabiGuid: randomUUID(),
      rabiLinkRelay: { enabled: true, url: peerFixture.relayUrl, token: "fixture-application", deviceId: "fixture-source" } }));
    const module = name => JSON.stringify(pathToFileURL(path.join(packageRoot, "dist", name)).href);
    // Discovery/session selection, application-bootstrap readiness and LAN advertisement are controlled. The
    // actual compiled authority, encrypted session, HTTP proxy and sockets run.
    prelude += `
      const {EventEmitter}=await import('node:events');
      const {loadTunnelIdentity}=await import(${module("peerTunnel/security.js")});
      const {establishTunnel}=await import(${module("peerTunnel/session.js")});
      const {serveTunnel}=await import(${module("peerTunnel/http.js")});
      const {PeerTunnelRuntime}=await import(${module("peerTunnel/runtime.js")});
      const {PeerLanServer}=await import(${module("manager/peerLanServer.js")});
      const a=loadTunnelIdentity(${JSON.stringify(path.join(root, "fixture-a.json"))},'fixture-a','a-gen');
      const b=loadTunnelIdentity(${JSON.stringify(path.join(root, "fixture-b.json"))},'fixture-b','b-gen');
      const ac=new EventEmitter(),bc=new EventEmitter();let ended=false;
      ac.send=async data=>{setImmediate(()=>{if(!ended)bc.emit('data',data)})};
      bc.send=async data=>{setImmediate(()=>{if(!ended)ac.emit('data',data)})};
      ac.close=bc.close=()=>{if(!ended){ended=true;ac.emit('close');bc.emit('close')}};
      const [caller,receiver]=await Promise.all([
        establishTunnel(ac,a,{deviceId:b.deviceId,publicKey:b.publicKey,services:[]},true,AbortSignal.timeout(5000)),
        establishTunnel(bc,b,{deviceId:a.deviceId,publicKey:a.publicKey,services:[]},false,AbortSignal.timeout(5000))]);
      serveTunnel(receiver,()=>({manager:{baseUrl:${JSON.stringify(peerFixture.targetUrl)}}}),()=>true);
      PeerTunnelRuntime.prototype.session=async function(id){if(id!=='fixture-peer-target')throw Error('Unknown fixture target');return caller};
      const ensureApplication=PeerTunnelRuntime.prototype.ensureApplicationConnection;
      PeerTunnelRuntime.prototype.ensureApplicationConnection=async function(id){if(id==='fixture-peer-target')return;return ensureApplication.call(this,id)};
      const peerDirectory=PeerTunnelRuntime.prototype.directory;
      PeerTunnelRuntime.prototype.directory=function(force){this.options.discover=async()=>[{id:'fixture-peer-target',name:'Fixture peer',online:true,deviceKind:'pc',capabilities:['peer-tunnel-v1','rabilink-application-access-v1'],peerUrls:[]}];return peerDirectory.call(this,force)};
      PeerTunnelRuntime.prototype.startLanDiscovery=function(){};
      const lanStart=PeerLanServer.prototype.start;
      PeerLanServer.prototype.start=function(){this.host='127.0.0.1';this.addresses=()=>['127.0.0.1'];return lanStart.call(this)};
      let fixturePeerLanServer;const lanStatus=PeerLanServer.prototype.status;
      PeerLanServer.prototype.status=function(){fixturePeerLanServer=this;return lanStatus.call(this)};
      process.on('message',async message=>{if(message?.kind!=='compiled-peer-lan')return;
        try{if(!fixturePeerLanServer)throw Error('Original Peer LAN server not captured');
          if(message.action==='start')await fixturePeerLanServer.start();
          else if(message.action==='stop')await fixturePeerLanServer.stop();
          else throw Error('Unknown controlled LAN action');
          process.send?.({kind:message.kind,id:message.id,ok:true,address:fixturePeerLanServer.boundAddress()});
        }catch(error){process.send?.({kind:message.kind,id:message.id,ok:false,error:String(error)})}
      });
    `;
  }
  const entry = pathToFileURL(path.join(packageRoot, "dist/manager/controlPlaneRoutes.js")).href;
  const worker = spawn(process.execPath, ["--input-type=module", "--eval", `${prelude}const {startManager}=await import(${JSON.stringify(entry)}); await startManager();`], {
    cwd: stateRoot, windowsHide: true, stdio: nativeFixture || peerFixture ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env,
      ...((peerFixture || contractFixture || nativeFixture) ? { APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), USERPROFILE: path.join(root, "userprofile") } : {}),
      GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: "0", GATEWAY_MANAGER_URL: "",
      RABIROUTE_APPLICATION_GENERATION_ID: generation, RABIROUTE_HOST_CONTROL_TOKEN: controlToken, RABIROUTE_HOSTED: "1",
      RABIROUTE_HOST_EXECUTABLE: "",
      RABIROUTE_MANAGER_AUTOSTART: "0", RABIROUTE_MANAGER_READ_ONLY: readOnly ? "1" : "0", RABIROUTE_MANAGER_ACCEPTANCE_MODE: "1",
      REMOTE_AGENT_DISCOVERABLE: "0", RABIROUTE_HOT_PATCH_WATCH: "0", RABIROUTE_PACKAGE_ROOT: packageRoot,
      RABIROUTE_PLUGIN_PROFILE: profilePath,
      RABIROUTE_STATE_ROOT: stateRoot, ROLES_DIR: path.join(root, "roles"), ROUTE_DIR: path.join(root, "routes"),
      RABIROUTE_MANAGER_INSTANCE_LOCK_DIR: path.join(root, "locks"), RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE: `api-contract-${randomUUID()}` }
  });
  let output = ""; let errors = ""; let ready;
  worker.stderr.on("data", bytes => { errors = (errors + bytes.toString()).slice(-4096); });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const stopped = once(worker, "exit");
      if (ready) await fetch(ready.baseUrl + "/_rabiroute/host/shutdown", {
        method: "POST", headers: { "x-rabiroute-host-token": controlToken }, signal: AbortSignal.timeout(5000)
      }).then(response => response.body?.cancel()).catch(() => {});
      else worker.kill();
      let timer;
      const terminated = await Promise.race([stopped.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 12_000); })]);
      clearTimeout(timer);
      if (!terminated && worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await stopped; }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("api-contract-built-manager-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Isolated Manager startup deadline exceeded: ${errors}`)), 45_000);
    const data = bytes => {
      output = (output + bytes.toString()).slice(-65_536);
      const line = output.split(/\r?\n/).find(line => line.startsWith("RABIROUTE_MANAGER_READY:"));
      if (!line || !output.includes(line + "\n") && !output.includes(line + "\r\n")) return;
      clearTimeout(timer); worker.stdout.off("data", data);
      try { resolve(JSON.parse(line.slice("RABIROUTE_MANAGER_READY:".length))); } catch (error) { reject(error); }
      worker.stdout.resume();
    };
    worker.stdout.on("data", data);
    worker.once("exit", () => { clearTimeout(timer); reject(new Error(`Isolated Manager exited before READY: ${errors}`)); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
  });
  if (nativeFixture) worker.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-262_144); });
  const get = target => fetch(ready.baseUrl + target, { signal: AbortSignal.timeout(10_000) });
  return { root, stateRoot, generation, ready, get, worker, output: () => output };
}

test("compiled original Gateway supervisor retains native publication through failed candidates and replacement", { timeout: 120_000 }, async t => {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const instance = await startBuiltManager(t, false, undefined, undefined, undefined, { port });
  const { ready, get, worker } = instance;
  await waitForNativeRouteCatalog(instance);
  const origin = new URL(ready.baseUrl).origin;
  let managerFetches = 0;
  const client = createManagerClient({ managerUrl: ready.baseUrl, localHost: true,
    endpointSession: { async ensure() { return { managerUrl: ready.baseUrl, meta: await (await get("/meta")).json() }; } },
    fetchImpl(url, options) {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      assert.equal(new URL(target).origin, origin, "Generic client must use the original Manager only.");
      managerFetches++; return fetch(url, options);
    } });
  const path = { id: "CompiledNativeRole__main" };
  const started = await client.invokeOperation("manager.gateway-runtime.start", { path });
  assert.equal(started.statusCode, 200, String(started.body));
  const originalRuntime = JSON.parse(started.body).data.find(value => value.id === path.id);
  assert.ok(Number.isSafeInteger(originalRuntime.pid) && originalRuntime.pid > 0);
  const publications = () => instance.output().split(/\r?\n/).flatMap(line => {
    const offset = line.indexOf("RABIROUTE_GATEWAY_LISTENERS ");
    if (offset < 0) return [];
    try { return [JSON.parse(line.slice(offset + "RABIROUTE_GATEWAY_LISTENERS ".length))]; } catch { return []; }
  });
  const catalog = async () => (await get("/api/lan-agent/capabilities")).json();
  const nativeRead = value => value.operations.find(operation => operation.binding?.kind === "external-listener"
    && operation.method === "GET" && operation.pathTemplate === "/compiled-native");
  const initialCatalog = await pollFixture(catalog, value => Boolean(nativeRead(value)), "original Gateway native listener publication");
  const original = nativeRead(initialCatalog);
  assert.equal(original.binding.address.port, port);
  const publishesOriginalOperation = value => value.listeners.some(listener => listener.binding.leaseId === original.binding.leaseId
    && listener.operations.some(operation => operation.contract.operationId === original.id));
  const published = await pollFixture(async () => publications(), values => values.some(publishesOriginalOperation), "original stdout envelope with its executable contract");
  const envelope = published.find(publishesOriginalOperation);
  assert.equal(envelope.gatewayId, path.id); assert.equal(envelope.pid, originalRuntime.pid);
  assert.ok(envelope.gatewayGenerationId); assert.ok(envelope.revision > 0);
  await pollFixture(async () => instance.output(), value => value.includes(`READY generation=${envelope.gatewayGenerationId}`), "same child's original Gateway READY");
  assert.equal((await client.invokeOperation(original.id)).statusCode, 200);
  const initialPublicationCount = publications().length;
  const initialOwner = original.owner.activationId;
  const initialGeneration = initialCatalog.pluginGenerationId;
  async function candidate(mode) {
    return fixtureChildCommand(worker, "compiled-native-candidate", { mode });
  }
  let retainedGeneration = initialGeneration;
  for (const mode of ["fail-prepare", "fail-publish"]) {
    const failure = await candidate(mode);
    if (mode === "fail-prepare") {
      assert.equal(failure.ok, true, JSON.stringify(failure)); assert.equal(failure.changed, true);
      assert.equal(failure.readiness, "degraded"); assert.equal(failure.record.status, "active");
      assert.match(failure.record.error.message, /compiled candidate prepare failure/);
      assert.equal(failure.record.activationId, initialOwner);
      retainedGeneration = failure.generationId;
    } else {
      assert.equal(failure.ok, false, JSON.stringify(failure)); assert.match(failure.error, /compiled candidate publish failure/);
      assert.equal(failure.generationId, retainedGeneration);
    }
    const retained = nativeRead(await catalog());
    assert.equal(retained.owner.activationId, initialOwner); assert.deepEqual(retained.binding, original.binding);
    assert.equal(failure.record.activationId, initialOwner); assert.equal(failure.record.revision, original.owner.revision);
    const liveRuntime = JSON.parse((await client.invokeOperation("manager.gateway-runtime.list")).body).data.manager.find(value => value.id === path.id);
    assert.equal(liveRuntime.pid, envelope.pid);
    assert.equal((await client.invokeOperation(original.id)).statusCode, 200);
  }
  const replaced = await candidate("replace"); assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.notEqual(replaced.generationId, retainedGeneration);
  const replacement = nativeRead(await catalog());
  assert.notEqual(replacement.owner.activationId, initialOwner);
  assert.deepEqual(replacement.binding, original.binding, "The new projection must inherit the verified original listener lease.");
  const health = await client.invokeOperation(original.id); assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).status, "ready");
  assert.equal(publications().length, initialPublicationCount, "Projection changes must not replay native publication or restart the child.");
  const statuses = JSON.parse((await client.invokeOperation("manager.gateway-runtime.list")).body).data.manager;
  assert.equal(statuses.find(value => value.id === path.id).pid, envelope.pid);
  const message = (await catalog()).operations.find(operation => operation.binding?.leaseId === original.binding.leaseId && operation.method === "POST");
  const malformed = await client.invokeOperation(message.id, { bodyBytes: Buffer.from("{broken"), headers: { "content-type": "image/png" } });
  assert.equal(malformed.statusCode, 500, "Original JSON failure must happen before accepting a business message.");
  assert.equal((await client.invokeOperation("manager.gateway-runtime.stop", { path })).statusCode, 200);
  const retired = await pollFixture(catalog, value => !value.operations.some(operation => operation.binding?.leaseId === original.binding.leaseId), "native listener withdrawal at original stop");
  await pollFixture(async () => JSON.parse((await client.invokeOperation("manager.gateway-runtime.list")).body).data.manager.find(value => value.id === path.id),
    value => value?.pid === null && value.lifecycleState === "stopped", "original Gateway process exit after stop");
  assert.ok(managerFetches > 0);
  console.log(JSON.stringify({ kind: "compiled-original-gateway-native-listener", profile: "required-plugins-plus-gateway-runtime", operationCount: retired.operations.length,
    coverageScope: retired.coverage.scope, globalCoverage: retired.coverage.globalCoverage,
    originalSupervisorSpawn: true, exactChildPidAndGeneration: true, verifiedStdoutPublication: true,
    nativeLeasePreservedAcrossFailedCandidates: true, nativeLeaseInheritedByNewProjection: true,
    nativeChildRestarted: false, publicationReplayed: false, genericClientManagerOnly: true,
    originalNativeReadyAndJsonFailure: true, originalStopWithdrawsListener: true, nativeProcessExitConfirmed: true,
    controlledCandidateSelectionIpc: true, realMessageAccepted: false, realPlatformOrAgentDeliveryTested: false, installedRuntimeTested: false }));
});

async function waitForNativeRouteCatalog({ ready, get }) {
  const { isRouteCatalogSnapshotInstalled } = await import(pathToFileURL(path.join(packageRoot, "dist/manager/routeCatalogStartupHttpGate.js")).href);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Native route catalog did not publish a usable snapshot within 30000ms.")), 30_000);
  let reader;
  try {
    // Subscribe before checking the snapshot so READY between those steps cannot be lost.
    const stream = await fetch(ready.baseUrl + "/api/events?webgui_token=fixture-browser-value", { signal: controller.signal });
    assert.equal(stream.status, 200); reader = stream.body.getReader();
    const meta = await (await get("/meta")).json();
    assert.equal(meta.applicationGenerationId, ready.applicationGenerationId); assert.equal(meta.managerInstanceId, ready.managerInstanceId);
    if (isRouteCatalogSnapshotInstalled(meta.routeLifecycle.catalog)) return;
    let buffered = "";
    for (;;) {
      const frame = await reader.read(); assert.equal(frame.done, false, "Native catalog event stream ended before a snapshot was installed.");
      buffered += Buffer.from(frame.value).toString("utf8").replaceAll("\r\n", "\n");
      let end;
      while ((end = buffered.indexOf("\n\n")) !== -1) {
        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!event.split("\n").some(line => line === "event: route_catalog_startup_changed")) continue;
        const data = JSON.parse(event.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n"));
        assert.ok(!["degraded", "stopped", "stopping"].includes(data.state), "Native catalog startup failed: " + String(data.lastErrorCode ?? data.state));
        if (data.state === "ready") {
          const current = await (await get("/meta")).json();
          assert.equal(current.applicationGenerationId, ready.applicationGenerationId); assert.equal(current.managerInstanceId, ready.managerInstanceId);
          assert.equal(isRouteCatalogSnapshotInstalled(current.routeLifecycle.catalog), true); return;
        }
      }
    }
  } finally { clearTimeout(deadline); await reader?.cancel().catch(() => {}); controller.abort(); }
}

function assertCorePublicContracts(catalog) {
  assert.equal(catalog.operations.filter(operation => operation.id.startsWith("manager.core-public.")).length, 9);
  assert.equal(catalog.operations.filter(operation => operation.id.startsWith("manager.plugins.")).length, 5);
  assert.equal(new Set(catalog.operations.map(operation => operation.id)).size, catalog.operations.length);
  assert.equal(catalog.operations.filter(operation => operation.id.startsWith("manager.webgui-static.")).length, 2);
  assert.equal(catalog.operations.find(operation => operation.id === "manager.webgui-static.distribution").contract.httpProxy.dispatch, "final-fallback");
}

async function waitForWebRelease(client) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await client.invokeOperation("manager.core-public.web-patches.read"); assert.equal(result.statusCode, 200);
    const state = JSON.parse(result.body).data;
    assert.notEqual(state.state, "blocked", "The fixture's native Web release owner failed initialization.");
    if (state.state === "ready" && /^[a-f0-9]{64}$/.test(state.active ?? "")) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail("The fixture's native Web release did not finish within its bounded startup budget.");
}

async function waitForVideoOwner(client) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await client.invokeOperation("manager.video.status");
    if (result.statusCode === 200) return;
    assert.equal(result.statusCode, 503, "Only the native owner startup/drain state may defer this read.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail("The fixture's native video owner did not finish publication within its bounded startup budget.");
}

test("built Manager executes five interactive and fifteen management contracts through an enrolled empty node", { timeout: 90_000 }, async t => {
  const { generation, ready, get } = await startBuiltManager(t, false);
  const meta = await (await get("/meta")).json(); assert.equal(meta.applicationGenerationId, generation);
  const local = createManagerClient({ managerUrl: ready.baseUrl, localHost: true, endpointSession: { async ensure() {
    const current = await (await get("/meta")).json(); assert.equal(current.applicationGenerationId, generation); assert.equal(current.managerInstanceId, meta.managerInstanceId);
    return { managerUrl: ready.baseUrl, meta: current };
  } } });
  const access = await local.invokeOperation("manager.webgui-access.update", { body: { enabled: true } }); assert.equal(access.statusCode, 200);
  const issued = await local.invokeOperation("manager.lan-agent.enrollments.create", { body: {} }); assert.equal(issued.statusCode, 201);
  const ticket = JSON.parse(issued.body).data.ticket, nodeId = "fixture-compiled-interactive-node";
  const enrolled = await local.invokeOperation("manager.lan-agent.enroll.exchange", { body: { ticket, nodeId, enrollmentSecret: "m".repeat(43) } }); assert.equal(enrolled.statusCode, 201);
  const credential = JSON.parse(enrolled.body).data;
  let socket, connectedResolve, connectedReject;
  const sessions = new Map(), calls = [];
  const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  const deadline = setTimeout(() => connectedReject(new Error("Compiled fixture node did not connect.")), 10_000);
  t.after(async () => { clearTimeout(deadline); socket?.close(); if (socket) await socket.closed; });
  const opened = local.openOperation("manager.lan-agent.connect", {
    onOpen: channel => { socket = channel; channel.sendJson({ type: "authenticate", token: credential.token }); },
    onClose: () => { clearTimeout(deadline); connectedReject(new Error("Compiled fixture connection closed.")); },
    onMessage: message => {
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "hello", node: { nodeId, version: "fixture", platform: "fixture", agents: [], agentTypes: ["dsh"], taskTargeting: "explicit-session-v1", terminalShells: ["cmd"], computerCapabilities: ["files"] } }));
      if (message.type === "connected") { clearTimeout(deadline); connectedResolve(); }
      if (message.type === "assignTask") { calls.push(message); socket.send(JSON.stringify({ type: "progress", taskId: message.task.taskId, summary: "compiled task accepted" })); return; }
      if (message.type === "updateAvailable") { calls.push(message); socket.send(JSON.stringify({ type: "updateResult", status: "updated" })); return; }
      if (message.type !== "manageAgent") return;
      calls.push(message); const input = message.params; let result;
      if (message.operation === "computer") result = { path: input.path, size: 11, version: "compiled-fixture", chunkBytes: 65536 };
      else if (message.operation !== "terminal") result = { params: input, operation: message.operation, extension: "compiled-provider" };
      else if (input.action === "list") result = { shells: ["cmd"], sessions: [...sessions.values()] };
      else {
        if (input.action === "open") sessions.set(input.terminalId, { terminalId: input.terminalId, shell: "cmd", cwd: "fixture-compiled-cwd", state: "running", createdAt: new Date().toISOString(), nextInputSequence: 1, pid: 1 });
        const session = sessions.get(input.terminalId);
        if (input.action === "input") { session.nextInputSequence++; socket.send(JSON.stringify({ type: "terminalEvent", event: { terminalId: input.terminalId, type: "output", data: "compiled terminal bytes 汉字" } })); }
        if (input.action === "close") { session.state = "exited"; session.exitCode = 0; socket.send(JSON.stringify({ type: "terminalEvent", event: { terminalId: input.terminalId, type: "exit", exitCode: 0 } })); }
        result = session;
      }
      socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result }));
    }
  });
  await Promise.all([opened, connected]);
  const client = createManagerClient({ managerUrl: ready.baseUrl, credential: credential.token, agentType: "dsh", sessionId: "compiled-full-unregistered-task" });
  const terminalId = randomUUID(), target = { instanceId: nodeId, terminalId };
  const execute = body => client.invokeOperation("manager.lan-agent.terminals.execute", { path: { instanceId: nodeId }, body: { terminalId, ...body } });
  assert.equal((await execute({ action: "open", shell: "cmd" })).statusCode, 200);
  const list = await client.invokeOperation("manager.lan-agent.terminals.list", { path: { instanceId: nodeId } }); assert.equal(list.statusCode, 200); assert.equal(JSON.parse(list.body).data.sessions.length, 1);
  let announce; const started = new Promise(resolve => { announce = resolve; }); let output = "";
  const stream = client.invokeOperation("manager.lan-agent.terminals.events", { path: target, onChunk: bytes => { output += bytes.toString(); announce(); } });
  await started; assert.equal((await execute({ action: "input", sequence: 1, data: "fixture input once" })).statusCode, 200);
  const read = await client.invokeOperation("manager.lan-agent.terminals.read", { path: target, query: { after: 0, waitMs: 0 } }); assert.equal(read.statusCode, 200); assert.equal(JSON.parse(read.body).data.nextOutputSequence, 1);
  const stat = await client.invokeOperation("manager.lan-agent.computer.execute", { path: { instanceId: nodeId }, body: { action: "file.stat", path: "fixture-path" } }); assert.equal(stat.statusCode, 200); assert.equal(JSON.parse(stat.body).data.size, 11);
  assert.equal((await execute({ action: "close" })).statusCode, 200); assert.equal((await stream).statusCode, 200);
  assert.match(output, /compiled terminal bytes 汉字/); assert.match(output, /"type":"exit"/);
  assert.equal(calls.filter(call => call.params?.action === "input").length, 1);
  const invoke = (key, options = {}) => client.invokeOperation('manager.lan-agent.' + key, options);
  const self = await invoke("self.read"); assert.equal(self.statusCode, 200); assert.equal(JSON.parse(self.body).data.nodeId, nodeId);
  const instances = await invoke("instances.list"); assert.equal(instances.statusCode, 200); assert.deepEqual(JSON.parse(instances.body).instances.find(row => row.instanceId === nodeId).agents, []);
  const nodes = await invoke("nodes.list"); assert.equal(nodes.statusCode, 200); assert.ok(JSON.parse(nodes.body).nodes.some(row => row.nodeId === nodeId));
  const renamed = await invoke("instances.name", { path: { instanceId: nodeId }, body: { name: "Compiled fixture", expectedName: "" } }); assert.equal(renamed.statusCode, 200);
  for (const key of ["create", "configure", "scan", "threads", "hooks"]) {
    const result = await invoke('agents.' + key, { path: key === "create" ? { instanceId: nodeId } : { instanceId: nodeId, agentId: "selected-provider" }, body: { agentAdapter: "dsh", extension: "forwarded" } });
    assert.equal(result.statusCode, 200, String(result.body)); assert.equal(JSON.parse(result.body).result.extension, "compiled-provider");
  }
  const taskBody = { targetAgent: "dsh", threadId: "compiled-target-session", message: "compiled original task", idempotencyKey: "compiled-stable-node-key" };
  const task = await invoke("nodes.tasks", { path: { nodeId }, body: taskBody }); assert.equal(task.statusCode, 202, String(task.body));
  const repeated = await invoke("nodes.tasks", { path: { nodeId }, body: taskBody }); assert.equal(repeated.statusCode, 202);
  assert.equal(JSON.parse(repeated.body).result.taskId, JSON.parse(task.body).result.taskId);
  const instanceTask = await invoke("agents.tasks", { path: { instanceId: nodeId, agentId: "display-only" }, body: { provider: "dsh", threadId: "compiled-target-session", message: "compiled instance task", idempotencyKey: "compiled-stable-instance-key" } }); assert.equal(instanceTask.statusCode, 200);
  assert.equal(calls.filter(call => call.type === "assignTask").length, 2);
  assert.equal((await invoke("nodes.update", { path: { nodeId }, body: {} })).statusCode, 202);
  const updateSignal = await new Promise(resolve => { const update = calls.find(call => call.type === "updateAvailable"); if (update) resolve(update); else socket.once("message", () => resolve(calls.find(call => call.type === "updateAvailable"))); }); assert.ok(updateSignal);
  for (const [enabled, expectedEnabled] of [[false, true], [true, false]]) {
    const result = await local.invokeOperation("manager.lan-agent.instances.enabled", { path: { instanceId: nodeId }, body: { enabled, expectedEnabled } }); assert.equal(result.statusCode, 200, String(result.body));
  }
  const recovered = await local.invokeOperation("manager.lan-agent.enroll.exchange", { body: { nodeId, enrollmentSecret: "m".repeat(43) } }); assert.equal(recovered.statusCode, 201); assert.deepEqual(JSON.parse(recovered.body).data, credential);
  const published = await local.catalog.refresh();
  const managementOperations = published.operations.filter(operation => /^manager\.lan-agent\.(?:self\.read|enrollments\.|enroll\.|instances\.|agents\.|nodes\.)/.test(operation.id));
  const interactiveOperations = published.operations.filter(operation => /^manager\.lan-agent\.(?:terminals\.|computer\.)/.test(operation.id));
  assert.equal(managementOperations.length, 15); assert.equal(interactiveOperations.length, 5);
  console.log(JSON.stringify({ kind: "compiled-management-owner", profile: "required-plugins", operationScope: "owner-subset", operationCount: managementOperations.length, profileOperationCount: published.operations.length, coverageScope: published.coverage.scope, globalCoverage: published.coverage.globalCoverage, nodeAgentRegistrations: 0, duplicateTasksRedispatched: false, transport: "isolated-loopback-http-and-authenticated-ws", realRemoteComputerTested: false }));
  console.log(JSON.stringify({ kind: "compiled-interactive-owner", profile: "required-plugins", operationScope: "owner-subset", operationCount: interactiveOperations.length, profileOperationCount: published.operations.length, coverageScope: published.coverage.scope, globalCoverage: published.coverage.globalCoverage, nodeAgentRegistrations: 0, transport: "isolated-loopback-http-and-authenticated-ws", realRemoteComputerTested: false }));
});

test("compiled peer plugin publishes seven fixed HTTP proxies, native fallback and a transparent upgrade", { timeout: 90_000 }, async t => {
  const paths = [], headers = [], frames = [], httpCalls = [];
  const targetContract = "sha256:" + "e".repeat(64);
  const httpBytes = Buffer.alloc(256 * 1024, 191);
  const upstream = http.createServer((request, response) => {
    if (!request.url.startsWith("/future-http/")) { response.end("ordinary peer HTTP"); return; }
    httpCalls.push({ method: request.method, path: request.url, headers: request.headers });
    if (request.headers["x-rabiroute-api-contract"] !== targetContract) { response.writeHead(409).end(); return; }
    response.setHeader("content-type", "application/x-future-binary"); response.setHeader("x-future-header", ["a", "b"]);
    response.setHeader("x-rabiroute-api-contract", "original-target-response");
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) response.end(httpBytes);
    else { response.statusCode = 201; request.pipe(response); }
  });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  upstream.on("upgrade", (request, socket, head) => {
    paths.push(request.url); headers.push(request.headers);
    if (request.headers["x-rabiroute-api-contract"] !== targetContract) { socket.end("HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n"); return; }
    sockets.handleUpgrade(request, socket, head, channel => sockets.emit("connection", channel, request));
  });
  sockets.on("connection", (channel, request) => {
    let cliFrames = 0;
    channel.on("message", (data, binary) => {
      frames.push(Buffer.from(data)); channel.send(data, { binary });
      if (request.url === "/cli-echo" && ++cliFrames === 2) channel.close(1000, "CLI capture complete");
    });
  });
  const relay = http.createServer((request, response) => {
    if (new URL(request.url, "http://fixture").pathname === "/api/rabilink/peers" && request.headers["x-rabilink-token"] === "fixture-application") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ peers: [
        { id: "fixture-relay-pc", name: "Discovered PC", deviceKind: "pc", online: true, capabilities: [], peerUrls: [], extension: "preserved" },
        { id: "fixture-relay-phone", name: "Discovered phone", deviceKind: "phone", online: false, capabilities: [], peerUrls: [] }
      ] })); return;
    }
    response.writeHead(503, { "content-type": "application/json" }).end('{"code":-1}');
  });
  await Promise.all([new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve)), new Promise(resolve => relay.listen(0, "127.0.0.1", resolve))]);
  t.after(async () => {
    for (const channel of sockets.clients) channel.terminate(); await new Promise(resolve => sockets.close(resolve));
    upstream.closeAllConnections(); relay.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => relay.close(resolve))]);
  });
  const { root, stateRoot, ready, generation, get, worker } = await startBuiltManager(t, false, undefined, {
    relayUrl: `http://127.0.0.1:${relay.address().port}`, targetUrl: `http://127.0.0.1:${upstream.address().port}`
  });
  const local = createManagerClient({ managerUrl: ready.baseUrl, localHost: true, endpointSession: { async ensure() {
    const meta = await (await get("/meta")).json(); assert.equal(meta.applicationGenerationId, generation); return { managerUrl: ready.baseUrl, meta };
  } } });
  assert.equal((await local.invokeOperation("manager.webgui-access.update", { body: { enabled: true } })).statusCode, 200);
  const issued = await local.invokeOperation("manager.lan-agent.enrollments.create", { body: {} });
  assert.equal(issued.statusCode, 201); const ticket = JSON.parse(issued.body).data.ticket;
  const enrollment = await local.invokeOperation("manager.lan-agent.enroll.exchange", { body: { ticket, nodeId: "fixture-peer-node", enrollmentSecret: "p".repeat(43) } });
  assert.equal(enrollment.statusCode, 201); const credential = JSON.parse(enrollment.body).data;
  const client = createManagerClient({ managerUrl: ready.baseUrl, credential: credential.token });
  const help = await client.catalog.refresh(), entry = help.operations.find(value => value.id === "manager.rabilink.peer.websocket.proxy");
  assertCorePublicContracts(help);
  const lanStarted = await fixtureChildCommand(worker, "compiled-peer-lan", { action: "start" });
  assert.equal(lanStarted.ok, true, JSON.stringify(lanStarted)); assert.ok(lanStarted.address.port > 0);
  const lanCatalog = await pollFixture(() => client.catalog.refresh(), value => value.listeners.some(listener => listener.binding.listenerId === "manager.rabilink.peer.lan"), "original bound Peer LAN listener metadata");
  const lanListener = lanCatalog.listeners.find(listener => listener.binding.listenerId === "manager.rabilink.peer.lan");
  assert.equal(lanListener.binding.address.port, lanStarted.address.port);
  assert.equal(lanListener.binding.invocation, "discovery-only"); assert.equal(lanListener.binding.authentication.kind, "native");
  assert.equal(lanListener.owner.activationId, entry.owner.activationId);
  const lanPublicOperations = lanCatalog.operations.filter(operation => operation.binding?.leaseId === lanListener.binding.leaseId);
  assert.equal(lanPublicOperations.length, 0, "The existing encrypted Peer protocols must not become public business operations.");
  assert.equal(lanCatalog.operations.length, help.operations.length);
  assert.ok(entry); assert.equal(entry.contract.websocket.framing, "passthrough");
  assert.equal(entry.contract.request.pathRemainder, "path"); assert.equal(entry.contract.websocket.maxMessageBytes, undefined);
  assert.equal(entry.contract.websocket.wire.dataFrameBytes, 12000); assert.equal(help.coverage.globalCoverage, "not-proven");
  assert.deepEqual(help.coverage.gaps, [], "This explicit profile must retire every registered legacy dispatcher; global coverage remains separately audited.");
  assert.ok(help.operations.some(value => value.id === "manager.rabilink.peer.list"));
  const discovered = await client.invokeOperation("manager.rabilink.peer.list", { query: { deviceKind: "pc", online: "true" } });
  assert.equal(discovered.statusCode, 200);
  const discoveredPage = JSON.parse(discovered.body);
  assert.deepEqual(discoveredPage.summary, { total: 1, online: 1, byDeviceKind: { pc: 1 } });
  assert.equal(discoveredPage.peers[0].id, "fixture-relay-pc"); assert.equal(discoveredPage.peers[0].extension, "preserved");
  assert.ok(!help.operations.some(value => value.id === "manager.rabilink.peer.receive"), "Encrypted receive retains its existing private boundary.");
  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.rabilink.peer.rabilink-peer"), "The old Peer dynamic dispatcher is retired.");
  const personaBootstrap = await client.invokeOperation("manager.rabilink.peer.persona.bootstrap", { body: { deviceId: "fixture-peer-target" } });
  assert.equal(personaBootstrap.statusCode, 200); assert.deepEqual(JSON.parse(personaBootstrap.body), { code: 0, data: { deviceId: "fixture-peer-target" } });
  const rejectedDevice = await client.invokeOperation("manager.rabilink.peer.device-bootstrap", { body: {} });
  assert.equal(rejectedDevice.statusCode, 403); assert.equal(JSON.parse(rejectedDevice.body).error, "DEVICE_PEER_BOOTSTRAP_DENIED");
  const { sealPeerPacket, openPeerPacket } = await import(pathToFileURL(path.join(packageRoot, "dist/rabiPeerProtocol.js")).href);
  const peerIdentity = JSON.parse((await client.invokeOperation("manager.rabilink.peer.identity.read")).body);
  const privatePacket = sealPeerPacket({ requestId: "compiled-private-probe", targetDeviceId: peerIdentity.deviceId, capability: "system", operation: "describe", input: {}, expiresAt: Date.now() + 10000 }, "fixture-application");
  const privateResult = await client.request("POST", "/api/rabilink/peer/receive", { body: privatePacket });
  assert.equal(privateResult.statusCode, 200); assert.equal(openPeerPacket(JSON.parse(privateResult.body), "fixture-application").ok, true);
  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.persona.api.language-style-validate"));
  const styleDir = path.join(root, "compiled-style"); await fs.mkdir(path.join(styleDir, "references"), { recursive: true });
  await fs.writeFile(path.join(styleDir, "references/style-data.json"), JSON.stringify({ runtimeConstraints: { checks: [
    { id: "COMPILED-STYLE", level: "error", kind: "forbidden_phrases", values: ["compiled forbidden phrase"], message: "fixture style result" }
  ] } }));
  const styleResult = await client.invokeOperation("manager.language-style.validate", { body: { text: "compiled forbidden phrase", styleSkillUrl: styleDir, scope: "final", prompt: 7 } });
  assert.equal(styleResult.statusCode, 200); const styleData = JSON.parse(styleResult.body).data;
  assert.equal(styleData.passed, false); assert.equal(styleData.status, "failed"); assert.equal(styleData.violations[0].ruleId, "COMPILED-STYLE");
  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.persona.api.personas"));
  await waitForNativeRouteCatalog({ ready, get });
  const personaDirectory = await client.invokeOperation("manager.personas.list", { query: { addressable: ["false", "true"], ignored: "native-query" } });
  assert.equal(personaDirectory.statusCode, 200); assert.deepEqual(JSON.parse(personaDirectory.body), { code: 0, personas: [] });
  const directoryAlias = await client.invokeOperation("agent:GET:/api/personas"); assert.equal(directoryAlias.statusCode, 200); assert.deepEqual(JSON.parse(directoryAlias.body).personas, []);
  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.persona.api.personas-resource"));
  const absentPersona = await client.invokeOperation("manager.personas.read", { path: { personaId: "AbsentCompiledPersona" } }); assert.equal(absentPersona.statusCode, 404);
  const { executeDurableDelivery } = await import(pathToFileURL(path.join(packageRoot, "dist/manager/durableDeliveryIdempotency.js")).href);
  const persisted = await executeDurableDelivery({ rootDir: stateRoot, namespace: "persona-message-idempotency", deliveryId: "compiled-persona-receipt", payload: { fixture: "receipt read owner" }, deliver: async () => ({ status: "delivered", fixture: "controlled receipt result; no Agent prompt" }) }); assert.equal(persisted.state, "completed");
  const personaReceipt = await client.invokeOperation("manager.personas.messages.receipt", { path: { deliveryId: "compiled-persona-receipt" } }); assert.equal(personaReceipt.statusCode, 200); assert.equal(JSON.parse(personaReceipt.body).receipt.result.fixture, "controlled receipt result; no Agent prompt");
  const receiptAlias = await client.invokeOperation("agent:GET:/api/personas/messages/receipts/:deliveryId", { path: { deliveryId: "compiled-persona-receipt" } }); assert.equal(receiptAlias.statusCode, 200);
  const rejectedPersonaSend = await client.invokeOperation("manager.personas.messages.send", { path: { personaId: "AbsentCompiledPersona" }, body: { deliveryId: "compiled-persona-no-dispatch", sourceRouteId: "absent-source", sourceCapability: "fixture-source-proof", text: "never dispatched" } }); assert.equal(rejectedPersonaSend.statusCode, 404);
  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.rabilink.video.rabilink-video"));
  const directVideo = await client.invokeOperation("manager.rabilink.video.status"); assert.equal(directVideo.statusCode, 200); assert.deepEqual(JSON.parse(directVideo.body), { sessions: [], relay: false });
  const invalidVideo = await client.invokeOperation("manager.rabilink.video.offer", { body: { deviceId: "compiled-camera", sdp: "invalid-direct-sdp" } }); assert.equal(invalidVideo.statusCode, 400);
  const afterInvalidVideo = await client.invokeOperation("manager.rabilink.video.status"); assert.equal(afterInvalidVideo.statusCode, 200); assert.deepEqual(JSON.parse(afterInvalidVideo.body).sessions, []);
  const profileOperations = help.operations.filter(value => value.id.startsWith("manager.rabilink.agent-devices.") || value.id === "manager.rabilink.persona-template.read");
  assert.equal(profileOperations.length, 6);
  assert.ok(!help.coverage.gaps.some(value => /agent-device-directory|agent-device-profile/.test(value.routeId)));
  const deviceProfiles = await client.invokeOperation("manager.rabilink.agent-devices.list"); assert.equal(deviceProfiles.statusCode, 200); assert.deepEqual(JSON.parse(deviceProfiles.body), { code: 0, data: { devices: [], sourceDeviceId: "fixture-source" } });
  const invalidTemplate = await client.invokeOperation("manager.rabilink.persona-template.read", { body: { roleId: "Fixture", skillIds: ["same", "same"] } }); assert.equal(invalidTemplate.statusCode, 400);
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.rabilink.mobile.') || value.id === 'manager.rabilink.devices.health-capabilities.read').length, 7);
  assert.ok(!help.coverage.gaps.some(value => value.routeId === 'manager.rabilink.owners.mobile-state-owner'));
  const healthCapabilities = await client.invokeOperation('manager.rabilink.devices.health-capabilities.read'); assert.equal(healthCapabilities.statusCode, 200);
  assert.deepEqual(JSON.parse(healthCapabilities.body), { rabilinkWearableObservation: { processingPolicies: ['transcribe', 'agent'], expectedWorkerFencing: true, processingPolicyFrozen: true } });
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.personas.resources.')).length, 6);
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.personas.plans.')).length, 8);
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.personas.history.')).length, 11);
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.personas.skills.')).length, 6);
  const resourceRole = path.join(root, 'roles/CompiledResourceRole'); await fs.mkdir(resourceRole, { recursive: true });
  await fs.writeFile(path.join(resourceRole, 'persona.md'), '# Compiled resource\n');
  const { ensurePersonaPlanWorkflow } = await import(pathToFileURL(path.join(packageRoot, 'dist/personaPlanWorkflow.js')).href);
  ensurePersonaPlanWorkflow(resourceRole);
  const resourceDocument = await client.invokeOperation('manager.personas.resources.document.read', { path: { roleId: 'CompiledResourceRole' } }); assert.equal(resourceDocument.statusCode, 200); assert.equal(resourceDocument.body, '# Compiled resource\n');
  const nativeChatHistory = await client.invokeOperation('manager.personas.history.chat.read', { path: { roleId: 'CompiledResourceRole' } }); assert.equal(nativeChatHistory.statusCode, 200); assert.deepEqual(JSON.parse(nativeChatHistory.body).data.entries, []);
  const nativeSkills = await client.invokeOperation('manager.personas.skills.list', { path: { roleId: 'CompiledResourceRole' } }); assert.equal(nativeSkills.statusCode, 200); assert.deepEqual(JSON.parse(nativeSkills.body).data, []);
  for (const [prefix, count] of [['manager.personas.knowledge.', 5], ['manager.personas.identities.', 10], ['manager.personas.storage.', 58], ['manager.personas.health.', 14], ['manager.personas.companion.', 8], ['manager.personas.recording.', 24], ['manager.roles.', 8]]) {
    assert.equal(help.operations.filter(value => value.id.startsWith(prefix)).length, count, prefix);
  }
  const rolePath = { roleId: 'CompiledResourceRole' };
  const nativeIdentity = await client.invokeOperation('manager.personas.identities.relations.read', { path: rolePath }); assert.equal(nativeIdentity.statusCode, 200); assert.equal(JSON.parse(nativeIdentity.body).code, 0);
  const nativeHealth = await client.invokeOperation('manager.personas.health.config.read', { path: rolePath }); assert.equal(nativeHealth.statusCode, 200); assert.equal(JSON.parse(nativeHealth.body).data.schemaVersion, 1);
  const nativeWorkflow = await client.invokeOperation('manager.personas.storage.plan-statuses.read', { path: rolePath }); assert.equal(nativeWorkflow.statusCode, 200);
  const compiledPlan = { id: 'compiled-contract-plan', title: 'Compiled contract plan', focus: 'Isolated native storage', keywords: ['compiled-fixture'], status: '分析中', steps: [{ id: 'verify', title: 'Verify' }], currentStepId: 'verify' };
  const createdPlan = await client.invokeOperation('manager.personas.storage.plans.create', { path: rolePath, headers: { 'idempotency-key': 'compiled-storage-create' }, body: compiledPlan }); assert.equal(createdPlan.statusCode, 201, createdPlan.body);
  const createdPlanData = JSON.parse(createdPlan.body).data; assert.equal(createdPlanData.id, compiledPlan.id); assert.ok(createdPlan.headers.etag);
  const planPath = { ...rolePath, planId: compiledPlan.id };
  const readPlan = await client.invokeOperation('manager.personas.storage.plans.read', { path: planPath }); assert.equal(readPlan.statusCode, 200); assert.equal(JSON.parse(readPlan.body).data.title, compiledPlan.title);
  const patchedPlan = await client.invokeOperation('manager.personas.storage.plans.update', { path: planPath, headers: { 'idempotency-key': 'compiled-storage-update', 'if-match': readPlan.headers.etag }, body: { title: 'Compiled readback verified' } }); assert.equal(patchedPlan.statusCode, 200, patchedPlan.body);
  const readPlanAlias = await client.invokeOperation('persona:GET:/roles/:roleId/plans/:planId', { path: planPath }); assert.equal(readPlanAlias.statusCode, 200); assert.equal(JSON.parse(readPlanAlias.body).data.title, 'Compiled readback verified');
  const missingRole = await client.invokeOperation('manager.roles.detail', { path: { roleId: 'AbsentCompiledRole' } }); assert.equal(missingRole.statusCode, 404, missingRole.body);
  const lifecycleRole = { roleId: 'CompiledLifecycleRole' };
  const createdRole = await client.invokeOperation('manager.roles.create', { body: { ...lifecycleRole, title: 'Compiled lifecycle fixture' } }); assert.equal(createdRole.statusCode, 201, createdRole.body);
  const currentRole = await client.invokeOperation('manager.roles.detail', { path: lifecycleRole }); assert.equal(currentRole.statusCode, 200);
  const roleRevision = JSON.parse(currentRole.body).data.revision;
  const changedRole = await client.invokeOperation('manager.roles.config', { path: lifecycleRole, headers: { 'idempotency-key': 'compiled-role-config-write' }, body: { expectedRevision: roleRevision, config: { speechTriggerKeywords: ['compiled-fixture-only'] } } }); assert.equal(changedRole.statusCode, 200, changedRole.body);
  const roleReadback = await client.invokeOperation('manager.roles.detail', { path: lifecycleRole }); assert.equal(roleReadback.statusCode, 200); assert.deepEqual(JSON.parse(roleReadback.body).data.config.speechTriggerKeywords, ['compiled-fixture-only']);
  assert.equal(help.operations.filter(value => value.id.startsWith('manager.device-agents.')).length, 13);
  assert.ok(help.operations.find(value => value.id === 'manager.device-agents.list').contract.aliases.includes('device-agent:GET:/api/device-agents'));
  assert.ok(!help.coverage.gaps.some(value => /device-agent-directory|device-agent-owner/.test(value.routeId)));

  assert.ok(!help.coverage.gaps.some(value => value.routeId === "manager.persona.api.role-panel-messages"));
  const timelineDir = path.join(root, "roles/CompiledPanelRole/role-panel"); await fs.mkdir(timelineDir, { recursive: true });
  await fs.writeFile(path.join(timelineDir, "messages.jsonl"), JSON.stringify({ id: "compiled-panel-message", time: 1, roleId: "CompiledPanelRole", direction: "user", sender: "Fixture", text: "native read-owner message", attachments: [], status: "sent" }) + "\n");
  const timeline = await client.invokeOperation("manager.role-panel.messages.list", { path: { roleId: "CompiledPanelRole" }, query: { limit: "1" } });
  assert.equal(timeline.statusCode, 200); assert.equal(JSON.parse(timeline.body).messages[0].id, "compiled-panel-message");
  const aliasedTimeline = await client.invokeOperation("persona:GET:/api/roles/:roleId/role-panel/messages", { path: { roleId: "CompiledPanelRole" } });
  assert.equal(aliasedTimeline.statusCode, 200); assert.equal(JSON.parse(aliasedTimeline.body).roleId, "CompiledPanelRole");
  const missingTarget = await client.invokeOperation("manager.role-panel.messages.send", { body: { gatewayId: "__absent_panel_gateway__", text: "never dispatched" } });
  assert.equal(missingTarget.statusCode, 400); assert.equal(JSON.parse(missingTarget.body).commitState, "not_started");
  const ordinary = await client.request("GET", "/api/rabilink/peer/http/fixture-peer-target/manager/echo");
  assert.equal(ordinary.statusCode, 200); assert.equal(ordinary.body, "ordinary peer HTTP");
  const httpContracts = help.operations.filter(value => value.id.startsWith("manager.rabilink.peer.http."));
  const fixedMethods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
  const fixedHttp = httpContracts.filter(operation => operation.contract.method !== "*");
  const proxyPath = "/api/rabilink/peer/http/:deviceId/:service/:path";
  assert.deepEqual(fixedHttp.map(operation => [operation.id, operation.contract.method, operation.contract.pathTemplate]).sort(),
    fixedMethods.map(method => ["manager.rabilink.peer.http." + method.toLowerCase(), method, proxyPath]).sort());
  const fallbackHttp = httpContracts.filter(operation => operation.contract.method === "*");
  assert.equal(fallbackHttp.length, 1); assert.equal(fallbackHttp[0].id, "manager.rabilink.peer.http.fallback");
  assert.equal(fallbackHttp[0].contract.pathTemplate, proxyPath); assert.equal(fallbackHttp[0].contract.request.pathRemainder, "path");
  assert.equal(new Set(httpContracts.map(operation => operation.id)).size, httpContracts.length);
  for (const { operation, method } of [...fixedHttp.map(operation => ({ operation, method: operation.contract.method })), { operation: fallbackHttp[0], method: "PROPFIND" }]) {
    assert.equal(operation.contract.request.body.kind, "passthrough"); assert.equal(operation.contract.httpProxy.wire.dataFrameBytes, 12000);
    const response = await client.invokeOperation(operation.id, { path: { deviceId: "fixture-peer-target", service: "manager", path: "future-http//%E6%B1%89" },
      ...(operation.contract.method === "*" ? { method } : {}),
      responseMode: "bytes", ...(["GET", "HEAD", "OPTIONS"].includes(method) ? {} : { bodyBytes: httpBytes }),
      headers: { "x-rabiroute-api-contract": targetContract, "idempotency-key": "original-request",
        "x-rabiroute-target-headers": JSON.stringify({ "x-rabiroute-expected-manager-instance-id": "target-manager" }) } });
    assert.equal(response.statusCode, ["GET", "HEAD", "OPTIONS"].includes(method) ? 200 : 201, method);
    assert.deepEqual(response.bodyBytes, method === "HEAD" ? Buffer.alloc(0) : httpBytes);
    assert.equal(response.headers["x-rabiroute-api-contract"], "original-target-response"); assert.equal(response.headers["x-future-header"], "a, b");
    const call = httpCalls.at(-1); assert.equal(call.path, "/future-http//%E6%B1%89"); assert.equal(call.method, method);
    assert.equal(call.headers["x-rabiroute-expected-manager-instance-id"], "target-manager"); assert.equal(call.headers["idempotency-key"], "original-request");
    assert.equal(call.headers.authorization, undefined); assert.equal(call.headers["x-rabiroute-proxy-contract"], undefined);
  }
  const controlIds = ["servers.read", "selection.read", "identity.read", "probe", "selection.update", "events"].map(id => "manager.rabilink.peer." + id);
  for (const id of controlIds) assert.ok(help.operations.some(value => value.id === id));
  const directory = await client.invokeOperation(controlIds[0]); assert.equal(directory.statusCode, 200);
  assert.equal(JSON.parse(directory.body).peers[0].deviceId, "fixture-peer-target");
  const identity = await client.invokeOperation("manager.rabilink.peer.identity.read"); assert.equal(identity.statusCode, 200);
  const publicIdentity = JSON.parse(identity.body); assert.equal(typeof publicIdentity.publicKey, "string"); assert.equal(publicIdentity.privateKey, undefined);
  const probe = await client.invokeOperation("manager.rabilink.peer.probe", { body: { deviceIds: [] } }); assert.equal(probe.statusCode, 200);
  const eventStop = new AbortController(); let connected, changed;
  const connectionReady = new Promise(resolve => { connected = resolve; }), selectionChanged = new Promise(resolve => { changed = resolve; });
  let events = "";
  const subscription = client.invokeOperation("manager.rabilink.peer.events", { signal: eventStop.signal, responseMode: "stream", onChunk(bytes) {
    events += Buffer.from(bytes).toString(); if (events.includes(": connected")) connected(); if (events.includes('event: selection\ndata: {"selectedDeviceId":""}')) changed();
  } }).catch(() => undefined);
  t.after(async () => { eventStop.abort(); await subscription; });
  await connectionReady;
  const selected = await client.invokeOperation("manager.rabilink.peer.selection.update", { body: { deviceId: "" } }); assert.equal(selected.statusCode, 200);
  const currentSelection = await client.invokeOperation("manager.rabilink.peer.selection.read"); assert.equal(currentSelection.statusCode, 200);
  assert.equal(JSON.parse(currentSelection.body).selectedDeviceId, ""); await selectionChanged; eventStop.abort(); await subscription;
  let textReady, binaryReady;
  const text = new Promise(resolve => { textReady = resolve; }), binary = new Promise(resolve => { binaryReady = resolve; });
  const channel = await client.openOperation(entry.id, { path: { deviceId: "fixture-peer-target", service: "manager", path: "echo//%E6%B1%89" },
    protocols: ["fixture.peer.v1"], headers: { "x-rabiroute-api-contract": targetContract,
      "x-rabiroute-target-headers": JSON.stringify({ "x-rabiroute-expected-manager-instance-id": "target-instance", "x-future-header": "future" }) },
    onMessage: (value, metadata) => (metadata.binary ? binaryReady : textReady)(value) });
  t.after(async () => { channel.close(); await channel.closed; });
  assert.equal(channel.protocol, "fixture.peer.v1"); channel.send("compiled opaque text"); assert.equal(await text, "compiled opaque text");
  const bytes = Buffer.alloc(256 * 1024, 191); channel.send(bytes); assert.deepEqual(await binary, bytes);
  assert.equal(paths[0], "/echo//%E6%B1%89"); assert.equal(headers[0]["x-rabiroute-proxy-contract"], undefined);
  assert.equal(headers[0]["x-rabiroute-api-contract"], targetContract); assert.equal(headers[0]["x-rabiroute-expected-manager-instance-id"], "target-instance");
  assert.equal(headers[0]["x-future-header"], "future"); assert.equal(headers[0].authorization, undefined); assert.equal(frames.length, 2);
  channel.close(); await channel.closed;
  const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compiled-api-cli-ws-"));
  const cliConfig = path.join(cliRoot, "config.json"), cliOutput = path.join(cliRoot, "frames.jsonl");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(cliRoot)), path.resolve(os.tmpdir()));
    await fs.rm(cliRoot, { recursive: true, force: true });
  });
  await fs.writeFile(cliConfig, JSON.stringify({ managerUrl: ready.baseUrl, nodeCredential: credential.token }), { mode: 0o600 });
  const cli = spawn(process.execPath, [path.join(packageRoot, "apps/rabi-agent/rabi-agent.mjs"), "--config", cliConfig,
    "--operation", entry.id, "--websocket", "--output", cliOutput, "--frames-stdin", "--agent-type", "dsh", "--id", "fixture-cli-full-source",
    "--path-params", JSON.stringify({ deviceId: "fixture-peer-target", service: "manager", path: "cli-echo" }),
    "--header", "x-rabiroute-api-contract: " + targetContract, "--timeout-ms", "10000"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (cli.exitCode === null) cli.kill(); });
  let cliStdout = "", cliStderr = ""; cli.stdout.on("data", chunk => { cliStdout += chunk; }); cli.stderr.on("data", chunk => { cliStderr += chunk; });
  const cliExited = once(cli, "exit"), cliBytes = Buffer.from([0, 255, 128, 10]);
  cli.stdin.end(JSON.stringify({ type: "text", data: "compiled CLI text" }) + "\n" + JSON.stringify({ type: "binary", data: cliBytes.toString("base64") }) + "\n");
  assert.equal((await cliExited)[0], 0, cliStderr);
  const cliReceipt = JSON.parse(cliStdout); assert.equal(cliReceipt.ok, true); assert.equal(cliReceipt.framesSent, 2); assert.equal(cliReceipt.framesReceived, 2);
  assert.equal(cliStdout.includes(credential.token), false); assert.equal(cliReceipt.businessOutcome, "not-evaluated");
  assert.deepEqual((await fs.readFile(cliOutput, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [
    { type: "text", data: "compiled CLI text" }, { type: "binary", data: cliBytes.toString("base64") }
  ]);
  const lanStopped = await fixtureChildCommand(worker, "compiled-peer-lan", { action: "stop" }); assert.equal(lanStopped.ok, true);
  await pollFixture(() => client.catalog.refresh(), value => !value.listeners.some(listener => listener.binding.leaseId === lanListener.binding.leaseId), "Peer LAN metadata withdrawal after original socket stop");
  console.log(JSON.stringify({ kind: "compiled-peer-upgrade-owner", profile: "required-plugins-plus-remote-hub-and-peer", operationCount: help.operations.length, coverageScope: help.coverage.scope, globalCoverage: help.coverage.globalCoverage, registeredLegacyRouteCount: help.coverage.gaps.length,
    registeredLegacyRoutes: help.coverage.gaps.map(({ instanceId, routeId, kind }) => ({ instanceId, routeId, kind })),
    encryptedNativeSessions: true, controlledTargetResolverAndDiscovery: true, controlledApplicationBootstrapReadiness: true, ordinaryHttpPreserved: true, httpProxyOperationCount: httpContracts.length, peerControlOperationCount: controlIds.length, executableRelayDiscovery: true, executablePersonaBootstrap: true, deviceSourceProofRetained: true, encryptedPrivateReceiveBound: true, peerLegacyDispatcherRetired: true, nativeLanguageStyleValidation: true, nativeDirectVideoStatusOwner: true, directVideoValidationBeforeAllocation: true, directVideoMediaTested: false, nativePersonaReceiptOwner: true, controlledPersonaReceiptResult: true, personaMessagingAgentDeliveryTested: false, nativePersonaDirectoryOwner: true, personaDirectoryLegacyAliasResolved: true, nativeRolePanelReadOwner: true, rolePanelLegacyAliasResolved: true, rolePanelValidationBeforeDispatch: true, rolePanelAgentDeliveryTested: false, nativeSelectionAndEvents: true, actualTextAndBinary: true, actualCliWebSocketProcess: true,
    originalPeerLanBoundSocket: true, nativePeerLanMetadata: true, nativePeerLanPublicOperations: lanPublicOperations.length, nativePeerLanWithdrawal: true, controlledPeerLanLifecycle: true,
    realRemoteComputerTested: false, fullMigrationComplete: false }));
});

test("compiled Remote Agent plugin publishes seven operations and uses its real v3 bridge owner", { timeout: 90_000 }, async t => {
  const bridge = http.createServer(), sockets = new WebSocketServer({ noServer: true });
  const password = randomBytes(24).toString("base64url"), deviceId = "compiled-v3-bridge";
  bridge.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request)));
  let received; const dispatched = new Promise(resolve => { received = resolve; }); const wireTasks = [];
  sockets.on("connection", socket => {
    const nonce = randomBytes(32).toString("base64url");
    const proof = role => createHmac("sha256", password).update(`rabiroute.remote-agent.v3:${role}:${nonce}`).digest("base64url");
    socket.send(JSON.stringify({ type: "challenge", protocolVersion: 3, algorithm: "hmac-sha256", nonce }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") {
        if (message.proof !== proof("manager")) { socket.close(); return; }
        socket.send(JSON.stringify({ type: "registered", protocolVersion: 3, serverProof: proof("server"), device: { deviceId } }));
      }
      if (message.type === "task") { wireTasks.push(message.task); received(message.task); }
    });
  });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  t.after(async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => bridge.close(resolve)); });
  const address = bridge.address(); assert.ok(address && typeof address !== "string");
  const fixture = { deviceId, host: "127.0.0.1", port: address.port, protocolVersion: 3, discoveredAt: new Date().toISOString(), controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control` };
  const { generation, ready, get } = await startBuiltManager(t, false, fixture);
  const meta = await (await get("/meta")).json(); assert.equal(meta.applicationGenerationId, generation);
  const local = createManagerClient({ managerUrl: ready.baseUrl, localHost: true, endpointSession: { async ensure() { return { managerUrl: ready.baseUrl, meta: await (await get("/meta")).json() }; } } });
  assert.equal((await local.invokeOperation("manager.webgui-access.update", { body: { enabled: true } })).statusCode, 200);
  const issued = await local.invokeOperation("manager.lan-agent.enrollments.create"); assert.equal(issued.statusCode, 201);
  const ticket = JSON.parse(issued.body).data.ticket;
  const enrolled = await local.invokeOperation("manager.lan-agent.enroll.exchange", { body: { ticket, nodeId: "compiled-hub-caller" } }); assert.equal(enrolled.statusCode, 201);
  const client = createManagerClient({ managerUrl: ready.baseUrl, credential: JSON.parse(enrolled.body).data.token, agentType: "dsh", sessionId: "compiled-hub-unregistered" });
  const invoke = (key, options = {}) => client.invokeOperation(`manager.remote-agent.${key}`, options);
  const help = JSON.parse((await client.request("GET", "/api/agent/help")).body).data;
  assertCorePublicContracts(help); assert.deepEqual(help.coverage.gaps, []); assert.equal(help.coverage.globalCoverage, "not-proven");
  for (const key of ["devices.list", "scan", "connect", "disconnect", "tasks.list", "tasks.create", "task-events.receive"]) {
    assert.ok(help.operations.some(operation => operation.id === `manager.remote-agent.${key}`), key);
  }
  assert.equal((await invoke("scan", { bodyText: "{ignored bytes" })).statusCode, 200);
  const connected = await invoke("connect", { body: { deviceId, password } }); assert.equal(connected.statusCode, 200, String(connected.body));
  assert.equal(JSON.parse(connected.body).device.passwordSaved, true);
  assert.equal((await invoke("devices.list")).statusCode, 200);
  const task = await invoke("tasks.create", { body: { deviceId, originGatewayId: "fixture-gateway", message: "compiled bridge fixture", files: [{ name: "fixture.txt", contentBase64: Buffer.from("compiled fixture bytes").toString("base64") }] } });
  assert.equal(task.statusCode, 202, String(task.body)); const accepted = JSON.parse(task.body).task;
  assert.equal(accepted.status, "delivered"); assert.equal(accepted.files[0].contentBase64, undefined);
  const wire = await dispatched; assert.equal(Buffer.from(wire.files[0].contentBase64, "base64").toString(), "compiled fixture bytes");
  const history = await client.invokeOperation("agent:GET:/api/remote-agent/tasks"); assert.equal(history.statusCode, 200); assert.equal(JSON.parse(history.body).tasks[0].taskId, accepted.taskId);
  const completed = await invoke("task-events.receive", { body: { taskId: accepted.taskId, device: { deviceId }, status: "completed", summary: "fixture done", files: [{ name: "returned.txt", contentBase64: "cmV0dXJuZWQ=" }] } });
  assert.equal(completed.statusCode, 202, String(completed.body));
  const saved = JSON.parse(completed.body).task.events.at(-1).savedFiles[0]; assert.equal(await fs.readFile(saved.path, "utf8"), "returned");
  assert.equal((await invoke("disconnect", { body: { deviceId } })).statusCode, 200); assert.equal(wireTasks.length, 1);
  console.log(JSON.stringify({ kind: "compiled-remote-hub-owner", profile: "required-plugins-plus-remote-hub", operationCount: help.operations.length, hubOperationCount: help.operations.filter(operation => operation.id.startsWith("manager.remote-agent.")).length, registeredLegacyRouteCount: help.coverage.gaps.length, coverageScope: help.coverage.scope, globalCoverage: help.coverage.globalCoverage, simulatedLanDiscovery: true, actualHmacAndSocketOwner: true, realRemoteComputerTested: false, callbackDeliveryTested: false, fullMigrationComplete: false }));
});

test("built Manager publishes executable API discovery and reports registered coverage without claiming global coverage", { timeout: 90_000 }, async t => {
  const { stateRoot, generation, ready, get, worker } = await startBuiltManager(t);
  const meta = await (await get("/meta")).json();
  assert.equal(meta.applicationGenerationId, generation);
  assert.equal(meta.health.pid, worker.pid);
  const help = await get("/api/agent/help"); assert.equal(help.status, 200);
  const helpData = (await help.json()).data;
  assert.equal(helpData.schemaVersion, "2");
  for (const id of ["manager.api.help", "manager.api.capabilities", "manager.api.openapi", "manager.events", "agent.upload.read", "agent.upload.write",
    "agent.qq.diagnostics", "agent.qq.group-files.read", "agent.qq.history.read", "agent.qq.message.read", "agent.qq.attachment.read", "agent.qq.stickers.read", "agent.qq.sticker.preview",
    "agent.send", "agent.send.capabilities", "agent.send.receipt.read", "agent.send.receipt.verify", "agent.send.receipt.settle",
    "agent.requests.list", "agent.requests.read", "agent.requests.cancel", "agent.send.traces", "agent.chat-history.read",
    "agent.hook.context.post", "agent.hook.roles.get", "agent.hook.doctor.get", "agent.hook.sessions.get", "agent.hook.session.get", "agent.hook.bind.put", "agent.hook.bind.patch", "agent.hook.unbind.delete",
    "agent.adapters.catalog.get", "agent.adapters.all.get", "agent.adapters.dsh.get", "agent.adapters.grokBot.get", "agent.adapters.connection.get", "agent.adapters.connections.get", "agent.adapters.connect.post", "agent.adapters.disconnect.delete", "agent.adapters.hooks.post",
    "manager.meta.read", "manager.gateways.read", "manager.webgui-access.read", "manager.webgui-access.update", "manager.webgui-access.update-post"]) {
    assert.ok(helpData.operations.some(operation => operation.id === id), `Missing executable operation: ${id}`);
  }
  const resources = ["settings.read", "settings.update", "archive-settings.read", "archive-settings.update", "object.read", "object.write", "archive.capabilities",
    "archive.recordings.list", "archive.processing.read", "archive.manifest.read", "archive.manifest.commit", "archive.receipt.read", "recording-events.write"];
  for (const key of resources) assert.ok(helpData.operations.some(operation => operation.id === `manager.resources.${key}`), `Missing resources owner: ${key}`);
  for (const key of ["terminals.list", "terminals.execute", "terminals.read", "terminals.events", "computer.execute"]) {
    assert.ok(helpData.operations.some(operation => operation.id === `manager.lan-agent.${key}`), `Missing interactive owner: ${key}`);
  }
  for (const key of ["resources.list", "resources.read", "releases.manifest", "releases.asset"]) {
    assert.ok(helpData.operations.some(operation => operation.id === `manager.lan-agent.${key}`), `Missing Agent read owner: ${key}`);
  }
  assert.equal(helpData.coverage.gaps.some(gap => gap.routeId === "resource-cache"), false, "Retired resources dispatch cannot remain a coverage scope.");
  for (const key of ["self.read", "enrollments.create", "enroll.exchange", "instances.list", "instances.enabled", "instances.name",
    "agents.create", "agents.tasks", "agents.configure", "agents.scan", "agents.threads", "agents.hooks", "nodes.list", "nodes.update", "nodes.tasks"]) {
    assert.ok(helpData.operations.some(operation => operation.id === `manager.lan-agent.${key}`), `Missing management owner: ${key}`);
  }
  assertCorePublicContracts(helpData);
  assert.equal(helpData.coverage.complete, true, "All registered routes in this profile now have executable contracts.");
  assert.equal(helpData.coverage.scope, "registered-routes"); assert.equal(helpData.coverage.globalCoverage, "not-proven");
  assert.deepEqual(helpData.coverage.gaps, []);
  const condition = await fetch(ready.baseUrl + "/api/agent/help", { headers: { "if-none-match": help.headers.get("etag") }, signal: AbortSignal.timeout(10_000) });
  assert.equal(condition.status, 304);
  const capabilitiesResponse = await get("/api/lan-agent/capabilities"); assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.catalogDigest, helpData.catalogDigest);
  const openapiResponse = await get("/api/agent/openapi"); assert.equal(openapiResponse.status, 200);
  const openapi = await openapiResponse.json();
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(openapi.paths["/api/lan-agent/connect"].get["x-rabiroute-transport"], "websocket");
  assert.equal(openapi.paths["/api/lan-agent/connect"].get.responses["101"].content, undefined);
  assert.ok(openapi.paths["/api/agent/uploads/{uploadId}"].put);
  assert.deepEqual(openapi.paths["/api/agent/qq/messages/{messageId}/attachments/{attachmentIndex}"].get.responses["200"]["x-rabiroute-binary"],
    { minBytes: 1, maxBytes: 64 * 1024 * 1024 });
  assert.deepEqual(Object.keys(openapi.paths["/api/agent/qq/stickers/{stickerId}/preview"].get.responses["200"].content).sort(),
    ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  const hookRoles = await get("/api/codex-hook/roles"); assert.equal(hookRoles.status, 200);
  assert.ok(Array.isArray((await hookRoles.json()).data.roleIds));
  const hookSessions = await get("/api/codex-hook/sessions"); assert.equal(hookSessions.status, 200);
  assert.deepEqual((await hookSessions.json()).data.sessions, []);
  const hookDoctor = await get("/api/codex-hook/doctor"); assert.equal(hookDoctor.status, 200);
  assert.equal((await hookDoctor.json()).data.ok, true);
  const unknownBinding = await get("/api/codex-hook/sessions/absent-fixture-session"); assert.equal(unknownBinding.status, 200);
  assert.equal((await unknownBinding.json()).data, null);
  const adapterCatalog = await get("/api/agent-adapters/catalog"); assert.equal(adapterCatalog.status, 200);
  assert.ok((await adapterCatalog.json()).data.adapters.length > 0);
  const connections = await get("/api/agent-adapters/dsh/connections"); assert.equal(connections.status, 200);
  assert.deepEqual((await connections.json()).endpoints, []);
  assert.equal(openapi.paths["/api/agent-adapters/dsh/connection"].post["x-rabiroute-deadline-ms"], 90000);
  const localClient = createManagerClient({ managerUrl: ready.baseUrl, localHost: true, endpointSession: { async ensure(options = {}) {
    const current = await (await get("/meta")).json();
    assert.equal(current.applicationGenerationId, generation); assert.equal(current.managerInstanceId, meta.managerInstanceId);
    if (!options.diagnostic) { assert.equal(current.health.live, true); assert.equal(current.health.requiredReady, true); assert.ok(["healthy", "degraded"].includes(current.health.state)); }
    return { managerUrl: ready.baseUrl, meta: current };
  } } });
  const discoveredMeta = await localClient.invokeOperation("agent:GET:/meta"); assert.equal(discoveredMeta.statusCode, 200);
  assert.equal(JSON.parse(discoveredMeta.body).managerInstanceId, meta.managerInstanceId);
  const discoveredHealth = await localClient.invokeOperation("manager.core-public.health.read"); assert.equal(discoveredHealth.statusCode, 200); assert.equal(JSON.parse(discoveredHealth.body).health.live, true);
  for (const id of ["automatic-updates.read", "source-patches.read", "web-patches.read"]) {
    const native = await localClient.invokeOperation("manager.core-public." + id); assert.equal(native.statusCode, 200); assert.equal(JSON.parse(native.body).code, 0);
  }
  const pluginReadiness = await localClient.invokeOperation("manager.plugins.reconciliation.read"); assert.equal(pluginReadiness.statusCode, 200); assert.ok(Array.isArray(JSON.parse(pluginReadiness.body).data.active));
  await waitForWebRelease(localClient);
  const shell = await localClient.invokeOperation("manager.webgui-static.distribution", { method: "GET", path: { resource: "" }, responseMode: "bytes" });
  assert.equal(shell.statusCode, 200); assert.match(shell.headers["content-type"], /^text\/html/);
  const html = shell.bodyBytes.toString("utf8"), scriptPath = html.match(/src=["']([^"']*\/_rabiroute\/web\/[a-f0-9]{64}\/web\/assets\/[^"']+\.js)["']/)?.[1];
  assert.ok(scriptPath, "Current HTML must reference an immutable asset in the current Web release.");
  const scriptSuffix = scriptPath.slice(scriptPath.indexOf("/_rabiroute/web/") + "/_rabiroute/web/".length);
  const compiledAsset = await localClient.invokeOperation("manager.webgui-static.release", { method: "GET", path: { resource: scriptSuffix }, responseMode: "bytes" });
  assert.equal(compiledAsset.statusCode, 200); assert.match(compiledAsset.headers["cache-control"], /immutable/);
  assert.deepEqual(compiledAsset.bodyBytes, await fs.readFile(path.join(packageRoot, "ribiwebgui/dist/assets", path.basename(scriptSuffix))));
  const compiledDoc = await localClient.invokeOperation("manager.webgui-static.release", { method: "GET", path: { resource: scriptSuffix.split("/")[0] + "/docs/api-contract-discovery-target-architecture.md" }, responseMode: "bytes" });
  assert.equal(compiledDoc.statusCode, 200); assert.match(compiledDoc.headers["content-type"], /^text\/plain/);
  assert.deepEqual(compiledDoc.bodyBytes, await fs.readFile(path.join(packageRoot, "docs/api-contract-discovery-target-architecture.md")));
  const privateStatic = await get("/_rabiroute/host/fixture-not-a-public-resource"); assert.equal(privateStatic.status, 404);
  const discoveredGateways = await localClient.invokeOperation("manager.gateways.read"); assert.equal(discoveredGateways.statusCode, 200);
  assert.deepEqual(JSON.parse(discoveredGateways.body), []);
  const discoveredAccess = await localClient.invokeOperation("manager.webgui-access.read"); assert.equal(discoveredAccess.statusCode, 200);
  const access = JSON.parse(discoveredAccess.body).data;
  assert.equal(access.managerPort, Number(new URL(ready.baseUrl).port)); assert.equal(access.canManage, true);
  assert.equal(discoveredAccess.headers["cache-control"], "private, no-store");
  assert.equal(openapi.paths["/api/webgui-access"].patch.requestBody.required, false);
  assert.deepEqual(openapi.paths["/api/webgui-access"].post.requestBody["x-rabiroute-body"].emptyValue, {});
  const unsupportedAccessMethod = await fetch(ready.baseUrl + "/api/webgui-access", { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  assert.equal(unsupportedAccessMethod.status, 423, "Existing read-only ingress must remain ahead of operation dispatch.");
  assert.equal((await unsupportedAccessMethod.json()).message, "Manager is running in read-only acceptance mode.");
  const resourcesSettings = await localClient.invokeOperation("manager.resources.settings.read"); assert.equal(resourcesSettings.statusCode, 200);
  assert.equal(path.resolve(JSON.parse(resourcesSettings.body).directory), path.join(stateRoot, "data", "resource-cache"));
  const archiveSettings = await localClient.invokeOperation("manager.resources.archive-settings.read"); assert.equal(archiveSettings.statusCode, 200);
  assert.deepEqual(JSON.parse(archiveSettings.body).data.ownerRoleBindings, {}); assert.match(archiveSettings.headers.etag, /^"[^"\r\n]+"$/);
  assert.equal(openapi.paths["/api/resource-cache/data/objects/{objectHash}"].get.responses["200"]["x-rabiroute-binary"].maxBytes, 1024 * 1024);
  assert.equal(openapi.paths["/api/resource-cache/data/objects/{objectHash}"].put.requestBody["x-rabiroute-body"].allowAnyContentType, true);
  assert.equal(openapi.paths["/api/resource-cache/archive-settings"].put.requestBody["x-rabiroute-body"].maxBytes, 8192);
  const agentResources = await localClient.invokeOperation("manager.lan-agent.resources.list"); assert.equal(agentResources.statusCode, 200);
  assert.ok(JSON.parse(agentResources.body).data.some(resource => resource.id === "docs/lan-rabi-agent-bootstrap.md"));
  const agentDocument = await localClient.invokeOperation("manager.lan-agent.resources.read", { query: { id: "docs/lan-rabi-agent-bootstrap.md" } });
  assert.equal(agentDocument.statusCode, 200); assert.equal(JSON.parse(agentDocument.body).data.content, await fs.readFile(path.join(packageRoot, "docs/lan-rabi-agent-bootstrap.md"), "utf8"));
  const releaseResponse = await localClient.invokeOperation("manager.lan-agent.releases.manifest"); assert.equal(releaseResponse.statusCode, 200);
  const release = JSON.parse(releaseResponse.body).release;
  const { verifyLanAgentReleaseManifest } = await import(pathToFileURL(path.join(packageRoot, "dist/manager/lanAgentReleaseStore.js")).href);
  assert.equal(verifyLanAgentReleaseManifest(release, release.publicKeySha256), true);
  const nativeReleaseAssets = release.files.filter(file => /^dist\/native\/(terminal|computer|tray)-[a-f0-9]{64}\.dll$/.test(file.path));
  if (process.platform === "win32") assert.equal(nativeReleaseAssets.length, 3, "The fresh Windows build must sign all three generated native assets.");
  for (const assetPath of ["lib/api-path-template.mjs", "lib/api-websocket-client.mjs", "lib/manager-websocket-cli.mjs", "lib/manager-cli.mjs", "lib/api-catalog-client.mjs", "lib/manager-client.mjs", "runtime/management.mjs", "package.json", ...nativeReleaseAssets.map(file => file.path)]) {
    const signedAsset = release.files.find(file => file.path === assetPath); assert.ok(signedAsset);
    const downloaded = await localClient.invokeOperation("manager.lan-agent.releases.asset", { path: { version: release.version, platform: release.platform, assetPath }, responseMode: "bytes" });
    assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.bodyBytes, await fs.readFile(path.join(packageRoot, "apps/rabi-agent", assetPath)));
    assert.equal(downloaded.bodyBytes.length, signedAsset.size);
    assert.equal(createHash("sha256").update(downloaded.bodyBytes).digest("hex"), signedAsset.sha256);
    if (assetPath === "package.json") {
      const dependencies = JSON.parse(downloaded.bodyBytes.toString()).dependencies;
      for (const name of ["ws", "ajv", "ajv-formats"]) assert.equal(typeof dependencies[name], "string");
    }
  }
  assert.deepEqual(openapi.paths["/api/lan-agent/releases/{version}/{platform}/{assetPath}"].get["x-rabiroute-path-tails"], ["assetPath"]);
  assert.equal(openapi["x-rabiroute-snapshot"].catalogDigest, helpData.catalogDigest);
  const sendResponse = await get("/api/agent/send/capabilities"); assert.equal(sendResponse.status, 200);
  const sendCapabilities = (await sendResponse.json()).data;
  assert.equal(sendCapabilities.schemaVersion, "2");
  assert.equal(sendCapabilities.requestContract.kind, "runtime-json-schema");
  assert.deepEqual(sendCapabilities.requestContract.schema, openapi.paths["/api/agent/send"].post.requestBody.content["application/json"].schema);
  assert.match(sendCapabilities.contract.qq, /private managed-file upload is not implemented/);
  // Loopback fixture exercises the existing EventSource query-credential form;
  // the value is synthetic and never copied into the business contract.
  const stream = await fetch(ready.baseUrl + "/api/events?webgui_token=fixture-browser-value", { signal: AbortSignal.timeout(5000) });
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  assert.ok(openapi.paths["/api/events"].get["x-rabiroute-transport"] === "sse");
  const reader = stream.body.getReader(); let initial = "";
  try {
    while (!initial.includes("event: ready")) { const next = await reader.read(); assert.equal(next.done, false); initial += Buffer.from(next.value).toString(); }
  } finally { await reader.cancel(); }
  const byOwner = {};
  for (const gap of helpData.coverage.gaps) byOwner[gap.instanceId] = (byOwner[gap.instanceId] ?? 0) + 1;
  console.log(JSON.stringify({ kind: "api-contract-built-manager", profile: "required-plugins", operationCount: helpData.operations.length, coverageScope: helpData.coverage.scope, globalCoverage: helpData.coverage.globalCoverage,
    registeredLegacyRouteCount: helpData.coverage.gaps.length, registeredLegacyRoutesByOwner: byOwner,
    fixtureScope: "isolated-readonly-required-plugin-profile", fullMigrationComplete: false, installedRuntimeTested: false }));
});

test('built Manager installs independent state, performance, output, provider, history and game-plan owners', { timeout: 90000 }, async t => {
  const { ready, get } = await startBuiltManager(t, false, undefined, undefined, {
    capabilities: ['manager.agent-state-control@1', 'manager.performance@1', 'manager.marvis-control@1', 'manager.bilibili-history@1', 'manager.astrbot-control@1', 'manager.copilot-control@1', 'manager.yeyu-gamer@1', 'manager.napcat-control@1', 'manager.route-control@1', 'manager.gateway-runtime@1', 'manager.message-adapter-control@1', 'manager.desktop@1', 'manager.agent-thread-control@1', 'manager.message-processing-control@1', 'manager.desktop-pet@1', 'manager.speech@1', 'manager.xiaomi-home@1', 'manager.video@1'],
  });
  const local = createManagerClient({ managerUrl: ready.baseUrl, localHost: true, endpointSession: { async ensure() { return { managerUrl: ready.baseUrl, meta: await (await get('/meta')).json() }; } } });
  assert.equal((await local.invokeOperation('manager.webgui-access.update', { body: { enabled: true } })).statusCode, 200);
  const issued = JSON.parse((await local.invokeOperation('manager.lan-agent.enrollments.create', { body: {} })).body).data;
  const credential = JSON.parse((await local.invokeOperation('manager.lan-agent.enroll.exchange', { body: { ticket: issued.ticket, nodeId: 'independent-owner-node', enrollmentSecret: 'i'.repeat(43) } })).body).data;
  const client = createManagerClient({ managerUrl: ready.baseUrl, credential: credential.token });
  const catalog = await client.catalog.refresh();
  assertCorePublicContracts(catalog);
  assert.equal(catalog.coverage.globalCoverage, 'not-proven');
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.performance.')).length, 7);
  assert.ok(catalog.operations.some(value => value.id === 'manager.agent-state.report'));
  assert.ok(catalog.operations.some(value => value.id === 'manager.agent.marvis.open'));
  assert.equal(catalog.operations.some(value => value.id.startsWith('manager.fennenote.')), false);
  for (const mode of ['reply', 'playback']) {
    const response = await fetch(ready.baseUrl + '/api/fennenote/' + mode, {
      method: 'POST', headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 404);
  }
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.bilibili-history.')).length, 9);
  const history = await client.invokeOperation('bilibili-history:GET:/api/bilibili-history/status'); assert.equal(history.statusCode, 200); assert.deepEqual(JSON.parse(history.body).jobs, []);
  for (const id of ['manager.agent.copilot.install', 'manager.agent.copilot.login']) {
    const entry = catalog.operations.find(value => value.id === id); assert.equal(entry.contract.request.body.allowIgnoredBody, true);
  }
  assert.ok(catalog.operations.some(value => value.id === 'manager.agent.astrbot.login-test'));
  const gamer = catalog.operations.filter(value => value.contract.pathTemplate.startsWith('/api/agent/yeyu-gamer/')); assert.equal(gamer.length, 5);
  assert.ok(gamer.every(value => value.contract.aliases.includes('gamer:' + value.contract.method + ':' + value.contract.pathTemplate)));
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.napcat.')).length, 10);
  const absentNapcat = await client.invokeOperation('manager.napcat.health', { body: { gatewayId: 'absent-compiled-gateway', instanceId: 'absent-compiled-instance' } }); assert.equal(absentNapcat.statusCode, 400); assert.equal(JSON.parse(absentNapcat.body).ok, false);
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.route-control.')).length, 14);
  await waitForNativeRouteCatalog({ ready, get });
  const identity = await client.invokeOperation('manager.route-control.identity.read'); assert.equal(identity.statusCode, 200);
  const identityData = JSON.parse(identity.body).data; assert.equal(identityData.port, Number(new URL(ready.baseUrl).port)); assert.equal(identityData.managerInstanceId, ready.managerInstanceId); assert.equal(identityData.applicationGenerationId, ready.applicationGenerationId);
  const disabledHome = await client.invokeOperation('manager.route-control.link-home.read'); assert.equal(disabledHome.statusCode, 503); assert.equal(JSON.parse(disabledHome.body).errorCode, 'RABILINK_HOME_DISABLED');
  assert.equal((await client.invokeOperation('manager.route-control.manager-config.read')).statusCode, 200);
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.gateway-runtime.')).length, 15);
  assert.equal((await client.invokeOperation('manager.gateway-runtime.list', { query: { summary: '1', includeConfig: '0' } })).statusCode, 200);
  assert.equal(catalog.operations.filter(value => value.id === 'manager.message-adapters.scan').length, 1);
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.desktop.')).length, 4);
  const desktopSettings = await client.invokeOperation('manager.desktop.settings.read'); assert.equal(desktopSettings.statusCode, 200); assert.equal(JSON.parse(desktopSettings.body).code, 0);
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.agent.threads.')).length, 2);
  assert.ok(catalog.operations.find(value => value.id === 'manager.agent.threads.action').contract.aliases.includes('agent:POST:/api/agent/threads'));
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.message-processing.')).length, 7);
  const board = await client.invokeOperation('manager.message-processing.board.read'); assert.equal(board.statusCode, 200);
  assert.equal(catalog.operations.filter(value => value.id.startsWith('manager.desktop-pet.')).length, 12);
  const binding = await client.invokeOperation('manager.desktop-pet.binding.read', { path: { roleId: 'CompiledContractRole' } }); assert.equal(binding.statusCode, 200);
  const speechContracts = catalog.operations.filter(value => value.contract.pathTemplate.startsWith('/api/speech/')); assert.equal(speechContracts.length, 39);
  assert.ok(speechContracts.every(value => value.contract.aliases.includes('speech:' + value.contract.method + ':' + value.contract.pathTemplate)));
  const homeContracts = catalog.operations.filter(value => value.id.startsWith('manager.xiaomi-home.')); assert.equal(homeContracts.length, 53);
  assert.ok(homeContracts.every(value => value.contract.aliases.includes('home:' + value.contract.method + ':' + value.contract.pathTemplate)));
  const videoContracts = catalog.operations.filter(value => value.id.startsWith('manager.video.')); assert.equal(videoContracts.length, 35);
  const dynamicVideo = videoContracts.find(value => value.contract.method === '*'); assert.ok(dynamicVideo); assert.ok(dynamicVideo.contract.httpProxy); assert.equal(dynamicVideo.contract.request.pathRemainder, 'suffix');
  const homeHealth = await client.invokeOperation('manager.xiaomi-home.health.read'); assert.equal(homeHealth.statusCode, 200); assert.equal(JSON.parse(homeHealth.body).code, 0); assert.equal(JSON.parse(homeHealth.body).data.status, 'authorization_required');
  await waitForVideoOwner(client);
  const videoJobs = await client.invokeOperation('manager.video.jobs.list'); assert.equal(videoJobs.statusCode, 200); assert.deepEqual(JSON.parse(videoJobs.body).jobs, []);
  const videoProjectList = await client.invokeOperation('manager.video.projects.list'); assert.equal(videoProjectList.statusCode, 200); assert.deepEqual(JSON.parse(videoProjectList.body).projects, []);
  assert.deepEqual(catalog.coverage.gaps, []); assert.equal(catalog.coverage.scope, 'registered-routes');

  const saved = await client.invokeOperation('manager.performance.config.save', { body: { enabled: false, slowOperationMs: 123 } }); assert.equal(saved.statusCode, 200);
  const config = JSON.parse((await client.invokeOperation('manager.performance.config.read')).body).data; assert.equal(config.enabled, false); assert.equal(config.slowOperationMs, 123);
  for (const id of ['status.read', 'logs.read', 'summary.read']) assert.equal((await client.invokeOperation('manager.performance.' + id)).statusCode, 200);
  const controller = new AbortController();
  const events = await fetch(ready.baseUrl + '/api/performance/events', { headers: { authorization: 'Bearer ' + credential.token }, signal: controller.signal }); assert.equal(events.status, 200);
  const reader = events.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: ready/); await reader.cancel(); controller.abort();
  const report = await client.invokeOperation('manager.agent-state.report', { body: { gatewayId: 'absent-fixture', adapterType: 'codex', generation: 'fixture', sequence: 1 } }); assert.equal(report.statusCode, 400);
  const marvis = await client.invokeOperation('manager.agent.marvis.open', { body: { appId: {} } }); assert.equal(marvis.statusCode, 400);
  console.log(JSON.stringify({ kind: 'compiled-independent-owners', profile: 'required-plugins-plus-explicit-independent-owners', operationCount: catalog.operations.length, performanceOperations: catalog.operations.filter(operation => operation.id.startsWith('manager.performance.')).length, speechOperations: speechContracts.length, homeOperations: homeContracts.length, videoOperations: videoContracts.length, coverageScope: catalog.coverage.scope, globalCoverage: catalog.coverage.globalCoverage, registeredLegacyRouteCount: catalog.coverage.gaps.length, retiredFenneNoteEndpointsAbsent: true, nativePerformanceConfigAndSse: true, nativeEmptyHistoryStatus: true, providerIgnoredBodyPublished: true, gamePlanContractsInstalled: true, nativeNapcatBindingRejection: true, actualNapcatServiceTested: false, nativeRouteControlReads: true, currentManagerPortRead: true, actualProviderLoginOrInstallTested: false, actualGameServiceTested: false, stateValidationBeforeMutation: true, marvisValidationBeforeLaunch: true, realExternalDeliveryTested: false, installedRuntimeTested: false, fullMigrationComplete: false }));
});


test('built Manager retires FenneNote while authenticated speech remains available', { timeout: 90000 }, async t => {
  const { ready, get } = await startBuiltManager(t, false, undefined, undefined, { capabilities: ['manager.speech@1'] });
  const request = async (method, target, body, token) => {
    const response = await fetch(ready.baseUrl + target, { method, signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.ok(response.ok, method + ' ' + target + ': HTTP ' + response.status);
    return JSON.parse(text);
  };
  const access = await request('PATCH', '/api/webgui-access', { enabled: true });
  const credential = { token: access.data.token };
  assert.equal(typeof credential.token, 'string');
  assert.ok(credential.token.length > 0);
  await request('GET', '/api/speech/selection-reader/settings', undefined, credential.token);
  const profile = JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/plugins/profiles/desktop.json'), 'utf8'));
  assert.equal(profile.instances.some(instance => instance.package.includes('fennenote')), false);
  await assert.rejects(fs.access(path.join(packageRoot, 'dist/plugins/packages/io.rabiroute.manager.fennenote-output')), { code: 'ENOENT' });
  for (const mode of ['reply', 'playback']) {
    const response = await fetch(ready.baseUrl + '/api/fennenote/' + mode, {
      method: 'POST', headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 404);
  }
});
