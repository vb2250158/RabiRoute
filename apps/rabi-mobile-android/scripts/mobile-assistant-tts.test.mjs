import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const assets = new URL('../app/src/main/assets/mobile-assistant/', import.meta.url);
const entry = await readFile(new URL('entry.js', assets), 'utf8');
const markup = await readFile(new URL('index.html', assets), 'utf8');
// Execute the actual WebView entry point with the Android bridge and browser audio replaced.
const app = new vm.Script(entry.replace(/^import\s.*;\r?\n/gm, '') + '\nglobalThis.testVoice = { tts, appendSpeechText };');

async function open(state, selectedModels = {}) {
  const requests = [];
  const playerEvents = [];
  const nodes = Object.fromEntries(Array.from(markup.matchAll(/\bid="([^"]+)"/g), ([, id]) => [id, {
    id, textContent: '', hidden: false, appendChild: node => node, addEventListener() {},
  }]));
  let player;
  let uuid = 0;
  const window = { addEventListener() {} };
  const context = {
    window,
    document: { querySelectorAll: () => Object.values(nodes), createElement: () => ({}) },
    crypto: { randomUUID: () => `test-${++uuid}` },
    Blob,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => playerEvents.push('release') },
    atob,
    Audio: class {
      constructor() { player = this; this.duration = 2; this.currentTime = 0; }
      async play() { playerEvents.push('play'); }
      pause() { playerEvents.push('stop'); }
      load() {}
      removeAttribute() {}
    },
    createAiuiAssistantRuntime: value => value,
    createVoiceInteraction: () => ({}),
    createVoiceIdleTimer: () => ({}),
    createPhoneCapture: () => ({ beforePlayback: async () => playerEvents.push('prepare') }),
    createStreamingRecognition: () => ({}),
    createLocalWakeRecognition: () => ({}),
    createLocalAsrAvailabilityRefresh: () => ({ stop() {}, sync() {} }),
    matchWakeWord() {},
    RabiMobile: {
      voiceEnabled: () => true,
      selectedModel: kind => selectedModels[kind] ? JSON.stringify(selectedModels[kind]) : '',
      send(id, operation, body) {
        requests.push({ operation, body: JSON.parse(body) });
        const payload = operation === 'state' ? JSON.stringify(state)
          : operation === 'messages' ? JSON.stringify({ sessionId: state.sessionId, messages: [] })
            : 'AA==';
        queueMicrotask(() => window.mobileReply(id, true, payload));
      },
    },
  };
  app.runInNewContext(context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, ...context.testVoice, playerEvents, get player() { return player; } };
}

const base = {
  sessionId: 'current-session', capabilities: { mobileVoiceSubmit: true }, settings: { voiceEnabled: true },
  hostSettings: {
    personaId: 'fixture-persona', personaLabel: '测试角色', asrModel: '',
    ttsSource: 'custom', ttsModel: '', voiceReady: false,
    mobileAudio: { recognition: 'streaming', sampleRate: 16000 },
  },
};
const custom = { ...base, capabilities: { ...base.capabilities, mobileCustomTts: true } };

test('ready custom TTS plays the exact assistant passage with the paired session and row identity', async () => {
  const fixture = await open(custom);
  assert.equal(fixture.nodes.start.disabled, false);
  const response = await fixture.tts.synthesize('第一句。', {
    responseId: 'reply-transcript-id', textOffset: 7,
    expression: { instructions: '客户端不覆盖电脑的表达', speed: 2 },
  });
  assert.deepEqual(fixture.requests.at(-1), {
    operation: 'assistant-tts', body: { sessionId: 'current-session', responseId: 'reply-transcript-id', input: '第一句。' },
  });
  await response.player.play();
  response.player.stop();
  assert.deepEqual(fixture.playerEvents, ['prepare', 'play', 'stop', 'release']);
});

test('legacy host stays ready and uses its existing model, voice and expression request', async () => {
  const fixture = await open({ ...base, hostSettings: { ...base.hostSettings, ttsSource: 'host', ttsModel: 'legacy-model', voiceReady: true } });
  assert.equal(fixture.nodes.start.disabled, false);
  await fixture.tts.synthesize('仍然可播。', { responseId: 'reply-unused-by-legacy', expression: { instructions: '平静', speed: 1.25 } });
  assert.deepEqual(fixture.requests.at(-1), {
    operation: 'tts', body: { model: 'legacy-model', voice: 'fixture-persona', input: '仍然可播。',
      sessionId: 'mobile.test-3', instructions: '平静', speed: 1.25 },
  });
});

test('the phone can select a hosted TTS model without changing the paired PC settings', async () => {
  const fixture = await open({ ...base, settings:{ voiceEnabled:false },
    capabilities:{ ...base.capabilities, mobileIndependentVoice:true } }, { tts: {machine:'other-pc', model:'tts/other'} });
  assert.equal(fixture.nodes.start.disabled, false);
  const response = await fixture.tts.synthesize('在手机播报。');
  assert.equal(fixture.requests.at(-1).operation, 'model-tts');
  assert.equal(fixture.requests.at(-1).body.model, 'tts/other');
  await response.player.play();
  assert.deepEqual(fixture.playerEvents, ['prepare', 'play']);
});

test('only a ready advertised custom provider enables the mobile realtime control', async () => {
  for (const state of [base, { ...custom, capabilities: { ...custom.capabilities, mobileCustomTts: false } },
    { ...custom, capabilities: { ...custom.capabilities, mobileVoiceSubmit: false } },
    { ...custom, hostSettings: { ...custom.hostSettings, asrIssue: '电脑识别不可用' } },
    { ...custom, settings: { voiceEnabled: false } }, { ...custom, sessionId: '' }]) {
    const fixture = await open(state);
    assert.equal(fixture.nodes.start.disabled, true);
  }
  assert.match((await open(base)).nodes.issue.textContent, /自定义播报暂不可用/);
});

test('interrupting a custom synthesis discards a late WAV without creating a player', async () => {
  const fixture = await open(custom);
  const controller = new AbortController();
  const loading = fixture.tts.synthesize('还没开始播。', { responseId: 'reply-transcript-id', signal: controller.signal });
  controller.abort();
  await assert.rejects(loading, { name: 'AbortError' });
  assert.equal(fixture.player, undefined);
});

test('an authoritative boundary still splits a full snapshot after a quick tool is missed', async () => {
  const { appendSpeechText } = await open(custom);
  const spoken = [];
  const turn = { spoken: '', token: {
    append: text => spoken.push(text), finishSpeechSegment: () => spoken.push('segment-end'),
  } };
  const opening = '𠮷，我查一下';
  appendSpeechText(turn, opening + '结果到了。', [opening.length]);
  assert.deepEqual(spoken, [opening, 'segment-end', '结果到了。']);
});

test('a boundary at the previously observed text flushes that tail only once', async () => {
  const { appendSpeechText } = await open(custom);
  const spoken = [];
  const turn = { spoken: '', token: {
    append: text => spoken.push(text), finishSpeechSegment: () => spoken.push('segment-end'),
  } };
  const opening = '我查一下';
  appendSpeechText(turn, opening, []);
  appendSpeechText(turn, opening, [opening.length]);
  appendSpeechText(turn, opening + '查到了。', [opening.length]);
  assert.deepEqual(spoken, [opening, 'segment-end', '查到了。']);
});
