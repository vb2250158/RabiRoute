import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackageStaging } from './Build-RabiLinkAiuiPackage.mjs';
import { createAiuiAsrInputAdapter, createAiuiTtsOutputAdapter } from '../utils/voice-runtime.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
import initAix, { AixReaderWasm } from '@yodaos-pkg/aix/pkg/aix_web.js';

// API-contract fixtures, not evidence of OEM microphone or speaker behavior.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-native-contract-'));
after(() => fs.rmSync(staging, { recursive: true, force: true }));
await buildPackageStaging(staging);
const aixPath = process.env.AIUI_NATIVE_CONTRACT_AIX;
if (aixPath) {
  await initAix({ module_or_path: fs.readFileSync(new URL('../node_modules/@yodaos-pkg/aix/pkg/aix_web_bg.wasm', import.meta.url)) });
  const reader = new AixReaderWasm(fs.readFileSync(path.resolve(aixPath)));
  try {
    for (const entry of reader.list()) {
      const target = path.resolve(staging, entry.name);
      if (path.relative(staging, target).startsWith('..')) throw Error('Invalid AIX path');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, reader.read_file(entry.name));
    }
  } finally { reader.free(); }
}
const pagePath = path.join(staging, 'pages/home/index.js');
fs.writeFileSync(path.join(staging, 'wx-fixture.js'), 'export default {getStorageSync(){return {}},setStorageSync(){},speech:{}};');
fs.writeFileSync(pagePath, fs.readFileSync(pagePath, 'utf8').replace(/from "wx"/g, 'from "../../wx-fixture.js"'));
const definition = (await import(pathToFileURL(pagePath).href)).default;
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
function page() {
  return { ...definition, data: { ...definition.data, isTranscriptionMode: true, isConfigurationMode: false,
    transcriptionDesired: false }, pageReady: true, pageVisible: true, destroyed: false,
    setData(patch) { Object.assign(this.data, patch); }, appendLog() {}, startTranscriptionClock() {},
    reconcileDeviceAgentReceipts() {}, speechDelay() { return 10; } };
}
class Utterance { constructor(text) { this.text = text; } }
function result(text, isFinal) { return Object.assign([{ transcript: text }], { isFinal }); }

test('continuous recognition emits each final segment once, without cumulative replay', () => {
  class Recognition { start() {} }
  const final = [], interim = [];
  const asr = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  const r = asr.createRound({ continuous: true, interimResults: true,
    onFinal(value) { final.push(value.text); }, onInterim(value) { interim.push(value.text); } });
  asr.start(r);
  r.onresult({ resultIndex: 0, results: [result('第一句', true)] });
  r.onresult({ resultIndex: 1, results: [result('第一句', true), result('第二', false)] });
  r.onresult({ resultIndex: 1, results: [result('第一句', true), result('第二句', true)] });
  r.onresult({ resultIndex: 1, results: [result('第一句', true), result('第二句', true)] });
  assert.deepEqual(final, ['第一句', '第二句']);
  assert.deepEqual(interim, ['第二']);
  r.onresult({ resultIndex: 2, results: [result('第一句', true), result('第二句', true), result('第二句', true)] });
  assert.deepEqual(final, ['第一句', '第二句', '第二句']);
});

test('conversation never falls back to an uncontrollable shared speak player', async () => {
  let spoken = 0;
  const p = page();
  p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: { speak() { spoken++; } }, SpeechSynthesisUtteranceCtor: Utterance });
  p.speakText('不能停止的音频');
  await settle();
  p.cancelSpeech();
  assert.equal(spoken, 0);
  assert.equal(p.speechActive, false);
  assert.match(p.data.agentStatus, /TTS.*不可用/);
});

test('gesture starts continuous ASR synchronously; end and timer cannot recreate it', async () => {
  let gesture = false, starts = 0;
  class Recognition {
    start() { assert.equal(gesture, true, 'SpeechRecognition.start needs the original activation'); starts++; }
    abort() { this.onend?.(); }
  }
  const p = page();
  p.pageReady = false; // Profile/owner startup has not completed; activation still belongs to this call.
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  const inputs = []; p.handleTranscriptionResult = text => inputs.push(text);
  gesture = true; p.resumeTranscription('tap'); gesture = false;
  assert.equal(starts, 1);
  assert.equal(p.recognition.continuous, true);
  p.recognition.onresult({ resultIndex: 0, results: [result('首句', true)] });
  assert.deepEqual(inputs, ['首句']);
  p.pageReady = true;
  const firstRecognition = p.recognition;
  p.recognition.onend();
  p.scheduleTranscriptionRestart(0);
  await settle();
  assert.equal(starts, 1);
  assert.equal(p.recognition, null);
  assert.match(p.data.transcriptionState, /点击|唤醒/);
  firstRecognition.onresult({ resultIndex: 1, results: [result('首句', true), result('迟到的旧输入', true)] });
  assert.deepEqual(inputs, ['首句']);
  p.pauseTranscription();
});

test('interim stops the owned player and task but preserves the pending model request', async () => {
  let stops = 0, destroys = 0, aborts = 0, reads = 0, release;
  const task = { abort() { aborts++; } };
  const player = { textTrack: {}, play() {}, stop() { stops++; }, destroy() { destroys++; } };
  class Player { constructor() { return player; } }
  const p = page();
  p.deviceAgentTurnActive = true; p.aiuiGuidanceQueue = []; p.beginAiuiConversation = () => null;
  p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: { async synthesize() { return task; } },
    SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  const requests = [];
  const model = { promptStreaming(input) {
    requests.push(input); let done = false;
    return { async read() {
      if (done) return { done: true }; done = true;
      if (requests.length === 1) { reads++; await new Promise(resolve => { release = resolve; }); }
      return { done: false, value: requests.length === 1 ? '旧回答' : '采用新输入' };
    } };
  } };
  const turn = createAgentTurnRuntime({ model, executeTool() { throw Error('unexpected tool'); },
    takeGuidance() { return p.aiuiGuidanceQueue.splice(0).map(item => item.text); } });
  const pending = turn.run('原输入'); await settle();
  p.speakText('正在播放'); await settle();
  assert.equal(p.currentSpeechAudioPlayer, player);
  p.stopAiuiPlaybackForInput('新输入');
  assert.equal(stops, 1); assert.equal(destroys, 1); assert.equal(aborts, 1);
  assert.equal(turn.getState().state, 'thinking'); assert.equal(reads, 1); assert.equal(requests.length, 1);
  p.enqueueAiuiGuidance('完整的新输入'); release();
  const output = await pending;
  assert.equal(output.state, 'completed'); assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /完整的新输入/);
  assert.equal(output.text, '采用新输入');
});

test('a synthesize result arriving after interim is aborted and never played', async () => {
  let release, plays = 0, aborts = 0, destroys = 0;
  const task = { abort() { aborts++; } };
  class Player {
    constructor() { this.textTrack = {}; }
    play() { plays++; } stop() {} destroy() { destroys++; }
  }
  const p = page(); p.deviceAgentTurnActive = true;
  p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: {
    synthesize() { return new Promise(resolve => { release = () => resolve(task); }); }
  }, SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  p.speakText('延迟合成'); p.stopAiuiPlaybackForInput('新输入'); release(); await settle();
  assert.equal(plays, 0); assert.equal(aborts, 1); assert.equal(destroys, 1);
});

test('synthesis failure remains an explicit TTS failure, never a shared-player fallback', async () => {
  let shared = 0;
  class Player {}
  const p = page(); p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: {
    speak() { shared++; }, async synthesize() { throw Error('provider failure'); }
  }, SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  p.speakText('失败合成'); await settle();
  assert.equal(shared, 0); assert.equal(p.speechActive, false);
  assert.equal(p.data.agentStatus, 'TTS 播放失败');
});

test('the actual page suppresses later old-stream speech, then speaks guidance on the same turn', async () => {
  const spoken = [], requests = []; let nextChunk, modelDestroyed = 0, modelCancelled = 0;
  class Player { constructor() { this.textTrack = {}; } play() {} stop() {} destroy() {} }
  const p = page();
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null; p.finishAiuiConversation = () => {};
  p.resumeDeviceAgentClaim = () => {}; p.ttsAdapter = createAiuiTtsOutputAdapter({
    speechSynthesisApi: { async synthesize(utterance) { spoken.push(utterance.text); return { abort() {} }; } },
    SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  const model = { destroy() { modelDestroyed++; }, promptStreaming(input) {
    const request = requests.length; requests.push(input); let step = 0;
    return { cancel() { modelCancelled++; }, async read() {
      if (request === 0) {
        if (step++ === 0) return { value: '旧句一。', done: false };
        if (step === 2) { await new Promise(resolve => { nextChunk = resolve; }); return { value: '旧句二。', done: false }; }
        return { done: true };
      }
      return step++ === 0 ? { done: false, value: '采用引导的新句。' } : { done: true };
    } };
  } };
  p.ensureChatModel = async () => model;
  const pending = p.executeLingzhuAgentPrompt('原问题'); await settle();
  assert.deepEqual(spoken, ['旧句一。']); const generation = p.promptGeneration;
  p.stopAiuiPlaybackForInput('用户说话');
  await p.executeLingzhuAgentPrompt('完整引导');
  nextChunk(); const output = await pending; await settle();
  assert.equal(output.state, 'completed'); assert.equal(p.promptGeneration, generation);
  assert.deepEqual(spoken, ['旧句一。', '采用引导的新句。']);
  assert.equal(modelDestroyed, 0); assert.equal(modelCancelled, 0); assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /完整引导/); p.cancelSpeech();
});

test('spoken configuration during a turn is guidance and cannot destroy or rename its model', () => {
  let destroyed = 0;
  const p = page(); p.deviceAgentTurnActive = true; p.aiuiGuidanceQueue = [];
  p.beginAiuiConversation = () => null; p.chatModel = { destroy() { destroyed++; } };
  p.promptGeneration = 17; p.promptCancelled = false;
  p.browseKnowledgeResultFromSpeech = () => false;
  const name = p.data.lingzhuAgentName;
  p.handleTranscriptionResult('设置智能体为 新名称');
  assert.equal(destroyed, 0); assert.equal(p.data.lingzhuAgentName, name);
  assert.equal(p.promptGeneration, 17); assert.equal(p.promptCancelled, false);
  assert.equal(p.aiuiGuidanceQueue.length, 1); assert.equal(p.aiuiGuidanceQueue[0].text, '设置智能体为 新名称');
});

test('a genuine wake during model or speech activity starts only a missing recognizer synchronously', () => {
  let activation = false, starts = 0, destroyed = 0;
  class Recognition { start() { assert.equal(activation, true); starts++; } abort() {} }
  const p = page(); p.deviceAgentTurnActive = true; p.promptGeneration = 23;
  p.chatModel = { destroy() { destroyed++; } }; p.data.assistantModelBusy = true;
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  activation = true; p.onVoiceWakeup({ keyword: 'leqi' }); activation = false;
  assert.equal(starts, 1); const first = p.recognition;
  p.data.agentSpeaking = true;
  activation = true; p.onVoiceWakeup({ keyword: 'leqi' }); activation = false;
  assert.equal(starts, 1); assert.equal(p.recognition, first);
  assert.equal(p.promptGeneration, 23); assert.equal(destroyed, 0);
  p.pauseTranscription();
});

test('early continuous finals wait for the confirmed persona and owner before history or model creation', async t => {
  const p = page(); let releaseProfile, releaseRead, starts = 0, modelCalls = 0;
  const history = [], contexts = [], requests = [];
  t.after(() => { p.destroyed = true; releaseRead?.(); p.pauseTranscription(); p.cancelSpeech(); });
  const profile = { id: 'confirmed-persona', name: 'Confirmed' };
  p.currentAgentProfileScope = () => 'configured-scope';
  p.refreshDeviceAgentProfile = async () => {
    await new Promise(resolve => { releaseProfile = resolve; });
    p.deviceAgentProfile = profile; return { ok: true, applied: true };
  };
  p.refreshApiTools = async () => {};
  p.startDeviceAgentOwner = async () => {
    p.deviceAgentOwner = { context: { targetDeviceId: 'confirmed-pc' } };
    p.rabiApiRuntime = {}; p.chatModelApiRuntime = p.rabiApiRuntime;
    p.chatModelApiScope = 'configured-scope'; p.chatModelApiToolsCount = 2;
  };
  p.deviceAgentTurnContext = () => { const value = p.deviceAgentOwner?.context; contexts.push(value); return value; };
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.beginAiuiConversation = text => {
    const ticket = { text, persona: p.deviceAgentProfile?.id }; history.push(ticket); return ticket;
  };
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
  p.ensureChatModel = async () => {
    modelCalls++; return { promptStreaming(input) {
      const index = requests.length; requests.push(input); let read = false;
      return { async read() { if (read) return { done: true }; read = true;
        if (index === 0) await new Promise(resolve => { releaseRead = resolve; });
        return { done: false, value: index ? '引导答案' : '首句答案' }; } };
    } };
  };
  class Recognition { start() { starts++; } abort() {} }
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.resumeTranscription('tap'); await settle(); const recognizer = p.recognition;
  recognizer.onresult({ resultIndex: 0, results: [result('第一句', true)] });
  recognizer.onresult({ resultIndex: 1, results: [result('第一句', true), result('第二句', true)] });
  assert.equal(history.length, 0, 'The first final must not create history before profile confirmation');
  assert.equal(p.aiuiVoiceInitialInputs.length, 2);
  assert.equal(contexts.length, 0); assert.equal(modelCalls, 0);
  releaseProfile(); await p.aiuiVoiceContextPromise; await settle();
  assert.equal(starts, 1); assert.equal(p.recognition, recognizer);
  assert.equal(modelCalls, 1); assert.equal(contexts[0].targetDeviceId, 'confirmed-pc');
  assert.equal(history[0].persona, 'confirmed-persona');
  // Guidance can already be consumed before the first streaming read starts.
  assert.match(JSON.stringify(requests), /第二句/);
  releaseRead(); await settle(); await settle();
  assert.equal(history[1].persona, 'confirmed-persona');
  assert.deepEqual(history.map(item => item.text), ['第一句', '第二句']); p.pauseTranscription(); p.cancelSpeech();
});

test('failed configured profile retains finals without starting an unbound model; no credentials stays standalone', async () => {
  const p = page(); let models = 0, owners = 0;
  p.currentAgentProfileScope = () => 'configured';
  p.refreshDeviceAgentProfile = async () => ({ ok: false });
  p.refreshApiTools = async () => {}; p.startDeviceAgentOwner = async () => { owners++; };
  p.ensureChatModel = async () => { models++; };
  p.handleTranscriptionResult('保留首句'); await p.aiuiVoiceContextPromise;
  assert.deepEqual(p.aiuiVoiceInitialInputs.map(item => item.text), ['保留首句']);
  assert.equal(models, 0); assert.equal(owners, 0); assert.equal(p.isAiuiVoiceContextReady(), false);
  assert.match(p.data.agentStatus, /尚未确认.*保留/);
  const standalone = page(); standalone.currentAgentProfileScope = () => '';
  assert.equal(standalone.isAiuiVoiceContextReady(), true);
  let invoked = '';
  standalone.executeLingzhuAgentPrompt = text => { invoked = text; };
  standalone.handleTranscriptionResult('本地原生对话'); assert.equal(invoked, '本地原生对话');
});

test('hidden or replaced scope cannot flush an old initialization into a later page', async () => {
  for (const hide of [true, false]) {
    const p = page(); let scope = 'first', release, calls = 0;
    p.currentAgentProfileScope = () => scope;
    p.refreshDeviceAgentProfile = async () => {
      await new Promise(resolve => { release = resolve; }); return { ok: true, applied: true };
    };
    p.refreshApiTools = async () => {}; p.startDeviceAgentOwner = async () => { calls++; p.deviceAgentOwner = {}; };
    p.handleTranscriptionResult('旧首句'); const pending = p.aiuiVoiceContextPromise;
    if (hide) { p.pageVisible = false; p.invalidateAiuiVoiceContext(); }
    else { scope = 'second'; p.synchronizeAgentProfileScope(scope); }
    release(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(calls, 0);
    assert.equal(p.aiuiVoiceInitialInputs.length, 0); assert.equal(p.aiuiVoiceContextReady, false);
  }
});

test('resolved API refresh with missing or old model tools never confirms a configured voice context', async () => {
  for (const stale of [false, true]) {
    const p = page(); let history = 0;
    p.currentAgentProfileScope = () => 'current';
    p.refreshDeviceAgentProfile = async () => ({ ok: true, applied: true });
    p.refreshApiTools = async () => undefined;
    p.startDeviceAgentOwner = async () => { p.deviceAgentOwner = {}; };
    p.beginAiuiConversation = () => { history++; };
    if (stale) {
      p.rabiApiRuntime = {}; p.chatModelApiRuntime = p.rabiApiRuntime;
      p.chatModelApiScope = 'old'; p.chatModelApiToolsCount = 2;
    }
    p.handleTranscriptionResult('保留接口未确认输入');
    const result = await p.aiuiVoiceContextPromise;
    assert.equal(result.code, 'VOICE_API_UNCONFIRMED'); assert.equal(history, 0);
    assert.equal(p.aiuiVoiceContextReady, false); assert.equal(p.aiuiVoiceInitialInputs.length, 1);
  }
});
