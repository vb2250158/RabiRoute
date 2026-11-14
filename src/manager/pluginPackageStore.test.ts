import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { PluginPackageStore } from "./pluginPackageStore.js";

test('one regular-file root preserves healthy packages and returns per-query diagnostics in either order', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-partial-root-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const good=path.join(root,'good'),bad=path.join(root,'not-a-directory');await fs.writeFile(bad,'synthetic');
  const dir=path.join(good,'io.test.healthy','0.1.1');await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'rabi.plugin.json'),JSON.stringify({schemaVersion:2,id:'io.test.healthy',version:'0.1.1',entries:{manager:{execution:'in_process',module:'./manager.mjs'}},provides:[],requires:[],optional:[],permissions:[]}));
  for(const roots of [[bad,good],[good,bad]]) {
    const store=new PluginPackageStore({roots,managedRoot:good,importRuntimeRoot:path.join(root,'imports')});
    const [a,b]=await Promise.all([store.listResult(),store.listResult()]);
    for(const result of [a,b]){assert.equal(result.packages[0]?.pluginId,'io.test.healthy');assert.equal(result.partial,true);assert.equal(result.diagnostics.length,1);assert.equal(result.diagnostics[0].path,bad);assert.equal(result.diagnostics[0].code,'ENOTDIR');}
    assert.notEqual(a.diagnostics,b.diagnostics);assert.equal((await store.list()).length,1);
  }
  const store=new PluginPackageStore({roots:[bad,good],managedRoot:good,importRuntimeRoot:path.join(root,'imports')});
  const original=fs.readdir;
  let failureCode='EACCES';
  t.mock.method(fs,'readdir',((file:any,...args:any[])=>String(file)===bad?Promise.reject(Object.assign(Error('fixture root unavailable'),{code:failureCode})):(original as any)(file,...args)) as typeof fs.readdir);
  for(const code of ['EACCES','EIO']){failureCode=code;const result=await store.listResult();assert.equal(result.partial,true);assert.equal(result.packages[0]?.pluginId,'io.test.healthy');assert.equal(result.diagnostics[0].code,code);assert.equal(result.diagnostics[0].root,bad);}
});

test("local package import preserves immutable versions and isolates a broken package listing", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), managed = path.join(root, "packages");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.import", version: "0.1.1",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export async function activate() {}\n");
  const owner = new PluginPackageStore({ roots: [managed], managedRoot: managed, importRuntimeRoot: path.join(root, "imports") });
  const imported = await owner.importDirectory(source, () => {});
  assert.equal(imported.id, 'io.test.import'); assert.equal(imported.version, '0.1.1'); assert.match(imported.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await owner.importDirectory(source, () => {}), imported);
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
