import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { withPersonaHistoryIndex } from './personaChatHistoryIndex.js';
import type { PersonaChatReply } from './shared/personaChatHistory.js';

function parse(line: string): PersonaChatReply {
  const value = JSON.parse(line);
  if (!value.id || typeof value.text !== 'string') throw new Error('invalid');
  return value;
}
const row = (id: string, text = 'reply'): PersonaChatReply => ({ id, text, sessionId: 'session', turnId: id, receivedAt: '2026-10-31T00:00:00Z' });
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-index-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return path.join(root, 'history.jsonl');
}

test('projection rebuilds after ledger-only commit, restart, deletion and corruption', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify(row('first')) + '\n');
  await withPersonaHistoryIndex(file, parse, async index => { assert.ok(index.find('first')); });
  // Simulate termination after durable ledger write but before index checkpoint.
  await fs.appendFile(file, JSON.stringify(row('second')) + '\n');
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.ok(index.find('first')); assert.ok(index.find('second')); assert.equal(index.unknownIdentityRecords, 0);
  });
  await fs.unlink(file + '.index.sqlite');
  await withPersonaHistoryIndex(file, parse, async index => { assert.ok(index.find('second')); });
  await fs.writeFile(file + '.index.sqlite', 'corrupt projection');
  await withPersonaHistoryIndex(file, parse, async index => { assert.ok(index.find('second')); });
});

test('identity projection retains offsets and reads the original Unicode body', async t => {
  const file = await fixture(t);
  const entry = row('original', '中文😀'.repeat(2000));
  await fs.writeFile(file, JSON.stringify(entry) + '\n');
  await withPersonaHistoryIndex(file, parse, async index => {
    const located = index.find('original')!;
    assert.equal(located.start, 0); assert.equal(located.end, index.size);
    assert.deepEqual(await index.read(located), entry);
  });
});

test('bad rows preserve valid reads and unknown identities remain a local diagnostic', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, [JSON.stringify(row('1')), 'broken', JSON.stringify({ id: 'bad-body' }), JSON.stringify(row('3'))].join('\n') + '\n');
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.find('1')?.valid, 1); assert.equal(index.find('3')?.valid, 1); assert.equal(index.find('bad-body')?.valid, 0);
    assert.equal(index.invalidRecords, 2);
    assert.ok(index.find('bad-body'));
    assert.ok(index.unknownIdentityRecords > 0);
  });
});

test('own append commits the projection only after ledger durability and external rewrite rebuilds', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, '');
  const entry = row('own');
  await withPersonaHistoryIndex(file, parse, async index => {
    const start = index.size;
    const handle = await fs.open(file, 'a');
    try { await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await index.appended([entry], start);
    assert.ok(index.find('own'));
  });
  await fs.writeFile(file, JSON.stringify(row('replacement')) + '\n');
  await withPersonaHistoryIndex(file, parse, async index => { assert.equal(index.find('own'), undefined); assert.ok(index.find('replacement')); });
});


test('same-size same-mtime same-inode ledger rewrite invalidates identity projection', async t => {
  const file = await fixture(t);
  const fixed = new Date('2026-01-01T00:00:00Z');
  await fs.writeFile(file, JSON.stringify(row('old-a')) + '\n');
  await fs.utimes(file, fixed, fixed);
  await withPersonaHistoryIndex(file, parse, async index => { assert.ok(index.find('old-a')); });
  const before = await fs.stat(file);
  await new Promise(resolve => setTimeout(resolve, 10));
  const replacement = JSON.stringify(row('old-b')) + '\n';
  await fs.writeFile(file, replacement);
  await fs.utimes(file, fixed, fixed);
  const after = await fs.stat(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.find('old-a'), undefined);
    assert.deepEqual(await index.read(index.find('old-b')!), row('old-b'));
    assert.equal(index.unknownIdentityRecords, 0);
  });
  assert.equal(await fs.readFile(file, 'utf8'), replacement, 'rebuilding only updates the disposable projection');
});

test('legacy version checkpoint rebuilds once and own append saves the full version atomically', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify(row('first')) + '\n');
  let parsed = 0;
  const countingParse = (line: string) => { parsed++; return parse(line); };
  await withPersonaHistoryIndex(file, countingParse, async () => {});
  const db = new DatabaseSync(file + '.index.sqlite');
  try {
    const checkpoint = JSON.parse(String(db.prepare('SELECT value FROM checkpoint').get()!.value));
    delete checkpoint.ctimeMs; delete checkpoint.dev;
    db.prepare('UPDATE checkpoint SET value=?').run(JSON.stringify(checkpoint));
  } finally { db.close(); }
  parsed = 0;
  await withPersonaHistoryIndex(file, countingParse, async index => { assert.ok(index.find('first')); });
  assert.equal(parsed, 1, 'old checkpoints cannot establish current absence');
  await withPersonaHistoryIndex(file, countingParse, async index => {
    assert.ok(index.find('first'));
    const start = index.size, entry = row('second');
    const handle = await fs.open(file, 'a');
    try { await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await index.appended([entry], start);
  });
  await withPersonaHistoryIndex(file, countingParse, async index => { assert.ok(index.find('first')); assert.ok(index.find('second')); });
  assert.equal(parsed, 1, 'unchanged and owner-appended ledgers reuse the upgraded checkpoint');
  assert.equal(await fs.readFile(file, 'utf8'), [row('first'), row('second')].map(item => JSON.stringify(item) + '\n').join(''));
});

test('external append reads only newly completed records and keeps physical task pages indexed', async t => {
  const file = await fixture(t);
  const original = Array.from({ length: 400 }, (_, i) => ({ ...row('record-' + i), sessionId: 'task-' + (i % 20) }));
  await fs.writeFile(file, original.map(value => JSON.stringify(value) + '\n').join(''));
  let parsed = 0;
  const count = (line: string) => { parsed++; return parse(line); };
  await withPersonaHistoryIndex(file, count, async index => { assert.equal(index.tasks({ limit: 100 }).items.length, 20); });
  assert.equal(parsed, 400);
  const appended = { ...row('newest'), sessionId: 'new-task' };
  await fs.appendFile(file, JSON.stringify(appended) + '\n');
  const bytes = await fs.readFile(file);
  parsed = 0;
  await withPersonaHistoryIndex(file, count, async index => {
    assert.equal(index.find('record-0')?.valid, 1);
    assert.equal(index.tasks({ limit: 1 }).items[0]?.sessionId, 'new-task');
    assert.equal(index.tasks({ limit: 100 }).items.length, 21);
  });
  assert.equal(parsed, 1, 'one external JSONL append must not reparse old bodies');
  assert.deepEqual(await fs.readFile(file), bytes);
  const db = new DatabaseSync(file + '.index.sqlite');
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT taskKey,descriptor,latest FROM task_summary WHERE category=? ORDER BY latest DESC,taskKey LIMIT ?').all('', 51);
    assert.ok(plan.some(item => String(item.detail).includes('task_summary_page')));
    assert.ok(!plan.some(item => /TEMP B-TREE|GROUP BY/i.test(String(item.detail))));
    const peerPlan = db.prepare('EXPLAIN QUERY PLAN SELECT taskKey,descriptor,latest FROM task_peer_summary WHERE category=? AND peerKey=? ORDER BY latest DESC,taskKey LIMIT ?').all('', 'peer-key', 51);
    assert.ok(peerPlan.some(item => String(item.detail).includes('task_peer_summary_page')));
    assert.ok(!peerPlan.some(item => /TEMP B-TREE|GROUP BY/i.test(String(item.detail))));
  } finally { db.close(); }
});

test('an incomplete external suffix is resumed without retaining a false invalid count', async t => {
  const file = await fixture(t), entry = JSON.stringify(row('split', 'Unicode \u4e2d\u6587\ud83d\ude80'));
  await fs.writeFile(file, JSON.stringify(row('first')) + '\n' + entry.slice(0, entry.length - 4));
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.ok(index.find('first')); assert.equal(index.invalidRecords, 1); assert.equal(index.appendSeparator, '\n');
  });
  await fs.appendFile(file, entry.slice(-4) + '\n' + JSON.stringify(row('last')) + '\n');
  let parsed = 0;
  await withPersonaHistoryIndex(file, line => { parsed++; return parse(line); }, async index => {
    assert.ok(index.find('split')); assert.ok(index.find('last'));
    assert.equal(index.invalidRecords, 0); assert.equal(index.appendSeparator, '');
  });
  assert.equal(parsed, 2);
});

test('growing rewrites with a changed old boundary rebuild instead of retaining stale task identities', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify(row('old')) + '\n');
  await withPersonaHistoryIndex(file, parse, async () => {});
  const replacement = JSON.stringify({ ...row('replacement'), sessionId: 'replacement-task', text: 'replacement grows the ledger' }) + '\n';
  await fs.writeFile(file, replacement);
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.find('old'), undefined);
    assert.ok(index.find('replacement'));
    assert.deepEqual(index.tasks({}).items.map(item => item.sessionId), ['replacement-task']);
  });
  assert.equal(await fs.readFile(file, 'utf8'), replacement);
});

test('task title search retains old matching titles while ordinary pages show the latest record', async t => {
  const file = await fixture(t);
  const older = { ...row('older'), sessionId: 'same-task', sessionTitle: 'Old matching title' };
  const newer = { ...row('newer'), sessionId: 'same-task', sessionTitle: 'Current title' };
  await fs.writeFile(file, [older, newer].map(value => JSON.stringify(value) + '\n').join(''));
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.tasks({}).items[0]?.title, 'Current title');
    assert.equal(index.tasks({ query: 'matching' }).items[0]?.title, 'Old matching title');
  });
});

test('oversized unfinished append is counted once and later valid records remain readable', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify(row('first')) + '\n' + 'x'.repeat(1100000));
  await withPersonaHistoryIndex(file, parse, async index => { assert.equal(index.invalidRecords, 1); });
  await fs.appendFile(file, 'more incomplete suffix');
  await withPersonaHistoryIndex(file, parse, async index => { assert.equal(index.invalidRecords, 1); });
  await fs.appendFile(file, '\n' + JSON.stringify(row('healthy')) + '\n');
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.invalidRecords, 1); assert.ok(index.find('healthy')); assert.ok(index.find('first'));
    assert.ok(index.unknownIdentityRecords > 0);
  });
});

test('duplicate physical IDs retain the first record and do not create ghost tasks', async t => {
  const file = await fixture(t);
  const first = { ...row('stable-id', 'first body'), sessionId: 'first-task' };
  const repeated = { ...row('stable-id', 'conflicting duplicate'), sessionId: 'ghost-task' };
  await fs.writeFile(file, JSON.stringify(first) + '\n');
  await withPersonaHistoryIndex(file, parse, async () => {});
  await fs.appendFile(file, JSON.stringify(repeated) + '\n');
  const raw = await fs.readFile(file);
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.deepEqual(await index.read(index.find(first.id)!), first);
    assert.deepEqual(index.tasks({}).items.map(task => task.sessionId), ['first-task']);
    assert.deepEqual(index.tasks({ query: 'ghost-task' }).items, []);
  });
  assert.deepEqual(await fs.readFile(file), raw);
});

test('atomic ledger replacement rebuilds even when the old tail still matches', async t => {
  const file = await fixture(t);
  const original = Array.from({ length: 100 }, (_, i) => row('old-' + i, 'body '.repeat(20)));
  await fs.writeFile(file, original.map(value => JSON.stringify(value) + '\n').join(''));
  await withPersonaHistoryIndex(file, parse, async () => {});
  const oldIdentity = (await fs.stat(file)).ino;
  const replaced = [row('replacement-first', original[0].text), ...original.slice(1), row('last')];
  await fs.writeFile(file + '.replacement', replaced.map(value => JSON.stringify(value) + '\n').join(''));
  await fs.rename(file + '.replacement', file);
  assert.notEqual((await fs.stat(file)).ino, oldIdentity);
  let parsed = 0;
  await withPersonaHistoryIndex(file, line => { parsed++; return parse(line); }, async index => {
    assert.equal(index.find('old-0'), undefined);
    assert.ok(index.find('replacement-first')); assert.ok(index.find('last'));
  });
  assert.equal(parsed, replaced.length);
});
