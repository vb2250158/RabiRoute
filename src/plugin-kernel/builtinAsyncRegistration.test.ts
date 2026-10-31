import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

for (const name of ["desktop-pet", "yeyu-gamer"]) {
  for (const mode of ["successful", "cancelled", "cancelled with failed cleanup"]) test(`${name} owns resources across ${mode} async registration`, async () => {
    const cancelled = mode !== "successful", cleanupFails = mode === "cancelled with failed cleanup";
    let stops = 0, registrations = 0, retired = 0;
    const effects: Array<() => Promise<() => Promise<void>>> = [];
    const adopted: Array<() => Promise<void>> = [];
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
    const module = await import(pathToFileURL(path.resolve(`plugins/builtin/io.rabiroute.manager.${name}/1.0.0/manager.mjs`)).href);
    await module.activate({ identity: { instanceId: `manager:${name}` }, config: {}, lifecycle: { signal: controller.signal },
      services: { require: () => host, provide() {} }, contributions: { register() {} },
      effects: { add: (starter: typeof effects[number]) => effects.push(starter), adopt: (dispose: () => Promise<void>) => adopted.push(dispose) } });
    assert.equal(stops, 0);
    const starting = effects[0]!();
    if (cancelled) await assert.rejects(starting, cleanupFails ? /fixture owner cleanup failed/ : /fixture async registration cancelled/);
    else { const dispose = await starting; assert.equal(stops, 0); await dispose(); }
    assert.equal(adopted.length, 1);
    if (cleanupFails) {
      assert.equal(adopted[0]!(), adopted[0]!(), "Retirement must retain the original cleanup failure without stopping twice.");
      await assert.rejects(adopted[0]!(), /fixture owner cleanup failed/);
    } else await adopted[0]!();
    assert.equal(registrations, 1);
    assert.equal(stops, 1);
    assert.equal(retired, cancelled ? 0 : 1);
  });
}
