import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createClientCallRecorder, currentCallObservation, redactCallValue } from '../lib/call-observation.mjs';

test('nested JSON receipt strings redact all credential fields while preserving ordinary results', () => {
  const value = redactCallValue({ response: { body: '{"token":"a","nested":{"adminToken":"b","value":"visible"}}' }, headers: { authorization: 'Bearer c' } });
  assert.equal(JSON.parse(value.response.body).nested.value, 'visible');
  assert.equal(JSON.parse(value.response.body).nested.adminToken, '[redacted]');
  assert.equal(value.headers.authorization, '[redacted]');
});

test('offline observations survive close and are delivered later without replaying the business action', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-call-client-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executed = 0;
  const offline = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async () => ({ ok: false, body: '{}' }) });
  const result = await offline.run({ boundary: 'client', request: { token: 'private' } }, async () => { executed++; return { ok: false, transportError: 'TRANSPORT' }; });
  assert.equal(result.transportError, 'TRANSPORT'); await offline.close();
  const received = [];
  const online = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async value => { received.push(value); return { ok: true, body: '{"data":{"stored":true}}' }; } });
  await online.flush(); await online.close();
  assert.equal(executed, 1); assert.equal(received.length, 1); assert.equal(received[0].status, 'failed'); assert.equal(received[0].request.token, '[redacted]');
});

test('nested transport calls share the original tool call and retain separate observations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-call-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const records = [];
  const recorder = createClientCallRecorder({ source: 'mcp', directory, targetKey: 'fixture', send: async record => { records.push(record); return { ok: true, body: '{"data":{"stored":true}}' }; } });
  let original;
  await recorder.run({ boundary: 'tool', toolName: 'rabi_call' }, async () => {
    original = currentCallObservation().callId;
    return recorder.run({ boundary: 'client' }, async () => ({ ok: true, body: '{"data":{"items":[1]}}' }));
  });
  await recorder.close();
  assert.equal(records.length, 2); assert.ok(records.every(record => record.callId === original)); assert.equal(new Set(records.map(record => record.spanId)).size, 2);
});

test('known transport credentials are removed from reflected arbitrary result fields and text', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-call-secrets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const records = [];
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', redactValues: ['known-private-value'],
    send: async record => { records.push(record); return { ok: true, body: '{"data":{"stored":true}}' }; } });
  const receipt = { ok: true, body: 'reflected known-private-value', custom: { field: 'known-private-value' } };
  assert.equal(await recorder.run({ boundary: 'tool' }, async () => receipt), receipt);
  await recorder.close();
  assert.ok(!JSON.stringify(records).includes('known-private-value'));
});

async function fixture(t, prefix = 'rabi-call-review-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function outboxRoot(directory, target = 'fixture') {
  return path.join(directory, createHash('sha256').update(target).digest('hex').slice(0, 24));
}

async function seed(directory, name, callId, target = 'fixture') {
  const root = outboxRoot(directory, target);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, name.repeat(64) + '.json'), JSON.stringify({ callId, spanId: callId, boundary: 'client',
    source: 'cli', status: 'succeeded', startedAt: '2026-11-16T00:00:00.000Z', target: { key: target } }));
}

const acknowledged = () => ({ ok: true, statusCode: 200, body: '{"data":{"stored":true}}' });

test('diagnostic getters, extraction and local write failures preserve the original action return and exception', async t => {
  const directory = await fixture(t);
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async () => acknowledged() });
  let executed = 0;
  const receipt = { get uncertain() { throw new Error('diagnostic getter'); } };
  assert.equal(await recorder.run({ boundary: 'client' }, async () => { executed++; return receipt; }), receipt);
  const metadata = { get broken() { throw new Error('metadata getter'); } };
  assert.equal(await recorder.run(metadata, async () => { executed++; return 'business-result'; }), 'business-result');
  const error = { get name() { throw new Error('diagnostic exception getter'); } };
  await recorder.run({ boundary: 'client' }, async () => { executed++; throw error; }).then(() => assert.fail('Original exception was swallowed.'), caught => assert.equal(caught, error));
  await recorder.close();
  const obstruction = path.join(directory, 'file'); await fs.writeFile(obstruction, 'keep');
  const failedWriter = createClientCallRecorder({ source: 'cli', directory: obstruction, targetKey: 'fixture', send: async () => acknowledged() });
  const ordinaryReceipt = { ok: true, body: 'original business result' };
  assert.equal(await failedWriter.run({ boundary: 'client' }, async () => { executed++; return ordinaryReceipt; }), ordinaryReceipt);
  await failedWriter.close();
  assert.equal(executed, 4);
});

test('malformed and explicitly rejected outbox entries are quarantined while valid neighbors upload', async t => {
  const directory = await fixture(t);
  const root = outboxRoot(directory);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, '0'.repeat(64) + '.json'), '{broken');
  await seed(directory, '1', 'rejected'); await seed(directory, '2', 'healthy');
  const received = [];
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async record => {
    received.push(record.callId);
    return record.callId === 'rejected' ? { ok: false, statusCode: 400, body: '{"code":-1}' } : acknowledged();
  } });
  await recorder.flush(); await recorder.close();
  assert.deepEqual(new Set(received), new Set(['rejected', 'healthy']));
  const remaining = await fs.readdir(root);
  assert.equal(remaining.length, 2); assert.ok(remaining.every(name => name.endsWith('.invalid')));
});

test('a failed connection preserves queued observations and ends that transfer', async t => {
  const directory = await fixture(t);
  await seed(directory, '0', 'first'); await seed(directory, '1', 'second');
  let attempted = 0;
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async () => {
    attempted++; return { ok: false, statusCode: 0, transportError: 'TRANSPORT', body: '' };
  } });
  await recorder.flush();
  assert.equal(attempted, 1); assert.equal((await fs.readdir(outboxRoot(directory))).length, 2);
  await recorder.close();
});

test('one recovery transfer bounds historical uploads and prioritizes newly captured observations', async t => {
  const directory = await fixture(t);
  const root = outboxRoot(directory);
  await fs.mkdir(root, { recursive: true });
  for (let index = 0; index < 40; index++) {
    const callId = 'historical-' + index;
    await fs.writeFile(path.join(root, index.toString(16).padStart(64, '0') + '.json'), JSON.stringify({
      callId, spanId: callId, boundary: 'client', source: 'cli', status: 'succeeded',
      startedAt: '2026-11-16T00:00:00.000Z', target: { key: 'fixture' }
    }));
  }
  const received = [];
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture',
    send: async record => { received.push(record); return acknowledged(); } });
  await recorder.run({ boundary: 'tool', toolName: 'new-call' }, async () => ({ ok: true }));
  await recorder.flush();
  assert.equal(received.length, 16);
  assert.equal(received[0].toolName, 'new-call');
  await recorder.close();
  assert.equal(received.length, 32);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.json')).length, 9);
});

test('close has one total deadline even when the transport ignores cancellation', async t => {
  const directory = await fixture(t);
  await seed(directory, '0', 'pending');
  let signal;
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', flushBudgetMs: 40,
    send: async (_record, options) => { signal = options.signal; return new Promise(() => {}); } });
  const startedAt = performance.now();
  await recorder.close();
  assert.ok(performance.now() - startedAt < 500);
  assert.equal(signal.aborted, true);
  assert.equal((await fs.readdir(outboxRoot(directory))).length, 1);
});

test('records queued during a transfer are included in bounded shutdown recovery', async t => {
  const directory = await fixture(t);
  let begin;
  const firstBegan = new Promise(resolve => { begin = resolve; });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const received = [];
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', send: async record => {
    if (!received.length) { begin(); await released; }
    received.push(record); return acknowledged();
  } });
  await recorder.run({ boundary: 'tool', toolName: 'first' }, async () => ({ ok: true }));
  await firstBegan;
  await recorder.run({ boundary: 'tool', toolName: 'second' }, async () => ({ ok: true }));
  const closed = recorder.close(); release(); await closed;
  assert.equal(received.length, 2);
  assert.equal((await fs.readdir(outboxRoot(directory))).filter(name => name.endsWith('.json')).length, 0);
});

test('nested observations share the verified target and queued records stay in their original target partition', async t => {
  const directory = await fixture(t);
  const records = [];
  const recorder = createClientCallRecorder({ source: 'mcp', directory, targetKey: 'initial', send: async record => { records.push(record); return acknowledged(); } });
  await recorder.run({ boundary: 'tool' }, async () => {
    const originalTarget = currentCallObservation().target;
    return recorder.run({ boundary: 'client' }, async () => {
      assert.equal(currentCallObservation().target, originalTarget);
      recorder.setTarget('verified');
      return { ok: true };
    });
  });
  await recorder.close();
  assert.equal(records.length, 2); assert.ok(records.every(record => record.target.key === 'verified'));
  await seed(directory, '0', 'old', 'previous-manager');
  const replayed = [];
  const changed = createClientCallRecorder({ source: 'cli', directory, targetKey: 'previous-manager', send: async record => { replayed.push(record); return acknowledged(); } });
  changed.setTarget('new-manager'); await changed.flush();
  assert.equal(replayed.length, 0); assert.equal((await fs.readdir(outboxRoot(directory, 'previous-manager'))).length, 1);
  changed.setTarget('previous-manager'); await changed.flush(); await changed.close();
  assert.equal(replayed.length, 1); assert.equal(replayed[0].target.key, 'previous-manager');
});

test('unparseable JSON-like previews are omitted and large-payload metadata keeps known-secret redaction', async t => {
  assert.deepEqual(redactCallValue('{"password":"prefix \\" private-tail'), { captured: 'omitted', reason: 'unparseable-json' });
  const directory = await fixture(t);
  const records = [];
  const recorder = createClientCallRecorder({ source: 'cli', directory, targetKey: 'fixture', redactValues: ['known-private-value'],
    send: async record => { records.push(record); return acknowledged(); } });
  const response = { ok: true, body: 'x'.repeat(9 * 1024 * 1024) };
  assert.equal(await recorder.run({ boundary: 'tool', note: 'known-private-value' }, async () => response), response);
  await recorder.close();
  assert.equal(records.length, 1); assert.equal(records[0].truncated, true);
  assert.ok(!JSON.stringify(records).includes('known-private-value'));
});
