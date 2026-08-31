import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import {
  handleManagerLanDiscoveryRequest,
  MANAGER_DISCOVERY_PATH,
  MANAGER_DISCOVERY_PROTOCOL_VERSION,
  MANAGER_DISCOVERY_SERVICE_TYPE
} from "./managerLanDiscovery.js";
import {
  startManagerDiscoveryPublisher,
  type BonjourFactory,
  type ManagerDiscoveryStatus
} from "./managerLanDiscoveryPublisher.js";

test("Manager LAN discovery uses a versioned DNS-SD contract without a fixed port", () => {
  assert.equal(MANAGER_DISCOVERY_SERVICE_TYPE, "rabiroute");
  assert.equal(MANAGER_DISCOVERY_PROTOCOL_VERSION, 1);
  assert.equal(MANAGER_DISCOVERY_PATH, "/.well-known/rabiroute-manager");
});

test("Manager LAN discovery document is public only on the exact enabled well-known path", () => {
  const calls: Array<{ statusCode: number; body: unknown }> = [];
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); }
  } as unknown as http.ServerResponse;
  const request = { method: "GET" } as http.IncomingMessage;
  const document = Object.freeze({
    protocolVersion: 1 as const,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a",
    guid: "rabi-a",
    name: "Rabi",
    computerName: "pc-a",
    deviceType: "RabiRoute Manager" as const,
    version: "1.0.0"
  });
  const handled = handleManagerLanDiscoveryRequest(
    request,
    new URL(`http://192.0.2.1${MANAGER_DISCOVERY_PATH}`),
    response,
    {
      enabled: true,
      document: () => document,
      jsonResponse: (_response, statusCode, body) => { calls.push({ statusCode, body }); }
    }
  );
  assert.equal(handled, true);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([{ statusCode: 200, body: { code: 0, data: document } }])
  );

  calls.length = 0;
  handleManagerLanDiscoveryRequest(
    request,
    new URL(`http://192.0.2.1${MANAGER_DISCOVERY_PATH}`),
    response,
    {
      enabled: false,
      document: () => { throw new Error("disabled discovery must not evaluate identity"); },
      jsonResponse: (_response, statusCode, body) => { calls.push({ statusCode, body }); }
    }
  );
  assert.equal(calls[0]?.statusCode, 404);
});

test("Manager DNS-SD publisher advertises the actual listener port and destroys its socket", async () => {
  const events = new EventEmitter();
  let published: Record<string, unknown> | undefined;
  let stopped = false;
  let destroyed = false;
  const factory: BonjourFactory = () => ({
    publish(options) {
      published = options as unknown as Record<string, unknown>;
      queueMicrotask(() => events.emit("up"));
      return Object.assign(events, {
        stop(callback?: () => void) { stopped = true; callback?.(); }
      });
    },
    destroy() { destroyed = true; }
  });
  const statuses: ManagerDiscoveryStatus[] = [];
  const publisher = await startManagerDiscoveryPublisher({
    port: 54321,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a",
    onStatus: status => statuses.push(status)
  }, factory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published?.port, 54321);
  assert.equal(published?.type, "rabiroute");
  assert.deepEqual(published?.txt, {
    protocol: "1",
    path: MANAGER_DISCOVERY_PATH,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a"
  });
  assert.equal(statuses.at(-1)?.state, "published");
  await publisher.stop();
  assert.equal(stopped, true);
  assert.equal(destroyed, true);
});
