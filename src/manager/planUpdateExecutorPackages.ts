import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginPackageFile, verifyRuntimePackage } from "../plugin-kernel/packageLoader.js";
import type { PlanUpdateExecutorLease, PlanUpdateExecutorPin } from "./planUpdateExecutor.js";
import { parsePlanUpdateExecutorPin } from "./planUpdateExecutor.js";

type RestoredExecutor = Readonly<{ pin: PlanUpdateExecutorPin; entryUrl: string }>;

/** Original immutable package snapshots survive instance removal and Manager generations. */
export function createPlanUpdateExecutorRestorer(runtimeRoot: string): (pin: PlanUpdateExecutorPin) => Promise<PlanUpdateExecutorLease> {
  const root = path.resolve(runtimeRoot);
  const verified = new Map<string, Promise<RestoredExecutor>>();
  return async pin => {
    const reference = parsePlanUpdateExecutorPin(pin);
    const key = JSON.stringify(reference);
    let ready = verified.get(key);
    if (!ready) {
      ready = (async (): Promise<RestoredExecutor> => {
        const snapshot = path.join(root, encodeURIComponent(reference.pluginId), reference.version, reference.revision);
        await verifyRuntimePackage(snapshot, {
          id: reference.pluginId, version: reference.version, revision: reference.revision
        }, "manager");
        const entry = await resolvePluginPackageFile(snapshot, reference.entryPath);
        return Object.freeze({ pin: reference, entryUrl: pathToFileURL(entry).href });
      })();
      verified.set(key, ready);
      void ready.catch(() => { if (verified.get(key) === ready) verified.delete(key); });
    }
    const restored = await ready;
    return Object.freeze({
      ...restored,
      async run<T>(operation: () => T | Promise<T>): Promise<T> { return operation(); },
      // The original store retains this snapshot after its activation retires.
      release(): void {}
    });
  };
}
