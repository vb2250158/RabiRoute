import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeReceipt, isStrongEtag, stableKey } from '../lib/knowledge-receipt.mjs';
const good = () => ({ statusCode: 200, ok: true, body: JSON.stringify({ code: 0, data: { id: 'p1' } }), headers: { ETag: '"v1"', 'Idempotency-Key': 'key-1' } });
const expected = { mutation: true, idempotencyKey: 'key-1', resourceId: 'p1' };
test('strong etags and explicit stable keys', () => {
  assert.ok(isStrongEtag('"v1"'));
  for (const value of ['*', 'W/"v1"', 'v1', '""', '"a\nb"']) assert.equal(isStrongEtag(value), false);
  for (const value of ['', undefined, 'a\nb', 'a b']) assert.throws(() => stableKey(value));
});
test('confirmed write requires exact key, strong etag and resource identity', () => {
  assert.equal(knowledgeReceipt(good(), expected).commitState, 'committed');
  for (const change of [r => r.headers.ETag = 'W/"v1"', r => r.headers['Idempotency-Key'] = 'different', r => r.body = '{"code":0,"data":{"id":"other"}}']) {
    const r = good(); change(r); const result = knowledgeReceipt(r, expected);
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
  }
});
test('read details reject the wrong resource and changed generation', () => {
  assert.equal(knowledgeReceipt(good(), { resourceId: 'p1' }).ok, true);
  assert.equal(knowledgeReceipt(good(), { resourceId: 'other' }).ok, false);
  assert.equal(knowledgeReceipt({ ...good(), identityChanged: true }).ok, false);
});
test('uncertainty, committed errors, malformed responses and conflict preserve boundaries', () => {
  for (const receipt of [{ ...good(), uncertain: true }, { ...good(), identityChanged: true }, { statusCode: 503, body: '{}' }, { statusCode: 0 }, { ...good(), body: 'invalid' }]) assert.equal(knowledgeReceipt(receipt, expected).ok, false);
  const committed = knowledgeReceipt({ statusCode: 503, body: { code: -1, commitState: 'committed' } }, expected);
  assert.equal(committed.commitState, 'committed'); assert.equal(committed.uncertain, true);
  const conflict = knowledgeReceipt({ statusCode: 412, body: { code: -1, commitState: 'not_started' } }, expected);
  assert.equal(conflict.commitState, 'not_started'); assert.equal(conflict.uncertain, false);
  assert.equal(knowledgeReceipt({ ...good(), body: { code: 0, commitState: 'unknown', data: { id: 'p1' } } }, expected).uncertain, true);
});
