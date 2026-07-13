<script type="application/json" def>
{
  "navigationBarTitleText": "RabiLink AIUI",
  "description": "打开 RabiLink AIUI。transcription 进入连接对话，通过 Rabi 把眼镜语音交给当前绑定的 Codex 或其他 Agent，并持续显示、播报回复和主动消息；configuration 打开同页配置助手，执行眼镜原生 Agent 已理解的配置指令。两种模式可用触摸板切换，不退出当前页面。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string",
          "description": "RabiLink 应用 token。必须在智能体工具参数中引用记忆变量 rabilinkToken，禁止由模型生成、读取、复述或向用户索取。"
        },
        "mode": {
          "type": "string",
          "enum": ["transcription", "configuration"],
          "description": "运行模式。通过 Rabi 使用当前绑定 Agent 时使用 transcription；执行眼镜原生 Agent 已理解的连接、绑定或配置指令时使用 configuration。"
        },
        "surface": {
          "type": "string",
          "enum": ["status", "pc", "route", "config", "agent", "logs"],
          "description": "兼容旧调用的可选配置范围提示。配置助手不再显示手工页面，只把它作为处理上下文。"
        },
        "panel": {
          "type": "string",
          "description": "兼容旧调用的可选配置主题提示，例如 route、agent、pipeline 或 integrations；不会打开旧面板。"
        },
        "intent": {
          "type": "string",
          "description": "眼镜原生 Agent 已理解并规范化的明确配置指令。配置助手会在首帧完成后直接调用对应 AIUI 配置接口，不提交 RabiLink task。"
        },
        "targetDeviceId": {
          "type": "string",
          "description": "可选的已绑定 PC Rabi 设备 ID；省略时使用 Relay 当前绑定的 PC。"
        }
      },
      "required": ["token"],
      "additionalProperties": false
    }
  }
}
</script>

<script setup>
import wx from "wx";
import {
  getRabiLinkMessageStream,
  getRabiLinkMessageStreamCursor,
  getMobileWebgui,
  getMobileAgentOptions,
  getMobileRoutes,
  getMobileState,
  postMobileWebgui,
  sendMobileProof,
  selectMobileTarget,
  setMobileAgentBinding,
  publishRabiLinkVoiceInput
} from "../../utils/rabilink-api.js";
import {
  CONFIG_PANELS,
  GATEWAY_JSON_FIELDS,
  GATEWAY_SCALAR_FIELDS,
  MESSAGE_ADAPTERS,
  MESSAGE_PAYLOAD_KINDS,
  NOTIFICATION_ROUTE_KINDS,
  NOTIFICATION_SCHEDULE_TYPES,
  NOTIFICATION_TEMPLATE_FIELDS,
  PIPELINE_INPUT_ADAPTERS,
  PIPELINE_OUTPUT_ADAPTERS,
  PROMPT_OUTPUT_MODES,
  addNotificationSchedule,
  addNotificationRule,
  addNapcatInstance,
  addRouteProfile,
  addRouteVariable,
  agentAdaptersFor,
  appendDefaultGateway,
  clearNotificationTemplate,
  clearPipelineConfig,
  configSummary,
  duplicateSelectedGateway,
  extractGateways,
  extractRuntimeRows,
  fieldSummary,
  fieldValueFor,
  findGatewayIndex,
  jsonValueFor,
  messageAdapterPolicyRowsFor,
  messageAdaptersFor,
  moveSelectedGateway,
  napcatInstanceRowsFor,
  notificationScheduleRowsFor,
  notificationRuleRowsFor,
  notificationTemplateField,
  notificationTemplateSummaryFor,
  notificationTemplateValueFor,
  pipelineConfigFor,
  pipelineSummaryFor,
  removeNapcatInstance,
  removeNotificationSchedule,
  patchSelectedGateway,
  removeNotificationRule,
  removeRouteProfile,
  removeSelectedGateway,
  removeRouteVariable,
  routeLabel,
  routeKindListFor,
  routeProfileRowsFor,
  routeProfileSummaryFor,
  routeVariableRowsFor,
  saveBodyForGateways,
  selectedGateway,
  setAgentAdapter,
  setMessageAdapterPolicy,
  setNotificationSchedule,
  setNotificationRule,
  setNapcatInstance,
  setNotificationTemplate,
  setPipelineConfig,
  setRouteProfile,
  setRouteVariable,
  setJsonField,
  setScalarField,
  setMessageAdapter,
  toggleMessageAdapterPayload
} from "../../utils/config-surface.js";
import { rabiLinkDefaults } from "../../utils/rabilink-defaults.js";
import {
  loadSettings,
  loadTranscriptQueue,
  maskToken,
  saveSettings,
  saveTranscriptQueue
} from "../../utils/rabilink-store.js";
import { VOICE_COMMANDS, parseConfigurationIntent, parseVoiceCommand } from "../../utils/voice-command.js";
import { buildDerivedState, selectedItem } from "../../utils/view-model.js";

const APP_SURFACES = Object.freeze([
  { id: "relay-status", label: "Relay", kind: "relay" },
  { id: "relay-settings", label: "Relay 凭据", kind: "relaySettings" },
  { id: "pc", label: "PC Rabi", kind: "pc" },
  { id: "route", label: "Route", kind: "route" },
  ...CONFIG_PANELS.map((panel, panelIndex) => ({
    id: `config-${panel.id}`,
    label: `配置 · ${panel.label}`,
    kind: "config",
    panelIndex
  })),
  { id: "agent-binding", label: "Agent 绑定", kind: "agent" },
  { id: "logs", label: "运行日志", kind: "logs" }
]);

const TOOL_SURFACE_IDS = Object.freeze({
  status: "relay-status",
  pc: "pc",
  route: "route",
  config: "config-route",
  agent: "agent-binding",
  logs: "logs"
});

const APP_MODES = Object.freeze({
  TRANSCRIPTION: "transcription",
  CONFIGURATION: "configuration"
});

const TRANSCRIPTION_RESTART_DELAY_MS = 220;
const TRANSCRIPTION_ERROR_RETRY_MS = 1200;
const TRANSCRIPTION_MAX_RETRY_DELAY_MS = 10000;
const TRANSCRIPTION_RAPID_END_THRESHOLD_MS = 800;
const TRANSCRIPTION_MAX_CONSECUTIVE_FAILURES = 5;
const AGENT_POLL_RETRY_DELAY_MS = 250;
const STARTUP_ACTIVATION_DELAY_MS = 160;
const STARTUP_NETWORK_DELAY_MS = 120;
const STARTUP_ASR_DELAY_MS = 480;
const TRANSCRIPTION_CLOCK_REFRESH_MS = 5000;
const DEVICE_CLOCK_REFRESH_MS = 30000;
const DEVICE_BATTERY_REFRESH_MS = 60000;
const RELAY_BATTERY_DEFAULT_STALE_MS = 3 * 60 * 1000;
const RELAY_BATTERY_MAX_STALE_MS = 15 * 60 * 1000;

function resolveAsrHostPolicy() {
  const hasInkNavigator = typeof navigator !== "undefined"
    && typeof navigator.getDeviceSerialNumber === "function";
  if (!hasInkNavigator) {
    return { requiresInteractiveWakeup: false };
  }

  let deviceSerialNumber = "";
  try {
    deviceSerialNumber = String(navigator.getDeviceSerialNumber() || "").trim();
  } catch {
    deviceSerialNumber = "";
  }

  return {
    requiresInteractiveWakeup: !deviceSerialNumber
  };
}

function resolveToolInvocation(query = {}) {
  const input = query && typeof query === "object" ? query : {};
  const token = String(input.token || "").trim();
  const requestedMode = String(input.mode || "").trim();
  const requestedSurface = String(input.surface || "").trim();
  const requestedPanel = String(input.panel || "").trim();
  const intent = String(input.intent || "").trim();
  const targetDeviceId = String(input.targetDeviceId || "").trim();
  const panelIndex = CONFIG_PANELS.findIndex((panel) => panel.id === requestedPanel);
  const surfaceId = panelIndex >= 0
    ? `config-${CONFIG_PANELS[panelIndex].id}`
    : (TOOL_SURFACE_IDS[requestedSurface] || TOOL_SURFACE_IDS.status);
  const surfaceIndex = Math.max(0, APP_SURFACES.findIndex((surface) => surface.id === surfaceId));
  const mode = requestedMode === APP_MODES.CONFIGURATION || requestedSurface || requestedPanel
    ? APP_MODES.CONFIGURATION
    : APP_MODES.TRANSCRIPTION;

  return {
    token,
    mode,
    intent,
    targetDeviceId,
    panelIndex: panelIndex >= 0 ? panelIndex : 0,
    surfaceIndex,
    invokedByAgent: Boolean(token || requestedMode || requestedSurface || requestedPanel || intent || targetDeviceId)
  };
}

function initialSettings() {
  return loadSettings(rabiLinkDefaults);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function nowLabel() {
  const date = new Date();
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function clockLabel(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function batteryFillClass(level) {
  const bucket = Math.max(0, Math.min(100, Math.round(Number(level || 0) / 10) * 10));
  return `batteryFillLevel${bucket}`;
}

function normalizeBatterySnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const keys = ["level", "batteryLevel", "battery", "capacity", "percentage", "percent"];
  const levelKey = keys.find((key) => snapshot[key] !== undefined && snapshot[key] !== null);
  if (!levelKey) return null;
  const rawText = String(snapshot[levelKey]).trim();
  let level = Number(rawText.replace(/%$/, ""));
  if (!Number.isFinite(level)) return null;
  if ((levelKey === "level" && level >= 0 && level <= 1) || (level > 0 && level < 1)) level *= 100;
  level = Math.max(0, Math.min(100, Math.round(level)));

  const rawCharging = snapshot.charging
    ?? snapshot.isCharging
    ?? snapshot.ischarging
    ?? snapshot.chargeState
    ?? snapshot.status;
  const chargingText = String(rawCharging ?? "").trim().toLowerCase();
  const charging = rawCharging === true
    || rawCharging === 1
    || ["1", "true", "charging", "charge", "full", "charged", "充电", "充电中"].includes(chargingText);
  return { level, charging };
}

function normalizeRelayBatterySnapshot(deviceStatus, now = Date.now()) {
  if (!deviceStatus || typeof deviceStatus !== "object" || deviceStatus.stale === true) return null;
  const receivedAt = Date.parse(String(deviceStatus.receivedAt || ""));
  if (!Number.isFinite(receivedAt)) return null;
  const requestedStaleMs = Number(deviceStatus.staleAfterMs || RELAY_BATTERY_DEFAULT_STALE_MS);
  const staleAfterMs = Math.max(
    DEVICE_BATTERY_REFRESH_MS,
    Math.min(RELAY_BATTERY_MAX_STALE_MS, Number.isFinite(requestedStaleMs) ? requestedStaleMs : RELAY_BATTERY_DEFAULT_STALE_MS)
  );
  if (Math.max(0, Number(now) - receivedAt) > staleAfterMs) return null;
  return normalizeBatterySnapshot(deviceStatus);
}

function durationLabel(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((Number(now) - Number(startedAt || now)) / 1000));
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function transcriptSegmentId(sequence) {
  return `asr-${Date.now()}-${Number(sequence || 0)}`;
}

function isRabiLinkPollTimeout(error) {
  return String(error?.message || error || "").includes("RabiLink 下行消息等待超时");
}

function extractSpeechText(event) {
  const results = event && event.results ? event.results : [];
  const firstResult = results[0] || [];
  const first = firstResult[0] || {};
  return String(first.transcript || "").trim();
}

const INPUT_KEY_CODE_MAP = Object.freeze({
  4: "backspace",
  8: "backspace",
  13: "enter",
  19: "arrowup",
  20: "arrowdown",
  21: "arrowleft",
  22: "arrowright",
  23: "enter",
  37: "arrowleft",
  38: "arrowup",
  39: "arrowright",
  40: "arrowdown",
  66: "enter"
});

function normalizeInputCode(event = {}) {
  const detail = event && typeof event.detail === "object" ? event.detail : {};
  const rawCode = event.code || event.key || detail.code || detail.key || "";
  const normalized = String(rawCode).trim().toLowerCase();
  const namedCodes = {
    dpad_up: "arrowup",
    dpad_down: "arrowdown",
    dpad_left: "arrowleft",
    dpad_right: "arrowright",
    keycode_dpad_up: "arrowup",
    keycode_dpad_down: "arrowdown",
    keycode_dpad_left: "arrowleft",
    keycode_dpad_right: "arrowright",
    keycode_back: "backspace",
    keycode_enter: "enter",
    keycode_dpad_center: "enter"
  };
  if (namedCodes[normalized]) return namedCodes[normalized];
  if (normalized && !/^\d+$/.test(normalized)) return normalized;
  const numericCode = Number(
    normalized || event.keyCode || event.which || detail.keyCode || detail.which || 0
  );
  return INPUT_KEY_CODE_MAP[numericCode] || "";
}

function remoteAgentDeviceLabel(device) {
  if (!device) return "未读取远端 Agent";
  const name = device.deviceName || device.name || device.deviceId || "远端 Agent";
  return name === device.deviceId ? name : `${name} (${device.deviceId || "-"})`;
}

function remoteAgentDeviceMeta(device) {
  if (!device) return "扫描后显示设备";
  const status = device.connected ? "已连接" : device.connectionError ? "连接异常" : "已发现";
  const system = [device.agentType, device.os, device.osVersion, device.arch].filter(Boolean).join(" · ");
  const host = device.observedIp || device.declaredIp || device.host || "";
  return [status, system, host, device.passwordSaved ? "已记住密码" : ""].filter(Boolean).join(" · ");
}

const WEBGUI_TOOL_PATHS = {
  reload: "/reload",
  managerShutdown: "/manager/shutdown",
  openConfigFile: "/open-config-file",
  napcatAdd: "/api/message/napcat-add",
  napcatLaunch: "/api/message/napcat-launch",
  napcatRestart: "/api/message/napcat-restart",
  napcatRemove: "/api/message/napcat-remove",
  copilotStatus: "/api/agent/copilot-status",
  copilotInstall: "/api/agent/copilot-install",
  copilotLogin: "/api/agent/copilot-login",
  marvisOpen: "/api/agent/marvis-open",
  astrbotDeploy: "/api/deploy-astrbot-adapter",
  remoteAgentDevices: "/api/remote-agent/devices",
  remoteAgentScan: "/api/remote-agent/scan",
  remoteAgentConnect: "/api/remote-agent/connect",
  remoteAgentDisconnect: "/api/remote-agent/disconnect"
};

export default {
  data: {
    relayBaseUrl: "",
    token: "",
    maskedToken: "未设置",
    statusText: "未连接",
    connected: false,
    busy: false,
    mode: APP_MODES.TRANSCRIPTION,
    isTranscriptionMode: true,
    isConfigurationMode: false,
    modeFrameRelayout: false,

    workers: [],
    workerIndex: 0,
    selectedWorkerLabel: "未读取 PC Rabi",
    selectedWorkerMeta: "连接 Relay 后显示",
    targetDeviceId: "",

    routes: [],
    routeIndex: 0,
    selectedRouteLabel: "未读取 Route",
    selectedRouteMeta: "选择 PC 后读取",

    gateways: [],
    runtimeRows: [],
    gatewayIndex: 0,
    webguiLoaded: false,
    webguiDirty: false,
    appSurfaces: APP_SURFACES,
    surfaceIndex: 0,
    surfaceId: "relay-status",
    surfaceLabel: "Relay",
    surfacePosition: `1/${APP_SURFACES.length}`,
    showRelaySurface: true,
    showRelaySettingsSurface: false,
    showPcSurface: false,
    showRouteSurface: false,
    showConfigSurface: false,
    showAgentSurface: false,
    showLogSurface: false,
    configPanels: CONFIG_PANELS,
    panelIndex: 0,
    panelId: "route",
    panelLabel: "路由",
    scalarFields: GATEWAY_SCALAR_FIELDS,
    jsonFields: GATEWAY_JSON_FIELDS,
    scalarFieldIndex: 0,
    jsonFieldIndex: 0,
    scalarFieldLabel: "Route ID",
    scalarFieldType: "string",
    scalarFieldValue: "",
    scalarFieldPreview: "未读取 WebGUI 配置",
    jsonFieldLabel: "消息端列表",
    jsonFieldValue: "",
    jsonFieldPreview: "未读取 WebGUI 配置",
    routeVariableRows: [],
    routeVariableIndex: 0,
    routeVariableKey: "",
    routeVariableValue: "",
    routeVariableSummary: "未配置变量",
    notificationRouteKinds: NOTIFICATION_ROUTE_KINDS,
    notificationRouteKindView: NOTIFICATION_ROUTE_KINDS,
    notificationRuleRows: [],
    notificationRuleIndex: 0,
    notificationRuleName: "",
    notificationRuleEnabled: true,
    notificationRuleRouteKinds: "",
    notificationRuleTargetGroupId: "",
    notificationRuleAllowedSpeakerNames: "",
    notificationRuleRegex: "",
    notificationRuleTemplate: "",
    notificationRuleSummary: "未配置规则",
    notificationScheduleTypes: NOTIFICATION_SCHEDULE_TYPES,
    notificationScheduleTypeView: NOTIFICATION_SCHEDULE_TYPES,
    notificationScheduleRows: [],
    notificationScheduleIndex: 0,
    notificationScheduleName: "",
    notificationScheduleEnabled: true,
    notificationScheduleType: "interval",
    notificationScheduleIntervalSeconds: "900",
    notificationScheduleWindowStartTime: "",
    notificationScheduleWindowEndTime: "",
    notificationScheduleTimeOfDay: "",
    notificationScheduleOnceAt: "",
    notificationScheduleSummary: "未配置计划",
    notificationTemplateFields: NOTIFICATION_TEMPLATE_FIELDS,
    notificationTemplateIndex: 0,
    notificationTemplateLabel: "群消息",
    notificationTemplateValue: "",
    notificationTemplateSummary: "未配置模板",
    messageAdapters: MESSAGE_ADAPTERS,
    messageAdaptersView: MESSAGE_ADAPTERS,
    messagePayloadKinds: MESSAGE_PAYLOAD_KINDS,
    messagePayloadKindView: MESSAGE_PAYLOAD_KINDS,
    messagePolicyRows: [],
    messagePolicyIndex: 0,
    messagePolicyAdapterId: "",
    messagePolicyAdapterLabel: "未选择消息端",
    messagePolicyInputEnabled: true,
    messagePolicyOutputEnabled: true,
    messagePolicyOutputs: "",
    messagePolicySummary: "未配置策略",
    napcatInstanceRows: [],
    napcatInstanceIndex: 0,
    napcatInstanceId: "",
    napcatInstanceName: "",
    napcatInstanceEnabled: true,
    napcatGatewayPort: "",
    napcatHttpUrl: "",
    napcatWebuiUrl: "",
    napcatAccessToken: "",
    napcatWebuiToken: "",
    napcatLaunchCommand: "",
    napcatWorkingDir: "",
    napcatBotUserId: "",
    napcatBotNickname: "",
    napcatInstanceSummary: "未配置 NapCat",
    pipelineInputAdapters: PIPELINE_INPUT_ADAPTERS,
    pipelineOutputAdapters: PIPELINE_OUTPUT_ADAPTERS,
    promptOutputModes: PROMPT_OUTPUT_MODES,
    pipelineInputAdapterView: PIPELINE_INPUT_ADAPTERS,
    pipelineOutputAdapterView: PIPELINE_OUTPUT_ADAPTERS,
    promptOutputModeView: PROMPT_OUTPUT_MODES,
    pipelineId: "",
    pipelineName: "",
    pipelineInputAdapter: "",
    pipelineOutputAdapter: "",
    pipelineOutputPipeline: "",
    pipelinePromptOutputMode: "",
    pipelineTtsProvider: "",
    pipelineTtsVoice: "",
    pipelineTtsWorkerUrl: "",
    pipelineTtsPlay: false,
    pipelinePreventFeedbackLoop: false,
    pipelineReplyToSource: false,
    pipelineSummary: "未配置 pipeline 覆盖",
    routeProfileRows: [],
    routeProfileIndex: 0,
    routeProfileId: "",
    routeProfileName: "",
    routeProfileEnabled: true,
    routeProfileRoleId: "",
    routeProfileRoleFile: "persona.md",
    routeProfileRolesDir: "",
    routeProfileDataDir: "",
    routeProfileRecentMessageLimit: "",
    routeProfilePipelinePreset: "",
    routeProfilePipelineJson: "",
    routeProfileVariablesJson: "{}",
    routeProfileSummary: "未配置 Profile",
    selectedGatewayLabel: "未读取 WebGUI 配置",
    selectedGatewayMeta: "连接 PC 后读取",
    messageAdapterText: "-",
    agentAdapterText: "-",
    runtimeText: "-",
    runtimeActionSummary: "未执行运行控制",
    manualTriggerMessage: "AIUI 手动触发",
    currentRouteName: "",
    currentRoleId: "",
    currentAgentModel: "",
    currentPipelinePreset: "",
    currentGatewayPort: "",
    currentWebhookPort: "",
    currentFenneNotePort: "",
    currentRabiLinkPort: "",
    integrationWebhookPath: "",
    integrationFenneNotePath: "",
    integrationXiaoaiPath: "",
    integrationRabiLinkPath: "",
    integrationRabiLinkHost: "",
    integrationHeartbeatSeconds: "900",
    integrationHeartbeatMessage: "",
    integrationWecomBotId: "",
    integrationWecomBotSecret: "",
    integrationWecomWsUrl: "",
    integrationRemoteAgentDeviceId: "",
    integrationRemoteAgentCwd: "",
    integrationRemoteAgentThreadName: "",
    integrationSummary: "未配置集成",
    currentRouteEnabled: false,
    currentMessageInputsDisabled: false,
    managerRouteDir: "",
    managerRolesDir: "",
    rabiName: "",
    rabiRelayUrl: "",
    rabiRelayToken: "",
    rabiRelayDeviceId: "",
    rabiRelayClaimWaitMs: "60000",
    rabiRelayReplyIdleTimeoutMs: "60000",

    agentAdapter: "codex",
    cwdOptions: [],
    cwdIndex: 0,
    threadOptions: [],
    threadIndex: 0,
    selectedCwdLabel: "未读取工作区",
    selectedThreadLabel: "未读取会话",
    bindingPreview: "未选择 Route",
    copilotCwd: "",
    copilotCliBin: "",
    marvisAppId: "",
    astrbotUrl: "",
    astrbotUsername: "",
    astrbotPassword: "",
    astrbotProjectId: "",
    astrbotSessionId: "",
    networkSummary: "未读取网络选项",
    managerActionSummary: "未执行 Manager 操作",
    agentScanSummary: "未扫描 Agent",
    messageScanSummary: "未扫描消息端",
    napcatHealthSummary: "未检查 NapCat",
    napcatRepairSummary: "未执行 NapCat 修复",
    copilotStatusSummary: "未读取 Copilot",
    astrbotLoginSummary: "未验证 AstrBot",
    webguiToolSummary: "未执行扩展工具",
    remoteAgentDevices: [],
    remoteAgentDeviceIndex: 0,
    remoteAgentDeviceLabel: "未读取远端 Agent",
    remoteAgentDeviceMeta: "扫描后显示设备",
    remoteAgentPassword: "",
    remoteAgentSummary: "未扫描远端 Agent",

    assistantStatus: "等待原生 Agent",
    assistantUserText: "请向眼镜助手提出配置需求",
    assistantReplyText: "原生 Agent 会理解需求，再调用这里的配置接口。",
    assistantLastRequest: "",
    assistantCanRetry: false,
    agentStatus: "等待语音",
    agentReplyText: "Agent 的回复会显示在这里",
    agentCursor: "",
    agentPolling: false,
    agentSpeaking: false,
    transcriptionDesired: true,
    transcriptionListening: false,
    transcriptionState: "准备中",
    transcriptionText: "等待语音",
    transcriptionSessionId: "",
    transcriptionStartedAt: 0,
    transcriptionElapsed: "00:00",
    transcriptionSequence: 0,
    transcriptionSyncedCount: 0,
    transcriptionPendingCount: 0,
    transcriptionSyncLabel: "等待连接",
    currentTime: "--:--",
    batteryAvailable: false,
    batteryLevel: 0,
    batteryText: "--",
    batteryCharging: false,
    batteryFillClass: "batteryFillLevel0",
    batteryStatusLabel: "电量不可用",
    batterySource: "",
    invocationIntent: "",
    logs: []
  },

  hudVisibleSnapshot() {
    const state = this.data || {};
    return {
      mode: state.mode,
      isTranscriptionMode: state.isTranscriptionMode,
      isConfigurationMode: state.isConfigurationMode,
      transcriptionListening: state.transcriptionListening,
      transcriptionDesired: state.transcriptionDesired,
      transcriptionState: state.transcriptionState,
      transcriptionText: state.transcriptionText,
      transcriptionElapsed: state.transcriptionElapsed,
      transcriptionSyncLabel: state.transcriptionSyncLabel,
      assistantStatus: state.assistantStatus,
      assistantUserText: state.assistantUserText,
      assistantReplyText: state.assistantReplyText,
      connected: state.connected,
      currentTime: state.currentTime,
      batteryFillClass: state.batteryFillClass,
      batteryCharging: state.batteryCharging,
      batteryText: state.batteryText
    };
  },

  installHudRelayoutGuard() {
    if (this.hudSetData) return;
    this.hudSetData = this.setData.bind(this);
    this.setData = (nextData) => {
      if (!nextData || typeof nextData !== "object") {
        this.hudSetData(nextData);
        return;
      }
      this.hudSetData({
        ...nextData,
        modeFrameRelayout: true
      });
      if (this.hudRelayoutTimer) clearTimeout(this.hudRelayoutTimer);
      this.hudRelayoutTimer = setTimeout(() => {
        this.hudRelayoutTimer = null;
        if (this.destroyed) return;
        this.hudSetData({
          ...this.hudVisibleSnapshot(),
          modeFrameRelayout: false
        });
      }, 32);
    };
  },

  onLoad(query = {}) {
    this.installHudRelayoutGuard();
    const invocation = resolveToolInvocation(query);
    const asrHostPolicy = resolveAsrHostPolicy();
    const token = invocation.token;
    const agentRequestedTranscription = invocation.mode === APP_MODES.TRANSCRIPTION && invocation.invokedByAgent;
    const shouldAutoStartTranscription = agentRequestedTranscription && !asrHostPolicy.requiresInteractiveWakeup;
    const waitsForInteractiveWakeup = agentRequestedTranscription && asrHostPolicy.requiresInteractiveWakeup;
    const firstFrameSurface = APP_SURFACES[invocation.surfaceIndex] || APP_SURFACES[0];
    const firstFramePanel = CONFIG_PANELS[invocation.panelIndex] || CONFIG_PANELS[0];
    this.asrHostPolicy = asrHostPolicy;
    this.startupInvocation = invocation;
    this.startupActivated = false;
    this.recognition = null;
    this.recognitionPurpose = "";
    this.pageReady = false;
    this.pageVisible = true;
    this.destroyed = false;
    this.transcriptQueue = [];
    this.flushingTranscripts = false;
    this.transcriptionRestartTimer = null;
    this.transcriptionStartupTimer = null;
    this.startupNetworkTimer = null;
    this.transcriptionElapsedTimer = null;
    this.transcriptionFailureCount = 0;
    this.modeFrameTimer = null;
    this.modeFrameGeneration = 0;
    this.hudRelayoutTimer = null;
    this.agentPollTimer = null;
    this.agentPollGeneration = 0;
    this.agentShouldPoll = false;
    this.agentSeenMessageIds = new Set();
    this.speechQueue = [];
    this.speechActive = false;
    this.speechGeneration = 0;
    this.currentUtterance = null;
    this.deviceClockTimer = null;
    this.batteryRefreshPromise = null;
    this.batteryLastRefreshAt = 0;
    this.batteryManager = null;
    this.batteryChangeHandler = null;
    this.setData({
      relayBaseUrl: rabiLinkDefaults.relayBaseUrl,
      token,
      maskedToken: maskToken(token),
      targetDeviceId: invocation.targetDeviceId,
      mode: invocation.mode,
      isTranscriptionMode: invocation.mode === APP_MODES.TRANSCRIPTION,
      isConfigurationMode: invocation.mode === APP_MODES.CONFIGURATION,
      transcriptionDesired: shouldAutoStartTranscription,
      transcriptionState: invocation.mode === APP_MODES.TRANSCRIPTION
        ? (shouldAutoStartTranscription
          ? "准备中"
          : (waitsForInteractiveWakeup ? "浏览器调试：进入后点麦克风" : "待运行智能体"))
        : "准备中",
      transcriptionSessionId: `rabilink-aiui-${Date.now()}`,
      assistantStatus: invocation.intent ? "执行原生 Agent 指令" : "等待原生 Agent",
      assistantUserText: invocation.intent || "请向眼镜助手提出配置需求",
      assistantReplyText: invocation.intent ? "正在调用对应配置接口。" : "原生 Agent 会理解需求，再调用这里的配置接口。",
      assistantLastRequest: invocation.intent,
      transcriptionStartedAt: Date.now(),
      transcriptionElapsed: "00:00",
      transcriptionPendingCount: 0,
      transcriptionSyncLabel: token ? "等待后台连接" : "等待智能体连接",
      agentStatus: token ? "准备连接 Agent" : "等待智能体连接",
      agentReplyText: "说话后，我会通过 Rabi 把 Agent 回复带回来。",
      agentCursor: "",
      agentPolling: false,
      agentSpeaking: false,
      currentTime: clockLabel(),
      surfaceIndex: invocation.surfaceIndex,
      surfaceId: firstFrameSurface.id,
      surfaceLabel: firstFrameSurface.label,
      surfacePosition: `${invocation.surfaceIndex + 1}/${APP_SURFACES.length}`,
      panelIndex: invocation.panelIndex,
      panelId: firstFramePanel.id,
      panelLabel: firstFramePanel.label,
      invocationIntent: invocation.intent
    });
    this.scheduleDeferredStartup();
  },

  onShow() {
    this.pageVisible = true;
    if (!this.startupActivated) {
      if (this.pageReady) this.scheduleDeferredStartup();
      return;
    }
    this.startDeviceStatus();
    if (this.startupActivated && this.pageReady && this.data.isTranscriptionMode) {
      if (this.data.transcriptionDesired) {
        this.startTranscriptionClock();
        this.scheduleTranscriptionRestart(0);
      }
      void this.flushTranscriptQueue();
      if (this.agentShouldPoll) this.scheduleAgentPoll(0);
    }
  },

  onReady() {
    this.pageReady = true;
    this.scheduleDeferredStartup();
  },

  scheduleDeferredStartup() {
    if (this.destroyed || this.startupActivated || this.transcriptionStartupTimer) return;
    this.transcriptionStartupTimer = setTimeout(() => {
      this.transcriptionStartupTimer = null;
      this.pageReady = true;
      this.activateDeferredStartup();
    }, STARTUP_ACTIVATION_DELAY_MS);
  },

  activateDeferredStartup() {
    if (this.destroyed || this.startupActivated) return;
    if (this.transcriptionStartupTimer) {
      clearTimeout(this.transcriptionStartupTimer);
      this.transcriptionStartupTimer = null;
    }
    this.pageReady = true;
    this.startupActivated = true;
    const invocation = this.startupInvocation || resolveToolInvocation();
    const settings = initialSettings();
    const token = this.data.token || settings.token;
    const transcriptQueue = loadTranscriptQueue();
    const tokenKey = maskToken(token);
    const agentCursor = settings.agentCursorTokenKey === tokenKey ? settings.agentCursor : "";
    this.transcriptQueue = transcriptQueue;
    this.setData({
      relayBaseUrl: settings.relayBaseUrl || this.data.relayBaseUrl,
      token,
      maskedToken: maskToken(token),
      targetDeviceId: this.data.targetDeviceId || settings.targetDeviceId,
      agentCursor,
      transcriptionPendingCount: transcriptQueue.length,
      transcriptionSyncLabel: token ? (transcriptQueue.length ? "待发送" : "等待连接") : "等待智能体连接"
    });
    this.appendLog("RabiLink AIUI 首屏已就绪，后台能力开始启动。");
    if (this.pageVisible) this.startDeviceStatus();
    if (invocation.intent) this.appendLog(`智能体请求：${invocation.intent}`);
    if (invocation.mode === APP_MODES.TRANSCRIPTION && invocation.invokedByAgent && this.asrHostPolicy?.requiresInteractiveWakeup) {
      this.appendLog("Craft 卡片不自动启动 ASR；进入 Interactive InkView 后点击麦克风模拟唤醒。");
    }
    this.startupNetworkTimer = setTimeout(() => {
      this.startupNetworkTimer = null;
      if (this.destroyed) return;
      void this.reportRuntimeProof("app-start", "RabiLink AIUI app loaded after first frame.");
      if (!invocation.invokedByAgent || !token) return;
      if (this.data.isConfigurationMode && invocation.intent) void this.executeConfigurationIntent(invocation.intent, "native-agent");
      else if (this.data.isTranscriptionMode) void this.connectTranscriptionRelay();
    }, STARTUP_NETWORK_DELAY_MS);

    if (this.pageVisible && this.data.isTranscriptionMode && this.data.transcriptionDesired) {
      this.startTranscriptionClock();
      this.scheduleTranscriptionRestart(STARTUP_ASR_DELAY_MS);
    }
  },

  onHide() {
    this.pageVisible = false;
    this.stopDeviceStatus();
    this.suspendAgentPolling();
    this.cancelSpeech();
    this.clearTranscriptionRestart();
    this.stopTranscriptionClock();
    this.stopRecognition(false);
    if (this.data.isTranscriptionMode) {
      this.setData({ transcriptionListening: false, transcriptionState: "已暂停" });
    }
  },

  onUnload() {
    this.destroyed = true;
    this.pageVisible = false;
    this.stopDeviceStatus();
    this.stopAgentPolling();
    this.cancelSpeech();
    if (this.transcriptionStartupTimer) {
      clearTimeout(this.transcriptionStartupTimer);
      this.transcriptionStartupTimer = null;
    }
    if (this.startupNetworkTimer) {
      clearTimeout(this.startupNetworkTimer);
      this.startupNetworkTimer = null;
    }
    if (this.modeFrameTimer) {
      clearTimeout(this.modeFrameTimer);
      this.modeFrameTimer = null;
    }
    if (this.hudRelayoutTimer) {
      clearTimeout(this.hudRelayoutTimer);
      this.hudRelayoutTimer = null;
    }
    this.clearTranscriptionRestart();
    this.stopTranscriptionClock();
    this.stopRecognition(false);
  },

  updateDeviceClock() {
    this.setData({ currentTime: clockLabel() });
  },

  startDeviceStatus() {
    if (this.destroyed || !this.pageVisible) return;
    this.updateDeviceClock();
    void this.refreshBatteryStatus();
    if (this.deviceClockTimer) return;
    this.deviceClockTimer = setInterval(() => {
      if (this.destroyed || !this.pageVisible) return;
      this.updateDeviceClock();
      if (Date.now() - this.batteryLastRefreshAt >= DEVICE_BATTERY_REFRESH_MS) {
        void this.refreshBatteryStatus();
      }
    }, DEVICE_CLOCK_REFRESH_MS);
  },

  stopDeviceStatus() {
    if (this.deviceClockTimer) {
      clearInterval(this.deviceClockTimer);
      this.deviceClockTimer = null;
    }
    this.unbindBatteryManager();
  },

  applyBatterySnapshot(snapshot, source = "host") {
    const normalized = normalizeBatterySnapshot(snapshot);
    if (!normalized) return false;
    this.batteryLastRefreshAt = Date.now();
    this.setData({
      batteryAvailable: true,
      batteryLevel: normalized.level,
      batteryText: `${normalized.level}%`,
      batteryCharging: normalized.charging,
      batteryFillClass: batteryFillClass(normalized.level),
      batteryStatusLabel: normalized.charging ? `充电中 ${normalized.level}%` : `电量 ${normalized.level}%`,
      batterySource: source
    });
    return true;
  },

  applyRelayBatteryState(state) {
    const snapshot = normalizeRelayBatterySnapshot(state?.deviceStatus);
    if (!snapshot) return false;
    return this.applyBatterySnapshot(snapshot, "relay-cxr");
  },

  clearBatteryStatus() {
    this.setData({
      batteryAvailable: false,
      batteryLevel: 0,
      batteryText: "--",
      batteryCharging: false,
      batteryFillClass: "batteryFillLevel0",
      batteryStatusLabel: "电量不可用",
      batterySource: ""
    });
  },

  bindBatteryManager(manager) {
    if (this.destroyed || !this.pageVisible || !manager || typeof manager !== "object") return false;
    if (this.batteryManager !== manager) {
      this.unbindBatteryManager();
      this.batteryManager = manager;
      this.batteryChangeHandler = () => {
        if (!this.destroyed) this.applyBatterySnapshot(manager, "web-battery");
      };
      if (typeof manager.addEventListener === "function") {
        manager.addEventListener("levelchange", this.batteryChangeHandler);
        manager.addEventListener("chargingchange", this.batteryChangeHandler);
      }
    }
    return this.applyBatterySnapshot(manager, "web-battery");
  },

  unbindBatteryManager() {
    if (this.batteryManager && this.batteryChangeHandler && typeof this.batteryManager.removeEventListener === "function") {
      this.batteryManager.removeEventListener("levelchange", this.batteryChangeHandler);
      this.batteryManager.removeEventListener("chargingchange", this.batteryChangeHandler);
    }
    this.batteryManager = null;
    this.batteryChangeHandler = null;
  },

  callWxDeviceInfo(methodName) {
    if (!wx || typeof wx[methodName] !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(value && typeof value === "object" ? value : null);
      };
      timeout = setTimeout(() => finish(null), 300);
      try {
        const result = wx[methodName]({ success: finish, fail: () => finish(null) });
        if (result && typeof result.then === "function") result.then(finish, () => finish(null));
        else if (result && typeof result === "object") finish(result);
      } catch {
        finish(null);
      }
    });
  },

  async resolveBatterySnapshot() {
    if (typeof navigator !== "undefined") {
      try {
        if (navigator.battery && this.bindBatteryManager(navigator.battery)) return true;
        if (typeof navigator.getBattery === "function") {
          const manager = await navigator.getBattery();
          if (this.destroyed || !this.pageVisible) return false;
          if (this.bindBatteryManager(manager)) return true;
        }
        if (typeof navigator.getBatteryInfo === "function") {
          const info = await navigator.getBatteryInfo();
          if (this.destroyed || !this.pageVisible) return false;
          if (this.applyBatterySnapshot(info, "navigator")) return true;
        }
      } catch {
        // Continue through compatible host fallbacks.
      }
    }

    for (const methodName of ["getBatteryInfoSync", "getSystemInfoSync"]) {
      if (!wx || typeof wx[methodName] !== "function") continue;
      try {
        if (this.applyBatterySnapshot(wx[methodName](), `wx.${methodName}`)) return true;
      } catch {
        // Continue through asynchronous host fallbacks.
      }
    }

    for (const methodName of ["getBatteryInfo", "getSystemInfo"]) {
      const info = await this.callWxDeviceInfo(methodName);
      if (this.destroyed || !this.pageVisible) return false;
      if (this.applyBatterySnapshot(info, `wx.${methodName}`)) return true;
    }

    if (this.data.token) {
      try {
        const state = await getMobileState(this.config(), 4000);
        if (this.destroyed || !this.pageVisible) return false;
        if (this.applyRelayBatteryState(state)) return true;
      } catch {
        // A missing or offline phone bridge is represented as unknown battery state.
      }
    }
    return false;
  },

  async refreshBatteryStatus() {
    if (this.batteryRefreshPromise) return this.batteryRefreshPromise;
    const refresh = this.resolveBatterySnapshot();
    this.batteryRefreshPromise = refresh;
    try {
      const available = await refresh;
      this.batteryLastRefreshAt = Date.now();
      if (!available) this.clearBatteryStatus();
      return available;
    } finally {
      this.batteryRefreshPromise = null;
    }
  },

  onVoiceWakeup(event) {
    const keyword = String(event?.keyword || "").trim();
    this.appendLog(keyword ? `唤醒词：${keyword}` : "收到语音唤醒。");
    if (this.data.isTranscriptionMode) {
      if (this.speechActive) return;
      if (!this.data.transcriptionDesired || !this.data.transcriptionListening) this.resumeTranscription("wakeup");
      return;
    }
    this.setData({
      assistantStatus: "等待原生 Agent",
      assistantReplyText: "请直接向眼镜助手说出配置需求；它会带着明确指令重新调用配置助手。"
    });
  },

  onKeyUp(event) {
    const code = normalizeInputCode(event);
    let handled = true;
    if (this.data.isTranscriptionMode) {
      if (code === "arrowdown" || code === "arrowright" || code === "backspace") {
        this.requestConfigurationAssistant("gesture");
      } else if (code === "enter" || code === "globalhook") {
        this.toggleTranscription();
      } else {
        handled = false;
      }
    } else if (code === "arrowup" || code === "arrowleft" || code === "backspace") {
      this.switchToTranscription("gesture");
    } else {
      handled = false;
    }
    if (handled && event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  },

  config() {
    return {
      relayBaseUrl: this.data.relayBaseUrl,
      token: this.data.token
    };
  },

  async connectTranscriptionRelay() {
    if (!this.data.token) {
      this.setData({
        connected: false,
        transcriptionSyncLabel: "等待智能体连接"
      });
      return false;
    }
    try {
      const state = await getMobileState(this.config());
      this.applyRelayBatteryState(state);
      const workers = state.workers || [];
      const selectedWorker = state.selectedWorker || {};
      const selectedId = selectedWorker.id || selectedWorker.guid || this.data.targetDeviceId || "";
      const workerIndex = Math.max(0, workers.findIndex((worker) => {
        return worker.id === selectedId || worker.guid === selectedId;
      }));
      this.setData({
        connected: true,
        statusText: "Relay 已连接",
        workers,
        workerIndex,
        targetDeviceId: selectedId,
        transcriptionSyncLabel: this.transcriptQueue.length ? "发送中" : "队列在线",
        agentStatus: "可以直接说话"
      });
      if (!this.data.agentCursor) {
        const cursorState = await getRabiLinkMessageStreamCursor(this.config());
        const cursor = String(cursorState.nextCursor || cursorState.cursor || "").trim();
        this.setData({ agentCursor: cursor });
        saveSettings({ agentCursor: cursor, agentCursorTokenKey: maskToken(this.data.token) });
      }
      this.agentShouldPoll = true;
      if (this.data.isTranscriptionMode) this.scheduleAgentPoll(0);
      if (selectedId) saveSettings({ targetDeviceId: selectedId });
      this.appendLog(`连接对话链路已连接，目标 PC：${selectedWorker.name || selectedId || "未绑定"}。`);
      await this.flushTranscriptQueue();
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      this.setData({
        connected: false,
        statusText: "Relay 连接失败",
        transcriptionSyncLabel: this.transcriptQueue.length ? "待重试" : "离线"
      });
      this.appendLog(`转写链路连接失败：${message}`);
      return false;
    }
  },

  runtimeProofPayload(event, detail = "", extra = {}) {
    const selectedWorker = this.selectedWorker() || {};
    const selectedRoute = this.selectedRoute() || {};
    const selectedPanel = this.selectedPanel() || {};
    const device = {
      userAgent: typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "",
      platform: typeof navigator !== "undefined" ? String(navigator.platform || "") : ""
    };
    return {
      event,
      detail,
      routeId: selectedRoute.id || selectedRoute.configName || "",
      panelId: selectedPanel.id || this.data.panelId || "",
      action: extra.action || "",
      status: extra.status || this.data.statusText || "",
      device,
      runtime: {
        appName: "RabiLink AIUI",
        appVersion: "0.1.2",
        selectedWorkerId: selectedWorker.id || selectedWorker.guid || this.data.targetDeviceId || "",
        selectedWorkerName: selectedWorker.name || ""
      }
    };
  },

  reportRuntimeProof(event, detail = "", extra = {}) {
    const config = this.config();
    if (!config.relayBaseUrl || !config.token) return Promise.resolve(false);
    return sendMobileProof(config, this.runtimeProofPayload(event, detail, extra))
      .then(() => true)
      .catch((error) => {
        this.appendLog(`运行证明上报失败：${error.message || error}`);
        return false;
      });
  },

  selectedWorker() {
    return selectedItem(this.data.workers, this.data.workerIndex);
  },

  selectedRoute() {
    return selectedItem(this.data.routes, this.data.routeIndex);
  },

  selectedGatewayConfig() {
    return selectedGateway(this.data.gateways, this.data.gatewayIndex);
  },

  selectedRemoteAgentDevice() {
    return selectedItem(this.data.remoteAgentDevices, this.data.remoteAgentDeviceIndex);
  },

  selectedPanel() {
    return selectedItem(this.data.configPanels, this.data.panelIndex) || this.data.configPanels[0];
  },

  selectedSurface() {
    return selectedItem(this.data.appSurfaces, this.data.surfaceIndex) || this.data.appSurfaces[0];
  },

  async loadInvocationSurface() {
    await this.connectRelay();
    if (!this.data.connected) return;

    const surface = this.selectedSurface() || {};
    if (surface.kind === "route" || surface.kind === "config" || surface.kind === "agent") {
      await this.refreshRoutes();
    }
    if (surface.kind === "config") {
      await this.loadWebguiConfig();
    } else if (surface.kind === "agent") {
      await this.loadAgentOptions();
    }
  },

  activateSurface() {
    const surface = this.selectedSurface() || {};
    if (surface.kind === "relay" || surface.kind === "relaySettings") return this.connectRelay();
    if (surface.kind === "pc") return this.bindSelectedWorker();
    if (surface.kind === "route") return this.refreshRoutes();
    if (surface.kind === "config") {
      return this.data.webguiLoaded ? this.say(`当前配置：${surface.label}`) : this.loadWebguiConfig();
    }
    if (surface.kind === "agent") return this.saveAgentBinding();
    return this.refreshAll();
  },

  selectedScalarField() {
    return selectedItem(this.data.scalarFields, this.data.scalarFieldIndex);
  },

  selectedJsonField() {
    return selectedItem(this.data.jsonFields, this.data.jsonFieldIndex);
  },

  onRelayUrlInput(event) {
    const relayBaseUrl = event.detail.value;
    this.setData({ relayBaseUrl });
    saveSettings({ relayBaseUrl });
  },

  onTokenInput(event) {
    const token = event.detail.value;
    this.setData({ token, maskedToken: maskToken(token) });
    saveSettings({ token });
  },

  onCopilotCwdInput(event) {
    this.setData({ copilotCwd: event.detail.value });
    this.patchGateway({ copilotCwd: event.detail.value });
  },

  onCopilotBinInput(event) {
    this.setData({ copilotCliBin: event.detail.value });
    this.patchGateway({ copilotCliBin: event.detail.value });
  },

  onMarvisAppIdInput(event) {
    this.setData({ marvisAppId: event.detail.value });
    this.patchGateway({ marvisAppId: event.detail.value });
  },

  onAstrbotUrlInput(event) {
    this.setData({ astrbotUrl: event.detail.value });
    this.patchGateway({ astrbotUrl: event.detail.value });
  },

  onAstrbotUsernameInput(event) {
    this.setData({ astrbotUsername: event.detail.value });
    this.patchGateway({ astrbotUsername: event.detail.value });
  },

  onAstrbotPasswordInput(event) {
    this.setData({ astrbotPassword: event.detail.value });
    this.patchGateway({ astrbotPassword: event.detail.value });
  },

  onAstrbotProjectInput(event) {
    this.setData({ astrbotProjectId: event.detail.value });
    this.patchGateway({ astrbotProjectId: event.detail.value });
  },

  onAstrbotSessionInput(event) {
    this.setData({ astrbotSessionId: event.detail.value });
    this.patchGateway({ astrbotSessionId: event.detail.value });
  },

  onRouteNameInput(event) {
    this.patchGateway({ routeName: event.detail.value, name: event.detail.value });
  },

  onRoleInput(event) {
    this.patchGateway({ agentRoleId: event.detail.value });
  },

  onModelInput(event) {
    this.patchGateway({ agentModel: event.detail.value });
  },

  onPipelineInput(event) {
    this.patchGateway({ pipelinePreset: event.detail.value });
  },

  onGatewayPortInput(event) {
    this.patchGateway({ gatewayPort: Number(event.detail.value || 0) || "" });
  },

  onWebhookPortInput(event) {
    this.patchGateway({ webhookPort: Number(event.detail.value || 0) || "" });
  },

  onFenneNotePortInput(event) {
    this.patchGateway({ fenneNoteWebhookPort: Number(event.detail.value || 0) || "" });
  },

  onRabiLinkPortInput(event) {
    this.patchGateway({ rabiLinkWebhookPort: Number(event.detail.value || 0) || "" });
  },

  onManagerRouteDirInput(event) {
    this.setData({ managerRouteDir: event.detail.value });
  },

  onManagerRolesDirInput(event) {
    this.setData({ managerRolesDir: event.detail.value });
  },

  onRabiNameInput(event) {
    this.setData({ rabiName: event.detail.value });
  },

  onRabiRelayUrlInput(event) {
    this.setData({ rabiRelayUrl: event.detail.value });
  },

  onRabiRelayTokenInput(event) {
    this.setData({ rabiRelayToken: event.detail.value });
  },

  onRabiRelayDeviceInput(event) {
    this.setData({ rabiRelayDeviceId: event.detail.value });
  },

  onRabiRelayClaimInput(event) {
    this.setData({ rabiRelayClaimWaitMs: event.detail.value });
  },

  onRabiRelayIdleInput(event) {
    this.setData({ rabiRelayReplyIdleTimeoutMs: event.detail.value });
  },

  onScalarFieldInput(event) {
    this.setData({ scalarFieldValue: event.detail.value });
  },

  onJsonFieldInput(event) {
    this.setData({ jsonFieldValue: event.detail.value });
  },

  onRouteVariableKeyInput(event) {
    this.setData({ routeVariableKey: event.detail.value });
  },

  onRouteVariableValueInput(event) {
    this.setData({ routeVariableValue: event.detail.value });
  },

  onNotificationRuleNameInput(event) {
    this.setData({ notificationRuleName: event.detail.value });
  },

  onNotificationRuleRouteKindsInput(event) {
    this.setData({ notificationRuleRouteKinds: event.detail.value });
    this.updateDerivedState();
  },

  onNotificationRuleTargetGroupInput(event) {
    this.setData({ notificationRuleTargetGroupId: event.detail.value });
  },

  onNotificationRuleAllowedSpeakersInput(event) {
    this.setData({ notificationRuleAllowedSpeakerNames: event.detail.value });
  },

  onNotificationRuleRegexInput(event) {
    this.setData({ notificationRuleRegex: event.detail.value });
  },

  onNotificationRuleTemplateInput(event) {
    this.setData({ notificationRuleTemplate: event.detail.value });
  },

  onMessagePolicyOutputsInput(event) {
    this.setData({ messagePolicyOutputs: event.detail.value });
    this.updateDerivedState();
  },

  onNapcatIdInput(event) {
    this.setData({ napcatInstanceId: event.detail.value });
  },

  onNapcatNameInput(event) {
    this.setData({ napcatInstanceName: event.detail.value });
  },

  onNapcatGatewayPortInput(event) {
    this.setData({ napcatGatewayPort: event.detail.value });
  },

  onNapcatHttpUrlInput(event) {
    this.setData({ napcatHttpUrl: event.detail.value });
  },

  onNapcatWebuiUrlInput(event) {
    this.setData({ napcatWebuiUrl: event.detail.value });
  },

  onNapcatAccessTokenInput(event) {
    this.setData({ napcatAccessToken: event.detail.value });
  },

  onNapcatWebuiTokenInput(event) {
    this.setData({ napcatWebuiToken: event.detail.value });
  },

  onNapcatLaunchCommandInput(event) {
    this.setData({ napcatLaunchCommand: event.detail.value });
  },

  onNapcatWorkingDirInput(event) {
    this.setData({ napcatWorkingDir: event.detail.value });
  },

  onNapcatBotUserIdInput(event) {
    this.setData({ napcatBotUserId: event.detail.value });
  },

  onNapcatBotNicknameInput(event) {
    this.setData({ napcatBotNickname: event.detail.value });
  },

  onPipelineIdInput(event) {
    this.setData({ pipelineId: event.detail.value });
  },

  onPipelineNameInput(event) {
    this.setData({ pipelineName: event.detail.value });
  },

  onPipelineOutputPipelineInput(event) {
    this.setData({ pipelineOutputPipeline: event.detail.value });
  },

  onPipelineTtsProviderInput(event) {
    this.setData({ pipelineTtsProvider: event.detail.value });
  },

  onPipelineTtsVoiceInput(event) {
    this.setData({ pipelineTtsVoice: event.detail.value });
  },

  onPipelineTtsWorkerUrlInput(event) {
    this.setData({ pipelineTtsWorkerUrl: event.detail.value });
  },

  onRouteProfileIdInput(event) {
    this.setData({ routeProfileId: event.detail.value });
  },

  onRouteProfileNameInput(event) {
    this.setData({ routeProfileName: event.detail.value });
  },

  onRouteProfileRoleInput(event) {
    this.setData({ routeProfileRoleId: event.detail.value });
  },

  onRouteProfileRoleFileInput(event) {
    this.setData({ routeProfileRoleFile: event.detail.value });
  },

  onRouteProfileRolesDirInput(event) {
    this.setData({ routeProfileRolesDir: event.detail.value });
  },

  onRouteProfileDataDirInput(event) {
    this.setData({ routeProfileDataDir: event.detail.value });
  },

  onRouteProfileRecentLimitInput(event) {
    this.setData({ routeProfileRecentMessageLimit: event.detail.value });
  },

  onRouteProfilePipelinePresetInput(event) {
    this.setData({ routeProfilePipelinePreset: event.detail.value });
  },

  onRouteProfilePipelineInput(event) {
    this.setData({ routeProfilePipelineJson: event.detail.value });
  },

  onRouteProfileVariablesInput(event) {
    this.setData({ routeProfileVariablesJson: event.detail.value });
  },

  onNotificationTemplateInput(event) {
    this.setData({ notificationTemplateValue: event.detail.value });
  },

  onIntegrationWebhookPathInput(event) {
    this.setData({ integrationWebhookPath: event.detail.value });
  },

  onIntegrationFenneNotePathInput(event) {
    this.setData({ integrationFenneNotePath: event.detail.value });
  },

  onIntegrationXiaoaiPathInput(event) {
    this.setData({ integrationXiaoaiPath: event.detail.value });
  },

  onIntegrationRabiLinkPathInput(event) {
    this.setData({ integrationRabiLinkPath: event.detail.value });
  },

  onIntegrationRabiLinkHostInput(event) {
    this.setData({ integrationRabiLinkHost: event.detail.value });
  },

  onIntegrationHeartbeatSecondsInput(event) {
    this.setData({ integrationHeartbeatSeconds: event.detail.value });
  },

  onIntegrationHeartbeatMessageInput(event) {
    this.setData({ integrationHeartbeatMessage: event.detail.value });
  },

  onIntegrationWecomBotIdInput(event) {
    this.setData({ integrationWecomBotId: event.detail.value });
  },

  onIntegrationWecomBotSecretInput(event) {
    this.setData({ integrationWecomBotSecret: event.detail.value });
  },

  onIntegrationWecomWsUrlInput(event) {
    this.setData({ integrationWecomWsUrl: event.detail.value });
  },

  onIntegrationRemoteAgentDeviceInput(event) {
    this.setData({ integrationRemoteAgentDeviceId: event.detail.value });
  },

  onIntegrationRemoteAgentCwdInput(event) {
    this.setData({ integrationRemoteAgentCwd: event.detail.value });
  },

  onIntegrationRemoteAgentThreadInput(event) {
    this.setData({ integrationRemoteAgentThreadName: event.detail.value });
  },

  onNotificationScheduleNameInput(event) {
    this.setData({ notificationScheduleName: event.detail.value });
  },

  onNotificationScheduleIntervalInput(event) {
    this.setData({ notificationScheduleIntervalSeconds: event.detail.value });
  },

  onNotificationScheduleWindowStartInput(event) {
    this.setData({ notificationScheduleWindowStartTime: event.detail.value });
  },

  onNotificationScheduleWindowEndInput(event) {
    this.setData({ notificationScheduleWindowEndTime: event.detail.value });
  },

  onNotificationScheduleTimeOfDayInput(event) {
    this.setData({ notificationScheduleTimeOfDay: event.detail.value });
  },

  onNotificationScheduleOnceAtInput(event) {
    this.setData({ notificationScheduleOnceAt: event.detail.value });
  },

  onManualTriggerInput(event) {
    this.setData({ manualTriggerMessage: event.detail.value });
  },

  onRemoteAgentPasswordInput(event) {
    this.setData({ remoteAgentPassword: event.detail.value });
  },

  async refreshAll() {
    await this.connectRelay();
    if (this.data.connected) {
      await this.refreshRoutes();
      await this.loadWebguiConfig();
    }
  },

  async connectRelay() {
    await this.runAction("连接 Relay", async () => {
      const state = await getMobileState(this.config());
      this.applyRelayBatteryState(state);
      const workers = state.workers || [];
      const selectedWorker = state.selectedWorker || {};
      const selectedId = selectedWorker.id || selectedWorker.guid || this.data.targetDeviceId;
      const workerIndex = Math.max(0, workers.findIndex((worker) => {
        return worker.id === selectedId || worker.guid === selectedId;
      }));
      this.setData({
        connected: true,
        statusText: "Relay 已连接",
        workers,
        workerIndex,
        targetDeviceId: selectedId || ""
      });
      saveSettings({ targetDeviceId: selectedId || "" });
      this.appendLog(`Relay 已连接，发现 ${workers.length} 台 PC Rabi。`);
      this.say(`已连接，发现 ${workers.length} 台 PC。`);
      this.updateDerivedState();
      this.reportRuntimeProof("relay-connected", `发现 ${workers.length} 台 PC Rabi。`, {
        action: "connect-relay",
        status: "connected"
      });
      await this.flushTranscriptQueue();
    });
  },

  async bindSelectedWorker() {
    const worker = this.selectedWorker();
    if (!worker) {
      this.warn("没有可绑定的 PC Rabi。");
      return;
    }
    await this.runAction("绑定 PC", async () => {
      const state = await selectMobileTarget(this.config(), worker.id || worker.guid);
      const selectedWorker = state.selectedWorker || {};
      const selectedId = selectedWorker.id || selectedWorker.guid || worker.id || worker.guid;
      this.setData({
        workers: state.workers || this.data.workers,
        targetDeviceId: selectedId,
        statusText: "PC 已绑定"
      });
      saveSettings({ targetDeviceId: selectedId });
      this.appendLog(`已绑定 PC：${worker.name || selectedId}`);
      this.say(`已绑定 ${worker.name || "这台 PC"}`);
      this.updateDerivedState();
      this.reportRuntimeProof("pc-bound", `已绑定 PC：${worker.name || selectedId}`, {
        action: "bind-pc",
        status: "bound"
      });
    });
  },

  async refreshRoutes() {
    await this.runAction("读取 Route", async () => {
      const routes = await getMobileRoutes(this.config(), this.data.targetDeviceId);
      const savedRouteId = initialSettings().selectedRouteId;
      const routeIndex = Math.max(0, routes.findIndex((route) => {
        return route.id === savedRouteId || route.configName === savedRouteId;
      }));
      const gatewayIndex = this.data.gateways.length
        ? findGatewayIndex(this.data.gateways, routes[routeIndex]?.id || savedRouteId)
        : this.data.gatewayIndex;
      this.setData({
        routes,
        routeIndex,
        gatewayIndex,
        statusText: "Route 已读取"
      });
      this.appendLog(`读取到 ${routes.length} 条 Route。`);
      this.say(`读取到 ${routes.length} 条 Route。`);
      this.updateDerivedState();
    });
  },

  async loadWebguiConfigData() {
    const targetDeviceId = this.data.targetDeviceId;
    const gatewayPayload = await getMobileWebgui(this.config(), "/gateways", targetDeviceId);
    const meta = await getMobileWebgui(this.config(), "/meta", targetDeviceId);
    const dirConfig = await getMobileWebgui(this.config(), "/manager-config", targetDeviceId);
    const gateways = extractGateways(gatewayPayload);
    const route = this.selectedRoute();
    const gatewayIndex = findGatewayIndex(gateways, route?.id || initialSettings().selectedRouteId);
    const relay = meta.rabiLinkRelay || {};
    this.setData({
      gateways,
      runtimeRows: extractRuntimeRows(gatewayPayload),
      gatewayIndex,
      webguiLoaded: true,
      webguiDirty: false,
      managerRouteDir: dirConfig.routeDir || "",
      managerRolesDir: dirConfig.rolesDir || "",
      rabiName: meta.rabiName || meta.computerName || "",
      rabiRelayUrl: relay.url || "",
      rabiRelayToken: relay.token || "",
      rabiRelayDeviceId: relay.deviceId || meta.computerName || "",
      rabiRelayClaimWaitMs: String(relay.claimWaitMs || 60000),
      rabiRelayReplyIdleTimeoutMs: String(relay.replyIdleTimeoutMs || 60000),
      statusText: "WebGUI 配置已读取"
    });
    this.syncAgentFromGateway();
    this.refreshConfigEditorValues();
    return gateways;
  },

  async loadWebguiConfig() {
    await this.runAction("读取 WebGUI 配置", async () => {
      const gateways = await this.loadWebguiConfigData();
      this.appendLog(`已读取 WebGUI 配置：${gateways.length} 条 Route。`);
      this.say(`已读取 ${gateways.length} 条配置。`);
      this.reportRuntimeProof("webgui-config-loaded", `已读取 ${gateways.length} 条 Route 配置。`, {
        action: "load-webgui-config",
        status: "loaded"
      });
    });
  },

  async saveWebguiConfig() {
    if (!this.data.webguiLoaded) {
      this.warn("请先读取 WebGUI 配置。");
      return;
    }
    await this.runAction("保存 WebGUI 配置", async () => {
      const body = saveBodyForGateways(this.data.gateways);
      await postMobileWebgui(this.config(), "/gateways", body, this.data.targetDeviceId);
      this.setData({ webguiDirty: false, statusText: "WebGUI 配置已保存" });
      this.appendLog("WebGUI route 配置已保存。");
      this.say("配置已保存。");
      this.reportRuntimeProof("webgui-config-saved", "WebGUI route 配置已保存。", {
        action: "save-webgui-config",
        status: "saved"
      });
    });
  },

  addGatewayDraft() {
    const result = appendDefaultGateway(this.data.gateways);
    this.setData({
      gateways: result.gateways,
      gatewayIndex: result.index,
      routeIndex: Math.max(0, this.data.routeIndex),
      webguiLoaded: true,
      webguiDirty: true,
      runtimeActionSummary: "已新增 Route 草稿"
    });
    this.syncAgentFromGateway();
    this.refreshConfigEditorValues();
    this.appendLog(`已新增 Route 草稿：${result.gateway.name || result.gateway.id}`);
    this.say("已新增 Route 草稿，保存配置后生效。");
  },

  duplicateGatewayDraft() {
    const result = duplicateSelectedGateway(this.data.gateways, this.data.gatewayIndex);
    this.setData({
      gateways: result.gateways,
      gatewayIndex: result.index,
      webguiLoaded: true,
      webguiDirty: true,
      runtimeActionSummary: "已复制 Route 草稿"
    });
    this.syncAgentFromGateway();
    this.refreshConfigEditorValues();
    this.appendLog(`已复制 Route 草稿：${result.gateway.name || result.gateway.id}`);
    this.say("已复制 Route 草稿，保存配置后生效。");
  },

  removeGatewayDraft() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    const label = routeLabel(gateway);
    const removeNow = () => {
      const result = removeSelectedGateway(this.data.gateways, this.data.gatewayIndex);
      this.setData({
        gateways: result.gateways,
        gatewayIndex: result.index,
        webguiDirty: true,
        runtimeActionSummary: "已移除 Route 草稿"
      });
      this.syncAgentFromGateway();
      this.refreshConfigEditorValues();
      this.appendLog(`已移除 Route 草稿：${label}`);
      this.say("已移除 Route 草稿，保存配置后生效。");
    };
    if (wx.showModal) {
      wx.showModal({
        title: "移除 Route",
        content: `确认从配置草稿移除 ${label}？保存配置后会写回 PC。`,
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) removeNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行移除。");
  },

  moveGatewayDraft(delta) {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    const result = moveSelectedGateway(this.data.gateways, this.data.gatewayIndex, delta);
    this.setData({
      gateways: result.gateways,
      gatewayIndex: result.index,
      webguiDirty: true,
      runtimeActionSummary: delta < 0 ? "已上移 Route 草稿" : "已下移 Route 草稿"
    });
    this.syncAgentFromGateway();
    this.refreshConfigEditorValues();
    this.appendLog(`${this.data.runtimeActionSummary}：${routeLabel(result.moved || gateway)}`);
    this.say("Route 顺序已调整，保存配置后生效。");
  },

  moveGatewayUp() {
    this.moveGatewayDraft(-1);
  },

  moveGatewayDown() {
    this.moveGatewayDraft(1);
  },

  async saveManagerDirs() {
    await this.runAction("保存目录配置", async () => {
      await postMobileWebgui(this.config(), "/manager-config", {
        routeDir: this.data.managerRouteDir || undefined,
        rolesDir: this.data.managerRolesDir || undefined
      }, this.data.targetDeviceId);
      this.appendLog("目录配置已保存。");
      this.say("目录配置已保存。");
    });
  },

  async saveRabiIdentity() {
    await this.runAction("保存 Rabi 实例", async () => {
      await postMobileWebgui(this.config(), "/api/rabi/identity", {
        rabiName: this.data.rabiName,
        rabiLinkRelay: {
          url: this.data.rabiRelayUrl,
          token: this.data.rabiRelayToken,
          deviceId: this.data.rabiRelayDeviceId,
          claimWaitMs: Number(this.data.rabiRelayClaimWaitMs || 60000),
          replyIdleTimeoutMs: Number(this.data.rabiRelayReplyIdleTimeoutMs || 60000)
        }
      }, this.data.targetDeviceId, "PATCH");
      this.appendLog("Rabi 实例配置已保存。");
      this.say("Rabi 实例已保存。");
    });
  },

  async loadAgentOptions() {
    const route = this.selectedRoute();
    if (!route) {
      this.warn("请先选择 Route。");
      return;
    }
    await this.runAction("读取 Agent 选项", async () => {
      const data = await getMobileAgentOptions(this.config(), route.id, this.data.targetDeviceId);
      const routeInfo = data.route || {};
      const agentAdapters = routeInfo.agentAdapters || route.agentAdapters || ["codex"];
      const agentAdapter = agentAdapters[0] || "codex";
      const cwdOptions = data.cwdOptions || [];
      const threadOptions = data.threadNames || [];
      const selectedThreadName = routeInfo.codexThreadName || route.codexThreadName || "";
      this.setData({
        agentAdapter,
        cwdOptions,
        threadOptions,
        cwdIndex: Math.max(0, cwdOptions.indexOf(routeInfo.codexCwd || route.codexCwd || "")),
        threadIndex: Math.max(0, threadOptions.indexOf(selectedThreadName)),
        copilotCwd: routeInfo.copilotCwd || "",
        copilotCliBin: routeInfo.copilotCliBin || "",
        marvisAppId: routeInfo.marvisAppId || "",
        astrbotUrl: routeInfo.astrbotUrl || "",
        astrbotUsername: routeInfo.astrbotUsername || "",
        astrbotPassword: routeInfo.astrbotPassword || "",
        astrbotProjectId: routeInfo.astrbotProjectId || "",
        astrbotSessionId: routeInfo.astrbotSessionId || "",
        statusText: "Agent 选项已读取"
      });
      this.appendLog(`已读取 ${route.name || route.id} 的 Agent 选项。`);
      this.say("Agent 选项已读取。");
      this.updateDerivedState();
    });
  },

  async saveAgentBinding() {
    const route = this.selectedRoute();
    if (!route) {
      this.warn("请先选择 Route。");
      return;
    }
    await this.runAction("保存 Agent 绑定", async () => {
      const binding = this.buildAgentBinding();
      await setMobileAgentBinding(this.config(), route.id, binding, this.data.targetDeviceId);
      this.setData({ statusText: "绑定已保存" });
      this.appendLog(`已保存 ${route.name || route.id} -> ${this.data.agentAdapter}。`);
      this.say("绑定已保存。");
    });
  },

  buildAgentBinding() {
    if (this.data.agentAdapter === "codex") {
      return {
        agentAdapter: "codex",
        codexCwd: selectedItem(this.data.cwdOptions, this.data.cwdIndex) || "",
        codexThreadName: selectedItem(this.data.threadOptions, this.data.threadIndex) || ""
      };
    }
    if (this.data.agentAdapter === "copilotCli") {
      return {
        agentAdapter: "copilotCli",
        copilotCwd: this.data.copilotCwd,
        copilotCliBin: this.data.copilotCliBin
      };
    }
    if (this.data.agentAdapter === "marvis") {
      return {
        agentAdapter: "marvis",
        marvisAppId: this.data.marvisAppId
      };
    }
    return {
      agentAdapter: "astrbot",
      astrbotUrl: this.data.astrbotUrl,
      astrbotUsername: this.data.astrbotUsername,
      astrbotPassword: this.data.astrbotPassword,
      astrbotProjectId: this.data.astrbotProjectId,
      astrbotSessionId: this.data.astrbotSessionId
    };
  },

  patchGateway(patch) {
    if (!this.selectedGatewayConfig()) return;
    this.setData({
      gateways: patchSelectedGateway(this.data.gateways, this.data.gatewayIndex, patch),
      webguiDirty: true
    });
    this.updateDerivedState();
  },

  syncAgentFromGateway() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return;
    const adapters = agentAdaptersFor(gateway);
    const agentAdapter = adapters[0] || this.data.agentAdapter || "codex";
    this.setData({
      agentAdapter,
      copilotCwd: gateway.copilotCwd || this.data.copilotCwd,
      copilotCliBin: gateway.copilotCliBin || this.data.copilotCliBin,
      marvisAppId: gateway.marvisAppId || this.data.marvisAppId,
      astrbotUrl: gateway.astrbotUrl || this.data.astrbotUrl,
      astrbotUsername: gateway.astrbotUsername || this.data.astrbotUsername,
      astrbotPassword: gateway.astrbotPassword || this.data.astrbotPassword,
      astrbotProjectId: gateway.astrbotProjectId || this.data.astrbotProjectId,
      astrbotSessionId: gateway.astrbotSessionId || this.data.astrbotSessionId
    });
  },

  refreshConfigEditorValues() {
    this.refreshAdvancedFieldValues();
    this.refreshNapcatInstanceValues();
    this.refreshPipelineValues();
    this.refreshRouteProfileValues();
    this.refreshRouteVariableValues();
    this.refreshNotificationRuleValues();
    this.refreshNotificationScheduleValues();
    this.refreshNotificationTemplateValues();
    this.refreshIntegrationValues();
    this.refreshMessagePolicyValues();
  },

  async loadNetworkOptions() {
    await this.runAction("读取网络选项", async () => {
      const data = await getMobileWebgui(this.config(), "/network-options", this.data.targetDeviceId);
      const payload = data.data || data;
      const localAddresses = Array.isArray(payload.localAddresses) ? payload.localAddresses.length : 0;
      const httpServers = Array.isArray(payload.httpServers) ? payload.httpServers.length : 0;
      const websocketClients = Array.isArray(payload.websocketClients) ? payload.websocketClients.length : 0;
      const networkSummary = `地址 ${localAddresses} · HTTP ${httpServers} · WS ${websocketClients}`;
      this.setData({ networkSummary });
      this.appendLog(`网络选项：${networkSummary}`);
    });
  },

  async runAgentScan() {
    await this.runAction("扫描 Agent", async () => {
      const data = await getMobileWebgui(this.config(), "/api/scan/agents", this.data.targetDeviceId);
      const agents = data.agents || data.data?.agents || {};
      const names = Object.keys(agents);
      const ready = names.filter((name) => {
        const agent = agents[name] || {};
        return agent.installed || agent.healthy || agent.available || agent.projects?.length || agent.sessions?.length;
      });
      const agentScanSummary = ready.length ? `${ready.join(" / ")} 可用` : `已扫描 ${names.length} 类 Agent`;
      this.setData({ agentScanSummary });
      this.appendLog(`Agent 扫描：${agentScanSummary}`);
    });
  },

  async runMessageScan() {
    await this.runAction("扫描消息端", async () => {
      const data = await getMobileWebgui(this.config(), "/api/scan/message-adapters", this.data.targetDeviceId);
      const adapters = data.adapters || data.data?.adapters || data.messageAdapters || {};
      const names = Array.isArray(adapters)
        ? adapters.map((item) => item.type || item.id).filter(Boolean)
        : Object.keys(adapters);
      const messageScanSummary = names.length ? `${names.join(" / ")} 已发现` : "扫描完成，未发现消息端";
      this.setData({ messageScanSummary });
      this.appendLog(`消息端扫描：${messageScanSummary}`);
    });
  },

  async testNapcatHealth() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    await this.runAction("检查 NapCat", async () => {
      const data = await postMobileWebgui(this.config(), "/api/message/napcat-health", this.napcatWebguiBody(), this.data.targetDeviceId);
      const http = data.http || {};
      const webui = data.webui || {};
      const label = data.ok ? "可用" : "异常";
      const napcatHealthSummary = `${label} · HTTP ${http.ok ? "OK" : (http.message || "-")} · WebUI ${webui.reachable ? "OK" : (webui.message || "-")}`;
      this.setData({ napcatHealthSummary });
      this.appendLog(`NapCat：${napcatHealthSummary}`);
    });
  },

  selectedNapcatDraft() {
    const rows = this.data.napcatInstanceRows || [];
    return rows[Math.max(0, Math.min(this.data.napcatInstanceIndex, rows.length - 1))] || null;
  },

  napcatWebguiBody() {
    const gateway = this.selectedGatewayConfig() || {};
    const instance = this.selectedNapcatDraft();
    if (instance) {
      return {
        gatewayId: gateway.id || gateway.configName,
        instanceId: instance.id,
        httpUrl: instance.httpUrl || gateway.napcatHttpUrl || "http://127.0.0.1:3000",
        webuiUrl: instance.webuiUrl || gateway.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
        accessToken: instance.accessToken || gateway.napcatAccessToken || "",
        webuiToken: instance.webuiToken || gateway.napcatWebuiToken || "",
        gatewayPort: instance.gatewayPort || gateway.gatewayPort || 0,
        botUserId: instance.botUserId || "",
        botNickname: instance.botNickname || ""
      };
    }
    return {
      gatewayId: gateway.id || gateway.configName,
      httpUrl: gateway.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: gateway.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: gateway.napcatAccessToken || "",
      webuiToken: gateway.napcatWebuiToken || "",
      gatewayPort: gateway.gatewayPort || 0
    };
  },

  async configureNapcatOnebot() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const run = async () => {
      await this.runAction("配置 NapCat", async () => {
        const data = await postMobileWebgui(this.config(), "/api/message/napcat-configure-onebot", this.napcatWebguiBody(), this.data.targetDeviceId);
        const napcatRepairSummary = `${data.ok === false ? "失败" : "完成"} · ${data.message || data.wsUrl || "-"}`;
        this.setData({ napcatRepairSummary });
        this.appendLog(`NapCat OneBot：${napcatRepairSummary}`);
      });
    };
    if (wx.showModal) {
      wx.showModal({
        title: "配置 NapCat",
        content: "确认写入当前 NapCat OneBot 配置？",
        confirmText: "写入",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) run();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行配置。");
  },

  async repairAllNapcatIssues() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const run = async () => {
      await this.runAction("修复 NapCat", async () => {
        const data = await postMobileWebgui(this.config(), "/api/message/napcat-repair-all", {}, this.data.targetDeviceId);
        const results = Array.isArray(data.results) ? data.results : [];
        const changed = data.repair?.changed || data.gatewayPayload?.data?.config;
        const napcatRepairSummary = `${changed ? "已修改" : "已检查"} · ${results.length} 项`;
        this.setData({ napcatRepairSummary });
        this.appendLog(`NapCat 修复：${napcatRepairSummary}`);
        if (changed) await this.loadWebguiConfigData();
      });
    };
    if (wx.showModal) {
      wx.showModal({
        title: "修复 NapCat",
        content: "确认执行 PC WebGUI 的 NapCat 一键修复？这可能修改端口和 OneBot 配置。",
        confirmText: "修复",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) run();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行修复。");
  },

  async testAstrbotLogin() {
    const gateway = this.selectedGatewayConfig();
    const url = this.data.astrbotUrl || gateway?.astrbotUrl || "";
    if (!url) return this.warn("请先填写 AstrBot URL。");
    await this.runAction("验证 AstrBot", async () => {
      const data = await postMobileWebgui(this.config(), "/api/agent/astrbot-login-test", {
        url,
        username: this.data.astrbotUsername || gateway?.astrbotUsername || "",
        password: this.data.astrbotPassword || gateway?.astrbotPassword || ""
      }, this.data.targetDeviceId);
      const astrbotLoginSummary = `${data.ok ? "成功" : "失败"} · ${data.message || "-"}`;
      this.setData({ astrbotLoginSummary });
      this.appendLog(`AstrBot：${astrbotLoginSummary}`);
    });
  },

  confirmDangerousTool(title, content, confirmText, run) {
    if (wx.showModal) {
      wx.showModal({
        title,
        content,
        confirmText,
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) run();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行工具动作。");
  },

  summarizeToolResult(label, data) {
    const ok = data.ok === false || data.code === -1 ? "失败" : "完成";
    return `${label} ${ok} · ${data.message || data.error || data.code || "-"}`;
  },

  async runWebguiTool(label, path, body = {}, options = {}) {
    await this.runAction(label, async () => {
      const data = await postMobileWebgui(this.config(), path, body, this.data.targetDeviceId);
      const webguiToolSummary = this.summarizeToolResult(label, data);
      this.setData({ webguiToolSummary });
      this.appendLog(webguiToolSummary);
      this.say(webguiToolSummary);
      if (options.reload) await this.loadWebguiConfigData();
    });
  },

  remoteAgentDeviceIndexFor(devices, preferredId = "") {
    const list = Array.isArray(devices) ? devices : [];
    const id = String(preferredId || this.selectedRemoteAgentDevice()?.deviceId || this.data.integrationRemoteAgentDeviceId || "").trim();
    const index = id ? list.findIndex((device) => device.deviceId === id) : -1;
    return index >= 0 ? index : 0;
  },

  setRemoteAgentDevices(devices, preferredId = "") {
    const list = Array.isArray(devices) ? devices : [];
    const remoteAgentDeviceIndex = this.remoteAgentDeviceIndexFor(list, preferredId);
    const device = selectedItem(list, remoteAgentDeviceIndex);
    this.setData({
      remoteAgentDevices: list,
      remoteAgentDeviceIndex,
      remoteAgentDeviceLabel: remoteAgentDeviceLabel(device),
      remoteAgentDeviceMeta: remoteAgentDeviceMeta(device),
      remoteAgentSummary: list.length ? `${remoteAgentDeviceIndex + 1}/${list.length} ${remoteAgentDeviceMeta(device)}` : "未发现远端 Agent"
    });
  },

  async refreshRemoteAgentDevices() {
    await this.runAction("读取远端 Agent", async () => {
      const data = await getMobileWebgui(this.config(), WEBGUI_TOOL_PATHS.remoteAgentDevices, this.data.targetDeviceId);
      this.setRemoteAgentDevices(data.devices || []);
      this.appendLog(`远端 Agent：${(data.devices || []).length} 台设备。`);
    });
  },

  async scanRemoteAgentDevices() {
    await this.runAction("扫描远端 Agent", async () => {
      const data = await postMobileWebgui(this.config(), WEBGUI_TOOL_PATHS.remoteAgentScan, {}, this.data.targetDeviceId);
      this.setRemoteAgentDevices(data.devices || []);
      this.appendLog(`远端 Agent 扫描完成：${(data.devices || []).length} 台设备。`);
      this.say("远端 Agent 扫描完成。");
    });
  },

  prevRemoteAgentDevice() {
    const devices = this.data.remoteAgentDevices || [];
    if (!devices.length) return this.warn("请先扫描远端 Agent。");
    const remoteAgentDeviceIndex = (this.data.remoteAgentDeviceIndex - 1 + devices.length) % devices.length;
    this.setRemoteAgentDevices(devices, devices[remoteAgentDeviceIndex]?.deviceId);
  },

  nextRemoteAgentDevice() {
    const devices = this.data.remoteAgentDevices || [];
    if (!devices.length) return this.warn("请先扫描远端 Agent。");
    const remoteAgentDeviceIndex = (this.data.remoteAgentDeviceIndex + 1) % devices.length;
    this.setRemoteAgentDevices(devices, devices[remoteAgentDeviceIndex]?.deviceId);
  },

  applySelectedRemoteAgentDevice() {
    const device = this.selectedRemoteAgentDevice();
    if (!device?.deviceId) return this.warn("请先选择远端 Agent。");
    const patch = {
      remoteAgentDefaultDeviceId: device.deviceId,
      remoteAgentDefaultCwd: device.defaultCwd || this.data.integrationRemoteAgentCwd,
      remoteAgentDefaultThreadName: device.defaultThreadName || this.data.integrationRemoteAgentThreadName
    };
    this.setData({
      integrationRemoteAgentDeviceId: patch.remoteAgentDefaultDeviceId,
      integrationRemoteAgentCwd: patch.remoteAgentDefaultCwd,
      integrationRemoteAgentThreadName: patch.remoteAgentDefaultThreadName
    });
    this.patchGateway(patch);
    this.appendLog(`已应用远端 Agent：${remoteAgentDeviceLabel(device)}，保存配置后生效。`);
  },

  async fetchCopilotStatus() {
    await this.runAction("读取 Copilot", async () => {
      const data = await getMobileWebgui(this.config(), WEBGUI_TOOL_PATHS.copilotStatus, this.data.targetDeviceId);
      const installed = data.installed ? "已安装" : "未安装";
      const loggedIn = data.loggedIn ? "已登录" : "未登录";
      const bin = data.binPath || data.command || "-";
      const copilotStatusSummary = `${installed} · ${loggedIn} · ${bin}`;
      this.setData({ copilotStatusSummary });
      this.appendLog(`Copilot：${copilotStatusSummary}`);
    });
  },

  connectRemoteAgentDevice() {
    const device = this.selectedRemoteAgentDevice();
    if (!device?.deviceId) return this.warn("请先选择远端 Agent。");
    this.confirmDangerousTool(
      "连接远端 Agent",
      `确认让 PC Rabi Manager 连接 ${remoteAgentDeviceLabel(device)}？`,
      "连接",
      async () => {
        await this.runAction("连接远端 Agent", async () => {
          const data = await postMobileWebgui(this.config(), WEBGUI_TOOL_PATHS.remoteAgentConnect, {
            deviceId: device.deviceId,
            password: this.data.remoteAgentPassword
          }, this.data.targetDeviceId);
          const connectedDevice = data.device || device;
          this.setRemoteAgentDevices(data.devices || this.data.remoteAgentDevices, connectedDevice.deviceId);
          this.setData({ remoteAgentPassword: "" });
          if (connectedDevice.deviceId) {
            const patch = {
              remoteAgentDefaultDeviceId: connectedDevice.deviceId,
              remoteAgentDefaultCwd: connectedDevice.defaultCwd || this.data.integrationRemoteAgentCwd,
              remoteAgentDefaultThreadName: connectedDevice.defaultThreadName || this.data.integrationRemoteAgentThreadName
            };
            this.setData({
              integrationRemoteAgentDeviceId: patch.remoteAgentDefaultDeviceId,
              integrationRemoteAgentCwd: patch.remoteAgentDefaultCwd,
              integrationRemoteAgentThreadName: patch.remoteAgentDefaultThreadName
            });
            this.patchGateway(patch);
          }
          this.appendLog(`远端 Agent 已连接：${remoteAgentDeviceLabel(connectedDevice)}。`);
          this.say("远端 Agent 已连接。");
        });
      }
    );
  },

  disconnectRemoteAgentDevice() {
    const device = this.selectedRemoteAgentDevice();
    if (!device?.deviceId) return this.warn("请先选择远端 Agent。");
    this.confirmDangerousTool(
      "断开远端 Agent",
      `确认断开 ${remoteAgentDeviceLabel(device)}？`,
      "断开",
      async () => {
        await this.runAction("断开远端 Agent", async () => {
          const data = await postMobileWebgui(this.config(), WEBGUI_TOOL_PATHS.remoteAgentDisconnect, {
            deviceId: device.deviceId
          }, this.data.targetDeviceId);
          this.setRemoteAgentDevices(data.devices || this.data.remoteAgentDevices, device.deviceId);
          this.appendLog(`远端 Agent 已断开：${remoteAgentDeviceLabel(device)}。`);
          this.say("远端 Agent 已断开。");
        });
      }
    );
  },

  openPcConfigFile(type, label) {
    const gateway = this.selectedGatewayConfig();
    const params = new URLSearchParams({ type });
    const gatewayId = gateway?.id || gateway?.configName || "";
    const roleId = gateway?.agentRoleId || "";
    if (gatewayId) params.set("gatewayId", gatewayId);
    if (roleId) params.set("roleId", roleId);
    this.confirmDangerousTool(
      label,
      `确认让 PC 打开${label}？`,
      "打开",
      () => this.runWebguiTool(label, `${WEBGUI_TOOL_PATHS.openConfigFile}?${params.toString()}`)
    );
  },

  openManagerConfigOnPc() {
    this.openPcConfigFile("manager", "Manager 目录");
  },

  openRouteConfigOnPc() {
    this.openPcConfigFile("routes", "Route 配置文件");
  },

  openRouteFolderOnPc() {
    this.openPcConfigFile("route-folder", "Route 目录");
  },

  openRolePersonaOnPc() {
    this.openPcConfigFile("role", "Persona 文件");
  },

  openRoleMessageConfigOnPc() {
    this.openPcConfigFile("role-message-config", "人格消息配置");
  },

  selectedNapcatToolBody() {
    const body = this.napcatWebguiBody();
    return {
      gatewayId: body.gatewayId,
      instanceId: body.instanceId
    };
  },

  addManagedNapcat() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    this.confirmDangerousTool(
      "新增 NapCat",
      "确认让 PC WebGUI 新增一个托管 NapCat 实例？",
      "新增",
      () => this.runWebguiTool("新增 NapCat", WEBGUI_TOOL_PATHS.napcatAdd, { gatewayId: gateway.id || gateway.configName }, { reload: true })
    );
  },

  launchManagedNapcat() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    this.confirmDangerousTool(
      "启动 NapCat",
      "确认让 PC 启动当前 NapCat 实例？",
      "启动",
      () => this.runWebguiTool("启动 NapCat", WEBGUI_TOOL_PATHS.napcatLaunch, this.selectedNapcatToolBody())
    );
  },

  restartManagedNapcat() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    this.confirmDangerousTool(
      "重启 NapCat",
      "确认让 PC 重启当前 NapCat 实例？",
      "重启",
      () => this.runWebguiTool("重启 NapCat", WEBGUI_TOOL_PATHS.napcatRestart, this.selectedNapcatToolBody())
    );
  },

  removeManagedNapcat() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    this.confirmDangerousTool(
      "移除 NapCat",
      "确认从 PC WebGUI 托管列表移除当前 NapCat 实例？",
      "移除",
      () => this.runWebguiTool("移除 NapCat", WEBGUI_TOOL_PATHS.napcatRemove, this.napcatWebguiBody(), { reload: true })
    );
  },

  deleteGatewayConfigOnPc() {
    const path = this.gatewayActionPath("delete");
    if (!path) return this.warn("请先读取 WebGUI 配置。");
    this.confirmDangerousTool(
      "删除 Route",
      "确认删除 PC 上当前 Route 配置目录？这个动作不可只靠 AIUI 撤销。",
      "删除",
      () => this.runWebguiTool("删除 Route", path, {}, { reload: true })
    );
  },

  installCopilotCli() {
    this.confirmDangerousTool(
      "安装 Copilot",
      "确认让 PC 执行 npm 全局安装 GitHub Copilot CLI？",
      "安装",
      () => this.runWebguiTool("安装 Copilot", WEBGUI_TOOL_PATHS.copilotInstall)
    );
  },

  startCopilotLogin() {
    this.confirmDangerousTool(
      "登录 Copilot",
      "确认让 PC 启动 GitHub Copilot 设备码登录流程？",
      "登录",
      () => this.runWebguiTool("登录 Copilot", WEBGUI_TOOL_PATHS.copilotLogin)
    );
  },

  openMarvisOnPc() {
    this.confirmDangerousTool(
      "打开 Marvis",
      "确认让 PC 打开 Marvis 应用或页面？",
      "打开",
      () => this.runWebguiTool("打开 Marvis", WEBGUI_TOOL_PATHS.marvisOpen, {
        appId: this.data.marvisAppId || this.selectedGatewayConfig()?.marvisAppId || ""
      })
    );
  },

  deployAstrbotAdapter() {
    this.confirmDangerousTool(
      "部署 AstrBot",
      "确认让 PC 运行 AstrBot Adapter 部署脚本？",
      "部署",
      () => this.runWebguiTool("部署 AstrBot", WEBGUI_TOOL_PATHS.astrbotDeploy)
    );
  },

  reloadPcWebgui() {
    return this.runWebguiTool("重载 WebGUI", WEBGUI_TOOL_PATHS.reload, {}, { reload: true });
  },

  shutdownManager() {
    this.confirmDangerousTool(
      "关闭 Manager",
      "确认关闭当前 PC Rabi Manager？之后需要在 PC 或服务端重新启动。",
      "关闭",
      () => this.runWebguiTool("关闭 Manager", WEBGUI_TOOL_PATHS.managerShutdown)
    );
  },

  selectedGatewayWebguiId() {
    const gateway = this.selectedGatewayConfig();
    return String(gateway?.id || gateway?.configName || gateway?.name || "").trim();
  },

  gatewayActionPath(action) {
    const id = this.selectedGatewayWebguiId();
    if (!id) return "";
    return `/gateways/${encodeURIComponent(id)}/${action}`;
  },

  async controlGateway(action) {
    const path = this.gatewayActionPath(action);
    if (!path) return this.warn("请先读取 WebGUI 配置。");
    const labels = { start: "启动", stop: "停止", restart: "重启" };
    const label = labels[action] || "控制";
    await this.runAction(`${label} Route`, async () => {
      await postMobileWebgui(this.config(), path, {}, this.data.targetDeviceId);
      const runtimeActionSummary = `${label}命令已发送`;
      this.setData({ runtimeActionSummary });
      this.appendLog(`${runtimeActionSummary}：${this.data.selectedGatewayLabel}`);
      this.say(runtimeActionSummary);
      await this.loadWebguiConfigData();
    });
  },

  startGateway() {
    return this.controlGateway("start");
  },

  stopGateway() {
    return this.controlGateway("stop");
  },

  restartGateway() {
    return this.controlGateway("restart");
  },

  async manualTriggerGateway() {
    const path = this.gatewayActionPath("manual-trigger");
    if (!path) return this.warn("请先读取 WebGUI 配置。");
    await this.runAction("手动触发 Route", async () => {
      await postMobileWebgui(this.config(), path, {
        triggerId: "aiui-manual",
        triggerName: "AIUI 手动触发",
        message: this.data.manualTriggerMessage || "AIUI 手动触发",
        routeKind: "manual_trigger"
      }, this.data.targetDeviceId);
      const runtimeActionSummary = "手动触发已发送";
      this.setData({ runtimeActionSummary });
      this.appendLog(`${runtimeActionSummary}：${this.data.selectedGatewayLabel}`);
      this.say(runtimeActionSummary);
      await this.loadWebguiConfigData();
    });
  },

  async startManager() {
    await this.runAction("启动 Manager", async () => {
      await postMobileWebgui(this.config(), "/manager/start", {}, this.data.targetDeviceId);
      const managerActionSummary = "Manager 启动命令已发送";
      this.setData({ managerActionSummary });
      this.appendLog(managerActionSummary);
      this.say(managerActionSummary);
      await this.loadWebguiConfigData();
    });
  },

  toggleRouteEnabled() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    this.patchGateway({ enabled: gateway.enabled === false });
    this.say(gateway.enabled === false ? "路由已启用。" : "路由已禁用。");
  },

  toggleMessageInputs() {
    const gateway = this.selectedGatewayConfig();
    if (!gateway) return this.warn("请先读取 WebGUI 配置。");
    this.patchGateway({ messageInputsDisabled: gateway.messageInputsDisabled !== true });
    this.say(gateway.messageInputsDisabled === true ? "消息入口已启用。" : "消息入口已禁用。");
  },

  toggleMessageAdapter(event) {
    const adapterId = event.currentTarget.dataset.adapter;
    const gateway = this.selectedGatewayConfig();
    if (!gateway || !adapterId) return;
    const current = messageAdaptersFor(gateway);
    const enabled = !current.includes(adapterId);
    this.setData({
      gateways: setMessageAdapter(this.data.gateways, this.data.gatewayIndex, adapterId, enabled),
      webguiDirty: true
    });
    this.refreshMessagePolicyValues();
  },

  selectAgent(event) {
    const agentAdapter = event.currentTarget.dataset.agent || "codex";
    this.setData({ agentAdapter });
    if (this.selectedGatewayConfig()) {
      this.setData({
        gateways: setAgentAdapter(this.data.gateways, this.data.gatewayIndex, agentAdapter),
        webguiDirty: true
      });
    }
    this.updateDerivedState();
  },

  prevWorker() {
    this.moveIndex("workerIndex", this.data.workers, -1);
  },

  nextWorker() {
    this.moveIndex("workerIndex", this.data.workers, 1);
  },

  prevRoute() {
    this.moveIndex("routeIndex", this.data.routes, -1, () => {
      const route = this.selectedRoute();
      saveSettings({ selectedRouteId: route ? route.id : "" });
      if (this.data.gateways.length) {
        this.setData({ gatewayIndex: findGatewayIndex(this.data.gateways, route ? route.id : "") });
        this.syncAgentFromGateway();
        this.refreshConfigEditorValues();
      }
    });
  },

  nextRoute() {
    this.moveIndex("routeIndex", this.data.routes, 1, () => {
      const route = this.selectedRoute();
      saveSettings({ selectedRouteId: route ? route.id : "" });
      if (this.data.gateways.length) {
        this.setData({ gatewayIndex: findGatewayIndex(this.data.gateways, route ? route.id : "") });
        this.syncAgentFromGateway();
        this.refreshConfigEditorValues();
      }
    });
  },

  prevPanel() {
    this.moveIndex("surfaceIndex", this.data.appSurfaces, -1);
  },

  nextPanel() {
    this.moveIndex("surfaceIndex", this.data.appSurfaces, 1);
  },

  prevScalarField() {
    this.moveIndex("scalarFieldIndex", this.data.scalarFields, -1, () => this.refreshAdvancedFieldValues());
  },

  nextScalarField() {
    this.moveIndex("scalarFieldIndex", this.data.scalarFields, 1, () => this.refreshAdvancedFieldValues());
  },

  prevJsonField() {
    this.moveIndex("jsonFieldIndex", this.data.jsonFields, -1, () => this.refreshAdvancedFieldValues());
  },

  nextJsonField() {
    this.moveIndex("jsonFieldIndex", this.data.jsonFields, 1, () => this.refreshAdvancedFieldValues());
  },

  prevRouteVariable() {
    this.moveIndex("routeVariableIndex", this.data.routeVariableRows, -1, () => this.refreshRouteVariableValues());
  },

  nextRouteVariable() {
    this.moveIndex("routeVariableIndex", this.data.routeVariableRows, 1, () => this.refreshRouteVariableValues());
  },

  prevNotificationRule() {
    this.moveIndex("notificationRuleIndex", this.data.notificationRuleRows, -1, () => this.refreshNotificationRuleValues());
  },

  nextNotificationRule() {
    this.moveIndex("notificationRuleIndex", this.data.notificationRuleRows, 1, () => this.refreshNotificationRuleValues());
  },

  prevNotificationSchedule() {
    this.moveIndex("notificationScheduleIndex", this.data.notificationScheduleRows, -1, () => this.refreshNotificationScheduleValues());
  },

  nextNotificationSchedule() {
    this.moveIndex("notificationScheduleIndex", this.data.notificationScheduleRows, 1, () => this.refreshNotificationScheduleValues());
  },

  prevNotificationTemplate() {
    this.moveIndex("notificationTemplateIndex", this.data.notificationTemplateFields, -1, () => this.refreshNotificationTemplateValues());
  },

  nextNotificationTemplate() {
    this.moveIndex("notificationTemplateIndex", this.data.notificationTemplateFields, 1, () => this.refreshNotificationTemplateValues());
  },

  prevMessagePolicy() {
    this.moveIndex("messagePolicyIndex", this.data.messagePolicyRows, -1, () => this.refreshMessagePolicyValues());
  },

  nextMessagePolicy() {
    this.moveIndex("messagePolicyIndex", this.data.messagePolicyRows, 1, () => this.refreshMessagePolicyValues());
  },

  prevNapcatInstance() {
    this.moveIndex("napcatInstanceIndex", this.data.napcatInstanceRows, -1, () => this.refreshNapcatInstanceValues());
  },

  nextNapcatInstance() {
    this.moveIndex("napcatInstanceIndex", this.data.napcatInstanceRows, 1, () => this.refreshNapcatInstanceValues());
  },

  prevRouteProfile() {
    this.moveIndex("routeProfileIndex", this.data.routeProfileRows, -1, () => this.refreshRouteProfileValues());
  },

  nextRouteProfile() {
    this.moveIndex("routeProfileIndex", this.data.routeProfileRows, 1, () => this.refreshRouteProfileValues());
  },

  refreshAdvancedFieldValues() {
    const gateway = this.selectedGatewayConfig();
    const scalarField = this.selectedScalarField();
    const jsonField = this.selectedJsonField();
    this.setData({
      scalarFieldValue: fieldValueFor(gateway, scalarField),
      jsonFieldValue: jsonValueFor(gateway, jsonField)
    });
    this.updateDerivedState();
  },

  refreshNotificationRuleValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = notificationRuleRowsFor(gateway);
    const index = rows.length ? Math.max(0, Math.min(this.data.notificationRuleIndex, rows.length - 1)) : 0;
    const rule = rows[index] || {};
    this.setData({
      notificationRuleRows: rows,
      notificationRuleIndex: index,
      notificationRuleName: rule.name || "",
      notificationRuleEnabled: rule.enabled !== false,
      notificationRuleRouteKinds: routeKindListFor(rule.routeKinds).join(", "),
      notificationRuleTargetGroupId: rule.targetGroupId || "",
      notificationRuleAllowedSpeakerNames: routeKindListFor(rule.allowedSpeakerNames).join(", "),
      notificationRuleRegex: rule.regex || "",
      notificationRuleTemplate: rule.template || "",
      notificationRuleSummary: rows.length ? `${index + 1}/${rows.length} ${rule.id || ""}` : "未配置规则"
    });
    this.refreshNotificationScheduleValues();
  },

  refreshNotificationScheduleValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = notificationScheduleRowsFor(gateway, this.data.notificationRuleIndex);
    const index = rows.length ? Math.max(0, Math.min(this.data.notificationScheduleIndex, rows.length - 1)) : 0;
    const schedule = rows[index] || {};
    this.setData({
      notificationScheduleRows: rows,
      notificationScheduleIndex: index,
      notificationScheduleName: schedule.name || "",
      notificationScheduleEnabled: schedule.enabled !== false,
      notificationScheduleType: schedule.type || "interval",
      notificationScheduleIntervalSeconds: schedule.intervalSeconds == null ? "900" : String(schedule.intervalSeconds),
      notificationScheduleWindowStartTime: schedule.windowStartTime || "",
      notificationScheduleWindowEndTime: schedule.windowEndTime || "",
      notificationScheduleTimeOfDay: schedule.timeOfDay || "",
      notificationScheduleOnceAt: schedule.onceAt || "",
      notificationScheduleSummary: rows.length ? `${index + 1}/${rows.length} ${schedule.id || ""}` : "未配置计划"
    });
    this.updateDerivedState();
  },

  refreshNotificationTemplateValues() {
    const gateway = this.selectedGatewayConfig();
    const index = Math.max(0, Math.min(this.data.notificationTemplateIndex, this.data.notificationTemplateFields.length - 1));
    const field = notificationTemplateField(index) || {};
    this.setData({
      notificationTemplateIndex: index,
      notificationTemplateLabel: field.label || "模板",
      notificationTemplateValue: notificationTemplateValueFor(gateway, index),
      notificationTemplateSummary: notificationTemplateSummaryFor(gateway, index)
    });
    this.updateDerivedState();
  },

  refreshIntegrationValues() {
    const gateway = this.selectedGatewayConfig() || {};
    const heartbeatSeconds = gateway.heartbeatIntervalSeconds == null ? 900 : gateway.heartbeatIntervalSeconds;
    this.setData({
      integrationWebhookPath: gateway.webhookPath || "",
      integrationFenneNotePath: gateway.fenneNoteWebhookPath || "",
      integrationXiaoaiPath: gateway.xiaoaiWebhookPath || "",
      integrationRabiLinkPath: gateway.rabiLinkWebhookPath || "",
      integrationRabiLinkHost: gateway.rabiLinkWebhookHost || "",
      integrationHeartbeatSeconds: String(heartbeatSeconds),
      integrationHeartbeatMessage: gateway.heartbeatMessage || "",
      integrationWecomBotId: gateway.wecomBotId || "",
      integrationWecomBotSecret: gateway.wecomBotSecret || "",
      integrationWecomWsUrl: gateway.wecomWsUrl || "",
      integrationRemoteAgentDeviceId: gateway.remoteAgentDefaultDeviceId || "",
      integrationRemoteAgentCwd: gateway.remoteAgentDefaultCwd || "",
      integrationRemoteAgentThreadName: gateway.remoteAgentDefaultThreadName || "",
      integrationSummary: `${heartbeatSeconds}s · ${gateway.wecomBotId ? "企微" : "企微未配"} · ${gateway.remoteAgentDefaultDeviceId || "远端未配"}`
    });
    this.updateDerivedState();
  },

  refreshMessagePolicyValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = messageAdapterPolicyRowsFor(gateway);
    const index = rows.length ? Math.max(0, Math.min(this.data.messagePolicyIndex, rows.length - 1)) : 0;
    const row = rows[index] || {};
    this.setData({
      messagePolicyRows: rows,
      messagePolicyIndex: index,
      messagePolicyAdapterId: row.id || "",
      messagePolicyAdapterLabel: row.label || "未选择消息端",
      messagePolicyInputEnabled: row.inputEnabled !== false,
      messagePolicyOutputEnabled: row.outputEnabled !== false,
      messagePolicyOutputs: row.supportedOutputsText || "",
      messagePolicySummary: rows.length ? `${index + 1}/${rows.length} ${row.id || ""}` : "未配置策略"
    });
    this.updateDerivedState();
  },

  refreshNapcatInstanceValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = napcatInstanceRowsFor(gateway);
    const index = rows.length ? Math.max(0, Math.min(this.data.napcatInstanceIndex, rows.length - 1)) : 0;
    const instance = rows[index] || {};
    this.setData({
      napcatInstanceRows: rows,
      napcatInstanceIndex: index,
      napcatInstanceId: instance.id || "",
      napcatInstanceName: instance.name || "",
      napcatInstanceEnabled: instance.enabled !== false,
      napcatGatewayPort: instance.gatewayPort == null ? "" : String(instance.gatewayPort),
      napcatHttpUrl: instance.httpUrl || "",
      napcatWebuiUrl: instance.webuiUrl || "",
      napcatAccessToken: instance.accessToken || "",
      napcatWebuiToken: instance.webuiToken || "",
      napcatLaunchCommand: instance.launchCommand || "",
      napcatWorkingDir: instance.workingDir || "",
      napcatBotUserId: instance.botUserId == null ? "" : String(instance.botUserId),
      napcatBotNickname: instance.botNickname || "",
      napcatInstanceSummary: rows.length ? `${index + 1}/${rows.length} ${instance.enabled === false ? "停用" : "启用"} · ${instance.httpUrl || "-"}` : "未配置 NapCat"
    });
    this.updateDerivedState();
  },

  refreshPipelineValues() {
    const gateway = this.selectedGatewayConfig();
    const pipeline = pipelineConfigFor(gateway);
    this.setData({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      pipelineInputAdapter: pipeline.inputAdapter,
      pipelineOutputAdapter: pipeline.outputAdapter,
      pipelineOutputPipeline: pipeline.outputPipeline,
      pipelinePromptOutputMode: pipeline.promptOutputMode,
      pipelineTtsProvider: pipeline.ttsProvider,
      pipelineTtsVoice: pipeline.ttsVoice,
      pipelineTtsWorkerUrl: pipeline.ttsWorkerUrl,
      pipelineTtsPlay: pipeline.ttsPlay,
      pipelinePreventFeedbackLoop: pipeline.preventFeedbackLoop,
      pipelineReplyToSource: pipeline.replyToSource,
      pipelineSummary: pipelineSummaryFor(gateway)
    });
    this.updateDerivedState();
  },

  refreshRouteProfileValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = routeProfileRowsFor(gateway);
    const index = rows.length ? Math.max(0, Math.min(this.data.routeProfileIndex, rows.length - 1)) : 0;
    const profile = rows[index] || {};
    this.setData({
      routeProfileRows: rows,
      routeProfileIndex: index,
      routeProfileId: profile.id || "",
      routeProfileName: profile.name || "",
      routeProfileEnabled: profile.enabled !== false,
      routeProfileRoleId: profile.agentRoleId || "",
      routeProfileRoleFile: profile.agentRoleFile || "persona.md",
      routeProfileRolesDir: profile.rolesDir || "",
      routeProfileDataDir: profile.dataDir || "",
      routeProfileRecentMessageLimit: profile.recentMessageLimit == null ? "" : String(profile.recentMessageLimit),
      routeProfilePipelinePreset: profile.pipelinePreset || "",
      routeProfilePipelineJson: profile.pipeline ? JSON.stringify(profile.pipeline, null, 2) : "",
      routeProfileVariablesJson: JSON.stringify(profile.routeVariables || {}, null, 2),
      routeProfileSummary: routeProfileSummaryFor(profile, index, rows.length)
    });
    this.updateDerivedState();
  },

  refreshRouteVariableValues() {
    const gateway = this.selectedGatewayConfig();
    const rows = routeVariableRowsFor(gateway);
    const index = rows.length ? Math.max(0, Math.min(this.data.routeVariableIndex, rows.length - 1)) : 0;
    const row = rows[index] || {};
    this.setData({
      routeVariableRows: rows,
      routeVariableIndex: index,
      routeVariableKey: row.key || "",
      routeVariableValue: row.value || "",
      routeVariableSummary: rows.length ? `${index + 1}/${rows.length} ${row.key || ""}` : "未配置变量"
    });
    this.updateDerivedState();
  },

  addRouteVariableDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const result = addRouteVariable(this.data.gateways, this.data.gatewayIndex);
    this.setData({
      gateways: result.gateways,
      routeVariableIndex: result.index,
      webguiDirty: true
    });
    this.refreshRouteVariableValues();
    this.appendLog(`已新增变量：${result.key}`);
  },

  applyRouteVariableDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const current = this.data.routeVariableRows[this.data.routeVariableIndex] || {};
    try {
      this.setData({
        gateways: setRouteVariable(
          this.data.gateways,
          this.data.gatewayIndex,
          current.key || this.data.routeVariableKey,
          this.data.routeVariableKey,
          this.data.routeVariableValue
        ),
        webguiDirty: true
      });
      this.refreshRouteVariableValues();
      this.appendLog(`已应用变量：${this.data.routeVariableKey}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  removeRouteVariableDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const key = this.data.routeVariableRows[this.data.routeVariableIndex]?.key || this.data.routeVariableKey;
    if (!key) return this.warn("当前没有可移除的变量。");
    this.setData({
      gateways: removeRouteVariable(this.data.gateways, this.data.gatewayIndex, key),
      routeVariableIndex: Math.max(0, this.data.routeVariableIndex - 1),
      webguiDirty: true
    });
    this.refreshRouteVariableValues();
    this.appendLog(`已移除变量：${key}`);
  },

  addNotificationRuleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const result = addNotificationRule(this.data.gateways, this.data.gatewayIndex);
    this.setData({
      gateways: result.gateways,
      notificationRuleIndex: result.index,
      webguiDirty: true
    });
    this.refreshNotificationRuleValues();
    this.appendLog(`已新增规则：${result.rule.name}`);
  },

  applyNotificationRuleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    try {
      this.setData({
        gateways: setNotificationRule(this.data.gateways, this.data.gatewayIndex, this.data.notificationRuleIndex, {
          name: this.data.notificationRuleName,
          enabled: this.data.notificationRuleEnabled !== false,
          routeKinds: this.data.notificationRuleRouteKinds,
          targetGroupId: this.data.notificationRuleTargetGroupId,
          allowedSpeakerNames: this.data.notificationRuleAllowedSpeakerNames,
          regex: this.data.notificationRuleRegex,
          template: this.data.notificationRuleTemplate
        }),
        webguiDirty: true
      });
      this.refreshNotificationRuleValues();
      this.appendLog(`已应用规则：${this.data.notificationRuleName || "未命名规则"}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  toggleNotificationRuleEnabled() {
    if (!this.data.notificationRuleRows.length) return this.warn("当前没有可切换的规则。");
    this.setData({ notificationRuleEnabled: !this.data.notificationRuleEnabled });
    this.applyNotificationRuleDraft();
  },

  toggleNotificationRouteKind(event) {
    const kind = event.currentTarget.dataset.kind;
    if (!kind) return;
    const kinds = new Set(routeKindListFor(this.data.notificationRuleRouteKinds));
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    this.setData({ notificationRuleRouteKinds: [...kinds].join(", ") });
    this.updateDerivedState();
  },

  removeNotificationRuleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const rule = this.data.notificationRuleRows[this.data.notificationRuleIndex];
    if (!rule) return this.warn("当前没有可移除的规则。");
    const removeNow = () => {
      this.setData({
        gateways: removeNotificationRule(this.data.gateways, this.data.gatewayIndex, this.data.notificationRuleIndex),
        notificationRuleIndex: Math.max(0, this.data.notificationRuleIndex - 1),
        webguiDirty: true
      });
      this.refreshNotificationRuleValues();
      this.appendLog(`已移除规则：${rule.name || rule.id}`);
    };
    if (wx.showModal) {
      wx.showModal({
        title: "移除规则",
        content: `确认从配置草稿移除 ${rule.name || rule.id}？保存配置后会写回 PC。`,
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) removeNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行移除。");
  },

  addNotificationScheduleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    if (!this.data.notificationRuleRows.length) return this.warn("请先选择或新增通知规则。");
    try {
      const result = addNotificationSchedule(this.data.gateways, this.data.gatewayIndex, this.data.notificationRuleIndex);
      this.setData({
        gateways: result.gateways,
        notificationScheduleIndex: result.index,
        webguiDirty: true
      });
      this.refreshNotificationScheduleValues();
      this.appendLog(`已新增计划：${result.schedule.name}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  applyNotificationScheduleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    if (!this.data.notificationScheduleRows.length) return this.warn("当前没有可应用的通知计划。");
    try {
      this.setData({
        gateways: setNotificationSchedule(this.data.gateways, this.data.gatewayIndex, this.data.notificationRuleIndex, this.data.notificationScheduleIndex, {
          name: this.data.notificationScheduleName,
          enabled: this.data.notificationScheduleEnabled !== false,
          type: this.data.notificationScheduleType,
          intervalSeconds: this.data.notificationScheduleIntervalSeconds,
          windowStartTime: this.data.notificationScheduleWindowStartTime,
          windowEndTime: this.data.notificationScheduleWindowEndTime,
          timeOfDay: this.data.notificationScheduleTimeOfDay,
          onceAt: this.data.notificationScheduleOnceAt
        }),
        webguiDirty: true
      });
      this.refreshNotificationScheduleValues();
      this.appendLog(`已应用计划：${this.data.notificationScheduleName || "未命名计划"}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  toggleNotificationScheduleEnabled() {
    if (!this.data.notificationScheduleRows.length) return this.warn("当前没有可切换的计划。");
    this.setData({ notificationScheduleEnabled: !this.data.notificationScheduleEnabled });
    this.applyNotificationScheduleDraft();
  },

  selectNotificationScheduleType(event) {
    const type = event.currentTarget.dataset.type || "interval";
    this.setData({ notificationScheduleType: type });
    this.updateDerivedState();
  },

  removeNotificationScheduleDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const schedule = this.data.notificationScheduleRows[this.data.notificationScheduleIndex];
    if (!schedule) return this.warn("当前没有可移除的计划。");
    const removeNow = () => {
      this.setData({
        gateways: removeNotificationSchedule(this.data.gateways, this.data.gatewayIndex, this.data.notificationRuleIndex, this.data.notificationScheduleIndex),
        notificationScheduleIndex: Math.max(0, this.data.notificationScheduleIndex - 1),
        webguiDirty: true
      });
      this.refreshNotificationScheduleValues();
      this.appendLog(`已移除计划：${schedule.name || schedule.id}`);
    };
    if (wx.showModal) {
      wx.showModal({
        title: "移除计划",
        content: `确认从规则草稿移除 ${schedule.name || schedule.id}？保存配置后会写回 PC。`,
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) removeNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行移除。");
  },

  applyNotificationTemplateDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    try {
      this.setData({
        gateways: setNotificationTemplate(this.data.gateways, this.data.gatewayIndex, this.data.notificationTemplateIndex, this.data.notificationTemplateValue),
        webguiDirty: true
      });
      this.refreshNotificationTemplateValues();
      this.appendLog(`已应用模板：${this.data.notificationTemplateLabel}`);
      this.say("通知模板已应用，保存配置后写回 PC。");
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  clearNotificationTemplateDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const label = this.data.notificationTemplateLabel || "模板";
    const clearNow = () => {
      try {
        this.setData({
          gateways: clearNotificationTemplate(this.data.gateways, this.data.gatewayIndex, this.data.notificationTemplateIndex),
          webguiDirty: true
        });
        this.refreshNotificationTemplateValues();
        this.appendLog(`已清空模板：${label}`);
      } catch (error) {
        this.warn(error.message || String(error));
      }
    };
    if (wx.showModal) {
      wx.showModal({
        title: "清空模板",
        content: `确认清空 ${label} 模板？保存配置后会写回 PC。`,
        confirmText: "清空",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) clearNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行清空。");
  },

  applyIntegrationDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const heartbeatSeconds = Number(this.data.integrationHeartbeatSeconds || 0);
    if (!Number.isInteger(heartbeatSeconds) || heartbeatSeconds <= 0) {
      return this.warn("心跳间隔必须是正整数秒。");
    }
    this.setData({
      gateways: patchSelectedGateway(this.data.gateways, this.data.gatewayIndex, {
        webhookPath: this.data.integrationWebhookPath,
        fenneNoteWebhookPath: this.data.integrationFenneNotePath,
        xiaoaiWebhookPath: this.data.integrationXiaoaiPath,
        rabiLinkWebhookPath: this.data.integrationRabiLinkPath,
        rabiLinkWebhookHost: this.data.integrationRabiLinkHost,
        heartbeatIntervalSeconds: heartbeatSeconds,
        heartbeatMessage: this.data.integrationHeartbeatMessage,
        wecomBotId: this.data.integrationWecomBotId,
        wecomBotSecret: this.data.integrationWecomBotSecret,
        wecomWsUrl: this.data.integrationWecomWsUrl,
        remoteAgentDefaultDeviceId: this.data.integrationRemoteAgentDeviceId,
        remoteAgentDefaultCwd: this.data.integrationRemoteAgentCwd,
        remoteAgentDefaultThreadName: this.data.integrationRemoteAgentThreadName
      }),
      webguiDirty: true
    });
    this.refreshIntegrationValues();
    this.appendLog("已应用消息端集成配置。");
    this.say("集成配置已应用，保存配置后写回 PC。");
  },

  applyMessagePolicyDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    if (!this.data.messagePolicyAdapterId) return this.warn("当前没有可应用的消息端策略。");
    try {
      this.setData({
        gateways: setMessageAdapterPolicy(this.data.gateways, this.data.gatewayIndex, this.data.messagePolicyAdapterId, {
          inputEnabled: this.data.messagePolicyInputEnabled !== false,
          outputEnabled: this.data.messagePolicyOutputEnabled !== false,
          supportedOutputs: this.data.messagePolicyOutputs
        }),
        webguiDirty: true
      });
      this.refreshMessagePolicyValues();
      this.appendLog(`已应用消息端策略：${this.data.messagePolicyAdapterLabel}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  toggleMessagePolicyInput() {
    if (!this.data.messagePolicyAdapterId) return this.warn("当前没有可切换的消息端策略。");
    this.setData({ messagePolicyInputEnabled: !this.data.messagePolicyInputEnabled });
    this.applyMessagePolicyDraft();
  },

  toggleMessagePolicyOutput() {
    if (!this.data.messagePolicyAdapterId) return this.warn("当前没有可切换的消息端策略。");
    this.setData({ messagePolicyOutputEnabled: !this.data.messagePolicyOutputEnabled });
    this.applyMessagePolicyDraft();
  },

  toggleMessagePolicyPayload(event) {
    const payload = event.currentTarget.dataset.payload;
    if (!this.data.messagePolicyAdapterId || !payload) return;
    try {
      this.setData({
        gateways: toggleMessageAdapterPayload(this.data.gateways, this.data.gatewayIndex, this.data.messagePolicyAdapterId, payload),
        webguiDirty: true
      });
      this.refreshMessagePolicyValues();
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  addNapcatInstanceDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    try {
      const result = addNapcatInstance(this.data.gateways, this.data.gatewayIndex);
      this.setData({
        gateways: result.gateways,
        napcatInstanceIndex: result.index,
        webguiDirty: true
      });
      this.refreshNapcatInstanceValues();
      this.appendLog(`已新增 NapCat：${result.instance.name || result.instance.id}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  applyNapcatInstanceDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    if (!this.data.napcatInstanceRows.length) return this.warn("当前没有可应用的 NapCat 实例。");
    try {
      this.setData({
        gateways: setNapcatInstance(this.data.gateways, this.data.gatewayIndex, this.data.napcatInstanceIndex, {
          id: this.data.napcatInstanceId,
          name: this.data.napcatInstanceName,
          enabled: this.data.napcatInstanceEnabled !== false,
          gatewayPort: this.data.napcatGatewayPort,
          httpUrl: this.data.napcatHttpUrl,
          webuiUrl: this.data.napcatWebuiUrl,
          accessToken: this.data.napcatAccessToken,
          webuiToken: this.data.napcatWebuiToken,
          launchCommand: this.data.napcatLaunchCommand,
          workingDir: this.data.napcatWorkingDir,
          botUserId: this.data.napcatBotUserId,
          botNickname: this.data.napcatBotNickname
        }),
        webguiDirty: true
      });
      this.refreshNapcatInstanceValues();
      this.appendLog(`已应用 NapCat：${this.data.napcatInstanceName || this.data.napcatInstanceId}`);
      this.say("NapCat 实例已应用，保存配置后写回 PC。");
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  toggleNapcatInstanceEnabled() {
    if (!this.data.napcatInstanceRows.length) return this.warn("当前没有可切换的 NapCat 实例。");
    this.setData({ napcatInstanceEnabled: !this.data.napcatInstanceEnabled });
    this.applyNapcatInstanceDraft();
  },

  removeNapcatInstanceDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const instance = this.data.napcatInstanceRows[this.data.napcatInstanceIndex];
    if (!instance) return this.warn("当前没有可移除的 NapCat 实例。");
    const removeNow = () => {
      this.setData({
        gateways: removeNapcatInstance(this.data.gateways, this.data.gatewayIndex, this.data.napcatInstanceIndex),
        napcatInstanceIndex: Math.max(0, this.data.napcatInstanceIndex - 1),
        webguiDirty: true
      });
      this.refreshNapcatInstanceValues();
      this.appendLog(`已移除 NapCat：${instance.name || instance.id}`);
    };
    if (wx.showModal) {
      wx.showModal({
        title: "移除 NapCat",
        content: `确认从配置草稿移除 ${instance.name || instance.id}？保存配置后会写回 PC。`,
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) removeNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行移除。");
  },

  selectPipelineInputAdapter(event) {
    const inputAdapter = event.currentTarget.dataset.adapter || "";
    this.setData({ pipelineInputAdapter });
    this.updateDerivedState();
  },

  selectPipelineOutputAdapter(event) {
    const outputAdapter = event.currentTarget.dataset.adapter || "";
    this.setData({ pipelineOutputAdapter: outputAdapter });
    this.updateDerivedState();
  },

  selectPipelinePromptMode(event) {
    const promptOutputMode = event.currentTarget.dataset.mode || "";
    this.setData({ pipelinePromptOutputMode: promptOutputMode });
    this.updateDerivedState();
  },

  cyclePipelineOption(field, options, delta) {
    if (!Array.isArray(options) || options.length === 0) return;
    const current = String(this.data[field] || "");
    const currentIndex = options.findIndex((item) => item.id === current);
    const baseIndex = currentIndex >= 0 ? currentIndex : (delta > 0 ? -1 : 0);
    const next = options[(baseIndex + delta + options.length) % options.length];
    this.setData({ [field]: next.id });
    this.updateDerivedState();
  },

  nextPipelineOutputAdapter() {
    this.cyclePipelineOption("pipelineOutputAdapter", this.data.pipelineOutputAdapters, 1);
  },

  prevPipelineOutputAdapter() {
    this.cyclePipelineOption("pipelineOutputAdapter", this.data.pipelineOutputAdapters, -1);
  },

  nextPipelinePromptMode() {
    this.cyclePipelineOption("pipelinePromptOutputMode", this.data.promptOutputModes, 1);
  },

  prevPipelinePromptMode() {
    this.cyclePipelineOption("pipelinePromptOutputMode", this.data.promptOutputModes, -1);
  },

  applyPipelineDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    try {
      this.setData({
        gateways: setPipelineConfig(this.data.gateways, this.data.gatewayIndex, {
          id: this.data.pipelineId,
          name: this.data.pipelineName,
          inputAdapter: this.data.pipelineInputAdapter,
          outputAdapter: this.data.pipelineOutputAdapter,
          outputPipeline: this.data.pipelineOutputPipeline,
          promptOutputMode: this.data.pipelinePromptOutputMode,
          ttsProvider: this.data.pipelineTtsProvider,
          ttsVoice: this.data.pipelineTtsVoice,
          ttsWorkerUrl: this.data.pipelineTtsWorkerUrl,
          ttsPlay: this.data.pipelineTtsPlay,
          preventFeedbackLoop: this.data.pipelinePreventFeedbackLoop,
          replyToSource: this.data.pipelineReplyToSource
        }),
        webguiDirty: true
      });
      this.refreshPipelineValues();
      this.appendLog(`已应用管道：${this.data.pipelineId || this.data.pipelineName || "pipeline"}`);
      this.say("管道配置已应用，保存配置后写回 PC。");
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  togglePipelineTtsPlay() {
    this.setData({ pipelineTtsPlay: !this.data.pipelineTtsPlay });
    this.applyPipelineDraft();
  },

  togglePipelinePreventFeedbackLoop() {
    this.setData({ pipelinePreventFeedbackLoop: !this.data.pipelinePreventFeedbackLoop });
    this.applyPipelineDraft();
  },

  togglePipelineReplyToSource() {
    this.setData({ pipelineReplyToSource: !this.data.pipelineReplyToSource });
    this.applyPipelineDraft();
  },

  clearPipelineDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const clearNow = () => {
      this.setData({
        gateways: clearPipelineConfig(this.data.gateways, this.data.gatewayIndex),
        webguiDirty: true
      });
      this.refreshPipelineValues();
      this.appendLog("已清空 pipeline 覆盖。");
      this.say("管道覆盖已清空，保存配置后写回 PC。");
    };
    if (wx.showModal) {
      wx.showModal({
        title: "清空管道",
        content: "确认清空当前 Route 的 pipeline 覆盖？保存配置后会写回 PC。",
        confirmText: "清空",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) clearNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行清空。");
  },

  addRouteProfileDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    try {
      const result = addRouteProfile(this.data.gateways, this.data.gatewayIndex);
      this.setData({
        gateways: result.gateways,
        routeProfileIndex: result.index,
        webguiDirty: true
      });
      this.refreshRouteProfileValues();
      this.appendLog(`已新增 Profile：${result.profile.name || result.profile.id}`);
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  applyRouteProfileDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    if (!this.data.routeProfileRows.length) return this.warn("当前没有可应用的 Route Profile。");
    try {
      this.setData({
        gateways: setRouteProfile(this.data.gateways, this.data.gatewayIndex, this.data.routeProfileIndex, {
          id: this.data.routeProfileId,
          name: this.data.routeProfileName,
          enabled: this.data.routeProfileEnabled !== false,
          agentRoleId: this.data.routeProfileRoleId,
          agentRoleFile: this.data.routeProfileRoleFile,
          rolesDir: this.data.routeProfileRolesDir,
          dataDir: this.data.routeProfileDataDir,
          recentMessageLimit: this.data.routeProfileRecentMessageLimit,
          pipelinePreset: this.data.routeProfilePipelinePreset,
          pipeline: this.data.routeProfilePipelineJson,
          routeVariables: this.data.routeProfileVariablesJson
        }),
        webguiDirty: true
      });
      this.refreshRouteProfileValues();
      this.appendLog(`已应用 Profile：${this.data.routeProfileName || this.data.routeProfileId}`);
      this.say("Route Profile 已应用，保存配置后写回 PC。");
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  toggleRouteProfileEnabled() {
    if (!this.data.routeProfileRows.length) return this.warn("当前没有可切换的 Route Profile。");
    this.setData({ routeProfileEnabled: !this.data.routeProfileEnabled });
    this.applyRouteProfileDraft();
  },

  removeRouteProfileDraft() {
    if (!this.selectedGatewayConfig()) return this.warn("请先读取 WebGUI 配置。");
    const profile = this.data.routeProfileRows[this.data.routeProfileIndex];
    if (!profile) return this.warn("当前没有可移除的 Route Profile。");
    const removeNow = () => {
      this.setData({
        gateways: removeRouteProfile(this.data.gateways, this.data.gatewayIndex, this.data.routeProfileIndex),
        routeProfileIndex: Math.max(0, this.data.routeProfileIndex - 1),
        webguiDirty: true
      });
      this.refreshRouteProfileValues();
      this.appendLog(`已移除 Profile：${profile.name || profile.id}`);
    };
    if (wx.showModal) {
      wx.showModal({
        title: "移除 Profile",
        content: `确认从配置草稿移除 ${profile.name || profile.id}？保存配置后会写回 PC。`,
        confirmText: "移除",
        cancelText: "取消",
        success: (res) => {
          if (res && res.confirm) removeNow();
        }
      });
      return;
    }
    this.warn("当前 AIUI 环境没有确认弹窗，未执行移除。");
  },

  applyScalarField() {
    const field = this.selectedScalarField();
    if (!this.selectedGatewayConfig() || !field) return this.warn("请先读取 WebGUI 配置。");
    try {
      this.setData({
        gateways: setScalarField(this.data.gateways, this.data.gatewayIndex, field, this.data.scalarFieldValue),
        webguiDirty: true
      });
      this.appendLog(`已修改字段：${field.label}`);
      this.updateDerivedState();
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  applyJsonField() {
    const field = this.selectedJsonField();
    if (!this.selectedGatewayConfig() || !field) return this.warn("请先读取 WebGUI 配置。");
    try {
      this.setData({
        gateways: setJsonField(this.data.gateways, this.data.gatewayIndex, field, this.data.jsonFieldValue),
        webguiDirty: true
      });
      this.appendLog(`已修改 JSON：${field.label}`);
      this.updateDerivedState();
    } catch (error) {
      this.warn(error.message || String(error));
    }
  },

  prevCwd() {
    this.moveIndex("cwdIndex", this.data.cwdOptions, -1);
  },

  nextCwd() {
    this.moveIndex("cwdIndex", this.data.cwdOptions, 1);
  },

  prevThread() {
    this.moveIndex("threadIndex", this.data.threadOptions, -1);
  },

  nextThread() {
    this.moveIndex("threadIndex", this.data.threadOptions, 1);
  },

  moveIndex(field, list, delta, afterMove) {
    if (!Array.isArray(list) || list.length === 0) {
      return;
    }
    const next = (this.data[field] + delta + list.length) % list.length;
    this.setData({ [field]: next });
    if (afterMove) {
      afterMove();
    }
    this.updateDerivedState();
  },

  toggleModePrimaryAction() {
    if (this.data.isTranscriptionMode) this.toggleTranscription();
  },

  retryModeAction() {
    if (this.data.isTranscriptionMode) {
      this.agentShouldPoll = true;
      this.setData({ agentStatus: "重新连接队列", transcriptionSyncLabel: "连接中" });
      void this.connectTranscriptionRelay();
      void this.flushTranscriptQueue();
      return;
    }
    this.retryConfigurationIntent();
  },

  commitModeFrame(nextData, afterCommit) {
    this.modeFrameGeneration = Number(this.modeFrameGeneration || 0) + 1;
    const generation = this.modeFrameGeneration;
    if (this.modeFrameTimer) clearTimeout(this.modeFrameTimer);
    this.setData(nextData);
    this.modeFrameTimer = setTimeout(() => {
      this.modeFrameTimer = null;
      if (this.destroyed || generation !== this.modeFrameGeneration) return;
      if (typeof afterCommit === "function") afterCommit();
    }, 48);
  },

  toggleTranscription() {
    if (this.data.transcriptionDesired) {
      this.pauseTranscription();
      return;
    }
    this.resumeTranscription();
  },

  pauseTranscription() {
    this.transcriptionFailureCount = 0;
    this.clearTranscriptionRestart();
    this.stopTranscriptionClock();
    this.stopRecognition(true);
    this.setData({
      transcriptionDesired: false,
      transcriptionListening: false,
      transcriptionState: "已暂停",
      agentStatus: "聆听已暂停，消息队列仍在线"
    });
  },

  resumeTranscription(reason = "ui") {
    if (!this.data.isTranscriptionMode) {
      this.switchToTranscription("voice");
      return;
    }
    const source = typeof reason === "string" ? reason : "ui";
    if (this.asrHostPolicy?.requiresInteractiveWakeup && source !== "wakeup") {
      this.setData({
        transcriptionDesired: false,
        transcriptionListening: false,
        transcriptionState: "浏览器调试：点麦克风开始"
      });
      this.appendLog("Craft 调试需先用麦克风控件模拟唤醒，未直接启动 ASR。");
      return;
    }
    this.transcriptionFailureCount = 0;
    const startedAt = Date.now();
    this.setData({
      transcriptionDesired: true,
      transcriptionStartedAt: startedAt,
      transcriptionElapsed: "00:00",
      transcriptionState: "准备聆听",
      agentStatus: "准备聆听"
    });
    this.startTranscriptionClock();
    this.scheduleTranscriptionRestart(0);
    void this.flushTranscriptQueue();
  },

  switchToTranscription(reason = "ui") {
    const source = typeof reason === "string" ? reason : "ui";
    const waitsForInteractiveWakeup = this.asrHostPolicy?.requiresInteractiveWakeup === true;
    this.cancelSpeech();
    this.stopRecognition(false);
    this.transcriptionFailureCount = 0;
    const startedAt = Date.now();
    this.commitModeFrame({
      mode: APP_MODES.TRANSCRIPTION,
      isTranscriptionMode: true,
      isConfigurationMode: false,
      transcriptionDesired: !waitsForInteractiveWakeup,
      transcriptionListening: false,
      transcriptionStartedAt: startedAt,
      transcriptionElapsed: "00:00",
      transcriptionState: waitsForInteractiveWakeup ? "浏览器调试：点麦克风开始" : "准备聆听",
      agentStatus: "可以直接说话"
    }, () => {
      this.appendLog(`已切到连接对话：${source}。`);
      if (waitsForInteractiveWakeup) {
        this.appendLog("Craft 调试已切换模式，等待麦克风控件模拟唤醒。");
      } else {
        this.startTranscriptionClock();
        this.scheduleTranscriptionRestart(0);
      }
      void this.connectTranscriptionRelay();
    });
  },

  selectTranscriptionMode() {
    if (!this.data.isTranscriptionMode) this.switchToTranscription("rail");
  },

  selectConfigurationMode() {
    if (!this.data.isConfigurationMode) this.requestConfigurationAssistant("rail");
  },

  requestConfigurationAssistant(reason = "ui") {
    const source = typeof reason === "string" ? reason : "ui";
    if (this.data.isConfigurationMode) return;
    this.clearTranscriptionRestart();
    this.stopTranscriptionClock();
    this.suspendAgentPolling();
    this.cancelSpeech();
    this.stopRecognition(true);
    this.commitModeFrame({
      mode: APP_MODES.CONFIGURATION,
      isTranscriptionMode: false,
      isConfigurationMode: true,
      transcriptionDesired: false,
      transcriptionListening: false,
      transcriptionState: "配置助手",
      assistantStatus: "等待原生 Agent",
      assistantUserText: "请向眼镜助手提出配置需求",
      assistantReplyText: "原生 Agent 会理解需求，再调用这里的配置接口。"
    }, () => {
      this.appendLog(`已切到配置助手：${source}。`);
    });
  },

  suspendAgentPolling() {
    this.agentPollGeneration = Number(this.agentPollGeneration || 0) + 1;
    if (this.agentPollTimer) {
      clearTimeout(this.agentPollTimer);
      this.agentPollTimer = null;
    }
    if (this.data.agentPolling) this.setData({ agentPolling: false });
  },

  stopAgentPolling() {
    this.agentShouldPoll = false;
    this.suspendAgentPolling();
  },

  scheduleAgentPoll(delayMs = 80) {
    if (!this.agentShouldPoll || !this.data.token) return;
    if (this.destroyed || !this.pageVisible || !this.data.isTranscriptionMode) return;
    if (this.agentPollTimer) return;
    const generation = Number(this.agentPollGeneration || 0);
    this.agentPollTimer = setTimeout(() => {
      this.agentPollTimer = null;
      if (generation !== this.agentPollGeneration) return;
      void this.pollAgentMessages(generation);
    }, Math.max(0, Number(delayMs || 0)));
  },

  async pollAgentMessages(generation = this.agentPollGeneration) {
    if (!this.agentShouldPoll || generation !== this.agentPollGeneration) return;
    if (this.destroyed || !this.pageVisible || !this.data.isTranscriptionMode) return;
    this.setData({
      agentPolling: true,
      agentStatus: this.speechActive
        ? "正在播报"
        : (this.data.transcriptionListening ? "正在聆听" : "消息队列在线")
    });
    try {
      const batch = await getRabiLinkMessageStream(this.config(), this.data.agentCursor, 25000);
      if (generation !== this.agentPollGeneration || !this.agentShouldPoll) return;
      const nextCursor = String(batch.nextCursor || this.data.agentCursor || "").trim();
      const messages = Array.isArray(batch.messages) ? batch.messages : [];
      this.setData({ agentCursor: nextCursor, connected: true });
      saveSettings({ agentCursor: nextCursor, agentCursorTokenKey: maskToken(this.data.token) });
      messages.forEach((message) => {
        const messageId = String(message?.id || message?.taskMessageId || "").trim();
        if (messageId && this.agentSeenMessageIds.has(messageId)) return;
        if (messageId) this.agentSeenMessageIds.add(messageId);
        const reply = String(message?.text || "").trim();
        if (reply) {
          this.say(reply, {
            allowInTranscription: true,
            agentStatus: message?.proactive === true ? "主动消息" : "Agent 消息"
          });
        }
      });
      if (this.agentSeenMessageIds.size > 500) this.agentSeenMessageIds.clear();
      this.setData({
        agentPolling: false,
        agentStatus: this.speechActive || this.speechQueue.length
          ? "正在播报"
          : (this.data.transcriptionListening ? "正在聆听" : "消息队列在线"),
        transcriptionSyncLabel: "主动队列在线"
      });
      this.scheduleAgentPoll(80);
    } catch (error) {
      if (generation !== this.agentPollGeneration || !this.agentShouldPoll) return;
      if (isRabiLinkPollTimeout(error)) {
        this.setData({ agentPolling: false, agentStatus: "消息队列在线", transcriptionSyncLabel: "主动队列在线" });
        this.scheduleAgentPoll(AGENT_POLL_RETRY_DELAY_MS);
        return;
      }
      const message = error?.message || String(error);
      this.agentShouldPoll = false;
      this.setData({
        connected: false,
        agentPolling: false,
        agentStatus: "回复连接中断",
        agentReplyText: message,
        transcriptionSyncLabel: "待重试"
      });
      this.appendLog(`连接对话消息流中断：${message}`);
    }
  },

  startTranscriptionClock() {
    this.stopTranscriptionClock();
    if (!this.data.isTranscriptionMode || !this.data.transcriptionDesired || !this.pageVisible) return;
    const update = () => {
      this.setData({ transcriptionElapsed: durationLabel(this.data.transcriptionStartedAt) });
    };
    update();
    this.transcriptionElapsedTimer = setInterval(update, TRANSCRIPTION_CLOCK_REFRESH_MS);
  },

  stopTranscriptionClock() {
    if (this.transcriptionElapsedTimer) {
      clearInterval(this.transcriptionElapsedTimer);
      this.transcriptionElapsedTimer = null;
    }
  },

  clearTranscriptionRestart() {
    if (this.transcriptionRestartTimer) {
      clearTimeout(this.transcriptionRestartTimer);
      this.transcriptionRestartTimer = null;
    }
  },

  transcriptionRetryDelay() {
    const failures = Math.max(1, Number(this.transcriptionFailureCount || 1));
    const exponent = Math.min(4, failures - 1);
    return Math.min(TRANSCRIPTION_MAX_RETRY_DELAY_MS, TRANSCRIPTION_ERROR_RETRY_MS * (2 ** exponent));
  },

  scheduleTranscriptionRestart(delayMs = TRANSCRIPTION_RESTART_DELAY_MS) {
    this.clearTranscriptionRestart();
    if (!this.pageReady || !this.pageVisible || this.destroyed) return;
    if (!this.data.isTranscriptionMode || !this.data.transcriptionDesired || this.recognition || this.speechActive) return;
    this.transcriptionRestartTimer = setTimeout(() => {
      this.transcriptionRestartTimer = null;
      this.startTranscription();
    }, Math.max(0, Number(delayMs || 0)));
  },

  startTranscription() {
    if (!this.pageReady || !this.pageVisible || this.destroyed) return;
    if (!this.data.isTranscriptionMode || !this.data.transcriptionDesired || this.recognition || this.speechActive) return;
    if (typeof SpeechRecognition === "undefined") {
      this.setData({
        transcriptionDesired: false,
        transcriptionListening: false,
        transcriptionState: "当前运行环境不支持 ASR"
      });
      this.appendLog("当前 AIUI 运行环境没有 SpeechRecognition。");
      return;
    }
    const recognition = new SpeechRecognition();
    const roundStartedAt = Date.now();
    let roundHadResult = false;
    let roundFinished = false;
    const finishRound = (outcome) => {
      if (roundFinished) return;
      roundFinished = true;
      const ownedRecognition = this.recognition === recognition;
      if (ownedRecognition) {
        this.recognition = null;
        this.recognitionPurpose = "";
      }
      this.setData({ transcriptionListening: false });
      if (!ownedRecognition || this.destroyed || !this.pageVisible) return;
      if (!this.data.isTranscriptionMode || !this.data.transcriptionDesired || outcome === "fatal") return;

      const elapsedMs = Date.now() - roundStartedAt;
      const rapidEmptyRound = outcome === "end"
        && !roundHadResult
        && elapsedMs < TRANSCRIPTION_RAPID_END_THRESHOLD_MS;
      const failedRound = outcome === "error" || outcome === "start-error" || rapidEmptyRound;
      if (failedRound) {
        this.transcriptionFailureCount = Number(this.transcriptionFailureCount || 0) + 1;
        if (this.transcriptionFailureCount >= TRANSCRIPTION_MAX_CONSECUTIVE_FAILURES) {
          this.setData({
            transcriptionDesired: false,
            transcriptionState: "ASR 暂不可用，点击继续"
          });
          this.appendLog("ASR 连续快速失败，已暂停自动重试。");
          return;
        }
        const retryDelay = this.transcriptionRetryDelay();
        this.setData({ transcriptionState: `ASR 暂不可用，${Math.ceil(retryDelay / 1000)} 秒后重试` });
        this.scheduleTranscriptionRestart(retryDelay);
        return;
      }

      this.transcriptionFailureCount = 0;
      this.setData({ transcriptionState: "准备继续聆听" });
      this.scheduleTranscriptionRestart(TRANSCRIPTION_RESTART_DELAY_MS);
    };
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      roundHadResult = true;
      this.transcriptionFailureCount = 0;
      const text = extractSpeechText(event);
      if (text) this.handleTranscriptionResult(text);
    };
    recognition.onerror = (event) => {
      const errorCode = String(event?.error || "unknown");
      const fatal = ["not-allowed", "service-not-allowed", "audio-capture"].includes(errorCode);
      this.setData({
        transcriptionListening: false,
        transcriptionDesired: fatal ? false : this.data.transcriptionDesired,
        transcriptionState: fatal ? "麦克风不可用" : "识别中断，准备重试"
      });
      this.appendLog(`转写识别失败：${errorCode}`);
      finishRound(fatal ? "fatal" : "error");
    };
    recognition.onend = () => {
      finishRound("end");
    };
    this.recognition = recognition;
    this.recognitionPurpose = "transcription";
    this.setData({
      transcriptionListening: true,
      transcriptionState: "正在聆听",
      agentStatus: "正在聆听"
    });
    try {
      recognition.start();
    } catch (error) {
      this.appendLog(`转写启动失败：${error?.message || error}`);
      finishRound("start-error");
    }
  },

  handleTranscriptionResult(text) {
    const value = String(text || "").trim();
    if (!value) return;
    const parsed = parseVoiceCommand(value);
    if (parsed.command === VOICE_COMMANDS.SWITCH_TO_CONFIGURATION) {
      this.setData({ transcriptionText: value });
      this.requestConfigurationAssistant("voice");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.PAUSE_TRANSCRIPTION) {
      this.setData({ transcriptionText: value });
      this.pauseTranscription();
      return;
    }
    if (parsed.command === VOICE_COMMANDS.RETRY_TRANSCRIPTS) {
      this.setData({ transcriptionText: value });
      void this.flushTranscriptQueue();
      return;
    }
    const sequence = this.data.transcriptionSequence + 1;
    const segment = {
      id: transcriptSegmentId(sequence),
      text: value,
      sessionId: this.data.transcriptionSessionId,
      sequence,
      createdAt: Date.now()
    };
    this.transcriptQueue = saveTranscriptQueue([...this.transcriptQueue, segment]);
    this.setData({
      transcriptionText: value,
      transcriptionSequence: sequence,
      transcriptionPendingCount: this.transcriptQueue.length,
      transcriptionSyncLabel: this.data.token ? "发送给 Agent" : "等待智能体连接",
      agentStatus: this.data.token ? "正在发送" : "等待智能体连接"
    });
    this.appendLog(`ASR ${sequence}：${value}`);
    void this.flushTranscriptQueue();
  },

  async flushTranscriptQueue() {
    if (this.flushingTranscripts || !this.transcriptQueue.length) {
      if (!this.transcriptQueue.length) {
        this.setData({
          transcriptionPendingCount: 0,
          transcriptionSyncLabel: this.data.token ? "主动队列在线" : "等待智能体连接"
        });
      }
      return;
    }
    if (!this.data.token) {
      this.setData({
        transcriptionPendingCount: this.transcriptQueue.length,
        transcriptionSyncLabel: "等待智能体连接"
      });
      return;
    }
    this.flushingTranscripts = true;
    try {
      while (this.transcriptQueue.length && !this.destroyed) {
        const segment = this.transcriptQueue[0];
        this.setData({
          transcriptionPendingCount: this.transcriptQueue.length,
          transcriptionSyncLabel: "发送给 Agent",
          agentStatus: "正在发送"
        });
        const response = await publishRabiLinkVoiceInput(this.config(), segment);
        if (!this.data.agentCursor) {
          const cursor = String(response.nextCursor || response.cursor || "").trim();
          if (cursor) {
            this.setData({ agentCursor: cursor });
            saveSettings({ agentCursor: cursor, agentCursorTokenKey: maskToken(this.data.token) });
          }
        }
        this.agentShouldPoll = true;
        if (this.data.isTranscriptionMode) this.scheduleAgentPoll(0);
        if (this.transcriptQueue[0]?.id === segment.id) {
          this.transcriptQueue = saveTranscriptQueue(this.transcriptQueue.slice(1));
        }
        this.setData({
          connected: true,
          transcriptionSyncedCount: this.data.transcriptionSyncedCount + 1,
          transcriptionPendingCount: this.transcriptQueue.length,
          transcriptionSyncLabel: this.transcriptQueue.length ? "继续发送" : "主动队列在线"
        });
      }
    } catch (error) {
      this.setData({
        connected: false,
        transcriptionPendingCount: this.transcriptQueue.length,
        transcriptionSyncLabel: "待重试"
      });
      this.appendLog(`Agent 请求发送失败：${error?.message || error}`);
    } finally {
      this.flushingTranscripts = false;
    }
  },

  stopRecognition(graceful = false) {
    const recognition = this.recognition;
    this.recognition = null;
    this.recognitionPurpose = "";
    if (recognition) {
      try {
        if (graceful && typeof recognition.stop === "function") recognition.stop();
        else if (typeof recognition.abort === "function") recognition.abort();
      } catch (error) {
        console.warn("Speech recognition stop failed:", error);
      }
    }
    this.setData({ transcriptionListening: false });
  },

  retryConfigurationIntent() {
    const value = String(this.data.assistantLastRequest || "").trim();
    if (!value) {
      this.setData({
        assistantStatus: "等待原生 Agent",
        assistantReplyText: "请向眼镜助手提出配置需求；它会带着明确指令重新调用配置助手。"
      });
      return false;
    }
    return this.executeConfigurationIntent(value, "retry");
  },

  executeConfigurationIntent(text, source = "native-agent") {
    const value = String(text || "").trim();
    if (!value) return false;
    this.appendLog(`配置指令（${source}）：${value}`);
    this.setData({
      assistantUserText: value,
      assistantLastRequest: value,
      assistantStatus: "正在处理",
      assistantCanRetry: false
    });
    const parsed = parseConfigurationIntent(value);
    if (parsed.command === VOICE_COMMANDS.SWITCH_TO_CONFIGURATION) return this.requestConfigurationAssistant("voice");
    if (parsed.command === VOICE_COMMANDS.SWITCH_TO_TRANSCRIPTION) return this.switchToTranscription("voice");
    if (parsed.command === VOICE_COMMANDS.PAUSE_TRANSCRIPTION) return this.pauseTranscription();
    if (parsed.command === VOICE_COMMANDS.RESUME_TRANSCRIPTION) return this.resumeTranscription();
    if (parsed.command === VOICE_COMMANDS.RETRY_TRANSCRIPTS) return this.flushTranscriptQueue();
    if (parsed.command === VOICE_COMMANDS.CONNECT_RELAY) return this.connectRelay();
    if (parsed.command === VOICE_COMMANDS.BIND_WORKER) return this.bindSelectedWorker();
    if (parsed.command === VOICE_COMMANDS.READ_ROUTES) return this.refreshRoutes();
    if (parsed.command === VOICE_COMMANDS.READ_AGENT) return this.loadAgentOptions();
    if (parsed.command === VOICE_COMMANDS.SAVE_BINDING) return this.saveAgentBinding();
    if (parsed.command === VOICE_COMMANDS.LOAD_CONFIG) return this.loadWebguiConfig();
    if (parsed.command === VOICE_COMMANDS.SAVE_CONFIG) return this.saveWebguiConfig();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_ROUTE) return this.toggleRouteEnabled();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_MESSAGE_INPUT) return this.toggleMessageInputs();
    if (parsed.command === VOICE_COMMANDS.READ_NETWORK) return this.loadNetworkOptions();
    if (parsed.command === VOICE_COMMANDS.SCAN_AGENT) return this.runAgentScan();
    if (parsed.command === VOICE_COMMANDS.SCAN_MESSAGE) return this.runMessageScan();
    if (parsed.command === VOICE_COMMANDS.CHECK_NAPCAT) return this.testNapcatHealth();
    if (parsed.command === VOICE_COMMANDS.CONFIGURE_NAPCAT) return this.configureNapcatOnebot();
    if (parsed.command === VOICE_COMMANDS.REPAIR_NAPCAT) return this.repairAllNapcatIssues();
    if (parsed.command === VOICE_COMMANDS.CHECK_ASTRBOT) return this.testAstrbotLogin();
    if (parsed.command === VOICE_COMMANDS.START_MANAGER) return this.startManager();
    if (parsed.command === VOICE_COMMANDS.START_ROUTE) return this.startGateway();
    if (parsed.command === VOICE_COMMANDS.STOP_ROUTE) return this.stopGateway();
    if (parsed.command === VOICE_COMMANDS.RESTART_ROUTE) return this.restartGateway();
    if (parsed.command === VOICE_COMMANDS.MANUAL_TRIGGER) return this.manualTriggerGateway();
    if (parsed.command === VOICE_COMMANDS.ADD_ROUTE) return this.addGatewayDraft();
    if (parsed.command === VOICE_COMMANDS.DUPLICATE_ROUTE) return this.duplicateGatewayDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_ROUTE) return this.removeGatewayDraft();
    if (parsed.command === VOICE_COMMANDS.MOVE_ROUTE_UP) return this.moveGatewayUp();
    if (parsed.command === VOICE_COMMANDS.MOVE_ROUTE_DOWN) return this.moveGatewayDown();
    if (parsed.command === VOICE_COMMANDS.ADD_VARIABLE) return this.addRouteVariableDraft();
    if (parsed.command === VOICE_COMMANDS.APPLY_VARIABLE) return this.applyRouteVariableDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_VARIABLE) return this.removeRouteVariableDraft();
    if (parsed.command === VOICE_COMMANDS.NEXT_VARIABLE) return this.nextRouteVariable();
    if (parsed.command === VOICE_COMMANDS.PREV_VARIABLE) return this.prevRouteVariable();
    if (parsed.command === VOICE_COMMANDS.ADD_RULE) return this.addNotificationRuleDraft();
    if (parsed.command === VOICE_COMMANDS.APPLY_RULE) return this.applyNotificationRuleDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_RULE) return this.removeNotificationRuleDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_RULE) return this.toggleNotificationRuleEnabled();
    if (parsed.command === VOICE_COMMANDS.NEXT_RULE) return this.nextNotificationRule();
    if (parsed.command === VOICE_COMMANDS.PREV_RULE) return this.prevNotificationRule();
    if (parsed.command === VOICE_COMMANDS.ADD_SCHEDULE) return this.addNotificationScheduleDraft();
    if (parsed.command === VOICE_COMMANDS.APPLY_SCHEDULE) return this.applyNotificationScheduleDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_SCHEDULE) return this.removeNotificationScheduleDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_SCHEDULE) return this.toggleNotificationScheduleEnabled();
    if (parsed.command === VOICE_COMMANDS.NEXT_SCHEDULE) return this.nextNotificationSchedule();
    if (parsed.command === VOICE_COMMANDS.PREV_SCHEDULE) return this.prevNotificationSchedule();
    if (parsed.command === VOICE_COMMANDS.APPLY_POLICY) return this.applyMessagePolicyDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_POLICY_INPUT) return this.toggleMessagePolicyInput();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_POLICY_OUTPUT) return this.toggleMessagePolicyOutput();
    if (parsed.command === VOICE_COMMANDS.NEXT_POLICY) return this.nextMessagePolicy();
    if (parsed.command === VOICE_COMMANDS.PREV_POLICY) return this.prevMessagePolicy();
    if (parsed.command === VOICE_COMMANDS.ADD_NAPCAT) return this.addNapcatInstanceDraft();
    if (parsed.command === VOICE_COMMANDS.APPLY_NAPCAT) return this.applyNapcatInstanceDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_NAPCAT) return this.removeNapcatInstanceDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_NAPCAT) return this.toggleNapcatInstanceEnabled();
    if (parsed.command === VOICE_COMMANDS.NEXT_NAPCAT) return this.nextNapcatInstance();
    if (parsed.command === VOICE_COMMANDS.PREV_NAPCAT) return this.prevNapcatInstance();
    if (parsed.command === VOICE_COMMANDS.APPLY_PIPELINE) return this.applyPipelineDraft();
    if (parsed.command === VOICE_COMMANDS.CLEAR_PIPELINE) return this.clearPipelineDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_PIPELINE_TTS) return this.togglePipelineTtsPlay();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_PIPELINE_GUARD) return this.togglePipelinePreventFeedbackLoop();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_PIPELINE_REPLY) return this.togglePipelineReplyToSource();
    if (parsed.command === VOICE_COMMANDS.NEXT_PIPELINE_OUTPUT) return this.nextPipelineOutputAdapter();
    if (parsed.command === VOICE_COMMANDS.PREV_PIPELINE_OUTPUT) return this.prevPipelineOutputAdapter();
    if (parsed.command === VOICE_COMMANDS.NEXT_PIPELINE_PROMPT) return this.nextPipelinePromptMode();
    if (parsed.command === VOICE_COMMANDS.PREV_PIPELINE_PROMPT) return this.prevPipelinePromptMode();
    if (parsed.command === VOICE_COMMANDS.ADD_PROFILE) return this.addRouteProfileDraft();
    if (parsed.command === VOICE_COMMANDS.APPLY_PROFILE) return this.applyRouteProfileDraft();
    if (parsed.command === VOICE_COMMANDS.REMOVE_PROFILE) return this.removeRouteProfileDraft();
    if (parsed.command === VOICE_COMMANDS.TOGGLE_PROFILE) return this.toggleRouteProfileEnabled();
    if (parsed.command === VOICE_COMMANDS.NEXT_PROFILE) return this.nextRouteProfile();
    if (parsed.command === VOICE_COMMANDS.PREV_PROFILE) return this.prevRouteProfile();
    if (parsed.command === VOICE_COMMANDS.APPLY_TEMPLATE) return this.applyNotificationTemplateDraft();
    if (parsed.command === VOICE_COMMANDS.CLEAR_TEMPLATE) return this.clearNotificationTemplateDraft();
    if (parsed.command === VOICE_COMMANDS.NEXT_TEMPLATE) return this.nextNotificationTemplate();
    if (parsed.command === VOICE_COMMANDS.PREV_TEMPLATE) return this.prevNotificationTemplate();
    if (parsed.command === VOICE_COMMANDS.APPLY_INTEGRATIONS) return this.applyIntegrationDraft();
    if (parsed.command === VOICE_COMMANDS.NEXT_PANEL) {
      this.nextPanel();
      this.say("已切到下一个配置面板。");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.PREV_PANEL) {
      this.prevPanel();
      this.say("已切到上一个配置面板。");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.NEXT_ROUTE) {
      this.nextRoute();
      this.say("已切到下一个 Route。");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.PREV_ROUTE) {
      this.prevRoute();
      this.say("已切到上一个 Route。");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.NEXT_WORKER) {
      this.nextWorker();
      this.say("已切到下一台 PC。");
      return;
    }
    if (parsed.command === VOICE_COMMANDS.PREV_WORKER) {
      this.prevWorker();
      this.say("已切到上一台 PC。");
      return;
    }
    this.setData({
      assistantStatus: "需要明确指令",
      assistantReplyText: "原生 Agent 尚未把需求转换成可执行的配置指令，请让它明确要读取或修改的项目。",
      assistantCanRetry: true
    });
    this.appendLog(`未识别配置指令：${value}`);
    return false;
  },

  say(text, options = {}) {
    const value = String(text || "").trim();
    if (!value) return;
    const agentSpeech = this.data.isTranscriptionMode && options.allowInTranscription === true;
    if (this.data.isConfigurationMode) {
      this.setData({
        assistantReplyText: value,
        assistantStatus: options.assistantStatus || "已完成",
        assistantCanRetry: options.assistantCanRetry === true
      });
    }
    if (agentSpeech) {
      this.setData({
        agentReplyText: value,
        agentStatus: options.agentStatus || "Agent 回复中"
      });
    }
    if (this.data.isTranscriptionMode && options.allowInTranscription !== true) return;
    this.enqueueSpeech(value, { agentSpeech });
  },

  enqueueSpeech(text, options = {}) {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      return;
    }
    this.speechQueue.push({
      text: String(text || ""),
      agentSpeech: options.agentSpeech === true
    });
    this.startNextSpeech();
  },

  startNextSpeech() {
    if (this.speechActive || this.destroyed || !this.pageVisible) return;
    const item = this.speechQueue.shift();
    if (!item) {
      if (this.data.agentSpeaking) this.setData({ agentSpeaking: false });
      return;
    }
    if (item.agentSpeech && !this.data.isTranscriptionMode) {
      this.startNextSpeech();
      return;
    }
    const generation = Number(this.speechGeneration || 0);
    this.speechActive = true;
    if (item.agentSpeech) {
      this.clearTranscriptionRestart();
      this.stopRecognition(false);
      this.setData({
        agentSpeaking: true,
        agentStatus: "正在播报",
        transcriptionState: "Agent 正在播报"
      });
    }
    let finished = false;
    const finishSpeech = (error) => {
      if (finished) return;
      finished = true;
      if (generation !== this.speechGeneration) return;
      this.speechActive = false;
      this.currentUtterance = null;
      if (error) this.appendLog(`TTS 失败：${error?.message || error}`);
      if (this.speechQueue.length) {
        this.startNextSpeech();
        return;
      }
      if (item.agentSpeech) {
        this.setData({
          agentSpeaking: false,
          agentStatus: "可以继续说话",
          transcriptionState: this.data.transcriptionDesired ? "准备继续聆听" : "已暂停"
        });
        if (this.data.transcriptionDesired && this.data.isTranscriptionMode && this.pageVisible && !this.destroyed) {
          this.scheduleTranscriptionRestart(TRANSCRIPTION_RESTART_DELAY_MS);
        }
      }
    };
    try {
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.lang = "zh-CN";
      utterance.onend = () => finishSpeech();
      utterance.onerror = (event) => finishSpeech(event?.error || "speech synthesis error");
      this.currentUtterance = utterance;
      speechSynthesis.speak(utterance);
    } catch (error) {
      finishSpeech(error);
    }
  },

  cancelSpeech() {
    this.speechGeneration = Number(this.speechGeneration || 0) + 1;
    this.speechQueue = [];
    this.speechActive = false;
    this.currentUtterance = null;
    if (typeof speechSynthesis !== "undefined" && typeof speechSynthesis.cancel === "function") {
      try {
        speechSynthesis.cancel();
      } catch (error) {
        this.appendLog(`停止 TTS 失败：${error?.message || error}`);
      }
    }
    if (this.data.agentSpeaking) this.setData({ agentSpeaking: false });
  },

  async runAction(label, action) {
    if (this.data.busy) {
      return;
    }
    this.setData({
      busy: true,
      statusText: `${label}中`,
      assistantStatus: `${label}中`,
      assistantReplyText: "正在执行，请稍候。",
      assistantCanRetry: false
    });
    try {
      await action();
    } catch (error) {
      const message = error.message || String(error);
      this.setData({
        statusText: `${label}失败`,
        assistantStatus: `${label}失败`,
        assistantReplyText: message,
        assistantCanRetry: true
      });
      this.appendLog(`${label}失败：${message}`);
      this.say(`${label}失败。`, { assistantStatus: `${label}失败`, assistantCanRetry: true });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ busy: false });
      this.updateDerivedState();
    }
  },

  warn(message) {
    this.appendLog(message);
    if (this.data.isConfigurationMode) {
      this.setData({
        assistantStatus: "需要处理",
        assistantReplyText: String(message || ""),
        assistantCanRetry: true
      });
    }
    this.say(message, { assistantStatus: "需要处理", assistantCanRetry: true });
    wx.showToast({ title: message, icon: "none" });
  },

  appendLog(text) {
    const logs = [
      { id: `${Date.now()}-${Math.random()}`, text: `${nowLabel()} ${text}` },
      ...this.data.logs
    ].slice(0, 8);
    this.setData({ logs });
  },

  updateDerivedState() {
    if (this.data.isTranscriptionMode) {
      this.setData({
        showRelaySurface: false,
        showRelaySettingsSurface: false,
        showPcSurface: false,
        showRouteSurface: false,
        showConfigSurface: false,
        showAgentSurface: false,
        showLogSurface: false
      });
      return;
    }
    const surface = this.selectedSurface() || APP_SURFACES[0];
    const panelIndex = surface.kind === "config" ? surface.panelIndex : this.data.panelIndex;
    const panel = selectedItem(this.data.configPanels, panelIndex) || this.data.configPanels[0];
    const gateway = this.selectedGatewayConfig() || {};
    const activeMessages = messageAdaptersFor(gateway);
    const scalarField = this.selectedScalarField();
    const jsonField = this.selectedJsonField();
    const routeVariableRows = routeVariableRowsFor(gateway);
    const routeVariableIndex = routeVariableRows.length
      ? Math.max(0, Math.min(this.data.routeVariableIndex, routeVariableRows.length - 1))
      : 0;
    const routeVariable = routeVariableRows[routeVariableIndex] || {};
    const notificationRuleRows = notificationRuleRowsFor(gateway);
    const notificationRuleIndex = notificationRuleRows.length
      ? Math.max(0, Math.min(this.data.notificationRuleIndex, notificationRuleRows.length - 1))
      : 0;
    const notificationRule = notificationRuleRows[notificationRuleIndex] || {};
    const selectedRuleKinds = new Set(routeKindListFor(this.data.notificationRuleRouteKinds));
    const messagePolicyRows = messageAdapterPolicyRowsFor(gateway);
    const messagePolicyIndex = messagePolicyRows.length
      ? Math.max(0, Math.min(this.data.messagePolicyIndex, messagePolicyRows.length - 1))
      : 0;
    const messagePolicy = messagePolicyRows[messagePolicyIndex] || {};
    const napcatInstanceRows = napcatInstanceRowsFor(gateway);
    const napcatInstanceIndex = napcatInstanceRows.length
      ? Math.max(0, Math.min(this.data.napcatInstanceIndex, napcatInstanceRows.length - 1))
      : 0;
    const napcatInstance = napcatInstanceRows[napcatInstanceIndex] || {};
    const routeProfileRows = routeProfileRowsFor(gateway);
    const routeProfileIndex = routeProfileRows.length
      ? Math.max(0, Math.min(this.data.routeProfileIndex, routeProfileRows.length - 1))
      : 0;
    const routeProfile = routeProfileRows[routeProfileIndex] || {};
    const selectedPayloadKinds = new Set(String(this.data.messagePolicyOutputs || messagePolicy.supportedOutputsText || "")
      .split(/[,\s，、]+/)
      .map((item) => String(item || "").trim())
      .filter(Boolean));
    const selectedPipelineInput = this.data.pipelineInputAdapter || "";
    const selectedPipelineOutput = this.data.pipelineOutputAdapter || "";
    const selectedPromptMode = this.data.pipelinePromptOutputMode || "";
    const notificationScheduleRows = notificationScheduleRowsFor(gateway, this.data.notificationRuleIndex);
    const notificationScheduleIndex = notificationScheduleRows.length
      ? Math.max(0, Math.min(this.data.notificationScheduleIndex, notificationScheduleRows.length - 1))
      : 0;
    const notificationSchedule = notificationScheduleRows[notificationScheduleIndex] || {};
    const selectedScheduleType = this.data.notificationScheduleType || notificationSchedule.type || "interval";
    const integrationHeartbeatSeconds = gateway.heartbeatIntervalSeconds == null ? 900 : gateway.heartbeatIntervalSeconds;
    const summary = configSummary(this.data.gateways, this.data.gatewayIndex, this.data.runtimeRows);
    this.setData({
      maskedToken: maskToken(this.data.token),
      surfaceId: surface.id,
      surfaceLabel: surface.label,
      surfacePosition: `${this.data.surfaceIndex + 1}/${this.data.appSurfaces.length}`,
      showRelaySurface: this.data.isConfigurationMode && surface.kind === "relay",
      showRelaySettingsSurface: this.data.isConfigurationMode && surface.kind === "relaySettings",
      showPcSurface: this.data.isConfigurationMode && surface.kind === "pc",
      showRouteSurface: this.data.isConfigurationMode && surface.kind === "route",
      showConfigSurface: this.data.isConfigurationMode && surface.kind === "config",
      showAgentSurface: this.data.isConfigurationMode && surface.kind === "agent",
      showLogSurface: this.data.isConfigurationMode && surface.kind === "logs",
      panelIndex,
      panelId: panel ? panel.id : "route",
      panelLabel: panel ? panel.label : "路由",
      scalarFieldLabel: scalarField ? scalarField.label : "字段",
      scalarFieldType: scalarField ? scalarField.type : "string",
      scalarFieldPreview: fieldSummary(scalarField, this.data.scalarFieldValue),
      jsonFieldLabel: jsonField ? jsonField.label : "JSON",
      jsonFieldPreview: fieldSummary(jsonField, this.data.jsonFieldValue),
      routeVariableRows,
      routeVariableIndex,
      routeVariableSummary: routeVariableRows.length ? `${routeVariableIndex + 1}/${routeVariableRows.length} ${routeVariable.key || ""}` : "未配置变量",
      notificationRuleRows,
      notificationRuleIndex,
      notificationRuleSummary: notificationRuleRows.length ? `${notificationRuleIndex + 1}/${notificationRuleRows.length} ${notificationRule.id || ""}` : "未配置规则",
      notificationRouteKindView: this.data.notificationRouteKinds.map((kind) => ({
        ...kind,
        active: selectedRuleKinds.has(kind.id)
      })),
      messagePolicyRows,
      messagePolicyIndex,
      messagePolicySummary: messagePolicyRows.length ? `${messagePolicyIndex + 1}/${messagePolicyRows.length} ${messagePolicy.id || ""}` : "未配置策略",
      napcatInstanceRows,
      napcatInstanceIndex,
      napcatInstanceSummary: napcatInstanceRows.length ? `${napcatInstanceIndex + 1}/${napcatInstanceRows.length} ${napcatInstance.enabled === false ? "停用" : "启用"} · ${napcatInstance.httpUrl || "-"}` : "未配置 NapCat",
      routeProfileRows,
      routeProfileIndex,
      routeProfileSummary: routeProfileSummaryFor(routeProfile, routeProfileIndex, routeProfileRows.length),
      messagePayloadKindView: this.data.messagePayloadKinds.map((kind) => ({
        ...kind,
        active: selectedPayloadKinds.has(kind.id)
      })),
      pipelineInputAdapterView: this.data.pipelineInputAdapters.map((adapter) => ({
        ...adapter,
        active: selectedPipelineInput === adapter.id
      })),
      pipelineOutputAdapterView: this.data.pipelineOutputAdapters.map((adapter) => ({
        ...adapter,
        active: selectedPipelineOutput === adapter.id
      })),
      promptOutputModeView: this.data.promptOutputModes.map((mode) => ({
        ...mode,
        active: selectedPromptMode === mode.id
      })),
      notificationScheduleRows,
      notificationScheduleIndex,
      notificationScheduleSummary: notificationScheduleRows.length ? `${notificationScheduleIndex + 1}/${notificationScheduleRows.length} ${notificationSchedule.id || ""}` : "未配置计划",
      notificationScheduleTypeView: this.data.notificationScheduleTypes.map((type) => ({
        ...type,
        active: selectedScheduleType === type.id
      })),
      selectedGatewayLabel: summary.gatewayLabel,
      selectedGatewayMeta: `${summary.gatewayMeta} · ${this.data.webguiDirty ? "未保存" : summary.dirtyText}`,
      messageAdapterText: summary.messageAdapterText,
      agentAdapterText: summary.agentAdapterText,
      runtimeText: summary.runtimeText,
      messageAdaptersView: this.data.messageAdapters.map((adapter) => ({
        ...adapter,
        active: activeMessages.includes(adapter.id)
      })),
      currentRouteName: gateway.routeName || gateway.name || "",
      currentRoleId: gateway.agentRoleId || "",
      currentAgentModel: gateway.agentModel || "",
      currentPipelinePreset: gateway.pipelinePreset || "",
      currentGatewayPort: gateway.gatewayPort || "",
      currentWebhookPort: gateway.webhookPort || "",
      currentFenneNotePort: gateway.fenneNoteWebhookPort || "",
      currentRabiLinkPort: gateway.rabiLinkWebhookPort || "",
      integrationSummary: `${integrationHeartbeatSeconds}s · ${gateway.wecomBotId ? "企微" : "企微未配"} · ${gateway.remoteAgentDefaultDeviceId || "远端未配"}`,
      currentRouteEnabled: gateway.enabled !== false,
      currentMessageInputsDisabled: gateway.messageInputsDisabled === true,
      ...buildDerivedState(this.data)
    });
  }
};
</script>

<page>
  <view class="pageScroll">
    <view class="page">
    <view class="compactCard {{modeFrameRelayout ? 'modeFrameRelayout' : ''}}">
      <view class="compactHeader">
        <text class="compactBrand">RabiLink</text>
        <view class="modeSwitch compactModeSwitch">
          <view class="modeSwitchThumb {{isConfigurationMode ? 'modeSwitchThumbRight' : ''}}"></view>
          <view class="modeSwitchOption {{isTranscriptionMode ? 'modeSwitchOptionActive' : ''}}" bindtap="selectTranscriptionMode">
            <text>连接对话</text>
          </view>
          <view class="modeSwitchOption {{isConfigurationMode ? 'modeSwitchOptionActive' : ''}}" bindtap="selectConfigurationMode">
            <text>配置助手</text>
          </view>
        </view>
        <text class="compactLive {{transcriptionListening || agentPolling || agentSpeaking || busy ? 'compactLiveOn' : ''}}">{{isTranscriptionMode ? (agentSpeaking ? 'TTS' : (transcriptionListening ? 'LIVE' : (agentPolling ? 'LINK' : 'PAUSE'))) : (busy ? 'WORK' : 'READY')}}</text>
      </view>
      <view class="compactStatusRow">
        <text class="compactStatusPrimary">{{isTranscriptionMode ? agentStatus : assistantStatus}}</text>
        <text class="compactStatusSecondary">{{isTranscriptionMode ? transcriptionSyncLabel : (connected ? 'Relay 在线' : '等待连接')}}</text>
      </view>
      <text class="compactMainText">{{isTranscriptionMode ? agentReplyText : assistantReplyText}}</text>
      <view class="deviceFooter compactDeviceFooter">
        <view class="deviceReadout">
          <view class="clockIcon"><view class="clockHourHand"></view><view class="clockMinuteHand"></view></view>
          <text class="deviceReadoutText">{{currentTime}}</text>
        </view>
        <text class="compactMeta">{{isTranscriptionMode ? transcriptionElapsed : '滑动切换'}}</text>
        <view class="deviceReadout deviceReadoutRight">
          <view class="batteryIcon">
            <view class="batteryBody">
              <view class="batteryFill {{batteryFillClass}}"></view>
              <text class="chargingMark {{batteryCharging ? '' : 'statusHidden'}}">⚡</text>
            </view>
            <view class="batteryCap"></view>
          </view>
          <text class="deviceReadoutText">{{batteryText}}</text>
        </view>
      </view>
    </view>

    <view class="unifiedModeHud {{modeFrameRelayout ? 'modeFrameRelayout' : ''}}">
      <view class="assistantClearZone"></view>

      <view class="modeHeader">
        <text class="modeProduct">RabiLink</text>
        <view class="modeSwitch">
          <view class="modeSwitchThumb {{isConfigurationMode ? 'modeSwitchThumbRight' : ''}}"></view>
          <view class="modeSwitchOption {{isTranscriptionMode ? 'modeSwitchOptionActive' : ''}}" bindtap="selectTranscriptionMode">
            <text>连接对话</text>
          </view>
          <view class="modeSwitchOption {{isConfigurationMode ? 'modeSwitchOptionActive' : ''}}" bindtap="selectConfigurationMode">
            <text>配置助手</text>
          </view>
        </view>
        <text class="modeGestureHint">滑动切换</text>
        <text class="pill {{transcriptionListening || agentPolling || agentSpeaking || busy ? 'pillOk' : ''}}">{{isTranscriptionMode ? (agentSpeaking ? 'TTS' : (transcriptionListening ? 'LIVE' : (agentPolling ? 'LINK' : 'PAUSE'))) : (busy ? 'WORK' : 'READY')}}</text>
      </view>

      <view class="assistantStatusRow">
        <text class="assistantState">{{isTranscriptionMode ? agentStatus : assistantStatus}}</text>
        <text class="muted">{{isTranscriptionMode ? transcriptionState : '原生 Agent 配置'}}</text>
      </view>

      <view class="assistantConversation">
        <view class="assistantLine">
          <text class="assistantSpeaker">你</text>
          <text class="assistantLineText {{isTranscriptionMode ? 'transcriptionLineText' : ''}}">{{isTranscriptionMode ? transcriptionText : assistantUserText}}</text>
        </view>
        <view class="assistantLine assistantReplyLine">
          <text class="assistantSpeaker">{{isTranscriptionMode ? 'Agent' : '助手'}}</text>
          <text class="assistantLineText assistantReplyText">{{isTranscriptionMode ? agentReplyText : assistantReplyText}}</text>
        </view>
      </view>

      <view class="hudInfoRow assistantInfoRow">
        <text class="assistantModeMeta">{{isTranscriptionMode ? transcriptionElapsed : '原生 Agent 调用'}}</text>
        <view class="utilityActions">
          <view class="utilityAction {{isConfigurationMode ? 'statusHidden' : ''}}" bindtap="toggleModePrimaryAction">
            <text class="utilityIcon">{{transcriptionDesired ? 'Ⅱ' : '▶'}}</text>
            <text>{{transcriptionDesired ? '暂停' : '继续'}}</text>
          </view>
          <view class="utilityAction {{isConfigurationMode && !assistantCanRetry ? 'statusHidden' : ''}}" bindtap="retryModeAction">
            <text class="utilityIcon">↻</text>
            <text>重试</text>
          </view>
        </view>
      </view>

      <view class="deviceFooter">
        <view class="deviceReadout">
          <view class="clockIcon"><view class="clockHourHand"></view><view class="clockMinuteHand"></view></view>
          <text class="deviceReadoutText">{{currentTime}}</text>
        </view>
        <text class="footerModeHint">滑动切换</text>
        <view class="deviceReadout deviceReadoutRight">
          <view class="batteryIcon">
            <view class="batteryBody">
              <view class="batteryFill {{batteryFillClass}}"></view>
              <text class="chargingMark {{batteryCharging ? '' : 'statusHidden'}}">⚡</text>
            </view>
            <view class="batteryCap"></view>
          </view>
          <text class="deviceReadoutText">{{batteryText}}</text>
        </view>
      </view>
    </view>


  </view>
</page>

<style>
.pageScroll {
  width: var(--app-width, 480px);
  height: var(--rabilink-surface-height, 352px);
  max-height: var(--rabilink-surface-height, 352px);
  overflow: hidden;
  background-color: var(--color-background, #000000);
}

.page {
  width: var(--app-width, 480px);
  height: 100%;
  min-height: 100%;
  max-height: 100%;
  padding: 16px;
  box-sizing: border-box;
  overflow: hidden;
  color: var(--color-text-primary, #40ff5e);
  background-color: var(--color-background, #000000);
}

.compactCard {
  display: none;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
}

.compactHeader,
.compactStatusRow,
.modeHeader,
.modeSwitch,
.modeSwitchOption,
.hudInfoRow,
.utilityActions,
.utilityAction,
.deviceFooter,
.deviceReadout,
.batteryIcon,
.batteryBody {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.compactHeader,
.compactStatusRow {
  width: 424px;
  justify-content: space-between;
  gap: 6px;
}

.compactBrand {
  color: var(--color-text-primary, #40ff5e);
  font-size: 14px;
  font-weight: 700;
  line-height: 18px;
}

.compactLive {
  padding: 1px 5px;
  border: 1px solid rgba(64, 255, 94, 0.4);
  border-radius: 6px;
  color: rgba(64, 255, 94, 0.6);
  font-size: 9px;
  line-height: 12px;
}

.compactLiveOn {
  border-color: var(--color-primary, #40ff5e);
  color: var(--color-primary, #40ff5e);
}

.compactStatusPrimary,
.compactStatusSecondary,
.compactMainText,
.compactMeta,
.deviceReadoutText {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compactStatusPrimary {
  color: var(--color-text-primary, #40ff5e);
  font-size: 12px;
  font-weight: 700;
  line-height: 15px;
}

.compactStatusSecondary {
  min-width: 0;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 15px;
}

.compactMainText {
  width: 424px;
  min-height: 20px;
  color: var(--color-text-primary, #40ff5e);
  font-size: 15px;
  line-height: 20px;
}

.compactMeta {
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 10px;
  line-height: 13px;
}

.unifiedModeHud {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  min-width: 0;
  gap: 4px;
  min-height: 320px;
  overflow: hidden;
}

.modeFrameRelayout {
  box-sizing: border-box;
  opacity: 0;
  padding-right: 1px;
}

.assistantClearZone {
  flex: 1;
  min-height: 110px;
}

.assistantStatusRow,
.assistantLine {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.assistantStatusRow {
  justify-content: space-between;
  gap: 10px;
  min-height: 22px;
}

.assistantState {
  color: var(--color-text-primary, #40ff5e);
  font-size: 16px;
  font-weight: 700;
  line-height: 20px;
}

.assistantConversation {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  min-height: 70px;
  max-height: 70px;
  padding: 5px 10px;
  box-sizing: border-box;
  overflow: hidden;
  border-left: 2px solid var(--color-primary, #40ff5e);
  background-color: #000000;
}

.assistantLine {
  align-items: flex-start;
  gap: 8px;
  min-height: 27px;
  overflow: hidden;
}

.assistantSpeaker {
  flex: 0 0 32px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
}

.assistantLineText {
  flex: 1;
  min-width: 0;
  max-height: 32px;
  overflow: hidden;
  color: var(--color-text-primary, #40ff5e);
  font-size: 14px;
  line-height: 18px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.assistantReplyText {
  font-weight: 700;
}

.transcriptionLineText {
  font-size: 18px;
  font-weight: 700;
  line-height: 22px;
}

.modeHeader {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  justify-content: space-between;
  gap: 6px;
  min-height: 28px;
}

.modeProduct {
  flex: 0 0 54px;
  color: var(--color-text-primary, #40ff5e);
  font-size: 13px;
  font-weight: 700;
  line-height: 18px;
}

.modeSwitch {
  position: relative;
  flex: 0 0 236px;
  width: 236px;
  height: 28px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(64, 255, 94, 0.4);
  border-radius: 7px;
  background-color: #000000;
}

.modeSwitchThumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 115px;
  height: 24px;
  box-sizing: border-box;
  border: 1px solid var(--color-primary, #40ff5e);
  border-radius: 5px;
  background-color: #000000;
}

.modeSwitchThumbRight {
  left: 118px;
}

.modeSwitchOption {
  position: relative;
  z-index: 1;
  justify-content: center;
  width: 117px;
  height: 26px;
  color: rgba(64, 255, 94, 0.5);
  font-size: 11px;
  line-height: 26px;
  white-space: nowrap;
}

.modeSwitchOptionActive {
  color: var(--color-text-primary, #40ff5e);
  font-weight: 700;
}

.modeGestureHint {
  flex: 0 0 54px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 10px;
  line-height: 13px;
  white-space: nowrap;
}

.hudInfoRow {
  justify-content: space-between;
  gap: 8px;
  min-height: 20px;
}

.utilityActions {
  justify-content: flex-end;
  gap: 10px;
  min-height: 18px;
}

.utilityAction {
  min-width: 48px;
  height: 18px;
  justify-content: flex-end;
  gap: 4px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.utilityIcon {
  display: block;
  width: 12px;
  color: var(--color-text-primary, #40ff5e);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.assistantInfoRow {
  min-height: 20px;
}

.assistantModeMeta {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deviceFooter {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  min-height: 18px;
  justify-content: space-between;
  gap: 8px;
}

.deviceReadout {
  min-width: 56px;
  gap: 5px;
}

.deviceReadoutRight {
  justify-content: flex-end;
}

.deviceReadoutText,
.footerModeHint {
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
}

.footerModeHint {
  opacity: 0.65;
}

.clockIcon {
  position: relative;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.7);
  border-radius: 6px;
}

.clockHourHand,
.clockMinuteHand {
  position: absolute;
  background-color: var(--color-primary, #40ff5e);
}

.clockHourHand {
  top: 2px;
  left: 5px;
  width: 1px;
  height: 4px;
}

.clockMinuteHand {
  top: 5px;
  left: 5px;
  width: 3px;
  height: 1px;
}

.batteryIcon {
  position: relative;
  width: 24px;
  height: 12px;
  justify-content: flex-start;
}

.batteryBody {
  position: relative;
  width: 20px;
  height: 11px;
  padding: 1px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(64, 255, 94, 0.7);
  border-radius: 2px;
}

.batteryCap {
  width: 2px;
  height: 5px;
  background-color: rgba(64, 255, 94, 0.7);
}

.batteryFill {
  flex: 0 0 auto;
  height: 7px;
  background-color: var(--color-primary, #40ff5e);
}

.batteryFillLevel0 { width: 0; }
.batteryFillLevel10 { width: 2px; }
.batteryFillLevel20 { width: 3px; }
.batteryFillLevel30 { width: 5px; }
.batteryFillLevel40 { width: 7px; }
.batteryFillLevel50 { width: 9px; }
.batteryFillLevel60 { width: 10px; }
.batteryFillLevel70 { width: 12px; }
.batteryFillLevel80 { width: 14px; }
.batteryFillLevel90 { width: 15px; }
.batteryFillLevel100 { width: 17px; }

.chargingMark {
  position: absolute;
  top: -1px;
  left: 5px;
  z-index: 2;
  color: var(--color-text-primary, #40ff5e);
  font-size: 9px;
  line-height: 11px;
}

.statusHidden {
  display: none;
}

.compactModeSwitch {
  flex-basis: 192px;
  width: 192px;
  height: 20px;
  border-radius: 6px;
}

.compactModeSwitch .modeSwitchThumb {
  width: 93px;
  height: 16px;
}

.compactModeSwitch .modeSwitchThumbRight {
  left: 96px;
}

.compactModeSwitch .modeSwitchOption {
  width: 95px;
  height: 18px;
  font-size: 9px;
  line-height: 18px;
}

.compactDeviceFooter {
  width: 424px;
  min-height: 13px;
}

.topbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.titleBlock {
  flex: 1;
  min-width: 0;
}

.title {
  display: block;
  font-size: 26px;
  font-weight: 700;
  line-height: 30px;
}

.subtitle {
  display: block;
  margin-top: 2px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding: 8px;
  border: var(--border-width-default, 2px) solid var(--border-color-default, rgba(64, 255, 94, 0.6));
  border-radius: var(--radius-md, 12px);
  background-color: var(--color-surface, #000000);
}

.voiceBar {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border: var(--border-width-default, 2px) solid var(--color-primary, #40ff5e);
  border-radius: var(--radius-md, 12px);
  background-color: rgba(64, 255, 94, 0.08);
}

.configurationViewport {
  flex: 0 0 190px;
  width: 100%;
  height: 190px;
  min-height: 190px;
  max-height: 190px;
  overflow: hidden;
}

.configurationContent {
  width: 100%;
}

.configurationPager,
.configurationPagerActions {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.configurationPager {
  justify-content: space-between;
  min-height: 28px;
  margin-top: 4px;
  background-color: #000000;
}

.topbar,
.voiceBar,
.configurationPager {
  position: relative;
  z-index: 2;
}

.topbar {
  background-color: #000000;
}

.configurationPagerHint {
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 11px;
  line-height: 14px;
}

.configurationPagerActions {
  gap: 6px;
}

.configurationPageButton {
  width: 36px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.6);
  border-radius: 6px;
  color: var(--color-text-primary, #40ff5e);
  background-color: #000000;
  font-size: 12px;
  line-height: 26px;
}

.configurationPageButtonDisabled {
  border-color: rgba(64, 255, 94, 0.2);
}

.configurationPageGlyph {
  display: block;
  color: var(--color-text-primary, #40ff5e);
  font-size: 12px;
  line-height: 26px;
  text-align: center;
}

.configurationPageGlyphDisabled {
  color: rgba(64, 255, 94, 0.25);
}

.panelHeader,
.row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panelTitle {
  font-size: 18px;
  font-weight: 700;
  line-height: 22px;
}

.muted {
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 17px;
}

.pill {
  padding: 3px 7px;
  border: 1px solid rgba(64, 255, 94, 0.4);
  border-radius: 6px;
  color: rgba(64, 255, 94, 0.6);
  font-size: 11px;
  line-height: 14px;
}

.pillOk {
  border-color: var(--color-primary, #40ff5e);
  color: var(--color-primary, #40ff5e);
}

.input {
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.4);
  border-radius: var(--radius-md, 12px);
  color: var(--color-text-primary, #40ff5e);
  background-color: rgba(64, 255, 94, 0.08);
  font-size: 14px;
}

.textarea {
  width: 100%;
  min-height: 132px;
  padding: 10px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.4);
  border-radius: var(--radius-md, 12px);
  color: var(--color-text-primary, #40ff5e);
  background-color: rgba(64, 255, 94, 0.08);
  font-size: 13px;
  line-height: 18px;
}

.selector {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.selectorBody {
  flex: 1;
  min-width: 0;
}

.selectorTitle,
.selectorMeta,
.singleLine {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectorTitle {
  font-size: 18px;
  font-weight: 700;
  line-height: 22px;
}

.selectorMeta {
  margin-top: 4px;
  color: var(--color-text-secondary, rgba(64, 255, 94, 0.6));
  font-size: 13px;
  line-height: 17px;
}

.compact {
  margin-top: 6px;
}

.singleLine {
  flex: 1;
  color: var(--color-text-primary, #40ff5e);
  font-size: 14px;
  line-height: 18px;
}

.iconButton,
.navButton {
  width: 38px;
  height: 38px;
  padding: 0;
  box-sizing: border-box;
  border: 2px solid rgba(64, 255, 94, 0.6);
  border-radius: var(--radius-md, 12px);
  color: var(--color-text-primary, #40ff5e);
  background-color: #000000;
  font-size: 20px;
  line-height: 38px;
}

.modeButton {
  width: 52px;
  height: 32px;
  min-height: 32px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 2px solid var(--color-primary, #40ff5e);
  border-radius: 8px;
  color: var(--color-text-primary, #40ff5e);
  background-color: #000000;
  font-size: 12px;
  line-height: 32px;
  white-space: nowrap;
}

.smallButton,
.wideButton,
.segment {
  min-height: 34px;
  box-sizing: border-box;
  border: 1px solid rgba(64, 255, 94, 0.6);
  border-radius: var(--radius-md, 12px);
  color: var(--color-text-primary, #40ff5e);
  background-color: #000000;
  font-size: 14px;
  line-height: 32px;
}

.smallButton {
  flex: 1;
  height: 34px;
  padding: 0 8px;
}

.wideButton {
  width: 100%;
  height: 34px;
  padding: 0 8px;
}

.primary,
.segmentOn {
  border-color: var(--color-primary, #40ff5e);
  border-width: 2px;
  color: var(--color-primary, #40ff5e);
  background-color: rgba(64, 255, 94, 0.08);
}

.danger {
  border-color: var(--color-primary, #40ff5e);
  color: var(--color-primary, #40ff5e);
  background-color: rgba(64, 255, 94, 0.08);
}

.optionScroll {
  width: 100%;
  height: auto;
  overflow: hidden;
}

.segmented {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  width: 100%;
  min-width: 100%;
  gap: 6px;
}

.adapterGrid {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  width: 100%;
  min-width: 100%;
  gap: 6px;
}

.segmented .segment,
.adapterGrid .segment {
  flex: 0 0 96px;
  width: 96px;
}

.segment {
  padding: 0 6px;
  height: 34px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fieldGroup {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
}

.preview {
  display: block;
  color: rgba(64, 255, 94, 0.6);
  font-size: 13px;
  line-height: 18px;
}

.fieldLabel {
  display: block;
  color: rgba(64, 255, 94, 0.6);
  font-size: 13px;
  line-height: 17px;
}

.logPanel {
  margin-top: 6px;
  padding: 8px;
}

.logLine {
  display: block;
  margin-bottom: 6px;
  color: rgba(64, 255, 94, 0.6);
  font-size: 12px;
  line-height: 17px;
}

@media (max-height: 180px) {
  .pageScroll {
    width: var(--app-width, 480px);
    height: 150px;
    max-height: 150px;
    overflow: hidden;
  }

  .page {
    width: var(--app-width, 480px);
    min-height: 150px;
    max-height: 150px;
    padding: 8px 12px 54px;
    overflow: hidden;
  }

  .compactCard {
    display: flex;
  }

  .unifiedModeHud {
    display: none;
  }
}
</style>
