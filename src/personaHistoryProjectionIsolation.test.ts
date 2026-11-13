import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPersonaHistoryTasks, readPersonaChatHistory } from './personaChatHistory.js';

async function fixture(t:test.TestContext){
 const role=fs.mkdtempSync(path.join(os.tmpdir(),'history-point-repair-'));t.after(()=>fs.rmSync(role,{recursive:true,force:true}));const file=path.join(role,'chat-history/final-replies.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,['a','b','c'].map(id=>JSON.stringify({id,sessionId:'session-'+id,turnId:'turn-'+id,text:'Reply '+id,receivedAt:'2026-01-01T00:00:00Z'})).join('\n')+'\n');
 const before=fs.readFileSync(file),warm=await readPersonaHistoryTasks(role);return {role,file,before,warm};
}
test('one damaged task descriptor is point-repaired from the unchanged ledger without a full rebuild',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.file+'.index.sqlite');try{db.prepare('UPDATE task_summary SET descriptor=? WHERE taskKey=?').run('{bad',f.warm.items[0].key);}finally{db.close();}
 let reads=0;const original=fs.readSync;t.mock.method(fs,'readSync',((...args:any[])=>{reads++;return (original as any)(...args);}) as typeof fs.readSync);
 const page=await readPersonaHistoryTasks(f.role);assert.deepEqual(page.items,f.warm.items);assert.equal(reads,1);
 await readPersonaHistoryTasks(f.role);assert.equal(reads,1,'a successful repair is persisted, not repeated on each request');assert.deepEqual(fs.readFileSync(f.file),f.before);
 const raw=await readPersonaChatHistory(f.role);assert.equal(raw.entries.length,3);
});
test('an unrecoverable derived row stays local and its real cursor still reaches healthy rows',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.file+'.index.sqlite');try{db.prepare('UPDATE task_summary SET descriptor=? WHERE taskKey=?').run('{bad',f.warm.items[0].key);db.prepare('DELETE FROM task_refs WHERE taskKey=?').run(f.warm.items[0].key);}finally{db.close();}
 const first=await readPersonaHistoryTasks(f.role,{limit:1});assert.equal(first.items.length,0);assert.equal(first.partial,true);assert.equal(first.projectionIssues?.length,1);assert.ok(first.nextCursor);
 const next=await readPersonaHistoryTasks(f.role,{limit:2,cursor:first.nextCursor!});assert.equal(next.items.length,2);assert.deepEqual(fs.readFileSync(f.file),f.before);
 assert.equal((await readPersonaChatHistory(f.role)).entries.length,3);
});

test('valid JSON null or another task identity is repaired at the projection boundary',async t=>{
 for(const descriptor of ['null',JSON.stringify({key:'another-task',title:'incorrect'})]){
  const f=await fixture(t),db=new DatabaseSync(f.file+'.index.sqlite');try{db.prepare('UPDATE task_summary SET descriptor=? WHERE taskKey=?').run(descriptor,f.warm.items[0].key);}finally{db.close();}
  const page=await readPersonaHistoryTasks(f.role);assert.deepEqual(page.items,f.warm.items);assert.equal(page.nextCursor,null);assert.deepEqual(fs.readFileSync(f.file),f.before);
 }
});

test('title search repairs a damaged task reference before matching and persists the point repair', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file + '.index.sqlite');
  try {
    db.prepare('UPDATE task_refs SET descriptor=? WHERE taskKey=?').run('{bad-json', f.warm.items[0].key);
  } finally {
    db.close();
  }
  let reads = 0;
  const original = fs.readSync;
  t.mock.method(fs, 'readSync', ((...args: any[]) => {
    reads++;
    return (original as any)(...args);
  }) as typeof fs.readSync);
  const first = await readPersonaHistoryTasks(f.role, { query: 'session-', limit: 1 });
  assert.equal(first.items[0].key, f.warm.items[0].key);
  assert.ok(first.nextCursor);
  assert.equal(reads, 1);
  const second = await readPersonaHistoryTasks(f.role, { query: 'session-', limit: 2, cursor: first.nextCursor! });
  assert.equal(second.items.length, 2);
  assert.equal(reads, 1);
  assert.equal((await readPersonaHistoryTasks(f.role, { query: 'session-' })).items.length, 3);
  assert.equal(reads, 1);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});

test('title search keeps category and peer identity while repairing one bad reference', async t => {
  const f = await fixture(t);
  const ledger = ['a', 'b'].map(id => ({
    id, kind: 'agent_delivery', deliveryId: 'delivery-' + id,
    sessionId: 'source-' + id, sessionTitle: 'Source ' + id,
    targetSessionId: 'target', targetSessionTitle: 'Shared target',
    text: 'Message ' + id, receivedAt: '2026-01-01T00:00:00Z'
  }));
  fs.writeFileSync(f.file, ledger.map(row => JSON.stringify(row)).join('\n') + '\n');
  const original = fs.readFileSync(f.file);
  const warm = await readPersonaHistoryTasks(f.role, { category: 'agent' });
  const source = warm.items.find(row => row.sessionId === 'source-a')!;
  const peer = warm.items.find(row => row.sessionId === 'target')!;
  const db = new DatabaseSync(f.file + '.index.sqlite');
  try {
    db.prepare('UPDATE task_refs SET descriptor=? WHERE taskKey=?').run('{broken', source.key);
  } finally {
    db.close();
  }
  const result = await readPersonaHistoryTasks(f.role, { query: 'Source', category: 'agent', peerOf: peer.key });
  assert.deepEqual(result.items.map(row => row.sessionId).sort(), ['source-a', 'source-b']);
  const otherCategory = await readPersonaHistoryTasks(f.role, { query: 'Source', category: 'panel', peerOf: peer.key });
  assert.equal(otherCategory.items.length, 0);
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test('an unrepairable search projection reports a local issue while healthy matching tasks remain readable', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file + '.index.sqlite');
  try {
    db.prepare('UPDATE task_refs SET descriptor=? WHERE taskKey=?').run('{broken', f.warm.items[0].key);
    db.prepare('UPDATE history SET textHash=? WHERE id=?').run('incorrect-cache-hash', 'c');
  } finally {
    db.close();
  }
  const result = await readPersonaHistoryTasks(f.role, { query: 'session-' });
  assert.equal(result.partial, true);
  assert.equal(result.projectionIssues?.length, 1);
  assert.equal(result.items.length, 2);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});

test('repair continuation advances past an unreadable newest reference to an older unique title match', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file + '.index.sqlite');
  try {
    db.prepare('UPDATE task_refs SET descriptor=? WHERE recordId IN (?,?)').run('{broken', 'c', 'b');
    db.prepare('UPDATE history SET textHash=? WHERE id=?').run('unreadable-derived-hash', 'c');
  } finally {
    db.close();
  }
  const first = await readPersonaHistoryTasks(f.role, { query: 'session-b', limit: 1 });
  assert.equal(first.items.length, 0);
  assert.equal(first.partial, true);
  assert.ok(first.nextCursor);
  const continued = await readPersonaHistoryTasks(f.role, { query: 'session-b', limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(continued.items.map(row => row.sessionId), ['session-b']);
  assert.equal(continued.partial, true);
  assert.equal(continued.nextCursor, null);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});

test('repair pages preserve the main result boundary so healthy title pages have no duplicates or omissions', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file + '.index.sqlite');
  try {
    db.prepare('UPDATE task_refs SET descriptor=? WHERE recordId IN (?,?)').run('{broken', 'c', 'b');
    db.prepare('UPDATE history SET textHash=? WHERE id=?').run('unreadable-derived-hash', 'c');
  } finally {
    db.close();
  }
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < 4; pages++) {
    const page = await readPersonaHistoryTasks(f.role, { query: 'session-', limit: 1, cursor });
    ids.push(...page.items.map(row => row.sessionId));
    if (!page.nextCursor) break;
    assert.equal(cursors.has(page.nextCursor), false, 'each continuation must advance');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.deepEqual(ids, ['session-b', 'session-a']);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});
