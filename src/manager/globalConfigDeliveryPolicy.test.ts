import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RabiGlobalConfigStore } from "./globalConfig.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RabiGlobalConfigStore(root);
  store.patch({ webguiLan: { enabled: true } });
  return { root, store, policyPath: path.join(root, "data", ".runtime", "lan-agent-delivery-policy.json"),
    pendingPath: path.join(root, "data", ".runtime", "lan-agent-delivery-policy.pending") };
}

test("durable delivery identity survives restart and unrelated writes, HTTP admission does not", t => {
  const { root, store } = fixture(t);
  const delivery = store.getLanAgentDeliveryPolicy();
  const admission = store.getLanAgentAdmissionPolicy();
  store.patch({ rabiName: "Fixture PC" });
  store.reload();
  assert.deepEqual(store.getLanAgentDeliveryPolicy(), delivery);
  assert.deepEqual(store.getLanAgentAdmissionPolicy(), admission);
  const restarted = new RabiGlobalConfigStore(root);
  assert.deepEqual(restarted.getLanAgentDeliveryPolicy(), delivery);
  assert.notEqual(restarted.getLanAgentAdmissionPolicy().incarnation, admission.incarnation);
  assert.equal("lanAgentDeliveryPolicy" in restarted.read(), false);
  assert.equal("lanAgentAdmissionIncarnation" in restarted.read(), false);
  restarted.patch({ webguiLan: { enabled: false } });
  const disabled = restarted.getLanAgentDeliveryPolicy();
  assert.equal(disabled.enabled, false);
  assert.notEqual(disabled.incarnation, delivery.incarnation);
  const next = new RabiGlobalConfigStore(root);
  assert.deepEqual(next.getLanAgentDeliveryPolicy(), disabled);
  next.patch({ webguiLan: { enabled: true } });
  assert.notEqual(next.getLanAgentDeliveryPolicy().incarnation, delivery.incarnation);
  assert.notEqual(next.getLanAgentDeliveryPolicy().incarnation, disabled.incarnation);
});

for (const failure of ["policy", "config", "unchanged-policy-config"] as const) {
  test(`failed ${failure} publication closes both gates and invalidates old delivery after restart`, t => {
    const { root, store, policyPath, pendingPath } = fixture(t);
    const original = store.getLanAgentDeliveryPolicy();
    const admission = store.getLanAgentAdmissionPolicy();
    const saved = fs.readFileSync(store.configPath, "utf8");
    const failedPath = failure === "policy" ? policyPath : store.configPath;
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === failedPath) throw Object.assign(new Error("fixture rename failure"), { code: "EIO" });
      return rename(from, to);
    });
    assert.throws(() => store.patch(failure === "unchanged-policy-config"
      ? { rabiName: "Rejected PC" } : { webguiLan: { enabled: false } }), /fixture rename failure/);
    mock.mock.restore();
    assert.equal(fs.readFileSync(store.configPath, "utf8"), saved);
    assert.equal(store.getLanAgentAdmissionPolicy().enabled, false);
    assert.notEqual(store.getLanAgentAdmissionPolicy().incarnation, admission.incarnation);
    assert.equal(store.getLanAgentDeliveryPolicy().enabled, false);
    assert.equal(fs.existsSync(pendingPath), true);
    const restarted = new RabiGlobalConfigStore(root);
    assert.equal(restarted.getLanAgentDeliveryPolicy().enabled, true);
    assert.notEqual(restarted.getLanAgentDeliveryPolicy().incarnation, original.incarnation);
    assert.equal(fs.existsSync(pendingPath), false);
    store.reload();
    assert.equal(store.getLanAgentAdmissionPolicy().enabled, true);
    assert.notEqual(store.getLanAgentDeliveryPolicy().incarnation, original.incarnation);
    assert.notEqual(store.getLanAgentAdmissionPolicy().incarnation, admission.incarnation);
  });
}

test("corrupt durable fence fails closed without overwriting evidence", t => {
  const { root, policyPath } = fixture(t);
  for (const corrupt of ["{", '{"enabled":true,"incarnation":""}', '{"enabled":"true","incarnation":"fixture"}']) {
    fs.writeFileSync(policyPath, corrupt);
    assert.throws(() => new RabiGlobalConfigStore(root));
    assert.equal(fs.readFileSync(policyPath, "utf8"), corrupt);
  }
});

test("failed reload closes delivery and recovery rotates the original incarnation", t => {
  const { store } = fixture(t);
  const original = store.getLanAgentDeliveryPolicy();
  const saved = fs.readFileSync(store.configPath, "utf8");
  fs.writeFileSync(store.configPath, "{");
  store.reload();
  assert.equal(store.getLanAgentDeliveryPolicy().enabled, false);
  fs.writeFileSync(store.configPath, saved);
  store.reload();
  assert.equal(store.getLanAgentDeliveryPolicy().enabled, true);
  assert.notEqual(store.getLanAgentDeliveryPolicy().incarnation, original.incarnation);
});
