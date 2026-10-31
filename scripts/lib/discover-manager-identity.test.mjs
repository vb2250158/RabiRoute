import assert from "node:assert/strict";
import test from "node:test";
import { discoverManagerIdentity } from "./discover-manager-url.mjs";

const identity = { managerBaseUrl: "http://127.0.0.1:51234", applicationGenerationId: "generation-a", managerInstanceId: "manager-a" };
const meta = { ...identity, health: { live: true, requiredReady: true, state: "degraded" } };
const env = { LOCALAPPDATA: "C:/fixture" };
const options = {
  platform: "win32", env,
  readFile: async () => JSON.stringify({ schemaVersion: 1, ...identity }),
  fetch: async (_url, request) => { assert.equal(request.redirect, "error"); return { ok: true, json: async () => meta }; },
  execFile: async () => { throw new Error("Host should not run for a valid cache"); }
};
test("address-free discovery validates the Host cache and permits required-ready degraded", async () => {
  assert.deepEqual(await discoverManagerIdentity(options), identity);
});
test("missing, malformed, incomplete and stale caches use captured Host stdout once", async () => {
  for (const raw of [null, "invalid", JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 1, ...identity, managerInstanceId: "old" })]) {
    let calls = 0;
    const actual = await discoverManagerIdentity({ ...options,
      readFile: async () => { if (raw === null) throw new Error("missing"); return raw; },
      execFile: async (_exe, args, opts) => {
        calls++; assert.deepEqual(args, ["--command", "status", "--json"]);
        assert.equal(opts.windowsHide, true); assert.ok(opts.signal); assert.ok(opts.timeout <= 5000);
        return { stdout: JSON.stringify({ ok: true, ...identity }) };
      }
    });
    assert.deepEqual(actual, identity); assert.equal(calls, 1);
  }
});
test("stopped Host and mismatched live identity fail closed", async () => {
  for (const status of [{ ok: true, state: "stopped" }, { ok: true, ...identity, managerInstanceId: "old" }]) {
    await assert.rejects(discoverManagerIdentity({ ...options, readFile: async () => "invalid", execFile: async () => ({ stdout: JSON.stringify(status) }) }), /incomplete|mismatch/);
  }
});
test("explicit URL bypasses the cache but still verifies live readiness", async () => {
  assert.deepEqual(await discoverManagerIdentity({ ...options, explicit: identity.managerBaseUrl, fetch: async () => ({ ok: true, json: async () => ({ ...meta, health: { ...meta.health, requiredReady: false } }) }) }), identity);
  await assert.rejects(discoverManagerIdentity({ ...options, explicit: "http://user:secret@localhost:51234" }), /without credentials/);
});
test("existing Agent can follow a replacement generation without restarting its environment", async () => {
  let current = identity;
  const opts = { ...options, readFile: async () => JSON.stringify({ schemaVersion: 1, ...current }), fetch: async () => ({ ok: true, json: async () => ({ ...meta, ...current }) }) };
  assert.deepEqual(await discoverManagerIdentity(opts), identity);
  current = { ...identity, managerBaseUrl: "http://127.0.0.1:51235", applicationGenerationId: "generation-b", managerInstanceId: "manager-b" };
  assert.deepEqual(await discoverManagerIdentity(opts), current);
});
