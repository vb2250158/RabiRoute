import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { ManagerEventHub, createManagerEventsOperation } from "./managerEvents.js";
import { compileApiOperation, validateApiOperationResult, type ApiOperationInput } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

async function ready(stream: NonNullable<ReturnType<ManagerEventHub["open"]>>) {
  const iterator = stream.frames[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { retry: 3000 });
  assert.deepEqual((await iterator.next()).value, { event: "ready", data: {} });
  return iterator;
}

test("Manager events share one publication owner, snapshot payloads and release subscriptions after the last consumer", async () => {
  let subscribed = 0; let unsubscribed = 0;
  const limits = { subscribers: 2 };
  const hub = new ManagerEventHub({ limits, subscribe: () => { subscribed++; return () => { unsubscribed++; }; } });
  limits.subscribers = 99; // External configuration mutation cannot change an active owner.
  const first = hub.open()!; const second = hub.open()!;
  assert.equal(hub.open(), undefined); assert.equal(subscribed, 1);
  const one = await ready(first); const two = await ready(second);
  const payload = { revision: 1 }; hub.publish("api.catalog.changed", payload); payload.revision = 2;
  for (const iterator of [one, two]) assert.deepEqual((await iterator.next()).value, { event: "api.catalog.changed", data: { revision: 1 } });
  await first.cancel("closed"); assert.equal((await one.next()).done, true); assert.equal(unsubscribed, 0);
  hub.closeAll(); assert.equal((await two.next()).done, true); assert.equal(unsubscribed, 1); assert.equal(hub.activeSubscriberCount(), 0);
  const reopened = hub.open()!; await ready(reopened); assert.equal(subscribed, 2); await reopened.cancel("done"); assert.equal(unsubscribed, 2);
});

test("a slow subscriber exceeds the bounded queue without failing publication or disturbing a current consumer", async () => {
  let unsubscribed = 0;
  const hub = new ManagerEventHub({ limits: { queuedFrames: 3 }, subscribe: () => () => { unsubscribed++; } });
  const slow = hub.open()!; const active = hub.open()!; const stalled = await ready(slow); const current = await ready(active);
  for (let revision = 1; revision <= 4; revision++) {
    assert.doesNotThrow(() => hub.publish("changed", { revision }));
    assert.deepEqual((await current.next()).value, { event: "changed", data: { revision } });
  }
  assert.equal((await stalled.next()).done, true); assert.equal(hub.activeSubscriberCount(), 1); assert.equal(unsubscribed, 0);
  await active.cancel("done"); assert.equal((await current.next()).done, true); assert.equal(unsubscribed, 1);
});

test("byte overflow and an opening-time event burst clean up listeners, and capacity is a declared resource error", async () => {
  let unsubscribed = 0;
  const burst = new ManagerEventHub({ limits: { queuedFrames: 2 }, subscribe: publish => {
    publish("changed", {}); return () => { unsubscribed++; };
  } });
  assert.equal(burst.open(), undefined);
  assert.equal(unsubscribed, 1); assert.equal(burst.activeSubscriberCount(), 0);
  const hub = new ManagerEventHub({ limits: { subscribers: 1, queuedBytes: 200, frameBytes: 1000 } });
  const definition = createManagerEventsOperation(hub); const operation = compileApiOperation(definition);
  const first = await definition.handler({} as ApiOperationInput); assert.ok(first.stream);
  await ready(first.stream);
  const capacity = await definition.handler({} as ApiOperationInput); assert.equal(capacity.status, 429); validateApiOperationResult(operation, capacity);
  assert.doesNotThrow(() => hub.publish("too-large", { value: "x".repeat(300) }));
  assert.equal(hub.activeSubscriberCount(), 0); assert.equal((await first.stream.frames[Symbol.asyncIterator]().next()).done, true);
  assert.match(definition.contract.validators[0]!.description, /1 subscriptions/);
});

test("protocol heartbeat is released with the subscription and does not query business state", async t => {
  const nativeSet = globalThis.setInterval; const nativeClear = globalThis.clearInterval;
  let heartbeat: (() => void) | undefined; let timer: ReturnType<typeof setInterval> | undefined; let cleared = 0;
  t.mock.method(globalThis, "setInterval", (callback: (...args: unknown[]) => void, interval?: number) => {
    assert.equal(interval, 15000); heartbeat = () => callback(); timer = nativeSet(() => {}, interval); return timer;
  });
  t.mock.method(globalThis, "clearInterval", (value: Parameters<typeof clearInterval>[0]) => { if (value === timer) cleared++; nativeClear(value); });
  const hub = new ManagerEventHub();
  try {
    const stream = hub.open()!; const iterator = await ready(stream); assert.ok(heartbeat); heartbeat();
    assert.match(String(((await iterator.next()).value as { comment: string }).comment), /^keepalive /);
    await stream.cancel("done"); assert.equal(cleared, 1); assert.equal((await iterator.next()).done, true);
  } finally { hub.closeAll(); if (timer) nativeClear(timer); }
});

test("queue overflow closes the real HTTP stream and drains its activation lease without failing the publisher", async t => {
  const hub = new ManagerEventHub({ limits: { queuedFrames: 2 } });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("events", [createManagerEventsOperation(hub)]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { hub.closeAll(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader(); let initial = "";
  while (!initial.includes("event: ready")) { const next = await reader.read(); assert.equal(next.done, false); initial += Buffer.from(next.value!).toString(); }
  for (let revision = 0; revision < 4; revision++) assert.doesNotThrow(() => hub.publish("changed", { revision }));
  assert.equal(hub.activeSubscriberCount(), 0);
  try { while (!(await reader.read()).done) { /* Drain frames already accepted before overflow. */ } } catch { /* Forced transport closure is expected. */ }
  await registration.dispose(); assert.equal(registration.activeOperationCount(), 0);
});
