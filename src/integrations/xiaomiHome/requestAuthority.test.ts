import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once, EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeArtifactAccess } from "./artifactAccess.js";
import { XiaomiHomeRuntimeController as RuntimeController, XiaomiHomeSettingsStore } from "./settingsRuntime.js";
import { XiaomiHomeCredentialStore } from "./credentials.js";
import { normalizeHomeAssistantState } from "./managerApi.js";
import test, { type TestContext } from "node:test";
import { LanAgentAuthority } from "../../manager/lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "../../manager/globalConfig.js";
import { evaluateLanAgentRequest } from "../../manager/lanAgentRequestAccess.js";
import { handleXiaomiHomeManagerApi, type XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";
import { createXiaomiHomeRequestAuthority, XiaomiHomeRequestAuthorityError } from "./requestAuthority.js";
import { XiaomiHomeManagerApiClient } from "./managerApi.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";
import { HomeAssistantDeployment } from "./homeAssistantDeployment.js";

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
};
const fence = { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, handler: http.RequestListener) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const global = new RabiGlobalConfigStore(root);
  global.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
  authority.registerAgentCatalog(credential.token, [binding]);
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true, () => global.getLanAgentAdmissionPolicy());
    if (access.kind !== "agent") { json(response, 403, { error: "ingress denied" }); return; }
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.20", configurable: true });
    handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, authority, global, url: `http://127.0.0.1:${address.port}/api/agent/xiaomi-home`,
    headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker", "x-rabiroute-expected-application-generation-id": fence.applicationGenerationId, "x-rabiroute-expected-manager-instance-id": fence.managerInstanceId },
    revoke(mode: string) {
      if (mode === "global-aba") { global.patch({ webguiLan: { enabled: false } }); global.patch({ webguiLan: { enabled: true } }); }
      else if (mode === "binding") authority.approveAgentBinding("fixture-node", { ...binding, sessionId: "replacement" });
      else if (mode === "reenroll") {
        authority.revokeNode("fixture-node");
        const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
        authority.registerAgentCatalog(replacement.token, [binding]);
      }
      else { authority.setAgentEnabled("fixture-node", "worker", false); if (mode === "agent-aba") authority.setAgentEnabled("fixture-node", "worker", true); }
    }
  };
}
function context(runtime: object, readJsonBody: XiaomiHomeManagerRoutesContext["readJsonBody"]): XiaomiHomeManagerRoutesContext {
  return { runtime: runtime as XiaomiHomeRuntimeController, lifecycleFence: fence, readJsonBody, jsonResponse: json, deliverEvent: async () => undefined, controlPlaneAccessAllowed: () => true };
}

test("authenticated remote Agent reaches inventory and deployment without WebGUI exemption", async t => {
  const f = await fixture(t, (request, response) => handleXiaomiHomeManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response,
    { ...context({ client: { listResources: async () => ["inventory"] }, deployment: { inspect: async () => ({ state: "ready" }) } }, async () => ({} as never)), controlPlaneAccessAllowed: () => false }));
  for (const suffix of ["/resources", "/deployment"]) { const response = await fetch(f.url + suffix, { headers: f.headers }); assert.equal(response.status, 200); }
});

for (const mode of ["disable", "agent-aba", "global-aba", "binding", "reenroll"]) {
  test(`original Xiaomi lease rejects settings body continuation after ${mode}`, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let writes = 0;
    const f = await fixture(t, (request, response) => handleXiaomiHomeManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response,
      context({ update: () => { writes++; return { secret: "not-disclosed" }; } }, async () => { entered.resolve(); await gate.promise; return { settings: {}, revision: "fixture" } as never; })));
    const pending = fetch(f.url + "/settings", { method: "PUT", headers: f.headers, body: "{}" });
    await entered.promise; f.revoke(mode); gate.resolve(); const response = await pending;
    assert.equal(response.status, 403); assert.match(await response.text(), /not_started/); assert.equal(writes, 0);
  });
  test(`provider body rechecks original Xiaomi lease after ${mode}`, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
    const f = await fixture(t, (request, response) => {
      const client = new XiaomiHomeManagerApiClient({ runtimeDir: f.root }, async () => ({ ok: true, status: 200, text: async () => { entered.resolve(); await gate.promise; return "[]"; } }) as Response, "fixture-provider-token");
      handleXiaomiHomeManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response, context({ client }, async () => ({} as never)));
    });
    const pending = fetch(f.url + "/resources", { headers: f.headers }); await entered.promise; f.revoke(mode); gate.resolve();
    const response = await pending; assert.equal(response.status, 403); assert.match(await response.text(), /not_started/);
  });
}

test("revoked loopback-shaped Agent cannot use WebGUI or localhost fallback", async t => {
  let reads = 0;
  const f = await fixture(t, (request, response) => {
    f.revoke("agent-aba"); Object.defineProperty(request.socket, "remoteAddress", { value: "127.0.0.1" });
    handleXiaomiHomeManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response, context({ settings: () => { reads++; return {}; } }, async () => ({} as never)));
  });
  const response = await fetch(f.url + "/settings", { headers: f.headers }); assert.equal(response.status, 403); assert.equal(reads, 0);
});

test("deployment process await does not start the next probe or fallback after revocation", { timeout: 10000 }, async t => {
  const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let calls = 0;
  const f = await fixture(t, (request, response) => {
    const deployment = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", {
      run: async () => { calls++; entered.resolve(); await gate.promise; return "fixture-container"; }, ready: async () => { calls++; return false; }
    }, { inspect: async () => { calls++; entered.resolve(); await gate.promise; return { state: "installed", message: "fixture" }; }, run: async () => { assert.fail("unexpected install"); } });
    handleXiaomiHomeManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response, context({ deployment }, async () => ({} as never)));
  });
  const pending = fetch(f.url + "/deployment", { headers: f.headers }); await entered.promise; f.revoke("global-aba"); gate.resolve();
  const response = await pending; assert.equal(response.status, 403); assert.equal(calls, 1);
});

test("dispatch classification is unknown without replacing the captured lease", async t => {
  const f = await fixture(t, (request, response) => {
    const guard = createXiaomiHomeRequestAuthority(request); guard.dispatch(); f.revoke("global-aba");
    assert.throws(guard.assert, (error: unknown) => error instanceof XiaomiHomeRequestAuthorityError && error.outcome === "unknown");
    json(response, 200, { ok: true });
  });
  assert.equal((await fetch(f.url + "/health", { headers: f.headers })).status, 200);
});

test("candidate token verification revocation cannot replace protected credentials", async t => {
  const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let runtime!: RuntimeController; let credentialStore!: XiaomiHomeCredentialStore;
  const f = await fixture(t, (request, response) => {
    const guard = createXiaomiHomeRequestAuthority(request);
    void runtime.authorize("candidate-token", "http://127.0.0.1:8123", runtime.settings().revision, undefined, guard)
      .then(() => json(response, 200, {})).catch(error => json(response, error.status || 500, { outcome: error.outcome }));
  });
  credentialStore = new XiaomiHomeCredentialStore(f.root, { scheme: "fixture", protect: value => Buffer.from(value).toString("base64"), unprotect: value => Buffer.from(value, "base64").toString() });
  credentialStore.write("existing-fixture-token", "http://127.0.0.1:8123", { providerName: "Fixture" });
  runtime = new RuntimeController(new XiaomiHomeSettingsStore(f.root, {}), new XiaomiHomeArtifactStore(f.root), {
    deliverEvent: async () => undefined, fetchImpl: async () => { entered.resolve(); await gate.promise; return new Response('{"name":"Fixture"}'); }
  }, credentialStore);
  const pending = fetch(f.url + "/auth", { headers: f.headers }); await entered.promise; f.revoke("global-aba"); gate.resolve();
  const response = await pending; assert.equal(response.status, 403); assert.equal(credentialStore.resolve().token, "existing-fixture-token");
  assert.equal(runtime.settings().source, "profile");
});

test("pre-dispatch action revocation releases the durable key for a fresh admitted request", { timeout: 10000 }, async t => {
  const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let posts = 0; let reads = 0; let client!: XiaomiHomeManagerApiClient;
  const state = { entity_id: "switch.fixture", state: "off", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" };
  const intent = { resourceId: "home:ha:switch.fixture", capability: "home.switch.turn_on@1", expectedStateVersion: normalizeHomeAssistantState(state).stateVersion };
  const f = await fixture(t, (request, response) => {
    void client.executeAction(intent, "fixture-action-before-dispatch", createXiaomiHomeRequestAuthority(request))
      .then(result => json(response, 200, result)).catch(error => json(response, error.status || 500, { outcome: error.outcome }));
  });
  client = new XiaomiHomeManagerApiClient({ runtimeDir: f.root, writeEnabled: true }, async (_input, init) => {
    if (init?.method === "POST") { posts++; return new Response("[]"); }
    if (++reads === 1) { entered.resolve(); await gate.promise; }
    return new Response(JSON.stringify(posts ? { ...state, state: "on" } : state));
  }, "fixture-token");
  const pending = fetch(f.url + "/actions", { headers: f.headers });
  await entered.promise; f.revoke("disable"); gate.resolve();
  const rejected = await pending; assert.equal(rejected.status, 403); assert.deepEqual(await rejected.json(), { outcome: "not_started" }); assert.equal(posts, 0);
  f.authority.setAgentEnabled("fixture-node", "worker", true);
  const fresh = await fetch(f.url + "/actions", { headers: f.headers });
  assert.equal(fresh.status, 200); assert.equal((await fresh.json() as { status: string }).status, "succeeded"); assert.equal(posts, 1);
});

test("action revoked after POST stays unknown, hides receipt and never retries POST", { timeout: 10000 }, async t => {
  const entered = deferred(); const gate = deferred(); t.after(gate.resolve); let posts = 0; let reads = 0;
  const state = { entity_id: "switch.fixture", state: "off", attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" };
  const f = await fixture(t, (request, response) => {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir: f.root, writeEnabled: true }, async (input, init) => {
      if (init?.method === "POST") { posts++; entered.resolve(); await gate.promise; return new Response("[]"); }
      reads++; return new Response(JSON.stringify(state));
    }, "fixture-token");
    const guard = createXiaomiHomeRequestAuthority(request);
    void client.executeAction({ resourceId: "home:ha:switch.fixture", capability: "home.switch.turn_on@1", expectedStateVersion: normalizeHomeAssistantState(state).stateVersion }, "fixture-action-key-0001", guard)
      .then(result => json(response, 200, result)).catch(error => json(response, error.status || 500, { outcome: error.outcome }));
  });
  const pending = fetch(f.url + "/actions", { headers: f.headers }); await entered.promise; f.revoke("agent-aba"); gate.resolve();
  const response = await pending; assert.equal(response.status, 403); assert.deepEqual(await response.json(), { outcome: "unknown" });
  assert.equal(posts, 1); assert.equal(reads, 1);
  const replay = await fetch(f.url + "/actions", { headers: f.headers });
  assert.equal(replay.status, 409); assert.equal(posts, 1);
});

for (const continuation of ["chunk", "drain", "close"]) {
  test(`artifact ACL survives Agent parity and stream ${continuation} continuation stays bounded`, { timeout: 10000 }, async t => {
  let access!: XiaomiHomeArtifactAccess; let artifactId = ""; let written = 0; const stopped = deferred();
  const f = await fixture(t, (request, response) => {
    if (request.headers["x-rabiroute-artifact-token"] !== "fixture-artifact-token") {
      try { access.stream(request, response, artifactId); assert.fail("ACL must reject missing artifact token"); }
      catch (error) { assert.equal((error as { status: number }).status, 401); json(response, 401, {}); }
      return;
    }
    const sink = new EventEmitter() as http.ServerResponse;
    sink.writeHead = (() => sink) as typeof sink.writeHead;
    sink.write = ((chunk: Buffer) => {
      written += chunk.length;
      if (continuation === "close") queueMicrotask(() => sink.emit("close"));
      else f.revoke("global-aba");
      if (continuation === "drain") queueMicrotask(() => sink.emit("drain"));
      return continuation === "chunk";
    }) as typeof sink.write;
    sink.destroy = (() => { stopped.resolve(); return sink; }) as typeof sink.destroy;
    sink.end = (() => { assert.fail("revoked stream must not complete"); }) as typeof sink.end;
    access.stream(request, sink, artifactId);
    void stopped.promise.then(() => json(response, 200, { written }));
  });
  const store = new XiaomiHomeArtifactStore(f.root); const media = store.allocateMediaPath("fixture-stream", "2026-01-01T00:00:00Z", ".mp4");
  const bytes = Buffer.alloc(256 * 1024, 0x41); fs.mkdirSync(path.dirname(media), { recursive: true }); fs.writeFileSync(media, bytes);
  artifactId = store.register({ sourceEventId: "fixture-stream", resourceId: "home:ha:camera.fixture", eventKind: "camera_motion_detected", occurredAt: "2026-01-01T00:00:00Z", mediaKind: "video/mp4", localPath: media, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length }).artifactId;
  access = new XiaomiHomeArtifactAccess({}, store, { RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN: "fixture-artifact-token" });
  assert.equal((await fetch(f.url + "/artifacts/content", { headers: f.headers })).status, 401);
  const response = await fetch(f.url + "/artifacts/content", { headers: { ...f.headers, "x-rabiroute-artifact-token": "fixture-artifact-token" } });
  assert.equal(response.status, 200); assert.ok(written > 0 && written < bytes.length); await response.text();
  });
}

test("deployment queue admission rechecks the original lease before OS dispatch", { timeout: 10000 }, async t => {
  const entered = deferred(); const admitted = deferred(); const gate = deferred(); t.after(gate.resolve); let deployment!: HomeAssistantDeployment; let dispatched = 0;
  const f = await fixture(t, (request, response) => {
    const guard = createXiaomiHomeRequestAuthority(request);
    void deployment.install(revision, guard).then(result => json(response, 200, result)).catch(error => json(response, error.status || 500, { outcome: error.outcome }));
    admitted.resolve();
  });
  deployment = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", { run: async () => "", ready: async () => false }, {
    inspect: async () => ({ state: "installed", message: "fixture" }),
    run: async () => { dispatched++; entered.resolve(); await gate.promise; return { state: "installed", message: "fixture" }; }
  });
  const snapshot = await deployment.inspect();
  const saved = await deployment.save({ ...snapshot.config, mode: "haos" }, snapshot.revision);
  const revision = saved.revision;
  const autonomous = deployment.install(revision); await entered.promise;
  const pending = fetch(f.url + "/deployment/install", { headers: f.headers });
  await admitted.promise;
  f.revoke("global-aba"); gate.resolve(); await autonomous;
  const response = await pending; assert.equal(response.status, 403); assert.equal(dispatched, 1);
});

test("disabled global ingress rejects credentials before Xiaomi handlers", async t => {
  let invoked = 0;
  const f = await fixture(t, (_request, response) => { invoked++; json(response, 200, {}); });
  f.global.patch({ webguiLan: { enabled: false } });
  assert.equal((await fetch(f.url + "/deployment", { headers: f.headers })).status, 403); assert.equal(invoked, 0);
});
