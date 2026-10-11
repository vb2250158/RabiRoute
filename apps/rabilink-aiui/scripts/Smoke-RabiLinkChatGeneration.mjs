import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLoopModelOptions } from '../utils/agent-decision-protocol.js';
const source = fs.readFileSync(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const profileSource = fs.readFileSync(new URL('../utils/agent-profile-page.js', import.meta.url), 'utf8');
const readiness = profileSource.slice(profileSource.indexOf('  isAiuiVoiceContextReady() {'), profileSource.indexOf('  invalidateAiuiVoiceContext() {')).trim().replace(/,$/, '');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).trim().replace(/,$/, ''); }
function fixture(storageFails = false) {
  const pending = [], saved = [], spoken = [];
  const context = vm.createContext({ agentLoopModelOptions, console, Promise, Number, String, navigator: { onLine: true },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    wx: { setStorageSync: (key, value) => { if (storageFails) throw Error('disk'); saved.push({ key, value }); } },
    lingzhuLanguageModelOptions: value => ({ ...value, tools: [] }),
    LanguageModel: { availability: async () => 'available', create: () => new Promise(resolve => pending.push(resolve)) }
  });
  const methods = vm.runInContext(`({${readiness},${extract('  handleTranscriptionResult(text) {', '  async executeLingzhuAgentPrompt(')},${extract('  async ensureChatModel() {', '  async ensureConfigurationModel() {')},${extract('  cleanupChatModel() {', '  async ensureChatModel() {')}})`, context);
  // These local-name fixtures have no configured Rabi credential scope.
  const page = { ...methods, currentAgentProfileScope: () => '', browseKnowledgeResultFromSpeech: () => false, prepareRabiApiTools: async () => ({tools: [], runtime: null}), deviceAgentSystemInstructions: fallback => fallback, acknowledgeDeviceAgentProfile: async () => {}, data: { lingzhuAgentName: 'Old', lingzhuAgentId: 'id', lingzhuSystemPrompt: 'prompt' }, setData(patch) { Object.assign(this.data, patch); }, speakText(text) { spoken.push(text); } };
  return { page, pending, saved, spoken };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
test('save failure preserves active model, name and generation', () => {
  const f = fixture(true); let destroyed = 0;
  const model = { destroy() { destroyed++; } }; f.page.chatModel = model;
  f.page.handleTranscriptionResult('设置智能体为 New');
  assert.equal(f.page.data.lingzhuAgentName, 'Old'); assert.equal(f.page.chatModel, model);
  assert.equal(destroyed, 0); assert.match(f.spoken[0], /保存失败/);
});
test('rename persists full profile and fences old deferred creation without clearing replacement', async () => {
  const f = fixture(); let destroyed = 0;
  const old = f.page.ensureChatModel(); await turn();
  f.page.handleTranscriptionResult('设置智能体为 New');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saved[0].value)), { id: 'id', name: 'New', prompt: 'prompt' });
  assert.match(f.spoken[0], /本地显示名称/);
  const replacement = f.page.ensureChatModel(); await turn(); const activePromise = f.page.chatModelPromise;
  f.pending[0]({ destroy() { destroyed++; } }); assert.equal(await old, null);
  assert.equal(destroyed, 1); assert.equal(f.page.chatModelPromise, activePromise);
  const current = { destroy() {} }; f.pending[1](current); assert.equal(await replacement, current); assert.equal(f.page.chatModel, current);
});
test('cleanup destroys late session and never publishes it', async () => {
  const f = fixture(); let destroyed = 0;
  const pending = f.page.ensureChatModel(); await turn(); f.page.destroyConfigurationModel();
  f.pending[0]({ destroy() { destroyed++; } }); assert.equal(await pending, null);
  assert.equal(destroyed, 1); assert.ok(!f.page.chatModel);
});
