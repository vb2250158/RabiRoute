import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { createXiaomiHomeManagerOperations } from "./managerOperations.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } from "./settingsRuntime.js";
import { HomeAssistantDeployment } from "./homeAssistantDeployment.js";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "../../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "../../manager/lanAgentBodyAuthority.js";

const basePath = "/api/agent/xiaomi-home";
const fence = { applicationGenerationId: "xiaomi-fixture-generation", managerInstanceId: "xiaomi-fixture-manager" };
const lifecycle = { "x-rabiroute-expected-application-generation-id": fence.applicationGenerationId, "x-rabiroute-expected-manager-instance-id": fence.managerInstanceId };
const bind = (server: http.Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port)));
const stop = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-contract-http-"));
  const providerCalls: string[] = [], nativeCalls: string[] = [], unblocks: Array<() => void> = [];
  const state = { entity_id: "light.fixture", state: "on", attributes: { friendly_name: "Fixture light", supported_color_modes: ["onoff"] }, last_updated: "2026-10-21T00:00:00.000Z" };
  const provider = http.createServer((request, response) => {
    providerCalls.push(request.method + " " + request.url); assert.equal(request.headers.authorization, "Bearer owned-fixture-home-token");
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/config") response.end(JSON.stringify({ location_name: "Owned fixture", version: "fixture" }));
      else if (request.url === "/api/") response.end(JSON.stringify({ message: "API running." }));
      else if (request.url === "/api/states") response.end(JSON.stringify([state]));
      else if (request.url === "/api/states/light.fixture") response.end(JSON.stringify(state));
      else if (request.url === "/api/services") response.end("[]");
      else if (request.url === "/api/template") { assert.equal(typeof JSON.parse(Buffer.concat(chunks).toString()).template, "string"); response.end(JSON.stringify([{ entityId: "light.fixture", deviceId: "fixture-device", displayName: "Fixture device", model: "fixture", manufacturer: "fixture", areaName: "fixture" }])); }
      else { response.statusCode = 404; response.end("{}"); }
    });
  });
  const providerBase = await bind(provider);
  let holdVideoResponse = false, holdVideoHeaders = false, closedVideoResponse: (() => void) | undefined, enteredVideoResponse: (() => void) | undefined;
  const sidecar = http.createServer((request, response) => {
    nativeCalls.push(request.url!); assert.equal(request.headers.authorization, "Basic owned-fixture-video"); enteredVideoResponse?.();
    if (holdVideoHeaders) { response.on("close", () => closedVideoResponse?.()); unblocks.push(() => response.destroy()); return; }
    response.writeHead(200, { "content-type": "video/mp4" });
    if (holdVideoResponse) { response.on("close", () => closedVideoResponse?.()); unblocks.push(() => response.destroy()); response.write(Buffer.from("owned-mp4-fixture")); }
    else response.end(Buffer.from("owned-mp4-fixture"));
  });
  const sidecarBase = await bind(sidecar);
  const artifacts = new XiaomiHomeArtifactStore(directory), settings = new XiaomiHomeSettingsStore(directory, { baseUrl: providerBase, writeEnabled: true, eventMonitorEnabled: false });
  const runtime = new XiaomiHomeRuntimeController(settings, artifacts, { env: {}, deliverEvent: async () => { throw new Error("No real message delivery is permitted."); } });
  (runtime as any).deployment = new HomeAssistantDeployment(directory, () => providerBase, { run: async () => { throw new Error("No real Docker process is permitted."); }, ready: async () => false }, { inspect: async () => ({ state: "not_installed", message: "owned fixture" }), run: async () => { throw new Error("No real install or device process is permitted."); } });
  const authority = new LanAgentAuthority({ statePath: path.join(directory, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-home-node");
  const registry = new ManagerPluginRouteRegistry();
  const bundle = createXiaomiHomeManagerOperations({ runtime, lifecycleFence: fence, deliverEvent: async () => { throw new Error("No real external message is permitted."); } });
  const operations = registry.registerOperations("xiaomi-owned-fixture", bundle.operations), proxies = registry.registerHttpProxies("xiaomi-owned-fixture", bundle.proxies);
  const manager = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  const managerBase = await bind(manager);
  t.after(async () => {
    for (const release of unblocks) release();
    await Promise.allSettled([operations.dispose(), proxies.dispose(), runtime.stop()]);
    await Promise.all([stop(manager), stop(provider), stop(sidecar)]);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("xiaomi-contract-http-")); fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (suffix: string, method = "GET", body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(managerBase + basePath + suffix, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...headers } }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode!, headers: incoming.headers as Record<string, string> })));
    }); outgoing.on("error", reject); outgoing.setTimeout(15000, () => outgoing.destroy(new Error("Owned Xiaomi HTTP fixture timeout."))); outgoing.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const authorize = async () => {
    const saved = await runtime.authorization();
    const response = await request("/auth", "POST", { accessToken: "owned-fixture-home-token" /* Public test-only fixture; not a real credential. */, baseUrl: providerBase, settingsRevision: runtime.settings().revision, authorizationRevision: saved.revision }, { ...lifecycle, "idempotency-key": "owned-home-auth-key-0001" });
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("owned-fixture-home-token"));
  };
  const media = (bytes = Buffer.from("0123456789")) => {
    const occurredAt = "2026-10-21T00:00:00.000Z", file = artifacts.allocateMediaPath("owned-event", occurredAt, ".mp4"); fs.writeFileSync(file, bytes);
    return artifacts.register({ sourceEventId: "owned-event", resourceId: "owned-camera", eventKind: "owned-fixture", occurredAt, mediaKind: "video/mp4", localPath: file, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length });
  };
  const video = () => { (runtime.vacuumCloud.video as any).active = { snapshot: { sessionId: "fixture-session", state: "streaming" }, baseUrl: sidecarBase, auth: "Basic owned-fixture-video", controller: new AbortController() }; };
  const holdVideo = () => { holdVideoResponse = true; return new Promise<void>(resolve => { closedVideoResponse = resolve; }); };
  const holdVideoOpening = () => { holdVideoHeaders = true; return { started: new Promise<void>(resolve => { enteredVideoResponse = resolve; }), closed: new Promise<void>(resolve => { closedVideoResponse = resolve; }) }; };
  const holdHealth = () => { const native = runtime.health.bind(runtime); let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }); unblocks.push(release); runtime.health = async source => { const value = await native(source); entered(); await wait; return value; }; return { started, release }; };
  return { directory, runtime, artifacts, registry, bundle, operations, proxies, authority, credential, request, authorize, media, video, holdVideo, holdVideoOpening, providerCalls, nativeCalls, holdHealth, unblocks, managerBase };
}

test("all 53 exact contracts admit an enrolled empty Node; native owned HA credentials, resource reads and dry-run receipts use the original services", async t => {
  const f = await fixture(t); assert.equal(f.bundle.operations.length, 50); assert.equal(f.bundle.proxies.length, 3); assert.equal(f.registry.catalogSnapshot().operations.length, 53); assert.ok(f.registry.catalogSnapshot().operations.every(operation => operation.contract.exposure === "public"));
  assert.equal((await f.request("/settings")).status, 200); assert.equal((await f.request("/health")).status, 200);
  await f.authorize();
  assert.equal((await f.request("/resources?view=summary")).status, 200);
  const devices = await f.request("/devices"); assert.equal(devices.status, 200); assert.equal((await devices.json()).data.items[0].deviceId, "fixture-device");
  assert.equal((await f.request("/devices/fixture-device")).status, 200);
  const resource = await (await f.request("/resources/home%3Aha%3Alight.fixture")).json();
  const submitted = await f.request("/action-requests", "POST", { resourceId: "home:ha:light.fixture", capability: "home.light.turn_off@1", expectedStateVersion: resource.data.stateVersion, dryRun: true }, { ...lifecycle, "idempotency-key": "owned-dryrun-action-0001" });
  assert.equal(submitted.status, 202); const receipt = await submitted.json(); assert.equal(receipt.data.idempotencyKey, "owned-dryrun-action-0001");
  const recovered = await f.request("/action-requests?idempotencyKey=owned-dryrun-action-0001"); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).data.idempotencyKey, "owned-dryrun-action-0001");
  assert.ok(!f.providerCalls.some(value => value.includes("POST /api/services/")));
});

test("current native lifecycle fences reject malformed credential/action bodies before native admission", async t => {
  const f = await fixture(t);
  for (const suffix of ["/auth", "/auth/refresh", "/settings", "/action-requests", "/vacuum-cloud/login", "/vacuum-remote/start"]) {
    const response = await f.request(suffix, suffix === "/settings" ? "PUT" : "POST", "not-json"); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "xiaomi_home_lifecycle_fence_required");
  }
  assert.deepEqual(f.providerCalls, []);
});

test("native artifact Range and MP4 stream/frame contracts preserve byte headers and original content", async t => {
  const f = await fixture(t), record = f.media();
  const range = await f.request("/artifacts/" + record.artifactId + "/content", "GET", undefined, { range: "bytes=2-5" }); assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 2-5/10"); assert.equal(range.headers.get("content-length"), "4"); assert.equal(await range.text(), "2345");
  const invalid = await f.request("/artifacts/" + record.artifactId + "/content", "GET", undefined, { range: "bytes=20-30" }); assert.equal(invalid.status, 416);
  f.video(); for (const suffix of ["frame", "stream"]) { const response = await f.request("/vacuum-cloud/video/" + suffix + "?sessionId=fixture-session"); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "video/mp4"); assert.equal(await response.text(), "owned-mp4-fixture"); }
  assert.equal(f.nativeCalls.length, 2);
});

test("nonce HTML retains CSP and the native deployment SSE source is cancelled on retirement", async t => {
  const f = await fixture(t), html = await f.request("/vacuum-cloud/connect?deviceId=123&view=embedded"); assert.equal(html.status, 200); assert.match(html.headers.get("content-type")!, /text\/html/); const nonce = /nonce-([^';]+)/.exec(html.headers.get("content-security-policy")!)?.[1]; assert.ok(nonce); assert.ok((await html.text()).includes(nonce!));
  let sourceClosed = false; const native = f.runtime.deployment.subscribe.bind(f.runtime.deployment);
  f.runtime.deployment.subscribe = (listener, failure) => { const unsubscribe = native(listener, failure); return async () => { await unsubscribe(); sourceClosed = true; }; };
  let request!: http.ClientRequest, response!: http.IncomingMessage;
  const first = await new Promise<string>((resolve, reject) => {
    request = http.get(f.managerBase + basePath + "/deployment/events", { headers: { authorization: "Bearer " + f.credential.token } }, incoming => { response = incoming; let text = ""; incoming.on("data", chunk => { text += chunk.toString(); if (text.includes("\n\n")) resolve(text); }); incoming.on("error", reject); }); request.on("error", reject);
  });
  assert.match(first, /event: deployment/); assert.match(first, /data: /);
  await f.operations.dispose(); assert.equal(sourceClosed, true); request.destroy(); response.destroy();
});

test("revoking the original Node while a native read is pending suppresses its old business result", async t => {
  const f = await fixture(t), hold = f.holdHealth();
  const pending = f.request("/health"); await hold.started; f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); assert.equal((await response.json()).data, undefined);
});

for (const reason of ["client disconnect", "plugin retirement"] as const) test("blocked native MP4 upstream closes and joins after " + reason, { timeout: 15000 }, async t => {
  const f = await fixture(t); f.video(); const upstreamClosed = f.holdVideo();
  let outgoing!: http.ClientRequest, incoming!: http.IncomingMessage;
  await new Promise<void>((resolve, reject) => {
    outgoing = http.get(f.managerBase + basePath + "/vacuum-cloud/video/stream?sessionId=fixture-session", { headers: { authorization: "Bearer " + f.credential.token } }, response => {
      incoming = response; response.on("error", () => undefined); response.once("data", chunk => { assert.equal(chunk.toString(), "owned-mp4-fixture"); resolve(); });
    }); outgoing.on("error", reject);
  });
  if (reason === "client disconnect") { incoming.destroy(); outgoing.destroy(); await upstreamClosed; }
  else { await f.proxies.dispose(); await upstreamClosed; incoming.destroy(); outgoing.destroy(); }
  assert.equal(f.runtime.vacuumCloud.video.status("fixture-session").state, "streaming");
});

test("retirement aborts the native MP4 open before upstream response headers arrive", { timeout: 15000 }, async t => {
  const f = await fixture(t); f.video(); const hold = f.holdVideoOpening();
  const pending = f.request("/vacuum-cloud/video/stream?sessionId=fixture-session").catch(() => undefined);
  await hold.started; await f.proxies.dispose(); await hold.closed; await pending;
  assert.equal(f.runtime.vacuumCloud.video.status("fixture-session").state, "streaming");
});
