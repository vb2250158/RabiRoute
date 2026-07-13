import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";
import { VOICE_COMMANDS, parseConfigurationIntent, parseVoiceCommand, voiceCommandCases, voiceCommandSamples } from "../utils/voice-command.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(message);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function rewriteCompiledImports(stagingRoot) {
  const pagePath = path.join(stagingRoot, "pages", "home", "index.js");
  const source = readText(pagePath)
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s+"wx";/g, 'import $1 from "../../test-mocks/wx.js";');
  writeText(pagePath, source);

  writeText(path.join(stagingRoot, "test-mocks", "wx.js"), `
const storage = new Map();
export const wxCalls = { storageReads: 0, storageWrites: 0, requests: 0 };
export const agentMessageBatches = [];
let batteryInfo = {};
let mobileDeviceStatus = null;

export function setBatteryInfo(value = {}) {
  batteryInfo = value && typeof value === "object" ? value : {};
}

export function setMobileDeviceStatus(value = null) {
  mobileDeviceStatus = value && typeof value === "object" ? value : null;
}

export function resetWxCalls() {
  wxCalls.storageReads = 0;
  wxCalls.storageWrites = 0;
  wxCalls.requests = 0;
  agentMessageBatches.length = 0;
}

const wx = {
  getStorageSync(key) {
    wxCalls.storageReads += 1;
    return storage.get(key) || {};
  },
  setStorageSync(key, value) {
    wxCalls.storageWrites += 1;
    storage.set(key, value);
  },
  getBatteryInfoSync() {
    return batteryInfo;
  },
  showToast() {},
  showModal(options = {}) {
    if (typeof options.success === "function") options.success({ confirm: false, cancel: true });
  },
  request(options = {}) {
    wxCalls.requests += 1;
    if (String(options.url || "").endsWith("/api/rabilink/mobile/state")) {
      if (typeof options.success === "function") options.success({
        statusCode: 200,
        data: { code: 0, ok: true, workers: [], selectedWorker: {}, deviceStatus: mobileDeviceStatus }
      });
      return;
    }
    if (String(options.url || "").endsWith("/rokid/rabilink/input")) {
      if (typeof options.success === "function") options.success({
        statusCode: 202,
        data: { code: 0, ok: true, status: "accepted", eventId: "voice-event-smoke", nextCursor: "out-tail" }
      });
      return;
    }
    if (String(options.url || "").includes("/rokid/rabilink/messages?")) {
      const url = String(options.url || "");
      const isTail = url.includes("tail=1");
      const data = isTail
        ? { code: 0, ok: true, messages: [], done: false, shouldContinue: true, nextCursor: "out-tail" }
        : (agentMessageBatches.length
          ? agentMessageBatches.shift()
          : { code: 0, ok: true, messages: [], done: false, shouldContinue: true, nextCursor: "out-tail" });
      if (typeof options.success === "function") options.success({ statusCode: 200, data });
      return;
    }
    if (typeof options.fail === "function") options.fail({ errMsg: "mock wx.request disabled" });
  }
};

export default wx;
`);
}

function createPageInstance(pageModule) {
  const page = pageModule.default;
  if (!page || typeof page !== "object") fail("Compiled page did not export a page object.");
  const instance = {
    ...page,
    data: JSON.parse(JSON.stringify(page.data || {})),
    setData(patch = {}) {
      this.data = {
        ...this.data,
        ...patch
      };
    },
    recognition: null
  };
  return instance;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function voiceDispatchTargets() {
  const pageSource = readText(path.join(projectRoot, "pages", "home", "index.ink"));
  const start = pageSource.indexOf("  executeConfigurationIntent(text, source = \"native-agent\") {");
  const end = pageSource.indexOf("\n  say(text", start);
  assert(start >= 0 && end > start, "Could not isolate executeConfigurationIntent for dispatch coverage.");
  const source = pageSource.slice(start, end);
  const map = new Map();
  for (const match of source.matchAll(/if \(parsed\.command === VOICE_COMMANDS\.([A-Z_]+)\) return this\.([A-Za-z0-9_]+)\(/g)) {
    map.set(VOICE_COMMANDS[match[1]], match[2]);
  }
  for (const match of source.matchAll(/if \(parsed\.command === VOICE_COMMANDS\.([A-Z_]+)\) \{\s*this\.([A-Za-z0-9_]+)\(/g)) {
    map.set(VOICE_COMMANDS[match[1]], match[2]);
  }
  return map;
}

const stagingRoot = path.join(os.tmpdir(), `rabilink-aiui-runtime-smoke-${process.pid}-${Date.now()}`);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setInkNavigator(deviceSerialNumber = "", batteryManager = null) {
  const navigatorValue = {
    userAgent: "AIUI/0.14 Ink/0.14.0",
    platform: deviceSerialNumber ? "YodaOS Sprite" : "",
    getDeviceSerialNumber() {
      return deviceSerialNumber;
    }
  };
  if (batteryManager) navigatorValue.getBattery = () => Promise.resolve(batteryManager);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigatorValue
  });
}

function createBatteryManager(level = 0.62, charging = false) {
  const listeners = new Map([
    ["levelchange", new Set()],
    ["chargingchange", new Set()]
  ]);
  return {
    level,
    charging,
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    }
  };
}

try {
  setInkNavigator();
  const recognitions = [];
  const speechUtterances = [];
  let holdSpeech = false;
  globalThis.SpeechRecognition = class MockSpeechRecognition {
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
      if (typeof this.onend === "function") this.onend();
    }
    abort() {
      this.aborted = true;
      if (typeof this.onend === "function") this.onend();
    }
  };
  globalThis.SpeechSynthesisUtterance = class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.onend = null;
      this.onerror = null;
    }
  };
  globalThis.speechSynthesis = {
    speak(utterance) {
      speechUtterances.push(utterance);
      if (!holdSpeech) queueMicrotask(() => utterance.onend?.());
    },
    cancel() {}
  };

  await buildPackageStaging(stagingRoot);
  rewriteCompiledImports(stagingRoot);

  const wxModule = await import(pathToFileURL(path.join(stagingRoot, "test-mocks", "wx.js")).href);
  wxModule.resetWxCalls();
  const pageModule = await import(`${pathToFileURL(path.join(stagingRoot, "pages", "home", "index.js")).href}?smoke=${Date.now()}`);
  const page = createPageInstance(pageModule);

  const commandSamples = voiceCommandSamples();
  const commandCases = voiceCommandCases();
  const expectedCommands = Object.values(VOICE_COMMANDS).filter((command) => command !== VOICE_COMMANDS.UNKNOWN);
  assert(commandSamples.length === expectedCommands.length, "Every declared voice command must expose one regression-test sample phrase.");
  assert(new Set(commandSamples.map((sample) => sample.command)).size === expectedCommands.length, "Voice command samples must cover each command exactly once.");
  for (const sample of commandCases) {
    assert(parseVoiceCommand(sample.text).command === sample.command, `Voice parser must recognize ${sample.command}: ${sample.text}`);
    assert(parseConfigurationIntent(sample.text).command === sample.command, `Native Agent intent parser must accept exact command phrase ${sample.command}: ${sample.text}`);
  }
  assert(parseConfigurationIntent("帮我自己想想怎么配置").command === VOICE_COMMANDS.UNKNOWN, "Native Agent intents must not use fuzzy substring matching.");

  const dispatchTargets = voiceDispatchTargets();
  assert(dispatchTargets.size === expectedCommands.length, "executeConfigurationIntent must dispatch every declared non-unknown command.");
  const dispatchPage = createPageInstance(pageModule);
  dispatchPage.data.isConfigurationMode = true;
  dispatchPage.data.isTranscriptionMode = false;
  dispatchPage.say = () => {};
  for (const sample of commandSamples) {
    const expectedTarget = dispatchTargets.get(sample.command);
    const called = [];
    for (const handler of new Set(dispatchTargets.values())) {
      dispatchPage[handler] = () => {
        called.push(handler);
        return handler;
      };
    }
    dispatchPage.executeConfigurationIntent(sample.text);
    assert(called[0] === expectedTarget, `Voice command ${sample.command} must dispatch ${expectedTarget}, got ${called[0] || "nothing"}.`);
  }
  const requestsBeforeUnknownIntent = wxModule.wxCalls.requests;
  const unknownHandled = dispatchPage.executeConfigurationIntent("帮我看看为什么回复变慢了");
  assert(unknownHandled === false, "Unmatched natural language must be rejected until the native Agent supplies a concrete configuration command.");
  assert(wxModule.wxCalls.requests === requestsBeforeUnknownIntent, "Unknown configuration text must not create a Relay task or network request.");
  assert(dispatchPage.data.assistantStatus === "需要明确指令", "Unknown configuration text must explain that the native Agent needs to normalize the intent.");

  assert(typeof page.onLoad === "function", "Page must define onLoad.");
  assert(typeof page.updateDerivedState === "function", "Page must define updateDerivedState.");
  assert(typeof page.nextPanel === "function" && typeof page.prevPanel === "function", "Page must expose panel navigation.");
  assert(typeof page.selectedSurface === "function", "Page must expose linear surface navigation.");
  assert(typeof page.activateSurface === "function", "Page must expose the current surface primary action.");
  assert(typeof page.startTranscription === "function", "Page must expose foreground ASR startup.");
  assert(typeof page.flushTranscriptQueue === "function", "Page must expose transcript queue synchronization.");
  assert(typeof page.requestConfigurationAssistant === "function", "Page must expose in-page configuration mode switching.");
  assert(typeof page.selectTranscriptionMode === "function" && typeof page.selectConfigurationMode === "function", "Page must expose both positions of the visual mode rail.");
  assert(typeof page.executeConfigurationIntent === "function", "Page must execute normalized intents supplied by the native Agent.");
  assert(typeof page.submitAssistantIntent === "undefined" && typeof page.pollAssistantMessages === "undefined", "Configuration mode must not own a Relay task lifecycle.");
  assert(typeof page.refreshBatteryStatus === "function" && typeof page.updateDeviceClock === "function", "Page must expose lower-corner device status updates.");
  assert(typeof page.selectAgent === "function", "Page must expose agent selection.");
  assert(typeof page.applySelectedRemoteAgentDevice === "function", "Page must expose remote Agent selection.");

  page.onLoad();
  assert(page.data.maskedToken === "未设置", "onLoad should initialize masked token.");
  assert(page.data.mode === "transcription" && page.data.isTranscriptionMode, "Direct startup should default to transcription mode.");
  assert(page.data.transcriptionDesired === false && page.data.transcriptionState === "待运行智能体", "Craft preview startup should not seize ASR before an Agent invocation.");
  assert(page.data.panelId === "route", "onLoad should derive the first panel.");
  assert(page.data.surfaceId === "relay-status", "onLoad should start on the Relay status surface.");
  assert(Array.isArray(page.data.logs) && page.data.logs.length === 0, "onLoad should leave logging work until after the first frame.");
  assert(wxModule.wxCalls.storageReads === 0 && wxModule.wxCalls.requests === 0, "onLoad must not synchronously access storage or the network.");
  page.onReady();
  assert(page.startupActivated === false, "onReady should schedule startup without running it inline.");
  page.activateDeferredStartup();
  assert(page.startupActivated === true, "Deferred startup should activate explicitly after the first frame.");
  assert(wxModule.wxCalls.storageReads > 0, "Deferred startup should load local state after the first frame.");
  assert(page.data.logs.length > 0, "Deferred startup should append the startup log.");

  const batteryManager = createBatteryManager(0.62, false);
  setInkNavigator("ROKID-BATTERY-SMOKE", batteryManager);
  const batteryPage = createPageInstance(pageModule);
  batteryPage.onLoad({ mode: "transcription" });
  assert(/^\d{2}:\d{2}$/.test(batteryPage.data.currentTime), "The lower-left clock must initialize as HH:mm during onLoad.");
  const batteryResolved = await batteryPage.refreshBatteryStatus();
  assert(batteryResolved === true, "A host Web Battery provider should be accepted.");
  assert(batteryPage.data.batteryAvailable && batteryPage.data.batteryText === "62%", "Fractional Web Battery levels must normalize to an integer percentage.");
  assert(batteryPage.data.batteryFillClass === "batteryFillLevel60" && batteryPage.data.batteryCharging === false, "Battery fill and idle charge state must be derived together.");
  assert(batteryManager.listenerCount("levelchange") === 1 && batteryManager.listenerCount("chargingchange") === 1, "BatteryManager changes must remain live while the page is visible.");
  batteryManager.level = 0.81;
  batteryManager.charging = true;
  batteryManager.emit("chargingchange");
  assert(batteryPage.data.batteryText === "81%" && batteryPage.data.batteryCharging === true, "Charging changes must update the percentage and charge indicator without polling.");
  assert(batteryPage.data.batteryFillClass === "batteryFillLevel80" && batteryPage.data.batteryStatusLabel === "充电中 81%", "Charging UI metadata must match the latest host snapshot.");
  batteryPage.onHide();
  assert(batteryManager.listenerCount("levelchange") === 0 && batteryManager.listenerCount("chargingchange") === 0, "Hiding the page must release BatteryManager listeners.");
  batteryPage.onUnload();
  setInkNavigator();

  wxModule.setBatteryInfo({ level: 47, isCharging: true });
  const wxBatteryPage = createPageInstance(pageModule);
  wxBatteryPage.onLoad({ mode: "transcription" });
  const wxBatteryResolved = await wxBatteryPage.refreshBatteryStatus();
  assert(wxBatteryResolved === true, "A compatible wx.getBatteryInfoSync host extension should be accepted.");
  assert(wxBatteryPage.data.batteryText === "47%" && wxBatteryPage.data.batteryCharging === true, "Mini Program-style battery and charging fields must normalize together.");
  assert(wxBatteryPage.data.batteryFillClass === "batteryFillLevel50" && wxBatteryPage.data.batterySource === "wx.getBatteryInfoSync", "The compatible battery fallback must retain its source and bounded fill class.");
  wxBatteryPage.onUnload();
  wxModule.setBatteryInfo({});

  wxModule.setMobileDeviceStatus({
    batteryLevel: 98,
    charging: false,
    receivedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    staleAfterMs: 180000,
    stale: false,
    source: "rokid-cxr-phone"
  });
  const relayBatteryPage = createPageInstance(pageModule);
  relayBatteryPage.onLoad({ token: "tool-token-value", mode: "transcription" });
  const relayBatteryResolved = await relayBatteryPage.refreshBatteryStatus();
  assert(relayBatteryResolved === true, "A fresh phone-side Rokid CXR device status should be accepted when the Ink host has no battery API.");
  assert(relayBatteryPage.data.batteryText === "98%" && relayBatteryPage.data.batteryCharging === false, "Relay CXR battery and charging state must reach the HUD unchanged.");
  assert(relayBatteryPage.data.batterySource === "relay-cxr", "Relay battery state must retain a distinguishable real-device source.");

  wxModule.setMobileDeviceStatus({
    batteryLevel: 97,
    charging: true,
    receivedAt: new Date().toISOString(),
    staleAfterMs: 180000,
    stale: false,
    source: "rokid-cxr-phone"
  });
  await relayBatteryPage.refreshBatteryStatus();
  assert(relayBatteryPage.data.batteryText === "97%" && relayBatteryPage.data.batteryCharging === true, "A later CXR charging update must refresh the charge mark.");

  wxModule.setMobileDeviceStatus({
    batteryLevel: 97,
    charging: true,
    receivedAt: new Date(Date.now() - 240000).toISOString(),
    staleAfterMs: 180000,
    stale: true,
    source: "rokid-cxr-phone"
  });
  const staleRelayBatteryResolved = await relayBatteryPage.refreshBatteryStatus();
  assert(staleRelayBatteryResolved === false, "A stale Relay device status must be rejected.");
  assert(relayBatteryPage.data.batteryAvailable === false && relayBatteryPage.data.batteryText === "--", "A stale phone status must clear the prior percentage instead of fabricating freshness.");
  relayBatteryPage.onUnload();
  wxModule.setMobileDeviceStatus(null);

  const invokedPage = createPageInstance(pageModule);
  let invocationRequests = 0;
  invokedPage.reportRuntimeProof = () => Promise.resolve(false);
  invokedPage.executeConfigurationIntent = async (text, source) => {
    if (text === "查看当前人格配置") invocationRequests += 1;
    assert(source === "native-agent", "Deferred configuration execution must retain native Agent provenance.");
    return true;
  };
  invokedPage.onLoad({
    token: "tool-token-value",
    mode: "configuration",
    surface: "config",
    panel: "persona",
    intent: "查看当前人格配置",
    targetDeviceId: "pc-bound"
  });
  assert(invokedPage.data.token === "tool-token-value", "Agent invocation should provide a transient tool token.");
  assert(invokedPage.data.mode === "configuration" && invokedPage.data.isConfigurationMode, "Configuration tool invocation should open configuration mode.");
  assert(invokedPage.data.surfaceId === "config-persona", "Agent invocation should open the requested configuration surface.");
  assert(invokedPage.data.panelId === "persona", "Agent invocation should select the requested configuration panel.");
  assert(invokedPage.data.invocationIntent === "查看当前人格配置", "Agent invocation should preserve the original intent.");
  assert(invokedPage.data.targetDeviceId === "pc-bound", "Agent invocation should honor an explicit PC target.");
  assert(invocationRequests === 0, "Agent invocation must not submit work during synchronous onLoad.");
  invokedPage.onReady();
  invokedPage.activateDeferredStartup();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(invocationRequests === 1, "A native Agent invocation should execute its normalized configuration intent once after first render.");

  const browserPage = createPageInstance(pageModule);
  browserPage.reportRuntimeProof = () => Promise.resolve(false);
  browserPage.connectTranscriptionRelay = async () => true;
  const browserRecognitionCount = recognitions.length;
  browserPage.onLoad({ token: "tool-token-value", mode: "transcription" });
  browserPage.onReady();
  browserPage.activateDeferredStartup();
  assert(recognitions.length === browserRecognitionCount, "Craft card preview must not start ASR before Interactive InkView is open.");
  assert(browserPage.data.transcriptionDesired === false, "Craft card preview must wait for an interactive wakeup before enabling ASR.");
  assert(browserPage.data.transcriptionState === "浏览器调试：进入后点麦克风", "Craft card preview must explain how to activate the ASR simulator.");
  browserPage.onVoiceWakeup({ keyword: "leqi" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(recognitions.length === browserRecognitionCount + 1 && recognitions.at(-1)?.started, "Craft Interactive InkView wakeup should start simulated ASR.");
  browserPage.onUnload();

  setInkNavigator("ROKID-SMOKE-DEVICE");
  const transcriptPage = createPageInstance(pageModule);
  transcriptPage.reportRuntimeProof = () => Promise.resolve(false);
  transcriptPage.connectTranscriptionRelay = async () => true;
  transcriptPage.onLoad({ token: "tool-token-value", mode: "transcription" });
  transcriptPage.onReady();
  transcriptPage.activateDeferredStartup();
  transcriptPage.clearTranscriptionRestart();
  transcriptPage.startTranscription();
  const activeRecognition = recognitions.at(-1);
  assert(activeRecognition?.started, "Transcription mode should start a real SpeechRecognition round after first render.");
  holdSpeech = true;
  wxModule.agentMessageBatches.push({
    code: 0,
    ok: true,
    done: false,
    shouldContinue: true,
    nextCursor: "out-agent-1",
    messages: [{ id: "out-agent-1", text: "这是 Codex 返回的第一条回复。", final: true }]
  });
  activeRecognition.onresult?.({ results: [[{ transcript: "这是一段真实 ASR 结果" }]] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(transcriptPage.data.transcriptionText === "这是一段真实 ASR 结果", "ASR result should update the foreground transcript HUD.");
  assert(transcriptPage.data.transcriptionSyncedCount === 1, "Final ASR text should be submitted directly through the Relay HTTP endpoint.");
  assert(transcriptPage.data.transcriptionPendingCount === 0, "Successful transcript submission should drain the local queue.");
  assert(transcriptPage.data.agentReplyText === "这是 Codex 返回的第一条回复。", "Connection conversation must display each normal message from the global stream without task filtering.");
  assert(speechUtterances.at(-1)?.text === "这是 Codex 返回的第一条回复。", "Connection conversation must send each downlink message to AIUI TTS.");
  assert(activeRecognition.aborted && transcriptPage.data.agentSpeaking, "Agent TTS must release ASR before playback starts.");
  speechUtterances.at(-1)?.onend?.();
  const recognitionCountBeforeResume = recognitions.length;
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert(recognitions.length > recognitionCountBeforeResume && recognitions.at(-1)?.started, "ASR must resume after Agent TTS finishes.");

  wxModule.agentMessageBatches.push({
    code: 0,
    ok: true,
    done: false,
    shouldContinue: true,
    nextCursor: "out-proactive-1",
    messages: [{ id: "out-proactive-1", text: "这是 Rabi 主动投递的提醒。", final: true, proactive: true }]
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert(transcriptPage.data.agentReplyText === "这是 Rabi 主动投递的提醒。", "The foreground Agent stream must display proactive messages without a pending task.");
  assert(speechUtterances.at(-1)?.text === "这是 Rabi 主动投递的提醒。", "Proactive Rabi messages must enter the same ordered TTS queue.");
  speechUtterances.at(-1)?.onend?.();
  holdSpeech = false;

  const retryPage = createPageInstance(pageModule);
  retryPage.reportRuntimeProof = () => Promise.resolve(false);
  retryPage.connectTranscriptionRelay = async () => true;
  retryPage.onLoad({ token: "tool-token-value", mode: "transcription" });
  retryPage.onReady();
  retryPage.activateDeferredStartup();
  retryPage.clearTranscriptionRestart();
  retryPage.startTranscription();
  const failedRecognition = recognitions.at(-1);
  failedRecognition.onerror?.({ error: "network" });
  assert(retryPage.recognition === null, "ASR errors should release the failed recognition without waiting for an end event.");
  assert(retryPage.transcriptionFailureCount === 1, "ASR errors should increment the bounded retry counter.");
  assert(Boolean(retryPage.transcriptionRestartTimer), "A transient ASR error should schedule a backoff retry.");
  retryPage.onUnload();

  let finishCalls = 0;
  transcriptPage.finish = () => { finishCalls += 1; };
  const recognitionBeforeConfig = transcriptPage.recognition;
  const downSwipe = { code: "ArrowDown", prevented: false, preventDefault() { this.prevented = true; } };
  transcriptPage.onKeyUp(downSwipe);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(!recognitionBeforeConfig || recognitionBeforeConfig.stopped || recognitionBeforeConfig.aborted, "Switching to the configuration assistant should release ASR first.");
  assert(transcriptPage.data.mode === "configuration" && transcriptPage.data.isConfigurationMode, "A physical down/back swipe should switch to configuration mode in the same page.");
  assert(transcriptPage.data.assistantStatus === "等待原生 Agent", "Configuration mode should wait for a normalized native Agent invocation instead of starting its own task flow.");
  assert(finishCalls === 0, "Switching modes must not close the AIUI page through page.finish().");
  assert(downSwipe.prevented, "A handled physical swipe should prevent the default scroll behavior.");
  const assistantRecognitionCount = recognitions.length;
  const assistantSpeakSwipe = { code: "ArrowDown", prevented: false, preventDefault() { this.prevented = true; } };
  transcriptPage.onKeyUp(assistantSpeakSwipe);
  assert(recognitions.length === assistantRecognitionCount, "Configuration mode must not start a second page-owned SpeechRecognition session.");
  assert(!assistantSpeakSwipe.prevented, "An unsupported configuration gesture must remain available to the native Agent host.");
  transcriptPage.data.transcriptionElapsed = "585:00";
  transcriptPage.data.transcriptionStartedAt = 1;
  const upReturnSwipe = { code: "ArrowUp", prevented: false, preventDefault() { this.prevented = true; } };
  transcriptPage.onKeyUp(upReturnSwipe);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(transcriptPage.data.mode === "transcription" && transcriptPage.data.isTranscriptionMode, "A physical up/forward swipe should return configuration mode to transcription.");
  assert(transcriptPage.data.transcriptionDesired === true, "Returning to transcription should resume the foreground ASR intent.");
  assert(transcriptPage.data.transcriptionElapsed === "00:00" && transcriptPage.data.transcriptionStartedAt > 1, "Returning to transcription must reset stale reused session duration.");
  assert(finishCalls === 0, "A complete mode round trip must keep the same AIUI page alive.");
  assert(upReturnSwipe.prevented, "The handled return swipe should prevent default scrolling.");
  transcriptPage.onUnload();

  const compatibilityPage = createPageInstance(pageModule);
  compatibilityPage.data.isTranscriptionMode = true;
  compatibilityPage.data.isConfigurationMode = false;
  const compatibilityGestures = [];
  compatibilityPage.requestConfigurationAssistant = (reason) => compatibilityGestures.push(reason);
  compatibilityPage.onKeyUp({ keyCode: 20, preventDefault() {} });
  compatibilityPage.onKeyUp({ detail: { keyCode: 40 }, preventDefault() {} });
  compatibilityPage.onKeyUp({ detail: { code: "KEYCODE_DPAD_DOWN" }, preventDefault() {} });
  assert(compatibilityGestures.length === 3, "Touchpad input should accept Android, browser, and wrapped Ink down-key event shapes.");

  const navigationPage = createPageInstance(pageModule);
  navigationPage.onLoad({ mode: "configuration", surface: "status" });
  navigationPage.onReady();
  navigationPage.activateDeferredStartup();
  navigationPage.nextPanel();
  assert(navigationPage.data.surfaceIndex === 1 && navigationPage.data.surfaceId === "relay-settings", "nextPanel should advance to Relay credentials.");
  navigationPage.prevPanel();
  assert(navigationPage.data.surfaceIndex === 0 && navigationPage.data.surfaceId === "relay-status", "prevPanel should return to Relay status.");

  page.selectAgent({ currentTarget: { dataset: { agent: "copilotCli" } } });
  assert(page.data.agentAdapter === "copilotCli", "selectAgent should switch agent adapter.");

  page.setRemoteAgentDevices([
    { deviceId: "pc-remote", deviceName: "远端 PC", connected: true, defaultCwd: "D:/Workspace/RabiRoute", defaultThreadName: "Rabi" }
  ]);
  assert(page.data.remoteAgentDeviceLabel.includes("远端 PC"), "setRemoteAgentDevices should derive a readable label.");
  page.applySelectedRemoteAgentDevice();
  assert(page.data.integrationRemoteAgentDeviceId === "pc-remote", "applySelectedRemoteAgentDevice should patch current route draft fields.");

  const configurationReturnPage = createPageInstance(pageModule);
  configurationReturnPage.onLoad({ mode: "configuration", surface: "config", panel: "tools" });
  const pageUpSwipe = { detail: { code: "ArrowUp" }, prevented: false, preventDefault() { this.prevented = true; } };
  configurationReturnPage.onKeyUp(pageUpSwipe);
  assert(configurationReturnPage.data.mode === "transcription" && configurationReturnPage.data.isTranscriptionMode, "A physical up/forward swipe must leave configuration mode regardless of legacy invocation hints.");
  assert(pageUpSwipe.prevented, "The physical return swipe should prevent default scrolling.");
  const leftSwipe = { detail: { code: "ArrowLeft" }, prevented: false, preventDefault() { this.prevented = true; } };
  invokedPage.onKeyUp(leftSwipe);
  assert(invokedPage.data.mode === "transcription" && invokedPage.data.isTranscriptionMode, "A physical left/back swipe should return the configuration UI to transcription mode.");
  assert(leftSwipe.prevented, "The handled return swipe should prevent default scrolling.");

  const assistantPage = createPageInstance(pageModule);
  assistantPage.reportRuntimeProof = () => Promise.resolve(false);
  assistantPage.onLoad({ token: "tool-token-value", mode: "configuration" });
  assistantPage.onReady();
  assistantPage.activateDeferredStartup();
  let directConfigCalls = 0;
  assistantPage.loadWebguiConfig = () => {
    directConfigCalls += 1;
    return true;
  };
  const configExecuted = assistantPage.executeConfigurationIntent("读取配置", "native-agent");
  assert(configExecuted === true && directConfigCalls === 1, "A normalized native Agent intent must call the matching AIUI configuration API directly.");
  assert(!Object.hasOwn(assistantPage.data, "assistantTaskId") && !Object.hasOwn(assistantPage.data, "assistantCursor"), "Configuration state must not contain task or polling cursors.");
  const requestsBeforeUnknown = wxModule.wxCalls.requests;
  const unknownConfigResult = assistantPage.executeConfigurationIntent("帮我自己想想怎么配置", "native-agent");
  assert(unknownConfigResult === false && wxModule.wxCalls.requests === requestsBeforeUnknown, "An ambiguous native Agent intent must not fall back to a Relay task.");
  const configRecognitionCount = recognitions.length;
  assistantPage.onVoiceWakeup({ keyword: "leqi" });
  assert(recognitions.length === configRecognitionCount, "Configuration wakeup must remain owned by the native Agent instead of page ASR.");

  const roundTripPage = createPageInstance(pageModule);
  roundTripPage.finish = () => { finishCalls += 1; };
  roundTripPage.onLoad({ mode: "transcription" });
  for (let cycle = 0; cycle < 20; cycle += 1) {
    roundTripPage.onKeyUp({ code: "ArrowDown", preventDefault() {} });
    assert(roundTripPage.data.isConfigurationMode, `Mode cycle ${cycle + 1} should enter configuration.`);
    roundTripPage.onKeyUp({ code: "ArrowUp", preventDefault() {} });
    assert(roundTripPage.data.isTranscriptionMode, `Mode cycle ${cycle + 1} should return to transcription.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(finishCalls === 0, "Repeated mode switching must never close the AIUI page.");

  const voiceRoundTripPage = createPageInstance(pageModule);
  voiceRoundTripPage.finish = () => { finishCalls += 1; };
  voiceRoundTripPage.onLoad({ mode: "configuration" });
  voiceRoundTripPage.executeConfigurationIntent("切到连接对话", "native-agent");
  assert(voiceRoundTripPage.data.isTranscriptionMode, "The voice command should switch configuration back to transcription.");
  voiceRoundTripPage.handleTranscriptionResult("切到配置助手");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(voiceRoundTripPage.data.isConfigurationMode, "The transcription voice command should switch to configuration in-page.");
  assert(finishCalls === 0, "Voice mode switching must not close the AIUI page.");

  page.onUnload();
  invokedPage.onUnload();
  navigationPage.onUnload();
  configurationReturnPage.onUnload();
  roundTripPage.onUnload();
  voiceRoundTripPage.onUnload();
  assistantPage.onUnload();

  console.log(`RabiLink AIUI runtime smoke passed (${expectedCommands.length} commands / ${commandCases.length} phrases, 20 mode round trips, continuous normal/proactive stream, native-Agent configuration).`);
} finally {
  delete globalThis.SpeechRecognition;
  delete globalThis.SpeechSynthesisUtterance;
  delete globalThis.speechSynthesis;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete globalThis.navigator;
  }
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
