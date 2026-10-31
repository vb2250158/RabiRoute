import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createRabiManagerPluginHostApi } from "./managerPluginPackageHost.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import type { ApiOperationDefinition, ApiUpgradeDefinition } from "./apiOperationContract.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("host operation cleanup failure still joins original upgrade listener and tracked work", async t => {
  const releaseListener = deferred(), releaseTask = deferred(), entered = deferred();
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const failure = new Error("controlled registration cleanup failure");
  let operationStops = 0, upgradeStops = 0, listenerClosed = false;
  class Registry extends ManagerPluginRouteRegistry {
    override registerOperations(id: string, definitions: readonly ApiOperationDefinition[]) {
      const original = super.registerOperations(id, definitions);
      return { ...original, async dispose() { operationStops++; await original.dispose(); throw failure; } };
    }
    override registerUpgrades(id: string, definitions: readonly ApiUpgradeDefinition[]) {
      const original = super.registerUpgrades(id, definitions);
      return { ...original, async dispose() {
        upgradeStops++; entered.resolve(); await original.dispose(); await releaseListener.promise;
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); listenerClosed = true;
      } };
    }
  }
  const host = createRabiManagerPluginHostApi({ instanceId: "manager:host-cleanup", routes: new Registry(), publishManagerEvent() {} });
  host.registerOperations([]); host.registerUpgrades([]);
  const task = host.track(releaseTask.promise);
  let settled = false;
  const stopping = host.stop();
  const observed = stopping.then(() => { settled = true; assert.fail("cleanup must report the original error"); }, error => { settled = true; assert.equal(error, failure); });
  t.after(async () => { releaseListener.resolve(); releaseTask.resolve(); await observed; if (listener.listening) listener.close(); });
  assert.equal(host.stop(), stopping);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(upgradeStops, 0, "accepted work retains its existing transport");
  releaseTask.resolve(); await task;
  await entered.promise;
  assert.equal(settled, false); assert.equal(listener.listening, true);
  releaseListener.resolve();
  await once(listener, "close");
  await observed;
  assert.deepEqual({ operationStops, upgradeStops, listenerClosed }, { operationStops: 1, upgradeStops: 1, listenerClosed: true });
  assert.equal(host.stop(), stopping);
  await assert.rejects(host.stop(), error => error === failure);
});

test("explicit registration release and host retirement share the same failed cleanup", async () => {
  const release = deferred(), entered = deferred();
  let stops = 0;
  class Registry extends ManagerPluginRouteRegistry {
    override registerOperations(id: string, definitions: readonly ApiOperationDefinition[]) {
      const original = super.registerOperations(id, definitions);
      return { ...original, async dispose() { stops++; entered.resolve(); await release.promise; await original.dispose(); throw undefined; } };
    }
  }
  const host = createRabiManagerPluginHostApi({ instanceId: "manager:host-explicit-cleanup", routes: new Registry(), publishManagerEvent() {} });
  const dispose = host.registerOperations([]), original = dispose();
  assert.equal(dispose(), original);
  const originalFailure = original.then(() => assert.fail("must reject"), error => assert.equal(error, undefined));
  await entered.promise;
  let settled = false;
  const stopping = host.stop();
  const stopped = stopping.then(() => assert.fail("must preserve original failure"), error => { settled = true; assert.equal(error, undefined); });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release.resolve(); await Promise.all([originalFailure, stopped]);
  assert.equal(stops, 1); assert.equal(host.stop(), stopping);
});
