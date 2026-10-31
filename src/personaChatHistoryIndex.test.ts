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
    assert.ok(index.find('first')); assert.ok(index.find('second')); index.assertIdentityComplete();
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

test('bad rows preserve valid reads; unknown identities only prevent unsafe new writes', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, [JSON.stringify(row('1')), 'broken', JSON.stringify({ id: 'bad-body' }), JSON.stringify(row('3'))].join('\n') + '\n');
  await withPersonaHistoryIndex(file, parse, async index => {
    assert.equal(index.find('1')?.valid, 1); assert.equal(index.find('3')?.valid, 1); assert.equal(index.find('bad-body')?.valid, 0);
    assert.equal(index.invalidRecords, 2);
    assert.ok(index.find('bad-body'));
    assert.throws(() => index.assertIdentityComplete(), /unknown identity/);
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
    index.assertIdentityComplete();
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
