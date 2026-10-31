import assert from "node:assert/strict";
import test from "node:test";
import { capability, createPluginTestHarness, definePlugin, ScopedEventBus, ScopedStorage } from "@rabiroute/plugin-sdk";

test("plugin SDK harness activates and disposes scoped resources", async () => {
  const lifecycle: string[] = [];
  const harness = createPluginTestHarness({ services: [["host.value@1", 7]], permissions: ["network.local"] });
  await harness.activate(definePlugin({
    activate(context) {
      assert.equal(context.services.require("host.value@1"), 7);
      context.permissions.require("network.local");
      context.contributions.register({ kind: "page", id: "test", value: {} });
      context.effects.add(() => { lifecycle.push("start"); return () => { lifecycle.push("stop"); }; });
    }
  }));
  assert.deepEqual(lifecycle, ["start"]);
  assert.equal(harness.contributions.list().length, 1);
  await harness.dispose();
  assert.deepEqual(lifecycle, ["start", "stop"]);
});

test("plugin SDK exposes versioned capabilities and scoped utilities", () => {
  assert.equal(capability("route.policy", 1), "route.policy@1");
  const storage = new ScopedStorage("plugin");
  storage.set("state", 1);
  assert.equal(storage.get("state"), 1);
  const bus = new ScopedEventBus<{ changed: number }>();
  let current = 0;
  bus.on("changed", value => { current = value; });
  bus.emit("changed", 2);
  assert.equal(current, 2);
});

test("SDK harness exposes full lifecycle and publication with scoped retirement", async () => {
  const harness = createPluginTestHarness();
  const calls: string[] = [];
  await harness.activate(definePlugin({ activate(context) {
    assert.equal(typeof context.identity.activationId, "string");
    context.effects.adopt(() => { calls.push("private"); });
    context.publication.add({
      publish() { calls.push("publish"); },
      rollback() { calls.push("rollback"); },
      async afterPublish({ signal, previousRetirement }) {
        await previousRetirement;
        assert.equal(signal, context.lifecycle.signal);
        assert.equal(signal.aborted, false);
        calls.push("start");
      },
      retire() {
        assert.equal(context.lifecycle.signal.aborted, true);
        calls.push("retire");
      }
    });
  } }));
  assert.deepEqual(calls, ["publish", "start"]);
  await harness.dispose();
  assert.deepEqual(calls, ["publish", "start", "retire", "private"]);
});

test("SDK harness rolls back partial publication without retiring an unpublished candidate", async () => {
  const harness = createPluginTestHarness();
  const calls: string[] = [];
  await assert.rejects(harness.activate(definePlugin({ activate(context) {
    context.effects.adopt(() => { calls.push("private"); });
    context.publication.add({
      publish() { calls.push("publish"); throw new Error("publication rejected"); },
      rollback() { calls.push("rollback"); },
      retire() { calls.push("retire"); }
    });
  } })), /publication rejected/);
  assert.deepEqual(calls, ["publish", "rollback", "private"]);
  await harness.dispose();
});

test("SDK rejects async publication callbacks rather than claiming synchronous atomic commit", async () => {
  const harness = createPluginTestHarness();
  let rolledBack = false;
  await assert.rejects(harness.activate(definePlugin({ activate(context) {
    context.publication.add({ publish: async () => {}, rollback() { rolledBack = true; } });
  } })), /must be synchronous/);
  assert.equal(rolledBack, true);
  await harness.dispose();
});
