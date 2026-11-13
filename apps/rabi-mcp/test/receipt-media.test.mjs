import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { projectManagerReceiptMedia, compactManagerReceiptMedia, getRawManagerReceipt } from '../../rabi-agent/lib/operation-result.mjs';
import { operationResult } from '../../rabi-agent/lib/operation-sdk.mjs';
import { createApiTools } from '../lib/api-tools.mjs';
import { createOperationTools } from '../lib/operation-tools.mjs';
import { createKnowledgeMcpServer } from '../lib/knowledge-mcp-server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDe8AAAAASUVORK5CYII=';
const image = { mimeType: 'image/png', data: png, width: 1, height: 1, frameId: 'frame-one', source: { displayId: 'display-one' } };
const declarations = [{ path: '/data/capture', type: 'image' }];
const contract = { operationId: 'fixture.capture', method: 'POST', pathTemplate: '/fixture/capture', effects: { mode: 'write' },
  responses: { '200': { mediaType: 'application/json', schema: { 'x-rabiroute-media': declarations } } } };
function receipt(json = { code: 0, data: { capture: image, saved: true } }, headers = {}) {
  return { ok: true, statusCode: 200, code: 0, requestId: 'original-request', uncertain: false,
    headers: { 'content-type': 'application/json', etag: 'original-revision', ...headers }, body: JSON.stringify(json) };
}
async function connect(t, tools) {
  const server = createKnowledgeMcpServer({ tools });
  const client = new Client({ name: 'media-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await tools.close?.(); });
  await server.connect(a); await client.connect(b);
  return client;
}
function operationTools(raw, operationContract = contract) {
  let calls = 0, descriptions = 0;
  const sdk = { describe: async () => { descriptions++; return { operation: { id: operationContract.operationId, contract: operationContract } }; },
    invokeOperation: async () => { calls++; return raw; }, openOperation: async () => { throw new Error('unexpected'); } };
  return { tools: createOperationTools({ client: { operations: sdk } }), calls: () => calls, descriptions: () => descriptions };
}

test('official MCP client receives a nested declared image once and compact receipts preserve the outcome', async t => {
  const raw = receipt(), original = structuredClone(raw), f = operationTools(raw);
  const client = await connect(t, f.tools);
  const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture', requestId: 'original-request' } });
  assert.equal(result.isError, false);
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: png });
  const publicReceipt = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), publicReceipt);
  assert.ok(!JSON.stringify(publicReceipt).includes(png));
  assert.equal(publicReceipt.data.code, 0); assert.equal(publicReceipt.code, 0);
  assert.equal(publicReceipt.data.data.saved, true); assert.equal(publicReceipt.data.data.capture.frameId, 'frame-one');
  assert.equal(publicReceipt.data.data.capture.data, undefined);
  assert.equal(publicReceipt.data.data.capture.imageItemId, publicReceipt.media[0].imageItemId);
  assert.equal(publicReceipt.statusCode, 200); assert.equal(publicReceipt.headers.etag, 'original-revision');
  assert.equal(publicReceipt.requestId, 'original-request'); assert.equal(publicReceipt.uncertain, false);
  assert.equal(f.calls(), 1); assert.equal(f.descriptions(), 1); assert.deepEqual(raw, original);
});

test('raw HTTP header declarations need no discovery and schema duplicates project one image', async t => {
  const raw = receipt(undefined, { 'X-RabiRoute-Media': JSON.stringify([...declarations, ...declarations]) });
  const projected = projectManagerReceiptMedia(raw);
  assert.equal(projected.media.length, 1); assert.strictEqual(getRawManagerReceipt(projected), raw);
  const transformed = operationResult({ ...projected }, 'capture', 'original-request');
  assert.strictEqual(getRawManagerReceipt(transformed), raw);
  assert.ok(!JSON.stringify(compactManagerReceiptMedia(transformed)).includes(png));
  const client = await connect(t, { list: () => [{ name: 'raw', inputSchema: { type: 'object' } }], call: async () => projected });
  const result = await client.callTool({ name: 'raw', arguments: {} });
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
});

test('ordinary JSON file data is unchanged without a declaration', async t => {
  const value = { code: 0, data: { mimeType: 'image/png', data: png, other: { data: png } } };
  const raw = receipt(value), f = operationTools(raw, { ...contract, responses: {} });
  const client = await connect(t, f.tools);
  const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture' } });
  assert.equal(result.content.length, 1); assert.deepEqual(result.structuredContent.data, value);
  assert.equal(result.structuredContent.media, undefined); assert.equal(f.calls(), 1);
});

test('uncertainty remains visible alongside image content without replay', async t => {
  const raw = { ...receipt({ code: 0, uncertain: true, mutationOutcome: 'unknown', data: { capture: image } }), uncertain: true, requestId: 'uncertain-original' };
  const f = operationTools(raw), client = await connect(t, f.tools);
  const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture' } });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.uncertain, true);
  assert.equal(result.structuredContent.ok, false); assert.equal(result.structuredContent.requestId, 'uncertain-original');
  assert.equal(result.structuredContent.data.mutationOutcome, 'unknown');
  assert.equal(result.content.filter(item => item.type === 'image').length, 1); assert.equal(f.calls(), 1);
});

test('raw HTTP image bytes produce one image and retain the untouched raw receipt', async t => {
  const raw = { ok: true, statusCode: 201, requestId: 'binary-original', headers: { 'Content-Type': 'image/png; profile=example', etag: 'binary-etag' }, bodyBytes: Buffer.from(png, 'base64') };
  const f = operationTools(raw, { ...contract, responses: {} }), client = await connect(t, f.tools);
  const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture' } });
  assert.equal(result.content.length, 2); assert.equal(result.content[1].data, png);
  assert.equal(result.structuredContent.bodyBase64, undefined); assert.equal(result.structuredContent.bodyBytes, undefined);
  assert.equal(result.structuredContent.statusCode, 201); assert.equal(result.structuredContent.headers.etag, 'binary-etag');
  assert.strictEqual(getRawManagerReceipt(projectManagerReceiptMedia(raw)), raw); assert.equal(f.calls(), 1);
});

test('a bad declared item leaves successful business state and valid neighbors available', () => {
  const items = [image, { ...image, data: 'invalid base64' }, image];
  const raw = receipt({ code: 0, data: { saved: true, items } });
  const declared = { ...contract, responses: { '200': { schema: { 'x-rabiroute-media': items.map((_, index) => ({ path: `/data/items/${index}`, type: 'image' })) } } } };
  const result = projectManagerReceiptMedia(raw, declared), publicReceipt = compactManagerReceiptMedia(result);
  assert.equal(result.ok, true); assert.equal(result.statusCode, 200); assert.equal(result.bodyJson.data.saved, true);
  assert.equal(result.media.length, 2); assert.equal(result.mediaErrors.length, 1);
  assert.equal(result.mediaErrors[0].code, 'IMAGE_BASE64_INVALID'); assert.equal(result.mediaErrors[0].path, '/data/items/1');
  assert.equal(publicReceipt.bodyJson.data.items.length, 3);
  assert.ok(!JSON.stringify(publicReceipt).includes(png)); assert.equal(publicReceipt.bodyJson.data.items[1].data, 'invalid base64');
  assert.equal(JSON.parse(raw.body).data.items[1].data, 'invalid base64');
});

test('malformed and unknown declarations report media errors without changing business receipts', () => {
  for (const value of ['{bad', '{}', '[{"path":"/data/capture","type":"video"}]']) {
    const raw = receipt(undefined, { 'x-rabiroute-media': value });
    const result = projectManagerReceiptMedia(raw, contract);
    assert.equal(result.ok, true); assert.equal(result.statusCode, raw.statusCode); assert.equal(result.requestId, raw.requestId);
    assert.equal(result.body, raw.body); assert.equal(result.media.length, 0); assert.ok(result.mediaErrors.length);
  }
});

test('JSON pointers use own keys and escape tokens without probing ordinary nested data', () => {
  const raw = receipt({ 'a/b': { '~image': image }, data: { hidden: image } });
  const result = projectManagerReceiptMedia(raw, { responses: { '200': { schema: { 'x-rabiroute-media': [{ path: '/a~1b/~0image', type: 'image' }] } } } });
  assert.equal(result.media.length, 1);
  const compact = compactManagerReceiptMedia(result);
  assert.equal(compact.bodyJson['a/b']['~image'].data, undefined); assert.equal(compact.bodyJson.data.hidden.data, png);
  const invalid = projectManagerReceiptMedia(receipt(), { responses: { '200': { schema: { 'x-rabiroute-media': [{ path: '/__proto__', type: 'image' }] } } } });
  assert.equal(invalid.mediaErrors, undefined); assert.equal(invalid.media, undefined);
});

test('SSE image-looking frames retain their session transport and original byte budget', async t => {
  let emit, finish, calls = 0;
  const frameReady = new Promise(resolve => { emit = resolve; });
  const finalReady = new Promise(resolve => { finish = resolve; });
  const streamContract = { ...contract, transport: 'sse' };
  const tools = createApiTools({ client: {
    catalog: { refresh: async () => ({ operations: [{ id: streamContract.operationId, contract: streamContract }] }) },
    invokeOperation: async (_id, options) => { calls++; await options.onChunk(Buffer.from(JSON.stringify(image))); emit(); await finalReady; return { ok: true, statusCode: 200, requestId: 'stream-original' }; },
    openOperation: async () => { throw new Error('unexpected'); }
  }, maxSessionBytes: 64 });
  t.after(async () => { finish(); await tools.close(); });
  const opened = await tools.call('rabi_api_call', { operationId: streamContract.operationId });
  await frameReady;
  const read = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' });
  assert.equal(read.frames.length, 1); assert.equal(read.media, undefined); assert.equal(opened.queueHighWaterBytes, 64);
  assert.equal(Buffer.from(read.frames[0].data, 'base64').toString(), JSON.stringify(image));
  finish(); await tools.close(); assert.equal(calls, 1);
});


test('declared images reject invalid mime, dimensions, data URLs and noncanonical padding locally', () => {
  for (const [changed, code] of [
    [{ mimeType: 'application/octet-stream' }, 'IMAGE_MIME_TYPE_INVALID'],
    [{ width: 0 }, 'IMAGE_DIMENSIONS_INVALID'],
    [{ height: 1.5 }, 'IMAGE_DIMENSIONS_INVALID'],
    [{ data: 'data:image/png;base64,' + png }, 'IMAGE_BASE64_INVALID'],
    [{ data: 'Zh==' }, 'IMAGE_BASE64_INVALID'],
    [{ data: 'Zm9=' }, 'IMAGE_BASE64_INVALID'],
    [{ data: '' }, 'IMAGE_BASE64_INVALID']
  ]) {
    const raw = receipt({ code: 0, data: { saved: true, capture: { ...image, ...changed } } });
    const result = projectManagerReceiptMedia(raw, contract);
    assert.equal(result.ok, true); assert.equal(result.media.length, 0);
    assert.equal(result.mediaErrors[0].code, code); assert.equal(result.bodyJson.data.saved, true);
  }
});

test('raw image projection works without the Node Buffer global', () => {
  const saved = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const result = projectManagerReceiptMedia({ ok: true, statusCode: 200, headers: { 'content-type': 'image/png' }, bodyBytes: Uint8Array.of(102) });
    assert.equal(result.media[0].data, 'Zg==');
    assert.equal(compactManagerReceiptMedia(result).bodyBytes, undefined);
  } finally { globalThis.Buffer = saved; }
});


test('compaction does not mutate an existing decoded receipt or its image array', () => {
  const items = Object.freeze([Object.freeze({ ...image }), Object.freeze({ ...image })]);
  const json = Object.freeze({ code: 0, data: Object.freeze({ items, saved: true }) });
  const raw = { ok: true, statusCode: 200, bodyJson: json };
  const projected = projectManagerReceiptMedia(raw, { responses: { '200': { schema: { 'x-rabiroute-media': [
    { path: '/data/items/0', type: 'image' }, { path: '/data/items/1', type: 'image' }
  ] } } } });
  const compact = compactManagerReceiptMedia(projected);
  assert.equal(compact.bodyJson.data.saved, true); assert.equal(compact.bodyJson.data.items[0].data, undefined);
  assert.equal(compact.bodyJson.data.items[1].data, undefined); assert.equal(items[0].data, png); assert.equal(items[1].data, png);
  assert.strictEqual(getRawManagerReceipt(projected), raw); assert.strictEqual(raw.bodyJson, json);
});


test('invalid declared MIME, base64 and dimensions retain public business data', async t => {
  const variants = [
    { mimeType: 'wrong', data: 'business value', id: 42 },
    { mimeType: 'image/png', data: 'business value', id: 42 },
    { mimeType: 'image/png', data: png, width: 0, id: 42 }
  ];
  for (const capture of variants) {
    const raw = receipt({ code: 0, data: { capture, saved: true } });
    const projected = projectManagerReceiptMedia(raw, contract);
    const compact = compactManagerReceiptMedia(projected);
    assert.equal(compact.body, raw.body); assert.deepEqual(compact.bodyJson.data.capture, capture);
    const f = operationTools(raw), client = await connect(t, f.tools);
    const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture' } });
    assert.equal(result.content.length, 1); assert.equal(result.isError, false);
    assert.equal(result.structuredContent.mediaErrors.length, 1); assert.equal(result.structuredContent.data.data.saved, true);
    assert.deepEqual(result.structuredContent.data.data.capture, capture);
    assert.deepEqual(JSON.parse(result.content[0].text).data.data.capture, capture); assert.equal(f.calls(), 1);
  }
});

test('failed raw image extraction preserves every original body alias', () => {
  for (const body of [{ body: 'original business response' }, { bodyBase64: 'business value' }, { bodyBytes: new Uint8Array() }]) {
    const raw = { ok: true, statusCode: 200, requestId: 'original', headers: { 'content-type': 'image/png' }, ...body };
    const projected = projectManagerReceiptMedia(raw), compact = compactManagerReceiptMedia(projected);
    assert.equal(compact.ok, true); assert.equal(compact.statusCode, 200); assert.equal(compact.requestId, 'original');
    assert.equal(compact.media.length, 0); assert.equal(compact.mediaErrors[0].code, 'IMAGE_BASE64_INVALID');
    for (const [name, value] of Object.entries(body)) assert.deepEqual(compact[name], value);
  }
});

test('upstream image identity and transform survive projection, public descriptors and MCP', async t => {
  const capture = { ...image, imageItemId: 'native-frame:original-variant', transform: { sourceWidth: 1920, sourceHeight: 1080, scaleX: 0.5, scaleY: 0.5, offsetX: 12, offsetY: 34 } };
  const raw = receipt({ code: 0, data: { capture } });
  const projected = projectManagerReceiptMedia(raw, contract);
  assert.equal(projected.media[0].imageItemId, capture.imageItemId); assert.deepEqual(projected.media[0].transform, capture.transform);
  const f = operationTools(raw), client = await connect(t, f.tools);
  const result = await client.callTool({ name: 'rabi_call', arguments: { operation: 'fixture.capture' } });
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  assert.equal(result.structuredContent.media[0].imageItemId, capture.imageItemId);
  assert.deepEqual(result.structuredContent.media[0].transform, capture.transform);
  assert.equal(result.structuredContent.data.data.capture.imageItemId, capture.imageItemId);
  assert.deepEqual(result.structuredContent.data.data.capture.transform, capture.transform);
  assert.ok(!JSON.stringify(result.structuredContent).includes(png));
});

test('optional image MIME conditions skip non-image business values and absent captures', () => {
  const conditional = [{ path: '/data', type: 'image', matchMimeType: 'image/*' }, { path: '/data/capture', type: 'image', matchMimeType: 'image/*' }];
  for (const data of [{ size: 42, data: 'ordinary file stat' }, [{ title: 'window' }], { captureAfter: false }, { mimeType: 'text/plain', data: 'business value' }]) {
    const raw = receipt({ code: 0, data }, { 'x-rabiroute-media': JSON.stringify(conditional) });
    const result = projectManagerReceiptMedia(raw);
    assert.equal(result.media, undefined); assert.equal(result.mediaErrors, undefined);
    assert.deepEqual(result.bodyJson.data, data); assert.equal(compactManagerReceiptMedia(result).body, raw.body);
  }
  const absent = projectManagerReceiptMedia(receipt({ code: 0, data: { saved: true } }), contract);
  assert.equal(absent.media, undefined); assert.equal(absent.mediaErrors, undefined);
  for (const matchMimeType of ['image/*', 'IMAGE/PNG']) {
    const declared = { responses: { '200': { schema: { 'x-rabiroute-media': [{ path: '/data/capture', type: 'image', matchMimeType }] } } } };
    assert.equal(projectManagerReceiptMedia(receipt(), declared).media.length, 1);
  }
});

test('invalid MIME conditions report a local declaration error and keep original business data', () => {
  const raw = receipt({ code: 0, data: { mimeType: 'wrong', data: 'business value', id: 42 } });
  const result = projectManagerReceiptMedia(raw, { responses: { '200': { schema: { 'x-rabiroute-media': [{ path: '/data', type: 'image', matchMimeType: '*/*' }] } } } });
  const compact = compactManagerReceiptMedia(result);
  assert.equal(compact.mediaErrors[0].code, 'MEDIA_ENTRY_INVALID'); assert.equal(compact.body, raw.body);
  assert.equal(compact.bodyJson.data.data, 'business value'); assert.equal(compact.bodyJson.data.id, 42);
});
