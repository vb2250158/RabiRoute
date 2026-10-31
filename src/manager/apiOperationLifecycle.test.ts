import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ApiContractError } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";

test("response validation and unknown owner failure retain uncertainty after execution while definite validation remains definite", async t => {
  let mode = "response", effects = 0;
  const registry = new ManagerPluginRouteRegistry();
  const value = fixtureApiContract();
  const registration = registry.registerOperations("example", [{ contract: value, handler: () => {
    if (mode === "validation") throw new ApiContractError(400, "FIXTURE_VALIDATION", "body", value.operationId);
    effects++;
    if (mode === "failure") throw new Error("After an accepted effect");
    return { status: 200, body: { ok: true, value: "wrong response type" } };
  } }]);
  const server = http.createServer((request, response) => { registry.handle(request, new URL(request.url!, "http://fixture"), response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  for (const current of ["response", "failure", "validation"]) {
    mode = current;
    const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/example/records/one`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: 1 }) });
    const result = await response.json(); assert.equal(response.status, current === "validation" ? 400 : 500);
    assert.equal(result.uncertain === true, current !== "validation"); assert.equal(result.retryable, false);
  }
  assert.equal(effects, 2);
});

test("ordinary HTTP owners receive disconnect cancellation and retirement joins their accepted cleanup", { timeout: 10000 }, async t => {
  let entered!: () => void, cancelled!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), aborted = new Promise<void>(resolve => { cancelled = resolve; }), cleanup = new Promise<void>(resolve => { release = resolve; });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("example", [{ contract: fixtureApiContract(), handler: async input => {
    assert.ok(input.signal); input.signal.addEventListener("abort", cancelled, { once: true }); entered();
    await aborted; await cleanup; return { status: 200, body: { ok: true, value: 1 } };
  } }]);
  const server = http.createServer((request, response) => { registry.handle(request, new URL(request.url!, "http://fixture"), response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const outgoing = http.request({ host: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port, path: "/api/example/records/one", method: "POST", headers: { "content-type": "application/json" } });
  outgoing.on("error", () => {}); outgoing.end(JSON.stringify({ value: 1 }));
  t.after(async () => { release(); outgoing.destroy(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await started; outgoing.destroy(); await aborted;
  let disposed = false; const retiring = registration.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  release(); await retiring; assert.equal(disposed, true);
});

test("owner preparation can reject before an unfinished HTTP body is consumed", { timeout: 10000 }, async t => {
  const registry = new ManagerPluginRouteRegistry(); let prepared = 0, executed = 0;
  const base = fixtureApiContract();
  const registration = registry.registerOperations("example", [{ contract: { ...base, responses: { ...base.responses,
    "403": { mediaType: "application/json", schema: { type: "object", required: ["error"], properties: { error: { const: "original-owner-denied" } }, additionalProperties: false } }
  } }, prepare: input => {
    prepared++; assert.equal(input.request.listenerCount("data"), 0);
    return { status: 403, body: { error: "original-owner-denied" } };
  }, handler: () => { executed++; throw new Error("Rejected requests never execute."); } }]);
  const server = http.createServer((request, response) => { registry.handle(request, new URL(request.url!, "http://fixture"), response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let outgoing: http.ClientRequest | undefined;
  t.after(async () => { outgoing?.destroy(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    outgoing = http.request({ hostname: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port,
      path: "/api/example/records/one", method: "POST", headers: { "content-type": "application/json", "content-length": "100" } }, response => {
      let body = ""; response.on("data", data => { body += data; }); response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    outgoing.on("error", reject); outgoing.write("{"); // Intentionally no end(): admission must not await a body.
  });
  assert.equal(result.status, 403); assert.deepEqual(JSON.parse(result.body), { error: "original-owner-denied" });
  assert.equal(prepared, 1); assert.equal(executed, 0);
});

test("real HTTP uses the registered contract, preserves an in-flight write across replacement and publishes only active generations", async t => {
  let published = new Set(["old"]);
  let generation = "generation-old";
  const changes: number[] = [];
  const registry = new ManagerPluginRouteRegistry(() => published, {
    identity: () => ({ applicationGenerationId: "application", managerInstanceId: "manager", pluginGenerationId: generation }),
    changed: snapshot => changes.push(snapshot.catalogRevision)
  });
  const identity: PluginIdentity = { applicationGenerationId: "application", managerInstanceId: "manager", host: "manager",
    pluginId: "example", instanceId: "example", activationId: "old", version: "1.0.0", revision: "old" };
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let release!: () => void;
  const requestSnapshots: unknown[] = [];
  const finish = new Promise<void>(resolve => { release = resolve; });
  const old = runPluginActivation(identity, () => registry.registerOperations("example", [{ contract: fixtureApiContract(), handler: async () => {
    start(); await finish; requestSnapshots.push(registry.catalogSnapshot()); return { status: 200, body: { ok: true, value: 1 } };
  } }]));
  const baseline = registry.catalogSnapshot();
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/example/records/one`;
  t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const send = (value: number) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
  const invalid = await send(-1); assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { errorCode: string }).errorCode, "API_REQUEST_SCHEMA_INVALID");
  const original = send(1); await started;
  const next = runPluginActivation({ ...identity, activationId: "new", revision: "new" }, () => registry.registerOperations("example", [{
    contract: fixtureApiContract({ description: "Updated implementation." }), handler: () => ({ status: 200, body: { ok: true, value: 2 } })
  }]));
  assert.equal(registry.catalogSnapshot(), baseline);
  published = new Set(["new"]); generation = "generation-new";
  const updated = registry.catalogSnapshot();
  assert.ok(updated.catalogRevision > baseline.catalogRevision);
  assert.equal(updated.operations[0]?.owner.revision, "new");
  let drained = false;
  const disposing = old.dispose().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  const fresh = await send(2); assert.deepEqual(await fresh.json(), { ok: true, value: 2 });
  release(); assert.deepEqual(await (await original).json(), { ok: true, value: 1 });
  await disposing;
  assert.equal(requestSnapshots[0], baseline);
  await next.dispose();
  assert.equal((await send(3)).status, 404);
  const unloaded = registry.catalogSnapshot();
  assert.equal(unloaded.operations.length, 0);
  assert.equal(changes.length, 3);
});
