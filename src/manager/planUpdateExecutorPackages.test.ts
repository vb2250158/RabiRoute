import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPluginPackage } from "../plugin-kernel/packageLoader.js";
import { createPlanUpdateExecutorRestorer } from "./planUpdateExecutorPackages.js";
import type { PlanUpdateExecutorPin } from "./planUpdateExecutor.js";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "plan-executor-package-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const runtime = path.join(directory, "runtime");
  await fs.mkdir(path.join(source, "worker"), { recursive: true });
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2, id: "fixture.plan", version: "0.1.1", displayName: "Fixture plan executor",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export async function activate() {}\n");
  await fs.writeFile(path.join(source, "worker", "plan-update.mjs"), "export const marker = 'A';\n");
  const loaded = await loadPluginPackage(source, runtime, "manager");
  const pin: PlanUpdateExecutorPin = {
    pluginId: loaded.manifest.id, version: loaded.manifest.version,
    revision: loaded.revision, entryPath: "worker/plan-update.mjs"
  };
  return { source, runtime, loaded, pin };
}

test("a cold restorer reopens the exact retired package after its ordinary source disappears", async t => {
  const f = await fixture(t);
  await fs.rm(f.source, { recursive: true, force: true });
  const restored = await createPlanUpdateExecutorRestorer(f.runtime)(f.pin);
  assert.deepEqual(restored.pin, f.pin);
  const module = await restored.run(() => import(restored.entryUrl));
  assert.equal(module.marker, "A");
  restored.release();
  assert.equal(await fs.readFile(path.join(f.loaded.runtimeRoot, "worker/plan-update.mjs"), "utf8"), "export const marker = 'A';\n");
});

test("one failed retained package does not poison other retained versions or remain failure-cached", async t => {
  const f = await fixture(t);
  const restore = createPlanUpdateExecutorRestorer(f.runtime);
  await assert.rejects(restore({ ...f.pin, revision: "0".repeat(64) }));
  const entry = path.join(f.loaded.runtimeRoot, "worker/plan-update.mjs");
  const original = await fs.readFile(entry);
  await fs.writeFile(entry, "export const marker = 'damaged';\n");
  await assert.rejects(restore(f.pin), /integrity verification/);
  await fs.writeFile(entry, original);
  const accepted = await restore(f.pin);
  assert.equal((await import(accepted.entryUrl)).marker, "A");
  accepted.release();
});

test("retained references cannot redirect the worker outside its recorded package", async t => {
  const f = await fixture(t);
  const restore = createPlanUpdateExecutorRestorer(f.runtime);
  await assert.rejects(restore({ ...f.pin, version: "../elsewhere" }), /reference is invalid/);
  await assert.rejects(restore({ ...f.pin, entryPath: "../manager.mjs" } as unknown as PlanUpdateExecutorPin), /reference is invalid/);
  const [first, second] = await Promise.all([restore(f.pin), restore(f.pin)]);
  assert.equal(first.entryUrl, second.entryUrl);
  assert.ok(Object.isFrozen(first.pin));
  first.release(); second.release();
});
