import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { createVideoOperations } from "./videoOperations.js";
import { createVideoRequestAccess } from "./videoRuntime.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
// @ts-ignore Native plugin owners, exercised with controlled runtime drivers only.
import { VideoService } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/service.mjs";
// @ts-ignore Native plugin owner.
import { VideoModels } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/models.mjs";
// @ts-ignore Native plugin owner.
import { VideoAssets } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/assets.mjs";
// @ts-ignore Native plugin owner.
import { VideoProjects } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/projects.mjs";
// @ts-ignore Native plugin owner.
import { RemoteVideoCompute } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/remoteCompute.mjs";
// @ts-ignore Native plugin event source, with no state polling.
import { createVideoApiEvents, createVideoOperationsOwner } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/apiOwner.mjs";

// @ts-ignore Native field definitions are supplied by the current plugin activation.
import { createVideoContracts } from "../../plugins/builtin/io.rabiroute.manager.video/1.0.0/contracts.mjs";

const bind = (server: http.Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port)));
const close = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-contract-http-")), calls: unknown[] = [];
  const cleanup: Array<() => Promise<unknown>> = [], releases: Array<() => void> = [];
  t.after(async () => { for (const release of releases) release(); await Promise.allSettled(cleanup.map(dispose => dispose())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("video-contract-http-")); await fs.rm(root, { recursive: true, force: true }); });
  const catalog = JSON.parse(await fs.readFile(new URL("../../plugins/builtin/io.rabiroute.manager.video/1.0.0/catalog.json", import.meta.url), "utf8"));
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
  const readJsonBody = <T>(request: http.IncomingMessage, limit: number): Promise<T> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false;
    request.on("data", chunk => { if (failed) return; size += chunk.length; if (size > limit) { failed = true; reject(new Error("Original model body cap")); return; } chunks.push(Buffer.from(chunk)); });
    request.on("error", reject); request.on("end", () => { if (!failed) { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (cause) { reject(cause); } } });
  });
  let streamCreated: (() => void) | undefined;
  const eventSource = { job: events.job, compute(access: ReturnType<typeof createVideoRequestAccess>) { const stream = events.compute(access); streamCreated?.(); return stream; } };
  const nativeContext = { contracts: createVideoContracts(catalog), runtime, catalog, service, models, assets, computeAssets, projects, events: eventSource, readJsonBody };
  const bundle = createVideoOperations({ ...nativeContext, owner: createVideoOperationsOwner(nativeContext) } as never);
  const registry = new ManagerPluginRouteRegistry(), operations = registry.registerOperations("video-fixture", bundle.operations); cleanup.push(() => operations.dispose());
  const proxies = registry.registerHttpProxies("video-fixture", bundle.proxies); cleanup.push(() => proxies.dispose());
  const authority = new LanAgentAuthority({ statePath: path.join(root, "node-authority.json") }), credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-video-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
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
  return { root, runtime, catalog, model, events, service, models, assets, computeAssets, projects, bundle, registry, operations, proxies, authority, credential, base, request, savedJob, calls, releases, holdPeer, setAlive: (value: boolean) => { alive = value; }, onStreamCreated: (callback: () => void) => { streamCreated = callback; } };
}

test("34 fixed Video contracts and one native model wildcard register with original mediaId aliases and public connection access", async t => {
  const f = await fixture(t); assert.equal(f.bundle.operations.length, 25); assert.equal(f.bundle.proxies.length, 10);
  const rows = f.registry.catalogSnapshot().operations; assert.equal(rows.length, 35); assert.ok(rows.every(row => row.contract.exposure === "public"));
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

test("queued native project save keeps the original Node incarnation and does not commit after revocation", async t => {
  const f = await fixture(t), id = randomUUID(); await f.request("/projects", "POST", { id });
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }); f.releases.push(release);
  const mutate = f.projects.mutate.bind(f.projects); f.projects.serial = gate; f.projects.mutate = (operation: unknown, access: unknown) => { entered(); return mutate(operation, access); };
  const pending = f.request("/projects/" + id, "PUT", { revision: 0, value: { version: 1, active: "video", items: [{ id: "video", kind: "video" }], drafts: [] } });
  await started; f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); release();
  const response = await pending; assert.equal(response.status, 403); const denied = await response.json(); assert.equal(denied.mutation ?? denied.mutationOutcome, "not_started"); assert.equal((await new VideoProjects(f.runtime).read(id)).revision, 0);
});

test("retiring an original media proxy joins a backpressured native file read", { timeout: 20000 }, async t => {
  const f=await fixture(t),id=randomUUID();await fs.mkdir(f.assets.root,{recursive:true});
  const bytes=8*1024*1024;await fs.writeFile(path.join(f.assets.root,id+".mp4"),Buffer.alloc(bytes,0x41));await fs.writeFile(path.join(f.assets.root,id+".json"),JSON.stringify({id,kind:"video",size:bytes}));
  let outgoing!:http.ClientRequest,incoming!:http.IncomingMessage,received=0;
  await new Promise<void>((resolve,reject)=>{outgoing=http.get(f.base+"/api/video/assets/"+id,{headers:{authorization:"Bearer "+f.credential.token}},response=>{incoming=response;response.on("error",()=>{});response.once("data",chunk=>{received+=chunk.length;response.pause();resolve();});});outgoing.on("error",reject);});
  assert.ok(received>0 && received<bytes);await f.proxies.dispose();assert.equal(f.proxies.activeOperationCount(),0);incoming.destroy();outgoing.destroy();
});

test("revocation during native SSE creation cancels the undisclosed original subscription", async t => {
  const f = await fixture(t); f.onStreamCreated(() => { f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); });
  const response = await f.request("/compute/events"); assert.equal(response.status, 403); assert.equal(f.events.active(), 0);
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
  const dispatched=f.calls.length;
  assert.equal((await f.request("/models/extension/%2F?computeDeviceId=owned-compute")).status,403);assert.equal(f.calls.length,dispatched);
  assert.equal((await f.request("/modelsXYZ")).status,404);assert.equal((await f.request("/models/settings","PUT","ignored")).status,404);
  assert.equal((await f.request("/models/custom?computeDeviceId=owned-compute","POST",{oversized:"x".repeat(4096)})).status,503);assert.equal(f.calls.length,dispatched);
  f.runtime.readOnly=true;assert.equal((await f.request("/models/custom?computeDeviceId=owned-compute","PROPFIND")).status,423);assert.equal(f.calls.length,dispatched);
});

test("native model exchange retirement cancels and joins an upstream pending before headers", { timeout: 20000 }, async t => {
  const f=await fixture(t),hold=f.holdPeer(),pending=f.request("/models/custom?computeDeviceId=owned-compute").catch(()=>undefined);
  await hold.started;await f.proxies.dispose();await hold.closed;await pending;assert.equal(f.proxies.activeOperationCount(),0);assert.equal(f.calls.length,1);
});

test("a dispatched native model mutation keeps its unknown outcome and suppresses the revoked peer response", async t => {
  const f=await fixture(t),hold=f.holdPeer(),pending=f.request("/models/custom?computeDeviceId=owned-compute","POST",{ownedFixture:true});
  await hold.started;f.authority.setNodeEnabled(f.credential.nodeId,false,true);f.authority.setNodeEnabled(f.credential.nodeId,true,false);hold.respond();
  const response=await pending;assert.equal(response.status,403);const body=await response.json();assert.equal(body.mutationOutcome,"unknown");assert.equal(body.nativePeer,undefined);assert.equal(f.calls.length,1);
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
    const response = definition.contract.responses[definition.contract.operationId.endsWith("submit") ? "202" : "200"];
    assert.ok(response?.schema && Object.keys(response.schema).some(key => key !== "description"), definition.contract.operationId);
  }
  const openapi = JSON.stringify((await apiCatalogOpenApi(f.registry.catalogSnapshot())));
  for (const field of ["expectedRevision", "progressMax", "effectiveModelRoot", "samplingSteps"]) assert.ok(openapi.includes(field));
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
