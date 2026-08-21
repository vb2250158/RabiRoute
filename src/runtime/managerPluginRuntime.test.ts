import assert from "node:assert/strict";
import test from "node:test";
import { RabiCordisHost } from "./cordisHost.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginDefinition
} from "./managerPluginRuntime.js";

type DefinitionOptions = {
  instanceId?: string;
  pluginId?: string;
  contributionId?: string;
  apply?: ManagerPluginDefinition["apply"];
};

function definition(
  id: string,
  routeId: string,
  options: DefinitionOptions = {}
): ManagerPluginDefinition {
  return {
    instanceId: options.instanceId ?? `manager:${id}`,
    manifest: {
      id: options.pluginId ?? `builtin:manager/${id}`,
      name: id,
      version: "1.0.0",
      kind: "builtin",
      hosts: ["manager", "web", "desktop"]
    },
    contributions: [
      {
        kind: "page",
        id: `${options.contributionId ?? id}-page`,
        label: {
          key: `page.${id}`,
          fallback: id
        },
        routeId,
        rendererId: `builtin.page.${id}.v1`,
        hosts: ["web"],
        surface: "manager.pages",
        slot: "main"
      },
      {
        kind: "navigation",
        id: options.contributionId ?? id,
        label: {
          key: `navigation.${id}`,
          fallback: id
        },
        routeId,
        hosts: ["web"],
        surface: "manager",
        slot: "primary"
      }
    ],
    apply: options.apply
  };
}

test("Manager Plugin Runtime publishes plugin state and rolls one plugin back to inactive", async () => {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host, [
    definition("overview", "route.overview"),
    definition("performance", "route.performance")
  ]);

  assert.deepEqual(
    runtime.catalog.snapshot().plugins.map(item => [item.instanceId, item.pluginId, item.status]),
    [
      ["manager:overview", "builtin:manager/overview", "active"],
      ["manager:performance", "builtin:manager/performance", "active"]
    ]
  );
  assert.deepEqual(
    runtime.contributions.catalog("web").contributions
      .filter(item => item.kind === "navigation")
      .map(item => [item.routeId, item.pluginId, item.instanceId]),
    [
      ["route.overview", "builtin:manager/overview", "manager:overview"],
      ["route.performance", "builtin:manager/performance", "manager:performance"]
    ]
  );

  await runtime.plugins.get("manager:overview")?.unmount();
  assert.equal(runtime.catalog.get("manager:overview")?.status, "inactive");
  assert.equal(runtime.plugins.has("manager:overview"), false);
  assert.deepEqual(
    runtime.contributions.catalog("web").contributions
      .filter(item => item.kind === "navigation")
      .map(item => item.routeId),
    ["route.performance"]
  );
  assert.equal(runtime.catalog.get("manager:performance")?.status, "active");

  await runtime.unmount();
  await host.dispose();
});

test("Manager Plugin Runtime rolls back contributions and effects after activation failure", async () => {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  let effectActive = 0;

  await assert.rejects(
    runtime.mount(definition("broken", "route.broken", {
      apply(ctx) {
        ctx.effect(() => {
          effectActive += 1;
          return () => { effectActive -= 1; };
        });
        throw new Error(
          "broken plugin at C:\\private\\runtime token=super-secret password=hunter2 Authorization: Bearer abc.def.ghi"
        );
      }
    })),
    /broken plugin/
  );

  const failure = runtime.catalog.get("manager:broken");
  assert.equal(effectActive, 0);
  assert.equal(runtime.plugins.has("manager:broken"), false);
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.error?.message.includes("super-secret"), false);
  assert.equal(failure?.error?.message.includes("hunter2"), false);
  assert.equal(failure?.error?.message.includes("abc.def.ghi"), false);
  assert.equal(failure?.error?.message.includes("C:\\private"), false);
  assert.deepEqual(runtime.contributions.catalog().contributions, []);

  await runtime.unmount();
  await host.dispose();
});

test("Manager Plugin Runtime retries failed and inactive instances without redeclaring them", async () => {
  const host = new RabiCordisHost();
  let attempts = 0;
  const retryable = definition("retryable", "route.retryable", {
    apply() {
      attempts += 1;
      if (attempts === 1) throw new Error("first activation failed");
    }
  });
  const runtime = await mountManagerPluginRuntime(host);

  await assert.rejects(runtime.mount(retryable), /first activation failed/);
  assert.equal(runtime.catalog.get("manager:retryable")?.status, "failed");

  const mounted = await runtime.mount(retryable);
  assert.equal(runtime.catalog.get("manager:retryable")?.status, "active");
  await mounted.unmount();
  assert.equal(runtime.catalog.get("manager:retryable")?.status, "inactive");

  const remounted = await runtime.mount(retryable);
  assert.equal(runtime.catalog.get("manager:retryable")?.status, "active");
  assert.equal(attempts, 3);
  await remounted.unmount();
  await runtime.unmount();
  await host.dispose();
});

test("Manager Plugin Runtime rolls back earlier definitions when initial activation fails", async () => {
  const host = new RabiCordisHost();
  let firstActive = 0;

  await assert.rejects(
    mountManagerPluginRuntime(host, [
      definition("first", "route.first", {
        apply(ctx) {
          ctx.effect(() => {
            firstActive += 1;
            return () => { firstActive -= 1; };
          });
        }
      }),
      definition("second", "route.second", {
        apply() {
          throw new Error("second activation failed");
        }
      })
    ]),
    /second activation failed/
  );

  assert.equal(firstActive, 0);
  await host.dispose();
});

test("Manager Plugin Runtime keeps instance IDs separate for two instances of one plugin", async () => {
  const host = new RabiCordisHost();
  const sharedPluginId = "package:manager/shared";
  const runtime = await mountManagerPluginRuntime(host, [
    definition("shared-primary", "route.primary", {
      instanceId: "manager:shared:primary",
      pluginId: sharedPluginId,
      contributionId: "shared-primary"
    }),
    definition("shared-secondary", "route.secondary", {
      instanceId: "manager:shared:secondary",
      pluginId: sharedPluginId,
      contributionId: "shared-secondary"
    })
  ]);

  const primary = runtime.plugins.get("manager:shared:primary");
  const secondary = runtime.plugins.get("manager:shared:secondary");
  assert.equal(primary?.pluginId, sharedPluginId);
  assert.equal(secondary?.pluginId, sharedPluginId);
  assert.notEqual(primary?.instanceId, secondary?.instanceId);
  assert.deepEqual(
    runtime.catalog.snapshot().plugins.map(item => [item.instanceId, item.pluginId]),
    [
      ["manager:shared:primary", sharedPluginId],
      ["manager:shared:secondary", sharedPluginId]
    ]
  );

  await primary?.unmount();
  assert.equal(runtime.catalog.get("manager:shared:primary")?.status, "inactive");
  assert.equal(runtime.catalog.get("manager:shared:secondary")?.status, "active");
  assert.deepEqual(
    runtime.contributions.catalog("web").contributions
      .filter(item => item.kind === "navigation")
      .map(item => item.id),
    ["shared-secondary"]
  );

  await runtime.unmount();
  await host.dispose();
});

test("Manager Plugin Runtime keeps missing dependencies visible without applying the plugin", async () => {
  const host = new RabiCordisHost();
  let applied = false;
  const runtime = await mountManagerPluginRuntime(host, [{
    ...definition("speech", "route.speech", { apply: () => { applied = true; } }),
    missingCapabilities: ["speech.runtime"]
  }]);

  assert.equal(applied, false);
  assert.equal(runtime.catalog.get("manager:speech")?.status, "waiting_dependency");
  assert.deepEqual(runtime.catalog.get("manager:speech")?.missingCapabilities, ["speech.runtime"]);
  assert.deepEqual(runtime.contributions.catalog().contributions, []);
  await runtime.plugins.get("manager:speech")?.unmount();
  assert.equal(runtime.catalog.get("manager:speech")?.status, "waiting_dependency");

  await runtime.unmount();
  await host.dispose();
});

test("Manager Plugin Runtime unmount clears its services and preserves sibling Fibers", async () => {
  const host = new RabiCordisHost();
  let siblingActive = 0;
  await host.mount({
    name: "test:manager-runtime-sibling",
    apply(ctx) {
      ctx.effect(() => {
        siblingActive += 1;
        return () => { siblingActive -= 1; };
      });
    }
  });
  const runtime = await mountManagerPluginRuntime(host, [definition("settings", "route.settings")]);

  await runtime.unmount();
  assert.equal(siblingActive, 1);
  assert.deepEqual(runtime.catalog.snapshot().plugins, []);
  assert.deepEqual(runtime.contributions.catalog().contributions, []);

  await host.dispose();
  assert.equal(siblingActive, 0);
});
