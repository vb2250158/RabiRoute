import assert from 'node:assert/strict';
import test from 'node:test';
import { plugin_init, plugin_cleanup } from './index.mjs';
test('native favorite names use the existing OneBot router and preserve upstream actions', async () => {
  const upstreamActions = new Map();
  const originalGet = name => upstreamActions.get(name);
  const actions = { get: originalGet, call: () => 'existing-call' };
  const context = { actions, core: { context: { session: { getMsgService: () => ({
    fetchFavEmojiList: async (...args) => {
      assert.deepEqual(args, ['', 48, true, true]);
      return { result: 0, emojiInfoList: [{ md5: 'test-id', desc: '谢谢', url: 'native-media', uin: 'private-account', emoPath: 'private-path' }] };
    }
  }) } } } };
  await plugin_init(context);
  const action = actions.get('fetch_custom_face_detail');
  const response = await action.handle({ count: 48 });
  assert.deepEqual(response.data, [{ md5: 'test-id', desc: '谢谢', url: 'native-media' }]);
  assert.equal((await action.handle({ count: 1001 })).retcode, 1400);
  await plugin_cleanup();
  assert.equal(actions.get, originalGet);
  assert.equal(actions.call(), 'existing-call');
  const upstream = {};
  upstreamActions.set('fetch_custom_face_detail', upstream);
  await plugin_init(context);
  await plugin_cleanup();
  assert.equal(actions.get('fetch_custom_face_detail'), upstream);
});

test('a broken native favorite row preserves healthy HTTP/WS results and reports partial data without changing the collection', async t => {
  t.after(plugin_cleanup);
  const first = { md5: 'original-first', desc: 'first', url: 'native-first' };
  const last = { md5: 'original-last', url: 'native-last' };
  const unreadable = { get md5() { throw new Error('private native error'); } };
  const collection = [first, null, { md5: 'no-url' }, unreadable, last];
  const actions = { get() {} };
  let requested;
  await plugin_init({ actions, core: { context: { session: { getMsgService: () => ({
    async fetchFavEmojiList(...args) { requested = args; return { result: 0, emojiInfoList: collection }; }
  }) } } } });
  const action = actions.get('fetch_custom_face_detail');
  for (const response of [await action.handle({ count: 5 }, null, null, null, 'http-echo'), await action.websocketHandle({ count: 5 }, 'ws-echo')]) {
    assert.equal(response.status, 'ok');
    assert.equal(response.retcode, 0);
    assert.equal(response.partial, true);
    assert.deepEqual(response.data, [first, { ...last, desc: '' }]);
    assert.deepEqual(response.diagnostics.map(row => row.rowIndex), [1, 2, 3]);
    assert.equal(JSON.stringify(response).includes('private native error'), false);
  }
  assert.deepEqual(requested, ['', 5, true, true]);
  assert.equal(collection.length, 5);
  assert.equal(collection[0], first);
  assert.equal(collection[4], last);
  assert.equal(Object.hasOwn(last, 'desc'), false);
});

test('a whole native favorite request failure stays a failure instead of an empty successful collection', async t => {
  t.after(plugin_cleanup);
  const actions = { get() {} };
  await plugin_init({ actions, core: { context: { session: { getMsgService: () => ({
    async fetchFavEmojiList() { throw new Error('native request failed'); }
  }) } } } });
  const response = await actions.get('fetch_custom_face_detail').handle({});
  assert.equal(response.status, 'failed');
  assert.equal(response.data, null);
  assert.equal(response.partial, undefined);
});
