import assert from "node:assert/strict";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { createNapcatManagerOwner, type NapcatManagerHostPorts } from "../plugins/io.rabiroute.endpoint.napcat/src/integrations/napcat/managerOwner.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { MessageEndpointManagers } from "./messageEndpointManagers.js";

test("an owner hook failure retires its real plugin component while healthy owner hooks keep running", async () => {
  const managers = new MessageEndpointManagers();
  const modules = new Map<PluginCandidate, PluginModule>();
  const events: string[] = [];
  const candidate = (id: string, broken: "reconcile" | "ready" | false): PluginCandidate => {
    const candidate: PluginCandidate = { instanceId: id, revision: String(broken), config: {}, entry: { execution: "in_process", path: "fixture" },
      manifest: { schemaVersion: 2, id: `io.test.${id}`, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [`endpoint.${id}@1`], requires: [], optional: [], permissions: [] } };
    modules.set(candidate, { activate(context) {
      context.services.provide(`endpoint.${id}@1`, {});
      const registration = managers.prepare(id, {
        async reconcileRoutes() { events.push(`${id}:reconcile`); if (broken === "reconcile") throw new Error("controlled reconcile failure"); },
        ready() { events.push(`${id}:ready`); if (broken === "ready") throw new Error("controlled ready failure"); }
      }, error => context.lifecycle.fail(error));
      context.effects.adopt(registration.dispose);
      context.publication.add(registration.publication);
    } });
    return candidate;
  };
  const kernel = new GenerationRuntime({ host: "manager", executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  try {
    const healthy = candidate("healthy", false);
    await kernel.switch([candidate("broken", "reconcile"), healthy]);
    await managers.reconcileRoutes([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(events.includes("healthy:reconcile"));
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === "broken")?.status, "failed");
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === "healthy")?.status, "active");
    await kernel.switch([candidate("broken", "ready"), healthy]);
    managers.ready();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(events.includes("healthy:ready"));
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === "broken")?.status, "failed");
    assert.match(managers.diagnostics()[0]?.message || "", /controlled ready failure/);
  } finally { await kernel.dispose(); }
});

test("unchanged invalid legacy QQ data cannot block an unrelated Webhook save; changed QQ bindings still validate", () => {
  const managers = new MessageEndpointManagers();
  const owner = createNapcatManagerOwner({} as NapcatManagerHostPorts);
  const registration = managers.prepare("napcat", { configurationKey: owner.configurationKey, validateRoutes: owner.validateRoutes }, () => {});
  registration.publication.publish();
  const old: GatewayDefinition = { id: "old-qq", gatewayPort: 8790, messageAdapters: ["napcat"], napcatInstances: [
    { id: "one", gatewayPort: 8791, httpUrl: "http://127.0.0.1:3001" },
    { id: "two", gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002" }
  ] };
  const webhook: GatewayDefinition = { id: "new-webhook", gatewayPort: 8800, messageAdapters: ["webhook"] };
  assert.doesNotThrow(() => managers.validateRoutes([structuredClone(old), webhook], [old]));
  assert.throws(() => managers.validateRoutes([{ ...old, gatewayPort: 8799 }, webhook], [old]), /QQ|NapCat|路由/);
  assert.throws(() => managers.validateRoutes([old]), /QQ|NapCat|路由/, "An explicit full validation still enforces the transaction invariant.");
});

test("current owner lookup follows publication and rollback without changing shared resource ownership", () => {
  const managers = new MessageEndpointManagers();
  const resources = {};
  const first = { resources }, second = { resources };
  const old = managers.prepare("napcat", first, () => {}), next = managers.prepare("napcat", second, () => {});
  assert.equal(managers.current("napcat"), undefined);
  old.publication.publish(); assert.equal(managers.current("napcat"), first);
  next.publication.publish(); assert.equal(managers.current("napcat"), second);
  next.publication.rollback(); assert.equal(managers.current("napcat"), first);
  next.dispose(); assert.equal(managers.current("napcat"), first);
  old.dispose(); assert.equal(managers.current("napcat"), undefined);
});
