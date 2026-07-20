import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";
import {
  CONFIGURATION_ACTION_TOOL,
  VOICE_COMMANDS,
  configurationCommandFromToolCall,
  configurationLanguageModelOptions,
  parseConfigurationIntent,
  parseVoiceCommand,
  voiceCommandCases,
  voiceCommandSamples
} from "../utils/voice-command.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const craftRelease = JSON.parse(readText(path.join(projectRoot, "craft-release.json")));

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
export const wxCalls = { storageReads: 0, storageWrites: 0, requests: 0, requestBodies: [] };
export const agentMessageBatches = [];
let batteryInfo = {};
let mobileDeviceStatus = null;
let inputFailuresRemaining = 0;

export function setBatteryInfo(value = {}) {
  batteryInfo = value && typeof value === "object" ? value : {};
}

export function setMobileDeviceStatus(value = null) {
  mobileDeviceStatus = value && typeof value === "object" ? value : null;
}

export function failNextInputs(count = 1) {
  inputFailuresRemaining = Math.max(0, Number(count || 0));
}

export function resetWxCalls() {
  wxCalls.storageReads = 0;
  wxCalls.storageWrites = 0;
  wxCalls.requests = 0;
  wxCalls.requestBodies.length = 0;
  agentMessageBatches.length = 0;
}

export function setStorageValue(key, value) {
  storage.set(key, value);
}

export function getStorageValue(key) {
  return storage.get(key);
}

export function getStorageKeys() {
  return [...storage.keys()];
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
  removeStorageSync(key) {
    wxCalls.storageWrites += 1;
    storage.delete(key);
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
    wxCalls.requestBodies.push({ url: String(options.url || ""), method: options.method || "GET", data: options.data || null });
    if (String(options.url || "").endsWith("/api/rabilink/mobile/state")) {
      if (typeof options.success === "function") options.success({
        statusCode: 200,
        data: { code: 0, ok: true, workers: [], selectedWorker: {}, deviceStatus: mobileDeviceStatus }
      });
      return;
    }
    if (String(options.url || "").endsWith("/api/rabilink/devices/logs")) {
      if (typeof options.success === "function") options.success({
        statusCode: 202,
        data: {
          code: 0,
          ok: true,
          status: "stored",
          accepted: Array.isArray(options.data?.logs) ? options.data.logs.length : 0
        }
      });
      return;
    }
    if (String(options.url || "").endsWith("/api/rabilink/devices/token")) {
      if (typeof options.success === "function") options.success({
        statusCode: 201,
        data: { code: 0, ok: true, token: "rbd_runtime-smoke-device-token" }
      });
      return;
    }
    if (String(options.url || "").endsWith("/rokid/rabilink/input")) {
      if (inputFailuresRemaining > 0) {
        inputFailuresRemaining -= 1;
        if (typeof options.fail === "function") options.fail({ errMsg: "mock input offline" });
        return;
      }
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
  const start = pageSource.indexOf("  executeConfigurationIntent(text, source = \"native-agent\", displayText = \"\") {");
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
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const localStorageValues = new Map();

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
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key) {
        return localStorageValues.has(String(key)) ? localStorageValues.get(String(key)) : null;
      },
      setItem(key, value) {
        localStorageValues.set(String(key), String(value));
      },
      removeItem(key) {
        localStorageValues.delete(String(key));
      },
      clear() {
        localStorageValues.clear();
      }
    }
  });
  setInkNavigator();
  const recognitions = [];
  const speechUtterances = [];
  const speechModes = [];
  let holdSpeech = false;
  let failingSpeechText = "";
  let suppressSpeechEvents = false;
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
    speak(utterance, mode) {
      speechUtterances.push(utterance);
      speechModes.push(mode);
      if (!holdSpeech && !suppressSpeechEvents) {
        queueMicrotask(() => {
          if (failingSpeechText && utterance.text === failingSpeechText) utterance.onerror?.({ error: "simulated-tts-failure" });
          else utterance.onend?.();
        });
      }
    },
    cancel() {}
  };
  const languageModelSessions = [];
  const languageModelPrompts = [];
  let nextLanguageModelCommand = VOICE_COMMANDS.LOAD_CONFIG;
  let nextLanguageModelReply = "";
  let nextLanguageModelError = null;
  globalThis.LanguageModel = {
    async availability() {
      return "available";
    },
    async create(options = {}) {
      const listeners = new Map();
      const session = {
        options,
        destroyed: false,
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
        async prompt(input) {
          languageModelPrompts.push(input);
          if (nextLanguageModelError) {
            const error = nextLanguageModelError;
            nextLanguageModelError = null;
            throw error;
          }
          if (nextLanguageModelCommand) {
            listeners.get("toolcall")?.({
              functionName: CONFIGURATION_ACTION_TOOL,
              arguments: { command: nextLanguageModelCommand },
              isComplete: true
            });
          }
          return nextLanguageModelReply;
        },
        destroy() {
          this.destroyed = true;
          listeners.clear();
        }
      };
      languageModelSessions.push(session);
      return session;
    }
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
  const modelOptions = configurationLanguageModelOptions();
  assert(modelOptions.initialPrompts?.[0]?.role === "system", "Configuration LanguageModel must start with a bounded system instruction.");
  assert(modelOptions.tools?.[0]?.function?.name === CONFIGURATION_ACTION_TOOL, "Configuration LanguageModel must expose one whitelisted action tool.");
  assert(modelOptions.tools[0].function.parameters.properties.command.enum.length === expectedCommands.length, "Configuration LanguageModel tool enum must cover every executable command.");
  assert(configurationCommandFromToolCall({
    functionName: CONFIGURATION_ACTION_TOOL,
    arguments: JSON.stringify({ command: VOICE_COMMANDS.LOAD_CONFIG }),
    isComplete: true
  }) === VOICE_COMMANDS.LOAD_CONFIG, "A complete native LanguageModel tool call must normalize its command.");
  assert(configurationCommandFromToolCall({
    functionName: CONFIGURATION_ACTION_TOOL,
    arguments: { command: "notAllowed" },
    isComplete: true
  }) === "", "Unknown LanguageModel tool commands must be rejected before dispatch.");
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
  assert(typeof page.handleConfigurationSpeechResult === "function", "Page must dispatch direct configuration ASR results.");
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
  page.setData({ currentTime: "12:34" });
  assert(page.data.modeFrameRelayout === false, "Ordinary clock or status updates must not blank and relayout the whole HUD.");
  assert(page.data.mode === "transcription" && page.data.isTranscriptionMode, "Direct startup should default to transcription mode.");
  assert(
    page.data.transcriptionDesired === false
      && page.data.transcriptionState === "等待绑定"
      && page.data.needsDeviceSetup === true,
    "A tokenless startup must enter Setup without seizing ASR."
  );
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

  wxModule.setStorageValue("rabilink-aiui-settings", {
    token: "legacy-local-token-must-be-removed",
    targetDeviceId: "legacy-device"
  });
  const legacyTokenPage = createPageInstance(pageModule);
  legacyTokenPage.onLoad();
  legacyTokenPage.activateDeferredStartup();
  const migratedSettings = wxModule.getStorageValue("rabilink-aiui-settings");
  assert(legacyTokenPage.data.token === "", "A fresh page must not reuse a token persisted by an older package.");
  assert(!Object.prototype.hasOwnProperty.call(migratedSettings, "token"), "Deferred startup must remove a legacy plaintext token from local storage.");
  assert(migratedSettings.targetDeviceId === "legacy-device", "Legacy token migration must preserve non-secret page settings.");
  legacyTokenPage.onUnload();
  wxModule.setStorageValue("rabilink-aiui-settings", {});

  const legacyQueueToken = "legacy-queue-token-value";
  const legacyQueueTokenKey = "legacy...alue";
  const legacyQueueStorageKey = `rabilink-aiui-agent-message-queue:${legacyQueueTokenKey}`;
  wxModule.setStorageValue("rabilink-aiui-settings", {
    agentCursor: "legacy-cursor",
    agentCursorTokenKey: legacyQueueTokenKey
  });
  wxModule.setStorageValue(legacyQueueStorageKey, {
    tokenKey: legacyQueueTokenKey,
    messages: [{ id: "legacy-downlink", text: "升级后仍要保留的待播报消息", createdAt: Date.now() }]
  });
  const legacyQueuePage = createPageInstance(pageModule);
  legacyQueuePage.onLoad({ token: legacyQueueToken, mode: "configuration" });
  legacyQueuePage.activateDeferredStartup();
  const migratedQueueSettings = wxModule.getStorageValue("rabilink-aiui-settings");
  assert(legacyQueuePage.data.agentCursor === "legacy-cursor", "Opaque token fingerprint migration must preserve the matching Relay cursor.");
  assert(legacyQueuePage.agentMessageQueue.length === 1, "Opaque token fingerprint migration must preserve the matching pending TTS queue.");
  assert(/^v2-[0-9a-f]{16}$/.test(migratedQueueSettings.agentCursorTokenKey), "A legacy masked cursor scope must migrate to an opaque fingerprint.");
  assert(wxModule.getStorageValue(legacyQueueStorageKey) === undefined, "A migrated queue must remove the storage key containing old token fragments.");
  legacyQueuePage.onUnload();
  wxModule.setStorageValue("rabilink-aiui-settings", {});

  const batteryManager = createBatteryManager(0.62, false);
  setInkNavigator("ROKID-BATTERY-SMOKE", batteryManager);
  const batteryPage = createPageInstance(pageModule);
  batteryPage.onLoad({ mode: "transcription" });
  assert(/^\d{2}:\d{2}$/.test(batteryPage.data.currentTime), "The lower-left clock must initialize as HH:mm during onLoad.");
  const batteryResolved = await batteryPage.refreshBatteryStatus();
  assert(batteryResolved === false, "A generic host Web Battery provider must not be mislabeled as glasses battery.");
  assert(!batteryPage.data.batteryAvailable && batteryPage.data.batteryText === "--", "Unverified host battery data must keep the HUD explicitly unknown.");
  assert(batteryManager.listenerCount("levelchange") === 0 && batteryManager.listenerCount("chargingchange") === 0, "The AIUI page must not subscribe to an unverified host BatteryManager.");
  batteryPage.onHide();
  batteryPage.onUnload();
  setInkNavigator();

  wxModule.setBatteryInfo({ level: 47, isCharging: true });
  const wxBatteryPage = createPageInstance(pageModule);
  wxBatteryPage.onLoad({ mode: "transcription" });
  const wxBatteryResolved = await wxBatteryPage.refreshBatteryStatus();
  assert(wxBatteryResolved === false, "A generic wx battery field must not be accepted as proof of glasses battery.");
  assert(wxBatteryPage.data.batteryText === "--" && wxBatteryPage.data.batterySource === "", "Unverified Mini Program battery data must remain unknown.");
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

  setInkNavigator("ROKID-SETUP-SMOKE");
  const setupPage = createPageInstance(pageModule);
  setupPage.reportRuntimeProof = () => Promise.resolve(false);
  setupPage.connectTranscriptionRelay = async () => true;
  setupPage.startTranscriptionClock = () => {};
  setupPage.scheduleTranscriptionRestart = () => {};
  setupPage.onLoad({ token: "legacy-app-token-must-not-bypass-setup", mode: "transcription" });
  assert(setupPage.data.needsDeviceSetup === true, "A physical glasses startup without a token must enter Setup.");
  assert(setupPage.data.token === "", "A legacy outer app token must not bypass physical-glasses Setup.");
  assert(setupPage.data.deviceSerialNumber === "ROKID-SETUP-SMOKE", "Setup must show the physical glasses serial number.");
  assert(setupPage.data.deviceSetupUrl.endsWith("/manage"), "Setup must show the Relay management URL.");
  const setupClaimed = await setupPage.claimDeviceTokenFromSerial();
  assert(setupClaimed && setupPage.data.needsDeviceSetup === false, "A successful SN claim must leave Setup automatically.");
  assert(setupPage.data.token === "rbd_runtime-smoke-device-token", "A successful SN claim must install the device credential.");
  const storedDeviceCredential = [...localStorageValues.values()].find((value) => value.includes("rbd_runtime-smoke-device-token"));
  assert(storedDeviceCredential, "The claimed device credential must persist in Agent-isolated localStorage.");
  const setupClaimRequest = wxModule.wxCalls.requestBodies.find((request) => request.url.endsWith("/api/rabilink/devices/token"));
  assert(setupClaimRequest?.data?.serialNumber === "ROKID-SETUP-SMOKE", "The claim request must send the current glasses SN.");
  setupPage.onUnload();

  setInkNavigator("ROKID-SETUP-SMOKE");
  const transcriptPage = createPageInstance(pageModule);
  transcriptPage.reportRuntimeProof = () => Promise.resolve(false);
  transcriptPage.connectTranscriptionRelay = async () => true;
  transcriptPage.onLoad({ token: "tool-token-value", mode: "transcription" });
  transcriptPage.onReady();
  transcriptPage.activateDeferredStartup();
  assert(
    transcriptPage.runtimeProofPayload("version-check").runtime.appVersion === craftRelease.version,
    "Runtime proof must expose the injected Craft release version shown in the HUD."
  );
  transcriptPage.appendLog("ASR 12：这是一段不得上传的私密转写");
  await transcriptPage.flushCloudLogs();
  const cloudLogRequest = wxModule.wxCalls.requestBodies.findLast((request) => (
    request.url.endsWith("/api/rabilink/devices/logs")
    && JSON.stringify(request.data?.logs || []).includes("[redacted-transcript]")
  ));
  assert(cloudLogRequest?.data?.deviceId === "ROKID-SETUP-SMOKE", "Cloud diagnostics must identify the physical glasses when AIUI exposes the serial number.");
  assert(cloudLogRequest?.data?.appVersion === craftRelease.version, "Cloud diagnostics must include the HUD release version.");
  const uploadedCloudText = JSON.stringify(cloudLogRequest?.data?.logs || []);
  assert(uploadedCloudText.includes("[redacted-transcript]"), "Cloud diagnostics must retain the ASR event while redacting the transcript text.");
  assert(!uploadedCloudText.includes("不得上传的私密转写"), "Cloud diagnostics must never upload raw transcript content.");
  assert(transcriptPage.cloudLogQueue.length === 0, "A successful cloud diagnostics upload must drain the persisted device queue.");
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
  assert(transcriptPage.data.transcriptionSyncedCount === 1, "Final ASR text should be recorded through the Relay HTTP endpoint.");
  assert(transcriptPage.data.transcriptionPendingCount === 0, "Successful transcript submission should drain the local queue.");
  const observationRequest = wxModule.wxCalls.requestBodies.find((request) => request.data?.type === "rabilink.observation");
  assert(observationRequest?.data?.deliveryMode === "observe", "Foreground ASR must enter the record-only conversation ledger instead of directly interrupting Codex.");
  assert(observationRequest?.data?.clientMessageId, "Each recorded observation must carry a stable client message id for retry deduplication.");
  transcriptPage.handleTranscriptionResult("这是一段真实 ASR 结果");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(transcriptPage.data.transcriptionSyncedCount === 1, "A rapid duplicate native-ASR final result must not create a second ledger observation.");
  assert(transcriptPage.data.agentReplyText === "这是 Codex 返回的第一条回复。", "Connection conversation must display each normal message from the global stream without task filtering.");
  assert(speechUtterances.at(-1)?.text === "这是 Codex 返回的第一条回复。", "Connection conversation must send each downlink message to AIUI TTS.");
  assert(speechModes.at(-1) === "enqueue", "AIUI TTS must explicitly use the documented enqueue playback mode.");
  assert(activeRecognition.aborted && transcriptPage.data.agentSpeaking, "Agent TTS must release ASR before playback starts.");
  speechUtterances.at(-1)?.onend?.();
  transcriptPage.handleTranscriptionResult("这是Codex返回的第一条回复");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(transcriptPage.data.transcriptionSyncedCount === 1, "A recent native-TTS echo must not return to the user-observation ledger.");
  const recognitionCountBeforeResume = recognitions.length;
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert(recognitions.length > recognitionCountBeforeResume && recognitions.at(-1)?.started, "ASR must resume after Agent TTS finishes.");

  setInkNavigator();
  wxModule.failNextInputs(1);
  const offlineTranscriptPage = createPageInstance(pageModule);
  offlineTranscriptPage.reportRuntimeProof = () => Promise.resolve(false);
  offlineTranscriptPage.connectTranscriptionRelay = async () => true;
  offlineTranscriptPage.onLoad({ token: "offline-transcript-token", mode: "transcription" });
  offlineTranscriptPage.onReady();
  offlineTranscriptPage.activateDeferredStartup();
  offlineTranscriptPage.handleTranscriptionResult("这条断网转写必须在页面重建后自动补传");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(offlineTranscriptPage.transcriptQueue.length === 1, "A failed observation upload must remain in durable transcript storage.");
  const offlineSegmentId = offlineTranscriptPage.transcriptQueue[0]?.id;
  offlineTranscriptPage.onUnload();

  const wrongTokenPage = createPageInstance(pageModule);
  wrongTokenPage.reportRuntimeProof = () => Promise.resolve(false);
  wrongTokenPage.connectTranscriptionRelay = async () => true;
  wrongTokenPage.onLoad({ token: "different-account-token", mode: "transcription" });
  wrongTokenPage.onReady();
  wrongTokenPage.activateDeferredStartup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(wrongTokenPage.transcriptQueue.length === 0, "A different token must not inherit another account's offline observation queue.");
  const crossAccountAttempts = wxModule.wxCalls.requestBodies.filter((request) => request.data?.text === "这条断网转写必须在页面重建后自动补传");
  assert(crossAccountAttempts.length === 1, "Switching tokens must not upload a pending observation to the wrong account.");
  assert(
    wxModule.getStorageKeys().some((key) => /^rabilink-aiui-transcript-queue:v2-[0-9a-f]{16}$/.test(key)),
    "Durable observation storage must use an opaque token fingerprint."
  );
  assert(
    wxModule.getStorageKeys().every((key) => !key.includes("offlin") && !key.includes("oken")),
    "Durable queue storage keys must not retain token prefix or suffix fragments."
  );
  wrongTokenPage.onUnload();

  const restoredTranscriptPage = createPageInstance(pageModule);
  restoredTranscriptPage.reportRuntimeProof = () => Promise.resolve(false);
  restoredTranscriptPage.connectTranscriptionRelay = async () => true;
  restoredTranscriptPage.onLoad({ token: "offline-transcript-token", mode: "transcription" });
  restoredTranscriptPage.onReady();
  restoredTranscriptPage.activateDeferredStartup();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(restoredTranscriptPage.transcriptQueue.length === 0, "A recreated foreground page must automatically retry its durable observation queue.");
  assert(restoredTranscriptPage.data.transcriptionSyncedCount === 1, "The restored observation must be acknowledged exactly once after connectivity returns.");
  const offlineAttempts = wxModule.wxCalls.requestBodies.filter((request) => request.data?.text === "这条断网转写必须在页面重建后自动补传");
  assert(offlineAttempts.length === 2, "The offline observation should have one failed attempt and one restored attempt.");
  assert(
    offlineAttempts.every((request) => request.data?.clientMessageId === offlineSegmentId),
    "Observation retries across page recreation must keep one stable client message id for server deduplication."
  );
  restoredTranscriptPage.onUnload();

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

  const durablePage = createPageInstance(pageModule);
  durablePage.reportRuntimeProof = () => Promise.resolve(false);
  durablePage.connectTranscriptionRelay = async () => true;
  durablePage.onLoad({ token: "durable-token-value", mode: "transcription" });
  durablePage.onReady();
  durablePage.activateDeferredStartup();
  durablePage.agentShouldPoll = true;
  holdSpeech = true;
  wxModule.agentMessageBatches.push({
    code: 0,
    ok: true,
    done: false,
    shouldContinue: true,
    nextCursor: "out-durable-2",
    messages: [
      { id: "out-durable-1", text: "这条离线消息必须在页面恢复后继续播报。", final: true, proactive: true },
      { id: "out-durable-2", text: "恢复后还要按原顺序播报第二条消息。", final: true, proactive: true }
    ]
  });
  durablePage.scheduleAgentPoll(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(speechUtterances.at(-1)?.text === "这条离线消息必须在页面恢复后继续播报。", "A durable downlink should start native TTS while the page is visible.");
  assert(durablePage.agentMessageQueue.length === 2, "Every downlink in a batch must be persisted before its stream cursor advances.");
  durablePage.onHide();
  assert(durablePage.agentMessageQueue.length === 2, "Hiding the page must not remove unfinished downlinks from durable storage.");
  const speechCountBeforeRestore = speechUtterances.length;

  const wrongDurableTokenPage = createPageInstance(pageModule);
  wrongDurableTokenPage.reportRuntimeProof = () => Promise.resolve(false);
  wrongDurableTokenPage.connectTranscriptionRelay = async () => true;
  wrongDurableTokenPage.onLoad({ token: "different-durable-token", mode: "transcription" });
  wrongDurableTokenPage.onReady();
  wrongDurableTokenPage.activateDeferredStartup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(wrongDurableTokenPage.agentMessageQueue.length === 0, "A different token must not inherit another account's pending TTS queue.");
  assert(speechUtterances.length === speechCountBeforeRestore, "A pending downlink must not be spoken while a different token is active.");
  wrongDurableTokenPage.onUnload();

  const restoredDurablePage = createPageInstance(pageModule);
  restoredDurablePage.reportRuntimeProof = () => Promise.resolve(false);
  restoredDurablePage.connectTranscriptionRelay = async () => true;
  restoredDurablePage.onLoad({ token: "durable-token-value", mode: "transcription" });
  restoredDurablePage.onReady();
  restoredDurablePage.activateDeferredStartup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(restoredDurablePage.agentMessageQueue.length === 2, "A recreated page must reload the unfinished downlink queue.");
  assert(
    speechUtterances.length === speechCountBeforeRestore + 1
      && speechUtterances.at(-1)?.text === "这条离线消息必须在页面恢复后继续播报。",
    "A downlink interrupted by page hide must survive local storage and resume instead of being lost behind the cursor."
  );
  speechUtterances.at(-1)?.onend?.();
  assert(
    speechUtterances.at(-1)?.text === "恢复后还要按原顺序播报第二条消息。",
    "Durable downlinks must resume in Relay cursor order after the interrupted item finishes."
  );
  speechUtterances.at(-1)?.onend?.();
  assert(restoredDurablePage.agentMessageQueue.length === 0, "Successfully spoken durable downlinks must leave the persisted queue.");
  holdSpeech = false;
  durablePage.onUnload();
  restoredDurablePage.onUnload();

  const poisonText = "这条消息模拟永久 TTS 失败。";
  const healthyText = "后一条主动消息不能被失败项阻塞。";
  const ttsFailurePage = createPageInstance(pageModule);
  ttsFailurePage.reportRuntimeProof = () => Promise.resolve(false);
  ttsFailurePage.connectTranscriptionRelay = async () => true;
  ttsFailurePage.onLoad({ token: "tts-failure-token", mode: "transcription" });
  ttsFailurePage.onReady();
  ttsFailurePage.activateDeferredStartup();
  failingSpeechText = poisonText;
  ttsFailurePage.persistAgentMessages([
    { id: "out-tts-failed", text: poisonText, proactive: true },
    { id: "out-tts-healthy", text: healthyText, proactive: true }
  ]);
  ttsFailurePage.drainAgentMessageQueue();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert(
    speechUtterances.some((utterance) => utterance.text === healthyText),
    "A permanently failing TTS item must not starve later proactive messages."
  );
  assert(
    ttsFailurePage.agentMessageQueue.length === 1
      && ttsFailurePage.agentMessageQueue[0]?.id === "out-tts-failed"
      && ttsFailurePage.agentMessageQueue[0]?.attempts === 3,
    "A failed downlink must remain durable after its bounded retry budget is exhausted."
  );
  assert(ttsFailurePage.data.agentStatus === "TTS 失败，单击重试", "The HUD must expose the retained TTS retry state.");
  failingSpeechText = "";
  const ttsRetryTap = { code: "Enter", prevented: false, preventDefault() { this.prevented = true; } };
  ttsFailurePage.onKeyUp(ttsRetryTap);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(ttsFailurePage.agentMessageQueue.length === 0, "Retry must replay and clear a retained TTS failure after playback recovers.");
  assert(ttsRetryTap.prevented, "A touchpad TTS retry must consume the handled click.");
  ttsFailurePage.onUnload();

  const recognitionBeforeManualReview = transcriptPage.recognition;
  const reviewTap = { code: "Enter", prevented: false, preventDefault() { this.prevented = true; } };
  transcriptPage.onKeyUp(reviewTap);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reviewRequest = wxModule.wxCalls.requestBodies.find((request) => request.data?.type === "rabilink.review_request");
  assert(reviewRequest?.data?.reviewRequested === true && reviewRequest?.data?.deliveryMode === "observe", "A touchpad click must enqueue an immediate conversation review request.");
  assert(transcriptPage.recognition === recognitionBeforeManualReview, "A touchpad review click must not pause or replace the continuous ASR session.");
  assert(reviewTap.prevented, "A handled touchpad review click should prevent the host default action.");

  setInkNavigator("ROKID-SETUP-SMOKE");
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
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(!recognitionBeforeConfig || recognitionBeforeConfig.stopped || recognitionBeforeConfig.aborted, "Switching to the configuration assistant should release ASR first.");
  assert(transcriptPage.data.mode === "configuration" && transcriptPage.data.isConfigurationMode, "A physical down/back swipe should switch to configuration mode in the same page.");
  const configurationRecognition = transcriptPage.recognition;
  assert(configurationRecognition?.started && transcriptPage.recognitionPurpose === "configuration", "Configuration mode must start a page-owned AIUI SpeechRecognition round after the mode frame commits.");
  assert(transcriptPage.data.assistantListening && transcriptPage.data.assistantStatus === "正在聆听", "Configuration HUD must expose its live listening state.");
  assert(finishCalls === 0, "Switching modes must not close the AIUI page through page.finish().");
  assert(downSwipe.prevented, "A handled physical swipe should prevent the default scroll behavior.");
  const assistantRecognitionCount = recognitions.length;
  const assistantSpeakSwipe = { code: "ArrowDown", prevented: false, preventDefault() { this.prevented = true; } };
  transcriptPage.onKeyUp(assistantSpeakSwipe);
  assert(recognitions.length === assistantRecognitionCount, "An unsupported configuration gesture must not create a competing recognition session.");
  assert(!assistantSpeakSwipe.prevented, "An unsupported configuration gesture must remain available to the native Agent host.");

  let directConfigurationAsrCalls = 0;
  transcriptPage.loadWebguiConfig = () => {
    directConfigurationAsrCalls += 1;
    return true;
  };
  const modelSessionsBeforeExactCommand = languageModelSessions.length;
  const modelPromptsBeforeExactCommand = languageModelPrompts.length;
  transcriptPage.handleConfigurationSpeechResult("读取配置");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(languageModelSessions.length === modelSessionsBeforeExactCommand, "An exact whitelisted configuration command must not create a LanguageModel session.");
  assert(languageModelPrompts.length === modelPromptsBeforeExactCommand, "An exact whitelisted configuration command must not wait for native semantic understanding.");
  assert(directConfigurationAsrCalls === 1, "An exact whitelisted configuration command must dispatch locally.");
  directConfigurationAsrCalls = 0;
  nextLanguageModelCommand = VOICE_COMMANDS.LOAD_CONFIG;
  nextLanguageModelReply = "";
  const modelSessionsBeforeConfiguration = languageModelSessions.length;
  configurationRecognition.onresult?.({ results: [[{ transcript: "帮我读取配置" }]] });
  configurationRecognition.onend?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(languageModelSessions.length === modelSessionsBeforeConfiguration + 1, "Configuration speech must create an AIUI native LanguageModel session lazily.");
  assert(languageModelPrompts.at(-1) === "帮我读取配置", "The native LanguageModel must receive the user's complete recognized phrase.");
  assert(directConfigurationAsrCalls === 1, "A native LanguageModel tool call must dispatch the matching local AIUI configuration API.");
  assert(transcriptPage.data.assistantUserText === "帮我读取配置", "Configuration ASR text must remain visible in the HUD.");
  const recognitionCountBeforeConfigurationResume = recognitions.length;
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert(recognitions.length > recognitionCountBeforeConfigurationResume && transcriptPage.recognitionPurpose === "configuration", "Configuration ASR must automatically start another one-round recognition after a handled command.");

  const unknownConfigurationRecognition = transcriptPage.recognition;
  const requestsBeforeUnknownConfigurationAsr = wxModule.wxCalls.requests;
  suppressSpeechEvents = true;
  transcriptPage.speechPlaybackWatchdogMs = () => 30;
  nextLanguageModelCommand = "";
  nextLanguageModelReply = "请说明要读取、修改或运行哪一项配置。";
  unknownConfigurationRecognition.onresult?.({ results: [[{ transcript: "帮我看看天气怎么样" }]] });
  unknownConfigurationRecognition.onend?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(wxModule.wxCalls.requests === requestsBeforeUnknownConfigurationAsr, "Unknown direct configuration speech must not create a Relay task or network request.");
  assert(transcriptPage.data.assistantReplyText === nextLanguageModelReply, "A no-tool native LanguageModel reply must become a bounded clarification instead of an action.");
  const recognitionCountBeforeUnknownResume = recognitions.length;
  await new Promise((resolve) => setTimeout(resolve, 320));
  suppressSpeechEvents = false;
  assert(recognitions.length > recognitionCountBeforeUnknownResume && transcriptPage.recognitionPurpose === "configuration", "Configuration ASR must resume through the fallback watchdog when AIUI exposes no utterance lifecycle events.");

  nextLanguageModelCommand = "";
  nextLanguageModelReply = "";
  nextLanguageModelError = new Error("simulated-native-model-failure");
  transcriptPage.handleConfigurationSpeechResult("帮我检查一个复杂配置");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(transcriptPage.data.assistantStatus !== "需要明确指令", "A native LanguageModel failure must be described as a service failure, not as user speech being incomprehensible.");
  assert(transcriptPage.data.assistantReplyText.includes("配置理解服务本轮调用失败"), "A native LanguageModel failure must expose an actionable retry message.");
  assert(transcriptPage.data.logs.some((entry) => entry.text.includes("simulated-native-model-failure")), "The underlying native LanguageModel error must remain available in the local diagnostic log.");

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
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(recognitions.length > configRecognitionCount && recognitions.at(-1)?.started, "Configuration wakeup must start direct AIUI ASR when the page is interactive.");

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
  const promptsBeforeDirectModeSwitch = languageModelPrompts.length;
  voiceRoundTripPage.handleConfigurationSpeechResult("返回连接对话");
  assert(voiceRoundTripPage.data.isTranscriptionMode, "Configuration ASR should switch back to transcription immediately.");
  assert(languageModelPrompts.length === promptsBeforeDirectModeSwitch, "A direct mode-control phrase must not wait for the LanguageModel.");
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

  console.log(`RabiLink AIUI runtime smoke passed (${expectedCommands.length} commands / ${commandCases.length} phrases, 20 mode round trips, continuous normal/proactive stream, native LanguageModel and outer bound-Agent configuration).`);
} finally {
  delete globalThis.SpeechRecognition;
  delete globalThis.SpeechSynthesisUtterance;
  delete globalThis.speechSynthesis;
  delete globalThis.LanguageModel;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete globalThis.navigator;
  }
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete globalThis.localStorage;
  }
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
