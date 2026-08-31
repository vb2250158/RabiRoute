import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  listenManagerEndpoint,
  managerHostIsLoopback,
  managerPortIsFetchSafe,
  parseManagerPortPolicy
} from "./managerEndpointPolicy.js";

test("Manager port policy defaults to OS-assigned local endpoints", () => {
  assert.deepEqual(parseManagerPortPolicy(undefined), { mode: "auto" });
  assert.deepEqual(parseManagerPortPolicy("auto"), { mode: "auto" });
  assert.deepEqual(parseManagerPortPolicy("0"), { mode: "auto" });
  assert.deepEqual(parseManagerPortPolicy("8790"), { mode: "fixed", port: 8790 });
  assert.throws(() => parseManagerPortPolicy("nope"), /GATEWAY_MANAGER_PORT/);
  assert.throws(() => parseManagerPortPolicy("70000"), /GATEWAY_MANAGER_PORT/);
});

test("Manager loopback detection keeps LAN and local allocation policies separate", () => {
  assert.equal(managerHostIsLoopback("127.0.0.1"), true);
  assert.equal(managerHostIsLoopback("localhost"), true);
  assert.equal(managerHostIsLoopback("[::1]"), true);
  assert.equal(managerHostIsLoopback("0.0.0.0"), false);
});

test("Manager endpoints reject ports blocked by browser Fetch", async () => {
  assert.equal(managerPortIsFetchSafe(6000), false);
  assert.equal(managerPortIsFetchSafe(6667), false);
  assert.equal(managerPortIsFetchSafe(10080), false);
  assert.equal(managerPortIsFetchSafe(8790), true);

  const server = http.createServer();
  await assert.rejects(
    listenManagerEndpoint({ server, host: "127.0.0.1", policy: { mode: "fixed", port: 6000 } }),
    /blocked by browser Fetch/
  );
  assert.equal(server.listening, false);
});

test("Automatic loopback endpoint asks the OS for an unused port", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  try {
    const endpoint = await listenManagerEndpoint({
      server,
      host: "127.0.0.1",
      policy: { mode: "auto" }
    });
    assert.ok(endpoint.port > 0);
    assert.equal(managerPortIsFetchSafe(endpoint.port), true);
    assert.equal(endpoint.baseUrl, `http://127.0.0.1:${endpoint.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Automatic LAN endpoint also asks the OS for an unused port", async () => {
  const candidate = http.createServer();
  try {
    const endpoint = await listenManagerEndpoint({
      server: candidate,
      host: "0.0.0.0",
      policy: { mode: "auto" }
    });
    assert.ok(endpoint.port > 0);
    assert.equal(managerPortIsFetchSafe(endpoint.port), true);
  } finally {
    if (candidate.listening) await new Promise<void>(resolve => candidate.close(() => resolve()));
  }
});
