import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { AgentCallHistory, type CallObservation } from "./agentCallHistory.js";
import { ManagerPluginRouteRegistry, operationForObservedRequest } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createDiagnosticsRoutes } from "../plugins/io.rabiroute.manager.diagnostics/operations.mjs";
import { createApiDiscoveryOperations } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js";
import { createManagerMetadataOperation } from "./corePublicOperations.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
// @ts-expect-error The CLI executable exposes its runtime integration entry without TypeScript declarations.
import { runManagerCommand } from "../../apps/rabi-agent/lib/manager-cli.mjs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// @ts-expect-error The MCP executable exposes its runtime integration entry without TypeScript declarations.
import { createKnowledgeMcpServer } from "../../apps/rabi-mcp/lib/knowledge-mcp-server.mjs";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-call-history-"));
  const history = new AgentCallHistory(root);
  t.after(async () => { await history.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, history };
}
const observation = (id: string, extra: Partial<CallObservation> = {}): CallObservation => ({
  callId: id, spanId: id, boundary: "server", source: "http", startedAt: "2026-11-16T00:00:00.000Z",
  status: "succeeded", method: "GET", pathname: "/api/search", ...extra
});

test("durable call details preserve returned values and isolate credential fields before storage", async t => {
  const { history } = await fixture(t);
  history.record(observation("one", { request: { query: { q: "邮件 JSON 规范", token: "private-query" } },
    response: { body: { code: 0, data: { items: [{ label: "邮件格式", excerpt: "原始内容", adminToken: "private-response" }], coverage: { state: "partial" } } } } }));
  const page = await history.list();
  assert.equal(page.items.length, 1);
  assert.match(page.items[0].summary, /邮件 JSON 规范.*1 items.*partial/);
  const detail = await history.detail("one");
  assert.equal(detail?.stages[0].response.body.data.items[0].excerpt, "原始内容");
  assert.ok(!JSON.stringify(detail).includes("private-"));
});

test("client receipt ingestion is durable, idempotent and correlated with server spans", async t => {
  const { history, root } = await fixture(t);
  history.record(observation("same", { requestId: "server-request", spanId: "server" }));
  const client = observation("same", { boundary: "tool", source: "mcp", spanId: "client", toolName: "rabi_call", status: "uncertain", response: { isError: true, content: [{ text: '{"adminToken":"secret-a","token":"secret-b","ok":false}' }] } });
  await history.ingest(client); await history.ingest(client);
  const page = await history.list();
  assert.equal(page.items.length, 1); assert.equal(page.items[0].source, "mcp"); assert.equal(page.items[0].status, "uncertain");
  const detail = await history.detail("same"); assert.equal(detail?.stages.length, 2);
  assert.ok(!JSON.stringify(detail).includes("secret-"));
  const reopened = new AgentCallHistory(root);
  try { assert.equal((await reopened.list()).items[0].callId, "same"); }
  finally { await reopened.close(); }
});

test("capture gaps and conflicting client spans remain visible without replacing server evidence", async t => {
  const { history, root } = await fixture(t);
  history.record(observation("collision", { response: { body: { code: 1, value: "original" } } }));
  assert.equal((await history.list()).items[0].businessCode, "1");
  const client = observation("collision", { boundary: "client", response: { body: { value: "client" } } });
  await history.ingest(client);
  const duplicate = await history.ingest({ ...client, response: { body: { value: "changed" } } });
  assert.equal("conflict" in duplicate && duplicate.conflict, true);
  const detail = await history.detail("collision");
  assert.equal(detail?.stages.length, 2);
  assert.equal(detail?.stages.find(stage => stage.boundary === "server")?.response.body.value, "original");
  assert.equal(detail?.stages.find(stage => stage.boundary === "client")?.response.body.value, "client");
  history.record(observation("malformed", { response: { body: '{"password":"unfinished' } }));
  const page = await history.list();
  assert.equal(page.items.find(item => item.callId === "malformed")?.captureState, "partial");
  const reopened = new AgentCallHistory(root);
  try { assert.equal((await reopened.list()).recording.conflicts, 1); }
  finally { await reopened.close(); }
});

test("keyset paging freezes new-call membership and rejects changed filters", async t => {
  const { history } = await fixture(t);
  for (const id of ["a", "b", "c"]) history.record(observation(id));
  const first = await history.list({ limit: 1 }); assert.equal(first.items[0].callId, "c");
  history.record(observation("new"));
  const second = await history.list({ limit: 1, cursor: first.nextCursor! }); assert.equal(second.items[0].callId, "b");
  const third = await history.list({ limit: 1, cursor: second.nextCursor! }); assert.equal(third.items[0].callId, "a"); assert.equal(third.nextCursor, null);
  await assert.rejects(history.list({ cursor: first.nextCursor!, source: "mcp" }), /cursor/);
});

test("HTTP capture preserves delayed body readers, successful searches and exact response bytes", async t => {
  const { history } = await fixture(t);
  const server = http.createServer((request, response) => {
    history.observeHttp(request, response, "request-http", () => "fixture.search");
    setImmediate(() => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 0, data: { echo: body, items: [{ excerpt: "找到原文" }] } }));
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/search?q=邮件&tag=a&tag=b`, { method: "POST", headers: { "content-type": "application/json", "x-rabiroute-call-id": "outer-call", "x-rabiroute-call-source": "cli" }, body: JSON.stringify({ value: "原始请求", password: "private" }) });
  const returned = await response.text(); assert.equal(JSON.parse(returned).data.echo.password, "private");
  const page = await history.list(); assert.equal(page.items[0].source, "cli"); assert.equal(page.items[0].responseBytes, Buffer.byteLength(returned));
  const detail = await history.detail("outer-call");
  assert.equal(detail?.stages[0].request.body.value, "原始请求");
  assert.deepEqual(detail?.stages[0].request.queryValues.tag, ["a", "b"]);
  assert.equal(detail?.stages[0].response.body.data.items[0].excerpt, "找到原文");
  assert.ok(!JSON.stringify(detail).includes('"private"'));
});

test("missing one stored payload preserves other correlated stages", async t => {
  const { history } = await fixture(t);
  await history.ingest(observation("partial", { boundary: "client", source: "cli", spanId: "first" }));
  await history.ingest(observation("partial", { boundary: "tool", source: "cli", spanId: "second" }));
  const directory = path.join(history.directory, "payloads", "2026-11-16");
  const files = await fs.readdir(directory); await fs.unlink(path.join(directory, files[0]));
  const detail = await history.detail("partial");
  assert.equal(detail?.stages.length, 2); assert.equal(detail?.stages.filter(stage => stage.status === "unavailable").length, 1);
});

test("real HTTP streams, binary, business codes, oversized bodies and cancellation report capture coverage", async t => {
  const { history } = await fixture(t);
  await history.configure({ enabled: true, captureBodies: true, maxBodyBytes: 1024 });
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const server = http.createServer((request, response) => {
    history.observeHttp(request, response, randomUUID(), () => "fixture.responses");
    if (request.url === "/api/cancel") {
      response.setHeader("content-type", "text/plain");
      response.write("partial"); response.once("close", cancelled); return;
    }
    if (request.url === "/api/binary") {
      response.setHeader("content-type", "application/octet-stream"); response.end(Buffer.from([0, 1, 2])); return;
    }
    if (request.url === "/api/stream") {
      response.setHeader("content-type", "text/event-stream"); response.write('data: {"value":1}\n\n');
      setImmediate(() => response.end('data: {"value":2}\n\n')); return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 1, value: request.url === "/api/large" ? "x".repeat(2000) : "ok" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const name of ["stream", "binary", "business", "large"]) {
    const response = await fetch(base + "/api/" + name, { headers: { "x-rabiroute-call-id": name } });
    await response.arrayBuffer();
  }
  const interrupted = await fetch(base + "/api/cancel", { headers: { "x-rabiroute-call-id": "cancel" } });
  await interrupted.body?.cancel(); await cancellation;
  const calls = (await history.list()).items;
  assert.equal(calls.find(call => call.callId === "cancel")?.status, "cancelled");
  assert.equal(calls.find(call => call.callId === "binary")?.captureState, "metadata");
  assert.equal(calls.find(call => call.callId === "large")?.captureState, "partial");
  assert.equal(calls.find(call => call.callId === "business")?.status, "succeeded");
  assert.equal(calls.find(call => call.callId === "business")?.businessCode, "1");
  assert.match((await history.detail("stream"))?.stages[0].response.body, /value.*1[\s\S]*value.*2/);
  await history.configure({ enabled: true, captureBodies: false, maxBodyBytes: 1024 });
  await (await fetch(base + "/api/business", { headers: { "x-rabiroute-call-id": "disabled-body" } })).text();
  assert.equal((await history.list()).items.find(call => call.callId === "disabled-body")?.captureState, "disabled");
});

test("owner disposal and explicit cancellation release event subscriptions", async t => {
  const { history } = await fixture(t);
  const stream = history.events(); const iterator = stream.frames[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  const waiting = iterator.next(); stream.cancel(); assert.equal((await waiting).done, true);
  const another = history.events(); const reader = another.frames[Symbol.asyncIterator](); await reader.next();
  const pending = reader.next(); await history.close(); assert.equal((await pending).done, true);
});

test("capture configuration is durable and disabled ingestion acknowledges without saving", async t => {
  const { history } = await fixture(t);
  await history.configure({ enabled: false, captureBodies: false, maxBodyBytes: 1024 });
  assert.deepEqual(await history.ingest(observation("disabled", { boundary: "client" })), { stored: true, captured: false, reason: "disabled" });
  assert.equal((await history.list()).items.length, 0);
  await assert.rejects(history.configure({ enabled: true, captureBodies: true, maxBodyBytes: 0 }), /configuration/);
});

test("client observations obey the configured per-side capture budget", async t => {
  const { history } = await fixture(t);
  await history.configure({ enabled: true, captureBodies: true, maxBodyBytes: 1024 });
  await history.ingest(observation("oversized", { boundary: "tool", response: { body: "x".repeat(1800) } }));
  const saved = await history.detail("oversized");
  assert.equal(saved?.stages[0].response.reason, "size-limit");
  assert.equal((await history.list()).items[0].captureState, "partial");
});

test("native diagnostic contracts expose real CLI requests, responses, details and stable ingestion", async t => {
  const { root, history } = await fixture(t);
  const identity = { applicationGenerationId: "calls-fixture", managerInstanceId: "calls-manager", pluginGenerationId: "calls-plugins" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  let base = "";
  const registrations = [registry.registerOperations("discovery", createApiDiscoveryOperations(registry)),
    registry.registerOperations("metadata", [createManagerMetadataOperation(() => ({ ...identity, managerBaseUrl: base, health: { live: true, requiredReady: true, state: "healthy" } }))]),
    registry.registerOperations("diagnostics", createDiagnosticsRoutes({ gatewayDiagnosticsPayload: () => [], callHistory: history }).operations),
    registry.registerOperations("search", [{ contract: fixtureApiContract({ operationId: "fixture.search", method: "GET", pathTemplate: "/api/search",
      request: { path: { type: "object" }, query: { type: "object", properties: { q: { type: "string" } } }, headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema: { type: "object" } } }, effects: { mode: "read", description: "Read fixture data." } }),
      handler: () => ({ status: 200, body: { code: 0, data: { items: [{ label: "搜索结果", excerpt: "真实返回正文", handle: { detailUrl: "/fixture" } }] } } }) }])];
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    const requestId = randomUUID(); response.setHeader("x-rabiroute-request-id", requestId);
    history.observeHttp(request, response, requestId, () => operationForObservedRequest(request));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const value of registrations) await value.dispose(); });
  const configPath = path.join(root, "client.json");
  await fs.writeFile(configPath, JSON.stringify({ managerUrl: base, nodeCredential: "fixture-private-credential" }));
  const receipt = await runManagerCommand(["--api", "GET", "/api/search?q=fixture", "--agent-type", "codex", "--id", "fixture-task"], configPath);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const response = await fetch(base + "/api/diagnostics/calls?source=cli&limit=50"); assert.equal(response.status, 200);
  const page = await response.json(); assert.equal(page.data.items.length, 1);
  const call = page.data.items[0]; assert.equal(call.sessionId, "fixture-task"); assert.equal(call.operationId, "fixture.search");
  const directory = await (await fetch(base + "/api/diagnostics/calls/" + call.callId)).json();
  assert.ok(directory.data.stages.every((stage: any) => stage.response === undefined));
  const serverStage = directory.data.stages.find((stage: any) => stage.boundary === "server");
  const detail = await (await fetch(base + "/api/diagnostics/calls/" + call.callId + "?" + new URLSearchParams({ spanId: serverStage.spanId, boundary: serverStage.boundary }))).json();
  assert.equal(detail.data.stages[0].response.body.data.items[0].excerpt, "真实返回正文");
  assert.ok(directory.data.stages.some((stage: any) => stage.boundary === "tool"));
  assert.ok(!JSON.stringify(detail).includes("fixture-private-credential"));
  const manager = createManagerClient({ managerUrl: base, configPath, agentType: "codex", sessionId: "mcp-session",
    callHistory: { source: "mcp", directory: path.join(root, "mcp-outbox") } });
  const mcp = createKnowledgeMcpServer({ tools: {
    list: () => [{ name: "rabi_call", inputSchema: { type: "object" }, readOnly: true }],
    call: () => manager.request("GET", "/api/search?q=mcp"),
    observeCall: (name: string, args: unknown, action: () => Promise<unknown>) => manager.observeCall(name, args, action)
  } });
  const agent = new Client({ name: "call-history-fixture", version: "1.0.0" });
  const [agentTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await agent.close(); await mcp.close(); await manager.close(); });
  await mcp.connect(serverTransport); await agent.connect(agentTransport);
  const returned = await agent.callTool({ name: "rabi_call", arguments: {} });
  await manager.close();
  const recordedMcp = (await history.list({ source: "mcp" })).items[0];
  assert.equal(recordedMcp.sessionId, "mcp-session");
  const mcpDetail = await history.detail(recordedMcp.callId);
  const toolResult = mcpDetail?.stages.find(stage => stage.boundary === "tool")?.response;
  assert.deepEqual(toolResult, JSON.parse(JSON.stringify(returned)));
  assert.deepEqual(mcpDetail?.stages.map(stage => stage.boundary).sort(), ["client", "server", "tool"]);
});
