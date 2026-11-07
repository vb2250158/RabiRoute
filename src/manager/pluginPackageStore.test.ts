import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { PluginPackageStore } from "./pluginPackageStore.js";

test("local package import preserves immutable versions and isolates a broken package listing", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), managed = path.join(root, "packages");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.import", version: "0.1.1",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export async function activate() {}\n");
  const owner = new PluginPackageStore({ roots: [managed], managedRoot: managed, importRuntimeRoot: path.join(root, "imports") });
  await owner.importDirectory(source, () => {});
  await owner.importDirectory(source, () => {});
  assert.equal((await owner.list())[0]?.pluginId, "io.test.import");
  assert.equal((await owner.list())[0]?.source, "local");
  await fs.mkdir(path.join(managed, "io.test.broken", "0.1.1"), { recursive: true });
  await fs.writeFile(path.join(managed, "io.test.broken", "0.1.1", "rabi.plugin.json"), "{broken");
  assert.equal((await owner.list()).length, 1);
  await fs.writeFile(path.join(source, "manager.mjs"), "export async function activate() { throw Error('changed'); }\n");
  await assert.rejects(owner.importDirectory(source, () => {}), error => {
    assert.equal((error as { status?: number }).status, 409); assert.equal((error as { code?: string }).code, 'PLUGIN_PACKAGE_VERSION_CONFLICT');
    assert.match((error as Error).message, /different bytes/); return true;
  });
  assert.equal(await fs.readFile(path.join(managed, "io.test.import", "0.1.1", "manager.mjs"), "utf8"), "export async function activate() {}\n");
  assert.deepEqual(await fs.readdir(path.join(root, "imports")), []);
});

test('import identity drift has its original conflict status and does not publish another package', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-import-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), managed = path.join(root, 'packages'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'rabi.plugin.json'), JSON.stringify({ schemaVersion: 2, id: 'io.test.actual', version: '0.1.1',
    entries: { manager: { execution: 'in_process', module: './manager.mjs' } }, provides: [], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(source, 'manager.mjs'), 'export function activate() {}');
  const owner = new PluginPackageStore({ roots: [managed], managedRoot: managed, importRuntimeRoot: path.join(root, 'imports') });
  await assert.rejects(owner.importDirectory(source, () => {}, { id: 'io.test.original', version: '0.1.1' }), error => {
    assert.equal((error as { status?: number }).status, 409); assert.equal((error as { code?: string }).code, 'PLUGIN_PACKAGE_IDENTITY_CHANGED'); return true;
  });
  assert.deepEqual(await owner.list(), []); assert.deepEqual(await fs.readdir(path.join(root, 'imports')), []);
});
