import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { compileApiOperation, type ApiOperationDefinition } from "./apiOperationContract.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerEventHub, createManagerEventsOperation } from "./managerEvents.js";

function definition(handler: ApiOperationDefinition["handler"]): ApiOperationDefinition {
  const contract = fixtureApiContract();
  return { contract: { ...contract, request: { ...contract.request, deadlineMs: 40 } }, handler };
}
test("a contract deadline bounds a partial request body before entering the owner", { timeout: 5000 }, async t => {
  let called = false;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("deadline", [definition(() => { called = true; return { status: 200, body: { ok: true, value: 1 } }; })]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const closed = new Promise<void>((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${address.port}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" } });
    request.once("error", () => resolve());
    request.once("response", response => { response.resume(); if (response.statusCode === 200) reject(new Error("Partial body reached owner")); else resolve(); });
    request.write('{"value":');
  });
  await closed; await registration.dispose(); assert.equal(called, false); assert.equal(registration.activeOperationCount(), 0);
});

test("a declared SSE deadline closes the subscription and drains its operation lease", { timeout: 5000 }, async t => {
  const hub = new ManagerEventHub();
  const base = createManagerEventsOperation(hub);
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("deadline-stream", [{ ...base, contract: { ...base.contract,
    request: { ...base.contract.request, deadlineMs: 100 } } }]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { hub.closeAll(); server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`); assert.equal(response.status, 200);
  const reader = response.body!.getReader(); assert.equal((await reader.read()).done, false);
  const next = await reader.read().then(value => value.done ? "ended" : "unexpected frame", () => "closed");
  assert.notEqual(next, "unexpected frame");
  await registration.dispose(); assert.equal(hub.activeSubscriberCount(), 0); assert.equal(registration.activeOperationCount(), 0);
});

test("the same deadline reaches the owner, withholds a late response and retains the lease through cleanup", { timeout: 5000 }, async t => {
  let observed!: () => void;
  const aborted = new Promise<void>(resolve => { observed = resolve; });
  let cleanup!: () => void;
  const cleaned = new Promise<void>(resolve => { cleanup = resolve; });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("deadline", [definition(async input => {
    assert.ok(input.signal);
    await new Promise<void>(resolve => {
      const aborted = () => { observed(); resolve(); };
      if (input.signal!.aborted) aborted(); else input.signal!.addEventListener("abort", aborted, { once: true });
    });
    await cleaned;
    return { status: 200, body: { ok: true, value: 1 } };
  })]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { cleanup(); server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = fetch(`http://127.0.0.1:${address.port}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}' });
  await aborted;
  let retired = false; const retirement = registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  cleanup(); const response = await request; assert.equal(response.status, 408);
  const failure = await response.json(); assert.equal(failure.errorCode, "API_REQUEST_DEADLINE_EXCEEDED"); assert.equal(failure.uncertain, true);
  await retirement; assert.equal(retired, true);
  const operation = definition(() => ({ status: 200 }));
  const another = new ManagerPluginRouteRegistry(); const registered = another.registerOperations("deadline", [operation]);
  const spec = (await apiCatalogOpenApi(another.catalogSnapshot())) as { paths: Record<string, { post: Record<string, unknown> }> };
  assert.equal(spec.paths["/api/example/records/{recordId}"]!.post["x-rabiroute-deadline-ms"], 40); await registered.dispose();
  for (const deadlineMs of [0, -1, 2_147_483_648]) assert.throws(() => compileApiOperation({ ...operation, contract: { ...operation.contract,
    request: { ...operation.contract.request, deadlineMs } } }), /deadline/);
});

test("a deadline responds before an uncooperative owner finishes and retains its actual lease", { timeout: 5000 }, async t => {
  let release!: () => void;
  let entered!: () => void;
  const ownerStarted = new Promise<void>(resolve => { entered = resolve; });
  const ownerFinished = new Promise<void>(resolve => { release = resolve; });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("deadline-uncooperative", [definition(async () => {
    entered();
    await ownerFinished;
    return { status: 200, body: { ok: true, value: 1 } };
  })]);
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("live"); return; }
    registry.handle(request, new URL(request.url!, "http://localhost"), response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { release(); server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const request = fetch(`${url}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}', signal: AbortSignal.timeout(2000) });
  await ownerStarted;
  const response = await request;
  assert.equal(response.status, 408);
  const failure = await response.json();
  assert.equal(failure.errorCode, "API_REQUEST_DEADLINE_EXCEEDED");
  assert.equal(failure.uncertain, true);
  assert.equal(registration.activeOperationCount(), 1);
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
  assert.equal(await health.text(), "live");
  let retired = false;
  const retirement = registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(retired, false);
  release(); await retirement;
  assert.equal(registration.activeOperationCount(), 0);
});

test("a trusted slow transaction completes finally and preserves its original receipt", { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-owner-transaction-"));
  const receipt = path.join(root, "receipt.json"), lock = path.join(root, "write.lock");
  let committed = 0, released = 0;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("transaction", [{ contract: fixtureApiContract(), handler() {
    if (fs.existsSync(receipt)) return JSON.parse(fs.readFileSync(receipt, "utf8"));
    const fd = fs.openSync(lock, "wx");
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
      const result = { status: 200, body: { ok: true, value: ++committed } };
      fs.writeFileSync(receipt, JSON.stringify(result));
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); released++; }
  } }]);
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("live"); return; }
    registry.handle(request, new URL(request.url!, "http://localhost"), response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true }); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`${url}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}' });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true, value: 1 });
  }
  assert.equal(committed, 1); assert.equal(released, 1); assert.equal(fs.existsSync(lock), false);
  assert.equal(await (await fetch(`${url}/health`)).text(), "live");
});

test("a trusted synchronous transaction returns a late deadline without pretending the write did not occur", { timeout: 5000 }, async t => {
  let trailingMutation = false;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("declared-deadline", [definition(() => {
    const until = performance.now() + 500;
    while (performance.now() < until) { /* trusted synchronous transaction must return through its own finally */ }
    trailingMutation = true;
    return { status: 200, body: { ok: true, value: 1 } };
  })]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/example/records/one`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}', signal: AbortSignal.timeout(2000)
  });
  assert.equal(response.status, 408);
  const failure = await response.json();
  assert.equal(failure.errorCode, "API_REQUEST_DEADLINE_EXCEEDED");
  assert.equal(failure.uncertain, true);
  assert.equal(trailingMutation, true);
});

test("response validation and serialization share the original deadline without repeating the owner", { timeout: 5000 }, async t => {
  let calls = 0;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("response-deadline", [definition(() => {
    calls++;
    return { status: 200, body: { ok: true, get value() {
      const until = performance.now() + 500;
      while (performance.now() < until) { /* a response getter must not evade its request budget */ }
      return 1;
    } } };
  })]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/example/records/one`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}', signal: AbortSignal.timeout(2000)
  });
  assert.equal(response.status, 408);
  const failure = await response.json();
  assert.equal(failure.errorCode, "API_REQUEST_DEADLINE_EXCEEDED");
  assert.equal(failure.uncertain, true);
  assert.equal(calls, 1);
});
