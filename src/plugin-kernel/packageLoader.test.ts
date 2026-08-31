import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPluginPackage, loadPluginPackage } from "./packageLoader.js";

async function packageFixture(): Promise<{ root: string; runtime: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-plugin-package-"));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2,
    id: "io.test.tree-out",
    version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export function activate(context) { context.contributions.register({ kind: 'test', id: 'tree-out', value: true }); }\n");
  return { root: source, runtime };
}

test("loadPluginPackage resolves an immutable revision copy without importing plugin code", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  const first = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  assert.match(first.runtimeRoot, new RegExp(first.revision));
  assert.equal(first.execution, "in_process");
  assert.match(first.entryPath, /manager[.]mjs$/);
  assert.equal(await hashPluginPackage(first.runtimeRoot), first.revision);
  await fs.appendFile(path.join(fixture.root, "manager.mjs"), "// changed\n");
  const second = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.runtimeRoot, first.runtimeRoot);
});

test("loadPluginPackage rejects symlinked package content", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  const outside = path.join(path.dirname(fixture.root), "outside.mjs");
  await fs.writeFile(outside, "export function activate() {}\n");
  try {
    await fs.symlink(outside, path.join(fixture.root, "linked.mjs"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows developer mode or symlink privilege is unavailable.");
      return;
    }
    throw error;
  }
  await assert.rejects(loadPluginPackage(fixture.root, fixture.runtime, "manager"), /symlink or reparse point/);
});

test("loadPluginPackage never trusts a corrupted existing revision", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  const first = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  await fs.appendFile(first.entryPath, "// corrupted after publication\n");
  await assert.rejects(loadPluginPackage(fixture.root, fixture.runtime, "manager"), /failed integrity verification/);
});

test("loadPluginPackage never imports isolated entry top-level code", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  const marker = path.join(path.dirname(fixture.root), "imported.txt");
  await fs.writeFile(path.join(fixture.root, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2, id: "io.test.tree-out", version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  }));
  await fs.writeFile(path.join(fixture.root, "manager.mjs"), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}\n`);
  const loaded = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  assert.equal(loaded.execution, "isolated");
  await assert.rejects(fs.access(marker));
});

test("loadPluginPackage does not parse the removed hosts/entry manifest", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.root, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 1, id: "io.test.old", version: "1.0.0", hosts: ["manager"], entry: "./manager.mjs"
  }));
  await assert.rejects(loadPluginPackage(fixture.root, fixture.runtime, "manager"), /unsupported fields/);
});
