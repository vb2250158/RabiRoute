import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type http from "node:http";
import {
  handleManagerHostLifecycleRequest,
  managerHostIdentityFromEnvironment,
  managerReadyLine
} from "./hostLifecycle.js";

function request(token?: string, remoteAddress = "127.0.0.1"): http.IncomingMessage {
  const value = new EventEmitter() as http.IncomingMessage;
  Object.defineProperties(value, {
    method: { value: "POST", writable: true },
    headers: { value: token ? { "x-rabiroute-host-token": token } : {}, writable: true },
    socket: { value: { remoteAddress } }
  });
  return value;
}

function response(): http.ServerResponse {
  return new EventEmitter() as http.ServerResponse;
}

test("Host identity is absent for ordinary cross-platform Manager runs", () => {
  assert.equal(managerHostIdentityFromEnvironment({}), null);
});

test("Host identity fails closed when generation or token is missing", () => {
  assert.throws(() => managerHostIdentityFromEnvironment({ RABIROUTE_HOSTED: "1" }), /APPLICATION_GENERATION_ID/);
  assert.throws(() => managerHostIdentityFromEnvironment({
    RABIROUTE_HOSTED: "1",
    RABIROUTE_APPLICATION_GENERATION_ID: "bad",
    RABIROUTE_HOST_CONTROL_TOKEN: "x".repeat(64)
  }), /APPLICATION_GENERATION_ID/);
});

test("Only the owning Host token can request Manager shutdown", async () => {
  const identity = {
    applicationGenerationId: "12345678-1234-1234-1234-123456789abc",
    controlToken: "t".repeat(64)
  };
  const statuses: number[] = [];
  const shutdowns: string[] = [];
  const invoke = (incoming: http.IncomingMessage): boolean => handleManagerHostLifecycleRequest(
    incoming,
    new URL("http://127.0.0.1/_rabiroute/host/shutdown"),
    response(),
    {
      identity,
      shutdown: reason => shutdowns.push(reason),
      jsonResponse: (_target, status) => { statuses.push(status); }
    }
  );

  assert.equal(invoke(request("wrong")), true);
  assert.equal(invoke(request(identity.controlToken, "192.168.1.2")), true);
  assert.equal(invoke(request(identity.controlToken)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, [403, 403, 202]);
  assert.deepEqual(shutdowns, ["host"]);
});

test("Ready output is a single structured protocol line", () => {
  const line = managerReadyLine({
    protocolVersion: 1,
    applicationGenerationId: "12345678-1234-1234-1234-123456789abc",
    managerInstanceId: "manager-1",
    pid: 42,
    baseUrl: "http://127.0.0.1:12345",
    readyAt: "2026-08-30T00:00:00.000Z"
  });
  assert.match(line, /^RABIROUTE_MANAGER_READY:\{/);
  assert.equal(line.includes("\n"), false);
});
