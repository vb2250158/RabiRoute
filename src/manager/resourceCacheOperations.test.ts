import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createManagerClient, type ManagerOperationOptions } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { ResourceCache, type ResourceCacheOptions } from "./resourceCache.js";
import { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { AllDayRecordingStore } from "./allDayRecording.js";
import { DEFAULT_ALL_DAY_SETTINGS } from "../shared/allDayRecording.js";
import { recordingManifestHash } from "./recordingArchiveContract.js";
import { createResourceCacheOperations } from "./resourceCacheOperations.js";
import { authenticatedResourceOwner } from "./resourceApiRequest.js";
import { RESOURCE_API_ROUTES } from "./resourceApiContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { createManagerMetadataOperation } from "./corePublicOperations.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const namespace = "12345678-1234-4234-8234-123456789abc";
async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-operations-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state"), role = path.join(root, "roles", "fixture-role");
  await fs.mkdir(state); await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  const config = new RabiGlobalConfigStore(root); config.patch({ webguiLan: { enabled: true } });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const cache = new ResourceCache(state);
  const mobile = new AllDayRecordingStore(() => role, "fixture-worker", path.join(root, "mobile"));
  const cacheOptions: ResourceCacheOptions = { local: () => false, tunnelKey: () => "fixture-device-key", readOnly: () => false,
    receiveRecording: async (owner, body, authorize = () => {}) => {
      for (const hash of (body as { chunks: string[] }).chunks) { authorize(); await cache.read(owner, hash); authorize(); }
      await mobile.receiveMobile(owner, body, authorize);
    } };
  const archive = new RecordingArchiveRuntime({ stateDir: state, roleDirectory: () => role, workerId: () => "fixture-worker",
    authorizeResources: request => authenticatedResourceOwner(request, { local: () => false, key: () => "fixture-device-key" }),
    localAdmin: () => false, readOnly: () => false, readProcessing: async () => ({ state: "completed", text: "fixture transcript", jobKey: "fixture-job", processingVersion: "fixture-v1" }) });
  const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ ...identity, pluginGenerationId: "fixture-plugins" }) });
  const registrations = [registry.registerOperations("resources", createResourceCacheOperations({ cache, cacheOptions, archive,
    admin: { bindings: archive.bindings, receiptRoot: state, identity: () => identity, workerId: () => "fixture-worker", readOnly: () => false, changed: () => archive.restore().then(() => {}) } })),
    registry.registerOperations("discovery", createApiDiscoveryOperations(registry)),
    registry.registerOperations("metadata", [createManagerMetadataOperation(() => ({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } }))])];
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await Promise.all(registrations.map(registration => registration.dispose())); await archive.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "codex", sessionId: "fixture-original-full-session" });
  const invoke = (key: typeof RESOURCE_API_ROUTES[number]["key"], options: ManagerOperationOptions = {}) => client.invokeOperation(`manager.resources.${key}`, options);
  const success = async (key: Parameters<typeof invoke>[0], options: ManagerOperationOptions = {}) => {
    const response = await invoke(key, options); const body = JSON.parse(String(response.body));
    assert.equal(response.statusCode, 200, body.errorCode ?? body.code ?? body.message); return { response, body };
  };
  const ownerHeaders = (owner = "archive-phone") => ({ "x-rabilink-resource-owner": owner });
  const bind = async (owner = "archive-phone", enabled = true, expectedRevision = 0, key = "fixture-binding") => {
    const current = await success("archive-settings.read");
    return success("archive-settings.update", { body: { owner, roleId: "fixture-role", storageNamespaceId: namespace, provision: expectedRevision === 0, enabled, expectedRevision },
      headers: { "idempotency-key": key, "if-match": current.response.headers!.etag } });
  };
  const pcm = Buffer.alloc(32000, 1), objectHash = sha(pcm);
  const manifest = { schemaVersion: 1, recordId: "record", captureId: "capture", eventId: "event", deviceId: "archive-phone", source: "phone",
    startedAt: 1000, endedAt: 2000, timeBasis: "received", format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
    segments: [{ sequence: 1, bytes: pcm.length, sha256: objectHash, startedAt: 1000 }], objects: [{ sha256: objectHash, bytes: pcm.length, offset: 0 }],
    gaps: [], processingPolicy: "transcribe", totalBytes: pcm.length, sealed: true };
  return { root, state, role, registry, registration: registrations[0]!, cache, mobile, archive, authority, credential, base, invoke, success, bind, ownerHeaders, pcm, objectHash, manifest };
}

test("all thirteen resources operations use discovery, the authenticated node and real durable owners without a resources key", async t => {
  const f = await fixture(t);
  const advertised = f.registry.catalogSnapshot().operations.filter(operation => operation.contract.operationId.startsWith("manager.resources."));
  assert.equal(advertised.length, RESOURCE_API_ROUTES.length);
  await f.success("settings.read");
  const directory = path.join(f.root, "resource-directory"); await f.success("settings.update", { body: { directory } });
  assert.equal((await new ResourceCache(f.state).settings()).directory, directory);
  const bound = await f.bind(); assert.equal(bound.body.data.revision, 1);
  const headers = f.ownerHeaders();
  const uploaded = await f.success("object.write", { path: { objectHash: f.objectHash }, headers, bodyBytes: f.pcm });
  assert.equal(uploaded.body.storageNamespaceId, namespace); assert.equal(uploaded.body.durable, undefined);
  const capabilities = await f.success("archive.capabilities", { headers }); assert.equal(capabilities.body.bindingRevision, 1);
  const hash = recordingManifestHash(f.manifest);
  const committed = await f.success("archive.manifest.commit", { headers, path: { recordId: "record", manifestHash: hash }, body: f.manifest });
  const repeated = await f.success("archive.manifest.commit", { headers, path: { recordId: "record", manifestHash: hash }, body: f.manifest });
  assert.deepEqual(repeated.body, committed.body);
  assert.equal(committed.body.durability, "archived"); assert.equal(committed.body.retention, "indefinite");
  assert.deepEqual((await f.success("archive.receipt.read", { headers, path: { recordId: "record", manifestHash: hash } })).body, committed.body);
  assert.deepEqual((await f.success("archive.manifest.read", { headers, path: { recordId: "record" } })).body, f.manifest);
  const records = await f.success("archive.recordings.list", { headers, query: { limit: 1 } });
  assert.equal(records.body.items[0].manifestHash, hash); assert.equal(records.body.items[0].text, "fixture transcript");
  assert.equal((await f.success("archive.processing.read", { headers, path: { recordId: "record" } })).body.state, "completed");
  const bytes = await f.invoke("object.read", { headers, path: { objectHash: f.objectHash }, responseMode: "bytes" });
  assert.equal(bytes.statusCode, 200); assert.deepEqual(bytes.bodyBytes, f.pcm);
  const legacyHeaders = f.ownerHeaders("legacy-phone");
  assert.equal((await f.success("object.write", { headers: legacyHeaders, path: { objectHash: f.objectHash }, bodyBytes: f.pcm })).body.durable, true);
  const compatibleBytes = await fetch(`${f.base}/api/resource-cache/data/objects/${f.objectHash}`, { method: "PUT",
    headers: { authorization: `Bearer ${f.credential.token}`, ...legacyHeaders, "content-type": "text/plain" }, body: f.pcm });
  assert.equal(compatibleBytes.status, 200); assert.equal((await compatibleBytes.json()).durable, true);
  const now = Date.now(); const event = { id: "fixture-event", startedAt: now, endedAt: now + 1000, text: "fixture mobile transcript", chunks: [f.objectHash] };
  await f.success("recording-events.write", { headers: legacyHeaders, body: event });
  await f.success("recording-events.write", { headers: legacyHeaders, body: event });
  await f.mobile.configure("fixture-role", { ...DEFAULT_ALL_DAY_SETTINGS, mobileDeviceIds: [sha("legacy-phone")] });
  const timeline = await f.mobile.timeline("fixture-role", now - 1, now + 2000);
  assert.equal(timeline.length, 1); assert.equal(timeline[0]!.text, event.text);
  const exported = JSON.stringify(f.registry.catalogSnapshot());
  assert.equal(exported.includes(f.root), false); assert.equal(exported.includes(f.credential.token), false);
  assert.equal((await fs.readFile(path.join(f.state, "resource-cache.json"), "utf8")).includes('"archiveBindings"'), true);
});

test("an enabled archive never falls back to legacy objects after a missing namespace or explicit disable", async t => {
  const f = await fixture(t); const headers = f.ownerHeaders();
  await f.cache.put("archive-phone", f.objectHash, f.pcm);
  await f.bind();
  assert.equal((await f.invoke("object.read", { headers, path: { objectHash: f.objectHash } })).statusCode, 404);
  const target = (await f.archive.bindings.describeOwner("archive-phone")).root;
  assert.ok(!path.relative(f.root, target).startsWith(".."));
  await fs.rename(target, target + "-offline");
  try {
    assert.equal((await f.invoke("object.read", { headers, path: { objectHash: f.objectHash } })).statusCode, 503);
    const cached = await f.success("archive.recordings.list", { headers }); assert.equal(cached.body.offline, true);
    assert.equal((await f.invoke("archive.manifest.commit", { headers, path: { recordId: "record", manifestHash: recordingManifestHash(f.manifest) }, body: f.manifest })).statusCode, 503);
  } finally { await fs.rename(target + "-offline", target); }
  await f.bind("archive-phone", false, 1, "fixture-disable-binding");
  assert.equal((await f.invoke("object.read", { headers, path: { objectHash: f.objectHash } })).statusCode, 403);
  assert.equal((await f.invoke("archive.capabilities", { headers })).statusCode, 403);
});

test("resource request revocation during temporary object creation or fsync never publishes the final object", async t => {
  for (const stage of ["open", "sync"]) await t.test(stage, async t => {
    const f = await fixture(t); await f.bind();
    const target = (await f.archive.bindings.describeOwner("archive-phone")).root;
    const final = path.join(target, "objects", sha("archive-phone"), f.objectHash.slice(0, 2), f.objectHash);
    const originalOpen = fs.open.bind(fs);
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(final + ".") && String(args[0]).endsWith(".partial")) {
        const revoke = () => { f.authority.setNodeEnabled("fixture-node", false); f.authority.setNodeEnabled("fixture-node", true); };
        if (stage === "open") revoke(); else { const original = handle.sync.bind(handle); t.mock.method(handle, "sync", async () => { await original(); revoke(); }); }
      }
      return handle;
    });
    const result = await f.invoke("object.write", { headers: f.ownerHeaders(), path: { objectHash: f.objectHash }, bodyBytes: f.pcm });
    assert.equal(result.statusCode, 403);
    assert.equal(result.uncertain, true);
    await assert.rejects(fs.stat(final), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(path.dirname(final)), []);
  });
});

test("resource registration retirement joins the actual configuration owner after the HTTP client disconnects", { timeout: 15000 }, async t => {
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = await fixture(t);
  const original = f.cache.configure.bind(f.cache);
  t.mock.method(f.cache, "configure", async (...args: Parameters<typeof original>) => { started(); await blocked; return original(...args); });
  const controller = new AbortController(), directory = path.join(f.root, "lease-directory");
  const result = f.invoke("settings.update", { body: { directory }, signal: controller.signal });
  await entered; controller.abort(); await result;
  let retired = false; const stopped = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(retired, false); assert.ok(f.registration.activeOperationCount() > 0);
  finish(); await stopped;
  assert.equal((await f.cache.settings()).directory, directory); assert.equal(f.registration.activeOperationCount(), 0);
});
