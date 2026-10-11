import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
import { formatApiResult } from '../utils/api-result-view.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
async function methods(name, exported, injected) {
  const code = (await fs.readFile(new URL('../utils/' + name, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('export const ' + exported, 'const ' + exported);
  return vm.runInNewContext(code + '\n' + exported, injected);
}
test('model tools preserve the adopted persona PC and expose successful receipts to turn settlement', async () => {
  const stored = new Map(), packets = [];
  const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance', health: { live: true, requiredReady: true, state: 'healthy' } };
  const wx = { getStorageSync: key => stored.get(key), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime, formatApiResult,
    requestDeviceApi: async (_config, packet) => { packets.push(packet); return { structuredContent: { ok: true, data: packet.request.path === '/meta' ? meta : { fixture: true } } }; }
  });
  const page = { ...apiMethods, deviceAgentProfile: { revision: 1, personaRef: {sourceDeviceId: 'pc-old'} }, config: () => ({ relayBaseUrl: 'https://relay.invalid', token: 'synthetic' }),
    deviceAgentProfileConfig: () => null, agentProfileScope: () => 'fixture-scope', setKnowledgePageData() {}, speakText() {} };
  await page.prepareRabiApiTools(); page.deviceAgentProfile = { revision: 2, personaRef: {sourceDeviceId: 'pc-new'} };
  let requests = 0;
  const model = { async prompt(input) {
    const packet = JSON.parse(input[0].content); requests++;
    if (requests === 1) return JSON.stringify({ protocol: 'rabi-agent/v1', requestId: packet.requestId, kind: 'tool', name: 'rabi_api_call', arguments: { method: 'POST', path: '/api/future', body: {} } });
    assert.equal(packet.observation.outcome.result.structuredContent.data.fixture, true); return '完成。';
  } };
  const turn = createAgentTurnRuntime({ model, tools: await page.rabiApiRuntime.loadTools(), executeTool: event => page.handleRabiApiToolCall(event) });
  const result = await turn.run('测试'); assert.notEqual(result.state, 'uncertain');
  assert.deepEqual(packets.map(packet => packet.targetDeviceId), ['pc-old', 'pc-old', 'pc-old']);
  assert.ok(packets.every(packet => !Object.hasOwn(packet, 'profileRevision')));
  assert.equal(packets[1].request.headers['x-rabiroute-expected-manager-instance-id'], 'fixture-instance');
});
test('user-first history sync cannot delete a reply added while its request is in flight', async () => {
  const stored = new Map(), submissions = [], pending = [];
  const wx = { getStorageSync: key => structuredClone(stored.get(key)), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const history = await methods('aiui-conversation-page.js', 'aiuiConversationPageMethods', { wx,
    recordAiuiConversation: (_config, packet) => { submissions.push(packet); return new Promise(resolve => pending.push(resolve)); }
  });
  const profile = { revision: 1, personaRef: { roleId: 'Persona', sourceDeviceId: 'pc' } };
  const page = { ...history, deviceAgentProfile: profile, deviceAgentProfileScope: 'scope', deviceAgentProfileConfig: () => ({}), agentProfileScope: () => 'scope', setData() {} };
  const ticket = page.beginAiuiConversation('用户消息');
  page.finishAiuiConversation(ticket, '实际模型回复');
  pending[0]({ roleId: 'Persona', sourceDeviceId: 'pc' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.length, 2); assert.equal(submissions[1].assistantText, '实际模型回复');
  pending[1]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  assert.equal(stored.get('rabilink-aiui-conversation-outbox-v1').rows.length, 0);
  // A previous owner process died after user-first sync: recovery preserves that user record and releases the pending slot.
  page.beginAiuiConversation('中断前用户消息'); pending[2]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  page.recoverAiuiConversations(); pending[3]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  assert.equal(stored.get('rabilink-aiui-conversation-outbox-v1').rows.length, 0);
});
