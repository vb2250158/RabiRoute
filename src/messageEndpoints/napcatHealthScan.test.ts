import assert from "node:assert/strict";
import test from "node:test";
import { scanNapcatHealthReadOnly } from "./napcatHealthScan.js";

type Instance = {
  id: string;
  enabled?: boolean;
  webuiUrl?: string;
  gatewayPort?: number;
};

type Runtime = {
  id: string;
  instances: Instance[];
};

test("NapCat health scan is concurrent, bounded, and preserves partial instance results", async () => {
  const starts: string[] = [];
  const runtimes: Runtime[] = [
    { id: "route-a", instances: [{ id: "ready", webuiUrl: "http://127.0.0.1:6101/webui" }] },
    { id: "route-b", instances: [{ id: "stalled", webuiUrl: "http://127.0.0.1:6102/webui" }] }
  ];

  const startedAt = Date.now();
  const result = await scanNapcatHealthReadOnly({
    runtimes,
    gatewayId: (runtime) => runtime.id,
    instances: (runtime) => runtime.instances,
    instanceId: (instance) => instance.id,
    instanceEnabled: (instance) => instance.enabled !== false,
    instanceMetadata: (instance) => ({
      webui: { url: instance.webuiUrl },
      gatewayPort: instance.gatewayPort
    }),
    testHealth: async (_runtime, instance) => {
      starts.push(instance.id);
      if (instance.id === "stalled") {
        return new Promise<Record<string, unknown>>(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        ok: true,
        http: { ok: true, online: true, good: true },
        webui: { reachable: false, url: instance.webuiUrl }
      };
    }
  }, { deadlineMs: 45 });

  assert.deepEqual(starts.sort(), ["ready", "stalled"]);
  assert.equal(result.payload["route-a"].instances.ready.ok, true);
  assert.equal(result.payload["route-a"].instances.ready.enabled, true);
  assert.equal(result.payload["route-a"].instances.ready.scanState, "ok");
  assert.equal(result.payload["route-b"].instances.stalled.ok, false);
  assert.equal(result.payload["route-b"].instances.stalled.state, "scan-timeout");
  assert.equal(result.payload["route-b"].instances.stalled.scanState, "timeout");
  assert.equal(result.partial, true);
  assert.ok(Date.now() - startedAt < 250);
});

test("NapCat health scan skips disabled instances without probing or launching them", async () => {
  let probes = 0;
  const result = await scanNapcatHealthReadOnly({
    runtimes: [{ id: "route", instances: [{ id: "disabled", enabled: false }] }],
    gatewayId: (runtime) => runtime.id,
    instances: (runtime) => runtime.instances,
    instanceId: (instance) => instance.id,
    instanceEnabled: (instance) => instance.enabled !== false,
    instanceMetadata: () => ({}),
    testHealth: async () => {
      probes += 1;
      return { ok: true };
    }
  }, { deadlineMs: 40 });

  assert.equal(probes, 0);
  assert.equal(result.payload.route.instances.disabled.state, "disabled");
  assert.equal(result.payload.route.instances.disabled.scanState, "skipped");
  assert.equal(result.payload.route.instances.disabled.enabled, false);
});
