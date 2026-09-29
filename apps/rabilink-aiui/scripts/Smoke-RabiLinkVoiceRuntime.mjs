import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AIUI_NATIVE_VOICE_MODE,
  VoiceRuntimeError,
  createAiuiAsrInputAdapter,
  createAiuiTtsOutputAdapter
} from "../utils/voice-runtime.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimePath = path.join(projectRoot, "utils", "voice-runtime.js");
const runtimeSource = fs.readFileSync(runtimePath, "utf8");
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("Voice adapters must not call fetch.");
};

try {
  let clock = 1_784_031_100_000;
  const recognitions = [];
  class MockSpeechRecognition {
    constructor() {
      this.started = false;
      this.stopped = false;
      this.aborted = false;
      recognitions.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
      this.onend?.({ type: "end" });
    }
    abort() {
      this.aborted = true;
      this.onend?.({ type: "end" });
    }
  }

  const asr = createAiuiAsrInputAdapter({
    SpeechRecognitionCtor: MockSpeechRecognition,
    language: "zh-CN",
    now: () => clock
  });
  const asrCapability = asr.getCapability();
  assert.equal(asrCapability.mode, AIUI_NATIVE_VOICE_MODE);
  assert.equal(asrCapability.available, true);
  assert.equal(asrCapability.requiresApiKey, false);
  assert.equal(asrCapability.networkFallback, false);
  assert.equal(asrCapability.supportsContinuous, false);

  let finalResult = null;
  let nativeError = null;
  let endCount = 0;
  const recognition = asr.createRound({
    onFinal: (result) => { finalResult = result; },
    onError: (error) => { nativeError = error; },
    onEnd: () => { endCount += 1; }
  });
  asr.start(recognition);
  assert.equal(recognition.started, true);
  assert.equal(recognition.lang, "zh-CN");
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, false);
  recognition.onresult?.({ results: [[{ transcript: " 这是 AIUI 原生识别结果 " }]] });
  assert.deepEqual(finalResult, {
    resultId: `asr-${clock}-1`,
    text: "这是 AIUI 原生识别结果",
    final: true,
    capturedAt: clock,
    adapterId: "aiui-native-asr",
    mode: "aiui_native",
    locale: "zh-CN"
  });
  recognition.onerror?.({ error: "network" });
  assert(nativeError instanceof VoiceRuntimeError);
  assert.equal(nativeError.code, "asr_runtime_error");
  assert.equal(nativeError.nativeCode, "network");
  asr.stop(recognition, { graceful: true });
  assert.equal(recognition.stopped, true);
  assert.equal(endCount, 1);

  let interimText = "";
  let finalStreamResult = null;
  const streamingRecognition = asr.createRound({
    interimResults: true,
    onInterim: (result) => { interimText = result.text; },
    onFinal: (result) => { finalStreamResult = result; }
  });
  asr.start(streamingRecognition);
  assert.equal(streamingRecognition.interimResults, true);

  streamingRecognition.onresult?.({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "今天" }], { isFinal: false })
    ]
  });
  assert.equal(interimText, "今天");
  assert.equal(finalStreamResult, null);

  streamingRecognition.onresult?.({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "今天天气" }], { isFinal: false })
    ]
  });
  assert.equal(interimText, "今天天气");
  assert.equal(finalStreamResult, null);

  streamingRecognition.onresult?.({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "今天天气怎么样" }], { isFinal: true })
    ]
  });
  assert.equal(interimText, "今天天气");
  assert.equal(finalStreamResult?.text, "今天天气怎么样");
  assert.equal(finalStreamResult?.final, true);
  asr.stop(streamingRecognition, { graceful: true });

  const unavailableAsr = createAiuiAsrInputAdapter();
  assert.equal(unavailableAsr.getCapability().available, false);
  assert.equal(unavailableAsr.getCapability().mode, "aiui_native");
  assert.equal(unavailableAsr.getCapability().requiresApiKey, false);
  assert.match(unavailableAsr.getCapability().reason, /SpeechRecognition/);
  assert.throws(() => unavailableAsr.createRound(), (error) => {
    assert(error instanceof VoiceRuntimeError);
    assert.equal(error.code, "asr_unavailable");
    return true;
  });

  const spoken = [];
  let cancelled = 0;
  class MockUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
    }
  }
  const synthesis = {
    speak(utterance, mode) {
      spoken.push({ utterance, mode });
    },
    cancel() {
      cancelled += 1;
    }
  };
  const tts = createAiuiTtsOutputAdapter({
    speechSynthesisApi: synthesis,
    SpeechSynthesisUtteranceCtor: MockUtterance,
    language: "zh-CN",
    now: () => clock
  });
  const ttsCapability = tts.getCapability();
  assert.equal(ttsCapability.mode, "aiui_native");
  assert.equal(ttsCapability.available, true);
  assert.equal(ttsCapability.requiresApiKey, false);
  assert.equal(ttsCapability.networkFallback, false);
  assert.equal(ttsCapability.supportsPlaybackReceipt, false);
  assert.equal(ttsCapability.supportsCancel, true);

  let ttsEnded = 0;
  let ttsError = null;
  clock += 20;
  const playback = tts.speak("这是 AIUI 原生播报。", {
    messageId: "relay-message-1",
    mode: "enqueue",
    onEnd: () => { ttsEnded += 1; },
    onError: (error) => { ttsError = error; }
  });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].mode, "enqueue");
  assert.equal(spoken[0].utterance.text, "这是 AIUI 原生播报。");
  assert.equal(spoken[0].utterance.lang, "zh-CN");
  assert.equal(playback.attempt.accepted, true);
  assert.equal(playback.attempt.messageId, "relay-message-1");
  assert.equal(playback.attempt.mode, "aiui_native");
  assert.equal(playback.attempt.playbackReceipt, "not_supported");
  playback.utterance.onend?.({ type: "end" });
  assert.equal(ttsEnded, 1);
  playback.utterance.onerror?.({ error: "synthesis-failed" });
  assert(ttsError instanceof VoiceRuntimeError);
  assert.equal(ttsError.nativeCode, "synthesis-failed");
  assert.equal(tts.cancel(), true);
  assert.equal(cancelled, 1);

  // Test synthesize with subtitles: 'word' and SpeechAudioPlayer speech-text sync
  let syncedCueText = "";
  class MockSpeechAudioPlayer {
    constructor(task, playerOptions) {
      this.task = task;
      this.playerOptions = playerOptions;
      this.textTrack = {
        addEventListener(event, handler) {
          if (event === "cuechange") this._cueHandler = handler;
        },
        activeCues: {
          item(index) { return { text: "你好呀", startTime: 0, endTime: 0.5 }; }
        }
      };
      this.audioPlayer = {
        addEventListener(event, handler) {}
      };
    }
    play() {
      if (this.textTrack._cueHandler) this.textTrack._cueHandler();
    }
    stop() {}
    destroy() {}
  }
  const syncSynthesis = {
    speak() {},
    cancel() {},
    async synthesize(utterance, synthOptions) {
      assert.equal(synthOptions.subtitles, "word");
      return {
        id: "task-1",
        audioConfig: { format: "mp3" },
        finished: Promise.resolve({ duration: 1.5 }),
        abort() {}
      };
    }
  };
  const syncTts = createAiuiTtsOutputAdapter({
    speechSynthesisApi: syncSynthesis,
    SpeechSynthesisUtteranceCtor: MockUtterance,
    SpeechAudioPlayerCtor: MockSpeechAudioPlayer,
    language: "zh-CN"
  });
  const syncResult = await syncTts.synthesize("你好呀", {
    subtitles: "word",
    onCue: (cue) => { syncedCueText = cue.text; }
  });
  syncResult.player.play();
  assert.equal(syncedCueText, "你好呀");

  const unavailableTts = createAiuiTtsOutputAdapter();
  assert.equal(unavailableTts.getCapability().available, false);
  assert.equal(unavailableTts.getCapability().requiresApiKey, false);
  assert.match(unavailableTts.getCapability().reason, /speechSynthesis/);
  assert.throws(() => unavailableTts.speak("不会走 API"), (error) => {
    assert(error instanceof VoiceRuntimeError);
    assert.equal(error.code, "tts_unavailable");
    return true;
  });

  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(|wx\.request|XMLHttpRequest|new\s+WebSocket\s*\(/);
  assert.equal(networkCalls, 0, "AIUI native voice adapters must never use an ASR/TTS network fallback.");
  console.log("RabiLink AIUI native voice runtime smoke passed (ASR/TTS aiui_native, no API key, no network fallback, no false playback receipt)." );
} finally {
  globalThis.fetch = originalFetch;
}
