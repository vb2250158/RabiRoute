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

async function runMessageAdapterScan(): Promise<void> {
  if (messageAdapterScan.value.loading) return;
  messageAdapterScan.value.loading = true;
  try {
    const res = await fetch("/api/scan/message-adapters");
    const data = await res.json();
    messageAdapterScan.value.adapters = data.adapters ?? {};
  } catch { /* ignore */ }
  finally { messageAdapterScan.value.loading = false; }
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
  napcat: false,
  heartbeat: false,
  fennenote: false,
  xiaoai: false,
  webhook: false
});
const addAdapterMenu = ref(false);
const adapterGroups: Array<{ title: string; note: string; choices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> }> = [
  {
    title: "实时消息",
    note: "来自聊天软件或即时通信平台的入口。",
    choices: [
      { type: "napcat", title: "NapCat / OneBot", note: "接收 QQ 群聊和私聊实时消息", icon: "mdi-message-badge-outline" }
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
      { type: "xiaoai", title: "小米音箱 / 小爱", note: "接收小爱音箱语音转写", icon: "mdi-speaker-wireless" }
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

// 所有已添加的 adapter（含禁用），用于 UI 列表显示
const addedAdapters = computed<MessageAdapterType[]>(() => {
  const gw = gateway.value;
  if (!gw) return [];
  if (Array.isArray(gw.messageAdapters) && gw.messageAdapters.length > 0)
    return gw.messageAdapters.filter((t): t is MessageAdapterType => t !== "disabled");
  return [gw.messageAdapterType || "napcat"] as MessageAdapterType[];
});
// 仅启用的 adapter（不含禁用）
const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);
const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);
const napcatState = computed(() => runtime.value.gatewayStatus?.napcat || {} as Record<string, any>);
const heartbeatState = computed(() => runtime.value.gatewayStatus?.heartbeat || {} as Record<string, any>);
const adapterErrors = (type: MessageAdapterType) => gateway.value ? adapterErrorsFor(type, gateway.value, runtime.value) : [];
const activeAdapterCount = computed(() => adapters.value.length);
const testingNapcatHealth = ref(false);
const testingNapcatInstance = ref<Record<string, boolean>>({});
const launchingNapcatInstance = ref<Record<string, boolean>>({});
const copyingNapcatToken = ref(false);
const copyingNapcatInstanceToken = ref<Record<string, boolean>>({});
const napcatHealthResult = ref<{
  ok?: boolean;
  http?: { ok?: boolean; status?: number; message?: string; userId?: string | number; nickname?: string };
  webui?: {
    url?: string;
    reachable?: boolean;
    found?: boolean;
    tokenFound?: boolean;
    token?: string;
    tokenLength?: number;
    configPath?: string;
    loginUrl?: string;
    message?: string;
  };
  process?: { found?: boolean; candidates?: Array<{ name: string; pid: string }> };
  wsUrl?: string;
  message?: string;
} | null>(null);
const napcatInstanceHealthResult = ref<Record<string, typeof napcatHealthResult.value>>({});
const napcatLaunchResult = ref<Record<string, { ok: boolean; message: string }>>({});
const copyResult = ref("");
const triggeringHeartbeat = ref(false);
const heartbeatTriggerResult = ref<{ ok: boolean; message: string } | null>(null);
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
  if (!gateway.value) return;
  toggleAdapterDisabled(gateway.value, type);
  store.touch();
}

function setMessageInputsDisabled(disabled: boolean): void {
  if (!gateway.value) return;
  gateway.value.messageInputsDisabled = disabled;
  store.touch();
}

function hasAdapterParams(type: MessageAdapterType): boolean {
  return type === "napcat" || type === "heartbeat" || isWebhookLikeAdapter(type);
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
}

function removeAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = adapters.value.filter(t => t !== type);
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = false;
  store.touch();
}

const availableToAdd = computed(() => {
  const allTypes: MessageAdapterType[] = ["napcat", "heartbeat", "fennenote", "xiaoai", "webhook"];
  return allTypes.filter(t => !addedAdapters.value.includes(t));
});

function addAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = [...addedAdapters.value, type];
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = true;
  void runMessageAdapterScan();
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
  return gateway.value?.napcatWebuiUrl?.trim() || "http://127.0.0.1:6099/webui";
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
      accessToken: gateway.value.napcatAccessToken || ""
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
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ]),
    ...store.managerRows.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.fenneNoteWebhookPort),
      Number(item.xiaoaiWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ])
  ].filter(port => Number.isFinite(port) && port > 0));
  let port = base;
  while (used.has(port)) port += 1;
  return port;
}

function addNapcatInstance(): void {
  if (!gateway.value) return;
  const instances = ensureNapcatInstances();
  const index = instances.length + 1;
  instances.push({
    id: `napcat-${index}`,
    name: `NapCat ${index}`,
    enabled: true,
    gatewayPort: nextNapcatPort(Number(gateway.value.gatewayPort || 8789) + 1),
    httpUrl: `http://127.0.0.1:${3000 + instances.length}`,
    webuiUrl: defaultNapcatWebuiUrl(),
    accessToken: ""
  });
  store.touch();
}

function removeNapcatInstance(index: number): void {
  if (!gateway.value) return;
  const instances = ensureNapcatInstances();
  if (instances.length <= 1) return;
  instances.splice(index, 1);
  syncPrimaryNapcatFromInstances();
  store.touch();
}

function removeNapcatInstanceById(id: string): void {
  const index = ensureNapcatInstances().findIndex(item => item.id === id);
  if (index >= 0) removeNapcatInstance(index);
}

function isConfiguredNapcatInstance(instance: NapCatInstance): boolean {
  return ensureNapcatInstances().some(item => item.id === instance.id);
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
  return Number(gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790);
}

function webhookPathFor(type: MessageAdapterType): string {
  if (type === "fennenote") return gateway.value?.fenneNoteWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "xiaoai") return gateway.value?.xiaoaiWebhookPath || adapterDefaultWebhookPath(type);
  return gateway.value?.webhookPath || adapterDefaultWebhookPath(type);
}

function setWebhookPort(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const port = Number(value || 0);
  if (type === "fennenote") gateway.value.fenneNoteWebhookPort = port;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPort = port;
  else gateway.value.webhookPort = port;
  touch();
}

function setWebhookPath(type: MessageAdapterType, value: unknown): void {
  if (!gateway.value) return;
  const path = String(value || "");
  if (type === "fennenote") gateway.value.fenneNoteWebhookPath = path;
  else if (type === "xiaoai") gateway.value.xiaoaiWebhookPath = path;
  else gateway.value.webhookPath = path;
  touch();
}

function webhookUrl(type: MessageAdapterType = "webhook"): string {
  return `http://127.0.0.1:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookCurl(type: MessageAdapterType = "webhook"): string {
  const source = adapterSourceAliases(type)[0] || type;
  return `curl -X POST "${webhookUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"test\",\"message\":\"hello from RabiRoute\"}"`;
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

function napcatAccountInstances(): NapCatInstance[] {
  const configured = ensureNapcatInstances();
  const merged = [...configured];
  for (const item of napcatRuntimeInstances()) {
    const id = String(item.id || item.instanceId || item.name || item.botUserId || item.userId || item.selfId || "");
    const port = Number(item.gatewayPort || item.port || item.wsPort || 0);
    const exists = merged.some(instance =>
      (id && String(instance.id) === id) ||
      (port && Number(instance.gatewayPort || 0) === port)
    );
    if (exists) continue;
    merged.push({
      id: id || `runtime-${merged.length + 1}`,
      name: item.name || item.instanceName || "运行中 NapCat",
      enabled: item.enabled !== false,
      gatewayPort: port || Number(gateway.value?.gatewayPort || 8790),
      httpUrl: item.httpUrl || item.napcatHttpUrl || gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl || item.napcatWebuiUrl || gateway.value?.napcatWebuiUrl,
      accessToken: item.accessToken || "",
      botUserId: item.botUserId || item.userId || item.selfId,
      botNickname: item.botNickname || item.nickname,
      connected: item.connected
    });
  }
  return merged;
}

function napcatRuntimeFor(instance: NapCatInstance): Record<string, any> {
  const id = String(instance.id || "");
  const port = Number(instance.gatewayPort || 0);
  const found = napcatRuntimeInstances().find(item =>
    String(item.id || item.instanceId || "") === id ||
    Number(item.gatewayPort || item.port || item.wsPort || 0) === port
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
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || "");
}

function napcatAccountNickname(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botNickname || runtimeInfo.botNickname || runtimeInfo.nickname || health.http?.nickname || "");
}

function napcatAccountConnected(instance: NapCatInstance): boolean {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  if (typeof instance.connected === "boolean") return instance.connected;
  if (typeof runtimeInfo.connected === "boolean") return runtimeInfo.connected;
  if (health.http?.ok) return true;
  return false;
}

function napcatAccountLoginLabel(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const runtimeInfo = napcatRuntimeFor(instance);
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return String(runtimeInfo.loginInfoError || instance.loginInfoError);
  if (userId) return "已登录";
  return "等待后端回填登录 QQ";
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
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl || defaultNapcatWebuiUrl(),
      accessToken: instance.accessToken,
      gatewayPort: instance.gatewayPort
    };
  }
  return {
    httpUrl: gateway.value?.napcatHttpUrl,
    webuiUrl: defaultNapcatWebuiUrl(),
    accessToken: gateway.value?.napcatAccessToken,
    gatewayPort: gateway.value?.gatewayPort
  };
}

async function openNapcatWebuiWithToken(instance?: NapCatInstance): Promise<void> {
  const fallbackUrl = instance?.webuiUrl || defaultNapcatWebuiUrl();
  const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(napcatHealthPayload(instance))
    });
    const body = await resp.json().catch(() => ({}));
    const target = body?.webui?.loginUrl || body?.webui?.url || fallbackUrl;
    if (popup) popup.location.href = target;
    else openExternalUrl(target);
    if (instance?.id) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [instance.id]: { ok: Boolean(body.ok), ...body }
      };
    } else {
      napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
    }
  } catch {
    if (popup) popup.location.href = fallbackUrl;
    else openExternalUrl(fallbackUrl);
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
      await copyText(token, "已复制 NapCat WebUI Token");
    } else {
      showCopyResult(body?.webui?.message || "未读取到 NapCat WebUI Token，请检查 NapCat config/webui.json 或启动日志。");
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
  testingNapcatInstance.value = { ...testingNapcatInstance.value, [instance.id]: true };
  napcatInstanceHealthResult.value = { ...napcatInstanceHealthResult.value, [instance.id]: null };
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl || defaultNapcatWebuiUrl(),
        accessToken: instance.accessToken,
        gatewayPort: instance.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [instance.id]: { ok: Boolean(body.ok), ...body }
    };
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

function renameCurrentConfig(value: unknown): void {
  if (!gateway.value) return;
  const result = store.renameGatewayConfig(gateway.value.id, value);
  configNameError.value = result.message || "";
}

const agentDefs: Array<{ type: AgentAdapterType; title: string; note: string; icon: string; hasCwd: boolean; hasThread: boolean }> = [
  { type: "codexDesktop", title: "Codex Desktop", note: "通过 Codex Desktop 桌面端投递消息", icon: "mdi-monitor-dashboard", hasCwd: true, hasThread: true },
  { type: "codexApp",     title: "Codex App",     note: "通过 Codex App 投递消息",          icon: "mdi-application-outline", hasCwd: true, hasThread: true },
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
  const canUseLegacyCodexState = (type === "codexDesktop" || type === "codexApp")
    && (runtimeAgents.length === 0 || runtimeAgents.includes(type))
    && (!runtime.value.codexState?.agentAdapterType || runtime.value.codexState.agentAdapterType === type);
  return canUseLegacyCodexState ? runtime.value.codexState ?? {} : {};
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
  if (type === "codexDesktop" || type === "codexApp") return gateway.value.codexCwd || "";
  return "";
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
  if (type === "codexDesktop" || type === "codexApp") {
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
      </div>
    </div>

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
            <div class="section-note">这里决定 RabiRoute 从哪些入口接收消息。多个入口可以并存，禁用时仅保留配置。</div>
          </div>
          <div class="adapter-master-actions">
            <v-switch
              :model-value="messageInputsDisabled"
              label="禁用消息端"
              color="warning"
              inset
              hide-details
              @update:model-value="value => setMessageInputsDisabled(Boolean(value))"
            />
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
            <v-chip v-for="type in adapters" :key="type" size="small" color="secondary" variant="tonal">
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
                :class="{ active: adapters.includes(choice.type) }"
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
                  <div @click.stop>
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
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="messageAdapterScan.loading" @click="runMessageAdapterScan">
                          重新扫描
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
                  <div v-if="choice.type === 'napcat'" class="catalog-param-grid">
                    <v-text-field v-model.number="gateway.gatewayPort" type="number" label="WebSocket 端口" @update:model-value="touch" />
                    <v-text-field v-model="gateway.napcatHttpUrl" label="HTTP 地址" @update:model-value="touch" />
                    <v-text-field v-model="gateway.napcatWebuiUrl" label="WebUI 地址" placeholder="http://127.0.0.1:6099/webui" @update:model-value="touch" />
                    <v-text-field v-model="gateway.napcatAccessToken" class="full-span" label="OneBot HTTP Access Token" placeholder="可选，不是 NapCat WebUI 登录 Token" @update:model-value="touch" />
                    <div class="full-span">
                      <div class="section-title-row mb-2">
                        <div>
                          <div class="section-title small-title">NapCat 账号</div>
                          <div class="section-note">每个已登录 QQ 独立成卡片；后端回填 botUserId / botNickname / connected 后会自动显示。</div>
                        </div>
                      </div>
                      <div class="napcat-account-grid">
                        <div
                          v-for="instance in napcatAccountInstances()"
                          :key="instance.id"
                          class="napcat-account-card"
                        >
                          <div class="napcat-account-head">
                            <div>
                              <div class="napcat-account-title">{{ napcatAccountUserId(instance) || "未识别 QQ" }}</div>
                              <div class="section-note">{{ napcatAccountNickname(instance) || "等待登录信息" }}</div>
                            </div>
                            <v-chip size="x-small" :color="napcatAccountConnected(instance) ? 'success' : 'warning'" variant="tonal">
                              {{ napcatAccountConnected(instance) ? "已连接" : "未连接" }}
                            </v-chip>
                          </div>
                          <div class="status-row"><span>实例</span><b>{{ instance.name || instance.id || "-" }}</b></div>
                          <div class="status-row"><span>端口</span><b>{{ instance.gatewayPort || "-" }}</b></div>
                          <div class="status-row"><span>登录</span><b :class="napcatAccountUserId(instance) ? 'text-success' : 'text-warning'">{{ napcatAccountLoginLabel(instance) }}</b></div>
                          <div class="status-row"><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                          <div class="catalog-param-grid mt-2">
                            <v-text-field v-model="instance.name" label="实例名称" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.id" label="实例 ID" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model.number="instance.gatewayPort" type="number" label="WS 端口" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.httpUrl" label="HTTP 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.webuiUrl" label="WebUI 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.accessToken" label="OneBot HTTP Access Token" placeholder="可选，不是 WebUI 登录 Token" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.launchCommand" class="full-span" label="启动命令" placeholder="例如 launcher.bat 123456 或 NapCatWinBootMain.exe 10001" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                            <v-text-field v-model="instance.workingDir" class="full-span" label="工作目录" placeholder="NapCat Shell 所在目录，可选" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                          </div>
                          <div class="agent-action-bar mt-2">
                            <div class="agent-action-status">
                              <span class="section-note">WS：{{ napcatInstanceWsUrl(instance) }}</span>
                            </div>
                            <div class="d-flex ga-2 flex-wrap">
                              <v-switch
                                v-model="instance.enabled"
                                color="secondary"
                                density="compact"
                                hide-details
                                label="启用"
                                :disabled="!isConfiguredNapcatInstance(instance)"
                                @update:model-value="touch"
                              />
                              <v-btn size="small" variant="text" prepend-icon="mdi-open-in-new" @click="openNapcatWebuiWithToken(instance)">
                                打开 WebUI
                              </v-btn>
                              <v-btn
                                size="small"
                                variant="text"
                                prepend-icon="mdi-key-variant"
                                :loading="copyingNapcatInstanceToken[instance.id]"
                                :disabled="copyingNapcatInstanceToken[instance.id]"
                                @click="copyNapcatWebuiToken(instance)"
                              >
                                复制 Token
                              </v-btn>
                              <v-btn
                                size="small"
                                variant="tonal"
                                color="secondary"
                                prepend-icon="mdi-stethoscope"
                                :loading="testingNapcatInstance[instance.id]"
                                :disabled="testingNapcatInstance[instance.id]"
                                @click="testNapcatInstanceHealth(instance)"
                              >
                                检查
                              </v-btn>
                              <v-btn
                                size="small"
                                variant="tonal"
                                color="primary"
                                prepend-icon="mdi-play"
                                :loading="launchingNapcatInstance[instance.id]"
                                :disabled="launchingNapcatInstance[instance.id] || !instance.launchCommand"
                                :title="instance.launchCommand ? '启动这个已保存的 NapCat 后台' : '请先填写启动命令并保存配置'"
                                @click="launchNapcatInstance(instance)"
                              >
                                {{ instance.launchCommand ? "启动后台" : "先填启动命令" }}
                              </v-btn>
                              <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyText(napcatInstanceWsUrl(instance), '已复制 NapCat WS 地址')">
                                复制 WS
                              </v-btn>
                              <v-btn
                                v-if="ensureNapcatInstances().length > 1 && isConfiguredNapcatInstance(instance)"
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
                            v-if="!instance.launchCommand"
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
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui">
                              WebUI：{{ napcatInstanceHealthResult[instance.id]?.webui?.reachable ? "可访问" : "未响应" }} · {{ napcatInstanceHealthResult[instance.id]?.webui?.url }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.tokenFound || napcatInstanceHealthResult[instance.id]?.webui?.found">
                              WebUI Token：已从配置读取 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位登录密钥。
                            </div>
                            <div v-else-if="napcatInstanceHealthResult[instance.id]?.webui?.message">
                              WebUI Token：{{ napcatInstanceHealthResult[instance.id]?.webui?.message }}
                            </div>
                            <div>WS：请在对应 NapCat WebSocket Client 里连接 {{ napcatInstanceHealthResult[instance.id]?.wsUrl || napcatInstanceWsUrl(instance) }}</div>
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                v-if="napcatInstanceHealthResult[instance.id]?.webui?.loginUrl"
                                size="small"
                                variant="tonal"
                                color="primary"
                                prepend-icon="mdi-open-in-new"
                                @click="openExternalUrl(napcatInstanceHealthResult[instance.id]?.webui?.loginUrl)"
                              >
                                打开带 Token
                              </v-btn>
                              <v-btn
                                v-if="napcatInstanceHealthResult[instance.id]?.webui?.token"
                                size="small"
                                variant="text"
                                prepend-icon="mdi-key-variant"
                                @click="copyText(napcatInstanceHealthResult[instance.id]?.webui?.token || '', '已复制 NapCat WebUI Token')"
                              >
                                复制 WebUI Token
                              </v-btn>
                            </div>
                          </v-alert>
                          <div class="adapter-log-panel mt-3">
                            <div class="section-title-row compact-row">
                              <div>
                                <div class="section-title small-title">{{ napcatAccountUserId(instance) || instance.name || "NapCat 账号" }} 日志</div>
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
                              <div class="section-title small-title">{{ napcatAccountUserId(instance) || instance.name || "NapCat 账号" }} 消息文件</div>
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
                          <span>新增一个 NapCat instance</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  <template v-if="choice.type === 'napcat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('napcat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('napcat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>WS 连接</span><b :class="napcatState.connected ? 'text-success' : 'text-error'">{{ napcatState.connected ? "已连接" : "未连接" }}</b></div>
                    <div class="status-row"><span>远端地址</span><b>{{ napcatState.remoteAddress || "-" }}</b></div>
                    <div class="status-row"><span>最后连接</span><b>{{ napcatState.lastConnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>最后断开</span><b>{{ napcatState.lastDisconnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>登录资料</span><b :class="napcatState.loginInfoError ? 'text-error' : ''">{{ napcatState.loginInfoError || napcatState.lastLoginInfoAt || "-" }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">先在 NapCat WebUI 里启用 WebSocket Client 和 HTTP Server；RabiRoute 只做检查和跳转。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="primary"
                          prepend-icon="mdi-open-in-new"
                          @click="openNapcatWebuiWithToken()"
                        >
                          打开 NapCat
                        </v-btn>
                        <v-btn
                          size="small"
                          variant="text"
                          prepend-icon="mdi-key-variant"
                          :loading="copyingNapcatToken"
                          :disabled="copyingNapcatToken"
                          @click="copyNapcatWebuiToken()"
                        >
                          复制 Token
                        </v-btn>
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="secondary"
                          prepend-icon="mdi-stethoscope"
                          :loading="testingNapcatHealth"
                          :disabled="testingNapcatHealth"
                          @click="testNapcatHealth"
                        >
                          检查启动
                        </v-btn>
                        <v-btn
                          size="small"
                          variant="text"
                          prepend-icon="mdi-content-copy"
                          @click="copyText(napcatWsUrl(), '已复制 NapCat WS 地址')"
                        >
                          复制 WS
                        </v-btn>
                        <v-btn
                          size="small"
                          variant="text"
                          prepend-icon="mdi-content-copy"
                          @click="copyText(gateway.napcatHttpUrl || '', '已复制 NapCat HTTP 地址')"
                        >
                          复制 HTTP
                        </v-btn>
                      </div>
                    </div>
                    <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                      {{ copyResult }}
                    </v-alert>
                    <v-alert
                      v-if="napcatHealthResult"
                      :type="napcatHealthResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="mt-2"
                    >
                      <div v-if="napcatHealthResult.message">{{ napcatHealthResult.message }}</div>
                      <div v-if="napcatHealthResult.http">
                        HTTP：{{ napcatHealthResult.http.ok ? `可用，${napcatHealthResult.http.nickname || napcatHealthResult.http.userId || '已登录'}` : (napcatHealthResult.http.message || '不可用') }}
                      </div>
                      <div v-if="napcatHealthResult.webui">
                        WebUI：{{ napcatHealthResult.webui.reachable ? "可访问" : "未响应" }} · {{ napcatHealthResult.webui.url }}
                      </div>
                      <div v-if="napcatHealthResult.webui?.found">
                        WebUI Token：已从配置读取 {{ napcatHealthResult.webui.tokenLength || "-" }} 位登录密钥。
                      </div>
                      <div v-else-if="napcatHealthResult.webui?.message">
                        WebUI Token：{{ napcatHealthResult.webui.message }}
                      </div>
                      <div>
                        WS：请在 NapCat WebSocket Client 里连接 {{ napcatHealthResult.wsUrl || `ws://127.0.0.1:${gateway.gatewayPort}` }}；当前 {{ napcatState.connected ? "已连接" : "未连接" }}
                      </div>
                      <div v-if="napcatHealthResult.process">
                        进程：{{ napcatHealthResult.process.found ? napcatHealthResult.process.candidates?.map(item => `${item.name}(${item.pid})`).join(", ") : "未发现 NapCat/QQNT 相关进程" }}
                      </div>
                      <div class="d-flex ga-2 flex-wrap mt-2">
                        <v-btn
                          v-if="napcatHealthResult.webui?.loginUrl"
                          size="small"
                          variant="tonal"
                          color="primary"
                          prepend-icon="mdi-open-in-new"
                          @click="openExternalUrl(napcatHealthResult.webui.loginUrl)"
                        >
                          打开带 Token
                        </v-btn>
                        <v-btn
                          v-if="napcatHealthResult.webui?.token"
                          size="small"
                          variant="text"
                          prepend-icon="mdi-key-variant"
                          @click="copyText(napcatHealthResult.webui.token, '已复制 NapCat WebUI Token')"
                        >
                          复制 WebUI Token
                        </v-btn>
                      </div>
                    </v-alert>
                  </template>
                  <div v-else-if="choice.type === 'heartbeat'" class="catalog-param-grid">
                    <v-text-field v-model.number="gateway.heartbeatIntervalSeconds" type="number" label="触发间隔（秒）" @update:model-value="touch" />
                    <v-text-field v-model="gateway.heartbeatMessage" label="触发消息" @update:model-value="touch" />
                  </div>
                  <template v-if="choice.type === 'heartbeat' && runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('heartbeat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('heartbeat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>触发器状态</span><b :class="heartbeatState.enabled === false ? 'text-error' : 'text-success'">{{ heartbeatState.enabled === false ? "未启用" : "已启用" }}</b></div>
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
                  <div v-else-if="isWebhookLikeAdapter(choice.type)" class="catalog-param-grid">
                    <v-text-field :model-value="webhookPortFor(choice.type)" type="number" :label="`${sourceTitle(choice.type)} 监听端口`" @update:model-value="value => setWebhookPort(choice.type, value)" />
                    <v-text-field :model-value="webhookPathFor(choice.type)" :label="`${sourceTitle(choice.type)} 路径`" :placeholder="adapterDefaultWebhookPath(choice.type)" @update:model-value="value => setWebhookPath(choice.type, value)" />
                  </div>
                  <template v-if="isWebhookLikeAdapter(choice.type) && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl(choice.type) }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">{{ sourceTitle(choice.type) }} 使用底层 HTTP 回调；这里只复制测试命令，不会自动发送。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(webhookUrl(choice.type), `已复制 ${sourceTitle(choice.type)} 地址`)">
                          复制地址
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

        <v-alert v-if="messageInputsDisabled" type="warning" variant="tonal">当前路由暂时不接收任何消息入口；下面的入口启用状态会保留，关闭禁用后继续使用。</v-alert>
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
                <!-- Codex Desktop -->
                <template v-if="agent.type === 'codexDesktop'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codexDesktop')" label="工作目录" placeholder="C:/Path/To/Project" hint="Agent 打开的项目目录" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('codexDesktop').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexThreadName" :items="sessionNamesFor('codexDesktop')" label="会话线程名" placeholder="Rabi" hint="Codex Desktop 里对话窗口的名称" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('codexDesktop').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="agentStateFor('codexDesktop').lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codexDesktop').lastNotificationError }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="agentStateFor('codexDesktop').monitorThreadId ? 'text-success' : 'text-warning'">{{ agentStateFor('codexDesktop').monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ agentStateFor('codexDesktop').monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('codexDesktop').lastNotificationAt || "-" }}</b></div>
                  </template>
                </template>
                <!-- Codex App -->
                <template v-else-if="agent.type === 'codexApp'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codexApp')" label="工作目录" placeholder="C:/Path/To/Project" hint="Agent 打开的项目目录" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('codexApp').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexThreadName" :items="sessionNamesFor('codexApp')" label="会话线程名" placeholder="Rabi" hint="Codex App 里的对话线程名" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('codexApp').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="agentStateFor('codexApp').lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codexApp').lastNotificationError }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="agentStateFor('codexApp').monitorThreadId ? 'text-success' : 'text-warning'">{{ agentStateFor('codexApp').monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ agentStateFor('codexApp').monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('codexApp').lastNotificationAt || "-" }}</b></div>
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
