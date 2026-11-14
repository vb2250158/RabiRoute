import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationSdk, operationResult, decodeOperationBytes, encodeOperationBytes } from '../lib/operation-sdk.mjs';
import { runOperationCommand } from '../lib/operation-cli.mjs';

const identity = { applicationGenerationId: 'app', managerInstanceId: 'manager' };
const snapshot = revision => ({ schemaVersion: '2', ...identity, pluginGenerationId: 'plugins', catalogRevision: revision, catalogDigest: 'sha256:' + String(revision).repeat(64) });
const contract = { operationId: 'plugin.notes.write', contractVersion: '1.0.0', method: 'POST', transport: 'http', pathTemplate: '/api/future/:id', request: { path: { type: 'object' }, query: { type: 'object' }, body: { kind: 'json' } } };
const operation = { id: contract.operationId, contractDigest: 'sha256:' + 'd'.repeat(64), contract };
const receipt = (data, statusCode = 200, headers = {}) => ({ statusCode, ok: statusCode >= 200 && statusCode < 300, body: statusCode === 304 ? '' : JSON.stringify(data), headers, identity });
function fixture() {
  let revision = 1;
  const calls = [];
  const request = async (method, target, options = {}) => {
    calls.push({ method, target, options });
    if (target === '/api/agent/categories') return receipt({ code: 0, data: { ...snapshot(revision), categories: [{ id: 'plugin.custom', title: 'Custom', count: 1 }] } });
    if (target.startsWith('/api/agent/operations?')) return receipt({ code: 0, data: { ...snapshot(revision), items: [{ operationId: contract.operationId, categoryId: 'plugin.custom' }], nextCursor: '' } });
    if (target.startsWith('/api/agent/operations/plugin.notes.write?')) {
      const etag = '"revision-' + revision + '"';
      return options.headers?.['if-none-match'] === etag ? receipt(undefined, 304, { etag })
        : receipt({ code: 0, data: { ...snapshot(revision), operation } }, 200, { etag });
    }
    return receipt({ code: 0, data: { saved: true } });
  };
  return { sdk: createOperationSdk({ request }), calls, revision: value => { revision = value; } };
}

test('categories and keyword discovery use bounded server projections rather than full help', async () => {
  const f = fixture();
  assert.equal((await f.sdk.categories()).categories[0].id, 'plugin.custom');
  const page = await f.sdk.search('群聊 历史', { category: 'messages', limit: 20 });
  assert.equal(page.items.length, 1);
  const query = new URL(f.calls[1].target, 'http://fixture').searchParams;
  assert.equal(query.get('query'), '群聊 历史'); assert.equal(query.get('category'), 'messages');
  assert.equal(f.calls.some(call => call.target === '/api/agent/help'), false);
});

test('call resolves only its operation, preserves request identity and encodes the same structured input', async () => {
  const f = fixture();
  const result = await f.sdk.call(contract.operationId, { pathParams: { id: 'note one' }, query: { tag: ['a', 'b'] }, body: { value: 7 } }, { requestId: 'write-one', expectedRevision: '"etag-original"' });
  const call = f.calls.at(-1);
  assert.equal(call.target, '/api/future/note%20one?tag=a&tag=b'); assert.equal(call.method, 'POST');
  assert.equal(call.options.headers['idempotency-key'], 'write-one'); assert.equal(call.options.headers['if-match'], '"etag-original"');
  assert.equal(call.options.headers['x-rabiroute-api-contract'], operation.contractDigest);
  assert.deepEqual(JSON.parse(call.options.body), { value: 7 }); assert.equal(result.ok, true); assert.equal(result.requestId, 'write-one');
  assert.notEqual(call.options.headers['idempotency-key'], contract.operationId);
});

test('description reuses conditional bytes and concurrent requests share a single read', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.sdk.describe(contract.operationId, { view: 'full' }), f.sdk.describe(contract.operationId, { view: 'full' })]);
  assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
  await f.sdk.describe(contract.operationId, { view: 'full' });
  assert.equal(f.calls[1].options.headers['if-none-match'], '"revision-1"');
  f.revision(2); const fresh = await f.sdk.describe(contract.operationId, { view: 'full' }); assert.equal(fresh.catalogRevision, 2);
});

test('a contract rejection invalidates the cache without replaying the business call', async () => {
  let calls = 0;
  const sdk = createOperationSdk({ request: async (method, target) => {
    if (target.startsWith('/api/agent/operations/')) return receipt({ code: 0, data: { ...snapshot(1), operation } });
    calls++; return receipt({ code: -1, errorCode: 'API_CONTRACT_CHANGED' }, 409);
  } });
  const result = await sdk.call(contract.operationId, { pathParams: { id: 'original' } }, { requestId: 'original-request' });
  assert.equal(calls, 1); assert.equal(result.statusCode, 409); assert.equal(result.ok, false); assert.equal(result.data.errorCode, 'API_CONTRACT_CHANGED');
});

test('CLI and SDK calls consume the same input object and preserve JSON string bodies', async () => {
  const f = fixture();
  const input = { pathParams: { id: 'one' }, body: 'literal text' };
  const result = await runOperationCommand(['call', contract.operationId, '--input-json', JSON.stringify(input), '--request-id', 'cli-request'], f.sdk);
  assert.equal(result.ok, true); assert.equal(f.calls.at(-1).options.body, '"literal text"');
  assert.equal(f.calls.at(-1).options.headers['idempotency-key'], 'cli-request');
});

test('discovery errors retain the actual code, field and repair without a business request', async () => {
  let calls = 0;
  const sdk = createOperationSdk({ request: async () => { calls++; return receipt({ code: -1, errorCode: 'API_REQUEST_SCHEMA_INVALID', field: 'query.category', repair: 'Read categories.' }, 400); } });
  await assert.rejects(sdk.describe('missing'), error => error.code === 'API_REQUEST_SCHEMA_INVALID' && error.details.field === 'query.category');
  assert.equal(calls, 1);
});


test('CLI rejects unconsumed arguments before any invocation', async () => {
  const f = fixture();
  for (const args of [['call', contract.operationId, '--bogus'], ['list', 'junk'], ['categories', '--input-json', '{}'], ['call', contract.operationId, '--input-file']]) {
    await assert.rejects(runOperationCommand(args, f.sdk), /Unknown|positional|Missing/);
  }
  assert.equal(f.calls.length, 0);
});

test('shared binary input reaches the same bodyBytes owner and rejects mixed representations', async () => {
  const f = fixture(); const bytes = Buffer.from([0, 255, 1, 80, 75]);
  await runOperationCommand(['call', contract.operationId, '--input-json', JSON.stringify({ pathParams: { id: 'binary' }, bodyBase64: bytes.toString('base64') })], f.sdk);
  assert.deepEqual(f.calls.at(-1).options.bodyBytes, bytes);
  await assert.rejects(f.sdk.call(contract.operationId, { pathParams: { id: 'binary' }, body: {}, bodyBase64: bytes.toString('base64') }), /one operation body/);
});


test('an older pending description cannot overwrite a newer observed catalog', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let old = true;
  const sdk = createOperationSdk({ request: async (_method, target) => {
    if (target.startsWith('/api/agent/operations?')) return receipt({ code: 0, data: { ...snapshot(2), items: [] } });
    if (old) { old = false; await delayed; return receipt({ code: 0, data: { ...snapshot(1), operation } }); }
    return receipt({ code: 0, data: { ...snapshot(2), operation } });
  } });
  const pending = sdk.describe(contract.operationId, { view: 'full' });
  await sdk.list({ category: 'knowledge' }); release();
  await assert.rejects(pending, error => error.code === 'API_CATALOG_SNAPSHOT_CHANGED');
  assert.equal((await sdk.describe(contract.operationId, { view: 'full' })).catalogRevision, 2);
});


test('the shared result and binary model also work without the Node Buffer global', () => {
  const original = globalThis.Buffer;
  const bytes = new TextEncoder().encode('{"code":0,"data":{"value":"中文"}}');
  let result, decoded, encoded;
  try {
    globalThis.Buffer = undefined;
    result = operationResult({ ok: true, statusCode: 200, bodyBytes: bytes, headers: {'content-type':'application/json'} }, 'portable');
    decoded = decodeOperationBytes('AP8B'); encoded = encodeOperationBytes(new Uint8Array([0,255,1]).buffer);
  } finally { globalThis.Buffer = original; }
  assert.equal(result.data.data.value, '中文'); assert.equal(encoded, 'AP8B'); assert.deepEqual([...decoded], [0,255,1]);
});
