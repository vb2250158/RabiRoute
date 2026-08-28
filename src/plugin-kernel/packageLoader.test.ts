import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPluginPackage } from "./packageLoader.js";

async function packageFixture(): Promise<{ root: string; runtime: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-plugin-package-"));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "io.test.tree-out",
    version: "1.0.0",
    entries: { manager: "./manager.mjs" },
    provides: [], requires: [], optional: [], permissions: []
  }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export function activate(context) { context.contributions.register({ kind: 'test', id: 'tree-out', value: true }); }\n");
  return { root: source, runtime };
}

test("loadPluginPackage imports an immutable revision copy", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  const first = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  assert.match(first.runtimeRoot, new RegExp(first.revision));
  assert.equal(typeof first.module.activate, "function");
  await fs.appendFile(path.join(fixture.root, "manager.mjs"), "// changed\n");
  const second = await loadPluginPackage(fixture.root, fixture.runtime, "manager");
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.runtimeRoot, first.runtimeRoot);
});

test("loadPluginPackage does not parse the removed hosts/entry manifest", async t => {
  const fixture = await packageFixture();
  t.after(() => fs.rm(path.dirname(fixture.root), { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.root, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 1, id: "io.test.old", version: "1.0.0", hosts: ["manager"], entry: "./manager.mjs"
  }));
  await assert.rejects(loadPluginPackage(fixture.root, fixture.runtime, "manager"), /unsupported fields/);
});
