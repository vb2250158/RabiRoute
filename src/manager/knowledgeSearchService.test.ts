import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeSearchService } from "./knowledgeSearchService.js";
import { readKnowledgeStorageDelta, type KnowledgeStorageDelta } from "./knowledgeSearchStorage.js";
import { knowledgeReference, publishKnowledgeChange } from "../roleKnowledgeSearch.js";
import type { RecentMemoryItem } from "../roleKnowledge.js";

function item(id = "one"): RecentMemoryItem {
  return { id, title: id, focus: "Search test", content: "Test body", keywords: ["alpha"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-search-"));
  const directory = path.join(root, "memory", "recent");
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(directory, "one.json");
  const write = (value: RecentMemoryItem) => fs.writeFileSync(file, JSON.stringify(value));
  write(item());
  return { root, file, write };
}

function planFile(root: string, bucket: 'active' | 'archive', folder: string, id: string, keyword: string) {
  const file = path.join(root, 'plans', bucket, folder, 'plan.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, title: keyword, focus: keyword, keywords: [keyword],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
  return file;
}

test('duplicate plan identities isolate the whole conflict group and preserve healthy cold results without selecting a file', async t => {
  const { root } = fixture(t);
  const conflictFiles = [
    planFile(root, 'active', 'a', 'shared', 'conflict-first'),
    planFile(root, 'archive', 'b', 'shared', 'conflict-second'),
    planFile(root, 'active', 'c', 'shared', 'conflict-third')
  ];
  planFile(root, 'active', 'healthy', 'healthy-plan', 'healthy-plan-keyword');
  const raw = conflictFiles.map(file => fs.readFileSync(file));
  const cold = readKnowledgeStorageDelta(root, {});
  assert.equal(cold.errors, 1, 'one local error per ambiguous identity, not a whole-batch rejection');
  assert.equal(cold.changes.some(change => change.kind === 'plan' && change.item.id === 'shared'), false);
  assert.equal(Object.values(cold.inventory).filter(stamp => stamp.reference === knowledgeReference('plan', 'shared')).length, 3);
  const reads: number[] = [];
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => {
    const delta = readKnowledgeStorageDelta(dir, previous); reads.push(delta.filesRead); return delta;
  } });
  t.after(() => service.close()); await service.reload('Example', root);
  const index = service.ensure('Example', root);
  assert.equal(index.ready, true); assert.equal(index.search({ query: 'alpha' }).total, 1);
  assert.equal(index.search({ query: 'healthy-plan-keyword' }).total, 1);
  assert.equal(index.references().includes(knowledgeReference('plan', 'shared')), false);
  await service.reload('Example', root);
  assert.equal(reads.at(-1), 0, 'unchanged conflicts are detected from inventory without reparsing healthy or conflicting files');
  assert.equal((service.status(root) as { errors: number }).errors, 1);
  conflictFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), raw[i]));
  fs.unlinkSync(conflictFiles[1]); fs.unlinkSync(conflictFiles[2]);
  await service.reload('Example', root);
  assert.equal(reads.at(-1), 1, 'the surviving unique plan is rehydrated even though its file stamp is unchanged');
  assert.equal(index.search({ query: 'conflict-first' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 0);
});

test('hot duplicate plans retain the last unambiguous summary while healthy neighbors refresh and recover all unique identities', async t => {
  const { root, write } = fixture(t);
  const original = planFile(root, 'active', 'original', 'shared', 'last-unambiguous');
  const reads: number[] = [];
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => {
    const delta = readKnowledgeStorageDelta(dir, previous); reads.push(delta.filesRead); return delta;
  } });
  t.after(() => service.close()); await service.reload('Example', root);
  const index = service.ensure('Example', root);
  planFile(root, 'active', 'original', 'shared', 'ambiguous-update');
  const other = planFile(root, 'archive', 'other', 'shared', 'ambiguous-other');
  write({ ...item(), keywords: ['healthy-during-conflict'] });
  await service.reload('Example', root, true);
  assert.equal(index.search({ query: 'last-unambiguous' }).total, 1);
  assert.equal(index.search({ query: 'ambiguous-update' }).total, 0); assert.equal(index.search({ query: 'ambiguous-other' }).total, 0);
  assert.equal(index.search({ query: 'healthy-during-conflict' }).total, 1);
  const raw = [fs.readFileSync(original), fs.readFileSync(other)];
  await service.reload('Example', root); assert.equal(reads.at(-1), 0);
  assert.equal(index.search({ query: 'last-unambiguous' }).total, 1);
  assert.deepEqual(fs.readFileSync(original), raw[0]); assert.deepEqual(fs.readFileSync(other), raw[1]);
  planFile(root, 'archive', 'other', 'repaired-identity', 'repaired-other');
  await service.reload('Example', root);
  assert.equal(reads.at(-1), 2, 'changed repaired file and unchanged newly-unambiguous survivor are both read');
  assert.equal(index.search({ query: 'last-unambiguous' }).total, 0);
  assert.equal(index.search({ query: 'ambiguous-update' }).total, 1); assert.equal(index.search({ query: 'repaired-other' }).total, 1);
  assert.equal(index.search({ query: 'healthy-during-conflict' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 0);
});

test('conflict recovery preserves an identity held by another physical file and removes it only after the last file disappears', async t => {
  const { root } = fixture(t);
  const first = planFile(root, 'active', 'first', 'identity-a', 'original-a');
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => readKnowledgeStorageDelta(dir, previous) });
  t.after(() => service.close()); await service.reload('Example', root);
  const second = planFile(root, 'archive', 'second', 'identity-a', 'surviving-a');
  await service.reload('Example', root);
  const index = service.ensure('Example', root);
  assert.equal(index.search({ query: 'original-a' }).total, 1);
  planFile(root, 'active', 'first', 'identity-b', 'new-b');
  await service.reload('Example', root);
  assert.equal(index.search({ query: 'surviving-a' }).total, 1);
  assert.equal(index.search({ query: 'new-b' }).total, 1);
  assert.equal(index.references().includes(knowledgeReference('plan', 'identity-a')), true);
  fs.unlinkSync(second); await service.reload('Example', root);
  assert.equal(index.references().includes(knowledgeReference('plan', 'identity-a')), false);
  assert.equal(index.search({ query: 'new-b' }).total, 1);
  planFile(root, 'archive', 'second', 'identity-b', 'conflicting-b');
  await service.reload('Example', root);
  assert.equal(index.search({ query: 'new-b' }).total, 1);
  fs.unlinkSync(first); fs.unlinkSync(second); await service.reload('Example', root);
  assert.equal(index.references().includes(knowledgeReference('plan', 'identity-b')), false);
  assert.equal(index.search({ query: 'alpha' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 0);
});

test("reconciliation reads only changed files, preserves invalid content, and removes verified deletions", t => {
  const { root, file, write } = fixture(t);
  const first = readKnowledgeStorageDelta(root, {});
  assert.equal(first.filesRead, 1);
  assert.equal(readKnowledgeStorageDelta(root, first.inventory).filesRead, 0);
  fs.writeFileSync(file, "{");
  const invalid = readKnowledgeStorageDelta(root, first.inventory);
  assert.equal(invalid.errors, 1);
  assert.equal(invalid.removed.length, 0);
  write({ ...item(), keywords: ["beta"] });
  const next = readKnowledgeStorageDelta(root, invalid.inventory);
  assert.equal(next.filesRead, 1);
  assert.deepEqual(next.changes[0].item.keywords, ["beta"]);
  fs.unlinkSync(file);
  assert.deepEqual(readKnowledgeStorageDelta(root, next.inventory).removed, [knowledgeReference("recent", "one")]);
});

test('a corrupt row cannot keep healthy cold-index results warming or hide healthy full-reload changes', async t => {
  const { root, file, write } = fixture(t), bad = path.join(root, 'memory/recent/bad.json');
  fs.writeFileSync(bad, '{bad-json'); const raw = fs.readFileSync(bad);
  const batches: Array<{ previous: string[]; filesRead: number }> = [];
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => {
    const delta=readKnowledgeStorageDelta(dir, previous);batches.push({previous:Object.keys(previous),filesRead:delta.filesRead});return delta;
  } });
  t.after(() => service.close());
  await service.reload('Example', root);
  assert.equal(service.status(root).ready, true);
  assert.equal(service.ensure('Example', root).search({ query: 'alpha' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 1); assert.deepEqual(fs.readFileSync(bad), raw);
  await service.reload('Example',root);assert.equal(batches.at(-1)!.filesRead,1);assert.ok(batches.at(-1)!.previous.includes(file));
  await service.reload('Example',root,true);assert.equal(batches.at(-1)!.filesRead,2,'an explicit full request still reads the unchanged healthy row once');
  await service.reload('Example',root);assert.equal(batches.at(-1)!.filesRead,1,'only failed rows are reparsed while the original full intent remains pending');
  write({ ...item(), keywords: ['healthy-update'] });
  await service.reload('Example', root, true);
  assert.equal(service.ensure('Example', root).search({ query: 'healthy-update' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 1); assert.deepEqual(fs.readFileSync(bad), raw);
  await service.reload('Example',root);assert.equal(batches.at(-1)!.filesRead,1,'the existing retry of a partial full must not reparse its healthy row');
  assert.ok(batches.at(-1)!.previous.includes(file));
  assert.equal(fs.existsSync(file), true);
});

test('partial full reload retains old failed rows until a later complete read verifies deletion', async t => {
  const { root, file, write } = fixture(t), second = path.join(root, 'memory/recent/two.json');
  fs.writeFileSync(second, JSON.stringify({ ...item('two'), keywords: ['retained-old-row'] }));
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => readKnowledgeStorageDelta(dir, previous) });
  t.after(() => service.close()); await service.reload('Example', root);
  fs.writeFileSync(second, '{bad-json'); write({ ...item(), keywords: ['healthy-next'] });
  await service.reload('Example', root, true);
  const index = service.ensure('Example', root);
  assert.equal(index.search({ query: 'healthy-next' }).total, 1); assert.equal(index.search({ query: 'retained-old-row' }).total, 1);
  fs.unlinkSync(second); await service.reload('Example', root);
  assert.equal(service.ensure('Example', root).search({ query: 'retained-old-row' }).total, 0);
  assert.equal(service.ensure('Example', root).search({ query: 'healthy-next' }).total, 1); assert.equal(fs.existsSync(file), true);
});

test('a partial full refresh retains its full intent so a later clean read removes replaced identities', async t => {
  const { root, write } = fixture(t), bad = path.join(root, 'memory/recent/bad.json');
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => readKnowledgeStorageDelta(dir, previous) });
  t.after(() => service.close()); await service.reload('Example', root);
  write({ ...item('replacement'), keywords: ['replacement-keyword'] }); fs.writeFileSync(bad, '{bad-json');
  await service.reload('Example', root, true);
  assert.equal(service.ensure('Example', root).search({ query: 'replacement-keyword' }).total, 1);
  fs.writeFileSync(bad, JSON.stringify({ ...item('recovered'), keywords: ['recovered-keyword'] }));
  await service.reload('Example', root);
  const index = service.ensure('Example', root);
  assert.equal(index.references().includes(knowledgeReference('recent', 'one')), false);
  assert.equal(index.search({ query: 'replacement-keyword' }).total, 1); assert.equal(index.search({ query: 'recovered-keyword' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 0);
});

test('ordinary partial initialization also prunes replaced identities after its bad neighbor is repaired', async t => {
  const { root, write } = fixture(t), bad=path.join(root,'memory/recent/bad.json'),reads:number[]=[];
  fs.writeFileSync(bad,'{bad-json');
  const service=new KnowledgeSearchService({watch:false,readDelta:async(dir,previous)=>{const delta=readKnowledgeStorageDelta(dir,previous);reads.push(delta.filesRead);return delta;}});
  t.after(()=>service.close());await service.reload('Example',root);
  write({...item('replacement'),keywords:['ordinary-replacement']});await service.reload('Example',root);
  assert.equal(service.ensure('Example',root).search({query:'ordinary-replacement'}).total,1);
  fs.writeFileSync(bad,JSON.stringify({...item('recovered'),keywords:['ordinary-recovered']}));await service.reload('Example',root);
  assert.equal(service.ensure('Example',root).references().includes(knowledgeReference('recent','one')),false);
  assert.equal(service.ensure('Example',root).search({query:'ordinary-replacement'}).total,1);
  assert.equal(service.ensure('Example',root).search({query:'ordinary-recovered'}).total,1);assert.equal(reads.at(-1),1);
});

test('a whole storage read failure keeps cold readiness and last successful hot data separate', async t => {
  const { root } = fixture(t); let reject = true;
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => {
    if (reject) throw Object.assign(new Error('Synthetic whole directory read failure'), { code: 'EACCES' });
    return readKnowledgeStorageDelta(dir, previous);
  } });
  t.after(() => service.close()); await service.reload('Example', root);
  assert.equal(service.status(root).ready, false); assert.throws(() => service.ensure('Example', root).search({ query: 'alpha' }), /WARMING/);
  reject = false; await service.reload('Example', root); const readyIndex = service.ensure('Example', root), version = readyIndex.status().version;
  assert.equal(readyIndex.search({ query: 'alpha' }).total, 1);
  reject = true; await service.reload('Example', root, true);
  assert.equal(service.ensure('Example', root), readyIndex); assert.equal(service.status(root).ready, true);
  assert.equal(readyIndex.status().version, version); assert.equal(readyIndex.search({ query: 'alpha' }).total, 1);
  assert.equal((service.status(root) as { errors: number }).errors, 1);
});

test("legacy JSON duplicates defer to Markdown and return when Markdown is removed", t => {
  const { root, file, write } = fixture(t);
  const markdown = file.replace(/\.json$/, ".md");
  const { content, ...metadata } = { ...item(), keywords: ["markdown"] };
  fs.writeFileSync(markdown, `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${content}\n`);
  const first = readKnowledgeStorageDelta(root, {});
  assert.equal(first.errors, 0);
  assert.equal(first.changes.length, 1);
  assert.deepEqual(first.changes[0].item.keywords, ["markdown"]);
  write({ ...item(), keywords: ["legacy"] });
  const changedLegacy = readKnowledgeStorageDelta(root, first.inventory);
  assert.equal(changedLegacy.changes.length, 0);
  fs.unlinkSync(markdown);
  const fallback = readKnowledgeStorageDelta(root, changedLegacy.inventory);
  assert.deepEqual(fallback.changes[0].item.keywords, ["legacy"]);
  assert.equal(fallback.removed.length, 0);
});

test("hot searches do not call storage and reconciliation does not reindex unchanged documents", async t => {
  const { root } = fixture(t);
  let reads = 0;
  const service = new KnowledgeSearchService({ watch: false, readDelta: async (directory, previous) => {
    reads += 1;
    return readKnowledgeStorageDelta(directory, previous);
  } });
  t.after(() => service.close());
  await service.reload("Example", root);
  const count = reads;
  const index = service.ensure("Example", root);
  for (let query = 0; query < 100; query++) assert.equal(index.search({ query: "alpha" }).total, 1);
  assert.equal(reads, count);
  const updates = index.status().indexedUpdates;
  await service.reload("Example", root);
  assert.equal(index.status().indexedUpdates, updates);
});

test("filesystem watcher refreshes automatically and clears removed keywords", async t => {
  const { root, write } = fixture(t);
  const service = new KnowledgeSearchService({ debounceMs: 10,
    readDelta: async (directory, previous) => readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  write({ ...item(), keywords: ["beta"] });
  const deadline = Date.now() + 3_000;
  while (service.ensure("Example", root).search({ query: "beta" }).total === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(service.ensure("Example", root).search({ query: "beta" }).total, 1);
  assert.equal(service.ensure("Example", root).search({ query: "alpha" }).total, 0);
});

test("automatic reconciliation repairs changes without a watcher", async t => {
  const { root, write } = fixture(t);
  const service = new KnowledgeSearchService({ watch: false, reconcileMs: 30, debounceMs: 5,
    readDelta: async (directory, previous) => readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  write({ ...item(), keywords: ["repaired"] });
  const deadline = Date.now() + 3_000;
  while (service.ensure("Example", root).search({ query: "repaired" }).total === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(service.ensure("Example", root).search({ query: "repaired" }).total, 1);
});

test("a late disk snapshot cannot overwrite a committed mutation", async t => {
  const { root } = fixture(t);
  let finish: ((delta: KnowledgeStorageDelta) => void) | undefined;
  let delayed = false;
  const service = new KnowledgeSearchService({ watch: false, debounceMs: 5_000,
    readDelta: async (directory, previous) => delayed
      ? new Promise(resolve => { finish = resolve; }) : readKnowledgeStorageDelta(directory, previous) });
  t.after(() => service.close());
  await service.reload("Example", root);
  delayed = true;
  const reloading = service.reload("Example", root, true);
  publishKnowledgeChange(root, { kind: "recent", item: { ...item(), keywords: ["new"] } });
  assert.ok(finish);
  finish(readKnowledgeStorageDelta(root, {}));
  await reloading;
  assert.equal(service.ensure("Example", root).search({ query: "new" }).total, 1);
  assert.equal(service.ensure("Example", root).search({ query: "alpha" }).total, 0);
});

test("cold indexing finishes despite concurrent commits and replays the latest value for each identity", async t => {
  const { root } = fixture(t);
  let finish!: (delta: KnowledgeStorageDelta) => void;
  const service = new KnowledgeSearchService({ watch: false, debounceMs: 5000,
    readDelta: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => service.close());
  const warming = service.reload("Example", root);
  assert.equal(service.status(root).ready, false);
  publishKnowledgeChange(root, { kind: "recent", item: { ...item(), keywords: ["intermediate"] } });
  publishKnowledgeChange(root, { kind: "recent", item: { ...item(), keywords: ["latest"] } });
  publishKnowledgeChange(root, { kind: "recent", item: { ...item("two"), keywords: ["other"] } });
  finish(readKnowledgeStorageDelta(root, {}));
  await warming;
  const index = service.ensure("Example", root);
  assert.equal(index.ready, true);
  const status = service.status(root);
  assert.ok("filesRead" in status);
  assert.equal(status.filesRead, 1);
  assert.equal(index.search({ query: "latest" }).total, 1);
  assert.equal(index.search({ query: "other" }).total, 1);
  assert.equal(index.search({ query: "intermediate" }).total, 0);
  assert.equal(index.search({ query: "alpha" }).total, 0);
});
