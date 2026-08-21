import assert from "node:assert/strict";
import test from "node:test";
import { RabiCordisHost, type RabiCordisContext } from "./cordisHost.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginDefinition
} from "./managerPluginRuntime.js";
import {
  ManagerPluginReconciler,
  type DesiredManagerPlugin
} from "./managerPluginReconciler.js";

function definition(
  instanceId: string,
  version: string,
  apply?: (ctx: RabiCordisContext) => void | Promise<void>
): ManagerPluginDefinition {
  return {
    instanceId,
    manifest: {
      id: `builtin:${instanceId}`,
      name: instanceId,
      version,
      kind: "builtin",
      hosts: ["manager"]
    },
    apply
  };
}

function desired(
  plugin: ManagerPluginDefinition,
  revision: string,
  enabled = true
): DesiredManagerPlugin {
  return { definition: plugin, enabled, revision };
}

async function setup() {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  const reconciler = new ManagerPluginReconciler(runtime);
  return {
    host,
    runtime,
    reconciler,
    async dispose() {
      await runtime.unmount();
      await host.dispose();
    }
  };
}

test("Manager Plugin Reconciler mounts desired plugins and skips unchanged revisions", async () => {
  const fixture = await setup();
  let applyCount = 0;
  const plugin = definition("manager:overview", "1.0.0", () => { applyCount += 1; });

  const first = await fixture.reconciler.reconcile([desired(plugin, "overview@1")]);
  const second = await fixture.reconciler.reconcile([desired(plugin, "overview@1")]);

  assert.equal(applyCount, 1);
  assert.equal(first.state, "idle");
  assert.equal(first.revision, 1);
  assert.deepEqual(first.desired, ["manager:overview"]);
  assert.deepEqual(first.active, ["manager:overview"]);
  assert.deepEqual(first.changed, ["manager:overview"]);
  assert.deepEqual(first.rolledBack, []);
  assert.ok(first.startedAt);
  assert.ok(first.completedAt);
  assert.equal(second.state, "idle");
  assert.equal(second.revision, 2);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.active, ["manager:overview"]);

  await fixture.dispose();
});

test("Manager Plugin Reconciler reloads and disables only changed instances", async () => {
  const fixture = await setup();
  const lifecycle: string[] = [];
  const stable = definition("manager:stable", "1.0.0", (ctx) => {
    lifecycle.push("stable:start");
    ctx.effect(() => () => { lifecycle.push("stable:stop"); });
  });
  const changingV1 = definition("manager:changing", "1.0.0", (ctx) => {
    lifecycle.push("changing:v1:start");
    ctx.effect(() => () => { lifecycle.push("changing:v1:stop"); });
  });
  const changingV2 = definition("manager:changing", "2.0.0", (ctx) => {
    lifecycle.push("changing:v2:start");
    ctx.effect(() => () => { lifecycle.push("changing:v2:stop"); });
  });

  await fixture.reconciler.reconcile([
    desired(stable, "stable@1"),
    desired(changingV1, "changing@1")
  ]);
  const reloaded = await fixture.reconciler.reconcile([
    desired(stable, "stable@1"),
    desired(changingV2, "changing@2")
  ]);
  const disabled = await fixture.reconciler.reconcile([
    desired(stable, "stable@1"),
    desired(changingV2, "changing@3", false)
  ]);

  assert.deepEqual(reloaded.changed, ["manager:changing"]);
  assert.deepEqual(disabled.changed, ["manager:changing"]);
  assert.deepEqual(disabled.desired, ["manager:stable"]);
  assert.deepEqual(disabled.active, ["manager:stable"]);
  assert.deepEqual(lifecycle, [
    "stable:start",
    "changing:v1:start",
    "changing:v1:stop",
    "changing:v2:start",
    "changing:v2:stop"
  ]);

  await fixture.dispose();
});

test("Manager Plugin Reconciler deactivates a changed batch in reverse activation order", async () => {
  const fixture = await setup();
  const lifecycle: string[] = [];
  const first = definition("manager:first", "1.0.0", (ctx) => {
    lifecycle.push("first:start");
    ctx.effect(() => () => { lifecycle.push("first:stop"); });
  });
  const second = definition("manager:second", "1.0.0", (ctx) => {
    lifecycle.push("second:start");
    ctx.effect(() => () => { lifecycle.push("second:stop"); });
  });
  const third = definition("manager:third", "1.0.0", (ctx) => {
    lifecycle.push("third:start");
    ctx.effect(() => () => { lifecycle.push("third:stop"); });
  });

  await fixture.reconciler.reconcile([
    desired(first, "first@1"),
    desired(second, "second@1"),
    desired(third, "third@1")
  ]);
  const disabled = await fixture.reconciler.reconcile([]);

  assert.deepEqual(disabled.changed, [
    "manager:first",
    "manager:second",
    "manager:third"
  ]);
  assert.deepEqual(disabled.active, []);
  assert.deepEqual(lifecycle, [
    "first:start",
    "second:start",
    "third:start",
    "third:stop",
    "second:stop",
    "first:stop"
  ]);

  await fixture.dispose();
});

test("Manager Plugin Reconciler stops the reload batch before starting definitions in desired order", async () => {
  const fixture = await setup();
  const lifecycle: string[] = [];
  const firstV1 = definition("manager:first", "1.0.0", (ctx) => {
    lifecycle.push("first:v1:start");
    ctx.effect(() => () => { lifecycle.push("first:v1:stop"); });
  });
  const secondV1 = definition("manager:second", "1.0.0", (ctx) => {
    lifecycle.push("second:v1:start");
    ctx.effect(() => () => { lifecycle.push("second:v1:stop"); });
  });
  const firstV2 = definition("manager:first", "2.0.0", () => {
    lifecycle.push("first:v2:start");
  });
  const secondV2 = definition("manager:second", "2.0.0", () => {
    lifecycle.push("second:v2:start");
  });

  await fixture.reconciler.reconcile([
    desired(firstV1, "first@1"),
    desired(secondV1, "second@1")
  ]);
  const reloaded = await fixture.reconciler.reconcile([
    desired(secondV2, "second@2"),
    desired(firstV2, "first@2")
  ]);

  assert.deepEqual(reloaded.changed, ["manager:second", "manager:first"]);
  assert.deepEqual(reloaded.active, ["manager:second", "manager:first"]);
  assert.deepEqual(lifecycle, [
    "first:v1:start",
    "second:v1:start",
    "second:v1:stop",
    "first:v1:stop",
    "second:v2:start",
    "first:v2:start"
  ]);

  await fixture.dispose();
});

test("Manager Plugin Reconciler removes new batch instances and restores the old batch after activation failure", async () => {
  const fixture = await setup();
  const lifecycle: string[] = [];
  const firstV1 = definition("manager:first", "1.0.0", (ctx) => {
    lifecycle.push("first:v1:start");
    ctx.effect(() => () => { lifecycle.push("first:v1:stop"); });
  });
  const secondV1 = definition("manager:second", "1.0.0", (ctx) => {
    lifecycle.push("second:v1:start");
    ctx.effect(() => () => { lifecycle.push("second:v1:stop"); });
  });
  const firstV2 = definition("manager:first", "2.0.0", (ctx) => {
    lifecycle.push("first:v2:start");
    ctx.effect(() => () => { lifecycle.push("first:v2:stop"); });
  });
  const third = definition("manager:third", "1.0.0", (ctx) => {
    lifecycle.push("third:start");
    ctx.effect(() => () => { lifecycle.push("third:stop"); });
  });
  const brokenSecond = definition("manager:second", "2.0.0", () => {
    lifecycle.push("second:v2:start");
    throw new Error("second activation failed");
  });

  await fixture.reconciler.reconcile([
    desired(firstV1, "first@1"),
    desired(secondV1, "second@1")
  ]);
  const failed = await fixture.reconciler.reconcile([
    desired(firstV2, "first@2"),
    desired(third, "third@1"),
    desired(brokenSecond, "second@2")
  ]);

  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "activation_failed");
  assert.deepEqual(failed.changed, [
    "manager:first",
    "manager:third",
    "manager:second"
  ]);
  assert.deepEqual(failed.rolledBack, ["manager:first", "manager:second"]);
  assert.deepEqual(failed.active, ["manager:first", "manager:second"]);
  assert.equal(fixture.runtime.plugins.has("manager:third"), false);
  assert.deepEqual(lifecycle, [
    "first:v1:start",
    "second:v1:start",
    "second:v1:stop",
    "first:v1:stop",
    "first:v2:start",
    "third:start",
    "second:v2:start",
    "third:stop",
    "first:v2:stop",
    "first:v1:start",
    "second:v1:start"
  ]);

  await fixture.dispose();
});

test("Manager Plugin Reconciler serializes concurrent reconciliation requests", async () => {
  const fixture = await setup();
  const lifecycle: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const first = definition("manager:first", "1.0.0", async (ctx) => {
    lifecycle.push("first:start");
    ctx.effect(() => () => { lifecycle.push("first:stop"); });
    firstStarted();
    await firstGate;
    lifecycle.push("first:ready");
  });
  const second = definition("manager:second", "1.0.0", () => {
    lifecycle.push("second:start");
  });

  const firstRun = fixture.reconciler.reconcile([desired(first, "first@1")]);
  await firstStart;
  assert.equal(fixture.reconciler.status().state, "reconciling");
  const secondRun = fixture.reconciler.reconcile([desired(second, "second@1")]);

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["first:start"]);
  releaseFirst();
  await Promise.all([firstRun, secondRun]);

  assert.ok(lifecycle.indexOf("first:ready") < lifecycle.indexOf("second:start"));
  assert.ok(lifecycle.includes("first:stop"));
  assert.deepEqual(fixture.reconciler.status().active, ["manager:second"]);
  assert.equal(fixture.reconciler.status().revision, 2);

  await fixture.dispose();
});

test("Manager Plugin Reconciler restores the old definition after reload failure", async () => {
  const fixture = await setup();
  let oldStarts = 0;
  const oldPlugin = definition("manager:recoverable", "1.0.0", () => { oldStarts += 1; });
  const brokenPlugin = definition("manager:recoverable", "2.0.0", () => {
    throw new Error("activation failed token=super-secret at C:\\private\\plugin");
  });

  await fixture.reconciler.reconcile([desired(oldPlugin, "recoverable@1")]);
  const failed = await fixture.reconciler.reconcile([desired(brokenPlugin, "recoverable@2")]);

  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.changed, ["manager:recoverable"]);
  assert.deepEqual(failed.rolledBack, ["manager:recoverable"]);
  assert.deepEqual(failed.active, ["manager:recoverable"]);
  assert.equal(oldStarts, 2);
  assert.equal(failed.error?.code, "activation_failed");
  assert.equal(failed.error?.message.includes("super-secret"), false);
  assert.equal(failed.error?.message.includes("C:\\private"), false);

  const retried = await fixture.reconciler.reconcile([desired(brokenPlugin, "recoverable@2")]);
  assert.equal(retried.state, "failed");
  assert.equal(oldStarts, 3);

  await fixture.dispose();
});

test("Manager Plugin Reconciler reports rollback failure without claiming recovery", async () => {
  const fixture = await setup();
  let oldStarts = 0;
  const oldPlugin = definition("manager:rollback-fails", "1.0.0", () => {
    oldStarts += 1;
    if (oldStarts > 1) {
      throw new Error("rollback failed password=hunter2 at C:\\private\\rollback");
    }
  });
  const brokenPlugin = definition("manager:rollback-fails", "2.0.0", () => {
    throw new Error("new activation failed Authorization: Bearer abc.def.ghi");
  });

  await fixture.reconciler.reconcile([desired(oldPlugin, "rollback@1")]);
  const failed = await fixture.reconciler.reconcile([desired(brokenPlugin, "rollback@2")]);

  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "rollback_failed");
  assert.deepEqual(failed.changed, ["manager:rollback-fails"]);
  assert.deepEqual(failed.rolledBack, []);
  assert.deepEqual(failed.active, []);
  assert.equal(failed.error?.message.includes("hunter2"), false);
  assert.equal(failed.error?.message.includes("abc.def.ghi"), false);
  assert.equal(failed.error?.message.includes("C:\\private"), false);

  await fixture.dispose();
});
