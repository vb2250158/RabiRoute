import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { prepareApiJsonBody, preparedApiJson } from "./apiPreparedJson.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";

test("prepared JSON matches native bytes and never freezes or trusts mutable owner input", async () => {
  const operations = [{ text: 'quote" / newline\n 中文', optional: undefined, nested: [true, null, undefined] }];
  const body = { code: 0, data: { operations, count: 1 } };
  const expected = JSON.stringify(body);
  const snapshot = await prepareApiJsonBody(body, operations);
  assert.notEqual(snapshot, body);
  assert.equal(preparedApiJson(snapshot), expected);
  assert.equal(JSON.stringify(snapshot), expected);
  assert.equal(preparedApiJson(body), undefined);
  assert.equal(Object.isFrozen(body), false);
  assert.equal(Object.isFrozen(operations[0]!.nested), false);
  assert.equal(Object.isFrozen(snapshot.data.operations[0]!.nested), true);
  operations[0]!.text = "changed owner state";
  assert.equal(preparedApiJson(snapshot), expected);
  assert.throws(() => { snapshot.data.operations[0]!.text = "changed prepared data"; }, TypeError);
});

test("prepared object containers retain property order, escapes and undefined omission", async () => {
  const paths = Object.assign(Object.create(null), { "/api/中文": { get: { description: "escaped \\ value" } }, skipped: undefined });
  const body = { paths, samePaths: paths };
  const result = await prepareApiJsonBody(body, paths);
  assert.equal(preparedApiJson(result), JSON.stringify(body));
});

test("independent native path containers preserve the same complete JSON document", async () => {
  const paths = { "/local": { get: { id: "local" } } };
  const listeners = [{ paths: { "/same": { get: { id: "first" } } } }, { paths: { "/same": { get: { id: "second" } } } }];
  const body = { paths, listeners };
  const result = await prepareApiJsonBody(body, paths, undefined, listeners.map(listener => listener.paths));
  assert.equal(preparedApiJson(result), JSON.stringify(body));
});

test("a frozen parent with mutable descendants cannot make prepared JSON mutable", async () => {
  const child = { value: 1 }, operations = Object.freeze([child]), body = Object.freeze({ operations });
  const result = await prepareApiJsonBody(body, operations);
  child.value = 2;
  assert.equal(preparedApiJson(result), '{"operations":[{"value":1}]}');
  assert.equal(Object.isFrozen(child), false);
  const refreshed = await prepareApiJsonBody(body, operations);
  assert.equal(preparedApiJson(refreshed), '{"operations":[{"value":2}]}');
});

test("cancelled or invalid preparation publishes no encoding and does not execute getters", async () => {
  const operations = Array.from({ length: 400 }, (_, index) => ({ index })), body = { operations };
  const controller = new AbortController(), cause = new Error("cancel prepared discovery");
  const preparation = prepareApiJsonBody(body, operations, controller.signal);
  controller.abort(cause);
  await assert.rejects(preparation, error => error === cause || error instanceof Error && error.cause === cause);
  assert.equal(preparedApiJson(body), undefined);
  let getterCalls = 0;
  const unsafe = { operations, get dangerous() { getterCalls++; return "owner getter"; } };
  await assert.rejects(prepareApiJsonBody(unsafe, operations), /accessors/);
  assert.equal(getterCalls, 0);
  assert.equal(preparedApiJson(unsafe), undefined);
  await assert.rejects(prepareApiJsonBody({ operations }, []), /must belong/);
});

test("cancellation after JSON capture has started cannot publish a prepared encoding", async t => {
  const operations = Array.from({ length: 100 }, (_, index) => ({ index })), body = { operations };
  const controller = new AbortController(), cause = new Error("cancel active JSON capture");
  const original = Object.getOwnPropertyDescriptors;
  let entered = false;
  t.mock.method(Object, "getOwnPropertyDescriptors", (value: object) => {
    const descriptors = original(value);
    if (value === body) { entered = true; controller.abort(cause); }
    return descriptors;
  });
  await assert.rejects(prepareApiJsonBody(body, operations, controller.signal), error => error === cause || error instanceof Error && error.cause === cause);
  assert.equal(entered, true);
  assert.equal(preparedApiJson(body), undefined);
  assert.equal(Object.isFrozen(body), false);
  assert.equal(Object.isFrozen(operations), false);
});

test("large snapshot capture, freeze and immutable bookkeeping yield in bounded node batches", { timeout: 10_000 }, async t => {
  const operations = Array.from({ length: 4096 }, (_, sliceFixture) => ({ sliceFixture, value: "complete fixture payload" }));
  const sourceRows = new Set<object>(operations), body = { operations };
  const captures = new Map<number, number>(), freezes = new Map<number, number>(), remembered = new Map<number, number>();
  const serializations = new Map<number, number>();
  let turn = 0, observing = true;
  const tick = () => { turn++; if (observing) timer = setImmediate(tick); };
  let timer = setImmediate(tick);
  const note = (counts: Map<number, number>) => counts.set(turn, (counts.get(turn) ?? 0) + 1);
  const ownedRow = (value: unknown) => value !== null && typeof value === "object" && !sourceRows.has(value)
    && typeof Object.getOwnPropertyDescriptor(value, "sliceFixture")?.value === "number";
  const descriptors = Object.getOwnPropertyDescriptors, freeze = Object.freeze, add = WeakSet.prototype.add, stringify = JSON.stringify;
  t.mock.method(Object, "getOwnPropertyDescriptors", (value: object) => {
    if (sourceRows.has(value)) note(captures);
    return descriptors(value);
  });
  t.mock.method(Object, "freeze", (value: unknown) => { if (ownedRow(value)) note(freezes); return Reflect.apply(freeze, Object, [value]); });
  t.mock.method(WeakSet.prototype, "add", function (this: WeakSet<object>, value: object) {
    if (ownedRow(value)) note(remembered);
    return add.call(this, value);
  });
  t.mock.method(JSON, "stringify", (value: unknown, ...options: unknown[]) => {
    if (ownedRow(value)) note(serializations);
    return Reflect.apply(stringify, JSON, [value, ...options]);
  });
  let snapshot: typeof body;
  try { snapshot = await prepareApiJsonBody(body, operations); }
  finally { observing = false; clearImmediate(timer); }
  for (const counts of [captures, freezes, remembered]) {
    assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), operations.length);
    assert.ok(counts.size >= 4, "Each large snapshot phase must yield before consuming the entire input.");
    assert.ok(Math.max(...counts.values()) <= 1024, "A snapshot phase exceeded its per-turn node ceiling.");
  }
  assert.equal([...serializations.values()].reduce((sum, count) => sum + count, 0), operations.length);
  assert.ok(serializations.size >= 16, "Large item serialization must yield between bounded batches.");
  assert.ok(Math.max(...serializations.values()) <= 256, "Item serialization exceeded its per-turn ceiling.");
  assert.equal(preparedApiJson(snapshot), JSON.stringify(body));
  assert.ok(snapshot.operations.every(Object.isFrozen));
  assert.ok(operations.every(value => !Object.isFrozen(value)));
});

for (const phase of ["freeze", "remember"] as const) test(`cancellation during snapshot ${phase} publishes no bytes and leaves owner data mutable`, async t => {
  const row = { sliceFixture: 0 }, operations = [row], body = { operations };
  const controller = new AbortController(), cause = new Error(`cancel snapshot ${phase}`);
  let entered = false;
  const cancelOwnedRow = (value: unknown) => {
    if (!entered && value !== row && value !== null && typeof value === "object"
      && Object.getOwnPropertyDescriptor(value, "sliceFixture")?.value === 0) {
      entered = true; controller.abort(cause);
    }
  };
  if (phase === "freeze") {
    const freeze = Object.freeze;
    t.mock.method(Object, "freeze", (value: unknown) => { cancelOwnedRow(value); return Reflect.apply(freeze, Object, [value]); });
  } else {
    const add = WeakSet.prototype.add;
    t.mock.method(WeakSet.prototype, "add", function (this: WeakSet<object>, value: object) {
      cancelOwnedRow(value); return add.call(this, value);
    });
  }
  await assert.rejects(prepareApiJsonBody(body, operations, controller.signal), error => error === cause || error instanceof Error && error.cause === cause);
  assert.equal(entered, true);
  assert.equal(preparedApiJson(body), undefined);
  assert.equal(Object.isFrozen(body), false); assert.equal(Object.isFrozen(operations), false); assert.equal(Object.isFrozen(row), false);
  row.sliceFixture = 1;
});

test("prepared encodings still pass the original response validator before disclosure", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("prepared-validation", [{ contract: fixtureApiContract({ method: "GET", pathTemplate: "/api/prepared",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } } }),
    async handler() { const body = { ok: true, value: "invalid integer" }; return { status: 200, body: await prepareApiJsonBody(body, body) }; } }]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/prepared`);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).errorCode, "API_RESPONSE_SCHEMA_INVALID");
});

test("ordinary owner output keeps its original JSON behavior and dangerous getter budget", { timeout: 5000 }, async t => {
  const registry = new ManagerPluginRouteRegistry();
  const definition = (unsafe: boolean) => ({ contract: fixtureApiContract({ operationId: unsafe ? "fixture.unsafe" : "fixture.ordinary", method: "GET", pathTemplate: unsafe ? "/api/unsafe" : "/api/ordinary",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } } }),
    handler() { return { status: 200, body: unsafe ? { ok: true, get value(): number { for (;;) { /* deliberate owner fault */ } } } : { ok: true, value: 42 } }; } });
  const registration = registry.registerOperations("ordinary-owner", [definition(false), definition(true)]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const ordinary = await fetch(base + "/api/ordinary");
  assert.equal(ordinary.status, 200); assert.equal(await ordinary.text(), '{"ok":true,"value":42}');
  const unsafe = await fetch(base + "/api/unsafe");
  assert.equal(unsafe.status, 500); assert.equal((await unsafe.json()).errorCode, "API_OPERATION_FAILED");
  assert.equal((await fetch(base + "/api/ordinary")).status, 200);
});
