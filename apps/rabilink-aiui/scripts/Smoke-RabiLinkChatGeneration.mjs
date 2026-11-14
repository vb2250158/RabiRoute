import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rabiAgentProtocol, getAgentProtocolFailureReason } from '../utils/agent-decision-protocol.js';
import { rabiAgentToolPolicy } from '../utils/rabi-agent-tool-policy.js';
import { createAiuiAssistantRuntime } from '../../../packages/assistant-runtime/src/aiui-runtime.js';
import { attachPageVoiceFixture } from './VoicePageFixture.mjs';
import { lingzhuLanguageModelOptions } from '../utils/voice-command.js';
import { requestTimeout } from '../utils/timeout-settings.js';
import { taskFollowPageMethods } from '../utils/task-follow-page.js';
const source = fs.readFileSync(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const profileSource = fs.readFileSync(new URL('../utils/agent-profile-page.js', import.meta.url), 'utf8');
const readiness = profileSource.slice(profileSource.indexOf('  isAiuiVoiceContextReady() {'), profileSource.indexOf('  invalidateAiuiVoiceContext() {')).trim().replace(/,$/, '');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).trim().replace(/,$/, ''); }
function fixture(storageFails = false, timeout = requestTimeout, online = true) {
  const pending = [], saved = [], spoken = [], modelOptions = [];
  const context = vm.createContext({ rabiAgentProtocol, getAgentProtocolFailureReason, rabiAgentToolPolicy, requestTimeout: timeout, console, Promise, Number, String, navigator: { onLine: online },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    wx: { setStorageSync: (key, value) => { if (storageFails) throw Error('disk'); saved.push({ key, value }); } },
    lingzhuLanguageModelOptions,
    LanguageModel: { availability: async () => 'available', create: options => { modelOptions.push(options); return new Promise(resolve => pending.push(resolve)); } }
  });
  const methods = vm.runInContext(`({${readiness},${extract('  handleTranscriptionResult(text) {', '  async executeLingzhuAgentPrompt(')},${extract('  async executeLingzhuAgentPrompt(', '  recognitionStartupTimeoutMs() {')},${extract('  async ensureChatModel() {', '  async ensureConfigurationModel() {')},${extract('  cleanupChatModel() {', '  async ensureChatModel() {')}})`, context);
  // These local-name fixtures have no configured Rabi credential scope.
  const page = { ...methods, ...taskFollowPageMethods, currentAgentProfileScope: () => '', browseKnowledgeResultFromSpeech: () => false, prepareRabiApiTools: async () => ({tools: [], runtime: null}), deviceAgentSystemInstructions: fallback => fallback, acknowledgeDeviceAgentProfile: async () => {}, data: { lingzhuAgentName: 'Old', lingzhuAgentId: 'id', lingzhuSystemPrompt: 'prompt' }, setData(patch) { Object.assign(this.data, patch); }, speakText(text) { spoken.push(text); } };
  page.config = () => ({});
  attachPageVoiceFixture(page);
  return { page, pending, saved, spoken, modelOptions };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

function prepareConversation(page) {
  page.pageVisible = true;
  page.applyPendingDeviceAgentProfile = () => {};
  page.applyPendingApiTools = () => {};
  page.finishAiuiConversation = () => {};
}

test('an offline navigator hint does not block host model creation or a successful conversation', async () => {
  const f = fixture(false, requestTimeout, false);
  prepareConversation(f.page);
  let requests = 0;
  const response = f.page.executeLingzhuAgentPrompt('测试宿主');
  await turn();
  assert.equal(f.pending.length, 1, 'The host must be asked instead of guessing service reachability');
  f.pending[0]({ prompt: async () => { requests++; return '宿主可用。'; }, destroy() {} });
  const result = await response;
  assert.equal(result.state, 'completed');
  assert.equal(requests, 1);
  assert.equal(f.page.data.assistantReplyText, '宿主可用。');
  assert.equal(f.page.data.assistantModelBusy, false);
  assert.equal(f.page.deviceAgentTurnActive, false);
  f.page.cleanupChatModel();
});

test('an offline navigator hint cannot overwrite the actual turn failure', async () => {
  const f = fixture(false, requestTimeout, false);
  prepareConversation(f.page);
  let calls = 0;
  f.page.ensureChatModel = async () => ({ run: async () => {
    calls++;
    throw Object.assign(new Error('deadline'), { code: 'TURN_TIMEOUT' });
  }, cancel() {} });
  const result = await f.page.executeLingzhuAgentPrompt('测试超时');
  assert.equal(calls, 1);
  assert.equal(result.errorCode, 'TURN_TIMEOUT');
  assert.equal(f.page.data.assistantReplyText, '模型响应超时，当前请求已停止');
  assert.equal(f.page.data.assistantModelBusy, false);
  assert.equal(f.page.deviceAgentTurnActive, false);
});
test('save failure preserves active model, name and generation', () => {
  const f = fixture(true); let destroyed = 0;
  const model = { dispose() { destroyed++; } }; f.page.chatAssistant = model;
  f.page.handleTranscriptionResult('设置智能体为 New');
  assert.equal(f.page.data.lingzhuAgentName, 'Old'); assert.equal(f.page.chatAssistant, model);
  assert.equal(destroyed, 0); assert.match(f.spoken[0], /保存失败/);
});
test('rename persists full profile and fences old deferred creation without clearing replacement', async () => {
  const f = fixture(); let destroyed = 0;
  const old = f.page.ensureChatModel(); await turn();
  f.page.handleTranscriptionResult('设置智能体为 New');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saved[0].value)), { id: 'id', name: 'New', prompt: 'prompt' });
  assert.match(f.spoken[0], /本地显示名称/);
  const replacement = f.page.ensureChatModel(); await turn(); const activePromise = f.page.chatModelPromise;
  f.pending[0]({ destroy() { destroyed++; } }); assert.equal(await old, null); await turn();
  assert.equal(destroyed, 1); assert.equal(f.page.chatModelPromise, activePromise);
  const current = { prompt: async () => '当前回答', destroy() {} }; f.pending[1](current);
  const assistant = await replacement; assert.equal(f.page.chatAssistant, assistant); assert.equal(assistant.getState().ready, true);
  assert.match(f.modelOptions[1].initialPrompts[0].content, /\n\nprompt$/);
  assert.deepEqual(f.modelOptions[1].tools, []);
  assert.equal((await assistant.run('测试')).text, '当前回答'); f.page.cleanupChatModel();
});
test('cleanup destroys late session and never publishes it', async () => {
  const f = fixture(); let destroyed = 0;
  const pending = f.page.ensureChatModel(); await turn(); f.page.destroyConfigurationModel();
  f.pending[0]({ destroy() { destroyed++; } }); assert.equal(await pending, null); await turn();
  assert.equal(destroyed, 1); assert.ok(!f.page.chatAssistant);
});

test('model creation keeps its own configured deadline and destroys a late result', async () => {
  const f = fixture(false, (_config, _device, operation) => operation === 'aiui.model.create' ? 15 : 1000);
  let destroyed = 0;
  await assert.rejects(f.page.ensureChatModel(), /创建模型会话超时/);
  assert.equal(f.page.chatModelPromise, null); assert.ok(!f.page.chatAssistant);
  f.pending[0]({ prompt: async () => '迟到', destroy() { destroyed++; } }); await turn();
  assert.equal(destroyed, 1); assert.ok(!f.page.chatAssistant);
});
