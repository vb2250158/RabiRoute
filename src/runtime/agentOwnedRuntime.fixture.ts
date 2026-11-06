import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Observe the actual packaged factory/disposer without changing its owned implementation or Host ports. */
export async function observePackagedAgentRuntimeFixture(directory: string) {
  const source = path.join(directory, "runtime.mjs"), original = path.join(directory, "runtime-fixture-original.mjs");
  await fs.rename(source, original);
  const key = `__rabi_owned_runtime_fixture_${randomUUID()}`;
  const counts = { constructed: 0, disposed: 0 };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = counts;
  await fs.writeFile(source, `import { createImplementation as original, hostModules } from "./runtime-fixture-original.mjs";
export { hostModules };
export function createImplementation(host) {
  const implementation = original(host), counts = globalThis[${JSON.stringify(key)}];
  return { ...implementation, createAgentOperations() {
    counts.constructed++;
    const owned = implementation.createAgentOperations();
    return { ...owned, dispose() { counts.disposed++; return owned.dispose?.(); } };
  } };
}
`);
  return { counts, release() { delete globals[key]; } };
}
