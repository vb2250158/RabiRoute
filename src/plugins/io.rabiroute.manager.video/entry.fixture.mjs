import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Tests run from the application repository root, as does canonicalPluginSourceFixture.
// Only the public build helper and current compiled Host owners are used here.
const applicationRoot = process.cwd();
export function importVideoHostTestModule(id) {
  return import(pathToFileURL(path.join(applicationRoot, "dist", id + ".js")).href);
}

export async function prepareVideoEntryFixture(t, { rootDir, runtimeFor, onOperations } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "video-owned-entry-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = fileURLToPath(new URL(".", import.meta.url));
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    if (!item.isFile() || item.name.endsWith(".test.mjs") || item.name.endsWith(".fixture.mjs")) continue;
    await fs.copyFile(path.join(source, item.name), path.join(directory, item.name));
  }
  const { bundleMessageEndpointRuntime } = await import(pathToFileURL(path.join(applicationRoot, "scripts/build-message-endpoint-runtime.mjs")).href);
  const specification = JSON.parse(await fs.readFile(path.join(source, "manager-runtime.build.json"), "utf8"));
  await bundleMessageEndpointRuntime(applicationRoot, specification, path.join(directory, "manager-runtime.actual.mjs"));
  // Like observePackagedAgentRuntimeFixture, instrument only this private package.
  // Original owned factories still construct each runtime and operation definition.
  await fs.writeFile(path.join(directory, "manager-runtime.mjs"), `
import { createImplementation as original, hostModules } from "./manager-runtime.actual.mjs";
export { hostModules };
let hooks;
export function configureTestHooks(value) { hooks = value; }
export function createImplementation(ports) {
  const implementation = original(ports);
  return { ...implementation, createOwnedRuntime(shared) {
    const owned = implementation.createOwnedRuntime(shared);
    return { ...owned,
      createRuntime(identity) {
        const runtime = owned.createRuntime(identity);
        return { ...runtime, ...hooks.runtimeFor?.(identity) };
      },
      createOperations(context) { hooks.onOperations?.(context); return owned.createOperations(context); }
    };
  } };
}
`);
  // Private relocation preserves the canonical SDK module rather than copying it.
  const entryFile = path.join(directory, "manager.mjs");
  const entry = await fs.readFile(entryFile, "utf8");
  assert.equal(entry.split('"@rabiroute/plugin-sdk"').length, 2);
  await fs.writeFile(entryFile, entry.replace('"@rabiroute/plugin-sdk"', JSON.stringify(import.meta.resolve("@rabiroute/plugin-sdk"))));
  const instrumentation = await import(pathToFileURL(path.join(directory, "manager-runtime.mjs")).href);
  instrumentation.configureTestHooks({ runtimeFor, onOperations });
  const { createMessageEndpointHostPorts } = await importVideoHostTestModule("runtime/messageEndpointHostPorts");
  const ports = await createMessageEndpointHostPorts();
  const shared = Object.freeze({ ...ports, rootDir,
    managerPluginProcessLeases: { launch() { throw new Error("Video fixture forbids native process launch"); }, terminate() { throw new Error("Video fixture has no native lease to terminate"); } },
    managerReadOnly: false, activePeerTunnel: null
  });
  const { activate } = await import(pathToFileURL(entryFile).href);
  return { activate, shared, directory };
}
