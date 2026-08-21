import assert from "node:assert/strict";
import test from "node:test";
import { RabiCordisHost } from "./cordisHost.js";
import { mountManagerPluginRuntime } from "./managerPluginRuntime.js";
import { createProcessManagerPluginDefinition } from "./processManagerPlugin.js";
import type { ProcessPluginHostSnapshot } from "./processPluginHost.js";

const manifest = {
  id: "process:manager/example",
  name: "Example process plugin",
  version: "1.0.0",
  kind: "external-process" as const,
  hosts: ["manager", "web"] as const,
  capabilities: ["ui.contributions"]
};

function activeSnapshot(): ProcessPluginHostSnapshot {
  return {
    state: "active",
    instanceId: "manager:process-example",
    manifest,
    grantedCapabilities: ["ui.contributions"],
    contributions: [{
      kind: "page",
      id: "example-page",
      label: { fallback: "Example" },
      routeId: "process.example",
      rendererId: "builtin.web-page.docs.v1",
      hosts: ["web"],
      surface: "web.pages",
      slot: "route"
    }]
  };
}

test("process Manager plugin registers contributions and stops with its Cordis Fiber", async () => {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  let starts = 0;
  let stops = 0;
  const definition = createProcessManagerPluginDefinition({
    instanceId: "manager:process-example",
    manifest,
    controller: {
      async start() { starts += 1; return activeSnapshot(); },
      async stop() { stops += 1; }
    }
  });

  const mounted = await runtime.mount(definition);
  assert.equal(starts, 1);
  assert.equal(runtime.catalog.get(definition.instanceId)?.status, "active");
  assert.equal(runtime.contributions.catalog("web").contributions.some(item => item.id === "example-page"), true);

  await mounted.unmount();
  assert.equal(stops, 1);
  assert.deepEqual(runtime.contributions.catalog("web").contributions, []);
  await runtime.unmount();
  await host.dispose();
});

test("process Manager plugin stops the process when contribution activation fails", async () => {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  let stops = 0;
  const definition = createProcessManagerPluginDefinition({
    instanceId: "manager:process-example",
    manifest,
    controller: {
      async start() {
        const snapshot = activeSnapshot();
        return {
          ...snapshot,
          contributions: [snapshot.contributions[0], snapshot.contributions[0]]
        };
      },
      async stop() { stops += 1; }
    }
  });

  await assert.rejects(runtime.mount(definition), /Contribution already registered/);
  assert.equal(stops, 1);
  assert.equal(runtime.catalog.get(definition.instanceId)?.status, "failed");
  await runtime.unmount();
  await host.dispose();
});

test("process Manager plugin rejects a manifest changed after discovery", async () => {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  let stops = 0;
  const definition = createProcessManagerPluginDefinition({
    instanceId: "manager:process-example",
    manifest,
    controller: {
      async start() {
        return { ...activeSnapshot(), manifest: { ...manifest, version: "2.0.0" } };
      },
      async stop() { stops += 1; }
    }
  });

  await assert.rejects(runtime.mount(definition), /manifest changed/);
  assert.equal(stops, 1);
  await runtime.unmount();
  await host.dispose();
});
