import assert from "node:assert/strict";
import test from "node:test";
import { gatewayReadyLine, parseGatewayReadyLine, type GatewayReady } from "./gatewayLifecycle.js";

const ready: GatewayReady = {
  protocolVersion: 1,
  gatewayId: "Rabi__main",
  gatewayGenerationId: "generation-a",
  pid: 1234,
  readyAt: "2026-08-30T07:30:00.000Z",
  endpoints: [{ id: "napcat:main", transport: "websocket", host: "127.0.0.1", port: 41_234 }]
};

test("Gateway READY accepts only the exact route generation and child PID", () => {
  const line = gatewayReadyLine(ready);
  assert.deepEqual(parseGatewayReadyLine(line, {
    gatewayId: ready.gatewayId,
    gatewayGenerationId: ready.gatewayGenerationId,
    pid: ready.pid
  }), ready);
  assert.equal(parseGatewayReadyLine(line, { gatewayId: ready.gatewayId, gatewayGenerationId: "old", pid: ready.pid }), null);
  assert.equal(parseGatewayReadyLine(line, { gatewayId: ready.gatewayId, gatewayGenerationId: ready.gatewayGenerationId, pid: 999 }), null);
});

test("Gateway READY rejects invalid listener endpoints", () => {
  const line = gatewayReadyLine({ ...ready, endpoints: [{ ...ready.endpoints[0]!, port: 0 }] });
  assert.equal(parseGatewayReadyLine(line, {
    gatewayId: ready.gatewayId,
    gatewayGenerationId: ready.gatewayGenerationId,
    pid: ready.pid
  }), null);
});
