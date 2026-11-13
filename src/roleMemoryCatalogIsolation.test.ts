import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute } from './manager/managerReadWorkerTasks.js';
import { readRoleMemoryCatalogDiagnostics, readRoleKnowledgeCatalogSnapshot, publishRoleKnowledgeCatalogSnapshot, invalidateRoleMemoryCatalogForMutation, publishedRoleKnowledgeCatalogSnapshot } from './roleKnowledge.js';
import { readKnowledgeStorageDelta } from './manager/knowledgeSearchStorage.js';

test('a bad memory title is isolated consistently by overview, catalog, page and knowledge index',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-local-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'memory/recent');fs.mkdirSync(dir,{recursive:true});
 const healthy={id:'good',title:'Healthy',content:'Keep this memory',keywords:['healthy'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
 fs.writeFileSync(path.join(dir,'good.json'),JSON.stringify(healthy));const bad=path.join(dir,'bad.json');fs.writeFileSync(bad,JSON.stringify({...healthy,id:'bad',title:{toString:null}}));const before=fs.readFileSync(bad);
 const overview:any=await execute({type:'role_memory_overview',roleDir:root});
 assert.deepEqual(overview.recent.map((x:any)=>x.id),['good']);assert.equal(overview.partial,true);assert.equal(overview.issues[0].file,'bad.json');assert.equal(overview.issues[0].kind,'recent');
 const catalog:any=await execute({type:'role_memory_catalog',roleDir:root,kind:'recent'});assert.deepEqual(catalog.map((x:any)=>x.id),['good']);
 const page:any=await execute({type:'role_memory_page',roleDir:root,kind:'recent',limit:20,cursor:'',query:''});assert.deepEqual(page.items.map((x:any)=>x.id),['good']);
 const delta=readKnowledgeStorageDelta(root,{});assert.equal(delta.errors,1);assert.equal(delta.changes[0].item.id,'good');
 assert.deepEqual(fs.readFileSync(bad),before);assert.equal(readRoleMemoryCatalogDiagnostics(root).length,1);
 const warm:any=await execute({type:'role_memory_overview',roleDir:root});assert.equal(warm.issues.length,1,'warm cache retains diagnostics from the same read');
 publishRoleKnowledgeCatalogSnapshot(root,readRoleKnowledgeCatalogSnapshot(root));
 assert.equal(readRoleMemoryCatalogDiagnostics(root).length,1,'publishing healthy summaries cannot claim a known bad physical row disappeared');
});

test('a memory-directory read failure retains its own last snapshot and reports the failed source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-root-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const kind of ['recent', 'consolidated']) {
    const directory = path.join(root, 'memory', kind);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'good.json'), JSON.stringify({
      id: kind, title: kind, content: 'Healthy memory', keywords: ['healthy']
    }));
  }
  const warm: any = await execute({ type: 'role_memory_overview', roleDir: root });
  assert.equal(warm.recent.length, 1);
  assert.equal(warm.consolidated.length, 1);
  const directory = path.join(root, 'memory/recent');
  const before = fs.readFileSync(path.join(directory, 'good.json'));
  const readdir = fs.readdirSync;
  let code = 'EACCES';
  let failed = false;
  t.mock.method(fs, 'readdirSync', ((target: any, ...args: any[]) => {
    if (failed && path.resolve(String(target)) === path.resolve(directory)) {
      throw Object.assign(Error('fixture unavailable directory'), { code });
    }
    return (readdir as any)(target, ...args);
  }) as typeof fs.readdirSync);
  for (const next of ['EACCES', 'EIO']) {
    code = next;
    failed = true;
    invalidateRoleMemoryCatalogForMutation(root);
    const overview: any = await execute({ type: 'role_memory_overview', roleDir: root });
    assert.equal(overview.recent[0].id, 'recent');
    assert.equal(overview.consolidated[0].id, 'consolidated');
    assert.equal(overview.partial, true);
    assert.ok(overview.issues.some((issue: any) => issue.kind === 'recent' && issue.file === '.' && issue.message === next));
    assert.equal(publishedRoleKnowledgeCatalogSnapshot(root), undefined);
  }
  failed = false;
  invalidateRoleMemoryCatalogForMutation(root);
  const recovered: any = await execute({ type: 'role_memory_overview', roleDir: root });
  assert.equal(recovered.recent.length, 1);
  assert.equal(recovered.partial, false);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'good.json')), before);
});

test('a genuinely absent memory directory is an empty collection without a read-failure diagnostic', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-root-absent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const overview: any = await execute({ type: 'role_memory_overview', roleDir: root });
  assert.equal(overview.recent.length, 0);
  assert.equal(overview.consolidated.length, 0);
  assert.equal(overview.partial, false);
  assert.deepEqual(overview.issues, []);
});
