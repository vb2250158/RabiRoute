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
