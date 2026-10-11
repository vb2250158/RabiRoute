import test from "node:test";
import assert from "node:assert/strict";
import { DshOwnerRecovery, type DshOwnerRecoveryPorts } from "./dshOwnerRecovery.js";
const binding = { baseUrl: "http://127.0.0.1:3100", sessionId: "bound-session", cwd: "C:/workspace", sessionName: "Companion" };
function fixture(overrides: Partial<DshOwnerRecoveryPorts> = {}) {
  const calls: string[] = [];
  const ports: DshOwnerRecoveryPorts = { discover: () => ({ homeDir: "C:/owner-home", discoveredBaseUrls: ["http://127.0.0.1:3200"] }),
    reachable: async url => url.endsWith("3200"), authorize: async url => { calls.push("auth:" + url); },
    verify: async url => { calls.push("verify:" + url); }, launch: async () => { calls.push("launch"); }, ...overrides };
  return { service: new DshOwnerRecovery(ports), calls };
}
test("discovers a moved local owner and verifies the original session", async () => {
  const f = fixture();
  assert.equal(await f.service.ensure(binding), "http://127.0.0.1:3200");
  assert.deepEqual(f.calls, ["auth:http://127.0.0.1:3200", "verify:http://127.0.0.1:3200"]);
});
test("offline owner is launched once for concurrent requests then rediscovered", async () => {
  let live = false;
  const f = fixture({ reachable: async () => live, launch: async () => { f.calls.push("launch"); live = true; } });
  const urls = await Promise.all([f.service.ensure(binding), f.service.ensure(binding)]);
  assert.equal(f.calls.filter(c => c === "launch").length, 1);
  assert.deepEqual(urls, [binding.baseUrl, binding.baseUrl]);
});
test("never switches a bound session or silently replaces an explicit disconnect", async () => {
  const f = fixture({ verify: async () => { throw new Error("session mismatch"); } });
  await assert.rejects(f.service.ensure(binding), /session mismatch/);
  assert.equal(f.calls.includes("launch"), false);
  const blocked = fixture({ authorize: async () => { throw new Error("disconnected"); } });
  await assert.rejects(blocked.service.ensure(binding), /disconnected/);
  assert.equal(blocked.calls.includes("launch"), false);
});
test("remote owners are never scanned or started on this computer", async () => {
  const f = fixture({ discover: () => { throw new Error("unexpected local discovery"); } });
  const remote = { ...binding, baseUrl: "https://agent.example.test" };
  assert.equal(await f.service.ensure(remote), remote.baseUrl);
});
