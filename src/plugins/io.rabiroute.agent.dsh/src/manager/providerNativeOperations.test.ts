import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDshNativeOperations } from "./providerNativeOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import { nativeHttpTestFetch as requestHttp } from "../../../../manager/nativeHttpTestClient.js";
import type { ApiOperationDefinition, ApiOperationInput } from "../../../../manager/apiOperationContract.js";

function input(pathname: string, values: Record<string, string> = {}, body?: unknown, signal?: AbortSignal): ApiOperationInput {
  return {
    url: new URL(pathname, "http://fixture"),
    path: values,
    query: {},
    body,
    signal,
    request: { headers: {} },
    response: {}
  } as ApiOperationInput;
}
function operation(operations: ApiOperationDefinition[], suffix: string) { return operations.find(value => value.contract.operationId === "agent.providers.dsh." + suffix)!; }

test("DSH native history keeps original event IDs and exact backwards cursor/address", async () => {
  const calls: unknown[] = [], original = {
    records: [{
      type: "event",
      seq: 54,
      time: 100,
      event: { type: "tool/result", callId: "native-call", id: "native-event" }
    }],
    hasMore: true,
    cursor: 60
  };
  const operations = createDshNativeOperations({ rpc: async (method, args, signal) => { calls.push({ method, args, signal }); return original; } });
  const signal = new AbortController().signal;
  const result = await operation(operations, "sessions.history.read").handler(input("/?beforeSeq=55&throughSeq=60&maxMessages=10", { sessionId: "session-original" }, undefined, signal));
  assert.equal(result.status, 200);
  const data = (result.body as any).data;
  assert.deepEqual(data.records, original.records);
  assert.equal(data.cursor, 60);
  assert.equal(data.hasMore, true);
  assert.deepEqual(calls, [{
    method: "session/events",
    args: {
      request: {
        address: { kind: "session", sessionId: "session-original" },
        beforeSeq: 55,
        throughSeq: 60,
        maxMessages: 10
      }
    },
    signal
  }]);
  await operation(operations, "sessions.history.read").handler(input("/?parentSessionId=parent&mode=continuable", { sessionId: "child" }));
  assert.deepEqual((calls[1] as any).args.request.address, { kind: "subagent", parentSessionId: "parent", childSessionId: "child", mode: "continuable" });
});

test("DSH plugin operations preserve native arguments/results and route every action to its original owner", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const operations = createDshNativeOperations({
    rpc: async (method, args) => { calls.push({ method, args }); return { nativeReceipt: "original-owner", step: "committed" }; }
  });
  const cases = [
    ["plugins.list", {}, undefined, "pluginManager/listPlugins", {}],
    ["bundles.list", {}, undefined, "pluginManager/listBundles", {}],
    ["market.indexes.list", {}, undefined, "pluginMarket/listIndexes", {}],
    ["market.search", {}, { url: "https://market.example/index.json", query: { text: "feature", offset: 20 } }, "pluginMarket/search", { url: "https://market.example/index.json", query: { text: "feature", offset: 20 } }],
    ["plugins.install", {}, { spec: "@example/feature@1.2.3", options: { requestId: "original-native-request", activate: true } }, "pluginManager/installBundle", { spec: "@example/feature@1.2.3", options: { requestId: "original-native-request", activate: true } }],
    ["plugins.update", { name: "@example/feature" }, { version: "1.2.4", options: { requestId: "original-update" } }, "pluginManager/updateBundle", { name: "@example/feature", version: "1.2.4", options: { requestId: "original-update" } }],
    ["plugins.remove", { name: "@example/feature" }, undefined, "pluginManager/removeBundle", { name: "@example/feature" }]
  ] as const;
  for (const [id, params, body, method, args] of cases) {
    const result = await operation(operations, id).handler(input("/", params, body));
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as any).data, { nativeReceipt: "original-owner", step: "committed" });
    assert.deepEqual(calls.at(-1), { method, args });
  }
});

test("DSH actual loopback native RPC retains cookie, rpcId, method, result and cancellation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-native-api-"));
  const previous = process.env.RABI_DSH_AUTH_FILE, previousState = process.env.RABIROUTE_STATE_ROOT;
  process.env.RABIROUTE_STATE_ROOT = root;
  const calls: Array<{ method: string; args: unknown }> = [];
  let rpcMismatch = false, failWrite = false, holdRead = false;
  let began!: () => void, cancelled!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), closed = new Promise<void>(resolve => { cancelled = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(303, { location: "/", "set-cookie": "dsh-auth-fixture=native-cookie; HttpOnly; Path=/" }).end();
      return;
    }
    assert.equal(req.headers.cookie, "dsh-auth-fixture=native-cookie");
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ method: body.method, args: body.payload.args });
    if (failWrite) { res.destroy(); return; }
    if (holdRead) { res.once("close", cancelled); began(); return; }
    const value = body.method === "session/events" ? { records: [{ type: "event", seq: 11, event: { id: "kept-native" } }], hasMore: false, cursor: 11 } : { nativeOperation: body.method, saved: true };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "server-response", rpcId: rpcMismatch ? "wrong-reply" : body.rpcId, result: { ok: true, value } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const log = path.join(root, "launch.log");
  process.env.RABI_DSH_AUTH_FILE = path.join(root, "auth.json");
  await fs.writeFile(log, "dsh web: " + origin + "/?token=fixture-login\n");
  await fs.writeFile(process.env.RABI_DSH_AUTH_FILE, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
  t.after(async () => {
    if (previousState === undefined) delete process.env.RABIROUTE_STATE_ROOT; else process.env.RABIROUTE_STATE_ROOT = previousState;
    if (previous === undefined) delete process.env.RABI_DSH_AUTH_FILE; else process.env.RABI_DSH_AUTH_FILE = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const operations = createDshNativeOperations({ baseUrl: origin });
  const history = await operation(operations, "sessions.history.read").handler(input("/?maxMessages=5", { sessionId: "native-exact" }));
  assert.equal(history.status, 200);
  assert.equal((history.body as any).data.records[0].event.id, "kept-native");
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("fixture.dsh", operations);
  const manager = http.createServer((req, res) => {
    markAuthenticatedConnectionRequest(req);
    if (!registry.handle(req, new URL(req.url!, "http://localhost"), res)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => manager.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    manager.closeAllConnections();
    await registration.dispose();
    await new Promise<void>(resolve => manager.close(() => resolve()));
  });
  const publicRoot = `http://127.0.0.1:${(manager.address() as { port: number }).port}/api/agent/providers/dsh`;
  const install = await requestHttp(publicRoot + "/plugins/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: "@fixture/example", options: { requestId: "one-install" } })
  });
  assert.equal(install.status, 200);
  assert.equal((await install.json()).data.nativeOperation, "pluginManager/installBundle");
  const update = await requestHttp(publicRoot + "/plugins/%40fixture%2Fexample/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.4" })
  });
  assert.equal(update.status, 200);
  assert.deepEqual(calls.at(-1), { method: "pluginManager/updateBundle", args: { name: "@fixture/example", version: "1.2.4" } });
  rpcMismatch = true;
  const mismatch = await operation(operations, "plugins.list").handler(input("/"));
  assert.equal(mismatch.status, 503);
  rpcMismatch = false;
  failWrite = true;
  const failed = await operation(operations, "plugins.install").handler(input("/", {}, { spec: "@fixture/example", options: { requestId: "keep-original" } }));
  assert.equal(failed.status, 503);
  assert.equal((failed.body as any).uncertain, true);
  assert.equal(calls.filter(call => call.method === "pluginManager/installBundle").length, 2);
  await assert.rejects(async () => operation(operations, "plugins.list").handler(input("/", {}, undefined, AbortSignal.abort())), /abort/i);
  failWrite = false;
  holdRead = true;
  const controller = new AbortController();
  const pending = operation(operations, "plugins.list").handler(input("/", {}, undefined, controller.signal));
  await started;
  controller.abort();
  await assert.rejects(async () => pending);
  await closed;
});

test("DSH malformed history pages fail locally without executing plugin mutations", async () => {
  const calls: string[] = [];
  const operations = createDshNativeOperations({ rpc: async method => { calls.push(method); return { records: [], hasMore: true }; } });
  const result = await operation(operations, "sessions.history.read").handler(input("/", { sessionId: "original" }));
  assert.equal(result.status, 503);
  assert.equal((result.body as any).errorCode, "DSH_HISTORY_RESPONSE_INVALID");
  assert.deepEqual(calls, ["session/events"]);
});

test("native DSBot catalog is independently discoverable without primary session fields", async () => {
  const calls: unknown[] = [], catalog = { schemaVersion: 1 as const, botScopeId: "scope", runtimeId: "runtime", bots: [{ botId: "bot", botName: "Bot" }] };
  const operations = createDshNativeOperations({ baseUrl: "http://127.0.0.1:1234", botRequest: async (endpoint, payload, options) => { calls.push({ endpoint, payload, baseUrl: options?.baseUrl }); return catalog; } });
  const selected = operation(operations, "ds-bots.list");
  assert.equal(selected.contract.pathTemplate, "/api/agent/providers/dsh/ds-bots");
  const result = await selected.handler(input("/"));
  assert.equal(result.status, 200); assert.deepEqual((result.body as { data: unknown }).data, catalog);
  assert.deepEqual(calls, [{ endpoint: "rabi-automation-catalog", payload: { schemaVersion: 1 }, baseUrl: "http://127.0.0.1:1234" }]);
});

test("self destination resolves exact local scope, Bot and live runtime without persisting runtime", async () => {
  const catalog = { schemaVersion: 1 as const, botScopeId: "scope", runtimeId: "runtime", bots: [{ botId: "bot", botName: "Bot", roleId: "unrelated-persona" }] };
  const operations = createDshNativeOperations({ baseUrl: "http://127.0.0.1:1234", botRequest: async () => catalog });
  const selected = operation(operations, "ds-bot-destination.read");
  const result = await selected.handler(input("/?botScopeId=scope&botId=bot&runtimeId=runtime"));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { code: 0, data: { target: { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", dshBaseUrl: "http://127.0.0.1:1234", botScopeId: "scope", botId: "bot", botName: "Bot" } } });
  for (const query of ["botScopeId=other&botId=bot&runtimeId=runtime", "botScopeId=scope&botId=bot&runtimeId=copied-runtime", "botScopeId=scope&botId=missing&runtimeId=runtime"]) assert.equal((await selected.handler(input("/?" + query))).status, 404);
});

test("self destination refuses incomplete remote discovery or ambiguous local configuration", async () => {
  let calls = 0;
  const catalog = { schemaVersion: 1 as const, botScopeId: "scope", runtimeId: "runtime", bots: [{ botId: "bot", botName: "Bot" }] };
  const query = "/?botScopeId=scope&botId=bot&runtimeId=runtime";
  const operations = createDshNativeOperations({ configuredTargets: () => ({ localBaseUrls: [], remoteTargetIds: ["remote:configured:dsh"] }), botRequest: async () => { calls++; return catalog; } });
  const selected = operation(operations, "ds-bot-destination.read");
  assert.equal((await selected.handler(input(query))).status, 200); assert.equal(calls, 1);
  assert.equal((await selected.handler(input(query.replace("runtimeId=runtime", "runtimeId=another-runtime")))).status, 503); assert.equal(calls, 2);
  assert.equal((await selected.handler(input(query + "&agentTargetId=remote:unknown:dsh"))).status, 404);
  assert.equal((await selected.handler(input(query + "&agentTargetId=remote:configured:dsh"))).status, 503); assert.equal(calls, 2);
  assert.equal((await selected.handler(input(query + "&agentTargetId=local:dsh"))).status, 200); assert.equal(calls, 3);
  const ambiguous = createDshNativeOperations({ configuredTargets: () => ({ localBaseUrls: ["http://one.invalid", "http://two.invalid"], remoteTargetIds: [] }), botRequest: async () => catalog });
  assert.equal((await operation(ambiguous, "ds-bot-destination.read").handler(input(query))).status, 409);
});

test("self discovery checks formal origins with bounded parallelism and isolates failed profiles", async () => {
  const origins = ["http://127.0.0.1:1234", "http://127.0.0.1:1235", "http://127.0.0.1:1236", "http://127.0.0.1:1237", "http://127.0.0.1:1238"];
  let running = 0, peak = 0;
  const operations = createDshNativeOperations({ baseUrl: origins[0], configuredTargets: () => ({ localBaseUrls: origins, remoteTargetIds: [] }), botRequest: async (_endpoint, _payload, options) => {
    running++; peak = Math.max(peak, running); await Promise.resolve(); running--;
    if (options?.baseUrl !== origins[3]) throw new Error("other profile unavailable");
    return { schemaVersion: 1, botScopeId: "scope", runtimeId: "runtime", bots: [{ botId: "bot", botName: "Bot" }] };
  } });
  const result = await operation(operations, "ds-bot-destination.read").handler(input("/?botScopeId=scope&botId=bot&runtimeId=runtime"));
  assert.equal(result.status, 200); assert.equal((result.body as any).data.target.dshBaseUrl, origins[3]); assert.ok(peak <= 4);
});
