import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { guidancePageMethods } from '../utils/guidance-page.js';
import { createPageAssistantFixture } from './AssistantSessionFixture.mjs';
import { requestTimeout } from '../utils/timeout-settings.js';
import { getAgentProtocolFailureReason } from '../utils/agent-decision-protocol.js';
import { createSpeechPlayback } from '../../../packages/assistant-runtime/src/speech-playback.js';
import { attachPageVoiceFixture } from './VoicePageFixture.mjs';
const source = await fs.readFile(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const profileSource = await fs.readFile(new URL('../utils/agent-profile-page.js', import.meta.url), 'utf8');
const readiness = profileSource.slice(profileSource.indexOf('  isAiuiVoiceContextReady() {'), profileSource.indexOf('  invalidateAiuiVoiceContext() {')).trim().replace(/,$/, '');
function extract(start, end) { const i = source.indexOf(start); const j = source.indexOf(end, i); assert.ok(i >= 0 && j > i); return source.slice(i, j).trim().replace(/,$/, ''); }
function fixture() {
  const requests = [], resolvers = [], saved = [];
  const storage = new Map(); let storageFailure = false;
  const context = vm.createContext({ console, requestTimeout, getAgentProtocolFailureReason, navigator: { onLine: true }, setTimeout, clearTimeout,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => { if (storageFailure) throw Error('full'); storage.set(key, JSON.parse(JSON.stringify(value))); } } });
  const methods = vm.runInContext(`({${readiness},${extract('  async executeChatTool(', '  cleanupChatModel()')},${extract('  onVoiceWakeup(', '  clearDeviceTokenClaimTimer()')}})`, context);
  const page = { ...methods, ...guidancePageMethods, currentAgentProfileScope: () => '', pageVisible: true, data: { agentSpeaking: true }, speechActive: true,
    setData(patch) { Object.assign(this.data, patch); }, cancelSpeech() { this.stops = (this.stops || 0) + 1; this.speechActive = false; this.data.agentSpeaking = false; },
    scheduleTranscriptionRestart() {}, appendLog() {}, applyPendingDeviceAgentProfile() { this.applied = (this.applied || 0) + 1; }, applyPendingApiTools() {},
    beginAiuiConversation(text) { return { text }; }, finishAiuiConversation(ticket, text) { saved.push({ ticket, text }); },
    speakText(text) { if (!this.aiuiSpeechSuppressed) this.spoken = (this.spoken || '') + text; }, cleanupChatModel() {},
    async ensureChatModel() { return this.chatAssistant; }
  };
  page.chatAssistant = createPageAssistantFixture(page, { prompt: text => { requests.push(JSON.parse(text[0].content)); return new Promise(resolve => resolvers.push(resolve)); } });
  page.config = () => ({});
  return { page, requests, resolvers, saved, storage, failStorage: value => { storageFailure = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const toolReply = (packet, path = '/fixture/slow') => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId,
  kind: 'tool', name: 'rabi_api_call', arguments: { method: 'GET', path } });
const answerReply = packet => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId,
  kind: 'interjection', inputId: packet.input.id, disposition: 'answer', text: '插话答案。' });
const ledgerRows = f => f.storage.get('rabilink-aiui-independent-inputs-v1')?.rows || [];
async function waitingTool() {
  const f = fixture(); let finishTool; const calls = [];
  f.page.chatModelAgentTools = ['rabi_api_call'];
  f.page.executeChatTool = event => { calls.push(event); return calls.length === 1 ? new Promise(resolve => { finishTool = resolve; }) : { result: { structuredContent: { ok: true } } }; };
  const run = f.page.executeLingzhuAgentPrompt('原任务'); await tick();
  f.resolvers[0](toolReply(f.requests[0])); await tick();
  return { ...f, run, calls, finishTool: () => finishTool({ result: { structuredContent: { ok: true, receipt: 'original' } } }) };
}

test('tool-wait input has its own durable record, answer and history without replacing the original task', async () => {
  const f = await waitingTool();
  f.page.stopAiuiPlaybackForInput('插话'); await f.page.executeLingzhuAgentPrompt('独立问题'); await tick();
  assert.equal(f.requests[1].kind, 'independent-input'); assert.equal(ledgerRows(f)[0].status, 'submitted');
  f.resolvers[1](answerReply(f.requests[1])); await tick();
  assert.equal(ledgerRows(f)[0].status, 'answered'); assert.equal(f.page.spoken, '插话答案。');
  assert.equal(f.saved[0].ticket.text, '独立问题'); assert.equal(f.saved[0].text, '插话答案。');
  assert.equal(f.calls.length, 1); f.finishTool(); await tick(); f.resolvers[2]('原任务结果。');
  assert.equal((await f.run).text, '原任务结果。'); assert.equal(f.saved[1].ticket.text, '原任务');
  assert.equal(f.saved[1].text, '原任务结果。');
});

test('deferred tool input keeps the same ID and history ticket for a fresh decision after the original receipt', async () => {
  const f = await waitingTool(); await f.page.executeLingzhuAgentPrompt('追加任务'); await tick();
  const id = f.requests[1].input.id;
  f.resolvers[1](toolReply(f.requests[1], '/must-not-run')); await tick();
  assert.equal(ledgerRows(f)[0].status, 'deferred'); assert.equal(f.calls.length, 1);
  f.finishTool(); await tick(); f.resolvers[2]('原任务结果。'); await f.run; await tick();
  assert.equal(f.requests[3].text, '追加任务'); assert.equal(f.requests[3].requestId, id + ':step-1');
  assert.equal(ledgerRows(f)[0].status, 'running');
  f.resolvers[3](toolReply(f.requests[3], '/reviewed-new-action')); await tick();
  assert.equal(f.calls[1].arguments.path, '/reviewed-new-action'); assert.equal(f.calls[1].callId, id + ':call-1');
  f.resolvers[4]('追加结果。'); await tick();
  assert.equal(ledgerRows(f)[0].status, 'completed'); assert.equal(ledgerRows(f).length, 1);
  assert.deepEqual(f.saved.map(row => row.ticket.text), ['原任务', '追加任务']);
});

test('storage failure before dispatch cannot silently submit an independent input', async () => {
  const f = await waitingTool(); f.failStorage(true);
  await f.page.executeLingzhuAgentPrompt('无法保存的新任务'); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.page.data.assistantReplyText, '无法保存的新任务');
  assert.equal(f.page.aiuiGuidanceQueue?.length || 0, 0);
  f.failStorage(false); f.finishTool(); await tick(); f.resolvers[1]('原结果'); await f.run;
});

test('failed answer settlement keeps a recoverable reservation without speech or automatic replay', async () => {
  const f = await waitingTool(); await f.page.executeLingzhuAgentPrompt('独立问题'); await tick();
  f.failStorage(true); f.resolvers[1](answerReply(f.requests[1])); await tick();
  assert.equal(ledgerRows(f)[0].status, 'submitted'); assert.equal(f.page.spoken, undefined);
  f.failStorage(false); f.page.recoverAiuiInputs();
  assert.equal(ledgerRows(f)[0].status, 'unconfirmed'); assert.equal(f.requests.length, 2);
  f.finishTool(); await tick(); f.resolvers[2]('原结果'); await f.run;
  assert.equal(f.requests.length, 3); assert.equal(f.calls.length, 1);
});

test('a later utterance suppresses the older independent answer but retains both records', async () => {
  const f = await waitingTool(); await f.page.executeLingzhuAgentPrompt('问题一'); await tick();
  f.page.stopAiuiPlaybackForInput('问题二'); await f.page.executeLingzhuAgentPrompt('问题二'); await tick();
  f.resolvers[1](answerReply(f.requests[1])); await tick();
  assert.equal(f.page.spoken, undefined); assert.equal(f.requests.length, 3);
  f.resolvers[2](answerReply(f.requests[2])); await tick(); assert.equal(f.page.spoken, '插话答案。');
  assert.deepEqual(ledgerRows(f).map(row => row.status), ['answered','answered']);
  f.finishTool(); await tick(); f.resolvers[3]('原结果'); await f.run;
});

test('changed binding cannot move a deferred input into the replacement task', async () => {
  const f = await waitingTool(); await f.page.executeLingzhuAgentPrompt('追加任务'); await tick();
  f.resolvers[1](toolReply(f.requests[1])); await tick();
  f.page.deviceAgentProfile = { revision: 2 }; f.finishTool(); await f.run; await tick();
  assert.equal(ledgerRows(f)[0].status, 'deferred'); assert.equal(f.requests.length, 2);
  assert.equal(f.calls.length, 1); assert.equal(f.page.aiuiGuidanceQueue.length, 0);
});
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
  const context = vm.createContext({ console, createSpeechPlayback, cloudSafeMessage: String, requestTimeout, TRANSCRIPTION_RESTART_DELAY_MS: 10 });
  const speech = vm.runInContext(`({${extract('  ensureSpeechPlayback()', '  async runAction(')}})`, context);
  const page = { ...speech, pageVisible: true, data: {}, setData(patch) { Object.assign(this.data, patch); },
    ttsAdapter: { synthesize: text => new Promise(resolve => pending.push({ text, resolve })), cancel() {} },
    recognition: {}, appendLog() {}, drainAgentMessageQueue() {}
  };
  page.config = () => ({});
  attachPageVoiceFixture(page);
  page.speakText('第一句。'); page.speakText('第二句。'); await tick();
  assert.equal(pending.length, 1); assert.equal(page.speechPlayback.getState().queued, 1); assert.equal(page.aiuiPlaybackText, '第一句。');
  page.cancelSpeech(); page.speakText('新输入回复。'); await tick();
  let oldPlayed = 0, oldAborted = 0, oldDestroyed = 0;
  pending[0].resolve({ task: { abort() { oldAborted++; } }, player: { play() { oldPlayed++; }, destroy() { oldDestroyed++; } } }); await tick();
  assert.equal(oldPlayed, 0); assert.equal(oldAborted, 1); assert.equal(oldDestroyed, 1);
  assert.equal(page.speechActive, true); assert.equal(page.aiuiPlaybackText, '新输入回复。');
  let played = 0; pending[1].resolve({ task: {}, player: { play() { played++; }, destroy() {} } }); await tick();
  assert.equal(played, 1); page.cancelSpeech();
});
