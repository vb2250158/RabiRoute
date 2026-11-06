import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { declareAsyncPluginService, declareScopedAsyncPluginService } from "./asyncServiceTransport.js";
// @ts-expect-error contractFor is an internal wire validator, outside the public bridge declaration API.
import { contractFor } from "./bridge/protocol.mjs";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/profile.js";
import { ProtocolSelectingIsolatedExecutor } from "./protocolSelectingExecutor.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";

test("async owner and bridge contracts reject the original reserved method names without invoking factories", () => {
  for (const method of ["__proto__", "constructor", "prototype", "then"]) {
    const service = Object.create(null);
    Object.defineProperty(service, method, { value: async () => "never invoked" });
    assert.throws(() => declareAsyncPluginService(service, [method]), /Invalid async plugin service transport methods/);
    assert.throws(() => declareScopedAsyncPluginService([method], {}, () => { assert.fail("invalid method must not enter the factory"); }), /Invalid async plugin service transport methods/);
    assert.throws(() => contractFor({ "fixture.service@1": { kind: "async-methods", methods: [method] } }, "fixture.service@1"), /Invalid asynchronous methods/);
  }
  const service = { async toString() { return "valid original method"; } };
  assert.equal(declareAsyncPluginService(service, ["toString"]), service);
  assert.equal(contractFor({ "fixture.service@1": { kind: "async-methods", methods: ["toString"] } }, "fixture.service@1").kind, "async-methods");
});

test("normal immutable package preparation rejects reserved async names before any child activation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "async-method-safety-"));
  const packages = path.join(root, "packages"), catalog = new PluginPackageCatalog([packages]), leases = new ProcessLeaseRegistry();
  let activations = 0;
  const executor = new ProtocolSelectingIsolatedExecutor(leases, { async prepare() { return { activate() { activations++; } }; } });
  const kernel = new GenerationRuntime({ host: "manager", executor });
  t.after(async () => { await kernel.shutdown(); await catalog.dispose(); await leases.disposeAll(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [index, method] of ["__proto__", "constructor", "prototype", "then"].entries()) {
    const packageId = `io.test.async-safety-${index}`, directory = path.join(packages, packageId, "1.0.0");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: packageId, version: "1.0.0",
      entries: { manager: { execution: "isolated", module: "./manager.mjs" } }, provides: ["fixture.service@1"], requires: [], optional: [], permissions: [] }));
    await fs.writeFile(path.join(directory, "manager.mjs"), "export function activate() { throw new Error('Invalid contracts cannot activate'); }\n");
    await fs.writeFile(path.join(directory, "rabi.async-services.json"), JSON.stringify({ schemaVersion: 1, provides: { "fixture.service@1": { kind: "async-methods", methods: [method] } } }));
    const profilePath = path.join(root, "profile.json");
    await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "fixture:owner", package: packageId, version: "1.0.0", enabled: true }] }));
    const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "runtime"), host: "manager" });
    assert.deepEqual(loaded.loadFailures, []);
    const result = await kernel.switch(loaded.candidates);
    assert.equal(result.generation.records[0]?.status, "failed");
    assert.match(result.generation.records[0]?.error?.message ?? "", /Invalid provided async transport/);
    assert.equal(activations, 0);
    assert.equal(leases.list().length, 0);
  }
});
