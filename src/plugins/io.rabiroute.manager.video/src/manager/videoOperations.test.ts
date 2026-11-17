import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { apiCatalogOpenApi } from "../../../../manager/apiOperationCatalog.js";
import { compileApiContract, validateApiOperationResult } from "../../../../manager/apiOperationContract.js";
import { createVideoOperations } from "./videoOperations.js";
import { createVideoRequestAccess } from "./videoRuntime.js";
import { ManagerEventHub } from "../../../../manager/managerEvents.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "../../../../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../../../../manager/lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import { registerLanAgentBodyGuard } from "../../../../manager/lanAgentBodyAuthority.js";
// @ts-ignore Native plugin owners, exercised with controlled runtime drivers only.
import { VideoService } from "../../service.mjs";
// @ts-ignore Native plugin owner.
import { VideoModels } from "../../models.mjs";
// @ts-ignore Native plugin owner.
import { VideoAssets } from "../../assets.mjs";
// @ts-ignore Native plugin owner.
import { VideoProjects } from "../../projects.mjs";
// @ts-ignore Native plugin owner.
import { RemoteVideoCompute } from "../../remoteCompute.mjs";
// @ts-ignore Native plugin event source, with no state polling.
import { createVideoApiEvents, createVideoOperationsOwner } from "../../apiOwner.mjs";

// @ts-ignore Native field definitions are supplied by the current plugin activation.
import { createVideoContracts } from "../../contracts.mjs";
// @ts-ignore Native Workbench owner, with no external execution in this fixture.
import { WorkbenchRuns } from "../../workbenchRuns.mjs";

const bind = (server: http.Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port)));
const close = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
const connectionChanges = [
  { name: "work-disabled", denied: false, apply: (authority: LanAgentAuthority, credential: { nodeId: string; token: string }) => authority.setNodeEnabled(credential.nodeId, false, true) },
  { name: "work-toggle", denied: false, apply: (authority: LanAgentAuthority, credential: { nodeId: string; token: string }) => { authority.setNodeEnabled(credential.nodeId, false, true); authority.setNodeEnabled(credential.nodeId, true, false); } },
  { name: "credential-revoked", denied: true, apply: (authority: LanAgentAuthority, credential: { nodeId: string; token: string }) => authority.revokeNode(credential.nodeId) },
  { name: "credential-replaced-with-same-token", denied: true, apply: (authority: LanAgentAuthority, credential: { nodeId: string; token: string }) => { authority.revokeNode(credential.nodeId); const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, credential.nodeId, credential.token.split(":")[2]); assert.equal(replacement.token, credential.token); } }
] as const;
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-contract-http-")), calls: unknown[] = [];
  const cleanup: Array<() => Promise<unknown>> = [], releases: Array<() => void> = [];
  t.after(async () => { for (const release of releases) release(); await Promise.allSettled(cleanup.map(dispose => dispose())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("video-contract-http-")); await fs.rm(root, { recursive: true, force: true }); });
  const catalog = JSON.parse(await fs.readFile(new URL("../../catalog.json", import.meta.url), "utf8"));
  const model = catalog.models.find((row: any) => row.mode === "image"), events = createVideoApiEvents(catalog);
  cleanup.push(() => events.close());
  let pendingPeer: { entered(): void; closed(): void; respond?: () => void } | undefined;
  const provider = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url }); const chunks: Buffer[] = [];
    const hold = pendingPeer; if (hold) { response.on("close", hold.closed); releases.push(() => response.destroy()); }
    request.on("data", chunk => chunks.push(Buffer.from(chunk))); request.on("end", () => {
      const respond = () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ nativePeer: true, metadata: { providerOwned: true }, frames: 7, method: request.method, path: request.url, ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString()) } : {}) })); };
      if (hold) { hold.respond = respond; hold.entered(); } else respond();
    });
  });
  cleanup.push(() => close(provider)); const providerBase = await bind(provider); let alive = true;
  const runtime = { stateRoot: root, componentRoot: path.join(root, "component"), defaultModelRoot: path.join(root, "models"), readOnly: false,
    workbenchRuntimeRoot:path.join(root,"workbench-runtime"),machineId:"fixture-machine",generation:"fixture-generation",
    workbenchBindings:async()=>({workspaces:{fixture:{roots:{runtime:root,output:root,materials:root}}}}),
    requestAccess: createVideoRequestAccess, localSettingsAllowed: () => true, alive: () => alive, installed: async () => true,
    validateModelRoot: async () => null, inspectAsset: async (_id: string, kind: string) => ({ width: 16, height: 16, ...(kind === "audio" ? { duration: 1, channels: 1 } : {}) }),
    start: async () => { throw new Error("No real inference process is permitted."); }, stop: async () => { alive = false; }, stopInstaller: async () => {}, stopMediaProbe: async () => {},
    install: async () => { throw new Error("No real installation is permitted."); },
    peerFetch: async (device: string, route: string, init: RequestInit) => { assert.equal(device, "owned-compute"); return fetch(providerBase + route, init); }
  };
  const service = new VideoService(runtime, catalog, (name: string, data: unknown) => events.publish(name, data)); cleanup.push(() => service.close()); await service.initialize();
  service.online = true; service.pump = () => {}; // Admit durable jobs without executing inference.
  const assets = new VideoAssets(runtime), computeAssets = new VideoAssets({ ...runtime, stateRoot: path.join(root, "compute") });
  service.assets = assets; service.computeAssets = computeAssets; service.remote = new RemoteVideoCompute(runtime, catalog, () => {}, service.jobs.values());
  const models = new VideoModels(runtime, catalog, () => events.publish("video.models", {})); cleanup.push(() => models.close()); await models.initialize(); const projects = new VideoProjects(runtime);
  const runs=new WorkbenchRuns(runtime,projects,service,()=>{});await runs.initialize();cleanup.push(()=>runs.close());
  const readJsonBody = <T>(request: http.IncomingMessage, limit: number): Promise<T> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false;
    request.on("data", chunk => { if (failed) return; size += chunk.length; if (size > limit) { failed = true; reject(new Error("Original model body cap")); return; } chunks.push(Buffer.from(chunk)); });
    request.on("error", reject); request.on("end", () => { if (!failed) { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (cause) { reject(cause); } } });
  });
  let streamCreated: (() => void) | undefined;
  const eventSource = { job: events.job, compute(access: ReturnType<typeof createVideoRequestAccess>) { const stream = events.compute(access); streamCreated?.(); return stream; } };
  const nativeContext = { contracts: createVideoContracts(catalog), runtime, catalog, service, models, assets, computeAssets, projects, runs, events: eventSource, readJsonBody };
  const bundle = createVideoOperations({ ...nativeContext, owner: createVideoOperationsOwner(nativeContext) } as never);
  const registry = new ManagerPluginRouteRegistry(), operations = registry.registerOperations("video-fixture", bundle.operations); cleanup.push(() => operations.dispose());
  const proxies = registry.registerHttpProxies("video-fixture", bundle.proxies); cleanup.push(() => proxies.dispose());
  const authority = new LanAgentAuthority({ statePath: path.join(root, "node-authority.json") }), credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-video-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  cleanup.push(() => close(server)); const base = await bind(server);
  const request = (suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
    const outgoing = http.request(base + "/api/video" + suffix, { method, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...(encoded === undefined ? {} : { "content-length": String(Buffer.byteLength(encoded)) }), ...headers } }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.on("error", reject); incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode!, headers: incoming.headers as Record<string, string> })));
    }); outgoing.on("error", reject); outgoing.setTimeout(15000, () => outgoing.destroy(new Error("Owned video fixture timeout."))); outgoing.end(encoded);
  });
  const savedJob = async (compute = false) => {
    const id = randomUUID(), job = { id, model: model.id, status: "succeeded", createdAt: new Date().toISOString(), ...(compute ? { computeOnly: true } : {}), output: { filename: id + ".png", subfolder: "" } };
    await fs.mkdir(path.join(root, "provider-output"), { recursive: true }); await fs.writeFile(path.join(root, "provider-output", id + ".png"), "0123456789"); await service.save(job); service.jobs.set(id, job); return job;
  };
  const holdPeer = () => {
    let entered!: () => void, closed!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), finished = new Promise<void>(resolve => { closed = resolve; });
    const hold = { entered, closed, respond: undefined as (() => void) | undefined }; pendingPeer = hold;
    return { started, closed: finished, respond: () => { assert.ok(hold.respond); hold.respond(); } };
  };
  return { root, runtime, catalog, model, events, service, models, assets, computeAssets, projects, runs, bundle, registry, operations, proxies, authority, credential, base, request, savedJob, calls, releases, holdPeer, setAlive: (value: boolean) => { alive = value; }, onStreamCreated: (callback: () => void) => { streamCreated = callback; } };
}

test("original Video contracts and separate Workbench contracts register with public connection access", async t => {
  const f = await fixture(t), original = (row: { contract: { operationId: string } }) => !row.contract.operationId.startsWith("manager.video.workbench.");
  assert.equal(f.bundle.operations.filter(original).length, 25); assert.equal(f.bundle.proxies.filter(original).length, 10);
  assert.equal(f.bundle.operations.filter(row => !original(row)).length, 24); assert.equal(f.bundle.proxies.filter(row => !original(row)).length, 1);
  const rows = f.registry.catalogSnapshot().operations; assert.equal(rows.length, 60); assert.equal(new Set(rows.map(row=>row.contract.operationId)).size,60); assert.ok(rows.every(row => row.contract.exposure === "public"));
  for (const path of ["/jobs/:mediaId", "/projects/:mediaId", "/assets/:mediaId"]) assert.ok(rows.some(row => row.contract.aliases?.includes("video:GET:/api/video" + path)));
  assert.equal((await f.request("/status")).status, 200); assert.equal((await f.request("/models/settings")).status, 200); assert.equal((await f.request("/compute/status")).status, 200);
});

test("native projects preserve original IDs, revisions, concurrent conflict and independent file readback", async t => {
  const f = await fixture(t), id = randomUUID(), value = { version: 1, active: "video", items: [{ id: "video", kind: "video", prompt: "owned fixture" }], drafts: [] };
  const created = await f.request("/projects", "POST", { id }); assert.equal(created.status, 200, await created.text()); assert.equal((await f.request("/projects", "POST", { id })).status, 200);
  const saved = await f.request("/projects/" + id, "PUT", { revision: 0, title: "Owned fixture", value }); assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { revision: 1 });
  assert.equal((await f.request("/projects/" + id, "PUT", { revision: 0, value })).status, 409);
  assert.equal((await new VideoProjects(f.runtime).read(id)).value.items[0].prompt, "owned fixture");
  f.runtime.readOnly = true; assert.equal((await f.request("/projects/" + id, "PUT", { revision: 1, value })).status, 423);
});

test("native raw uploads keep all media kinds and metadata/Range reads without invoking a decoder process", async t => {
  const f = await fixture(t);
  for (const kind of ["image", "video", "audio"]) {
    const created = await f.request("/assets?kind=" + kind, "POST", Buffer.from("0123456789")); assert.equal(created.status, 201); const asset = await created.json(); assert.equal(asset.kind, kind);
    const metadata = await f.request("/assets/" + asset.id + "?metadata=1"); assert.equal(metadata.status, 200); assert.equal((await metadata.json()).id, asset.id);
    const content = await f.request("/assets/" + asset.id, "GET", undefined, { range: "bytes=2-5" }); assert.equal(content.status, 206); assert.equal(content.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await content.text(), "2345");
  }
});

test("native job admission and cancellation preserve durable idempotency and never execute inference", async t => {
  const f = await fixture(t), command = { model: f.model.id, prompt: "owned fixture", width: 512, height: 512, seed: 1 }, headers = { "idempotency-key": "owned-video-job-key" };
  const first = await f.request("/jobs", "POST", command, headers); assert.equal(first.status, 202, await first.clone().text()); const job = await first.json();
  const replay = await f.request("/jobs", "POST", command, headers); assert.equal((await replay.json()).id, job.id);
  assert.equal((await f.request("/jobs", "POST", { ...command, seed: 2 }, headers)).status, 409);
  assert.equal((await f.request("/jobs/" + job.id + "/cancel", "POST")).status, 200);
  const restored = new VideoService(f.runtime, f.catalog, () => {}); await restored.initialize(); assert.equal(restored.jobs.get(job.id).status, "cancelled"); await restored.close();
});

test("workspace and compute output routes keep native PNG Range, ownership and purged receipts", async t => {
  const f = await fixture(t), local = await f.savedJob(), compute = await f.savedJob(true);
  for (const [prefix, job] of [["", local], ["/compute", compute]] as const) {
    const reply = await f.request(prefix + "/jobs/" + job.id + "/image", "GET", undefined, { range: "bytes=-3" }); assert.equal(reply.status, 206); assert.equal(await reply.text(), "789"); assert.equal(reply.headers.get("content-type"), "image/png");
  }
  assert.equal((await f.request("/compute/jobs/" + local.id)).status, 404); assert.equal((await f.request("/jobs/" + compute.id)).status, 404);
  assert.equal((await f.request("/compute/jobs/" + compute.id, "DELETE")).status, 200); assert.equal((await f.request("/compute/jobs/" + compute.id + "/image")).status, 410); assert.equal(f.service.jobs.get(compute.id).outputPurged, true);
});

test("original selected-peer model JSON preserves conditional bodies and never falls back to local", async t => {
  const f = await fixture(t);
  for (const [suffix, method, body] of [["/models", "GET", undefined], ["/models/settings", "PATCH", { expectedRevision: 1, modelRoot: null }], ["/models/runtime", "POST", { remoteFixture: true }]] as const) {
    const response = await f.request(suffix + "?computeDeviceId=owned-compute", method, body); assert.equal(response.status, 200, await response.clone().text()); const value = await response.json(); assert.equal(value.nativePeer, true); assert.equal(value.method, method); assert.deepEqual(value.metadata, { providerOwned: true }); if (body) assert.deepEqual(value.body, body);
  }
  assert.equal(f.calls.length, 3); assert.equal((await f.request("/models?computeDeviceId=" + "x".repeat(201))).status, 400);
});

test("native compute SSE sends progress, finishes at terminal state and joins subscriptions on retirement", async t => {
  const f = await fixture(t), job = await f.savedJob(true);
  const finished = await f.request("/compute/jobs/" + job.id + "/events"); assert.equal(finished.status, 200); const finishedText = await finished.text(); assert.match(finishedText, /event: progress/); assert.ok(finishedText.includes(job.id)); assert.equal(f.events.active(), 0);
  let incoming!: http.IncomingMessage, outgoing!: http.ClientRequest;
  const first = await new Promise<string>((resolve, reject) => { outgoing = http.get(f.base + "/api/video/compute/events", { headers: { authorization: "Bearer " + f.credential.token } }, response => { incoming = response; response.on("error", () => {}); response.once("data", chunk => resolve(chunk.toString())); }); outgoing.on("error", reject); });
  assert.match(first, /event: compute/); assert.equal(f.events.active(), 1); await f.operations.dispose(); assert.equal(f.events.active(), 0); incoming.destroy(); outgoing.destroy();
});

for (const change of connectionChanges) test("queued native project save preserves the original connection after " + change.name, async t => {
  const f = await fixture(t), id = randomUUID(); await f.request("/projects", "POST", { id });
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }); f.releases.push(release);
  let lockEntered!: () => void; const lockStarted = new Promise<void>(resolve => { lockEntered=resolve; });
  const held = f.projects.locked(`project:${id}`, undefined, async () => { lockEntered(); await gate; }); await lockStarted;
  const mutate = f.projects.mutate.bind(f.projects); f.projects.mutate = (...args: Parameters<typeof mutate>) => { entered(); return mutate(...args); };
  const pending = f.request("/projects/" + id, "PUT", { revision: 0, value: { version: 1, active: "video", items: [{ id: "video", kind: "video" }], drafts: [] } });
  await started; change.apply(f.authority,f.credential); release(); await held;
  const response = await pending; assert.equal(response.status, change.denied ? 403 : 200); const body=await response.json();
  if(change.denied) assert.equal(body.mutation ?? body.mutationOutcome, "not_started");
  assert.equal((await new VideoProjects(f.runtime).read(id)).revision, change.denied ? 0 : 1);
});

test("retiring an original media proxy joins a backpressured native file read", { timeout: 20000 }, async t => {
  const f=await fixture(t),id=randomUUID();await fs.mkdir(f.assets.root,{recursive:true});
  const bytes=8*1024*1024;await fs.writeFile(path.join(f.assets.root,id+".mp4"),Buffer.alloc(bytes,0x41));await fs.writeFile(path.join(f.assets.root,id+".json"),JSON.stringify({id,kind:"video",size:bytes}));
  let outgoing!:http.ClientRequest,incoming!:http.IncomingMessage,received=0;
  await new Promise<void>((resolve,reject)=>{outgoing=http.get(f.base+"/api/video/assets/"+id,{headers:{authorization:"Bearer "+f.credential.token}},response=>{incoming=response;response.on("error",()=>{});response.once("data",chunk=>{received+=chunk.length;response.pause();resolve();});});outgoing.on("error",reject);});
  assert.ok(received>0 && received<bytes);await f.proxies.dispose();assert.equal(f.proxies.activeOperationCount(),0);incoming.destroy();outgoing.destroy();
});

for (const change of connectionChanges) test("native SSE creation preserves the original connection after " + change.name, async t => {
  const f = await fixture(t); f.onStreamCreated(() => change.apply(f.authority,f.credential));
  if(change.denied) { const response = await f.request("/compute/events"); assert.equal(response.status, 403); assert.equal(f.events.active(), 0); return; }
  let outgoing!:http.ClientRequest,incoming!:http.IncomingMessage;
  const first=await new Promise<string>((resolve,reject)=>{outgoing=http.get(f.base+"/api/video/compute/events",{headers:{authorization:"Bearer "+f.credential.token}},response=>{incoming=response;assert.equal(response.statusCode,200);response.on("error",()=>{});response.once("data",chunk=>resolve(chunk.toString()));});outgoing.on("error",reject);});
  assert.match(first,/event: compute/);assert.equal(f.events.active(),1);await f.operations.dispose();assert.equal(f.events.active(),0);incoming.destroy();outgoing.destroy();
});

test("native model wildcard preserves raw prefix paths, arbitrary methods, original body rules and local 404", async t => {
  const f=await fixture(t);
  for(const [suffix,method,body] of [
    ["/modelsXYZ","GET",undefined], ["/models/extension/nested/%E4%B8%AD/%20","PROPFIND",undefined],
    ["/models/settings","PUT","ignored-not-json"], ["/models/custom/nested","POST",{ownedFixture:true}],
    ["/models/custom/nested","PATCH",{ownedFixture:"patch"}], ["/models/","DELETE","ignored-not-json"]
  ] as const) {
    const reply=await f.request(suffix+"?computeDeviceId=owned-compute",method,body);assert.equal(reply.status,200,method+" "+suffix+": "+await reply.clone().text());
    const value=await reply.json();assert.equal(value.path,"/api/video"+suffix);assert.equal(value.method,method);assert.deepEqual(value.metadata,{providerOwned:true});assert.equal(value.frames,7);
    assert.deepEqual(value.body,["POST","PATCH"].includes(method)?body:undefined);
  }
  // The authenticated connection preserves the native provider's raw path contract.
  const encoded = await f.request("/models/extension/%2F?computeDeviceId=owned-compute");
  assert.equal(encoded.status, 200);
  const nativeEncoded = await encoded.json();
  assert.equal(nativeEncoded.path, "/api/video/models/extension/%2F");
  assert.equal(nativeEncoded.method, "GET");
  const dispatched=f.calls.length;
  assert.equal((await f.request("/modelsXYZ")).status,404);assert.equal((await f.request("/models/settings","PUT","ignored")).status,404);
  assert.equal((await f.request("/models/custom?computeDeviceId=owned-compute","POST",{oversized:"x".repeat(4096)})).status,503);assert.equal(f.calls.length,dispatched);
  f.runtime.readOnly=true;assert.equal((await f.request("/models/custom?computeDeviceId=owned-compute","PROPFIND")).status,423);assert.equal(f.calls.length,dispatched);
});

test("native model exchange retirement cancels and joins an upstream pending before headers", { timeout: 20000 }, async t => {
  const f=await fixture(t),hold=f.holdPeer(),pending=f.request("/models/custom?computeDeviceId=owned-compute").catch(()=>undefined);
  await hold.started;await f.proxies.dispose();await hold.closed;await pending;assert.equal(f.proxies.activeOperationCount(),0);assert.equal(f.calls.length,1);
});

for (const change of connectionChanges) test("a dispatched native model mutation preserves its original outcome after " + change.name, async t => {
  const f=await fixture(t),hold=f.holdPeer(),pending=f.request("/models/custom?computeDeviceId=owned-compute","POST",{ownedFixture:true});
  await hold.started;change.apply(f.authority,f.credential);hold.respond();
  const response=await pending;assert.equal(response.status,change.denied?403:200);const body=await response.json();
  if(change.denied){assert.equal(body.mutationOutcome,"unknown");assert.equal(body.nativePeer,undefined);}else{assert.equal(body.nativePeer,true);assert.deepEqual(body.body,{ownedFixture:true});}
  assert.equal(f.calls.length,1);
});


test("Video discovery describes stable native fields, result DTOs and deferred native constraints without narrowing peer JSON", async t => {
  const f = await fixture(t), rows = f.registry.catalogSnapshot().operations;
  const contract = (name: string) => { const row = rows.find(row => row.contract.operationId === "manager.video." + name); assert.ok(row); return row.contract; };
  const schema = (name: string) => JSON.stringify(contract(name));
  for (const [name, fields] of [
    ["project.save", ["revision", "title", "value", "1000"]],
    ["jobs.submit", ["model", "prompt", "12000", "references", "quickGeneration", "Idempotency-Key"]],
    ["models.settings-save", ["modelRoot", "expectedRevision", "layout", "409"]],
    ["models.initialization", ["downloadBytes", "availableBytes", "canDownload", "relative"]],
    ["models.read", ["runtimeInstalled", "currentFile", "missingFiles"]],
    ["job.read", ["computeOutcome", "hasFirstFrame", "outputPurged", "progressStage"]]
  ] as const) for (const field of fields) assert.ok(schema(name).includes(field), name + ": " + field);
  for (const definition of f.bundle.operations.filter(row => row.contract.transport === "http")) {
    const response = Object.entries(definition.contract.responses).find(([status])=>/^2\d\d$/.test(status))?.[1];
    assert.ok(response?.schema && Object.keys(response.schema).some(key => key !== "description"), definition.contract.operationId);
  }
  const openapi = JSON.stringify((await apiCatalogOpenApi(f.registry.catalogSnapshot())));
  for (const field of ["expectedRevision", "progressMax", "effectiveModelRoot", "samplingSteps"]) assert.ok(openapi.includes(field));
});

test("Workbench discovery validates original HTTP project, canvas, media, run and log results",async t=>{
  const f=await fixture(t),id=randomUUID();
  const read=async(suffix:string,method="GET",body?:unknown,status=200)=>{const response=await f.request(suffix,method,body);assert.equal(response.status,status,await response.clone().text());return response.json();};
  const definition=await read("/v2/definition");assert.equal(definition.capabilities.agent.executable,true);
  const project=await read("/v2/projects","POST",{id,title:"Discovery fixture"}),canvasId=project.defaultCanvasId,prefix=`/v2/projects/${id}/canvases/${canvasId}`;
  const canvas=await read(prefix);canvas.workspaceBindingKey="fixture";canvas.extension={retained:true};canvas.graph.nodes=[{id:"review",kind:"human",config:{}}];
  const saved=await read(prefix,"PUT",canvas);assert.deepEqual(saved.extension,{retained:true});
  assert.equal((await read(`/v2/projects/${id}/canvases`)).canvases[0].id,canvasId);
  assert.equal((await read(prefix+"/editor")).value,null);assert.equal((await read(prefix+"/export")).id,canvasId);
  assert.equal((await read(`/v2/projects/${id}/index/rebuild`,"POST")).count,1);
  const runId=randomUUID(),run=await read(prefix+"/runs","POST",{id:runId,revision:saved.revision},202);assert.equal(run.id,runId);
  await f.runs.flights.get(runId);
  const waiting=await read(`/v2/runs/${runId}`);assert.equal(waiting.state,"waiting_human");
  assert.equal((await read(prefix+"/runs")).runs[0].id,runId);assert.ok(Array.isArray((await read(`/v2/runs/${runId}/logs`)).entries));
  const finished=await read(`/v2/runs/${runId}/complete`,"POST",{nodeId:"review",attemptId:waiting.attempts.review.id,identity:"fixture reviewer",evidence:{reviewed:true}});assert.equal(finished.attempts.review.state,"succeeded");
  await f.runs.flights.get(runId);assert.equal((await read(`/v2/runs/${runId}`)).state,"succeeded");
  const contract=f.bundle.operations.find(row=>row.contract.operationId==="manager.video.workbench.canvas-read")!;
  assert.doesNotThrow(()=>validateApiOperationResult(compileApiContract(contract),{status:200,body:saved}));
  assert.throws(()=>validateApiOperationResult(compileApiContract(contract),{status:200,body:{...saved,revision:"wrong"}}));
});

test("project native coercion, ignored root fields and opaque canvas data survive the same registered JSON parser", async t => {
  const f = await fixture(t), id = randomUUID();
  const created = await f.request("/projects", "POST", { id: [id], ignored: true }); assert.equal(created.status, 200); assert.deepEqual((await created.json()).id, [id]);
  const value = { version: 1, active: "v", items: [{ id: "v", kind: "video", providerExtension: [null, 7] }], drafts: [null, "opaque", { future: true }], futureCanvas: { retained: true } };
  let result = await f.request("/projects/" + id, "PUT", { revision: 0, title: "   " + "t".repeat(120) + "  ", value, ignored: [1] }); assert.equal(result.status, 200);
  const restored = await (await f.request("/projects/" + id)).json(); assert.equal(restored.title, "t".repeat(100)); assert.deepEqual(restored.value, value);
  result = await f.request("/projects/" + id, "PUT", { revision: 1, title: 9, value }); assert.equal(result.status, 200);
  assert.equal((await (await f.request("/projects/" + id)).json()).title, restored.title);
  const invalid = await f.request("/projects/" + id, "PUT", { revision: "2", value }); assert.equal(invalid.status, 409); assert.deepEqual(await invalid.json(), { message: "项目已被另一页面更新，请保留当前编辑后重新打开项目。" });
  for (const invalidId of [null, [], {}]) { const response = await f.request("/projects", "POST", { id: invalidId }); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { message: "项目不存在。" }); }
});

test("native job nullish defaults and exact rejection messages remain owned by the shared command definition", async t => {
  const f = await fixture(t), command = { model: f.model.id, prompt: "  owned prompt  ", width: null, height: null, seed: null };
  const response = await f.request("/jobs", "POST", command, { "idempotency-key": "schema-null-defaults" }); assert.equal(response.status, 202); const job = await response.json();
  assert.equal(job.prompt, "owned prompt"); assert.equal(job.width, f.model.width); assert.equal(job.height, f.model.height); assert.equal(job.seed, 1);
  for (const [body, message] of [[{ ...command, providerExtra: true }, "请求包含不支持的参数。"], [{ ...command, prompt: " " }, "提示词须为 1–12000 个字符。"], [[], "请求必须是 JSON 对象。"], [null, "请求必须是 JSON 对象。"]] as const) {
    const invalid = await f.request("/jobs", "POST", JSON.stringify(body), { "idempotency-key": "schema-invalid-body" }); assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { message });
  }
});

test("native local settings keep revision and unknown-field 409 while selected-peer bodies retain arbitrary shapes", async t => {
  const f = await fixture(t); f.setAlive(false);
  for (const body of [{ modelRoot: null, expectedRevision: 0, unknown: true }, { modelRoot: null, expectedRevision: "0" }, {}, [], null]) {
    const response = await f.request("/models/settings", "PATCH", JSON.stringify(body)); assert.equal(response.status, 409); assert.deepEqual(await response.json(), { message: "目录设置已改变，请刷新后重试。" });
  }
  const invalidLayout = await f.request("/models/settings", "PATCH", { modelRoot: null, expectedRevision: 0, layout: "other" }); assert.equal(invalidLayout.status, 400); assert.deepEqual(await invalidLayout.json(), { message: "模型目录布局无效。" });
  const accepted = await f.request("/models/settings", "PATCH", { modelRoot: { originalDriverValue: true }, expectedRevision: 0, layout: "categorized" }); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).layout, "flat");
  const initialization = await f.request("/models/initialize", "POST", { expectedRevision: 1, unknown: true }); assert.equal(initialization.status, 409); assert.deepEqual(await initialization.json(), { message: "模型目录已改变，请重新查看下载空间。" });
  for (const body of [{ providerOption: { arbitrary: [null, true] }, expectedRevision: "provider-owned" }, [1, 2], null]) {
    const response = await f.request("/models/settings?computeDeviceId=owned-compute", "PATCH", JSON.stringify(body)); assert.equal(response.status, 200); assert.deepEqual((await response.json()).body, body);
  }
});

test('native material import and dated trigger expose one discoverable idempotent receipt',async t=>{
 const f=await fixture(t),projectId=randomUUID(),canvasId=randomUUID(),triggerId=randomUUID();
 const created=await f.request('/v2/projects','POST',{id:projectId,title:'Bundle fixture'});assert.equal(created.status,200);
 const source={version:2,name:'Bundle template',workspaceBindingKey:'fixture',variables:[],graph:{nodes:[{id:'human',kind:'human',config:{}}],edges:[],groups:[]}};
 const imported=await f.request('/v2/projects/'+projectId+'/canvases/import','POST',{id:canvasId,source,materials:[{path:'materials/brief.txt',base64:Buffer.from('native bundle').toString('base64')}]});assert.equal(imported.status,200,await imported.clone().text());
 const root='/v2/projects/'+projectId+'/canvases/'+canvasId;
 const accepted=await f.request(root+'/trigger','POST',{id:triggerId,date:'2026-11-17'});assert.equal(accepted.status,202,await accepted.clone().text());const first=await accepted.json();
 const queried=await f.request(root+'/triggers/'+triggerId);assert.equal(queried.status,200);assert.equal((await queried.json()).run.id,first.run.id);
 const replay=await f.request(root+'/trigger','POST',{id:triggerId,date:'2026-11-17'});assert.equal(replay.status,202);assert.equal((await replay.json()).run.id,first.run.id);
 const material=path.join(f.root,'projects',projectId,'canvases',canvasId,'materials','brief.txt');assert.equal(await fs.readFile(material,'utf8'),'native bundle');
 assert.ok(f.registry.catalogSnapshot().operations.some(row=>row.contract.operationId==='manager.video.workbench.trigger-read'));
});

test('native Manager event stream resumes an accepted Agent and retires without a subscriber leak',async t=>{
 const f=await fixture(t),hub=new ManagerEventHub();let responded=false,sends=0,finish!:()=>void;
 const completed=new Promise<void>(resolve=>{finish=resolve;});
 Object.assign(f.runtime,{agentTasks:{events:()=>hub.open(),send:async()=>{sends++;return{};},inspect:async()=>({request:responded?{id:'request',status:'responded',response:{by:{threadId:'exact-target',agentAdapter:'test'},result:JSON.stringify({status:'succeeded'})}}:{status:'awaiting_response'}})}});
 f.runs.publish=(_name:string,event:{state:string})=>{if(event.state==='succeeded')finish();};f.runs.observeAgentEvents();assert.equal(hub.activeSubscriberCount(),1);
 await fs.writeFile(path.join(f.root,'brief.txt'),'Native Agent event fixture');
 const project=await f.projects.createProjectV2({id:randomUUID()}),canvas=await f.projects.readCanvas(project.id,project.defaultCanvasId);
 const saved=await f.projects.saveCanvas(project.id,canvas.id,{...canvas,workspaceBindingKey:'fixture',graph:{nodes:[{id:'agent',kind:'agent',config:{target:{threadId:'exact-target',agentAdapter:'test'},source:{sourceThreadId:'source',sourceAgentType:'codex'},briefRef:{root:'materials',path:'brief.txt'}}}],edges:[],groups:[]}});
 const original=await f.runs.start(project.id,canvas.id,{id:randomUUID(),revision:saved.revision});await f.runs.flights.get(original.id);
 responded=true;hub.publish('agent_requests_changed',{requestId:'request',status:'responded'});
 let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Agent event was not consumed')),2000);})]);}finally{clearTimeout(timer);}
 assert.equal((await f.runs.read(original.id)).state,'succeeded');assert.equal(sends,1);
 await f.runs.close();assert.equal(hub.activeSubscriberCount(),0);
});
