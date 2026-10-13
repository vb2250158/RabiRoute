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
