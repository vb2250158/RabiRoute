import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { guidancePageMethods } from '../utils/guidance-page.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
const source = await fs.readFile(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const profileSource = await fs.readFile(new URL('../utils/agent-profile-page.js', import.meta.url), 'utf8');
const readiness = profileSource.slice(profileSource.indexOf('  isAiuiVoiceContextReady() {'), profileSource.indexOf('  invalidateAiuiVoiceContext() {')).trim().replace(/,$/, '');
function extract(start, end) { const i = source.indexOf(start); const j = source.indexOf(end, i); assert.ok(i >= 0 && j > i); return source.slice(i, j).trim().replace(/,$/, ''); }
function fixture() {
  const requests = [], resolvers = [], saved = [];
  const context = vm.createContext({ console, createAgentTurnRuntime, navigator: { onLine: true }, setTimeout, clearTimeout });
  const methods = vm.runInContext(`({${readiness},${extract('  async executeChatTool(', '  cleanupChatModel()')},${extract('  onVoiceWakeup(', '  clearDeviceTokenClaimTimer()')}})`, context);
  const page = { ...methods, ...guidancePageMethods, currentAgentProfileScope: () => '', pageVisible: true, data: { agentSpeaking: true }, speechActive: true,
    setData(patch) { Object.assign(this.data, patch); }, cancelSpeech() { this.stops = (this.stops || 0) + 1; this.speechActive = false; this.data.agentSpeaking = false; },
    scheduleTranscriptionRestart() {}, appendLog() {}, applyPendingDeviceAgentProfile() { this.applied = (this.applied || 0) + 1; }, applyPendingApiTools() {},
    beginAiuiConversation(text) { return { text }; }, finishAiuiConversation(ticket, text) { saved.push({ ticket, text }); },
    speakText(text) { if (!this.aiuiSpeechSuppressed) this.spoken = (this.spoken || '') + text; }, cleanupChatModel() {},
    async ensureChatModel() { return { prompt: text => { requests.push(JSON.parse(text[0].content)); return new Promise(resolve => resolvers.push(resolve)); } }; }
  };
  return { page, requests, resolvers, saved };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('interim speech preserves inference; final guidance enters the next step of the same turn', async () => {
  const f = fixture(); const first = f.page.executeLingzhuAgentPrompt('原任务'); await tick();
  const generation = f.page.promptGeneration;
  assert.equal(f.page.stopAiuiPlaybackForInput('请先看另一个计划'), true);
  assert.equal(f.page.stops, 1); assert.equal(f.page.promptGeneration, generation);
  assert.equal(f.page.deviceAgentTurnActive, true); assert.notEqual(f.page.promptCancelled, true);
  await f.page.executeLingzhuAgentPrompt('完整的新引导');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, '原任务'); assert.equal(f.page.aiuiGuidanceQueue.length, 1);
  f.resolvers[0]('原任务本轮结果。'); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].kind, 'steering');
  assert.deepEqual(f.requests[1].text, ['完整的新引导']); assert.equal(f.page.applied, 1);
  assert.equal(f.page.deviceAgentTurnActive, true); assert.equal(f.page.promptGeneration, generation);
  assert.equal(f.page.spoken, undefined);
  f.resolvers[1]('采用引导。'); await first;
  assert.equal(f.page.deviceAgentTurnActive, false); assert.equal(f.page.applied, 2);
  assert.deepEqual(f.saved.map(row => row.ticket.text), ['原任务', '完整的新引导']);
  assert.equal(f.saved[1].text, '采用引导。'); assert.equal(f.page.spoken, '采用引导。');
});
test('wakeup preserves inference and playback echo does not interrupt', () => {
  const f = fixture(); f.page.deviceAgentTurnActive = true; f.page.aiuiPlaybackText = '已经查询完成。';
  assert.equal(f.page.stopAiuiPlaybackForInput('已经查询完成'), false); assert.equal(f.page.stops, undefined);
  f.page.onVoiceWakeup({ keyword: '唤醒词' }); assert.equal(f.page.stops, 1); assert.equal(f.page.deviceAgentTurnActive, true);
  assert.equal(f.page.stopAiuiPlaybackForInput('已经查询完成'), true); // An old utterance is not an active playback echo.
  assert.equal(f.page.aiuiSpeechSuppressed, true); // Interim input during reasoning suppresses later old-turn speech too.
  f.page.destroyed = true; f.page.aiuiGuidanceQueue = [{ text: '等待引导' }]; f.page.drainAiuiGuidance(); assert.deepEqual(f.requests, []);
});
test('pending native synthesis stays serial and cancelled late audio cannot start a new playback', async () => {
  const pending = [];
  const context = vm.createContext({ console, setTimeout, clearTimeout, TRANSCRIPTION_RESTART_DELAY_MS: 10 });
  const speech = vm.runInContext(`({${extract('  speakText(text,', '  enqueueSpeech(')},${extract('  cancelSpeech() {', '  async runAction(')}})`, context);
  const page = { ...speech, pageVisible: true, data: {}, setData(patch) { Object.assign(this.data, patch); },
    ttsAdapter: { synthesize: text => new Promise(resolve => pending.push({ text, resolve })), cancel() {} },
    recognition: {}, speechDelay: () => 10, appendLog() {}, drainAgentMessageQueue() {},
    startNextSpeech() { const next = this.speechQueue.shift(); if (next) this.speakText(next.text, next.mode, next.options); }
  };
  page.speakText('第一句。'); page.speakText('第二句。');
  assert.equal(pending.length, 1); assert.equal(page.speechQueue.length, 1); assert.equal(page.aiuiPlaybackText, '第一句。');
  page.cancelSpeech(); page.speakText('新输入回复。');
  let oldPlayed = 0, oldAborted = 0, oldDestroyed = 0;
  pending[0].resolve({ task: { abort() { oldAborted++; } }, player: { play() { oldPlayed++; }, destroy() { oldDestroyed++; } } }); await tick();
  assert.equal(oldPlayed, 0); assert.equal(oldAborted, 1); assert.equal(oldDestroyed, 1);
  assert.equal(page.speechActive, true); assert.equal(page.aiuiPlaybackText, '新输入回复。');
  let played = 0; pending[1].resolve({ task: {}, player: { play() { played++; }, destroy() {} } }); await tick();
  assert.equal(played, 1); page.cancelSpeech();
});
