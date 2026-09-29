import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHostEndpointSession } from "../lib/host-endpoint.mjs";

const descriptor = { ok: true, managerBaseUrl: "http://127.0.0.1:12345", applicationGenerationId: "generation-fixture", managerInstanceId: "instance-fixture" };
const meta = { applicationGenerationId: descriptor.applicationGenerationId, managerInstanceId: descriptor.managerInstanceId, health: { live: true, requiredReady: true, state: "healthy" } };
const options = { hostExecutable: "fixture-host.exe", env: {}, spawnSync: () => ({ status: 0, stdout: JSON.stringify(descriptor) }), fetchImpl: async () => Response.json(meta) };

test("each ensure resolves Host again and only reads current metadata", async () => {
  let generation = 0;
  const calls = [];
  const session = createHostEndpointSession({ ...options, timeoutMs: 1234,
    spawnSync: (file, args, opts) => {
      assert.equal(file, options.hostExecutable);
      assert.deepEqual(args, ["--command", "status", "--json"]);
      assert.equal(opts.shell, false);
      assert.equal(opts.timeout, 1234);
      assert.equal(opts.maxBuffer, 65536);
      assert.equal(opts.windowsHide, true);
      generation++;
      return { status: 0, stdout: JSON.stringify({ ...descriptor, managerBaseUrl: `http://127.0.0.1:${12345 + generation}`, applicationGenerationId: String(generation) }) };
    }, fetchImpl: async (url, opts) => {
      calls.push(url);
      assert.equal(opts.redirect, "error");
      assert.deepEqual(opts.headers, { accept: "application/json" });
      assert.ok(opts.signal instanceof AbortSignal);
      return Response.json({ ...meta, applicationGenerationId: String(generation) });
    }
  });
  assert.equal((await session.ensure()).managerUrl, "http://127.0.0.1:12346");
  assert.equal((await session.ensure()).meta.applicationGenerationId, "2");
  assert.deepEqual(calls, ["http://127.0.0.1:12346/meta", "http://127.0.0.1:12347/meta"]);
});

test("explicit, environment and default executable precedence", async () => {
  for (const [configuration, expected] of [
    [{ hostExecutable: "explicit.exe", env: { RABIROUTE_HOST_EXE: "environment.exe" } }, "explicit.exe"],
    [{ env: { RABIROUTE_HOST_EXE: "environment.exe" } }, "environment.exe"],
    [{ env: { LOCALAPPDATA: "fixture-local" } }, path.join("fixture-local", "Programs", "RabiRoute", "RabiRouteHost.exe")]
  ]) {
    await createHostEndpointSession({ fetchImpl: options.fetchImpl, ...configuration, spawnSync: (file) => {
      assert.equal(file, expected); return options.spawnSync();
    } }).ensure();
  }
  assert.throws(() => createHostEndpointSession({ env: {} }), /Configure/);
});

test("accepts bare and enveloped identities and healthy or degraded readiness", async () => {
  for (const state of ["healthy", "degraded"]) for (const envelope of [true, false]) {
    const value = { ...meta, health: { ...meta.health, state } };
    const session = createHostEndpointSession({ ...options, fetchImpl: async () => Response.json(envelope ? { code: 0, data: value } : value) });
    assert.deepEqual((await session.ensure()).meta, value);
  }
});

test("diagnostic bypasses readiness but never identity checks", async () => {
  const session = createHostEndpointSession({ ...options, fetchImpl: async () => Response.json({ ...meta, health: { live: false, requiredReady: false, state: "starting" } }) });
  await assert.rejects(session.ensure(), /not ready/);
  assert.equal((await session.ensure({ diagnostic: true })).meta.health.state, "starting");
  for (const change of [{ applicationGenerationId: "other" }, { managerInstanceId: "other" }, { applicationGenerationId: "" }]) {
    await assert.rejects(createHostEndpointSession({ ...options, fetchImpl: async () => Response.json({ ...meta, ...change }) }).ensure({ diagnostic: true }), /identity/);
  }
});

test("rejects invalid descriptors without making HTTP calls", async () => {
  for (const result of [
    { status: 1, stdout: "secret" }, { status: 0, error: new Error("secret") }, { status: null, signal: "SIGTERM" },
    { status: 0, stdout: "not json secret" }, { status: 0, stdout: "x".repeat(65537) },
    ...[{ ok: false }, { applicationGenerationId: " " }, { managerInstanceId: null }].map(change => ({ status: 0, stdout: JSON.stringify({ ...descriptor, ...change }) }))
  ]) {
    let requests = 0;
    const session = createHostEndpointSession({ ...options, spawnSync: () => result, fetchImpl: async () => { requests++; throw new Error(); } });
    await assert.rejects(session.ensure(), error => !error.message.includes("secret") && /descriptor/.test(error.message));
    assert.equal(requests, 0);
  }
});

test("only strict HTTP loopback origins are accepted", async () => {
  for (const url of ["http://localhost:12345/", "http://[::1]:12345", "http://127.0.0.1:12345"]) {
    await createHostEndpointSession({ ...options, spawnSync: () => ({ status: 0, stdout: JSON.stringify({ ...descriptor, managerBaseUrl: url }) }) }).ensure();
  }
  for (const url of ["https://localhost", "http://example.invalid", "http://user:secret@localhost", "http://localhost/api", "http://localhost/..", "http://localhost/a/..", "http://localhost?", "http://localhost#", "http://localhost/?x=1", "http://localhost/#x", "http://localhost\\evil", " http://localhost", "file:///local", "http://127.0.0.1.evil.invalid"]) {
    let requests = 0;
    await assert.rejects(createHostEndpointSession({ ...options, spawnSync: () => ({ status: 0, stdout: JSON.stringify({ ...descriptor, managerBaseUrl: url }) }), fetchImpl: async () => { requests++; } }).ensure(), /origin/);
    assert.equal(requests, 0);
  }
});

test("metadata failures are bounded and sanitized", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("secret credential"); },
    async () => new Response("secret", { status: 503 }),
    async () => new Response("not-json-secret"),
    async () => Response.json({ code: 1, data: meta }),
    async () => new Response(JSON.stringify({ ...meta, padding: "x".repeat(65536) }))
  ]) {
    await assert.rejects(createHostEndpointSession({ ...options, fetchImpl }).ensure(), error => /metadata/.test(error.message) && !error.message.includes("secret"));
  }
});

test("invalid timeout is rejected before any process operation", () => {
  for (const timeoutMs of [0, -1, 12001, NaN, 1.5, "1000"]) assert.throws(() => createHostEndpointSession({ ...options, timeoutMs }), /timeout/);
});
