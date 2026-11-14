import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandaloneConversation } from '../src/conversation.mjs';
import { createChatModel } from '@rabilink/desktop-voice-service/chat-model';

test('caption changes preserve multi-turn model context and accepted request IDs do not resend', async () => {
  let settings = { persona: '测试助手', llmEndpoint: 'https://example.com/chat/completions', llmModel: 'fixture', captionFontSize: 24 };
  const requests = []; let modelCount = 0;
  const native = createStandaloneConversation({ settings: () => settings, credentials: { resolve: async () => undefined }, onError: error => { throw error; },
    createModel: options => { modelCount++; return createChatModel({ ...options, fetcher: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '已收到。' } }] }) + '\n\ndata: [DONE]\n\n');
    } }); },
  });
  try {
    await native.submit('第一句话', 'first'); await native.drain();
    await native.submit('第二句话', 'second'); await native.drain();
    settings = { ...settings, captionFontSize: 32 };
    assert.deepEqual(native.configure(), { applied: false, deferred: false });
    await native.submit('第三句话', 'third'); await native.drain();
    await native.submit('第三句话', 'third'); await native.drain();
    assert.equal(modelCount, 1); assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests[2].messages).includes('第一句话'));
    assert.ok(JSON.stringify(requests[2].messages).includes('第二句话'));
    assert.equal(native.messages().filter(item => item.role === 'assistant').length, 3);
  } finally { native.close(); await native.drain(); }
});
