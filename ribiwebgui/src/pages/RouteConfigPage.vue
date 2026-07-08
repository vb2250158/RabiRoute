<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType, AgentAdapterType, AgentMaturity, AgentScanResult, AgentScanSession, MessageAdapterScanResult, NapCatInstance } from "../types";
import { adapterDefaultWebhookPath, adapterLabel, adapterRuntimeKey, adapterSourceAliases, adapterErrorsFor, applyAdapterDefaults, configNameFor, gatewayAdapterTypes, isAdapterDisabled, isMessageInputsDisabled, isWebhookLikeAdapter, adapterConfigPathFor, setGatewayAdapters, toggleAdapterDisabled } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const runtime = computed(() => store.selectedRuntime);
const adapterQuery = ref("");
const configNameError = ref("");
const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  agents: {} as Partial<Record<AgentAdapterType, AgentScanResult>>,
  loading: false,
});

const messageAdapterScan = ref({
  adapters: {} as Partial<Record<MessageAdapterType, MessageAdapterScanResult>>,
  loading: false
});
type RemoteAgentDeviceStatus = {
  deviceId: string;
  deviceName?: string;
  agentType?: string;
  os?: string;
  osVersion?: string;
  arch?: string;
  declaredIp?: string;
  observedIp?: string;
  host?: string;
  port?: number;
  controlUrl?: string;
  discoveryPort?: number;
  protocolVersion?: number;
  defaultCwd?: string;
  defaultThreadName?: string;
  connected?: boolean;
  passwordSaved?: boolean;
  connectionError?: string;
  discoveredAt?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  lastTaskAt?: string;
};
const remoteAgentDevices = ref<RemoteAgentDeviceStatus[]>([]);
const remoteAgentDevicesLoading = ref(false);
const remoteAgentConnecting = ref(false);
const remoteAgentPassword = ref("");
const remoteAgentConnectResult = ref<{ ok: boolean; message: string } | null>(null);
const remoteAgentDeviceError = ref("");
const remoteAgentDeviceMenu = ref(false);
const addingNapcatInstance = ref(false);
const repairingNapcatAll = ref(false);
const napcatAutoSteps = ref<Record<string, { ok?: boolean; message: string; steps: string[] }>>({});

async function runMessageAdapterScan(): Promise<void> {
  if (messageAdapterScan.value.loading) return;
  messageAdapterScan.value.loading = true;
  try {
    const params = new URLSearchParams();
    if (gateway.value?.id) params.set("gatewayId", gateway.value.id);
    const res = await fetch(`/api/scan/message-adapters${params.toString() ? `?${params}` : ""}`);
    const data = await res.json();
    messageAdapterScan.value.adapters = data.adapters ?? {};
    if (data.repair?.changed || data.gatewayPayload?.data?.config) {
      await store.load();
    }
    await applyNapcatScanHealth(data.napcatHealth);
    if (data.repair?.messages?.length) {
      napcatAutoSteps.value = {
        ...napcatAutoSteps.value,
        backendScan: {
          ok: true,
          message: data.repair.changed ? "后端扫描自测完成，已自动修复基础配置。" : "后端扫描自测完成。",
          steps: data.repair.messages
        }
      };
    }
  } catch { /* ignore */ }
  finally { messageAdapterScan.value.loading = false; }
}

async function rescanNapcatInstances(): Promise<void> {
  await runMessageAdapterScan();
}

async function runAgentScan(): Promise<void> {
  if (agentScan.value.loading) return;
  agentScan.value.loading = true;
  try {
    const res = await fetch("/api/scan/agents");
    const data = await res.json();
    agentScan.value.threadNames = data.threadNames ?? [];
    agentScan.value.cwdOptions = data.cwdOptions ?? [];
    agentScan.value.copilotSessions = data.copilotSessions ?? [];
    agentScan.value.copilotBins = data.copilotBins ?? [];
    agentScan.value.marvisAppIds = data.marvisAppIds ?? [];
    agentScan.value.agents = data.agents ?? {};
  } catch { /* ignore */ }
  finally { agentScan.value.loading = false; }
}

// Copilot CLI 安装/登录
const copilotStatus = ref<{ installed?: boolean; binPath?: string; loggedIn?: boolean; copilotHome?: string } | null>(null);
const copilotInstalling = ref(false);
const copilotLoginState = ref<{ loading: boolean; code: string | null; url: string | null; done: boolean; error: string | null }>({
  loading: false, code: null, url: null, done: false, error: null
});
const agentParamOpen = ref<Record<string, boolean>>({});

async function fetchCopilotStatus(): Promise<void> {
  try {
    const res = await fetch("/api/agent/copilot-status");
    copilotStatus.value = await res.json();
  } catch { /* ignore */ }
}

async function installCopilotCli(): Promise<void> {
  if (copilotInstalling.value) return;
  copilotInstalling.value = true;
  try {
    const res = await fetch("/api/agent/copilot-install", { method: "POST" });
    const data = await res.json();
    if (data.ok) await fetchCopilotStatus();
    else copilotLoginState.value.error = data.stderr || data.error || "安装失败";
  } catch (e) { copilotLoginState.value.error = String(e); }
  finally { copilotInstalling.value = false; }
}

async function startCopilotLogin(): Promise<void> {
  copilotLoginState.value = { loading: true, code: null, url: null, done: false, error: null };
  try {
    const res = await fetch("/api/agent/copilot-login", { method: "POST" });
    const data = await res.json();
    if (data.done) {
      copilotLoginState.value = { loading: false, code: null, url: null, done: true, error: null };
      await fetchCopilotStatus();
    } else if (data.code) {
      copilotLoginState.value = { loading: false, code: data.code, url: data.url, done: false, error: null };
      // Poll for login completion (process exits when done)
      const poll = setInterval(async () => {
        const r2 = await fetch("/api/agent/copilot-status");
        const s = await r2.json();
        if (s.loggedIn) {
          copilotStatus.value = s;
          copilotLoginState.value.done = true;
          copilotLoginState.value.code = null;
          clearInterval(poll);
        }
      }, 3000);
      setTimeout(() => clearInterval(poll), 120_000);
    } else {
      copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: data.error || "启动失败" };
    }
  } catch (e) {
    copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: String(e) };
  }
}

watch(
  () => agentParamOpen.value["copilotCli"],
  (open) => { if (open && copilotStatus.value === null) fetchCopilotStatus(); }
);


const adapterParamOpen = ref<Record<string, boolean>>({
  rolePanel: false,
  napcat: false,
  wecom: false,
  remoteAgent: false,
  heartbeat: false,
  fennenote: false,
  xiaoai: false,
  rabilink: false,
  webhook: false
});
const addAdapterMenu = ref(false);
const adapterCatalogCache = ref<Record<string, MessageAdapterType[]>>({});
const adapterGroups: Array<{ title: string; note: string; choices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> }> = [
  {
    title: "本地桌面",
    note: "RabiRoute 内置的角色面板入口。",
    choices: [
      { type: "rolePanel", title: "角色面板", note: "托盘打开的本地聊天和计划记忆面板", icon: "mdi-view-dashboard-outline" }
    ]
  },
  {
    title: "实时消息",
    note: "来自聊天软件或即时通信平台的入口。",
    choices: [
      { type: "napcat", title: "NapCat / OneBot", note: "接收 QQ 群聊和私聊实时消息", icon: "mdi-message-badge-outline" },
      { type: "wecom", title: "企业微信 / WeCom", note: "接收企业微信群聊并支持回发消息", icon: "mdi-domain" }
    ]
  },
  {
    title: "远端设备",
    note: "连接远端 Agent 设备，让本机人格按需投递下游任务。",
    choices: [
      { type: "remoteAgent", title: "远端 Agent", note: "远端设备只运行独立 bridge，按参数声明实际 Agent 类型", icon: "mdi-lan-connect" }
    ]
  },
  {
    title: "内部触发",
    note: "由 RabiRoute 自己产生的事件。",
    choices: [
      { type: "heartbeat", title: "定时触发", note: "按间隔主动生成内部消息", icon: "mdi-timer-outline" }
    ]
  },
  {
    title: "语音转写",
    note: "来自具体设备或笔记工具的语音输入。",
    choices: [
      { type: "fennenote", title: "FenneNote / 芬妮笔记", note: "接收 FenneNote 桌面语音转写", icon: "mdi-note-edit-outline" },
      { type: "xiaoai", title: "小米音箱 / 小爱", note: "接收小爱音箱语音转写", icon: "mdi-speaker-wireless" },
      { type: "rabilink", title: "RabiLink / Relay 直连", note: "电脑端直连 Relay，转发 Rokid/灵珠文本到 Codex", icon: "mdi-access-point-network" }
    ]
  },
  {
    title: "外部接口",
    note: "未命名系统的 HTTP 兜底入口。",
    choices: [
      { type: "webhook", title: "通用 Webhook", note: "没有专用消息端时的通用外部 POST 兜底入口", icon: "mdi-webhook" }
    ]
  }
];
const gateway = computed(() => store.selectedGateway);

function uniqueAdapters(types: MessageAdapterType[]): MessageAdapterType[] {
  return [...new Set(types.filter((type) => type !== "disabled"))];
}

function configuredAdapterCatalog(gw: NonNullable<typeof gateway.value>): MessageAdapterType[] {
  if (Array.isArray(gw.messageAdapters) && gw.messageAdapters.length > 0) {
    return uniqueAdapters(["rolePanel", ...gw.messageAdapters]);
  }
  const cached = adapterCatalogCache.value[gw.id];
  if (cached?.length) return uniqueAdapters(["rolePanel", ...cached]);
  return uniqueAdapters(["rolePanel", gw.messageAdapterType || "napcat"]);
}

// 所有已添加的 adapter（含禁用），用于 UI 列表显示
const addedAdapters = computed<MessageAdapterType[]>(() => {
  const gw = gateway.value;
  if (!gw) return [];
  return configuredAdapterCatalog(gw);
});
// 仅启用的 adapter（不含禁用）
const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);
const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);
const messageAdapterInactive = computed(() => Boolean(gateway.value?.enabled === false || runtime.value.enabled === false || messageInputsDisabled.value));
const napcatState = computed(() => runtime.value.gatewayStatus?.napcat || {} as Record<string, any>);
const wecomState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.wecom || runtime.value.gatewayStatus?.wecom || {} as Record<string, any>);
const heartbeatState = computed(() => runtime.value.gatewayStatus?.heartbeat || {} as Record<string, any>);
const adapterErrors = (type: MessageAdapterType) => gateway.value ? adapterErrorsFor(type, gateway.value, runtime.value) : [];
const visibleActiveAdapters = computed<MessageAdapterType[]>(() => [...new Set(["rolePanel" as MessageAdapterType, ...adapters.value])]);
const activeAdapterCount = computed(() => visibleActiveAdapters.value.length);
const selectedRemoteAgentDeviceId = computed({
  get: () => gateway.value?.remoteAgentDefaultDeviceId || "",
  set: (value: string | null) => {
    if (!gateway.value) return;
    gateway.value.remoteAgentDefaultDeviceId = String(value || "");
    const selected = remoteAgentDevices.value.find(device => device.deviceId === gateway.value?.remoteAgentDefaultDeviceId);
    if (selected?.defaultCwd && !gateway.value.remoteAgentDefaultCwd) gateway.value.remoteAgentDefaultCwd = selected.defaultCwd;
    if (selected?.defaultThreadName && !gateway.value.remoteAgentDefaultThreadName) gateway.value.remoteAgentDefaultThreadName = selected.defaultThreadName;
    store.touch();
  }
});
const remoteAgentDeviceOptions = computed(() => {
  const configuredId = gateway.value?.remoteAgentDefaultDeviceId?.trim();
  const devices = [...remoteAgentDevices.value];
  if (configuredId && !devices.some(device => device.deviceId === configuredId)) {
    devices.push({ deviceId: configuredId, deviceName: `${configuredId}（未连接）`, connected: false });
  }
  return devices.map(device => ({
    ...device,
    label: remoteAgentDeviceTitle(device),
    subtitle: remoteAgentDeviceSubtitle(device)
  }));
});
const selectedRemoteAgentDevice = computed(() => remoteAgentDevices.value.find(device => device.deviceId === selectedRemoteAgentDeviceId.value));
const selectedRemoteAgentDeviceLabel = computed(() => {
  const option = remoteAgentDeviceOptions.value.find(device => device.deviceId === selectedRemoteAgentDeviceId.value);
  return option?.label || "选择远端 Agent 设备";
});
const remoteAgentConnected = computed(() => remoteAgentDevices.value.some(device => device.connected));
const remoteAgentDiscoveryDetail = computed(() => {
  const requirement = messageScanFor("remoteAgent")?.requirements?.find(item => item.id === "discovery");
  return requirement?.detail || "扫描远端 bridge 公告，无需输入端口。";
});
const testingNapcatHealth = ref(false);
const testingNapcatInstance = ref<Record<string, boolean>>({});
const launchingNapcatInstance = ref<Record<string, boolean>>({});
const restartingNapcatInstance = ref<Record<string, boolean>>({});
const copyingNapcatToken = ref(false);
const copyingNapcatInstanceToken = ref<Record<string, boolean>>({});
const fixingNapcatPorts = ref(false);
const napcatPortFixResult = ref<Record<string, { ok: boolean; message: string }>>({});
const configuringNapcatOneBot = ref<Record<string, boolean>>({});
const napcatOneBotFixResult = ref<Record<string, { ok: boolean; message: string }>>({});
const napcatHealthResult = ref<{
  ok?: boolean;
  fixAvailable?: boolean;
  diagnostics?: string[];
  onebot?: { configPath?: string; currentUserId?: string | number; currentNickname?: string };
  loginInfo?: { userId?: string | number; nickname?: string; online?: boolean; source?: string };
  http?: { ok?: boolean; status?: number; message?: string; userId?: string | number; nickname?: string };
  webui?: {
    url?: string;
    reachable?: boolean;
    found?: boolean;
    tokenFound?: boolean;
    token?: string;
    tokenLength?: number;
    configPath?: string;
    source?: "provided" | "config";
    loginUrl?: string;
    message?: string;
  };
  process?: { found?: boolean; candidates?: Array<{ name: string; pid: string }> };
  wsUrl?: string;
  message?: string;
} | null>(null);
const napcatInstanceHealthResult = ref<Record<string, typeof napcatHealthResult.value>>({});
const napcatLaunchResult = ref<Record<string, { ok: boolean; message: string }>>({});
const autoCheckingNapcat = ref(false);
const lastAutoNapcatHealthKey = ref("");
const napcatHealthPausedAfterFix = ref<Record<string, boolean>>({});
const copyResult = ref("");
const triggeringHeartbeat = ref(false);
const heartbeatTriggerResult = ref<{ ok: boolean; message: string } | null>(null);
const deletingGateway = ref(false);
const deleteError = ref("");
const openingMarvis = ref(false);
const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);
const visibleAdapterGroups = computed(() => {
  const query = adapterQuery.value.trim().toLowerCase();
  return adapterGroups
    .map(group => ({
      ...group,
      choices: group.choices.filter(choice => {
        if (!addedAdapters.value.includes(choice.type)) return false;
        if (!query) return true;
        return [
          group.title,
          group.note,
          choice.type,
          choice.title,
          choice.note
        ].join(" ").toLowerCase().includes(query);
      })
    }))
    .filter(group => group.choices.length > 0);
});
const codexCwdOptions = computed(() => {
  const values = new Set<string>();
  store.gateways.forEach(item => {
    if (item.codexCwd) values.add(item.codexCwd);
  });
  return [...values];
});

function toggleAdapter(type: MessageAdapterType): void {
  if (type === "rolePanel") return;
  if (!gateway.value) return;
  toggleAdapterDisabled(gateway.value, type);
  store.touch();
}

function hasAdapterParams(type: MessageAdapterType): boolean {
  return type === "rolePanel" || type === "napcat" || type === "wecom" || type === "remoteAgent" || type === "heartbeat" || isWebhookLikeAdapter(type);
}

function adapterLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function adapterLogPaths(type: MessageAdapterType): string[] {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function messageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function messageFilePaths(type: MessageAdapterType): string[] {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function formatLogTime(entry: Record<string, any>): string {
  const ms = Number(entry.timeMs || 0);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toLocaleString();
  }
  if (entry.time) return String(entry.time);
  return "-";
}

function logPreview(entry: Record<string, any>): string {
  const text = String(entry.text || entry.message || "");
  if (text) return text;
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function logEventTitle(entry: Record<string, any>): string {
  return [entry.level && entry.level !== "info" ? String(entry.level) : "", entry.event || entry.source || "log"]
    .filter(Boolean)
    .join(" · ");
}

function rawLogJson(entry: Record<string, any>): string {
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function toggleAdapterParams(type: MessageAdapterType): void {
  adapterParamOpen.value[type] = !adapterParamOpen.value[type];
  if (adapterParamOpen.value[type]) void runMessageAdapterScan();
  if (adapterParamOpen.value[type] && type === "remoteAgent") void refreshRemoteAgentDevices();
}

function removeAdapter(type: MessageAdapterType): void {
  if (type === "rolePanel") return;
  if (!gateway.value) return;
  const next = adapters.value.filter(t => t !== type);
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = false;
  store.touch();
}

const availableToAdd = computed(() => {
  const allTypes: MessageAdapterType[] = ["napcat", "wecom", "remoteAgent", "heartbeat", "fennenote", "xiaoai", "rabilink", "webhook"];
  return allTypes.filter(t => !addedAdapters.value.includes(t));
});

watch(
  () => [gateway.value?.id, gateway.value?.messageAdapterType, JSON.stringify(gateway.value?.messageAdapters ?? [])] as const,
  ([id]) => {
    const configured = Array.isArray(gateway.value?.messageAdapters)
      ? uniqueAdapters(gateway.value.messageAdapters)
      : [];
    if (!id || configured.length === 0) return;
    adapterCatalogCache.value = {
      ...adapterCatalogCache.value,
      [id]: addedAdapters.value
    };
  },
  { immediate: true }
);

watch(
  () => [gateway.value?.id, adapterParamOpen.value.remoteAgent] as const,
  ([id, open]) => {
    if (id && open) void refreshRemoteAgentDevices();
  }
);

function addAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = [...addedAdapters.value, type];
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = true;
  void runMessageAdapterScan();
  if (type === "remoteAgent") void refreshRemoteAgentDevices();
  store.touch();
}

function touch(): void {
  if (gateway.value) applyAdapterDefaults(gateway.value);
  if (gateway.value?.messageAdapters?.includes("napcat") || gateway.value?.messageAdapterType === "napcat") {
    syncPrimaryNapcatFromInstances();
  }
  store.touch();
}

function defaultNapcatWebuiUrl(): string {
  const scanned = messageAdapterScan.value.adapters.napcat?.endpoints?.find(endpoint => endpoint.healthy)?.url;
  return scanned || gateway.value?.napcatWebuiUrl?.trim() || "http://127.0.0.1:6099/webui";
}

function ensureNapcatInstances(): NapCatInstance[] {
  if (!gateway.value) return [];
  if (!Array.isArray(gateway.value.napcatInstances) || gateway.value.napcatInstances.length === 0) {
    gateway.value.napcatInstances = [{
      id: "default",
      name: "默认 NapCat",
      enabled: true,
      gatewayPort: gateway.value.gatewayPort || 8789,
      httpUrl: gateway.value.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: gateway.value.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: gateway.value.napcatAccessToken || "",
      webuiToken: gateway.value.napcatWebuiToken || ""
    }];
  }
  return gateway.value.napcatInstances;
}

function syncPrimaryNapcatFromInstances(): void {
  if (!gateway.value) return;
  const primary = ensureNapcatInstances().find((item) => item.enabled !== false) ?? ensureNapcatInstances()[0];
  if (!primary) return;
  gateway.value.gatewayPort = Number(primary.gatewayPort || gateway.value.gatewayPort || 8790);
  gateway.value.napcatHttpUrl = primary.httpUrl || gateway.value.napcatHttpUrl;
  gateway.value.napcatWebuiUrl = primary.webuiUrl || gateway.value.napcatWebuiUrl;
  gateway.value.napcatAccessToken = primary.accessToken || gateway.value.napcatAccessToken;
  gateway.value.napcatWebuiToken = primary.webuiToken || gateway.value.napcatWebuiToken;
}

function nextNapcatPort(base: number): number {
  const used = new Set<number>([
    Number(store.meta.managerPort || 8790),
    ...ensureNapcatInstances().map((item) => Number(item.gatewayPort)),
    ...store.gateways.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.fenneNoteWebhookPort),
      Number(item.xiaoaiWebhookPort),
      Number(item.rabiLinkWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ]),
    ...store.managerRows.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.fenneNoteWebhookPort),
      Number(item.xiaoaiWebhookPort),
      Number(item.rabiLinkWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ])
  ].filter(port => Number.isFinite(port) && port > 0));
  let port = base;
  while (used.has(port)) port += 1;
  return port;
}

function allocateAvailablePort(used: Set<number>, base: number): number {
  let port = Math.max(1, Math.min(65535, Number(base) || 8790));
  while (port <= 65535 && used.has(port)) port += 1;
  if (port > 65535) {
    throw new Error("没有可用端口了，请手动释放一个 1-65535 范围内的端口。");
  }
  used.add(port);
  return port;
}

function autoAssignNapcatPortsForAllGateways(): boolean {
  const usedWs = new Set<number>();
  const usedHttp = new Set<number>();
  const usedWebui = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWs.add(port);
  };

  claim(store.meta.managerPort || 8790);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("fennenote")) claim(item.fenneNoteWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("xiaoai")) claim(item.xiaoaiWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("rabilink")) claim(item.rabiLinkWebhookPort ?? item.webhookPort ?? item.gatewayPort);
  }

  let changed = false;
  const claimHttp = (url: string | undefined): void => {
    const port = portFromLocalUrl(url);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedHttp.add(port);
  };
  const claimWebui = (url: string | undefined): void => {
    const port = portFromLocalUrl(url);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWebui.add(port);
  };
  for (const item of store.gateways) {
    if (!gatewayAdapterTypes(item).includes("napcat")) continue;
    const instances = Array.isArray(item.napcatInstances) && item.napcatInstances.length > 0
      ? item.napcatInstances
      : [{
          id: "default",
          name: "默认 NapCat",
          enabled: true,
          gatewayPort: item.gatewayPort,
          httpUrl: item.napcatHttpUrl || "http://127.0.0.1:3000",
          webuiUrl: item.napcatWebuiUrl || defaultNapcatWebuiUrl(),
          accessToken: item.napcatAccessToken || "",
          webuiToken: item.napcatWebuiToken || ""
        } as NapCatInstance];
    item.napcatInstances = instances;
    for (const instance of instances) {
      if (instance.enabled === false) continue;
      const current = Number(instance.gatewayPort || 0);
      if (!Number.isInteger(current) || current < 1 || current > 65535 || usedWs.has(current)) {
        instance.gatewayPort = allocateAvailablePort(usedWs, Math.max(current + 1, Number(item.gatewayPort || 8789) + 1));
        changed = true;
      } else {
        usedWs.add(current);
      }

      const httpPort = portFromLocalUrl(instance.httpUrl);
      if (!httpPort || usedHttp.has(httpPort)) {
        instance.httpUrl = nextAvailableLocalUrl(instance.httpUrl || item.napcatHttpUrl || "http://127.0.0.1:3000", usedHttp, 3000);
        changed = true;
      } else {
        claimHttp(instance.httpUrl);
      }

      const webuiPort = portFromLocalUrl(instance.webuiUrl);
      if (!webuiPort || usedWebui.has(webuiPort)) {
        instance.webuiUrl = nextAvailableLocalUrl(instance.webuiUrl || item.napcatWebuiUrl || defaultNapcatWebuiUrl(), usedWebui, 6099);
        changed = true;
      } else {
        claimWebui(instance.webuiUrl);
      }
    }
    const primary = instances.find(instance => instance.enabled !== false) ?? instances[0];
    if (primary && Number(item.gatewayPort || 0) !== Number(primary.gatewayPort || 0)) {
      item.gatewayPort = Number(primary.gatewayPort);
      item.napcatHttpUrl = primary.httpUrl || item.napcatHttpUrl;
      item.napcatWebuiUrl = primary.webuiUrl || item.napcatWebuiUrl;
      item.napcatAccessToken = primary.accessToken || item.napcatAccessToken;
      item.napcatWebuiToken = primary.webuiToken || item.napcatWebuiToken;
      changed = true;
    }
  }
  if (changed) store.touch();
  return changed;
}

function portFromLocalUrl(value: string | undefined): number {
  try {
    return Number(new URL(value || "").port || 0);
  } catch {
    return 0;
  }
}

function nextAvailableLocalUrl(baseUrl: string, used: Set<number>, fallbackPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
  } catch {
    parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
  }
  const original = Number(parsed.port || fallbackPort);
  const port = allocateAvailablePort(used, original || fallbackPort);
  parsed.port = String(port);
  return parsed.toString().replace(/\/$/, "");
}

function nextLocalHttpUrl(baseUrl: string, fallbackPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
  } catch {
    parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
  }
  const used = new Set<number>([
    ...ensureNapcatInstances().flatMap(item => [
      portFromLocalUrl(item.httpUrl),
      portFromLocalUrl(item.webuiUrl)
    ]),
    ...store.gateways.flatMap(item => [
      portFromLocalUrl(item.napcatHttpUrl),
      portFromLocalUrl(item.napcatWebuiUrl),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.flatMap(instance => [
        portFromLocalUrl(instance.httpUrl),
        portFromLocalUrl(instance.webuiUrl)
      ]) : [])
    ])
  ].filter(port => Number.isFinite(port) && port > 0));
  let port = Number(parsed.port || fallbackPort);
  while (used.has(port)) port += 1;
  parsed.port = String(port);
  return parsed.toString().replace(/\/$/, "");
}

function recentNapcatTemplate(): Partial<NapCatInstance> {
  const configured = ensureNapcatInstances();
  return [...configured].reverse().find(instance =>
    Boolean(instance.launchCommand || instance.workingDir || instance.webuiUrl || instance.accessToken)
  ) || configured[0] || {};
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstance>): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoredNapcatKeys(): Set<string> {
  return new Set((gateway.value?.ignoredNapcatInstanceIds ?? []).map(item => String(item || "").trim()).filter(Boolean));
}

function isIgnoredNapcatInstance(instance: Partial<NapCatInstance>): boolean {
  const ignored = ignoredNapcatKeys();
  return napcatInstanceIgnoreKeys(instance).some(key => ignored.has(key));
}

function clearIgnoredNapcatInstance(instance: Partial<NapCatInstance>): void {
  if (!gateway.value?.ignoredNapcatInstanceIds?.length) return;
  const keys = new Set(napcatInstanceIgnoreKeys(instance));
  const next = gateway.value.ignoredNapcatInstanceIds.filter(item => !keys.has(String(item || "").trim()));
  if (next.length !== gateway.value.ignoredNapcatInstanceIds.length) {
    gateway.value.ignoredNapcatInstanceIds = next;
    store.touch();
  }
}

function ignoreNapcatInstance(instance: Partial<NapCatInstance>): void {
  if (!gateway.value) return;
  const next = new Set((gateway.value.ignoredNapcatInstanceIds ?? []).map(item => String(item || "").trim()).filter(Boolean));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  gateway.value.ignoredNapcatInstanceIds = [...next];
  store.touch();
}

function clearNapcatInstanceUiState(id: string): void {
  for (const state of [
    napcatInstanceHealthResult,
    napcatLaunchResult,
    napcatPortFixResult,
    napcatOneBotFixResult,
    napcatHealthPausedAfterFix,
    testingNapcatInstance,
    launchingNapcatInstance,
    copyingNapcatInstanceToken,
    configuringNapcatOneBot
  ]) {
    const next = { ...state.value };
    delete next[id];
    state.value = next;
  }
}

async function addNapcatInstance(): Promise<void> {
  if (!gateway.value) return;
  addingNapcatInstance.value = true;
  const pendingId = `pending-${Date.now()}`;
  napcatAutoSteps.value = {
    ...napcatAutoSteps.value,
    [pendingId]: {
      message: "正在准备 NapCat 实例...",
      steps: ["正在准备 NapCat 实例..."]
    }
  };
  try {
    if (store.dirty) await store.save();
    const resp = await fetch("/api/message/napcat-add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id })
    });
    const body = await resp.json().catch(() => ({}));
    const instanceId = body?.instance?.id || pendingId;
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      [instanceId]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已创建并启动 NapCat。" : "添加 QQ 失败。"),
        steps: Array.isArray(body.steps) && body.steps.length ? body.steps : [body.message || "添加 QQ 失败。"]
      }
    };
    delete napcatAutoSteps.value[pendingId];
    await store.load();
    await runMessageAdapterScan();
    const target = body?.loginUrl || body?.webuiUrl || body?.instance?.webuiUrl;
    if (resp.ok && target) {
      openExternalUrl(target);
    }
  } catch (e: unknown) {
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      [pendingId]: {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        steps: [e instanceof Error ? e.message : String(e)]
      }
    };
  } finally {
    addingNapcatInstance.value = false;
  }
}

function napcatRemovePayload(instance: NapCatInstance): Record<string, unknown> {
  return {
    gatewayId: gateway.value?.id,
    instanceId: instance.id,
    name: instance.name,
    gatewayPort: instance.gatewayPort,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl,
    accessToken: instance.accessToken,
    webuiToken: instance.webuiToken,
    launchCommand: instance.launchCommand,
    workingDir: instance.workingDir,
    botUserId: napcatAccountUserId(instance),
    botNickname: napcatAccountNickname(instance)
  };
}

async function removeNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  napcatLaunchResult.value = {
    ...napcatLaunchResult.value,
    [instance.id]: { ok: true, message: "正在退出登录并停止 NapCat..." }
  };
  try {
    if (store.dirty) await store.save();
    const resp = await fetch("/api/message/napcat-remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatRemovePayload(instance))
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已退出登录、停止并移除。" : "删除失败。")
      }
    };
    if (resp.ok && body.ok !== false) {
      ignoreNapcatInstance(instance);
      clearNapcatInstanceUiState(instance.id);
      if (store.dirty) await store.save();
    }
    await store.load();
    await runMessageAdapterScan();
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  }
}

function removeNapcatInstanceById(id: string): void {
  const instance = napcatAccountInstances().find(item => item.id === id);
  if (instance) void removeNapcatInstance(instance);
}

function isConfiguredNapcatInstance(instance: NapCatInstance): boolean {
  return ensureNapcatInstances().some(item => sameNapcatInstance(item as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>));
}

async function setNapcatInstanceEnabled(instance: NapCatInstance, value: boolean | null): Promise<void> {
  const enabled = value === true;
  const configured = ensureNapcatInstances().find(item => sameNapcatInstance(item as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>));
  if (configured) {
    configured.enabled = enabled;
    instance.enabled = enabled;
    syncPrimaryNapcatFromInstances();
    store.touch();
    await store.save();
    return;
  }

  instance.enabled = enabled;
  if (enabled) {
    addDiscoveredNapcatInstance(instance);
    await store.save();
  }
}

function openExternalUrl(url: string | undefined): void {
  const target = url?.trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function napcatWsUrl(): string {
  return `ws://127.0.0.1:${gateway.value?.gatewayPort || 8790}`;
}

function napcatInstanceWsUrl(instance: NapCatInstance): string {
  return `ws://127.0.0.1:${instance.gatewayPort || 8790}`;
}

function webhookPortFor(type: MessageAdapterType): number {
  if (type === "fennenote") return Number(gateway.value?.fenneNoteWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  if (type === "xiaoai") return Number(gateway.value?.xiaoaiWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  if (type === "rabilink") return Number(gateway.value?.rabiLinkWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
  return Number(gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
}

function webhookPathFor(type: MessageAdapterType): string {
  if (type === "fennenote") return gateway.value?.fenneNoteWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "xiaoai") return gateway.value?.xiaoaiWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "rabilink") return gateway.value?.rabiLinkWebhookPath || adapterDefaultWebhookPath(type);
  return gateway.value?.webhookPath || adapterDefaultWebhookPath(type);
}

function webhookHostFor(type: MessageAdapterType): string {
  if (type === "rabilink") return gateway.value?.rabiLinkWebhookHost || "0.0.0.0";
  return "127.0.0.1";
}

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function localCallbackHost(): string {
  const browserHost = window.location.hostname;
  if (browserHost && !isUnspecifiedHttpHost(browserHost) && browserHost !== "localhost" && !browserHost.startsWith("127.")) {
    return browserHost;
  }
  return store.networkOptions.localAddresses?.find((item) => item.address)?.address || "127.0.0.1";
}

function callbackHostFor(type: MessageAdapterType): string {
  const host = webhookHostFor(type);
  return type === "rabilink" && isUnspecifiedHttpHost(host) ? localCallbackHost() : host;
}

function setWebhookPort(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const port = Number(value || 0);
  if (type === "fennenote") gateway.value.fenneNoteWebhookPort = port;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPort = port;
  else if (type === "rabilink") gateway.value.rabiLinkWebhookPort = port;
  else gateway.value.webhookPort = port;
  touch();
}

function setWebhookPath(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const path = String(value || "");
  if (type === "fennenote") gateway.value.fenneNoteWebhookPath = path;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPath = path;
  else if (type === "rabilink") gateway.value.rabiLinkWebhookPath = path;
  else gateway.value.webhookPath = path;
  touch();
}

function setWebhookHost(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value || type !== "rabilink") return;
  gateway.value.rabiLinkWebhookHost = String(value || "").trim() || "0.0.0.0";
  touch();
}

function webhookUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${webhookHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function callbackUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${callbackHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookTestEventType(type: MessageAdapterType): string {
  if (type === "fennenote") return "fennenote.transcript";
  if (type === "xiaoai") return "xiaoai.transcript";
  if (type === "rabilink") return "rabilink.message";
  return "webhook.text";
}

function webhookCurl(type: MessageAdapterType = "webhook"): string {
  const source = adapterSourceAliases(type)[0] || type;
  const eventType = webhookTestEventType(type);
  return `curl -X POST "${callbackUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"${eventType}\",\"message\":\"hello from RabiRoute\"}"`;
}
function sourceLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return adapterLogEntries(type);
}

function sourceMessageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return messageFileEntries(type);
}

function sourceTitle(type: MessageAdapterType): string {
  return adapterLabel(type);
}

function messageScanFor(type: MessageAdapterType): MessageAdapterScanResult | undefined {
  return messageAdapterScan.value.adapters[type];
}

function remoteAgentDeviceTitle(device: RemoteAgentDeviceStatus): string {
  const name = device.deviceName || device.deviceId;
  return name === device.deviceId ? name : `${name} (${device.deviceId})`;
}

function remoteAgentDeviceSubtitle(device: RemoteAgentDeviceStatus): string {
  const status = device.connected ? "已连接" : device.connectionError ? "连接异常" : "已发现";
  const system = [device.os, device.osVersion, device.arch].filter(Boolean).join(" ");
  const ip = device.observedIp || device.declaredIp || device.host || "";
  const password = device.passwordSaved ? "已记住密码" : "";
  return [status, device.agentType, system, ip, password].filter(Boolean).join(" · ");
}

function selectRemoteAgentDevice(deviceId: string): void {
  selectedRemoteAgentDeviceId.value = deviceId;
  remoteAgentConnectResult.value = null;
  remoteAgentDeviceMenu.value = false;
}

async function refreshRemoteAgentDevices(): Promise<void> {
  if (remoteAgentDevicesLoading.value) return;
  remoteAgentDevicesLoading.value = true;
  remoteAgentDeviceError.value = "";
  try {
    const res = await fetch("/api/remote-agent/devices");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : [];
  } catch (error: unknown) {
    remoteAgentDeviceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteAgentDevicesLoading.value = false;
  }
}

async function scanRemoteAgentDevices(): Promise<void> {
  if (remoteAgentDevicesLoading.value) return;
  remoteAgentDevicesLoading.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/scan", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : [];
    const selectedId = selectedRemoteAgentDeviceId.value;
    if (!selectedId && remoteAgentDevices.value[0]) {
      selectedRemoteAgentDeviceId.value = remoteAgentDevices.value[0].deviceId;
    }
  } catch (error: unknown) {
    remoteAgentDeviceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteAgentDevicesLoading.value = false;
  }
}

async function connectRemoteAgentDevice(): Promise<void> {
  if (!selectedRemoteAgentDeviceId.value || remoteAgentConnecting.value) return;
  remoteAgentConnecting.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: selectedRemoteAgentDeviceId.value,
        password: remoteAgentPassword.value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : remoteAgentDevices.value;
    const device = data.device as RemoteAgentDeviceStatus | undefined;
    if (device?.deviceId && gateway.value) {
      gateway.value.remoteAgentDefaultDeviceId = device.deviceId;
      if (device.defaultCwd && !gateway.value.remoteAgentDefaultCwd) gateway.value.remoteAgentDefaultCwd = device.defaultCwd;
      if (device.defaultThreadName && !gateway.value.remoteAgentDefaultThreadName) gateway.value.remoteAgentDefaultThreadName = device.defaultThreadName;
      store.touch();
    }
    remoteAgentPassword.value = "";
    remoteAgentConnectResult.value = { ok: true, message: "已连接远端 Agent，密码已记住。" };
  } catch (error: unknown) {
    remoteAgentConnectResult.value = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    remoteAgentConnecting.value = false;
  }
}

async function disconnectRemoteAgentDevice(): Promise<void> {
  if (!selectedRemoteAgentDeviceId.value || remoteAgentConnecting.value) return;
  remoteAgentConnecting.value = true;
  remoteAgentDeviceError.value = "";
  remoteAgentConnectResult.value = null;
  try {
    const res = await fetch("/api/remote-agent/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: selectedRemoteAgentDeviceId.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code === -1) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    remoteAgentDevices.value = Array.isArray(data.devices) ? data.devices : remoteAgentDevices.value;
    remoteAgentConnectResult.value = { ok: true, message: "已断开远端 Agent。" };
  } catch (error: unknown) {
    remoteAgentConnectResult.value = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    remoteAgentConnecting.value = false;
  }
}

function requirementColor(requirement: { ok?: boolean }): string {
  if (requirement.ok === true) return "success";
  if (requirement.ok === false) return "warning";
  return "secondary";
}

function requirementLabel(requirement: { ok?: boolean; required?: boolean }): string {
  if (requirement.ok === true) return "已满足";
  if (requirement.ok === false) return requirement.required ? "缺少" : "未发现";
  return "需确认";
}

function scanConnectionLabel(scan?: MessageAdapterScanResult): string {
  if (!scan) return messageAdapterScan.value.loading ? "扫描中" : "未扫描";
  const required = scan.requirements?.filter(item => item.required) ?? [];
  if (required.some(item => item.ok === false)) return "缺配置";
  if (scan.endpoints?.some(endpoint => endpoint.healthy === false)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function scanConnectionColor(scan?: MessageAdapterScanResult): string {
  const label = scanConnectionLabel(scan);
  if (label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描") return "secondary";
  return "warning";
}

function openScanCandidate(candidate: { url?: string; path?: string }): void {
  if (candidate.url) {
    openExternalUrl(candidate.url);
    return;
  }
  if (candidate.path) void copyText(candidate.path, "已复制本地路径");
}

function napcatRuntimeInstances(): Record<string, any>[] {
  const raw = napcatState.value.instances ?? napcatState.value.napcatInstances ?? runtime.value.gatewayStatus?.napcatInstances;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.entries(raw).map(([id, value]) => ({ id, ...(value as Record<string, any>) }));
  return [];
}

function napcatInstanceSourceId(instance: Partial<NapCatInstance> & Record<string, any>): string {
  return String(instance.sourceInstanceId || instance.instanceId || instance.id || "").trim();
}

function napcatInstanceScope(instance: Partial<NapCatInstance> & Record<string, any>): string {
  return String(instance.routeId || instance.gatewayId || instance.configName || gateway.value?.id || "").trim();
}

function sameNapcatInstance(left: Partial<NapCatInstance> & Record<string, any>, right: Partial<NapCatInstance> & Record<string, any>): boolean {
  const leftPort = Number(left.gatewayPort || left.port || left.wsPort || 0);
  const rightPort = Number(right.gatewayPort || right.port || right.wsPort || 0);
  if (leftPort > 0 && rightPort > 0 && leftPort === rightPort) return true;

  const leftHttp = String(left.httpUrl || left.napcatHttpUrl || "").trim();
  const rightHttp = String(right.httpUrl || right.napcatHttpUrl || "").trim();
  if (leftHttp && rightHttp && leftHttp === rightHttp) return true;

  const leftId = napcatInstanceSourceId(left);
  const rightId = napcatInstanceSourceId(right);
  if (!leftId || !rightId || leftId !== rightId) return false;

  return napcatInstanceScope(left) === napcatInstanceScope(right);
}

function scopedRuntimeNapcatId(item: Record<string, any>, rawId: string, port: number): string {
  const scope = napcatInstanceScope(item).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  const id = rawId || `ws-${port || "unknown"}`;
  if (!scope || scope === gateway.value?.id || scope === store.configNameFor(gateway.value as any)) return id;
  return `${scope}-${id}`;
}

function napcatIdFromFile(file: string | undefined, fallback: string): string {
  const raw = String(file || "").replace(/\.json$/i, "");
  const match = raw.match(/onebot11[_-]?(.+)?$/i);
  return (match?.[1] || raw || fallback).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || fallback;
}

function portFromWsOption(option: Record<string, any>): number {
  const raw = option.value || option.port || option.url;
  const direct = Number(raw);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    return Number(new URL(String(option.url || raw)).port || 0);
  } catch {
    const match = String(raw || "").match(/:(\d+)(?:\/|$)/);
    return Number(match?.[1] || 0);
  }
}

function napcatDiscoveredInstances(): NapCatInstance[] {
  const napcatOptions = ((store.networkOptions.adapters as Record<string, any>)?.napcat || {}) as {
    httpServers?: Array<Record<string, any>>;
    websocketClients?: Array<Record<string, any>>;
  };
  const byKey = new Map<string, Partial<NapCatInstance> & { file?: string }>();
  const keyFor = (item: Record<string, any>, index: number) => String(item.file || item.configPath || item.value || item.url || `discovered-${index + 1}`);

  (napcatOptions.httpServers || []).forEach((server, index) => {
    const key = keyFor(server, index);
    const current = byKey.get(key) || {};
    byKey.set(key, {
      ...current,
      file: server.file,
      id: current.id || napcatIdFromFile(server.file, `discovered-${index + 1}`),
      name: current.name || napcatIdFromFile(server.file, `QQ ${index + 1}`),
      httpUrl: String(server.value || server.url || current.httpUrl || ""),
      webuiUrl: current.webuiUrl || defaultNapcatWebuiUrl()
    });
  });

  (napcatOptions.websocketClients || []).forEach((client, index) => {
    const key = keyFor(client, index);
    const current = byKey.get(key) || {};
    const port = portFromWsOption(client);
    byKey.set(key, {
      ...current,
      file: client.file,
      id: current.id || napcatIdFromFile(client.file, `discovered-${index + 1}`),
      name: current.name || napcatIdFromFile(client.file, `QQ ${index + 1}`),
      gatewayPort: port || current.gatewayPort,
      webuiUrl: current.webuiUrl || defaultNapcatWebuiUrl()
    });
  });

  return [...byKey.values()]
    .filter(item => {
      const httpPort = portFromLocalUrl(item.httpUrl);
      const webuiPort = portFromLocalUrl(item.webuiUrl);
      return Boolean((item.gatewayPort || httpPort) && (httpPort || webuiPort));
    })
    .map((item, index) => ({
      id: String(item.id || `discovered-${index + 1}`),
      name: String(item.name || item.id || `QQ ${index + 1}`),
      enabled: false,
      gatewayPort: Number(item.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + index + 1)),
      httpUrl: String(item.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000 + index)),
      webuiUrl: String(item.webuiUrl || defaultNapcatWebuiUrl()),
      accessToken: "",
      webuiToken: "",
      ...(item as Record<string, any>),
      __discovered: true
    } as NapCatInstance));
}

function napcatAccountInstances(): NapCatInstance[] {
  const configured = ensureNapcatInstances();
  const merged = [...configured];
  const pushIfMissing = (candidate: NapCatInstance) => {
    if (isIgnoredNapcatInstance(candidate)) return;
    const exists = merged.some(instance => sameNapcatInstance(instance as NapCatInstance & Record<string, any>, candidate as NapCatInstance & Record<string, any>));
    if (!exists) merged.push(candidate);
  };
  for (const item of napcatRuntimeInstances()) {
    const sourceInstanceId = String(item.id || item.instanceId || item.name || item.botUserId || item.userId || item.selfId || "");
    const port = Number(item.gatewayPort || item.port || item.wsPort || 0);
    const exists = merged.some(instance => sameNapcatInstance(instance as NapCatInstance & Record<string, any>, item as Record<string, any>));
    if (exists) continue;
    const candidate = {
      id: scopedRuntimeNapcatId(item, sourceInstanceId, port) || `runtime-${merged.length + 1}`,
      sourceInstanceId,
      routeId: item.routeId,
      configName: item.configName,
      name: item.name || item.instanceName || "运行中 NapCat",
      enabled: false,
      gatewayPort: port || Number(gateway.value?.gatewayPort || 8790),
      httpUrl: item.httpUrl || item.napcatHttpUrl || gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl || item.napcatWebuiUrl || gateway.value?.napcatWebuiUrl,
      accessToken: item.accessToken || "",
      webuiToken: item.webuiToken || "",
      botUserId: item.botUserId || item.userId || item.selfId,
      botNickname: item.botNickname || item.nickname,
      connected: item.connected
    };
    if (!isIgnoredNapcatInstance(candidate)) merged.push(candidate);
  }
  for (const instance of napcatDiscoveredInstances()) {
    pushIfMissing(instance);
  }
  return merged;
}

function addDiscoveredNapcatInstance(instance: NapCatInstance): void {
  const configured = ensureNapcatInstances();
  clearIgnoredNapcatInstance(instance);
  const clean = { ...instance } as NapCatInstance & Record<string, any>;
  delete clean.__discovered;
  delete clean.sourceInstanceId;
  delete clean.routeId;
  delete clean.configName;
  delete clean.botUserId;
  delete clean.botNickname;
  delete clean.connected;
  clean.enabled = true;
  clean.name = clean.name || `QQ ${configured.length + 1}`;
  clean.gatewayPort = Number(clean.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + 1));
  clean.httpUrl = clean.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000 + configured.length);
  clean.webuiUrl = clean.webuiUrl || defaultNapcatWebuiUrl();
  configured.push(clean);
  syncPrimaryNapcatFromInstances();
  store.touch();
}

function matchingDiscoveredNapcatInstance(instance: NapCatInstance): NapCatInstance | undefined {
  const id = String(instance.id || "");
  const port = Number(instance.gatewayPort || 0);
  const httpUrl = String(instance.httpUrl || "");
  return napcatDiscoveredInstances().find(item =>
    (id && String(item.id) === id) ||
    (port && Number(item.gatewayPort || 0) === port) ||
    (httpUrl && String(item.httpUrl || "") === httpUrl)
  );
}

async function autofillNapcatInstance(instance: NapCatInstance): Promise<boolean> {
  if (!messageAdapterScan.value.adapters.napcat && !messageAdapterScan.value.loading) {
    await runMessageAdapterScan();
  }
  const discovered = matchingDiscoveredNapcatInstance(instance);
  const template = recentNapcatTemplate();
  let changed = false;
  const fill = <K extends keyof NapCatInstance>(key: K, value: NapCatInstance[K] | undefined): void => {
    if (instance[key] != null && String(instance[key]).trim()) return;
    if (value == null || !String(value).trim()) return;
    instance[key] = value;
    changed = true;
  };

  fill("httpUrl", discovered?.httpUrl || template.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000));
  fill("webuiUrl", discovered?.webuiUrl || template.webuiUrl || defaultNapcatWebuiUrl());
  fill("accessToken", template.accessToken || "");
  fill("launchCommand", discovered?.launchCommand || template.launchCommand);
  fill("workingDir", discovered?.workingDir || template.workingDir);
  if (!isValidPort(instance.gatewayPort)) {
    instance.gatewayPort = discovered?.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + 1);
    changed = true;
  }
  if (changed) {
    syncPrimaryNapcatFromInstances();
    store.touch();
  }
  return changed;
}

function webuiTokenMissing(body: Record<string, any>): boolean {
  return !(body.webui?.tokenFound || body.webui?.found || body.webui?.token || body.webui?.loginUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function runNapcatInstanceHealth(instance: NapCatInstance): Promise<Record<string, any>> {
  const resp = await fetch("/api/message/napcat-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(napcatHealthPayload(instance))
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: Boolean(body.ok), ...body };
}

function resolveConfiguredNapcatInstance(instance: NapCatInstance): NapCatInstance {
  return ensureNapcatInstances().find(item => item.id === instance.id) ?? instance;
}

function applyNapcatHealthToInstance(instance: NapCatInstance, body: Record<string, any>, options: { updateConfig?: boolean } = {}): boolean {
  if (options.updateConfig === false) return false;
  let changed = false;
  const userId = body.http?.userId || body.loginInfo?.userId || body.webui?.loginInfo?.userId;
  const nickname = body.http?.nickname || body.loginInfo?.nickname || body.webui?.loginInfo?.nickname;
  if (userId && !instance.botUserId) {
    instance.botUserId = userId;
    changed = true;
  }
  if (nickname && !instance.botNickname) {
    instance.botNickname = nickname;
    changed = true;
  }
  const correctedWebuiUrl = body.webui?.correctedUrl || body.webui?.correctedWebuiUrl || body.webui?.url;
  if (correctedWebuiUrl && instance.webuiUrl !== correctedWebuiUrl) {
    instance.webuiUrl = correctedWebuiUrl;
    changed = true;
  }
  if (changed) store.touch();
  return changed;
}

async function applyNapcatScanHealth(payload: unknown): Promise<void> {
  if (!gateway.value || !payload || typeof payload !== "object") return;
  const byGateway = payload as Record<string, { instances?: Record<string, Record<string, any>> }>;
  const current = byGateway[gateway.value.id]?.instances;
  if (!current || typeof current !== "object") return;
  const nextHealth = { ...napcatInstanceHealthResult.value };
  const nextPaused = { ...napcatHealthPausedAfterFix.value };
  for (const [id, raw] of Object.entries(current)) {
    const body = { ok: Boolean(raw?.ok), ...(raw || {}) };
    nextHealth[id] = body;
    delete nextPaused[id];
  }
  napcatInstanceHealthResult.value = nextHealth;
  napcatHealthPausedAfterFix.value = nextPaused;
}

function napcatHealthUserId(body: Record<string, any>): string {
  return String(body.http?.userId || body.loginInfo?.userId || body.webui?.loginInfo?.userId || "");
}

function napcatInstanceCanBeManaged(instance: NapCatInstance): boolean {
  return Boolean(instance.launchCommand?.trim() && instance.workingDir?.trim());
}

function normalizedLocalEndpoint(value: string | undefined): string {
  try {
    const parsed = new URL(value || "");
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${parsed.hostname}:${port}`.toLowerCase();
  } catch {
    return "";
  }
}

async function cleanupNapcatInstancesAfterScan(): Promise<boolean> {
  if (!gateway.value || !gatewayAdapterTypes(gateway.value).includes("napcat")) return false;
  const instances = Array.isArray(gateway.value.napcatInstances) ? gateway.value.napcatInstances : [];
  if (instances.length === 0) return false;

  let changed = false;
  const seenUsers = new Set<string>();
  const seenWebui = new Set<string>();
  const seenHttp = new Set<string>();
  const seenWs = new Set<number>();
  const kept: NapCatInstance[] = [];

  for (const instance of instances) {
    let health: Record<string, any> = {};
    try {
      health = await runNapcatInstanceHealth(instance);
      napcatInstanceHealthResult.value[instance.id] = health;
      if (applyNapcatHealthToInstance(instance, health)) changed = true;
    } catch {
      health = {};
    }

    const userId = napcatHealthUserId(health) || String(instance.botUserId || "");
    const webuiKey = normalizedLocalEndpoint(instance.webuiUrl);
    const httpKey = normalizedLocalEndpoint(instance.httpUrl);
    const wsPort = Number(instance.gatewayPort || 0);
    const healthy = Boolean(health.ok || userId);
    const manageable = napcatInstanceCanBeManaged(instance);
    const duplicateUser = Boolean(userId && seenUsers.has(userId));
    const duplicateWebui = Boolean(webuiKey && seenWebui.has(webuiKey));
    const duplicateHttp = Boolean(httpKey && seenHttp.has(httpKey));
    const duplicateWs = Boolean(Number.isInteger(wsPort) && wsPort > 0 && seenWs.has(wsPort));
    const staleGenerated = !manageable && !healthy;
    const duplicate = duplicateUser || duplicateWebui || duplicateHttp || duplicateWs;

    if (duplicate || staleGenerated) {
      changed = true;
      continue;
    }

    kept.push(instance);
    if (userId) seenUsers.add(userId);
    if (webuiKey) seenWebui.add(webuiKey);
    if (httpKey) seenHttp.add(httpKey);
    if (Number.isInteger(wsPort) && wsPort > 0) seenWs.add(wsPort);
  }

  if (kept.length !== instances.length) {
    gateway.value.napcatInstances = kept;
    changed = true;
  }
  if (autoAssignNapcatPortsForAllGateways()) changed = true;
  syncPrimaryNapcatFromInstances();
  if (changed) store.touch();
  return changed;
}

function collectUsedWsPorts(excludeInstance?: NapCatInstance): Set<number> {
  const used = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) used.add(port);
  };
  claim(store.meta.managerPort || 8790);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("fennenote")) claim(item.fenneNoteWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("xiaoai")) claim(item.xiaoaiWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("rabilink")) claim(item.rabiLinkWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    for (const instance of item.napcatInstances ?? []) {
      if (excludeInstance && item.id === gateway.value?.id && instance.id === excludeInstance.id) continue;
      if (instance.enabled === false) continue;
      claim(instance.gatewayPort);
    }
  }
  return used;
}

async function fixNapcatPorts(instance?: NapCatInstance): Promise<void> {
  if (fixingNapcatPorts.value) return;
  fixingNapcatPorts.value = true;
  const resultKey = instance?.id || "_global";
  try {
    const beforePort = Number(instance?.gatewayPort || 0);
    if (instance && !isConfiguredNapcatInstance(instance)) {
      addDiscoveredNapcatInstance(instance);
    }
    autoAssignNapcatPortsForAllGateways();
    if (instance) {
      const target = resolveConfiguredNapcatInstance(instance);
      if (Number(target.gatewayPort || 0) === beforePort || !isValidPort(target.gatewayPort)) {
        const used = collectUsedWsPorts(target);
        target.gatewayPort = allocateAvailablePort(used, Math.max(beforePort + 1, Number(gateway.value?.gatewayPort || 8789) + 1));
        syncPrimaryNapcatFromInstances();
        store.touch();
      }
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [target.id]: {
          ok: true,
          fixAvailable: false,
          message: `已自动分配 RabiRoute WS 端口：${target.gatewayPort}。请把对应 NapCat WebSocket Client 连接到 ws://127.0.0.1:${target.gatewayPort}。`,
          diagnostics: ["旧检查结果已失效，请在 NapCat 侧重载网络配置后再点检查。"],
          wsUrl: `ws://127.0.0.1:${target.gatewayPort}`
        }
      };
      napcatPortFixResult.value = {
        ...napcatPortFixResult.value,
        [resultKey]: { ok: true, message: `已分配端口 ${target.gatewayPort} 并保存。` }
      };
    }
    if (store.dirty) {
      await store.save();
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    store.error = message;
    napcatPortFixResult.value = {
      ...napcatPortFixResult.value,
      [resultKey]: { ok: false, message }
    };
  } finally {
    fixingNapcatPorts.value = false;
  }
}

async function configureNapcatOneBot(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: true };
  napcatOneBotFixResult.value = { ...napcatOneBotFixResult.value, [instance.id]: { ok: true, message: "正在写入 NapCat OneBot 配置..." } };
  try {
    let target = resolveConfiguredNapcatInstance(instance);
    const resp = await fetch("/api/message/napcat-configure-onebot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(target))
    });
    const body = await resp.json().catch(() => ({}));
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [target.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已写入 NapCat OneBot 配置。" : "写入失败。")
      }
    };
    if (body.userId && !target.botUserId) target.botUserId = body.userId;
    if (body.nickname && !target.botNickname) target.botNickname = body.nickname;
    if (body.userId || body.nickname) {
      store.touch();
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: {
        ok: Boolean(body.httpReady),
        fixAvailable: false,
        message: body.message || "已写入 NapCat OneBot 配置；请重载 NapCat 网络配置后复查。",
        diagnostics: Array.isArray(body.steps) && body.steps.length
          ? body.steps
          : ["配置已写入当前登录 QQ 的 OneBot 文件。", "如果 HTTP 仍未连通，请稍后再点检查。"],
        onebot: {
          ...(napcatInstanceHealthResult.value[target.id]?.onebot || {}),
          currentUserId: body.userId,
          currentNickname: body.nickname,
          configPath: body.configPath
        },
        wsUrl: body.wsUrl || napcatInstanceWsUrl(target)
      }
    };
    napcatHealthPausedAfterFix.value = {
      ...napcatHealthPausedAfterFix.value,
      [target.id]: true,
      [instance.id]: true
    };
  } catch (e: unknown) {
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: false };
  }
}

async function autoConfigureNapcatOneBotIfAvailable(instance: NapCatInstance, body: Record<string, any>): Promise<Record<string, any>> {
  if (!gateway.value || !body?.fixAvailable) return body;
  configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: true };
  try {
    const resp = await fetch("/api/message/napcat-configure-onebot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(instance))
    });
    const fixBody = await resp.json().catch(() => ({}));
    const steps = Array.isArray(fixBody.steps) ? fixBody.steps : [];
    const diagnostics = [
      ...(Array.isArray(body.diagnostics) ? body.diagnostics : []),
      ...(steps.length ? steps : [fixBody.message || "已尝试自动写入 NapCat OneBot 配置。"])
    ];
    napcatOneBotFixResult.value = {
      ...napcatOneBotFixResult.value,
      [instance.id]: {
        ok: resp.ok && fixBody.ok !== false,
        message: fixBody.message || (resp.ok ? "已自动写入 NapCat OneBot 配置。" : "自动写入 NapCat 配置失败。")
      }
    };
    if (fixBody.userId && !instance.botUserId) instance.botUserId = fixBody.userId;
    if (fixBody.nickname && !instance.botNickname) instance.botNickname = fixBody.nickname;
    if (fixBody.webuiToken && !instance.webuiToken) instance.webuiToken = fixBody.webuiToken;
    if (fixBody.userId || fixBody.nickname || fixBody.webuiToken) store.touch();
    return {
      ...body,
      ok: Boolean(fixBody.httpReady) || Boolean(body.ok),
      fixAvailable: false,
      message: fixBody.message || body.message,
      diagnostics,
      onebot: {
        ...(body.onebot || {}),
        currentUserId: fixBody.userId || body.onebot?.currentUserId,
        currentNickname: fixBody.nickname || body.onebot?.currentNickname,
        configPath: fixBody.configPath || body.onebot?.configPath
      },
      wsUrl: fixBody.wsUrl || body.wsUrl || napcatInstanceWsUrl(instance)
    };
  } finally {
    configuringNapcatOneBot.value = { ...configuringNapcatOneBot.value, [instance.id]: false };
  }
}

async function prepareNapcatInstanceForWebui(instance: NapCatInstance): Promise<NapCatInstance> {
  if (!gateway.value) return instance;
  let target = instance;
  const wasConfigured = isConfiguredNapcatInstance(target);
  if (!wasConfigured) {
    addDiscoveredNapcatInstance(target);
    target = ensureNapcatInstances().find(item => item.id === instance.id) ?? target;
  }
  if (!wasConfigured) target.enabled = true;
  await autofillNapcatInstance(target);
  autoAssignNapcatPortsForAllGateways();
  syncPrimaryNapcatFromInstances();
  store.touch();
  if (store.dirty) {
    await store.save();
    target = resolveConfiguredNapcatInstance(target);
  }
  return target;
}

function napcatRuntimeFor(instance: NapCatInstance): Record<string, any> {
  const id = String(instance.id || "");
  const port = Number(instance.gatewayPort || 0);
  const found = napcatRuntimeInstances().find(item =>
    sameNapcatInstance(instance as NapCatInstance & Record<string, any>, item as Record<string, any>)
  );
  if (found) return found;
  if (id === "default" || port === Number(gateway.value?.gatewayPort || 0)) return napcatState.value;
  return {};
}

function napcatHealthFor(instance: NapCatInstance): Record<string, any> {
  return napcatInstanceHealthResult.value[instance.id] ?? {};
}

function napcatAccountUserId(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || health.loginInfo?.userId || health.webui?.loginInfo?.userId || "");
}

function napcatAccountNickname(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botNickname || runtimeInfo.botNickname || runtimeInfo.nickname || health.http?.nickname || health.loginInfo?.nickname || health.webui?.loginInfo?.nickname || "");
}

function napcatAccountTitle(instance: NapCatInstance): string {
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询 QQ 状态";
  return napcatAccountUserId(instance) || "未登录 QQ";
}

function napcatAccountSubtitle(instance: NapCatInstance): string {
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "加载 NapCat 登录资料...";
  return napcatAccountNickname(instance) || "等待 QQ 登录";
}

function napcatAccountLogTitle(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const nickname = napcatAccountNickname(instance);
  if (userId && nickname) return `${userId} / ${nickname}`;
  return userId || nickname || "未登录 QQ";
}

function napcatAccountConnected(instance: NapCatInstance): boolean {
  if (napcatAccountOffline(instance)) return false;
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  if (typeof instance.connected === "boolean") return instance.connected;
  if (typeof runtimeInfo.connected === "boolean") return runtimeInfo.connected;
  if (health.http?.ok) return true;
  if (health.loginInfo?.online === true || health.webui?.loginInfo?.online === true) return true;
  return false;
}

function napcatAccountOffline(instance: NapCatInstance): boolean {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return runtimeInfo.online === false
    || runtimeInfo.good === false
    || health.http?.online === false
    || health.http?.good === false
    || health.loginInfo?.online === false
    || health.webui?.loginInfo?.online === false
    || /online:false|已离线/.test(String(runtimeInfo.loginInfoError || instance.loginInfoError || ""));
}

function napcatPrimaryOffline(): boolean {
  return napcatState.value.online === false
    || napcatState.value.good === false
    || /online:false|已离线/.test(String(napcatState.value.loginInfoError || ""));
}

function napcatAccountLoginLabel(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const runtimeInfo = napcatRuntimeFor(instance);
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return String(runtimeInfo.loginInfoError || instance.loginInfoError);
  if (userId && (napcatHealthFor(instance).loginInfo?.source === "webui" || napcatHealthFor(instance).webui?.loginInfo)) return "WebUI 已登录";
  if (userId) return "已登录";
  return "等待 QQ 登录";
}

function isValidPort(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function napcatInstancePortError(instance: NapCatInstance): string {
  return isValidPort(instance.gatewayPort) ? "" : "端口必须是 1-65535 的整数";
}

function napcatInstanceStatusLabel(instance: NapCatInstance): string {
  if ((instance as Record<string, any>).__discovered && !isConfiguredNapcatInstance(instance)) return "已发现";
  if (instance.enabled === false) return "已停用";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "查询中";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  if (napcatAccountConnected(instance)) return "WS 已连接";
  if (napcatHealthFor(instance).loginInfo?.source === "webui" || napcatHealthFor(instance).webui?.loginInfo) return "WebUI 已登录";
  if (napcatAccountUserId(instance)) return "HTTP 已登录";
  if (napcatAccountLoginLabel(instance) !== "等待 QQ 登录") return "登录异常";
  return "待检查";
}

function napcatInstanceStatusColor(instance: NapCatInstance): string {
  if ((instance as Record<string, any>).__discovered && !isConfiguredNapcatInstance(instance)) return "info";
  if (instance.enabled === false) return "secondary";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "info";
  if (napcatAccountOffline(instance)) return "error";
  if (napcatAccountConnected(instance)) return "success";
  if (napcatAccountUserId(instance)) return "info";
  const runtimeInfo = napcatRuntimeFor(instance);
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return "error";
  return "warning";
}

function napcatEnabledCount(): number {
  return ensureNapcatInstances().filter(instance => instance.enabled !== false).length;
}

function napcatConnectedCount(): number {
  return napcatAccountInstances().filter(instance => instance.enabled !== false && napcatAccountConnected(instance)).length;
}

function napcatAutoFixTargets(): NapCatInstance[] {
  return ensureNapcatInstances().filter(instance =>
    instance.enabled !== false && Boolean(napcatInstanceHealthResult.value[instance.id]?.fixAvailable)
  );
}

function napcatAutoFixCount(): number {
  return napcatAutoFixTargets().length;
}

function napcatRepairAllSteps(body: Record<string, any>): string[] {
  const steps: string[] = [];
  if (Array.isArray(body.repair?.messages)) steps.push(...body.repair.messages);
  for (const result of Array.isArray(body.results) ? body.results : []) {
    const instanceId = result?.instanceId ? ` ${result.instanceId}` : "";
    const message = result?.message || (result?.ok ? "已处理。" : "处理失败。");
    if (result?.action === "configure-onebot") {
      steps.push(`NapCat${instanceId}：${message}`);
    } else if (result?.action === "health-check") {
      steps.push(`自测${instanceId}：${message}`);
    } else {
      steps.push(String(message));
    }
  }
  return steps.length ? steps : ["没有发现可自动修复项。"];
}

async function repairAllNapcatIssues(): Promise<void> {
  if (repairingNapcatAll.value || !gateway.value) return;
  repairingNapcatAll.value = true;
  napcatAutoSteps.value = {
    ...napcatAutoSteps.value,
    repairAll: {
      message: "正在修复扫描发现的可自动处理项...",
      steps: ["正在写入 RabiRoute 端口配置和 NapCat OneBot 配置。"]
    }
  };
  try {
    const resp = await fetch("/api/message/napcat-repair-all", { method: "POST" });
    const body = await resp.json().catch(() => ({}));
    if (body.repair?.changed || body.gatewayPayload?.data?.config) {
      await store.load();
    }
    await applyNapcatScanHealth(body.napcatHealth);
    const fixedResults = new Map<string, Record<string, any>>();
    for (const result of Array.isArray(body.results) ? body.results : []) {
      if (
        result?.ok &&
        result?.instanceId &&
        (result?.action === "configure-onebot" || result?.reloadRequired || result?.wsUrl)
      ) {
        fixedResults.set(String(result.instanceId), result);
      }
    }
    if (fixedResults.size > 0) {
      napcatHealthPausedAfterFix.value = {
        ...napcatHealthPausedAfterFix.value,
        ...Object.fromEntries([...fixedResults.keys()].map(id => [id, true]))
      };
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        ...Object.fromEntries([...fixedResults.entries()].map(([id, result]) => {
          const current = napcatInstanceHealthResult.value[id] || {};
          return [id, {
            ok: true,
            fixAvailable: false,
            message: result.message || "已写入 NapCat OneBot 配置；请在 NapCat WebUI 保存/重载网络配置或重启 NapCat 后重新扫描。",
            diagnostics: [
              "配置已写入，但运行中的 NapCat 可能需要保存/重载网络配置后才会开放 OneBot HTTP。"
            ],
            onebot: {
              ...(current.onebot || {}),
              currentUserId: result.userId || current.onebot?.currentUserId,
              currentNickname: result.nickname || current.onebot?.currentNickname,
              configPath: result.configPath || current.onebot?.configPath
            },
            webui: current.webui,
            wsUrl: result.wsUrl || current.wsUrl
          }];
        }))
      };
    }
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      repairAll: {
        ok: resp.ok && body.ok !== false,
        message: resp.ok && body.ok !== false ? "已修复全部可自动处理项。" : (body.message || "修复失败。"),
        steps: napcatRepairAllSteps(body)
      }
    };
  } catch (e: unknown) {
    napcatAutoSteps.value = {
      ...napcatAutoSteps.value,
      repairAll: {
        ok: false,
        message: "修复失败。",
        steps: [e instanceof Error ? e.message : String(e)]
      }
    };
  } finally {
    repairingNapcatAll.value = false;
  }
}

function napcatConfiguredCount(): number {
  return ensureNapcatInstances().length;
}

function napcatSetupHint(): string {
  const instances = ensureNapcatInstances();
  if (instances.length === 0) return "先添加一个 QQ 实例。";
  const invalid = instances.find(instance => instance.enabled !== false && !isValidPort(instance.gatewayPort));
  if (invalid) return `${invalid.name || invalid.id} 的 WS 端口无效，保存前需要改成 1-65535。`;
  const enabled = instances.filter(instance => instance.enabled !== false);
  if (enabled.length === 0) return "当前没有启用的 QQ；保存后不会启动 NapCat 监听，也不会参与路由。";
  if (!enabled.some(instance => napcatAccountConnected(instance))) return "下一步：检查实例，打开对应 NapCat WebUI，把 WebSocket Client 指向该实例的 WS 地址。";
  return "已看到可用连接；收到消息后会按来源实例投递和回复。";
}

function napcatEntryMatchesInstance(entry: Record<string, any>, instance: NapCatInstance, allowUnscoped: boolean): boolean {
  const instanceIds = [entry.instanceId, entry.napcatInstanceId, entry.adapterInstanceId, entry.raw?.instanceId].filter(Boolean).map(String);
  const userIds = [entry.botUserId, entry.selfId, entry.RobotQQId, entry.raw?.botUserId, entry.raw?.self_id].filter(Boolean).map(String);
  const ports = [entry.gatewayPort, entry.port, entry.wsPort, entry.raw?.gatewayPort].filter(Boolean).map(Number);
  const hasScope = instanceIds.length > 0 || userIds.length > 0 || ports.length > 0;
  if (!hasScope) return allowUnscoped;
  const targetUserId = napcatAccountUserId(instance);
  return instanceIds.includes(String(instance.id)) ||
    (targetUserId ? userIds.includes(targetUserId) : false) ||
    ports.includes(Number(instance.gatewayPort || 0));
}

function napcatLogEntriesFor(instance: NapCatInstance): Array<Record<string, any>> {
  const instances = napcatAccountInstances();
  const allowUnscoped = instances.length === 1;
  return adapterLogEntries("napcat").filter(entry => napcatEntryMatchesInstance(entry, instance, allowUnscoped));
}

function napcatMessageFileEntriesFor(instance: NapCatInstance): Array<Record<string, any>> {
  const instances = napcatAccountInstances();
  const allowUnscoped = instances.length === 1;
  return messageFileEntries("napcat").filter(entry => napcatEntryMatchesInstance(entry, instance, allowUnscoped));
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copyResult.value = message;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    copyResult.value = message;
  }
  window.setTimeout(() => {
    if (copyResult.value === message) copyResult.value = "";
  }, 1800);
}

function showCopyResult(message: string): void {
  copyResult.value = message;
  window.setTimeout(() => {
    if (copyResult.value === message) copyResult.value = "";
  }, 2400);
}

function openRuntimeLog(): void {
  void router.push("/runtime");
}

async function deleteCurrentGateway(): Promise<void> {
  if (!gateway.value || deletingGateway.value) return;
  const name = store.configNameFor(gateway.value);
  const confirmed = window.confirm(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`);
  if (!confirmed) return;
  deletingGateway.value = true;
  deleteError.value = "";
  try {
    await store.deleteGateway(gateway.value.id);
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingGateway.value = false;
  }
}

async function triggerHeartbeatNow(): Promise<void> {
  if (!gateway.value || triggeringHeartbeat.value) return;
  triggeringHeartbeat.value = true;
  heartbeatTriggerResult.value = null;
  try {
    await store.manualTriggerGateway(gateway.value.id, {
      triggerId: "heartbeat-now",
      triggerName: "立即触发心跳",
      routeKind: "heartbeat",
      message: gateway.value.heartbeatMessage || "定时心跳巡检：请检查最近消息和角色相关上下文。"
    });
    heartbeatTriggerResult.value = { ok: true, message: "已提交一次心跳触发，请到运行日志查看投递结果。" };
  } catch (e: unknown) {
    heartbeatTriggerResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    triggeringHeartbeat.value = false;
  }
}

async function openMarvis(): Promise<void> {
  if (openingMarvis.value) return;
  openingMarvis.value = true;
  marvisOpenResult.value = null;
  try {
    const resp = await fetch("/api/agent/marvis-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: gateway.value?.marvisAppId })
    });
    const body = await resp.json().catch(() => ({}));
    marvisOpenResult.value = {
      ok: resp.ok && body.ok !== false,
      message: body.message || (resp.ok ? "已尝试打开 Marvis。" : "打开 Marvis 失败。")
    };
  } catch (e: unknown) {
    marvisOpenResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    openingMarvis.value = false;
  }
}

async function testNapcatHealth(): Promise<void> {
  if (!gateway.value) return;
  testingNapcatHealth.value = true;
  napcatHealthResult.value = null;
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: gateway.value.napcatHttpUrl,
        webuiUrl: defaultNapcatWebuiUrl(),
        accessToken: gateway.value.napcatAccessToken,
        webuiToken: gateway.value.napcatWebuiToken,
        gatewayPort: gateway.value.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
  } catch (e: unknown) {
    napcatHealthResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    testingNapcatHealth.value = false;
  }
}

function napcatHealthPayload(instance?: NapCatInstance): Record<string, unknown> {
  if (instance) {
    return {
      gatewayId: gateway.value?.id,
      instanceId: instance.id,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl || defaultNapcatWebuiUrl(),
      accessToken: instance.accessToken,
      webuiToken: instance.webuiToken,
      gatewayPort: instance.gatewayPort
    };
  }
  return {
    gatewayId: gateway.value?.id,
    httpUrl: gateway.value?.napcatHttpUrl,
    webuiUrl: defaultNapcatWebuiUrl(),
    accessToken: gateway.value?.napcatAccessToken,
    webuiToken: gateway.value?.napcatWebuiToken,
    gatewayPort: gateway.value?.gatewayPort
  };
}

function napcatWebuiUrlWithToken(webuiUrl: string | undefined, token: string | undefined): string {
  const url = webuiUrl?.trim() || defaultNapcatWebuiUrl();
  const value = token?.trim();
  if (!value) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("token", value);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(value)}`;
  }
}

async function openNapcatWebuiWithToken(instance?: NapCatInstance): Promise<void> {
  try {
    const targetInstance = instance ? await prepareNapcatInstanceForWebui(instance) : undefined;
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(targetInstance))
    });
    const body = await resp.json().catch(() => ({}));
    let result = { ok: Boolean(body.ok), ...body };
    if (targetInstance) {
      if (applyNapcatHealthToInstance(targetInstance, result) && store.dirty) {
        await store.save();
      }
      result = await autoConfigureNapcatOneBotIfAvailable(targetInstance, result);
      if (store.dirty) {
        await store.save();
      }
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [targetInstance.id]: result
      };
    } else {
      napcatHealthResult.value = result;
    }
    const target = result?.webui?.loginUrl
      || (result?.webui?.token ? napcatWebuiUrlWithToken(result?.webui?.url || targetInstance?.webuiUrl || defaultNapcatWebuiUrl(), result.webui.token) : "")
      || (result?.webui?.reachable ? result?.webui?.url : "");
    if (target) {
      openExternalUrl(target);
      return;
    }
    const message = result?.webui?.message || result?.message || `NapCat WebUI 未响应：${targetInstance?.webuiUrl || defaultNapcatWebuiUrl()}`;
    const failed = { ok: false, ...result, message };
    if (targetInstance?.id) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [targetInstance.id]: failed
      };
    } else {
      napcatHealthResult.value = failed;
    }
  } catch (e: unknown) {
    const failed = { ok: false, message: e instanceof Error ? e.message : String(e) };
    if (instance?.id) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [instance.id]: failed
      };
    } else {
      napcatHealthResult.value = failed;
    }
  }
}

async function copyNapcatWebuiToken(instance?: NapCatInstance): Promise<void> {
  if (instance?.id) {
    copyingNapcatInstanceToken.value = { ...copyingNapcatInstanceToken.value, [instance.id]: true };
  } else {
    copyingNapcatToken.value = true;
  }
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(instance))
    });
    const body = await resp.json().catch(() => ({}));
    if (instance?.id) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [instance.id]: { ok: Boolean(body.ok), ...body }
      };
    } else {
      napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
    }
    const token = body?.webui?.token;
    if (token) {
      await copyText(token, "已复制 NapCat WebUI 登录密钥");
    } else {
      showCopyResult(body?.webui?.message || "未读取到 NapCat WebUI 登录密钥，请检查 NapCat config/webui.json 或启动日志。");
    }
  } catch (e: unknown) {
    showCopyResult(e instanceof Error ? e.message : String(e));
  } finally {
    if (instance?.id) {
      copyingNapcatInstanceToken.value = { ...copyingNapcatInstanceToken.value, [instance.id]: false };
    } else {
      copyingNapcatToken.value = false;
    }
  }
}

async function testNapcatInstanceHealth(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  testingNapcatInstance.value = { ...testingNapcatInstance.value, [instance.id]: true };
  napcatInstanceHealthResult.value = { ...napcatInstanceHealthResult.value, [instance.id]: null };
  const nextPaused = { ...napcatHealthPausedAfterFix.value };
  delete nextPaused[instance.id];
  napcatHealthPausedAfterFix.value = nextPaused;
  const nextOneBotFix = { ...napcatOneBotFixResult.value };
  delete nextOneBotFix[instance.id];
  napcatOneBotFixResult.value = nextOneBotFix;
  try {
    let target = instance;
    if (!isConfiguredNapcatInstance(target)) {
      addDiscoveredNapcatInstance(target);
      target = ensureNapcatInstances().find(item => item.id === instance.id) ?? target;
    }
    await autofillNapcatInstance(target);
    autoAssignNapcatPortsForAllGateways();
    if (store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }

    let body = await runNapcatInstanceHealth(target);
    if (applyNapcatHealthToInstance(target, body) && store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }

    if (webuiTokenMissing(body) && target.launchCommand && isConfiguredNapcatInstance(target)) {
      napcatLaunchResult.value = {
        ...napcatLaunchResult.value,
        [target.id]: { ok: true, message: "未读到 WebUI 登录密钥，正在尝试启动 NapCat 后台后复查..." }
      };
      const launchResp = await fetch("/api/message/napcat-launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: target.id })
      });
      const launchBody = await launchResp.json().catch(() => ({}));
      napcatLaunchResult.value = {
        ...napcatLaunchResult.value,
        [target.id]: {
          ok: launchResp.ok && launchBody.ok !== false,
          message: launchBody.message || (launchResp.ok ? "已尝试启动 NapCat 后台，正在复查。" : "启动失败。")
        }
      };
      if (launchResp.ok && launchBody.ok !== false) {
        await sleep(2500);
        target = resolveConfiguredNapcatInstance(target);
        body = await runNapcatInstanceHealth(target);
        applyNapcatHealthToInstance(target, body);
      }
    }

    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: body
    };
    if (store.dirty) {
      await store.save();
    }
  } catch (e: unknown) {
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    testingNapcatInstance.value = { ...testingNapcatInstance.value, [instance.id]: false };
  }
}

async function launchNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: true };
  napcatLaunchResult.value = { ...napcatLaunchResult.value, [instance.id]: { ok: true, message: "正在启动..." } };
  try {
    const resp = await fetch("/api/message/napcat-launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: instance.id })
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已尝试启动 NapCat 后台。" : "启动失败。")
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    launchingNapcatInstance.value = { ...launchingNapcatInstance.value, [instance.id]: false };
  }
}

async function restartNapcatInstance(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  restartingNapcatInstance.value = { ...restartingNapcatInstance.value, [instance.id]: true };
  napcatLaunchResult.value = { ...napcatLaunchResult.value, [instance.id]: { ok: true, message: "正在重启 NapCat..." } };
  try {
    if (store.dirty) await store.save();
    const resp = await fetch("/api/message/napcat-restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: instance.id })
    });
    const body = await resp.json().catch(() => ({}));
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: {
        ok: resp.ok && body.ok !== false,
        message: body.message || (resp.ok ? "已尝试重启 NapCat。" : "重启失败。")
      }
    };
    await sleep(2500);
    await testNapcatInstanceHealth(resolveConfiguredNapcatInstance(instance));
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    restartingNapcatInstance.value = { ...restartingNapcatInstance.value, [instance.id]: false };
  }
}

function renameCurrentConfig(value: unknown): void {
  if (!gateway.value) return;
  const result = store.renameGatewayConfig(gateway.value.id, value);
  configNameError.value = result.message || "";
}

const agentDefs: Array<{ type: AgentAdapterType; title: string; note: string; icon: string; hasCwd: boolean; hasThread: boolean }> = [
  { type: "codex",       title: "Codex",          note: "投递到当前 Codex 聊天线程",       icon: "mdi-monitor-dashboard", hasCwd: true, hasThread: true },
  { type: "copilotCli",  title: "Copilot CLI",   note: "通过 GitHub Copilot CLI 投递消息",  icon: "mdi-robot-outline", hasCwd: true, hasThread: true },
  { type: "marvis",      title: "Marvis",         note: "打开 Marvis 并复制 prompt（人工接力）", icon: "mdi-message-processing-outline", hasCwd: false, hasThread: false },
  { type: "astrbot",     title: "AstrBot",         note: "通过 AstrBot ChatUI / 机器人框架投递消息",    icon: "mdi-robot-happy-outline", hasCwd: false, hasThread: false },
];

const addAgentMenu = ref(false);
const deployingAstrbot = ref(false);
const astrbotDeployResult = ref<{ ok: boolean; message: string; detail?: string } | null>(null);
const testingAstrbotLogin = ref(false);
const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);

const agentTypes = computed(() => gateway.value?.agentAdapters ?? []);
const visibleAgentItems = computed(() => agentDefs.filter(a => agentTypes.value.includes(a.type)));
const availableAgentsToAdd = computed(() => agentDefs.filter(a => !agentTypes.value.includes(a.type)));

function agentStateFor(type: AgentAdapterType): Record<string, any> {
  const states = runtime.value.agentStates;
  if (states) return states[type] ?? {};
  const runtimeAgents = runtime.value.agentAdapters ?? [];
  const canUseLegacyCodexState = type === "codex"
    && (runtimeAgents.length === 0 || runtimeAgents.includes(type))
    && (!runtime.value.codexState?.agentAdapterType || runtime.value.codexState.agentAdapterType === type);
  return canUseLegacyCodexState ? runtime.value.codexState ?? {} : {};
}

function codexDeliveryChannelLabel(state: Record<string, any>): string {
  if (state.lastDeliveryChannel === "desktop-ipc") return "Codex Desktop IPC";
  if (state.lastDeliveryChannel === "app-server-fallback") return "app-server fallback";
  return "-";
}

function codexDeliveryVisibilityLabel(state: Record<string, any>): string {
  if (state.lastDeliveryVisibility === "desktop-client-confirmed") return "当前 Desktop 客户端已确认";
  if (state.lastDeliveryVisibility === "desktop-client-not-loaded") return "Desktop 会话未确认加载";
  if (state.lastDeliveryVisibility === "unknown") return "可见性未知";
  return "-";
}

function normalizeClientPath(value?: string): string {
  return (value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left?: string, right?: string): boolean {
  const a = normalizeClientPath(left);
  const b = normalizeClientPath(right);
  return Boolean(a && b && a === b);
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined {
  const scan = agentScan.value.agents[type];
  if (type !== "astrbot" || !gateway.value) return scan;

  const localUrl = gateway.value.astrbotUrl?.trim();
  const localPassword = gateway.value.astrbotPassword?.trim();
  const endpoints = [...(scan?.endpoints ?? [])];
  if (localUrl && !endpoints.some(endpoint => endpoint.url === localUrl)) {
    endpoints.unshift({ label: "当前 AstrBot", url: localUrl });
  }

  if (!scan) {
    return {
      type: "astrbot",
      label: "AstrBot",
      maturity: "experimental",
      installed: false,
      auth: {
        required: true,
        loggedIn: false,
        message: localPassword ? "已填写本地 AstrBot 密码，保存后写入 route 配置。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。"
      },
      endpoints,
      warnings: []
    };
  }

  return {
    ...scan,
    endpoints,
    auth: localPassword
      ? {
          ...(scan.auth ?? { required: true }),
          required: true,
          loggedIn: scan.auth?.loggedIn,
          message: scan.auth?.loggedIn ? scan.auth.message : (scan.auth?.message || "已填写本地 AstrBot 密码，尚未验证登录。")
        }
      : scan.auth
  };
}

function maturityLabel(value?: AgentMaturity): string {
  if (value === "verified") return "已验证";
  if (value === "stub") return "占位";
  return "实验";
}

function maturityColor(value?: AgentMaturity): string {
  if (value === "verified") return "success";
  if (value === "stub") return "grey";
  return "warning";
}

function agentConnectionLabel(type: AgentAdapterType): string {
  const scan = agentScanFor(type);
  if (!scan) return agentScan.value.loading ? "扫描中" : "未扫描";
  if (scan.auth?.required && scan.auth.loggedIn === false) return "未登录";
  if (scan.plugins?.some(plugin => !plugin.installed)) return "插件缺失";
  if (scan.endpoints?.length && !scan.endpoints.some(endpoint => endpoint.healthy)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function agentConnectionColor(type: AgentAdapterType): string {
  const label = agentConnectionLabel(type);
  if (label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描") return "secondary";
  if (label === "未登录" || label === "插件缺失" || label === "未连接") return "warning";
  return "error";
}

function currentAgentProject(type: AgentAdapterType): string {
  if (!gateway.value) return "";
  if (type === "copilotCli") return gateway.value.copilotCwd || "";
  if (type === "codex") return gateway.value.codexCwd || "";
  return "";
}

function fallbackCodexThreadName(): string {
  if (!gateway.value) return "RabiRoute";
  return gateway.value.routeName || gateway.value.name || store.configNameFor(gateway.value) || gateway.value.id || "RabiRoute";
}

function agentProjectItems(type: AgentAdapterType): string[] {
  const projects = agentScanFor(type)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(type: AgentAdapterType): AgentScanSession[] {
  const sessions = agentScanFor(type)?.sessions;
  if (sessions) return sessions;
  if (type === "copilotCli") {
    return agentScan.value.copilotSessions.map(session => ({
      name: session.name,
      projectPath: session.cwd,
      userNamed: session.userNamed
    }));
  }
  if (type === "codex") {
    return agentScan.value.threadNames.map(name => ({ name }));
  }
  return [];
}

function astrbotProjectItems(): Array<{ title: string; value: string; path?: string }> {
  return (agentScanFor("astrbot")?.projects ?? []).map(project => ({
    title: project.label || project.path || project.id || "未命名项目",
    value: project.id || project.path,
    path: project.path
  }));
}

function astrbotSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  const projectId = gateway.value?.astrbotProjectId || "";
  return (agentScanFor("astrbot")?.sessions ?? [])
    .filter(session => !projectId || session.projectId === projectId)
    .map(session => ({
      title: session.name,
      value: session.id || session.name,
      subtitle: session.projectPath || session.updatedAt
    }));
}

function selectAstrbotProject(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotProjectId = String(value || "");
  const sessions = astrbotSessionItems();
  if (gateway.value.astrbotSessionId && !sessions.some(session => session.value === gateway.value?.astrbotSessionId)) {
    gateway.value.astrbotSessionId = "";
  }
  touch();
}

function selectAstrbotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotSessionId = String(value || "");
  const selected = (agentScanFor("astrbot")?.sessions ?? []).find(session => (session.id || session.name) === gateway.value?.astrbotSessionId);
  if (selected?.projectId && !gateway.value.astrbotProjectId) {
    gateway.value.astrbotProjectId = selected.projectId;
  }
  touch();
}

function sessionNamesFor(type: AgentAdapterType): string[] {
  const selectedProject = currentAgentProject(type);
  return [...new Set(agentSessions(type)
    .filter(session => !selectedProject || !session.projectPath || samePath(session.projectPath, selectedProject))
    .map(session => session.name))];
}

function selectCopilotSession(value: unknown): void {
  if (!gateway.value) return;
  touch();
  const selected = agentSessions("copilotCli").find(session => session.name === String(value || ""));
  if (selected?.projectPath && !gateway.value.copilotCwd) {
    gateway.value.copilotCwd = selected.projectPath;
  }
}

function agentWarnings(type: AgentAdapterType): string[] {
  const warnings = [...(agentScanFor(type)?.warnings ?? [])];
  if (type === "astrbot") {
    const hasLocalPassword = Boolean(gateway.value?.astrbotPassword?.trim());
    const scan = agentScanFor("astrbot");
    const pluginReady = scan?.plugins?.every(plugin => plugin.installed) ?? false;
    const endpointReady = scan?.endpoints?.some(endpoint => endpoint.healthy) ?? false;
    return [...new Set(warnings.filter(warning => {
      if (hasLocalPassword && warning.includes("缺少 AstrBot 密码")) return false;
      if (warning.includes("默认管线") || warning.includes("无可选会话列表")) return false;
      if (hasLocalPassword && pluginReady && endpointReady && warning.includes("尚未验证列会话")) return false;
      return true;
    }))];
  }
  if (type === "copilotCli" && gateway.value?.copilotCwd && gateway.value.codexThreadName) {
    const selected = agentSessions(type).find(session => session.name === gateway.value?.codexThreadName);
    if (selected?.projectPath && !samePath(selected.projectPath, gateway.value.copilotCwd)) {
      warnings.push(`当前会话属于 ${selected.projectPath}，和工作目录不一致。`);
    }
  }
  return [...new Set(warnings)];
}

function addAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = [...agentTypes.value, type];
  agentParamOpen.value[type] = true;
  void runAgentScan();
  if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  store.touch();
}

function removeAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = agentTypes.value.filter(t => t !== type);
  agentParamOpen.value[type] = false;
  store.touch();
}

async function deployAstrbotAdapter(): Promise<void> {
  deployingAstrbot.value = true;
  astrbotDeployResult.value = null;
  try {
    const resp = await fetch("/api/deploy-astrbot-adapter", { method: "POST" });
    const body = await resp.json();
    if (body.ok) {
      astrbotDeployResult.value = { ok: true, message: body.message || "AstrBot Adapter 部署成功", detail: body.stdout };
      await runAgentScan();
    } else {
      astrbotDeployResult.value = { ok: false, message: body.error || "部署失败", detail: body.stderr };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    astrbotDeployResult.value = { ok: false, message: "部署请求失败", detail: msg };
  } finally {
    deployingAstrbot.value = false;
  }
}

async function testAstrbotLogin(): Promise<void> {
  if (!gateway.value) return;
  testingAstrbotLogin.value = true;
  astrbotLoginResult.value = null;
  try {
    const resp = await fetch("/api/agent/astrbot-login-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: gateway.value.astrbotUrl,
        username: gateway.value.astrbotUsername,
        password: gateway.value.astrbotPassword
      })
    });
    const body = await resp.json().catch(() => ({}));
    astrbotLoginResult.value = {
      ok: Boolean(body.ok),
      message: body.message || (resp.ok ? "AstrBot 登录验证成功。" : "AstrBot 登录验证失败。")
    };
    if (body.ok) await runAgentScan();
  } catch (e: unknown) {
    astrbotLoginResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    testingAstrbotLogin.value = false;
  }
}

function toggleAgentParams(type: AgentAdapterType): void {
  const nextOpen = !agentParamOpen.value[type];
  agentParamOpen.value[type] = nextOpen;
  if (nextOpen) {
    void runAgentScan();
    if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  }
}

async function refreshVisibleNapcatHealth(): Promise<void> {
  if (!gateway.value || !gatewayAdapterTypes(gateway.value).includes("napcat")) return;
  if (store.dirty) return;
  if (repairingNapcatAll.value) return;
  const instances = ensureNapcatInstances().filter(instance => instance.enabled !== false && !napcatHealthPausedAfterFix.value[instance.id]);
  if (instances.length === 0) return;
  autoCheckingNapcat.value = true;
  try {
    const results = await Promise.all(instances.map(async (instance) => {
      try {
        const body = await runNapcatInstanceHealth(instance);
        return [instance.id, body] as const;
      } catch (e: unknown) {
        return [instance.id, { ok: false, message: e instanceof Error ? e.message : String(e) }] as const;
      }
    }));
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      ...Object.fromEntries(results)
    };
  } finally {
    autoCheckingNapcat.value = false;
  }
}

// URL ↔ gateway 双向同步（放最后避免 TDZ）
watch([() => route.params.id as string, () => store.gateways], ([id]) => {
  if (!id || !store.gateways.length) return;
  const found = store.gateways.find(g => configNameFor(g) === id || g.id === id);
  if (found && found.id !== store.selectedGatewayId) store.selectGateway(found.id);
}, { immediate: true });

watch(() => store.selectedGatewayId, (id) => {
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  if (name && route.params.id !== name) router.replace(`/routes/${name}`);
});

watch(() => gateway.value?.configName, (name) => {
  configNameError.value = "";
  if (name && route.params.id !== name) router.replace(`/routes/${name}`);
});

watch(
  () => [store.loading, store.dirty, gateway.value?.id, JSON.stringify((gateway.value?.napcatInstances ?? []).map(instance => ({
    id: instance.id,
    enabled: instance.enabled,
    gatewayPort: instance.gatewayPort,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl
  })))],
  ([loading, dirty, gatewayId, instancesKey]) => {
    if (loading || dirty || autoCheckingNapcat.value || repairingNapcatAll.value) return;
    const key = `${gatewayId || ""}:${instancesKey || ""}`;
    if (key === lastAutoNapcatHealthKey.value) return;
    lastAutoNapcatHealthKey.value = key;
    void refreshVisibleNapcatHealth();
  },
  { immediate: true }
);
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">消息适配器</h1>
        <div class="page-subtitle">配置消息端和 Agent 端。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-switch v-model="gateway.enabled" label="是否启用" color="success" inset hide-details @update:model-value="touch" />
        <v-btn prepend-icon="mdi-folder-open-outline" variant="tonal" @click="store.openConfigFile('route-folder', gateway.id, gateway.agentRoleId || '')">
          打开航线配置
        </v-btn>
        <v-btn prepend-icon="mdi-delete" color="error" variant="text" :loading="deletingGateway" @click="deleteCurrentGateway">
          删除
        </v-btn>
      </div>
    </div>

    <v-alert v-if="deleteError" type="error" variant="tonal" class="mb-4">{{ deleteError }}</v-alert>
    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="status-row mb-4" style="gap:8px">
        <span style="color:var(--v-theme-on-surface-variant)">配置名</span>
        <v-text-field
          :model-value="gateway.configName"
          density="compact"
          variant="outlined"
          style="max-width:260px"
          hint="用于 data/route 下的目录名"
          persistent-hint
          :error-messages="configNameError"
          @update:model-value="renameCurrentConfig"
        />
      </div>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息端</div>
            <div class="section-note">这里决定 RabiRoute 从哪些入口接收消息。多个入口可以并存，也可以分别停用或调整权限。</div>
          </div>
          <div class="adapter-master-actions">
            <v-chip color="secondary" variant="tonal">{{ activeAdapterCount }} 个入口启用</v-chip>
          </div>
        </div>

        <div class="config-toolbar">
          <v-text-field
            v-model="adapterQuery"
            density="compact"
            prepend-inner-icon="mdi-magnify"
            label="搜索入口"
            hide-details
            clearable
          />
          <div class="selected-pill-row">
            <v-chip v-for="type in visibleActiveAdapters" :key="type" size="small" color="secondary" variant="tonal">
              {{ adapterLabel(type) }}
            </v-chip>
          </div>
        </div>

        <div class="catalog-list mb-2">
          <section v-for="group in visibleAdapterGroups" :key="group.title" class="catalog-section">
            <div class="catalog-section-head">
              <div>
                <div class="catalog-section-title">{{ group.title }}</div>
                <div class="section-note">{{ group.note }}</div>
              </div>
            </div>
            <div
              v-for="choice in group.choices"
              :key="choice.type"
              class="catalog-item"
            >
              <div
                class="catalog-row"
                :class="{ active: choice.type === 'rolePanel' || adapters.includes(choice.type) }"
                @click="toggleAdapterParams(choice.type)"
              >
                <v-icon class="catalog-row-icon" color="secondary">{{ choice.icon }}</v-icon>
                <span class="catalog-row-main">
                  <strong>{{ choice.title }}</strong>
                  <small>{{ choice.note }}</small>
                </span>
                <div class="catalog-row-actions">
                  <v-chip size="x-small" :color="maturityColor(messageScanFor(choice.type)?.maturity)" variant="tonal">
                    {{ maturityLabel(messageScanFor(choice.type)?.maturity) }}
                  </v-chip>
                  <v-chip size="x-small" :color="scanConnectionColor(messageScanFor(choice.type))" variant="tonal">
                    {{ scanConnectionLabel(messageScanFor(choice.type)) }}
                  </v-chip>
                  <v-btn
                    v-if="hasAdapterParams(choice.type)"
                    :icon="adapterParamOpen[choice.type] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    size="small"
                    variant="text"
                    :title="adapterParamOpen[choice.type] ? '收起参数' : '展开参数'"
                    @click.stop="toggleAdapterParams(choice.type)"
                  />
                  <div v-if="choice.type !== 'rolePanel'" @click.stop>
                    <v-switch
                      class="catalog-row-toggle"
                      color="success"
                      density="compact"
                      inset
                      hide-details
                      :model-value="!isAdapterDisabled(gateway, choice.type)"
                      @update:model-value="() => toggleAdapter(choice.type)"
                    />
                  </div>
                  <v-btn
                    v-if="choice.type !== 'rolePanel'"
                    icon="mdi-close"
                    size="small"
                    variant="text"
                    color="error"
                    title="移除此消息端"
                    @click.stop="removeAdapter(choice.type)"
                  />
                </div>
              </div>
              <v-expand-transition>
                <div v-if="adapterParamOpen[choice.type]" class="catalog-param-panel">
                  <div class="dependency-panel mb-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">环境和依赖</div>
                        <div class="section-note">先确认这个消息端需要的外部工具、桥接服务和回调入口是否就绪。</div>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-chip size="small" :color="scanConnectionColor(messageScanFor(choice.type))" variant="tonal">
                          {{ scanConnectionLabel(messageScanFor(choice.type)) }}
                        </v-chip>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="messageAdapterScan.loading" @click="choice.type === 'napcat' ? rescanNapcatInstances() : runMessageAdapterScan()">
                          {{ choice.type === "napcat" ? "后端自测" : "重新扫描" }}
                        </v-btn>
                      </div>
                    </div>
                    <template v-if="messageScanFor(choice.type)">
                      <div v-if="messageScanFor(choice.type)?.requirements?.length" class="dependency-list">
                        <div
                          v-for="requirement in messageScanFor(choice.type)?.requirements"
                          :key="requirement.id"
                          class="dependency-row"
                        >
                          <v-chip size="x-small" :color="requirementColor(requirement)" variant="tonal">
                            {{ requirementLabel(requirement) }}
                          </v-chip>
                          <div>
                            <strong>{{ requirement.label }}</strong>
                            <span>{{ requirement.detail || (requirement.required ? "这是必需项。" : "这是可选项。") }}</span>
                          </div>
                          <v-btn
                            v-if="requirement.url || requirement.path"
                            size="small"
                            variant="text"
                            :prepend-icon="requirement.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                            @click="openScanCandidate(requirement)"
                          >
                            {{ requirement.actionLabel || (requirement.url ? "打开" : "复制路径") }}
                          </v-btn>
                        </div>
                      </div>
                      <div v-if="messageScanFor(choice.type)?.endpoints?.length" class="dependency-endpoints mt-2">
                        <div
                          v-for="endpoint in messageScanFor(choice.type)?.endpoints"
                          :key="`${endpoint.label}-${endpoint.url}`"
                          class="status-row compact-status-row"
                        >
                          <span>{{ endpoint.label }}</span>
                          <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可用" : "未响应" }}</b>
                        </div>
                      </div>
                      <div v-if="messageScanFor(choice.type)?.installCandidates?.length" class="dependency-actions mt-2">
                        <v-btn
                          v-for="candidate in messageScanFor(choice.type)?.installCandidates"
                          :key="candidate.label"
                          size="small"
                          variant="tonal"
                          :prepend-icon="candidate.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                          @click="openScanCandidate(candidate)"
                        >
                          {{ candidate.label }}
                        </v-btn>
                      </div>
                      <v-alert
                        v-for="warning in messageScanFor(choice.type)?.warnings ?? []"
                        :key="warning"
                        type="warning"
                        variant="tonal"
                        density="compact"
                        class="mt-2"
                      >
                        {{ warning }}
                      </v-alert>
                    </template>
                    <div v-else class="section-note">尚未扫描。展开面板后会自动扫描，也可以手动刷新。</div>
                  </div>
                  <div v-if="choice.type === 'napcat'" class="catalog-param-grid napcat-manager-panel">
                    <div class="full-span napcat-setup-strip">
                      <div class="napcat-setup-main">
                        <v-icon size="22">mdi-account-switch-outline</v-icon>
                        <div>
                          <strong>NapCat 多 QQ 实例</strong>
                          <span>{{ napcatSetupHint() }}</span>
                        </div>
                      </div>
                      <div class="napcat-setup-stats">
                        <div><b>{{ napcatConfiguredCount() }}</b><span>已配置</span></div>
                        <div><b>{{ napcatEnabledCount() }}</b><span>启用中</span></div>
                        <div><b>{{ napcatConnectedCount() }}</b><span>已连接</span></div>
                      </div>
                    </div>
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      保存时以每张 QQ 卡片为准；禁用的 QQ 会保留配置，但不会启动监听、不会参与路由。
                    </v-alert>
                    <v-alert
                      v-for="(auto, key) in napcatAutoSteps"
                      :key="key"
                      :type="auto.ok === false ? 'error' : auto.ok === true ? 'success' : 'info'"
                      variant="tonal"
                      density="compact"
                      class="full-span"
                    >
                      <div>{{ auto.message }}</div>
                      <div v-for="step in auto.steps" :key="step" class="section-note">{{ step }}</div>
                    </v-alert>
                    <div class="full-span">
                      <div class="section-title-row mb-2">
                        <div>
                          <div class="section-title small-title">QQ 实例</div>
                          <div class="section-note">每个 QQ 对应一个 NapCat 实例；打开 WebUI 会自动维护连接配置，开关只决定这个 QQ 是否参与路由。</div>
                        </div>
                        <div class="d-flex ga-2 flex-wrap">
                          <v-btn
                            size="small"
                            variant="tonal"
                            color="primary"
                            prepend-icon="mdi-plus"
                            :loading="addingNapcatInstance"
                            :disabled="addingNapcatInstance"
                            @click="addNapcatInstance"
                          >
                            {{ addingNapcatInstance ? "正在启动..." : "添加 QQ" }}
                          </v-btn>
                        </div>
                      </div>
                      <div class="napcat-account-grid">
                        <div
                          v-for="instance in napcatAccountInstances()"
                          :key="instance.id"
                          class="napcat-account-card"
                          :class="{ disabled: instance.enabled === false }"
                        >
                          <div class="napcat-account-head">
                            <div>
                              <div class="napcat-account-title">{{ napcatAccountTitle(instance) }}</div>
                              <div class="section-note">{{ napcatAccountSubtitle(instance) }}</div>
                            </div>
                            <div class="napcat-card-controls">
                              <v-switch
                                v-model="instance.enabled"
                                color="secondary"
                                density="compact"
                                hide-details
                                inset
                                @update:model-value="value => void setNapcatInstanceEnabled(instance, value)"
                              />
                              <v-chip size="x-small" :color="napcatInstanceStatusColor(instance)" variant="tonal">
                                {{ napcatInstanceStatusLabel(instance) }}
                              </v-chip>
                            </div>
                          </div>
                          <div class="napcat-card-summary">
                            <div><span>WS</span><b :class="napcatInstancePortError(instance) ? 'text-error' : ''">{{ napcatInstanceWsUrl(instance) }}</b></div>
                            <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                            <div><span>登录</span><b :class="napcatAccountOffline(instance) ? 'text-error' : napcatAccountUserId(instance) ? 'text-success' : 'text-warning'">{{ napcatAccountLoginLabel(instance) }}</b></div>
                          </div>
                          <div class="agent-action-bar mt-2">
                            <div class="agent-action-status">
                              <span class="section-note">{{ instance.enabled === false ? "已停用；打开开关后此 QQ 才参与路由" : "打开 WebUI 会自动检查并维护 OneBot / WS 配置" }}</span>
                            </div>
                            <div class="d-flex ga-2 flex-wrap">
                              <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-open-in-new" @click="openNapcatWebuiWithToken(instance)">
                                打开 WebUI
                              </v-btn>
                              <v-btn
                                v-if="isConfiguredNapcatInstance(instance) || (instance as Record<string, any>).__discovered"
                                size="small"
                                variant="text"
                                color="error"
                                prepend-icon="mdi-delete-outline"
                                @click="removeNapcatInstanceById(instance.id)"
                              >
                                删除
                              </v-btn>
                            </div>
                          </div>
                          <v-alert
                            v-if="napcatInstancePortError(instance)"
                            type="error"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatInstancePortError(instance) }}
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                size="small"
                                color="error"
                                variant="tonal"
                                prepend-icon="mdi-auto-fix"
                                :loading="fixingNapcatPorts"
                                :disabled="fixingNapcatPorts"
                                @click="fixNapcatPorts(instance)"
                              >
                                自动分配端口并保存
                              </v-btn>
                            </div>
                          </v-alert>
                          <v-alert
                            v-if="napcatPortFixResult[instance.id]"
                            :type="napcatPortFixResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatPortFixResult[instance.id].message }}
                          </v-alert>
                          <v-alert
                            v-if="napcatOneBotFixResult[instance.id]"
                            :type="napcatOneBotFixResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatOneBotFixResult[instance.id].message }}
                          </v-alert>
                          <v-expansion-panels class="napcat-detail-panel mt-2" variant="accordion">
                            <v-expansion-panel>
                              <v-expansion-panel-title>自动分配详情</v-expansion-panel-title>
                              <v-expansion-panel-text>
                                <v-alert type="info" variant="tonal" density="compact" class="mb-3">
                                  RabiRoute 会自动生成和维护这些值，用户通常只需要登录 QQ 并勾选是否作为消息渠道。
                                </v-alert>
                                <div class="napcat-auto-summary">
                                  <div><span>WebUI</span><b>{{ instance.webuiUrl || "-" }}</b></div>
                                  <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                                  <div><span>WS</span><b>{{ napcatInstanceWsUrl(instance) }}</b></div>
                                  <div><span>工作目录</span><b>{{ instance.workingDir || "自动生成" }}</b></div>
                                </div>
                                <div class="d-flex ga-2 flex-wrap mt-2">
                                  <v-btn
                                    size="small"
                                    variant="text"
                                    prepend-icon="mdi-key-variant"
                                    :loading="copyingNapcatInstanceToken[instance.id]"
                                    :disabled="copyingNapcatInstanceToken[instance.id]"
                                    @click="copyNapcatWebuiToken(instance)"
                                  >
                                    复制 WebUI 登录密钥
                                  </v-btn>
                                </div>
                                <v-expansion-panels class="mt-3" variant="accordion">
                                  <v-expansion-panel>
                                    <v-expansion-panel-title>高级配置</v-expansion-panel-title>
                                    <v-expansion-panel-text>
                                      <div class="catalog-param-grid">
                                        <v-text-field v-model="instance.id" label="实例 ID" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.name" label="内部备注" placeholder="可选，仅用于排障" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model.number="instance.gatewayPort" type="number" label="RabiRoute WS 端口" :error-messages="napcatInstancePortError(instance)" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.httpUrl" label="NapCat HTTP 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.webuiUrl" label="NapCat WebUI 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.webuiToken" label="NapCat WebUI 登录密钥" placeholder="扫描后自动回填" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.accessToken" label="OneBot HTTP 鉴权密钥" placeholder="一般留空；仅 HTTP Server 设置 token 时填写" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.launchCommand" class="full-span" label="启动命令" placeholder="自动生成" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.workingDir" class="full-span" label="NapCat Shell 工作目录" placeholder="自动生成" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                      </div>
                                    </v-expansion-panel-text>
                                  </v-expansion-panel>
                                </v-expansion-panels>
                              </v-expansion-panel-text>
                            </v-expansion-panel>
                          </v-expansion-panels>
                          <v-alert
                            v-if="!instance.launchCommand && !napcatAccountUserId(instance)"
                            type="info"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            这个实例还没有启动命令；RabiRoute 只能检查和给出 WS 地址，不能自动拉起第二个 NapCat 后台。
                          </v-alert>
                          <v-alert
                            v-if="napcatLaunchResult[instance.id]"
                            :type="napcatLaunchResult[instance.id].ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatLaunchResult[instance.id].message }}
                          </v-alert>
                          <v-alert
                            v-if="napcatInstanceHealthResult[instance.id]"
                            :type="napcatInstanceHealthResult[instance.id]?.ok ? 'success' : 'error'"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            <div v-if="napcatInstanceHealthResult[instance.id]?.message">{{ napcatInstanceHealthResult[instance.id]?.message }}</div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.http">
                              HTTP：{{ napcatInstanceHealthResult[instance.id]?.http?.ok ? `可用，${napcatInstanceHealthResult[instance.id]?.http?.nickname || napcatInstanceHealthResult[instance.id]?.http?.userId || '已登录'}` : (napcatInstanceHealthResult[instance.id]?.http?.message || '不可用') }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.onebot?.currentUserId">
                              当前 WebUI QQ：{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentUserId }}{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname ? ` / ${napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname}` : "" }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui">
                              WebUI：{{ napcatInstanceHealthResult[instance.id]?.webui?.reachable ? "可访问" : "未响应" }} · {{ napcatInstanceHealthResult[instance.id]?.webui?.url }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.found">
                              WebUI 登录密钥：已从 NapCat webui.json 读取 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位；只用于打开管理页。
                            </div>
                            <div v-else-if="napcatInstanceHealthResult[instance.id]?.webui?.source === 'provided'">
                              WebUI 登录密钥：使用当前配置保存的 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位登录密钥。
                            </div>
                            <div v-else-if="napcatInstanceHealthResult[instance.id]?.webui?.message">
                              WebUI 登录密钥：{{ napcatInstanceHealthResult[instance.id]?.webui?.message }}
                            </div>
                            <div>WS：请在对应 NapCat WebSocket Client 里连接 {{ napcatInstanceHealthResult[instance.id]?.wsUrl || napcatInstanceWsUrl(instance) }}</div>
                            <ul v-if="napcatInstanceHealthResult[instance.id]?.diagnostics?.length" class="health-diagnostics">
                              <li v-for="item in napcatInstanceHealthResult[instance.id]?.diagnostics" :key="item">{{ item }}</li>
                            </ul>
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                v-if="napcatInstanceHealthResult[instance.id]?.webui?.loginUrl"
                                size="small"
                                variant="tonal"
                                color="primary"
                                prepend-icon="mdi-open-in-new"
                                @click="openExternalUrl(napcatInstanceHealthResult[instance.id]?.webui?.loginUrl)"
                              >
                                打开 WebUI
                              </v-btn>
                              <v-btn
                                v-if="napcatInstanceHealthResult[instance.id]?.webui?.token"
                                size="small"
                                variant="text"
                                prepend-icon="mdi-key-variant"
                                @click="copyText(napcatInstanceHealthResult[instance.id]?.webui?.token || '', '已复制 NapCat WebUI 登录密钥')"
                              >
                                复制 WebUI 登录密钥
                              </v-btn>
                            </div>
                          </v-alert>
                          <div class="adapter-log-panel mt-3">
                            <div class="section-title-row compact-row">
                              <div>
                                <div class="section-title small-title">{{ napcatAccountLogTitle(instance) }} 日志</div>
                                <div class="section-note">只展示此 QQ / 实例对应的连接、登录、入站和解析日志。</div>
                              </div>
                              <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                            </div>
                            <div v-if="napcatLogEntriesFor(instance).length" class="adapter-log-list">
                              <v-expansion-panels variant="accordion" density="compact">
                                <v-expansion-panel
                                  v-for="(entry, logIndex) in napcatLogEntriesFor(instance)"
                                  :key="`${entry.path}-${entry.messageId || logIndex}`"
                                >
                                  <v-expansion-panel-title>
                                    <div class="adapter-log-title">
                                      <span>{{ formatLogTime(entry) }}</span>
                                      <b>{{ logEventTitle(entry) }}</b>
                                      <span>{{ entry.target || "-" }}</span>
                                      <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                                    </div>
                                  </v-expansion-panel-title>
                                  <v-expansion-panel-text>
                                    <div class="status-row"><span>实例</span><b>{{ entry.instanceId || instance.id || "-" }}</b></div>
                                    <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                                    <div class="status-row"><span>来源</span><b>{{ entry.sender || entry.target || "-" }}</b></div>
                                    <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                                    <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                                  </v-expansion-panel-text>
                                </v-expansion-panel>
                              </v-expansion-panels>
                            </div>
                            <div v-else class="empty-state compact-empty">
                              <div>
                                <strong>暂无此账号日志</strong>
                                <span>{{ adapterLogPaths('napcat').join(' / ') || '等待启动或收到连接后生成日志。' }}</span>
                              </div>
                            </div>
                            <div class="adapter-message-file-panel mt-2">
                              <div class="section-title small-title">{{ napcatAccountLogTitle(instance) }} 消息文件</div>
                              <div class="section-note">{{ messageFilePaths('napcat').join(' / ') || '尚未生成消息文件。' }}</div>
                              <div v-if="napcatMessageFileEntriesFor(instance).length" class="adapter-message-preview">
                                <div
                                  v-for="(entry, messageIndex) in napcatMessageFileEntriesFor(instance).slice(0, 3)"
                                  :key="`${entry.path}-${entry.messageId || messageIndex}`"
                                >
                                  {{ formatLogTime(entry) }} · {{ entry.source }} · {{ logPreview(entry) }}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <button class="napcat-account-card napcat-add-card" type="button" @click="addNapcatInstance">
                          <v-icon size="28">mdi-plus</v-icon>
                          <strong>添加 QQ</strong>
                          <span>自动分配下一个可用 WS 端口</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  <template v-if="choice.type === 'napcat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('napcat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('napcat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'text-medium-emphasis' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>WS 连接</span><b :class="messageAdapterInactive ? 'text-medium-emphasis' : napcatPrimaryOffline() ? 'text-error' : napcatState.connected ? 'text-success' : 'text-error'">{{ messageAdapterInactive ? "未启用" : napcatPrimaryOffline() ? "QQ 已离线" : napcatState.connected ? "已连接" : "未连接" }}</b></div>
                    <div class="status-row"><span>远端地址</span><b>{{ napcatState.remoteAddress || "-" }}</b></div>
                    <div class="status-row"><span>最后连接</span><b>{{ napcatState.lastConnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>最后断开</span><b>{{ napcatState.lastDisconnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>登录资料</span><b :class="napcatState.loginInfoError ? 'text-error' : ''">{{ napcatState.loginInfoError || napcatState.lastLoginInfoAt || "-" }}</b></div>
                  </template>
                  <div v-else-if="choice.type === 'rolePanel'" class="catalog-param-grid">
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      角色面板是内置本地消息端，不需要端口、外部登录或安装。托盘打开后，聊天视图会把用户输入作为 role_panel_message 投递给 Agent，Agent 默认回到同一个角色面板时间线。
                    </v-alert>
                    <div class="full-span adapter-message-file-panel">
                      <div class="section-title small-title">聊天记录</div>
                      <div class="section-note">{{ messageFilePaths('rolePanel').join(' / ') || '发送角色面板消息后生成 messages.jsonl。' }}</div>
                      <div v-if="messageFileEntries('rolePanel').length" class="adapter-message-preview">
                        <div
                          v-for="(entry, messageIndex) in messageFileEntries('rolePanel').slice(0, 3)"
                          :key="`${entry.path}-${entry.messageId || messageIndex}`"
                        >
                          {{ formatLogTime(entry) }} · {{ entry.sender || entry.source || '角色面板' }} · {{ logPreview(entry) }}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="choice.type === 'remoteAgent'" class="catalog-param-grid">
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      远端 Agent 是下游 Agent 设备入口。远端机器只运行 <code>plugin-adapters/remote-agent-rabiroute</code> bridge，无人值守等待 RabiGUI 扫描；选择设备并输入密码后，本机人格会通过 Rabi API 投递任务。
                    </v-alert>
                    <div class="full-span">
                      <v-menu v-model="remoteAgentDeviceMenu" location="bottom start" :close-on-content-click="false">
                        <template #activator="{ props }">
                          <v-btn
                            v-bind="props"
                            class="remote-agent-device-select"
                            variant="outlined"
                            block
                            append-icon="mdi-menu-down"
                            :loading="remoteAgentDevicesLoading"
                            @click="remoteAgentDeviceOptions.length ? undefined : scanRemoteAgentDevices()"
                          >
                            <span class="remote-agent-device-select-main">{{ selectedRemoteAgentDeviceLabel }}</span>
                          </v-btn>
                        </template>
                        <v-list class="remote-agent-device-menu" density="compact">
                          <v-list-item
                            v-for="device in remoteAgentDeviceOptions"
                            :key="device.deviceId"
                            prepend-icon="mdi-lan-connect"
                            :title="device.label"
                            :subtitle="device.subtitle"
                            @click="selectRemoteAgentDevice(device.deviceId)"
                          />
                          <v-list-item
                            v-if="remoteAgentDeviceOptions.length === 0"
                            prepend-icon="mdi-lan-disconnect"
                            title="还没有扫描到远端 Agent 设备"
                            subtitle="先在另一台设备运行 remote-agent-rabiroute bridge，再扫描局域网。"
                          />
                        </v-list>
                      </v-menu>
                      <div class="field-hint">选择当前路由默认投递的远端设备；端口占用会由 bridge 和 Rabi 扫描自动处理。</div>
                    </div>
                    <v-text-field
                      v-model="remoteAgentPassword"
                      class="full-span"
                      type="password"
                      label="连接密码"
                      :placeholder="selectedRemoteAgentDevice?.passwordSaved ? '已记住密码，留空可直接连接' : '默认密码 123456'"
                      autocomplete="current-password"
                    />
                    <v-alert v-if="remoteAgentConnectResult" class="full-span" :type="remoteAgentConnectResult.ok ? 'success' : 'warning'" variant="tonal" density="compact">
                      {{ remoteAgentConnectResult.message }}
                    </v-alert>
                    <v-alert v-if="remoteAgentDeviceError" class="full-span" type="warning" variant="tonal" density="compact">
                      {{ remoteAgentDeviceError }}
                    </v-alert>
                    <div v-if="selectedRemoteAgentDevice" class="full-span">
                      <div class="status-row"><span>选中设备</span><b>{{ remoteAgentDeviceTitle(selectedRemoteAgentDevice) }}</b></div>
                      <div class="status-row"><span>连接状态</span><b :class="selectedRemoteAgentDevice.connected ? 'text-success' : 'text-warning'">{{ selectedRemoteAgentDevice.connected ? "已连接" : "未连接" }}</b></div>
                      <div class="status-row"><span>Agent 类型</span><b>{{ selectedRemoteAgentDevice.agentType || "agent" }}</b></div>
                      <div class="status-row"><span>系统</span><b>{{ [selectedRemoteAgentDevice.os, selectedRemoteAgentDevice.osVersion, selectedRemoteAgentDevice.arch].filter(Boolean).join(" ") || "-" }}</b></div>
                      <div class="status-row"><span>IP</span><b>{{ selectedRemoteAgentDevice.observedIp || selectedRemoteAgentDevice.declaredIp || selectedRemoteAgentDevice.host || "-" }}</b></div>
                      <div class="status-row"><span>密码</span><b>{{ selectedRemoteAgentDevice.passwordSaved ? "已记住" : "未保存" }}</b></div>
                      <div class="status-row"><span>默认 cwd</span><b>{{ selectedRemoteAgentDevice.defaultCwd || "-" }}</b></div>
                      <div class="status-row"><span>默认线程</span><b>{{ selectedRemoteAgentDevice.defaultThreadName || "-" }}</b></div>
                      <div v-if="selectedRemoteAgentDevice.connectionError" class="status-row"><span>连接诊断</span><b class="text-warning">{{ selectedRemoteAgentDevice.connectionError }}</b></div>
                    </div>
                    <div class="full-span">
                      <div class="status-row"><span>设备发现 API</span><b>/api/remote-agent/devices</b></div>
                      <div class="status-row"><span>任务投递 API</span><b>/api/remote-agent/tasks</b></div>
                      <div class="status-row"><span>局域网扫描</span><b>{{ remoteAgentDiscoveryDetail }}</b></div>
                      <div class="status-row"><span>在线状态</span><b :class="remoteAgentConnected ? 'text-success' : 'text-warning'">{{ remoteAgentConnected ? '已有设备连接' : '等待扫描并连接' }}</b></div>
                    </div>
                    <div class="agent-action-bar full-span mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">开启后，Agent prompt 会注入远端 Agent 设备 API。默认密码是 123456，连接成功后会记住密码。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="secondary" prepend-icon="mdi-lan-pending" :loading="remoteAgentDevicesLoading" @click="scanRemoteAgentDevices">
                          扫描局域网
                        </v-btn>
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-lan-connect" :loading="remoteAgentConnecting" :disabled="!selectedRemoteAgentDeviceId" @click="connectRemoteAgentDevice">
                          连接
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-lan-disconnect" :loading="remoteAgentConnecting" :disabled="!selectedRemoteAgentDeviceId || !selectedRemoteAgentDevice?.connected" @click="disconnectRemoteAgentDevice">
                          断开
                        </v-btn>
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText('/api/remote-agent/devices', '已复制远端 Agent 设备 API')">
                          复制设备 API
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="choice.type === 'heartbeat'" class="catalog-param-grid">
                    <div class="section-note">定时触发参数在“人格配置 / 消息模板规则”的 heartbeat 规则里维护；这里仅启用内部定时来源。</div>
                  </div>
                  <template v-if="choice.type === 'heartbeat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('heartbeat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('heartbeat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'text-medium-emphasis' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>触发器状态</span><b :class="messageAdapterInactive ? 'text-medium-emphasis' : heartbeatState.enabled === false ? 'text-error' : 'text-success'">{{ messageAdapterInactive ? "未启用" : heartbeatState.enabled === false ? "未启用" : "已启用" }}</b></div>
                    <div class="status-row"><span>计划数量</span><b>{{ heartbeatState.scheduleCount ?? "-" }}</b></div>
                    <div class="status-row"><span>下次触发</span><b>{{ heartbeatState.nextTickAt || "-" }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">立即触发会向当前 Agent 端投递一条心跳消息；日志页可看完整结果。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="secondary"
                          prepend-icon="mdi-play-circle-outline"
                          :loading="triggeringHeartbeat"
                          :disabled="triggeringHeartbeat || !runtime.running"
                          @click="triggerHeartbeatNow"
                        >
                          立即触发
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert
                      v-if="heartbeatTriggerResult"
                      :type="heartbeatTriggerResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="mt-2"
                    >
                      {{ heartbeatTriggerResult.message }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">适配器日志</div>
                          <div class="section-note">启用、tick 和投递过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('heartbeat').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('heartbeat')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无心跳适配器日志</strong>
                          <span>{{ adapterLogPaths('heartbeat').join(' / ') || '等待启动或触发后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('heartbeat').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('heartbeat').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('heartbeat').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="choice.type === 'wecom'" class="catalog-param-grid">
                    <v-text-field v-model="gateway.wecomBotId" label="企业微信 Bot ID" placeholder="可留空使用 WECOM_BOT_ID" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomBotSecret" type="password" label="企业微信 Bot Secret" placeholder="可留空使用 WECOM_BOT_SECRET" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomWsUrl" class="full-span" label="企业微信 WebSocket 地址" placeholder="留空使用 SDK 默认地址；私有部署时填写" @update:model-value="touch" />
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      企业微信消息端使用智能机器人 WebSocket 长连接，主场景是企业微信群聊；模板变量会尽量对齐 NapCat 的 groupId、userId、sender、message 和 messageId。
                    </v-alert>
                  </div>
                  <template v-if="choice.type === 'wecom' && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>连接</span><b :class="wecomState.connected && wecomState.authenticated ? 'text-success' : 'text-warning'">{{ wecomState.connected && wecomState.authenticated ? "已认证" : wecomState.message || "未连接" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ wecomState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>消息数</span><b>{{ wecomState.messageCount ?? 0 }}</b></div>
                    <v-alert v-if="wecomState.lastError" type="error" variant="tonal" density="compact" class="mt-2">
                      {{ wecomState.lastError }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">企业微信适配器日志</div>
                          <div class="section-note">连接、认证、消息接收和错误日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('wecom').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('wecom')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无企业微信适配器日志</strong>
                          <span>{{ adapterLogPaths('wecom').join(' / ') || '等待启动后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('wecom').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('wecom').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('wecom').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                  <div v-else-if="isWebhookLikeAdapter(choice.type)" class="catalog-param-grid">
                    <v-text-field v-if="choice.type === 'rabilink'" :model-value="webhookHostFor(choice.type)" :label="`${sourceTitle(choice.type)} 监听地址`" placeholder="0.0.0.0" @update:model-value="value => setWebhookHost(choice.type, value)" />
                    <v-text-field :model-value="webhookPortFor(choice.type)" type="number" :label="`${sourceTitle(choice.type)} 监听端口`" @update:model-value="value => setWebhookPort(choice.type, value)" />
                    <v-text-field :model-value="webhookPathFor(choice.type)" :label="`${sourceTitle(choice.type)} 路径`" :placeholder="adapterDefaultWebhookPath(choice.type)" @update:model-value="value => setWebhookPath(choice.type, value)" />
                    <v-alert v-if="choice.type === 'rabilink'" class="full-span" type="info" variant="tonal" density="compact">
                      Relay 服务器、应用 token 和本机 Rabi PC 标识在控制台的 Rabi 实例里统一配置；这里添加消息端即可接收 RabiLink 输入。
                    </v-alert>
                  </div>
                  <template v-if="isWebhookLikeAdapter(choice.type) && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl(choice.type) }}</b></div>
                    <div v-if="choice.type === 'rabilink'" class="status-row"><span>复制回调</span><b>{{ callbackUrl(choice.type) }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">{{ sourceTitle(choice.type) }} 使用底层 HTTP 回调；RabiLink 的回调地址会把 0.0.0.0 换成本机可访问 IP。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl(choice.type), `已复制 ${sourceTitle(choice.type)} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn v-if="choice.type === 'rabilink'" size="small" variant="text" prepend-icon="mdi-access-point" @click="copyText(webhookUrl(choice.type), '已复制监听地址')">
                          复制监听
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl(choice.type), '已复制 curl 示例')">
                          复制 curl
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                      {{ copyResult }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">{{ sourceTitle(choice.type) }} 适配器日志</div>
                          <div class="section-note">按 voiceSource / source 匹配请求、接收、拒绝和错误等过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="sourceLogEntries(choice.type).length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in sourceLogEntries(choice.type)"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span>{{ entry.sender || "-" }}</span>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>来源</span><b>{{ entry.sender || entry.target || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无 {{ sourceTitle(choice.type) }} 日志</strong>
                          <span>{{ adapterLogPaths(choice.type).join(' / ') || '等待启动或收到请求后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">{{ sourceTitle(choice.type) }} 消息文件</div>
                        <div class="section-note">{{ messageFilePaths(choice.type).join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="sourceMessageFileEntries(choice.type).length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in sourceMessageFileEntries(choice.type).slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ entry.source }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </v-expand-transition>
            </div>
          </section>
          <div v-if="visibleAdapterGroups.length === 0 && adapterQuery" class="empty-state compact-empty">
            <div>
              <strong>没有匹配的入口</strong>
              <span>换个关键词，或先清空搜索。</span>
            </div>
          </div>
          <div v-else-if="visibleAdapterGroups.length === 0" class="empty-state compact-empty">
            <div>
              <strong>尚未添加任何消息端</strong>
              <span>点击下方按钮添加入口。</span>
            </div>
          </div>
        </div>

        <div class="adapter-add-row">
          <v-menu v-model="addAdapterMenu" location="bottom start">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                prepend-icon="mdi-plus"
                variant="tonal"
                size="small"
                :disabled="availableToAdd.length === 0"
              >
                添加消息端
              </v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="type in availableToAdd"
                :key="type"
                :title="adapterLabel(type)"
                @click="addAdapter(type)"
              />
            </v-list>
          </v-menu>
        </div>

        <v-alert v-if="messageInputsDisabled" type="info" variant="tonal">当前配置仍带有旧版全局消息禁用字段；请移除该字段，或分别关闭不需要的消息端。</v-alert>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">Agent 端</div>
            <div class="section-note">这里决定分诊后的消息送给哪个处理端，以及 Agent 在哪个项目目录里工作。</div>
          </div>
        </div>

        <div class="catalog-list mb-2">
          <div v-for="agent in visibleAgentItems" :key="agent.type" class="catalog-item">
            <div
              class="catalog-row active"
              @click="toggleAgentParams(agent.type)"
            >
              <v-icon class="catalog-row-icon" color="secondary">{{ agent.icon }}</v-icon>
              <span class="catalog-row-main">
                <strong>{{ agent.title }}</strong>
                <small>{{ agent.note }}</small>
              </span>
              <div class="catalog-row-actions">
                <v-chip size="x-small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                  {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                </v-chip>
                <v-chip size="x-small" :color="agentConnectionColor(agent.type)" variant="tonal">
                  {{ agentConnectionLabel(agent.type) }}
                </v-chip>
                <v-btn
                  :icon="agentParamOpen[agent.type] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                  size="small"
                  variant="text"
                  :title="agentParamOpen[agent.type] ? '收起参数' : '展开参数'"
                  @click.stop="toggleAgentParams(agent.type)"
                />
                <v-btn
                  icon="mdi-close"
                  size="small"
                  variant="text"
                  color="error"
                  title="移除此 Agent"
                  @click.stop="removeAgent(agent.type)"
                />
              </div>
            </div>
            <v-expand-transition>
              <div v-if="agentParamOpen[agent.type]" class="catalog-param-panel">
                <div class="dependency-panel mb-3">
                  <div class="section-title-row compact-row">
                    <div>
                      <div class="section-title small-title">环境和依赖</div>
                      <div class="section-note">先确认处理端是否安装、登录、插件可用，以及能否读取项目和会话。</div>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-chip size="small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                        {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                      </v-chip>
                      <v-chip size="small" :color="agentConnectionColor(agent.type)" variant="tonal">
                        {{ agentConnectionLabel(agent.type) }}
                      </v-chip>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agentScan.loading" @click="runAgentScan">
                        重新扫描
                      </v-btn>
                    </div>
                  </div>
                  <div class="dependency-list">
                    <div class="dependency-row">
                      <v-chip size="x-small" :color="agentScanFor(agent.type)?.installed ? 'success' : 'warning'" variant="tonal">
                        {{ agentScanFor(agent.type)?.installed ? "已发现" : "未安装" }}
                      </v-chip>
                      <div>
                        <strong>安装状态</strong>
                        <span>{{ agentScanFor(agent.type)?.installed ? "已通过本机扫描发现可用入口。" : "没有发现可用安装或服务；请按下方候选入口安装/打开。" }}</span>
                      </div>
                    </div>
                    <div v-if="agentScanFor(agent.type)?.auth" class="dependency-row">
                      <v-chip size="x-small" :color="agentScanFor(agent.type)?.auth?.loggedIn ? 'success' : 'warning'" variant="tonal">
                        {{ agentScanFor(agent.type)?.auth?.loggedIn ? "已登录" : "未登录" }}
                      </v-chip>
                      <div>
                        <strong>鉴权</strong>
                        <span>{{ agentScanFor(agent.type)?.auth?.message || "需要确认登录状态。" }}</span>
                      </div>
                      <v-btn
                        v-if="agentScanFor(agent.type)?.auth?.loginUrl"
                        size="small"
                        variant="text"
                        prepend-icon="mdi-open-in-new"
                        @click="openExternalUrl(agentScanFor(agent.type)?.auth?.loginUrl)"
                      >
                        打开登录
                      </v-btn>
                    </div>
                    <div
                      v-for="plugin in agentScanFor(agent.type)?.plugins ?? []"
                      :key="plugin.id"
                      class="dependency-row"
                    >
                      <v-chip size="x-small" :color="plugin.installed ? 'success' : 'warning'" variant="tonal">
                        {{ plugin.installed ? "已安装" : "缺插件" }}
                      </v-chip>
                      <div>
                        <strong>{{ plugin.name }}</strong>
                        <span>{{ plugin.version ? `版本/状态：${plugin.version}` : "插件用于完成真实消息投递和会话绑定。" }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-if="agentScanFor(agent.type)?.endpoints?.length" class="dependency-endpoints mt-2">
                    <div
                      v-for="endpoint in agentScanFor(agent.type)?.endpoints ?? []"
                      :key="`${agent.type}-${endpoint.url}`"
                      class="status-row compact-status-row"
                    >
                      <span>{{ endpoint.label }}</span>
                      <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                    </div>
                  </div>
                  <div v-if="agentScanFor(agent.type)?.installCandidates?.length" class="dependency-actions mt-2">
                    <v-btn
                      v-for="candidate in agentScanFor(agent.type)?.installCandidates"
                      :key="candidate.label"
                      size="small"
                      variant="tonal"
                      :prepend-icon="candidate.url ? 'mdi-open-in-new' : 'mdi-content-copy'"
                      @click="openScanCandidate(candidate)"
                    >
                      {{ candidate.label }}
                    </v-btn>
                  </div>
                </div>
                <v-alert
                  v-for="warning in agentWarnings(agent.type)"
                  :key="warning"
                  type="warning"
                  variant="tonal"
                  density="compact"
                  class="mb-2"
                >
                  {{ warning }}
                </v-alert>
                <!-- Codex -->
                <template v-if="agent.type === 'codex'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codex')" label="工作目录" placeholder="留空，使用 RabiRoute 根目录" hint="可不绑定项目；留空时 Codex 在 RabiRoute 根目录创建或投递" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('codex').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexThreadName" :items="sessionNamesFor('codex')" label="会话线程名" placeholder="留空，按路由名自动创建" :hint="`留空使用：${fallbackCodexThreadName()}`" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('codex').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-text-field v-model="gateway.agentModel" class="full-span" label="模型覆盖" placeholder="留空，沿用原会话模型" hint="只在需要强制指定 Agent 模型时填写" persistent-hint @update:model-value="touch" />
                  </div>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="agentStateFor('codex').lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').lastNotificationError }}
                    </v-alert>
                    <v-alert v-else-if="agentStateFor('codex').message" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').message }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="agentStateFor('codex').monitorThreadId ? 'text-success' : 'text-warning'">{{ agentStateFor('codex').monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ agentStateFor('codex').monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('codex').lastNotificationAt || "-" }}</b></div>
                    <div class="status-row"><span>最近通道</span><b>{{ codexDeliveryChannelLabel(agentStateFor('codex')) }}</b></div>
                    <div class="status-row"><span>可见性</span><b>{{ codexDeliveryVisibilityLabel(agentStateFor('codex')) }}</b></div>
                  </template>
                </template>
                <!-- Copilot CLI -->
                <template v-else-if="agent.type === 'copilotCli'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.copilotCliBin" :items="agentScan.copilotBins" label="CLI 可执行路径" placeholder="copilot" hint="留空则使用 PATH 中的 copilot" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.copilotBins.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotCwd" :items="agentProjectItems('copilotCli')" label="工作目录 (-C)" placeholder="留空则使用 RabiRoute 根目录" hint="copilot -C &lt;目录&gt;，影响会话分组" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexThreadName" :items="sessionNamesFor('copilotCli')" label="会话线程名" placeholder="Rabi" hint="Copilot CLI session 名称（--name 参数）" persistent-hint @update:model-value="selectCopilotSession">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <!-- 安装/登录操作区 -->
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span v-if="copilotStatus === null" class="section-note">检测中…</span>
                      <template v-else>
                        <v-chip size="x-small" :color="copilotStatus.installed ? 'success' : 'error'" variant="tonal" class="mr-1">
                          {{ copilotStatus.installed ? '已安装' : '未安装' }}
                        </v-chip>
                        <v-chip size="x-small" :color="copilotStatus.loggedIn ? 'success' : 'warning'" variant="tonal">
                          {{ copilotStatus.loggedIn ? '已登录' : '未登录' }}
                        </v-chip>
                      </template>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn v-if="copilotStatus && !copilotStatus.installed" size="small" variant="tonal" color="primary"
                        :loading="copilotInstalling" prepend-icon="mdi-download" @click="installCopilotCli">
                        安装 Copilot CLI
                      </v-btn>
                      <v-btn v-if="copilotStatus && copilotStatus.installed && !copilotStatus.loggedIn && !copilotLoginState.code"
                        size="small" variant="tonal" color="secondary"
                        :loading="copilotLoginState.loading" prepend-icon="mdi-login" @click="startCopilotLogin">
                        登录
                      </v-btn>
                      <v-btn v-if="copilotStatus" size="small" variant="text" icon="mdi-refresh" @click="fetchCopilotStatus" title="刷新状态" />
                    </div>
                  </div>
                  <!-- 登录 device code -->
                  <v-alert v-if="copilotLoginState.code" type="info" variant="tonal" density="compact" class="mt-2">
                    <div class="d-flex align-center justify-space-between flex-wrap ga-2">
                      <div>
                        在浏览器访问 <a :href="copilotLoginState.url ?? 'https://github.com/login/device'" target="_blank">github.com/login/device</a>，输入验证码：
                        <strong class="ml-1" style="font-size:1.1em;letter-spacing:2px">{{ copilotLoginState.code }}</strong>
                      </div>
                      <v-chip size="small" color="info" variant="tonal">等待授权…</v-chip>
                    </div>
                  </v-alert>
                  <v-alert v-if="copilotLoginState.done" type="success" variant="tonal" density="compact" class="mt-2">登录成功</v-alert>
                  <v-alert v-if="copilotLoginState.error" type="error" variant="tonal" density="compact" class="mt-2">{{ copilotLoginState.error }}</v-alert>
                  <!-- 运行时诊断 -->
                  <template v-if="runtime.running !== undefined">
                    <div class="mt-2">
                      <template v-if="agentStateFor('copilotCli').lastNotificationError">
                        <v-alert type="warning" variant="tonal" density="compact" class="mb-1">
                          {{ agentStateFor('copilotCli').lastNotificationError }}
                        </v-alert>
                      </template>
                      <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('copilotCli').lastNotificationAt || "-" }}</b></div>
                      <div class="status-row"><span>来源</span><b>{{ agentStateFor('copilotCli').monitorThreadSource || "-" }}</b></div>
                      <div class="status-row"><span>状态文件</span><b>{{ agentStateFor('copilotCli').statePath || "-" }}</b></div>
                    </div>
                  </template>
                </template>
                <!-- Marvis -->
                <template v-else-if="agent.type === 'marvis'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    当前 Marvis 适配器不会列出会话，也不会创建或复用线程；它只负责打开目标 App 并把 prompt 放到剪贴板。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.marvisAppId" :items="agentScan.marvisAppIds" label="应用 ID" placeholder="Tencent.Marvis" hint="留空使用默认 Tencent.Marvis" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.marvisAppIds.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">可先打开 Marvis 确认桌面端可用；真正消息会在路由触发时复制为 prompt。</span>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        prepend-icon="mdi-open-in-app"
                        :loading="openingMarvis"
                        :disabled="openingMarvis"
                        @click="openMarvis"
                      >
                        打开 Marvis
                      </v-btn>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agentScan.loading" @click="runAgentScan">
                        重新扫描
                      </v-btn>
                    </div>
                  </div>
                  <v-alert
                    v-if="marvisOpenResult"
                    :type="marvisOpenResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ marvisOpenResult.message }}
                  </v-alert>
                </template>
                <template v-else-if="agent.type === 'astrbot'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    AstrBot 会优先绑定 ChatUI 项目和会话；未选择会话时才回退到 rabiroute_agent 插件默认管线。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot 仪表盘地址，需安装 rabiroute_agent 插件"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-btn
                          size="x-small"
                          variant="tonal"
                          color="primary"
                          :loading="deployingAstrbot"
                          :disabled="deployingAstrbot"
                          @click="deployAstrbotAdapter"
                          title="一键部署/更新 AstrBot Adapter"
                        >
                          <v-icon start>mdi-rocket-launch</v-icon>
                          部署
                        </v-btn>
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.astrbotUsername"
                      label="AstrBot 用户名"
                      placeholder="留空使用环境变量 ASTRBOT_USERNAME"
                      hint="不填则默认沿用适配器默认用户名"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-text-field
                      v-model="gateway.astrbotPassword"
                      type="password"
                      label="AstrBot 密码"
                      placeholder="留空则使用环境变量 ASTRBOT_PASSWORD"
                      hint="仅写入本地 route 配置；也可用私有环境变量提供"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-select
                      v-model="gateway.astrbotProjectId"
                      :items="astrbotProjectItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 项目"
                      placeholder="可选：先选项目再筛选会话"
                      hint="来自 AstrBot ChatUI 项目列表；没有项目也可以直接选会话"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotProject"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                    <v-select
                      v-model="gateway.astrbotSessionId"
                      :items="astrbotSessionItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 会话"
                      placeholder="选择一个 ChatUI 会话"
                      hint="选择后消息会投递到同一个会话；不选则使用旧插件默认管线"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                  </div>
                  <div class="mt-2">
                    <div
                      v-for="endpoint in agentScanFor('astrbot')?.endpoints ?? []"
                      :key="endpoint.url"
                      class="status-row"
                    >
                      <span>{{ endpoint.label }}</span>
                      <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                    </div>
                    <div class="status-row">
                      <span>鉴权</span>
                      <b :class="agentScanFor('astrbot')?.auth?.loggedIn ? 'text-success' : 'text-warning'">
                        {{ agentScanFor('astrbot')?.auth?.message || "-" }}
                      </b>
                    </div>
                    <div class="status-row">
                      <span>ChatUI 会话</span>
                      <b :class="astrbotSessionItems().length ? 'text-success' : 'text-warning'">
                        {{ astrbotSessionItems().length ? `可选 ${astrbotSessionItems().length} 个` : "未读取到会话" }}
                      </b>
                    </div>
                    <div
                      v-for="plugin in agentScanFor('astrbot')?.plugins ?? []"
                      :key="plugin.id"
                      class="status-row"
                    >
                      <span>{{ plugin.name }}</span>
                      <b :class="plugin.installed ? 'text-success' : 'text-warning'">{{ plugin.installed ? "已安装" : "未安装" }}</b>
                    </div>
                  </div>
                  <div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">用当前填写的地址、用户名和密码请求 AstrBot 登录接口。</span>
                    </div>
                    <v-btn
                      size="small"
                      variant="tonal"
                      color="secondary"
                      prepend-icon="mdi-login-variant"
                      :loading="testingAstrbotLogin"
                      :disabled="testingAstrbotLogin"
                      @click="testAstrbotLogin"
                    >
                      验证登录
                    </v-btn>
                  </div>
                  <v-alert
                    v-if="astrbotLoginResult"
                    :type="astrbotLoginResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ astrbotLoginResult.message }}
                  </v-alert>
                  <v-alert
                    v-if="astrbotDeployResult"
                    :type="astrbotDeployResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    <div>{{ astrbotDeployResult.message }}</div>
                    <pre v-if="astrbotDeployResult.detail" class="deploy-output">{{ astrbotDeployResult.detail }}</pre>
                  </v-alert>
                </template>
              </div>
            </v-expand-transition>
          </div>

          <div v-if="visibleAgentItems.length === 0" class="empty-state compact-empty">
            <div>
              <strong>尚未添加任何 Agent 端</strong>
              <span>点击下方按钮添加。</span>
            </div>
          </div>
        </div>

        <div class="adapter-add-row">
          <v-menu v-model="addAgentMenu" location="bottom start">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                prepend-icon="mdi-plus"
                variant="tonal"
                size="small"
                :disabled="availableAgentsToAdd.length === 0"
              >
                添加 Agent
              </v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="agent in availableAgentsToAdd"
                :key="agent.type"
                :title="agent.title"
                @click="addAgent(agent.type)"
              />
            </v-list>
          </v-menu>
        </div>
      </v-card>
    </template>
  </div>
</template>
