import assert from "node:assert/strict";
import test from "node:test";
import { canonicalManagerPluginFixture } from "../manager/canonicalManagerPlugin.fixture.js";
import type { PluginEffectStarter, PluginEffectDisposer } from "./types.js";

for (const name of ["desktop-pet", "yeyu-gamer"]) {
  for (const mode of ["successful", "cancelled", "cancelled with failed cleanup"]) test(`${name} owns resources across ${mode} async registration`, async () => {
    const cancelled = mode !== "successful", cleanupFails = mode === "cancelled with failed cleanup";
    let stops = 0, registrations = 0, retired = 0;
    const effects: PluginEffectStarter[] = [];
    const adopted: PluginEffectDisposer[] = [];
    const controller = new AbortController();
    const stop = async () => { stops++; if (cleanupFails) throw new Error("fixture owner cleanup failed"); };
    const owner = { operations: [], stop };
    const host = {
      DesktopPetOwner: class { stop = stop; },
      createDesktopPetOperations: () => [],
      createYeYuGamerManagerOperations: () => owner,
      managerPluginRoutes: { async registerOperationsAsync(instance: string, definitions: unknown, signal: AbortSignal) {
        assert.equal(instance, `manager:${name}`); assert.equal(signal, controller.signal);
        assert.ok(Array.isArray(definitions));
        registrations++;
        await new Promise<void>(resolve => setImmediate(resolve));
        if (cancelled) controller.abort(new Error("fixture async registration cancelled"));
        signal.throwIfAborted();
        return { async dispose() { retired++; } };
      } }
    };
    const fixture = await canonicalManagerPluginFixture(name, host);
    await fixture.module.activate({ identity: { instanceId: `manager:${name}`, pluginId: fixture.manifest.id, version: fixture.manifest.version,
      applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", activationId: "fixture-activation", revision: "fixture", host: "manager" }, config: {},
      lifecycle: { signal: controller.signal, fail(error) { throw error; } },
      services: { require<T>(capability: string) { assert.equal(capability, `host.manager.${name}@2`); return fixture.ports as T; }, optional() { return undefined; }, provide() {} },
      contributions: { register() {} }, permissions: { has: () => true, require() {}, list: () => [] }, publication: { add() {} },
      effects: { add: starter => { effects.push(starter); }, adopt: dispose => { adopted.push(dispose); } } });
    assert.equal(stops, 0);
    const starting = Promise.resolve(effects[0]!());
    if (cancelled) await assert.rejects(starting, cleanupFails ? /fixture owner cleanup failed/ : /fixture async registration cancelled/);
    else { const dispose = await starting; assert.equal(stops, 0); await dispose(); }
    assert.equal(adopted.length, 1);
    if (cleanupFails) {
      assert.equal(adopted[0]!(), adopted[0]!(), "Retirement must retain the original cleanup failure without stopping twice.");
      await assert.rejects(Promise.resolve(adopted[0]!()), /fixture owner cleanup failed/);
    } else await adopted[0]!();
    assert.equal(registrations, 1);
    assert.equal(stops, 1);
    assert.equal(retired, cancelled ? 0 : 1);
  });
}
