import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackageStaging } from './Build-RabiLinkAiuiPackage.mjs';
import { createAiuiAsrInputAdapter, createAiuiTtsOutputAdapter } from '../utils/voice-runtime.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
import { createPageAssistantFixture } from './AssistantSessionFixture.mjs';
import { hudDisplayFields } from '../utils/hud-text.js';
import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { createAiuiAssistantRuntime } from '../../../packages/assistant-runtime/src/aiui-runtime.js';
import { rabiAgentProtocol } from '../utils/agent-decision-protocol.js';
import { rabiAgentToolPolicy } from '../utils/rabi-agent-tool-policy.js';
import initAix, { AixReaderWasm } from '@yodaos-pkg/aix/pkg/aix_web.js';

// API-contract fixtures, not evidence of OEM microphone or speaker behavior.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-native-contract-'));
after(() => fs.rmSync(staging, { recursive: true, force: true }));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--aix' || !args[1])) {
  throw Error('Usage: node Test-AiuiNativeVoiceContract.mjs [--aix <archive>]');
}
const aixPath = args[1] || process.env.AIUI_NATIVE_CONTRACT_AIX;
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
  console.log('Testing supplied AIX VERSION:', fs.readFileSync(path.join(staging, 'VERSION'), 'utf8').trim());
} else {
  await buildPackageStaging(staging);
}
const pagePath = path.join(staging, 'pages/home/index.js');
// The temporary fixture is outside the project's ESM package boundary.
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ type: 'module' }));
fs.writeFileSync(path.join(staging, 'wx-fixture.js'), 'const values=new Map();export default {getStorageSync(key){return values.get(key)},setStorageSync(key,value){values.set(key,JSON.parse(JSON.stringify(value)))},speech:{}};');
fs.writeFileSync(pagePath, fs.readFileSync(pagePath, 'utf8').replace(/from "wx"/g, 'from "../../wx-fixture.js"'));
const definition = (await import(pathToFileURL(pagePath).href)).default;
const fixtureWx = (await import(pathToFileURL(path.join(staging, 'wx-fixture.js')).href)).default;
test('packaged app declares microphone capture permission', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'app.json'), 'utf8'));
  assert.ok(manifest.permissions?.includes('RECORD_AUDIO'),
    'Host microphone capture requires RECORD_AUDIO in the packaged app.json');
});
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const pages = new Set();
after(() => { for (const p of pages) { p.cancelSpeech(); p.stopRecognition(); p.voiceInteraction?.dispose(); p.aiuiRuntime?.dispose(); } });
function page() {
  const p = { ...definition, data: { ...definition.data, isTranscriptionMode: true, isConfigurationMode: false,
    transcriptionDesired: false }, pageReady: true, pageVisible: true, destroyed: false,
    setData(patch) { Object.assign(this.data, patch); }, appendLog() {}, startTranscriptionClock() {},
    reconcileDeviceAgentReceipts() {} };
  // Mirror onLoad's resource ownership without replacing compiled page methods.
  // Individual tests still inject native ASR/TTS resources below.
  let resources;
  Object.defineProperty(p, 'aiuiRuntime', { configurable: true,
    get() { return resources ||= createAiuiAssistantRuntime({
      asr: {
        createRound: handlers => p.asrAdapter?.createRound(handlers) || { handlers },
        start: round => p.asrAdapter?.start(round),
        stop: (round, options) => p.asrAdapter?.stop(round, options)
      },
      tts: { canSynthesize: () => p.ttsAdapter?.canSynthesize?.() ?? (Boolean(p.ttsAdapter?.synthesize) || p.speakText !== definition.speakText), async synthesize(text, options) {
        if (p.ttsAdapter?.synthesize) return p.ttsAdapter.synthesize(text, options);
        if (p.speakText === definition.speakText) throw Error('No TTS configured in fixture');
        p.speakText(text);
        const audioPlayer = new EventTarget();
        return { task: { abort() {} }, player: { audioPlayer,
          play() { queueMicrotask(() => audioPlayer.dispatchEvent(new Event('ended'))); }, destroy() {} } };
      } }
    }); }, set(value) { resources = value; }
  });
  pages.add(p);
  return p;
}
class Utterance { constructor(text) { this.text = text; } }

test('unrelated keyboard input cannot silence a pending answer or steal browser navigation', () => {
  const p = page();
  p.data.assistantModelBusy = true;
  let interruptions = 0, prevented = 0;
  p.interruptConversation = () => { interruptions++; };
  for (const code of ['ControlLeft', 'Home', 'KeyA', 'ShiftLeft', 'Tab', '']) {
    const event = { code, preventDefault() { prevented++; } };
    p.onKeyDown(event); p.onKeyUp(event);
  }
  assert.equal(interruptions, 0);
  assert.equal(prevented, 0);
  const confirmation = { code: 'Enter', preventDefault() { prevented++; } };
  p.onKeyDown(confirmation); p.onKeyUp(confirmation);
  assert.ok(interruptions > 0, 'The glasses confirmation gesture still interrupts output.');
});

test('PC enrollment failure and credential rejection preserve native conversation and listening intent', async () => {
  for (const failureKind of ['claim', 'authentication']) {
    const p = page();
    p.data.relayBaseUrl = 'https://fixture.invalid';
    p.asrHostPolicy = { deviceSerialNumber: 'fixture-serial' };
    p.scheduleDeviceTokenClaim = () => {};
    const conversation = { transcriptionDesired: true, transcriptionState: '正在聆听', transcriptionText: '用户原话',
      agentStatus: '助手回复中', agentReplyText: '模型实际回答', assistantReplyText: '模型实际回答' };
    Object.assign(p.data, conversation, { token: failureKind === 'claim' ? '' : 'rbd_fixture', assistantModelBusy: true });
    if (failureKind === 'claim') assert.equal(await p.claimDeviceTokenFromSerial(), false);
    else assert.equal(p.handleRelayAuthenticationFailure({ statusCode: 401 }), true);
    for (const [key, value] of Object.entries(conversation)) assert.equal(p.data[key], value, `${failureKind}: ${key}`);
    assert.equal(p.data.needsDeviceSetup, true);
    assert.equal(p.data.connected, false);
  }
});

test('record browsing keys preserve live inference, capture and reservations in the compiled page', () => {
  const p = page(); let state;
  p.readAiuiInputState = () => state;
  p.writeAiuiInputState = value => { state = structuredClone(value); };
  const input = p.inputLedger().retain('原话'.repeat(100), 'old-owner'); p.inputLedger().submit(input);
  p.refreshAiuiInputReview(); const before = structuredClone(state);
  p.data.assistantModelBusy = true; p.deviceAgentTurnActive = true;
  const recognition = p.recognition = { abort() { throw Error('Browsing aborted capture'); } };
  p.interruptConversation = () => { throw Error('Browsing interrupted the task'); };
  p.executeLingzhuAgentPrompt = () => { throw Error('Browsing submitted an input'); };
  let prevented = 0;
  const key = code => { const event = { code, preventDefault() { prevented++; } }; p.onKeyDown(event); p.onKeyUp(event); };
  key('ArrowUp'); assert.equal(p.data.inputReviewOpen, true);
  key('ArrowDown'); assert.equal(p.data.inputReviewPage, 1);
  p.onPageTap({}); key('Backspace'); assert.equal(p.data.inputReviewOpen, false);
  assert.equal(p.recognition, recognition); assert.equal(p.deviceAgentTurnActive, true);
  assert.deepEqual(state, before); assert.equal(prevented, 6);
  p.recognition = null;
});
function result(text, isFinal) { return Object.assign([{ transcript: text }], { isFinal }); }

test('startup cannot manufacture first-frame readiness or activate a hidden page', async () => {
  const p = page(); p.pageReady = false; p.startupActivated = false;
  let activations = 0;
  p.activateDeferredStartup = () => { activations++; };
  p.scheduleDeferredStartup();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(p.pageReady, false); assert.equal(activations, 0);
  p.onReady(); p.pageVisible = false;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(activations, 0);
  p.pageVisible = true; p.scheduleDeferredStartup();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(activations, 1);
});

test('direct deferred activation cannot override missing readiness', () => {
  const p = page(); p.pageReady = false; p.startupActivated = false;
  p.restoreDeviceAgentProfile = () => { throw Error('profile started before first frame'); };
  p.activateDeferredStartup();
  assert.equal(p.pageReady, false); assert.equal(p.startupActivated, false);
});

test('startup rejects serialized null identity and shows an instruction, not a fabricated reply', () => {
  const p = page();
  p.installCloudConsoleCapture = () => {};
  p.scheduleDeferredStartup = () => {};
  p.onLoad({ agentName: 'null', agentId: 'undefined', systemPrompt: ' null ' });
  assert.equal(p.data.lingzhuAgentName, '灵珠智能体');
  assert.equal(p.data.lingzhuAgentId, '');
  assert.equal(p.data.lingzhuSystemPrompt, '');
  assert.match(p.data.agentReplyText, /轻触/);
  assert.doesNotMatch(p.data.agentReplyText, /你好|我是|null/);
  assert.notEqual(p.data.transcriptionState, '等待绑定');
});

test('temple confirm starts ASR without a PC token in both conversation and configuration', () => {
  for (const configuration of [false, true]) {
    let starts = 0, prevented = false;
    class Recognition { start() { starts++; this.onstart?.(); } abort() { this.onend?.(); } }
    const p = page();
    p.data.isConfigurationMode = configuration; p.data.isTranscriptionMode = !configuration;
    p.data.token = ''; p.asrHostPolicy = { requiresInteractiveWakeup: true };
    p.startDeviceAgentOwner = () => { throw Error('idle confirm must start microphone first'); };
    p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
    p.onKeyUp({ code: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(starts, 1); assert.equal(prevented, true);
    assert.equal(configuration ? p.data.assistantListening : p.data.transcriptionListening, true);
    p.stopRecognition();
  }
});

test('ASR waits for host confirmation and times out instead of claiming to listen forever', async () => {
  let aborts = 0;
  class Recognition { start() {} abort() { aborts++; this.onend?.(); } }
  const p = page(); p.recognitionStartupTimeoutMs = () => 20;
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.resumeTranscription('tap');
  assert.equal(p.data.transcriptionListening, false);
  assert.equal(p.data.transcriptionState, '正在启动麦克风');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(p.recognition, null); assert.equal(aborts, 1);
  assert.match(p.data.voiceErrorText, /超时/);
  assert.notEqual(hudDisplayFields(p.data).hudDisplayStatus, '就绪');
});

test('ASR constructor failure clears listening intent, shows the failure and permits an explicit retry', () => {
  for (const configuration of [false, true]) {
    let attempts = 0, starts = 0;
    class Recognition {
      constructor() { if (++attempts === 1) throw new Error('host initialization failed'); }
      start() { starts++; this.onstart?.(); }
      abort() { this.onend?.(); }
    }
    const p = page();
    p.data.isConfigurationMode = configuration;
    p.data.isTranscriptionMode = !configuration;
    p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
    const resume = () => configuration ? p.resumeConfigurationListening('tap') : p.resumeTranscription('tap');
    resume();
    assert.equal(starts, 0);
    assert.equal(Boolean(p.recognition), false);
    assert.equal(configuration ? p.data.assistantListeningDesired : p.data.transcriptionDesired, false);
    assert.equal(configuration ? p.data.assistantListening : p.data.transcriptionListening, false);
    assert.match(p.data.voiceErrorText, /初始化失败/);
    assert.match(configuration ? p.data.assistantStatus : p.data.transcriptionState, /初始化失败/);
    assert.equal(Boolean(p.listeningLifecycle?.getState().starting), false);
    assert.equal(Boolean(p.listeningLifecycle?.getState().restartPending), false);
    resume();
    assert.equal(starts, 1);
    assert.equal(configuration ? p.data.assistantListening : p.data.transcriptionListening, true);
    assert.equal(p.data.voiceErrorText, '');
    p.stopRecognition();
  }
});

test('late errors and end from an old ASR cannot stop or hide the new session', () => {
  class Recognition { start() { this.onstart?.(); } abort() {} }
  const p = page(); p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.resumeTranscription('tap'); const old = p.recognition;
  p.stopRecognition(); p.resumeTranscription('tap'); const current = p.recognition;
  old.onerror({ error: 'network', message: 'old failure' }); old.onend();
  assert.equal(p.recognition, current); assert.equal(p.data.transcriptionListening, true);
  assert.equal(p.data.voiceErrorText, ''); p.stopRecognition();
});

test('TTS synthesis timeout rejects late audio and preserves explicit failure', async () => {
  let release, plays = 0, aborts = 0;
  class Player { play() { plays++; } destroy() {} }
  const p = page(); p.speechSynthesisTimeoutMs = () => 20;
  p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: {
    synthesize() { return new Promise(resolve => { release = () => resolve({ abort() { aborts++; } }); }); }
  }, SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  p.speakText('测试'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(p.speechActive, false); assert.equal(p.data.agentStatus, 'TTS 播放失败');
  release(); await settle(); assert.equal(plays, 0); assert.equal(aborts, 1);
});

test('missing playback completion is failure; an ended event alone confirms completion', async () => {
  for (const ends of [false, true]) {
    let aborts = 0, player;
    class Player {
      constructor() { player = this; this.audioPlayer = new EventTarget(); }
      play() {} destroy() {}
    }
    const p = page(); p.speechPlaybackTimeoutMs = () => 20;
    p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: { async synthesize() {
      return { finished: Promise.resolve({ duration: 0.001 }), abort() { aborts++; } };
    } }, SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
    p.speakText('测试'); await settle();
    if (ends) player.audioPlayer.dispatchEvent(new Event('ended'));
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(p.data.agentStatus, ends ? '可以继续说话' : 'TTS 播放失败');
    assert.equal(aborts, ends ? 0 : 1);
  }
});

test('native player callbacks start once and finish without a destroy error becoming failure', async () => {
  let player, plays = 0;
  class Player {
    constructor() { player = this; this.audioPlayer = {
      onCanplay(fn) { this.canplay = fn; }, onEnded(fn) { this.ended = fn; }, onError(fn) { this.error = fn; }
    }; }
    play() { plays++; }
    destroy() { this.audioPlayer.error?.(); }
  }
  const p = page();
  p.ttsAdapter = createAiuiTtsOutputAdapter({ speechSynthesisApi: { async synthesize() { return { abort() {} }; } },
    SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  p.speakText('新版播放器'); await settle();
  assert.equal(plays, 0);
  player.audioPlayer.canplay(); player.audioPlayer.canplay();
  assert.equal(plays, 1);
  player.audioPlayer.ended();
  assert.equal(p.data.agentStatus, '可以继续说话');
  assert.equal(p.data.voiceErrorText, ''); assert.equal(p.speechActive, false);
});

test('queued speech preserves its voice options through actual playback completion', async () => {
  const calls = [], players = [];
  const p = page();
  p.ttsAdapter = { canSynthesize: () => true, async synthesize(text, options) {
    calls.push({ text, options });
    const player = { audioPlayer: new EventTarget(), play() {}, destroy() {} };
    players.push(player);
    return { task: { abort() {} }, player };
  } };
  p.speakText('第一句');
  p.speakText('第二句', 'enqueue', { voice: 'test-voice', volume: 0.5 });
  await settle();
  assert.equal(calls.length, 1);
  players[0].audioPlayer.dispatchEvent(new Event('ended'));
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, '第二句');
  assert.equal(calls[1].options.voice, 'test-voice');
  assert.equal(calls[1].options.volume, 0.5);
  players[1].audioPlayer.dispatchEvent(new Event('ended'));
});

test('late subtitle cues from completed speech cannot overwrite the next sentence', async () => {
  const cues = [], players = [];
  const p = page();
  p.ttsAdapter = { canSynthesize: () => true, async synthesize(text, options) {
    cues.push(options.onCue);
    const player = { audioPlayer: new EventTarget(), play() {}, destroy() {} };
    players.push(player);
    return { task: { abort() {} }, player };
  } };
  p.speakText('第一句'); p.speakText('第二句'); await settle();
  players[0].audioPlayer.dispatchEvent(new Event('ended')); await settle();
  cues[1]({ text: '当前字幕' });
  const currentStatus = p.data.agentStatus;
  cues[0]({ text: '迟到的旧字幕' });
  assert.equal(p.data.agentSpeakingCue, '当前字幕');
  assert.equal(p.data.agentStatus, currentStatus);
  players[1].audioPlayer.dispatchEvent(new Event('ended'));
  cues[1]({ text: '结束后字幕' });
  assert.equal(p.data.agentSpeakingCue, '');
});

test('player construction failure releases the already-created synthesis task', async () => {
  let aborts = 0;
  class Player { constructor() { throw Error('player unavailable'); } }
  const tts = createAiuiTtsOutputAdapter({ speechSynthesisApi: { async synthesize() { return { abort() { aborts++; } }; } },
    SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player });
  await assert.rejects(tts.synthesize('测试'), /player unavailable/);
  assert.equal(aborts, 1);
});

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

test('first gesture starts ASR synchronously and normal end resumes while the page stays interactive', async () => {
  let starts = 0;
  class Recognition {
    start() { starts++; this.onstart?.(); }
    abort() { this.onend?.(); }
  }
  const p = page();
  p.pageReady = false; // Profile/owner startup has not completed; activation still belongs to this call.
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  const inputs = []; p.handleTranscriptionResult = text => inputs.push(text);
  p.resumeTranscription('tap');
  assert.equal(starts, 1);
  assert.equal(p.recognition.continuous, true);
  p.recognition.onresult({ resultIndex: 0, results: [result('首句', true)] });
  assert.deepEqual(inputs, ['首句']);
  p.pageReady = true;
  const firstRecognition = p.recognition;
  p.deviceAgentTurnActive = true;
  p.data.assistantModelBusy = true;
  p.recognition.onend();
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(starts, 2);
  assert.notEqual(p.recognition, firstRecognition);
  assert.equal(p.data.transcriptionListening, true);
  assert.equal(p.deviceAgentTurnActive, true, 'Resuming capture must retain active model work');
  p.recognition.onresult({ resultIndex: 0, results: [result('第二句', true)] });
  firstRecognition.onresult({ resultIndex: 1, results: [result('首句', true), result('迟到的旧输入', true)] });
  assert.deepEqual(inputs, ['首句', '第二句']);
  p.pauseTranscription();
});

test('ASR continuation requires activation and stops on pause, hide or host rejection', async () => {
  for (const stop of ['pause', 'hide', 'reject']) {
    let starts = 0;
    class Recognition {
      start() {
        starts++;
        if (stop === 'reject' && starts > 1) throw new Error('InvalidStateError: non-interactive');
        this.onstart?.();
      }
      abort() { this.onend?.(); }
    }
    const p = page();
    p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
    p.data.transcriptionDesired = true;
    p.scheduleTranscriptionRestart(0); await settle();
    assert.equal(starts, 0, 'No capture before the first interaction');
    p.resumeTranscription('tap');
    p.recognition.onend();
    if (stop === 'pause') p.pauseTranscription();
    if (stop === 'hide') p.pageVisible = false;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(starts, stop === 'reject' ? 2 : 1);
    assert.equal(p.recognition, null);
    if (stop === 'reject') {
      assert.equal(p.data.transcriptionDesired, false);
      assert.match(p.data.voiceErrorText, /识别失败|启动失败/);
      assert.equal(Boolean(p.listeningLifecycle?.getState().restartPending), false);
    }
    p.pauseTranscription();
  }
});

test('repeated immediate empty ASR endings stop instead of spinning forever', async () => {
  let starts = 0;
  class Recognition { start() { starts++; this.onstart?.(); this.onend?.(); } abort() {} }
  const p = page();
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.resumeTranscription('tap');
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(starts, 3);
  assert.equal(p.data.transcriptionDesired, false);
  assert.equal(p.recognition, null);
  assert.equal(Boolean(p.listeningLifecycle?.getState().restartPending), false);
  assert.match(p.data.voiceErrorText, /识别.*结束/);
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
  assert.equal(p.speechPlayback.getState().player, player);
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
  p.speakText('延迟合成'); await settle(); p.stopAiuiPlaybackForInput('新输入'); release(); await settle();
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

test('streaming speech preserves decimals, domains and versions split after a dot and flushes the tail', async () => {
  const p = page(), spoken = [];
  const snapshots = [];
  const chunks = ['圆周率是3.', '14，访问example.', 'com，用v1.', '2。', '尾句'];
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
  p.speakText = text => spoken.push(text);
  p.ensureChatModel = async () => createPageAssistantFixture(p, { promptStreaming() {
    let index = 0;
    return { async read() {
      await settle(); // Let native synthesis/player completion drain the shared serial queue.
      if (index === 1 || index === 4) snapshots.push([...spoken]);
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    } };
  } });
  const result = await p.executeLingzhuAgentPrompt('朗读含小数和网址的回复');
  await settle();
  assert.equal(result.state, 'completed');
  assert.deepEqual(snapshots, [[], ['圆周率是3.14，访问example.com，用v1.2。']], 'Stream boundaries must not change speech boundaries.');
  assert.deepEqual(spoken, ['圆周率是3.14，访问example.com，用v1.2。', '尾句']);
  assert.equal(p.data.agentReplyText, chunks.join(''));
});

test('multilingual speech emits complete segments before model completion and preserves an unpunctuated tail', async () => {
  const p = page(), spoken = [];
  let beforeCompletion;
  const chunks = ['你好。', 'Hello. Next! ', 'مرحبا؟', 'تمام؛', 'یہ جواب ہے۔', 'नमस्ते।', 'निष्कर्ष॥', '末尾'];
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
  p.speakText = text => spoken.push(text.trim());
  p.ensureChatModel = async () => createPageAssistantFixture(p, { promptStreaming() {
    let index = 0;
    return { async read() {
      await settle();
      if (index === 3) beforeCompletion = [...spoken];
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    } };
  } });
  const result = await p.executeLingzhuAgentPrompt('朗读多语言回复');
  await settle();
  assert.equal(result.state, 'completed');
  assert.deepEqual(beforeCompletion, ['你好。', 'Hello.', 'Next!', 'مرحبا؟']);
  assert.deepEqual(spoken, ['你好。', 'Hello.', 'Next!', 'مرحبا؟', 'تمام؛', 'یہ جواب ہے۔', 'नमस्ते।', 'निष्कर्ष॥', '末尾']);
  assert.equal(p.data.agentReplyText, chunks.join(''));
});

test('compiled page logs a safe protocol reason and rejects a mismatched model decision', async () => {
  const p = page(), warnings = []; let tools = 0;
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {}; p.speakText = () => {};
  p.executeChatTool = () => { tools++; };
  p.ensureChatModel = async () => createPageAssistantFixture(p, { async prompt(input) {
    const original = JSON.parse(input[0].content);
    return JSON.stringify({ protocol: original.protocol, requestId: 'private-wrong-id', kind: 'final', text: 'private-reply' });
  } });
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await p.executeLingzhuAgentPrompt('测试');
    assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'TURN_DECISION_INVALID');
    assert.equal(tools, 0); assert.equal(p.data.assistantModelBusy, false);
    assert.ok(warnings.includes('[RabiLink AIUI] decision validation failed: request-mismatch'));
    assert.doesNotMatch(warnings.join('\n'), /private-wrong-id|private-reply/);
  } finally { console.warn = warn; }
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
  const assistant = createPageAssistantFixture(p, model);
  p.ensureChatModel = async () => assistant;
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

test('compiled API tool results reach the model and HUD without a second speech producer', async () => {
  for (const scenario of ['confirmed', 'uncertain', 'interrupted']) {
    const p = page(), spoken = [], requests = [];
    let finishTool, observed;
    const config = { relayBaseUrl: 'https://fixture.invalid', token: 'synthetic', targetDeviceId: 'fixture-pc' };
    const outcome = { structuredContent: { ok: scenario !== 'uncertain',
      ...(scenario === 'uncertain' ? { uncertain: true } : {}), data: { value: 42 } } };
    fixtureWx.request = options => {
      assert.equal(options.url, config.relayBaseUrl + '/api/rabilink/device/api');
      const packet = options.data;
      requests.push(packet);
      const deliver = data => options.success({ statusCode: 200, data: { code: 0, data } });
      if (packet.request.path === '/meta') deliver({ structuredContent: { ok: true, data: {
        applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance',
        health: { live: true, state: 'healthy' }
      } } });
      else finishTool = () => deliver(outcome);
    };
    p.config = () => config; p.deviceAgentProfileConfig = () => config;
    p.isAiuiVoiceContextReady = () => true;
    p.agentProfileScope = () => 'fixture-tool-speech-' + scenario;
    p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
    p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
    p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
    p.setKnowledgePageData = patch => p.setData(patch);
    p.scheduleTranscriptionRestart = () => {};
    class Player { constructor() { this.textTrack = {}; } play() {} stop() {} destroy() {} }
    p.ttsAdapter = createAiuiTtsOutputAdapter({
      speechSynthesisApi: { async synthesize(utterance) { spoken.push(utterance.text); return { abort() {} }; } },
      SpeechSynthesisUtteranceCtor: Utterance, SpeechAudioPlayerCtor: Player
    });
    let assistant;
    try {
      const prepared = await p.prepareRabiApiTools();
      p.chatModelAgentTools = prepared.tools; p.chatModelApiRuntime = prepared.runtime;
      const answer = scenario === 'uncertain' ? '结果尚未确认。' : '查到的数值是四十二。';
      assistant = createPageAssistantFixture(p, { async prompt(input) {
        const packet = JSON.parse(input[0].content);
        if (packet.kind === 'user-input') return JSON.stringify({ protocol: packet.protocol,
          requestId: packet.requestId, kind: 'tool', name: 'rabi_api_call',
          arguments: { method: 'GET', path: '/api/fixture/value' } });
        assert.equal(packet.kind, 'tool-observation');
        observed = packet.observation.outcome.result.structuredContent;
        return answer;
      } });
      p.ensureChatModel = async () => assistant;
      const pending = p.executeLingzhuAgentPrompt('查询数值');
      await settle();
      assert.equal(typeof finishTool, 'function');
      if (scenario === 'interrupted') p.stopAiuiPlaybackForInput('用户开口');
      finishTool();
      const result = await pending; await settle();
      assert.deepEqual(observed, outcome.structuredContent, 'The model must receive the actual receipt.');
      assert.equal(result.state, scenario === 'uncertain' ? 'uncertain' : 'completed');
      assert.equal(p.data.agentReplyText, answer, 'Stopping TTS must preserve the model answer.');
      assert.match(p.data.knowledgeToolStatus, scenario === 'uncertain' ? /未确认/ : /已返回/);
      assert.deepEqual(spoken, scenario === 'interrupted' ? [] : [answer],
        'Only the assistant reply owns speech; API status remains in the tool result view.');
      assert.deepEqual(requests.map(packet => packet.request.path), ['/meta', '/api/fixture/value']);
      const ledger = fixtureWx.getStorageSync('rabilink-aiui-api-ledger-v2:' + sha256Text(p.agentProfileScope()));
      assert.equal(ledger.rows.length, 1);
      assert.match(ledger.rows[0].fingerprint, /^[a-f0-9]{64}$/,
        'The compiled tool path must persist read fingerprints too, not just in-memory identity.');
    } finally {
      p.cancelSpeech(); p.cleanupRabiApiRuntime(); assistant?.dispose(); delete fixtureWx.request;
    }
  }
});

test('compiled page recreation retains an in-flight write and ignores its released owner late receipt', async () => {
  const packets = [], config = { relayBaseUrl: 'https://fixture.invalid', token: 'synthetic', targetDeviceId: 'fixture-pc' };
  const scope = 'fixture-compiled-ledger-recovery';
  let finishWrite;
  fixtureWx.request = options => {
    const packet = options.data; packets.push(packet);
    const deliver = data => options.success({ statusCode: 200, data: { code: 0, data } });
    if (packet.request.path === '/meta') deliver({ structuredContent: { ok: true, data: {
      applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' }
    } } });
    else finishWrite = () => deliver({ structuredContent: { ok: true, data: { accepted: true } } });
  };
  const makePage = () => {
    const p = page(); p.config = () => config; p.deviceAgentProfileConfig = () => config;
    p.agentProfileScope = () => scope; p.setKnowledgePageData = patch => p.setData(patch);
    return p;
  };
  const old = makePage(), replacement = makePage();
  const event = { callId: 'old-call', functionName: 'rabi_api_call', isComplete: true,
    arguments: { method: 'PUT', path: '/api/fixture/write', operationId: 'original-write', body: { test: true } } };
  try {
    await old.prepareRabiApiTools(); const pending = old.handleRabiApiToolCall(event);
    await settle(); assert.equal(typeof finishWrite, 'function');
    old.cleanupRabiApiRuntime(); await replacement.prepareRabiApiTools();
    const before = packets.length;
    const recovery = await replacement.handleRabiApiToolCall({ ...event, callId: 'new-call' });
    assert.equal(recovery.duplicate, true); assert.equal(recovery.uncertain, true);
    assert.equal(packets.length, before, 'Reopening must not submit the original write again.');
    finishWrite(); assert.equal((await pending).cancelled, true);
    const saved = fixtureWx.getStorageSync('rabilink-aiui-api-ledger-v2:' + sha256Text(scope));
    assert.equal(saved.rows.length, 1); assert.equal(saved.rows[0].state, 'pending');
    assert.equal(saved.rows[0].operationId, 'original-write');
    assert.equal(packets.filter(packet => packet.request.path === '/api/fixture/write').length, 1);
  } finally { old.cleanupRabiApiRuntime(); replacement.cleanupRabiApiRuntime(); delete fixtureWx.request; }
});

test('compiled page returns the generated original operation after a lost write response for model readback', async () => {
  const p = page(), requests = [], observations = [];
  const config = { relayBaseUrl: 'https://fixture.invalid', token: 'synthetic', targetDeviceId: 'fixture-pc' };
  const scope = 'fixture-compiled-lost-response';
  let original, assistant;
  fixtureWx.request = options => {
    const packet = options.data; requests.push(packet);
    const deliver = data => options.success({ statusCode: 200, data: { code: 0, data } });
    if (packet.request.path === '/meta') deliver({ structuredContent: { ok: true, data: {
      applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' }
    } } });
    else if (packet.request.method === 'PUT') {
      original = packet.request.operationId;
      options.fail({ errMsg: 'fixture lost response with private transport details' });
    } else {
      assert.equal(packet.request.path, '/api/fixture/receipts/' + encodeURIComponent(original));
      deliver({ structuredContent: { ok: true, data: { operationId: original, state: 'pending' } } });
    }
  };
  p.config = () => config; p.deviceAgentProfileConfig = () => config;
  p.agentProfileScope = () => scope; p.setKnowledgePageData = patch => p.setData(patch);
  p.isAiuiVoiceContextReady = () => true;
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
  p.scheduleTranscriptionRestart = () => {}; p.queueSpeech = () => {};
  try {
    const prepared = await p.prepareRabiApiTools();
    p.chatModelAgentTools = prepared.tools; p.chatModelApiRuntime = prepared.runtime;
    assistant = createPageAssistantFixture(p, { async prompt(input) {
      const packet = JSON.parse(input[0].content);
      const action = arguments_ => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId,
        kind: 'tool', name: 'rabi_api_call', arguments: arguments_ });
      if (packet.kind === 'user-input') return action({ method: 'PUT', path: '/api/fixture/write' });
      const outcome = packet.observation.outcome; observations.push(outcome);
      if (observations.length === 1) {
        assert.equal(outcome.uncertain, true);
        assert.equal(outcome.requestIdentity.operationId, original);
        assert.equal(outcome.requestIdentity.targetDeviceId, 'fixture-pc');
        assert.ok(!JSON.stringify(outcome).includes('private transport details'));
        return action({ method: 'GET', targetDeviceId: outcome.requestIdentity.targetDeviceId,
          path: '/api/fixture/receipts/' + encodeURIComponent(outcome.requestIdentity.operationId) });
      }
      assert.equal(outcome.result.structuredContent.data.operationId, original);
      return '原请求仍在处理中。';
    } });
    p.ensureChatModel = async () => assistant;
    const output = await p.executeLingzhuAgentPrompt('保存后核对原请求');
    assert.equal(output.state, 'uncertain');
    assert.equal(p.data.agentReplyText, '原请求仍在处理中。');
    assert.equal(requests.filter(packet => packet.request.method === 'PUT').length, 1);
    const journal = fixtureWx.getStorageSync('rabilink-aiui-api-ledger-v2:' + sha256Text(scope));
    assert.equal(journal.rows.find(row => row.operationId === original).state, 'uncertain');
    const duplicate = await p.handleRabiApiToolCall({ callId: 'later-query', functionName: 'rabi_api_call', isComplete: true,
      arguments: { method: 'PUT', path: '/api/fixture/write', operationId: original } });
    assert.equal(duplicate.requestIdentity.operationId, original);
    assert.equal(duplicate.resultAvailable, false);
    assert.equal(requests.filter(packet => packet.request.method === 'PUT').length, 1);
  } finally { p.cancelSpeech(); p.cleanupRabiApiRuntime(); assistant?.dispose(); delete fixtureWx.request; }
});

test('compiled page projects discovery indexes and retains the selected full contract through its actual API adapter', async () => {
  const p = page(), requests = [];
  const config = { relayBaseUrl: 'https://fixture.invalid', token: 'synthetic', targetDeviceId: 'fixture-pc' };
  const contract = { request: { body: { schema: { description: 'schema-only-marker' } } },
    recovery: { strategy: 'receipt-first', description: 'Read the original deliveryId, not the operationId.' } };
  fixtureWx.request = options => {
    const packet = options.data; requests.push(packet);
    const data = packet.request.path === '/meta'
      ? { applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' } }
      : { code: 0, data: { schemaVersion: '2', catalogDigest: 'fixture-digest', count: 1, total: 1, nextCursor: '',
        operations: [{ id: 'fixture.detail', method: 'GET', pathTemplate: '/api/fixture', contract }] } };
    options.success({ statusCode: 200, data: { code: 0, data: { structuredContent: { ok: true, data },
      content: [{ type: 'text', text: JSON.stringify(data) }] } } });
  };
  p.config = () => config; p.deviceAgentProfileConfig = () => config;
  p.agentProfileScope = () => 'fixture-compiled-discovery'; p.setKnowledgePageData = patch => p.setData(patch);
  try {
    await p.prepareRabiApiTools();
    const invoke = (callId, args) => p.handleRabiApiToolCall({ callId, functionName: 'rabi_api_help', isComplete: true, arguments: args });
    const index = await invoke('index', {});
    assert.equal(index.result.apiHelpView, 'index');
    assert.ok(!JSON.stringify(index).includes('schema-only-marker'));
    const detail = await invoke('detail', { operationId: 'fixture.detail' });
    assert.deepEqual(detail.result.structuredContent.data.data.operations[0].contract, contract);
    assert.deepEqual(requests.map(packet => packet.request.path), ['/meta', '/api/agent/help?limit=32', '/meta', '/api/agent/help?operationId=fixture.detail&limit=1']);
    assert.ok(requests.every(packet => packet.targetDeviceId === 'fixture-pc'));
  } finally { p.cleanupRabiApiRuntime(); delete fixtureWx.request; }
});

test('packaged page registers an actual follow tool, keeps foreground conversation and later presents the original task result', async () => {
  const p = page(), packets = [], modelInputs = [], spoken = [];
  const config = { relayBaseUrl: 'https://fixture.invalid', token: 'synthetic', targetDeviceId: 'fixture-pc' };
  p.setData = (patch, callback) => { Object.assign(p.data, patch); callback?.(); };
  fixtureWx.request = options => {
    const packet = options.data; packets.push(packet);
    const data = packet.request.path === '/meta'
      ? { applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' } }
      : packet.request.method === 'POST' ? { jobId: 'original-job', status: 'accepted' }
        : { jobId: 'original-job', status: 'done', result: '原任务的实际结果' };
    options.success({ statusCode: 200, data: { code: 0, data: { structuredContent: { ok: true, data } } } });
  };
  p.config = () => config; p.deviceAgentProfileConfig = () => config;
  p.agentProfileScope = () => 'fixture-compiled-task-follow'; p.setKnowledgePageData = patch => p.setData(patch);
  p.isAiuiVoiceContextReady = () => true; p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {}; p.speakText = text => spoken.push(text);
  p.aiuiRuntime = createAiuiAssistantRuntime({ asr: { createRound: handlers => handlers, start() {}, stop() {} }, tts: { synthesize() {} } });
  try {
    const prepared = await p.prepareRabiApiTools(); p.chatModelApiRuntime = prepared.runtime;
    const assistant = p.aiuiRuntime.createSession({ profile: { systemPrompt: '按实际回执回答。' }, protocol: rabiAgentProtocol,
      discoverTools: () => ({ tools: prepared.tools, executeTool: event => p.executeChatTool(event, prepared.runtime), toolPolicy: rabiAgentToolPolicy }),
      createModel: () => ({ async prompt(input) {
        const message = JSON.parse(input[0].content); modelInputs.push(message);
        const action = (name, args) => JSON.stringify({ protocol: message.protocol, requestId: message.requestId, kind: 'tool', name, arguments: args });
        if (message.kind === 'user-input') {
          if (message.text === '再聊一句') return '可以继续聊天';
          return action('rabi_api_call', { method: 'POST', path: '/api/jobs' });
        }
        if (message.kind === 'task-observation') {
          assert.equal(message.observation.body.result.result, '原任务的实际结果');
          return '后台原任务完成，结果已保存。';
        }
        if (message.observation.name === 'rabi_api_call') return action('rabi_task_follow', {
          action: 'watch', taskId: message.observation.outcome.result.structuredContent.data.jobId,
          path: '/api/jobs/original-job', statusPointer: '/status', terminalValues: ['done'], intervalMs: 1000 });
        assert.equal(message.observation.outcome.result.structuredContent.data.state, 'watching');
        return '任务已受理，会继续跟进。';
      }, destroy() {} }) });
    await assistant.ready(); p.chatAssistant = assistant; p.ensureChatModel = async () => assistant;
    p.startTaskFollow();
    assert.equal((await p.executeLingzhuAgentPrompt('开始任务')).state, 'completed');
    assert.equal((await p.executeLingzhuAgentPrompt('再聊一句')).text, '可以继续聊天');
    const deadline = Date.now() + 4000;
    while (!p.data.agentReplyText.includes('后台原任务完成') && Date.now() < deadline) await settle();
    assert.equal(p.data.agentReplyText, '后台原任务完成，结果已保存。');
    assert.equal(packets.filter(packet => packet.request.method === 'POST').length, 1);
    assert.equal(packets.filter(packet => packet.request.path === '/api/jobs/original-job').length, 1);
    assert.equal(modelInputs.filter(message => message.kind === 'task-observation').length, 1);
    assert.equal(modelInputs.at(-2).text, '再聊一句');
    assert.equal(spoken.at(-1), '后台原任务完成，结果已保存。');
    assert.equal(p.taskFollowRuntime.pending().length, 0);
  } finally { p.stopTaskFollow(); p.cleanupRabiApiRuntime(); p.aiuiRuntime.dispose(); delete fixtureWx.request; }
});

test('packaged page speaks an interjection while its original tool is still waiting', async () => {
  const spoken=[],requests=[];let finishTool,toolCalls=0;
  class Player { constructor(){this.textTrack={};} play(){} stop(){} destroy(){} }
  const p=page();
  p.applyPendingDeviceAgentProfile=()=>{};p.applyPendingApiTools=()=>{};
  p.deviceAgentTurnContext=()=>null;p.beginAiuiConversation=()=>null;p.finishAiuiConversation=()=>{};p.resumeDeviceAgentClaim=()=>{};
  p.chatModelAgentTools=['rabi_api_call'];
  p.executeChatTool=()=>{toolCalls++;return new Promise(resolve=>{finishTool=resolve;});};
  p.ttsAdapter=createAiuiTtsOutputAdapter({speechSynthesisApi:{async synthesize(utterance){spoken.push(utterance.text);return {abort(){}};}},
    SpeechSynthesisUtteranceCtor:Utterance,SpeechAudioPlayerCtor:Player});
  const assistant=createPageAssistantFixture(p,{async prompt(input){
    const value=JSON.parse(input[0].content);requests.push(value);
    if(value.kind==='user-input')return JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'rabi_api_call',arguments:{method:'GET',path:'/fixture/slow'}});
    if(value.kind==='independent-input')return JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'interjection',inputId:value.input.id,disposition:'answer',text:'四十二'});
    assert.equal(value.kind,'tool-observation');return '原任务已完成。';
  }});
  p.ensureChatModel=async()=>assistant;
  const run=p.executeLingzhuAgentPrompt('执行原任务');await settle();
  assert.equal(toolCalls,1);
  p.stopAiuiPlaybackForInput('用户插话');await p.executeLingzhuAgentPrompt('六乘以七是多少？');await settle();
  assert.deepEqual(spoken,['四十二']);assert.equal(p.deviceAgentTurnActive,true);
  assert.equal(assistant.getState().turn.settledToolCount,0);assert.equal(requests[1].kind,'independent-input');
  finishTool({result:{structuredContent:{ok:true,receipt:'original'}}});
  assert.equal((await run).state,'completed');assert.equal(toolCalls,1);assert.equal(requests.length,3);
  p.cancelSpeech();assistant.dispose();
});

test('packaged page defers a proposed action and runs the original saved input under the same ID', async () => {
  const p=page(),requests=[],calls=[]; let finishTool;
  p.applyPendingDeviceAgentProfile=()=>{};p.applyPendingApiTools=()=>{};
  p.deviceAgentTurnContext=()=>null;p.beginAiuiConversation=()=>null;p.finishAiuiConversation=()=>{};p.resumeDeviceAgentClaim=()=>{};p.speakText=()=>{};
  p.chatModelAgentTools=['rabi_api_call'];
  p.executeChatTool=event=>{calls.push(event);return calls.length===1?new Promise(resolve=>{finishTool=resolve;}):{result:{structuredContent:{ok:true}}};};
  const action=(packet,path)=>JSON.stringify({protocol:packet.protocol,requestId:packet.requestId,kind:'tool',name:'rabi_api_call',arguments:{method:'GET',path}});
  const assistant=createPageAssistantFixture(p,{async prompt(input){
    const packet=JSON.parse(input[0].content);requests.push(packet);
    if(packet.kind==='independent-input')return action(packet,'/discarded-proposal');
    if(packet.kind==='user-input')return action(packet,packet.text==='原任务'?'/original':'/fresh-decision');
    return '真实结果已返回。';
  }});
  p.ensureChatModel=async()=>assistant;
  const original=p.executeLingzhuAgentPrompt('原任务');await settle();
  await p.executeLingzhuAgentPrompt('追加工作');await settle();
  const identity=requests[1].input;
  assert.equal(p.readAiuiInputState().rows.find(row=>row.id===identity.id).status,'deferred');assert.equal(calls.length,1);
  finishTool({result:{structuredContent:{ok:true}}});await original;await settle();
  assert.equal(calls.length,2);assert.equal(calls[1].callId,identity.id+':call-1');assert.equal(calls[1].arguments.path,'/fresh-decision');
  const row=p.readAiuiInputState().rows.find(item=>item.id===identity.id);
  assert.equal(row.status,'completed');assert.equal(row.text,'追加工作');assistant.dispose();
});

test('packaged cleanup retains submitted input for recovery and cannot revive late speech or requests', async () => {
  const p=page(),requests=[];let finishTool,finishAnswer;
  p.applyPendingDeviceAgentProfile=()=>{};p.applyPendingApiTools=()=>{};
  p.deviceAgentTurnContext=()=>null;p.beginAiuiConversation=()=>null;p.finishAiuiConversation=()=>{};p.resumeDeviceAgentClaim=()=>{};
  let spoken=0;p.speakText=()=>{spoken++;};p.chatModelAgentTools=['rabi_api_call'];
  p.executeChatTool=()=>new Promise(resolve=>{finishTool=resolve;});
  const assistant=createPageAssistantFixture(p,{async prompt(input){
    const packet=JSON.parse(input[0].content);requests.push(packet);
    if(packet.kind==='independent-input')return new Promise(resolve=>{finishAnswer=resolve;});
    return JSON.stringify({protocol:packet.protocol,requestId:packet.requestId,kind:'tool',name:'rabi_api_call',arguments:{method:'GET',path:'/original'}});
  }});
  p.chatAssistant=assistant;p.ensureChatModel=async()=>assistant;
  const original=p.executeLingzhuAgentPrompt('原任务');await settle();await p.executeLingzhuAgentPrompt('需保留的新话');await settle();
  const identity=requests[1].input;p.pageVisible=false;p.cleanupChatModel();await original;await settle();
  finishAnswer(JSON.stringify({protocol:requests[1].protocol,requestId:requests[1].requestId,kind:'interjection',inputId:identity.id,disposition:'answer',text:'迟到回复'}));
  finishTool({result:{structuredContent:{ok:true}}});await settle();
  const reopened=page();reopened.recoverAiuiInputs();
  assert.equal(reopened.readAiuiInputState().rows.find(row=>row.id===identity.id).status,'unconfirmed');
  assert.equal(reopened.data.agentReplyText,'需保留的新话');assert.equal(spoken,0);assert.equal(requests.length,2);
  assert.equal(p.aiuiGuidanceQueue.length,0);
});

test('packaged page connects recognition input ownership to mailbox waiting', async () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'SpeechRecognition');
  class Recognition { start(){this.onstart?.();} abort(){} }
  Object.defineProperty(globalThis,'SpeechRecognition',{value:Recognition,configurable:true});
  const p=page();
  try {
    p.installCloudConsoleCapture=()=>{};p.scheduleDeferredStartup=()=>{};
    p.onLoad({});p.pageVisible=true;p.pageReady=true;
    p.handleTranscriptionResult=()=>{p.deviceAgentTurnActive=true;};
    p.resumeTranscription('tap');
    const owner={sessionId:'synthetic-owner'};p.deviceAgentOwner=owner;
    p.recognition.onspeechstart();
    let finished=false;const idle=p.waitForDeviceAgentTurnIdle(owner).then(()=>{finished=true;});
    await settle();assert.equal(finished,false);
    p.recognition.onspeechend();await settle();assert.equal(finished,false);
    p.recognition.onresult({results:[result('完整用户输入',true)],resultIndex:0});
    await settle();assert.equal(finished,false);assert.equal(p.aiuiRuntime.getState().inputPending,false);
    p.deviceAgentTurnActive=false;p.resumeDeviceAgentClaim();await idle;
    assert.equal(finished,true);
  } finally {
    p.deviceAgentOwner=null;p.aiuiRuntime?.dispose();
    if(previous)Object.defineProperty(globalThis,'SpeechRecognition',previous);else delete globalThis.SpeechRecognition;
  }
});

test('host speech onset stops playback before any transcript without cancelling work or capture', () => {
  let stopped = 0, cancelled = 0;
  class Recognition { start() { this.onstart?.(); } abort() {} }
  const p = page(); p.deviceAgentTurnActive = true; p.promptGeneration = 31;
  p.chatTurnRuntime = { cancel() { cancelled++; } };
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.cancelSpeech = () => { stopped++; p.speechActive = false; p.data.agentSpeaking = false; };
  p.resumeTranscription('tap');
  const recognition = p.recognition;
  p.speechActive = true; p.data.agentSpeaking = true;
  assert.equal(typeof recognition.onspeechstart, 'function');
  recognition.onspeechstart({ type: 'speechstart' });
  assert.equal(stopped, 1);
  assert.equal(cancelled, 0); assert.equal(p.promptGeneration, 31);
  assert.equal(p.deviceAgentTurnActive, true); assert.equal(p.recognition, recognition);
  assert.equal(p.aiuiSpeechSuppressed, true);
  assert.equal(p.aiuiGuidanceQueue?.length || 0, 0, 'Onset must not manufacture words or a new task');
  p.stopRecognition();
  p.speechActive = true; p.data.agentSpeaking = true;
  recognition.onspeechstart({ type: 'speechstart' });
  assert.equal(stopped, 1, 'Stopped recognition must not interrupt a later response');
  p.resumeTranscription('tap');
  const hiddenRecognition = p.recognition;
  prepareVisibilityLifecycle(p);
  p.onHide();
  const stoppedAtHide = stopped;
  hiddenRecognition.onspeechstart({ type: 'speechstart' });
  assert.equal(stopped, stoppedAtHide, 'Hidden page must ignore late onset');
});

test('recognition onset during thinking retains the old answer as text while user input has priority', async () => {
  const p = page(); let release, synthesized = 0;
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
  class Recognition {
    start() { this.onstart?.(); this.onspeechstart?.(); }
    abort() {}
  }
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.ttsAdapter = { canSynthesize: () => true, async synthesize() {
    synthesized++;
    return { task: { abort() {} }, player: { play() {}, destroy() {} } };
  } };
  p.ensureChatModel = async () => createPageAssistantFixture(p, {
    async prompt() { await new Promise(resolve => { release = resolve; }); return '正常播报这句。'; }
  });
  const pending = p.executeLingzhuAgentPrompt('测试'); await settle();
  try {
    p.resumeTranscription('tap');
    assert.equal(p.aiuiSpeechSuppressed, true, 'User onset must suppress old output without cancelling the pending model');
  } finally { release(); await pending; }
  await settle();
  assert.equal(synthesized, 0);
  assert.equal(p.data.agentReplyText, '正常播报这句。');
  p.cancelSpeech(); p.pauseTranscription();
});

test('tap and temple keys stop output while preserving the pending model, guidance and recognizer', async () => {
  for (const entry of ['onPageTap', 'onKeyDown', 'onKeyUp']) {
    const p = page();
    let release, cancelled = 0, disposed = 0, stopped = 0;
    p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
    p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
    p.finishAiuiConversation = () => {}; p.resumeDeviceAgentClaim = () => {};
    p.recognition = { abort() {} }; const recognizer = p.recognition;
    const runtime = { async run() {
      await new Promise(resolve => { release = resolve; });
      return { state: 'completed', text: '后台任务已完成' };
    }, cancel() { cancelled++; }, dispose() { disposed++; } };
    p.ensureChatModel = async () => runtime; p.chatAssistant = runtime;
    p.cancelSpeech = () => { stopped++; p.speechActive = false; p.data.agentSpeaking = false; };
    const pending = p.executeLingzhuAgentPrompt('继续处理任务'); await settle();
    p.aiuiGuidanceQueue = [{ text: '稍后采用的引导', ticket: { id: 'original' } }];
    const queue = p.aiuiGuidanceQueue, generation = p.promptGeneration;
    p.speechActive = true; p.data.agentSpeaking = true;
    try {
      p[entry]({ code: 'Enter', preventDefault() {} });
      assert.equal(stopped, 1);
      assert.equal(cancelled, 0, entry + ' must not cancel model work');
      assert.equal(disposed, 0);
      assert.equal(p.promptGeneration, generation);
      assert.equal(p.recognition, recognizer);
      assert.equal(p.aiuiGuidanceQueue, queue);
      assert.equal(p.deviceAgentTurnActive, true);
      assert.equal(p.data.assistantModelBusy, true);
      assert.equal(p.aiuiSpeechSuppressed, true);
    } finally {
      // The fixture does not execute a second queued model turn.
      p.aiuiGuidanceQueue = []; release(); await pending;
      p.recognition = null;
    }
  }
});

test('automatic ASR restart preserves the last user transcript', async () => {
  class Recognition { start() { this.onstart?.(); } abort() {} }
  const p = page();
  p.asrAdapter = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  p.resumeTranscription('tap');
  p.data.transcriptionText = '保留这句用户输入';
  p.recognition.onend();
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(p.data.transcriptionText, '保留这句用户输入');
  p.pauseTranscription();
});

test('spoken configuration during a turn is guidance and cannot destroy or rename its model', () => {
  let destroyed = 0;
  const p = page(); p.deviceAgentTurnActive = true; p.aiuiGuidanceQueue = [];
  p.beginAiuiConversation = () => null; p.chatAssistant = { dispose() { destroyed++; } };
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
  p.chatAssistant = { dispose() { destroyed++; } }; p.data.assistantModelBusy = true;
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
    modelCalls++; return createPageAssistantFixture(p, { promptStreaming(input) {
      const index = requests.length; requests.push(input); let read = false;
      return { async read() { if (read) return { done: true }; read = true;
        if (index === 0) await new Promise(resolve => { releaseRead = resolve; });
        return { done: false, value: index ? '引导答案' : '首句答案' }; } };
    } });
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

function prepareVisibilityLifecycle(p) {
  p.startupActivated = true;
  for (const name of ['closeAiuiInputReview', 'clearDeviceTokenClaimTimer', 'stopDeviceStatus',
    'startDeviceStatus', 'scheduleCloudLogFlush', 'resumeDeviceAgentClaim']) p[name] = () => {};
  p.flushCloudLogs = async () => {};
  p.initializeAiuiVoiceContext = async () => ({ ok: true });
}

test('hide preserves an admitted tool and its complete text under the original model binding', async () => {
  const p = page(); prepareVisibilityLifecycle(p);
  let finishTool, toolCalls = 0, synthesized = 0;
  p.applyPendingDeviceAgentProfile = () => {}; p.applyPendingApiTools = () => {};
  p.deviceAgentTurnContext = () => null; p.beginAiuiConversation = () => null;
  p.finishAiuiConversation = () => {}; p.chatModelAgentTools = ['rabi_api_call'];
  p.executeChatTool = () => { toolCalls++; return new Promise(resolve => { finishTool = resolve; }); };
  p.ttsAdapter = { async synthesize() { synthesized++; throw Error('Hidden audio must not start'); } };
  const assistant = createPageAssistantFixture(p, { async prompt(input) {
    const value = JSON.parse(input[0].content);
    if (value.kind === 'user-input') return JSON.stringify({ protocol: value.protocol, requestId: value.requestId,
      kind: 'tool', name: 'rabi_api_call', arguments: { method: 'GET', path: '/fixture/slow' } });
    assert.equal(value.kind, 'tool-observation'); return '原任务完成，文字完整保留。';
  } });
  p.ensureChatModel = async () => assistant; p.chatAssistant = assistant;
  const run = p.executeLingzhuAgentPrompt('执行原任务'); await settle();
  assert.equal(toolCalls, 1);
  p.onHide(); p.onHide();
  assert.equal(p.chatAssistant, assistant);
  assert.equal(p.deviceAgentTurnActive, true);
  finishTool({ result: { structuredContent: { ok: true, receipt: 'original' } } });
  assert.equal((await run).state, 'completed');
  assert.equal(toolCalls, 1); assert.equal(synthesized, 0);
  assert.equal(p.data.agentReplyText, '原任务完成，文字完整保留。');
  let starts = 0; p.scheduleTranscriptionRestart = () => { starts++; };
  p.onShow(); assert.equal(starts, 0); assert.equal(synthesized, 0);
  assistant.dispose();
});

test('manual voice pause survives hide/show and still projects later response text', async () => {
  const p = page(); prepareVisibilityLifecycle(p);
  p.ensureVoiceInteraction(); p.pauseTranscription(); p.onHide(); p.onShow();
  assert.equal(p.voiceInteraction.getState().outputEnabled, false);
  const response = p.beginVoiceResponse('muted-after-show');
  assert.equal(response.append('文字仍在。'), true); response.finish();
  assert.equal(response.getState().text, '文字仍在。');
  assert.equal(response.getState().suppressed, true);
  assert.equal(p.data.transcriptionDesired, false);
});

test('hide never claims a new mailbox delivery and does not retire its existing owner', async () => {
  const p = page(); prepareVisibilityLifecycle(p);
  const owner = { sessionId: 'original-session' }; p.deviceAgentOwner = owner;
  let claims = 0; p.processDeviceAgentMailbox = async () => { claims++; };
  p.onHide(); await p.runDeviceAgentMailbox(owner);
  assert.equal(claims, 0); assert.equal(p.deviceAgentOwner, owner);
  p.deviceAgentOwner = null;
});
