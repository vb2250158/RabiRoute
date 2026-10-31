import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createRabiControlOperations } from "./rabiApiOperations.js";
import { createRabiApiOwner, type RabiApiContext } from "./rabiApi.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-control-operation-"));
  const globalConfig = new RabiGlobalConfigStore(root);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-control-node");
  let release: (() => void) | undefined, waitForSync = async () => {};
  let managerConfig: Record<string, unknown> = {}, routeRoot = path.join(root, "routes"), rolesRoot = path.join(root, "roles");
  fs.mkdirSync(routeRoot, { recursive: true }); fs.mkdirSync(rolesRoot, { recursive: true });
  let routeConfig = { gateways: [{ id: "route-a", name: "Route A", configName: "route-a", enabled: true, messageAdapters: ["rabilink"], agentAdapters: ["codex"] }] } as any;
  const routeHash = "a".repeat(64);
  const context: RabiApiContext = {
    rootDir: root, get routeRoot() { return routeRoot; }, managerPort: 0, managerHost: "127.0.0.1",
    applicationGenerationId: "generation-control", managerInstanceId: "manager-control", version: () => "fixture", globalConfig,
    runtimes: () => [], runtimeStatus: () => ({}), readConfig: () => structuredClone(routeConfig),
    writeConfig: async (config, expected, operationId) => { assert.equal(expected, routeHash); assert.ok(operationId); routeConfig = structuredClone(config); return structuredClone(routeConfig); },
    loadRuntimes: async () => {}, routeCatalogVersion: () => ({ contentHash: routeHash, routeConfigHash: routeHash, presentationHash: routeHash, revision: 0 }), routeCatalogPersonas: () => [],
    syncRunningGateways: () => {}, syncRabiLinkRelay: () => waitForSync(), scanAgentAdapters: async () => ({}), routeDataDir: () => path.join(root, "workers")
  };
  const definitions = createRabiControlOperations(context, {
    rootDir: root, get routeRoot() { return routeRoot; }, get rolesRoot() { return rolesRoot; },
    readManagerConfig: () => structuredClone(managerConfig), writeManagerConfig: config => { managerConfig = structuredClone(config); fs.writeFileSync(path.join(root, "manager.json"), JSON.stringify(config)); },
    ensureDataDirs: async () => { routeRoot = path.join(root, String(managerConfig.routeDir || "routes")); rolesRoot = path.join(root, String(managerConfig.rolesDir || "roles")); fs.mkdirSync(routeRoot, { recursive: true }); fs.mkdirSync(rolesRoot, { recursive: true }); }
  });
  const registry = new ManagerPluginRouteRegistry();
  let registration: ReturnType<typeof registry.registerOperations>;
  let server: http.Server | undefined;
  t.after(async () => {
    release?.(); await registration?.dispose();
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("rabi-control-operation-")); fs.rmSync(root, { recursive: true, force: true });
  });
  registration = registry.registerOperations("control-fixture", definitions);
  server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const request = (url: string, method = "GET", body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(base + url, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers: response.headers as Record<string, string> })));
    }); outgoing.on("error", reject); outgoing.setTimeout(10000, () => outgoing.destroy(new Error("Owned control fixture timeout."))); outgoing.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const holdSync = () => { let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; }); waitForSync = async () => { entered(); await gate; }; return { started, release: () => release!() }; };
  return { root, globalConfig, definitions, registry, registration, request, holdSync, authority, credential, context, routeHash };
}

test("all 16 control operations use one executable catalog and an enrolled empty node reads native identity/configuration", async t => {
  const f = await fixture(t);
  assert.equal(f.definitions.length, 16);
  assert.ok(f.definitions.every(value => value.contract.exposure === "public"));
  assert.equal(f.registry.catalogSnapshot().operations.length, 16);
  const response = await f.request("/api/rabi/identity?ignored=yes"); assert.equal(response.status, 200);
  assert.equal((await response.json()).data.guid, f.globalConfig.read().rabiGuid);
  const configuration = await f.request("/manager-config"); assert.equal(configuration.status, 200); assert.equal((await configuration.json()).routeDir, "routes");
});

test("one native owner observes Manager port allocation and host changes after operation registration", async t => {
  const f = await fixture(t);
  let managerPort = 0, managerHost = "initial-bind";
  const owner = createRabiApiOwner({ ...f.context, get managerPort() { return managerPort; }, get managerHost() { return managerHost; } });
  const request = { headers: {} } as http.IncomingMessage;
  assert.equal((owner.identity(request).body as any).data.port, 0);
  managerPort = 54321; managerHost = "allocated-bind";
  const current = (owner.identity(request).body as any).data;
  assert.equal(current.port, 54321); assert.equal(new URL(current.baseUrl).port, "54321"); assert.equal(current.managerHost, "allocated-bind");
});

test("an enrolled node patches native global identity, preserves the original store and never receives its Relay token", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/rabi/identity", "PATCH", { rabiName: "Updated fixture", rabiLinkRelay: { token: "owned-fixture-secret" }, unknown: true });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.data.rabiName, "Updated fixture"); assert.equal(body.data.rabiLinkRelay.tokenConfigured, true); assert.ok(!JSON.stringify(body).includes("owned-fixture-secret"));
  assert.equal(new RabiGlobalConfigStore(f.root).read().rabiName, "Updated fixture");
  const invalid = await f.request("/api/rabi/identity", "PATCH", { agentUploads: { maxFileMiB: 0 } }); assert.equal(invalid.status, 400);
  assert.equal(f.globalConfig.read().rabiName, "Updated fixture");
});

test("native Manager path configuration writes and reads the same owner after awaited directory preparation", async t => {
  const f = await fixture(t), patch = { routeDir: "routes-next", rolesDir: "roles-next" };
  const response = await f.request("/manager-config", "POST", patch); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { code: 0, ...patch });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "manager.json"), "utf8")), patch);
  assert.deepEqual(await (await f.request("/manager-config")).json(), { code: 0, ...patch });
  assert.ok(fs.statSync(path.join(f.root, "routes-next")).isDirectory());
});

test("generation and Route mutation fences reject before consuming malformed JSON, including remote targets", async t => {
  const f = await fixture(t), endpoint = "/api/rabi/instances/remote-guid/routes/route-a/agent-binding";
  let response = await f.request(endpoint, "PATCH", "not-json", { "x-rabiroute-expected-application-generation-id": "old" }); assert.equal(response.status, 400); assert.match((await response.json()).message, /both generation/);
  response = await f.request(endpoint, "PATCH", "not-json", { "x-rabiroute-expected-application-generation-id": "old", "x-rabiroute-expected-manager-instance-id": "old" }); assert.equal(response.status, 409);
  response = await f.request(endpoint, "PATCH", "not-json", { "idempotency-key": "original-operation", "if-match": 'W/"' + f.routeHash + '"' }); assert.equal(response.status, 428); assert.equal((await response.json()).errorCode, "route_catalog_precondition_required");
  response = await f.request(endpoint, "POST", "not-json"); assert.equal(response.status, 400); assert.equal((await response.json()).errorCode, "idempotency_key_required");
});

test("self Route reads, missing-object states and worker limit coercion retain the native owner behavior", async t => {
  const f = await fixture(t), base = "/api/rabi/instances/" + f.globalConfig.read().rabiGuid + "/routes";
  assert.equal((await f.request(base + "?presentation=mobile&includeProfiles=true")).status, 200);
  assert.equal((await f.request(base + "/route-a/agent-options")).status, 200);
  assert.equal((await f.request(base + "/missing/agent-options")).status, 404);
  const missingReplies = await f.request(base + "/missing/rabilink-replies"); assert.equal(missingReplies.status, 200); assert.equal((await missingReplies.json()).code, -1);
  const changed = await f.request(base + "/route-a/message-processing", "PATCH", { maxAgents: "200", adapter: "codex" }, { "idempotency-key": "limit-operation", "if-match": f.routeHash });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).data.route.messageProcessingAgents.codex.maxAgents, 32);
  assert.equal((await (await f.request(base + "/route-a/message-processing")).json()).data.route.messageProcessingAgents.codex.maxAgents, 32);
});

test("native cleanup keeps explicit sessions and unrelated workers, and independently reads both persisted owner files", async t => {
  const f = await fixture(t), directory = path.join(f.root, "workers", "message-groups");
  fs.mkdirSync(directory, { recursive: true });
  const workers = [
    { threadId: "delete-native", agentAdapter: "codex", threadName: "协助处理消息 fixture" },
    { threadId: "keep-native", agentAdapter: "codex", threadName: "协助处理消息 fixture" },
    { threadId: "unrelated", agentAdapter: "codex", threadName: "Independent task" }
  ];
  for (const name of ["agents.json", "routing-affinity.json"]) fs.writeFileSync(path.join(directory, name), JSON.stringify({ schemaVersion: 2, workers }));
  const endpoint = "/api/rabi/instances/" + f.globalConfig.read().rabiGuid + "/routes/route-a/message-processing-cleanup";
  const response = await f.request(endpoint, "POST", { adapter: "codex", keepSessionIds: ["keep-native"] });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data.deleted, ["delete-native"]);
  for (const name of ["agents.json", "routing-affinity.json"]) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")).workers.map((worker: any) => worker.threadId), ["keep-native", "unrelated"]);
});

test("node revocation suppresses an accepted identity write response while joining the original native synchronization", async t => {
  const f = await fixture(t), hold = f.holdSync();
  const pending = f.request("/api/rabi/identity", "PATCH", { rabiName: "Committed before revocation" }); await hold.started;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false);
  hold.release(); const response = await pending; assert.equal(response.status, 403); const result = await response.json(); assert.equal(result.uncertain, true); assert.equal(result.data, undefined);
  assert.equal(f.globalConfig.read().rabiName, "Committed before revocation");
});

test("plugin retirement after HTTP disconnect waits for the accepted native synchronization and removes all 14 routes", async t => {
  const f = await fixture(t), hold = f.holdSync(), controller = new AbortController();
  const pending = f.request("/api/rabi/identity", "PATCH", { rabiName: "Accepted operation" }, undefined, controller.signal).catch(() => undefined); await hold.started;
  controller.abort(); await pending;
  let finished = false; const retired = f.registration.dispose().then(() => { finished = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(finished, false);
  hold.release(); await retired; assert.equal(f.registry.catalogSnapshot().operations.length, 0); assert.equal((await f.request("/manager-config")).status, 404);
});

test("timeout settings HTTP CAS, readback and reset use the persisted owner", async t => {
  const f = await fixture(t);
  const initial = await f.request("/api/rabi/timeouts");
  assert.equal(initial.status, 200);
  const etag = initial.headers.get("etag")!;
  assert.ok(etag);
  const changed = await f.request("/api/rabi/timeouts", "PATCH", { overrides: { "agent.catalog": 62000 } }, { "content-type": "application/json", "if-match": etag });
  assert.equal(changed.status, 200);
  const saved = await (await f.request("/api/rabi/timeouts")).json();
  assert.deepEqual(saved.data.overrides, { "agent.catalog": 62000 });
  assert.equal(new RabiGlobalConfigStore(f.root).read().timeoutOverrides["agent.catalog"], 62000);
  const stale = await f.request("/api/rabi/timeouts", "PATCH", { overrides: {} }, { "content-type": "application/json", "if-match": etag });
  assert.equal(stale.status, 412);
  const missing = await f.request("/api/rabi/timeouts", "PATCH", { overrides: {} }, { "content-type": "application/json" });
  assert.equal(missing.status, 428);
  const invalid = await f.request("/api/rabi/timeouts", "PATCH", { overrides: { "agent.catalog": 0 } }, { "content-type": "application/json", "if-match": changed.headers.get("etag")! });
  assert.equal(invalid.status, 400);
  const reset = await f.request("/api/rabi/timeouts", "PATCH", { overrides: {} }, { "content-type": "application/json", "if-match": changed.headers.get("etag")! });
  assert.equal(reset.status, 200);
  assert.deepEqual(f.globalConfig.read().timeoutOverrides, {});
});

test("timeout ETags reject a different Manager identity even with identical saved values", async t => {
  const f = await fixture(t);
  const first = createRabiApiOwner(f.context);
  const replacement = createRabiApiOwner({ ...f.context, managerInstanceId: "replacement-manager" });
  const read = first.timeouts();
  const tag = String(read.headers!.etag);
  const result = replacement.updateTimeouts({ overrides: { "agent.catalog": 4567 } }, () => {}, tag);
  assert.equal(result.status, 412);
  assert.deepEqual(f.globalConfig.read().timeoutOverrides, {});
});
