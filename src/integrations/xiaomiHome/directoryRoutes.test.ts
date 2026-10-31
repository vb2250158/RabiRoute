import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { invokeFixtureXiaomiOperation, type XiaomiHomeOperationFixtureContext } from "./managerOperations.fixture.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";

test("directory HTTP reads validate before discovery and forward filters, pages and exact device IDs", async () => {
  const calls: unknown[] = [];
  const statuses: number[] = [];
  const context: XiaomiHomeOperationFixtureContext = {
    runtime: { client: {
      queryDevices: async (q: unknown) => { calls.push(q); return { items: [] }; },
      queryResources: async (q: unknown) => { calls.push(q); return { items: [] }; },
      getDevice: async (id: string) => { calls.push(id); return { deviceId: id }; }
    } } as unknown as XiaomiHomeRuntimeController,
    lifecycleFence: { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" },
    readJsonBody: async () => { throw Error("No read body expected"); },
    jsonResponse: (_response, status) => { statuses.push(status); },
    deliverEvent: async () => undefined
  };
  const request = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: {} } as http.IncomingMessage;
  for (const suffix of ["/devices?q=书房&limit=5", "/resources?kind=climate&available=1&offset=5&limit=5", "/devices/ac", "/devices?limit=51", "/resources?q=x&q=y", "/devices/%ZZ", "/devices/ac?view=detail"]) {
    invokeFixtureXiaomiOperation(request, new URL("http://localhost/api/agent/xiaomi-home" + suffix), {} as http.ServerResponse, context);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(statuses, [200, 200, 200, 400, 400, 400, 400]);
  assert.deepEqual(calls, [
    { q: "书房", kind: "", available: undefined, deviceId: "", view: "summary", includeActions: false, offset: 0, limit: 5 },
    { q: "", kind: "climate", available: true, deviceId: "", view: "summary", includeActions: false, offset: 5, limit: 5 }, "ac"
  ]);
});
