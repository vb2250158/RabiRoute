<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, onMounted } from "vue";
import { userFacingError } from "../userFacingError";
import { useRoute } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { NapcatState, type NapcatLoginPanelData, type NapcatHealthSnapshot } from "@shared/napcatStateContract";
import type { MessageAdapterType, MessageAdapterScanResult, NapCatInstance } from "../types";
import { adapterRuntimeKey, adapterErrorsFor, applyAdapterDefaults, gatewayAdapterTypes, isMessageInputsDisabled, messageAdapterPolicyFor, setMessageAdapterPolicy } from "../utils/gatewayHelpers";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const route = useRoute();

const runtime = computed(() => store.selectedRuntime);

const messageAdapterScan = ref({
  adapters: {} as Partial<Record<MessageAdapterType, MessageAdapterScanResult>>,
  loading: false,
  error: "",
  overall: null as null | { state: "healthy" | "degraded" | "unknown"; message: string },
  partial: false,
  durationMs: 0,
  checkedAt: ""
});

const repairingNapcatAll = ref(false);

const napcatAutoSteps = ref<Record<string, { ok?: boolean; message: string; steps: string[] }>>({});

type NapCatAccountRow = {
  key: string;
  instance: NapCatInstance;
  endpointLabel: string;
  endpointHealthy?: boolean;
  source: "scan" | "configured" | "runtime" | "discovered";
};

type NapcatLoginMode = "quick" | "password" | "qrcode";

type NapcatLoginUiState = {
  visible: boolean;
  loading: boolean;
  busy: boolean;
  mode: NapcatLoginMode;
  quickUserId: string;
  userId: string;
  password: string;
  message: string;
  error: string;
  panel: NapcatLoginPanelData | null;
  captcha: { proofWaterUrl: string } | null;
  newDevice: {
    jumpUrl: string;
    newDevicePullQrCodeSig: string;
    qrCodeDataUrl: string;
    bytesToken: string;
    status: "loading" | "waiting" | "scanned" | "confirmed" | "error";
  } | null;
};

type NapCatScanHealthEntry = Record<string, any> & {
  gatewayName?: string;
  instanceName?: string;
};

async function runMessageAdapterScan(): Promise<void> {
  if (messageAdapterScan.value.loading) return;
  messageAdapterScan.value.loading = true;
  messageAdapterScan.value.error = "";
  try {
    const params = new URLSearchParams();
    if (gateway.value?.id) params.set("gatewayId", gateway.value.id);
    const res = await fetch(`/api/scan/message-adapters${params.toString() ? `?${params}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `消息端扫描失败（HTTP ${res.status}）`);
    messageAdapterScan.value.adapters = data.adapters ?? {};
    messageAdapterScan.value.overall = data.health?.overall ?? null;
    messageAdapterScan.value.partial = data.scan?.partial === true;
    messageAdapterScan.value.durationMs = Number(data.scan?.durationMs || 0);
    messageAdapterScan.value.checkedAt = new Date().toISOString();
    if (data.repair?.changed) {
      await store.load();
    }
    await applyNapcatScanHealth(data.napcatHealth);
    if (data.repair?.messages?.length) {
      napcatAutoSteps.value = {
        ...napcatAutoSteps.value,
        backendScan: {
          ok: true,
          message: data.repair.changed ? "后端检查完成，已修复基础配置。" : "只读扫描完成，未启动、登录或修复任何消息端。",
          steps: data.repair.messages
        }
      };
    }
  } catch (error) {
    messageAdapterScan.value.adapters = {};
    messageAdapterScan.value.overall = null;
    messageAdapterScan.value.partial = false;
    messageAdapterScan.value.durationMs = 0;
    messageAdapterScan.value.checkedAt = "";
    messageAdapterScan.value.error = userFacingError(error);
  }
  finally { messageAdapterScan.value.loading = false; }
}

const gateway = computed(() => store.selectedGateway);

const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);

const messageAdapterInactive = computed(() => Boolean(gateway.value?.enabled === false || runtime.value.enabled === false || messageInputsDisabled.value));

const napcatState = computed(() => runtime.value.gatewayStatus?.napcat || {} as Record<string, any>);

const adapterErrors = (type: MessageAdapterType) => gateway.value ? adapterErrorsFor(type, gateway.value, runtime.value) : [];

const testingNapcatInstance = ref<Record<string, boolean>>({});

const launchingNapcatInstance = ref<Record<string, boolean>>({});

const restartingNapcatInstance = ref<Record<string, boolean>>({});

const managingNapcatLogin = ref<Record<string, boolean>>({});

const napcatLoginPanels = ref<Record<string, NapcatLoginUiState>>({});

let napcatPanelPollTimer = 0;

let napcatPanelDisposed = false;

onBeforeUnmount(() => {
  napcatPanelDisposed = true;
  window.clearTimeout(napcatPanelPollTimer);
});

const napcatNewDevicePollTimers = new Map<string, number>();

const adoptingNapcatOwner = ref<Record<string, boolean>>({});

const fixingNapcatPorts = ref(false);

const napcatPortFixResult = ref<Record<string, { ok: boolean; message: string }>>({});

const configuringNapcatOneBot = ref<Record<string, boolean>>({});

const napcatOneBotFixResult = ref<Record<string, { ok: boolean; message: string }>>({});

const napcatHealthResult = ref<NapcatHealthSnapshot | null>(null);

const napcatInstanceHealthResult = ref<Record<string, typeof napcatHealthResult.value>>({});

const napcatScanHealthByWebui = ref<Record<string, NapCatScanHealthEntry[]>>({});

const napcatLaunchResult = ref<Record<string, { ok: boolean; message: string }>>({});

const autoCheckingNapcat = ref(false);

const lastAutoNapcatHealthKey = ref("");

const napcatHealthPausedAfterFix = ref<Record<string, boolean>>({});

function napcatTextConfirmationThreshold(): number {
  return gateway.value ? messageAdapterPolicyFor(gateway.value, "napcat").textConfirmationThreshold : 0;
}

function setNapcatTextConfirmationThreshold(value: unknown): void {
  const threshold = Number(value);
  if (!gateway.value || !Number.isInteger(threshold) || threshold < 0 || threshold > 200_000) return;
  setMessageAdapterPolicy(gateway.value, "napcat", { textConfirmationThreshold: threshold });
  store.touch();
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
  return gateway.value?.napcatInstances ?? [];
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
    Number(store.meta.managerPort || 0),
    ...ensureNapcatInstances().map((item) => Number(item.gatewayPort)),
    ...store.gateways.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
      Number(item.xiaoaiWebhookPort),
      Number(item.rabiLinkWebhookPort),
      ...(Array.isArray(item.napcatInstances) ? item.napcatInstances.map(instance => Number(instance.gatewayPort)) : [])
    ]),
    ...store.managerRows.flatMap((item) => [
      Number(item.gatewayPort),
      Number(item.webhookPort),
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
  const usedWebui = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWs.add(port);
  };

  claim(store.meta.managerPort || 0);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("xiaoai")) claim(item.xiaoaiWebhookPort ?? item.webhookPort ?? item.gatewayPort);
    if (activeAdapters.includes("rabilink")) claim(item.rabiLinkWebhookPort ?? item.webhookPort ?? item.gatewayPort);
  }

  let changed = false;
  const claimWebui = (url: string | undefined): void => {
    const port = portFromLocalUrl(url);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) usedWebui.add(port);
  };
  for (const item of store.gateways) {
    if (!gatewayAdapterTypes(item).includes("napcat")) continue;
    const configuredInstances = Array.isArray(item.napcatInstances) && item.napcatInstances.length > 0
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
    const instances = [configuredInstances.find(instance => instance.enabled !== false) ?? configuredInstances[0]];
    instances[0].enabled = true;
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

      if (!portFromLocalUrl(instance.httpUrl)) {
        const configuredHttpUrl = item.napcatHttpUrl;
        instance.httpUrl = configuredHttpUrl && portFromLocalUrl(configuredHttpUrl)
          ? configuredHttpUrl
          : "http://127.0.0.1:3000";
        changed = true;
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
    managingNapcatLogin,
    napcatLoginPanels,
    configuringNapcatOneBot
  ]) {
    const next = { ...state.value };
    delete next[id];
    state.value = next;
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
      [instance.id]: { ok: false, message: userFacingError(e) }
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

function napcatInstanceWsUrl(instance: NapCatInstance): string {
  return `ws://127.0.0.1:${instance.gatewayPort || 8790}`;
}

function messageScanFor(type: MessageAdapterType): MessageAdapterScanResult | undefined {
  const scan = messageAdapterScan.value.adapters[type];
  if (type !== "napcat") return scan;
  const instance = gateway.value?.napcatInstances?.[0];
  const panel = instance && napcatLoginPanels.value[instance.id]?.panel;
  if (!panel) return scan;
  return {
    ...scan, type, label: "NapCat / OneBot", maturity: scan?.maturity ?? "experimental", installed: true,
    health: {
      state: panel.health?.ok === true ? "healthy" : panel.loggedIn ? "degraded" : panel.offline ? "offline" : panel.managementAvailable ? "needs_login" : "unknown",
      message: panel.message || "正在读取当前 QQ 状态。"
    },
    requirements: [
      { id: "qq-login", label: "当前 QQ 登录", required: true, ok: panel.loggedIn === true && panel.state !== NapcatState.AccountMismatch, detail: panel.message },
      { id: "onebot-http", label: "当前实例 OneBot HTTP", required: true, ok: panel.health?.ok === true, detail: instance.httpUrl },
      { id: "webui", label: "当前实例管理服务", required: false, ok: panel.managementAvailable === true, detail: instance.webuiUrl }
    ],
    warnings: panel.warnings || []
  };
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
  const leftWebui = String(left.webuiUrl || left.napcatWebuiUrl || "").trim();
  const rightWebui = String(right.webuiUrl || right.napcatWebuiUrl || "").trim();
  if (leftWebui && rightWebui) return leftWebui === rightWebui;

  const leftHttp = String(left.httpUrl || left.napcatHttpUrl || "").trim();
  const rightHttp = String(right.httpUrl || right.napcatHttpUrl || "").trim();
  if (leftHttp && rightHttp) return leftHttp === rightHttp;

  const leftPort = Number(left.gatewayPort || left.port || left.wsPort || 0);
  const rightPort = Number(right.gatewayPort || right.port || right.wsPort || 0);
  if (leftPort > 0 && rightPort > 0 && leftPort === rightPort) return true;

  const leftId = napcatInstanceSourceId(left);
  const rightId = napcatInstanceSourceId(right);
  if (!leftId || !rightId || leftId !== rightId) return false;

  return napcatInstanceScope(left) === napcatInstanceScope(right);
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

function napcatEndpointLabelFromInstance(instance: Partial<NapCatInstance> & Record<string, any>, fallback = "NapCat WebUI"): string {
  const base = String(instance.name || instance.id || "").trim();
  if (!base) return fallback;
  return /\bWebUI\b/i.test(base) ? base : `${base} WebUI`;
}

function napcatAccountRowKey(instance: NapCatInstance, source: NapCatAccountRow["source"], endpointLabel: string): string {
  const identity = String(instance.webuiUrl || instance.httpUrl || instance.gatewayPort || instance.id || endpointLabel || "unknown");
  return `${source}:${identity}`;
}

function napcatAccountRows(): NapCatAccountRow[] {
  const configured = ensureNapcatInstances();
  const rows: NapCatAccountRow[] = configured
    .filter(instance => !isIgnoredNapcatInstance(instance))
    .map(instance => {
      const label = napcatEndpointLabelFromInstance(instance);
      return {
        key: napcatAccountRowKey(instance, "configured", label),
        instance,
        endpointLabel: label,
        source: "configured"
      };
    });
  return rows;
}

function napcatAccountInstances(): NapCatInstance[] {
  return ensureNapcatInstances().slice(0, 1);
}

function napcatAccountRowFor(instance: NapCatInstance): NapCatAccountRow | undefined {
  return napcatAccountRows().find(row => row.instance === instance || sameNapcatInstance(row.instance as NapCatInstance & Record<string, any>, instance as NapCatInstance & Record<string, any>));
}

function napcatDisplayEndpointLabel(instance: NapCatInstance): string {
  return napcatAccountRowFor(instance)?.endpointLabel || napcatEndpointLabelFromInstance(instance);
}

function napcatDisplayInstanceName(instance: NapCatInstance): string {
  const configuredName = String(instance.name || instance.id || "").trim();
  if (configuredName) return configuredName;
  return napcatDisplayEndpointLabel(instance)
    .replace(/\s*NapCat\s*WebUI$/i, " NapCat")
    .replace(/\s*WebUI$/i, "")
    .trim() || "QQ 实例";
}

function napcatDisplayEndpointHealthy(instance: NapCatInstance): boolean | undefined {
  return napcatAccountRowFor(instance)?.endpointHealthy;
}

function napcatWebuiStatusLabel(instance: NapCatInstance): string {
  const reachable = napcatHealthFor(instance).webui?.reachable;
  if (reachable === true) return "可用";
  if (reachable === false) return "未响应";
  const healthy = napcatDisplayEndpointHealthy(instance);
  if (healthy === true) return "可用";
  if (healthy === false) return "未响应";
  return "未扫描";
}

function napcatWebuiStatusClass(instance: NapCatInstance): string {
  const reachable = napcatHealthFor(instance).webui?.reachable;
  if (reachable === true) return "text-success";
  if (reachable === false) return "text-warning";
  const healthy = napcatDisplayEndpointHealthy(instance);
  if (healthy === true) return "text-success";
  if (healthy === false) return "text-warning";
  return "text-info";
}

function isDiscoveredNapcatAccount(instance: NapCatInstance): boolean {
  const row = napcatAccountRowFor(instance);
  return Boolean((instance as Record<string, any>).__discovered || (row && row.source !== "configured" && !isConfiguredNapcatInstance(instance)));
}

function addDiscoveredNapcatInstance(instance: NapCatInstance): void {
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
  clean.name = clean.name || "NapCat";
  clean.gatewayPort = Number(clean.gatewayPort || nextNapcatPort(Number(gateway.value?.gatewayPort || 8789) + 1));
  clean.httpUrl = clean.httpUrl || nextLocalHttpUrl(gateway.value?.napcatHttpUrl || "http://127.0.0.1:3000", 3000);
  clean.webuiUrl = clean.webuiUrl || defaultNapcatWebuiUrl();
  if (gateway.value) gateway.value.napcatInstances = [clean];
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function runNapcatInstanceHealth(instance: NapCatInstance, payloadPatch: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const resp = await fetch("/api/message/napcat-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...napcatHealthPayload(instance), ...payloadPatch })
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
  const userId = body.http?.userId || (body.loginInfo?.source !== "webui" ? body.loginInfo?.userId : "");
  const nickname = body.http?.nickname || (body.loginInfo?.source !== "webui" ? body.loginInfo?.nickname : "");
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
  const nextByWebui: Record<string, NapCatScanHealthEntry[]> = {};
  for (const [gatewayName, gatewayHealth] of Object.entries(byGateway)) {
    const instances = gatewayHealth?.instances;
    if (!instances || typeof instances !== "object") continue;
    for (const [instanceName, raw] of Object.entries(instances)) {
      const body = { ok: Boolean(raw?.ok), ...(raw || {}), gatewayName, instanceName } as NapCatScanHealthEntry;
      const webuiUrl = String(body.webui?.url || body.webui?.configuredUrl || "");
      if (!webuiUrl) continue;
      nextByWebui[webuiUrl] = [...(nextByWebui[webuiUrl] || []), body];
    }
  }
  napcatScanHealthByWebui.value = nextByWebui;
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

function napcatHealthShowsExpectedLogin(instance: NapCatInstance, body: Record<string, any> | undefined): boolean {
  if (!body) return false;
  const qqLoggedIn = Boolean(
    body.http?.ok
    || body.http?.online === true
    || (body.loginInfo?.source !== "webui" && body.loginInfo?.online === true)
    || (body.loginInfo?.source === "webui" && body.loginInfo?.online === true)
    || body.webui?.loginInfo?.online === true
  );
  if (!qqLoggedIn) return false;
  const expected = napcatExpectedUserId(instance);
  const actual = napcatHealthUserId(body);
  return !expected || !actual || expected === actual;
}

function scheduleNapcatLoginRecheck(instance: NapCatInstance): void {
  for (const delay of [8000, 20000, 45000]) {
    window.setTimeout(async () => {
      const target = resolveConfiguredNapcatInstance(instance);
      try {
        const health = await runNapcatInstanceHealth(target);
        napcatInstanceHealthResult.value = {
          ...napcatInstanceHealthResult.value,
          [target.id]: health
        };
        if (napcatHealthShowsExpectedLogin(target, health)) {
          napcatLaunchResult.value = {
            ...napcatLaunchResult.value,
            [target.id]: {
              ok: true,
              message: "QQ 已登录，NapCat 已进入可用状态。"
            }
          };
        }
      } catch {
        // The visible health panel already keeps the latest explicit check result.
      }
    }, delay);
  }
}

function napcatLoginUi(instance: NapCatInstance): NapcatLoginUiState {
  const existing = napcatLoginPanels.value[instance.id];
  if (existing) return existing;
  const created: NapcatLoginUiState = {
    visible: false,
    loading: false,
    busy: false,
    mode: "quick",
    quickUserId: String(instance.botUserId || ""),
    userId: String(instance.botUserId || ""),
    password: "",
    message: "",
    error: "",
    panel: null,
    captcha: null,
    newDevice: null
  };
  napcatLoginPanels.value = { ...napcatLoginPanels.value, [instance.id]: created };
  return created;
}

function napcatQuickLoginOptions(instance: NapCatInstance): Array<{ title: string; value: string }> {
  return (napcatLoginUi(instance).panel?.quickAccounts ?? []).map(account => ({
    title: account.nickname ? `${account.nickname}（${account.userId}）` : `QQ ${account.userId}`,
    value: account.userId
  }));
}

async function loadNapcatLoginPanel(instance: NapCatInstance): Promise<void> {
  const target = resolveConfiguredNapcatInstance(instance);
  const ui = napcatLoginUi(target);
  const gatewayId = gateway.value?.id;
  if (ui.loading || napcatPanelDisposed) return;
  ui.loading = true;
  ui.error = "";
  try {
    const response = await fetch("/api/message/napcat-login-panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId, instanceId: target.id })
    });
    const body = await response.json().catch(() => ({})) as NapcatLoginPanelData;
    if (!response.ok || body.ok === false) throw new Error(body.message || "NapCat 登录控制加载失败。");
    if (gateway.value?.id !== gatewayId || napcatPanelDisposed) return;
    ui.panel = body;
    if (body.health) napcatInstanceHealthResult.value = { ...napcatInstanceHealthResult.value, [target.id]: body.health };
    ui.message = body.message || "";
    const expected = String(body.expectedUserId || target.botUserId || "");
    const firstQuick = body.quickAccounts?.find(account => account.userId === expected)
      ?? body.quickAccounts?.find(account => account.quickLoginAvailable)
      ?? body.quickAccounts?.[0];
    if (!ui.quickUserId) ui.quickUserId = firstQuick?.userId || expected;
    if (!ui.userId) ui.userId = expected || firstQuick?.userId || "";
    if (!body.loggedIn && ui.mode === "quick" && !body.quickAccounts?.length) ui.mode = "qrcode";
    if (body.loggedIn) {
      ui.password = "";
      ui.captcha = null;
      cancelNapcatNewDevice(target);
      napcatLaunchResult.value = { ...napcatLaunchResult.value, [target.id]: { ok: body.state !== NapcatState.AccountMismatch, message: body.message || "QQ 已登录。" } };
    }
  } catch (error) {
    if (gateway.value?.id !== gatewayId || napcatPanelDisposed) return;
    ui.panel = null;
    ui.error = userFacingError(error);
  } finally {
    ui.loading = false;
    if (!napcatPanelDisposed && gateway.value?.id === gatewayId && ui.visible) {
      window.clearTimeout(napcatPanelPollTimer);
      napcatPanelPollTimer = window.setTimeout(() => { void loadNapcatLoginPanel(target); }, 3000);
    }
  }
}

async function postNapcatLoginAction(instance: NapCatInstance, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch("/api/message/napcat-login-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gatewayId: gateway.value?.id, instanceId: instance.id, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.message || "NapCat 登录请求失败。");
  return body;
}

function scheduleNapcatPanelRefresh(instance: NapCatInstance): void {
  for (const delay of [1500, 5000, 10000]) {
    window.setTimeout(() => {
      const ui = napcatLoginUi(instance);
      if (!ui.visible) return;
      void loadNapcatLoginPanel(resolveConfiguredNapcatInstance(instance));
    }, delay);
  }
  scheduleNapcatLoginRecheck(instance);
}

async function submitNapcatQuickLogin(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.quickUserId) {
    ui.error = "当前没有可用的快速登录账号。";
    return;
  }
  ui.busy = true;
  ui.error = "";
  try {
    const result = await postNapcatLoginAction(instance, { action: "quick-login", userId: ui.quickUserId });
    ui.message = result.message || "已提交快速登录请求。";
    scheduleNapcatPanelRefresh(instance);
  } catch (error) {
    ui.error = userFacingError(error);
  } finally {
    ui.busy = false;
  }
}

async function refreshNapcatLoginQr(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  ui.busy = true;
  ui.error = "";
  try {
    if (ui.panel?.managementAvailable === false || !ui.panel) {
      await startNapcatAndManage(instance);
      if (ui.panel?.managementAvailable !== true) throw new Error(ui.panel?.message || "NapCat 尚未启动，请检查启动结果。");
    }
    const result = await postNapcatLoginAction(instance, { action: "refresh-qr" });
    ui.message = result.message || "已刷新二维码。";
    await sleep(350);
    await loadNapcatLoginPanel(instance);
  } catch (error) {
    ui.error = userFacingError(error);
  } finally {
    ui.busy = false;
  }
}

async function handleNapcatPasswordChallenge(instance: NapCatInstance, result: Record<string, any>): Promise<void> {
  const ui = napcatLoginUi(instance);
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, any> : {};
  if (data.needCaptcha && data.proofWaterUrl) {
    ui.captcha = { proofWaterUrl: String(data.proofWaterUrl) };
    ui.message = "QQ 要求完成安全验证码。";
    return;
  }
  if (data.needNewDevice && data.jumpUrl) {
    ui.newDevice = {
      jumpUrl: String(data.jumpUrl),
      newDevicePullQrCodeSig: String(data.newDevicePullQrCodeSig || ""),
      qrCodeDataUrl: "",
      bytesToken: "",
      status: "loading"
    };
    ui.message = "QQ 检测到新设备，请扫码确认。";
    await prepareNapcatNewDeviceQr(instance);
    return;
  }
  ui.message = result.message || "已提交密码登录请求。";
  scheduleNapcatPanelRefresh(instance);
}

async function submitNapcatPasswordLogin(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.userId || !ui.password) {
    ui.error = "请填写 QQ 号和密码。";
    return;
  }
  ui.busy = true;
  ui.error = "";
  ui.captcha = null;
  cancelNapcatNewDevice(instance);
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "password-login",
      userId: ui.userId,
      password: ui.password
    });
    await handleNapcatPasswordChallenge(instance, result);
  } catch (error) {
    ui.error = userFacingError(error);
  } finally {
    ui.busy = false;
  }
}

async function loadTencentCaptchaScript(): Promise<void> {
  const captchaWindow = window as Window & { TencentCaptcha?: unknown };
  if (captchaWindow.TencentCaptcha) return;
  const existing = document.querySelector<HTMLScriptElement>('script[data-rabi-napcat-captcha="true"]');
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("QQ 验证码脚本加载失败。")), { once: true });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://captcha.gtimg.com/TCaptcha.js";
    script.dataset.rabiNapcatCaptcha = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("QQ 验证码脚本加载失败。"));
    document.head.appendChild(script);
  });
}

async function startNapcatCaptcha(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  const proofWaterUrl = ui.captcha?.proofWaterUrl;
  if (!proofWaterUrl) return;
  ui.busy = true;
  ui.error = "";
  try {
    await loadTencentCaptchaScript();
    const parsed = new URL(proofWaterUrl);
    const appId = parsed.searchParams.get("aid") || "2081081773";
    const sid = parsed.searchParams.get("sid") || "";
    const Captcha = (window as Window & {
      TencentCaptcha?: new (
        appId: string,
        callback: (result: { ret?: number; ticket?: string; randstr?: string }) => void,
        options?: Record<string, unknown>
      ) => { show(): void; destroy?(): void };
    }).TencentCaptcha;
    if (!Captcha) throw new Error("QQ 验证码组件没有正确加载。");
    let captcha: { show(): void; destroy?(): void } | null = null;
    captcha = new Captcha(appId, (result) => {
      captcha?.destroy?.();
      if (result.ret !== 0 || !result.ticket || !result.randstr) {
        ui.busy = false;
        ui.error = "验证码未完成，请重试。";
        return;
      }
      void submitNapcatCaptcha(instance, result.ticket, result.randstr, sid);
    }, {
      type: "popup",
      showHeader: false,
      login_appid: parsed.searchParams.get("login_appid") || undefined,
      uin: parsed.searchParams.get("uin") || ui.userId,
      sid,
      enableAged: true
    });
    captcha.show();
  } catch (error) {
    ui.busy = false;
    ui.error = userFacingError(error);
  }
}

async function submitNapcatCaptcha(instance: NapCatInstance, ticket: string, randstr: string, sid: string): Promise<void> {
  const ui = napcatLoginUi(instance);
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "captcha-login",
      userId: ui.userId,
      password: ui.password,
      ticket,
      randstr,
      sid
    });
    ui.captcha = null;
    await handleNapcatPasswordChallenge(instance, result);
  } catch (error) {
    ui.error = userFacingError(error);
  } finally {
    ui.busy = false;
  }
}

function cancelNapcatNewDevice(instance: NapCatInstance): void {
  const timer = napcatNewDevicePollTimers.get(instance.id);
  if (timer) window.clearTimeout(timer);
  napcatNewDevicePollTimers.delete(instance.id);
  const ui = napcatLoginPanels.value[instance.id];
  if (ui) ui.newDevice = null;
}

async function prepareNapcatNewDeviceQr(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  if (!ui.newDevice) return;
  ui.newDevice.status = "loading";
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "new-device-qr",
      userId: ui.userId,
      jumpUrl: ui.newDevice.jumpUrl
    });
    if (!ui.newDevice) return;
    ui.newDevice.qrCodeDataUrl = String(result.data?.qrCodeDataUrl || "");
    ui.newDevice.bytesToken = String(result.data?.bytes_token || "");
    if (!ui.newDevice.qrCodeDataUrl || !ui.newDevice.bytesToken) throw new Error("新设备二维码内容不完整，请重试。");
    ui.newDevice.status = "waiting";
    scheduleNapcatNewDevicePoll(instance);
  } catch (error) {
    if (ui.newDevice) ui.newDevice.status = "error";
    ui.error = userFacingError(error);
  }
}

function scheduleNapcatNewDevicePoll(instance: NapCatInstance): void {
  const current = napcatNewDevicePollTimers.get(instance.id);
  if (current) window.clearTimeout(current);
  const timer = window.setTimeout(() => void pollNapcatNewDevice(instance), 2500);
  napcatNewDevicePollTimers.set(instance.id, timer);
}

async function pollNapcatNewDevice(instance: NapCatInstance): Promise<void> {
  const ui = napcatLoginUi(instance);
  const challenge = ui.newDevice;
  if (!challenge?.bytesToken) return;
  try {
    const result = await postNapcatLoginAction(instance, {
      action: "new-device-poll",
      userId: ui.userId,
      bytesToken: challenge.bytesToken
    });
    const status = Number(result.data?.uint32_guarantee_status ?? -1);
    if (status === 3) challenge.status = "scanned";
    if (status === 1) {
      challenge.status = "confirmed";
      const token = String(result.data?.str_nt_succ_token || challenge.newDevicePullQrCodeSig || "");
      const login = await postNapcatLoginAction(instance, {
        action: "new-device-login",
        userId: ui.userId,
        password: ui.password,
        newDevicePullQrCodeSig: token
      });
      cancelNapcatNewDevice(instance);
      await handleNapcatPasswordChallenge(instance, login);
      return;
    }
    scheduleNapcatNewDevicePoll(instance);
  } catch (error) {
    if (ui.newDevice) ui.newDevice.status = "error";
    ui.error = userFacingError(error);
  }
}

async function startNapcatAndManage(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  let target = resolveConfiguredNapcatInstance(instance);
  managingNapcatLogin.value = { ...managingNapcatLogin.value, [instance.id]: true };
  napcatLaunchResult.value = {
    ...napcatLaunchResult.value,
    [instance.id]: { ok: true, message: "正在准备 QQ，请稍候..." }
  };
  try {
    await autofillNapcatInstance(target);
    autoAssignNapcatPortsForAllGateways();
    if (store.dirty) {
      await store.save();
      target = resolveConfiguredNapcatInstance(target);
    }
    const response = await fetch("/api/message/napcat-ensure-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: gateway.value.id, instanceId: target.id })
    });
    const body = await response.json().catch(() => ({}));
    if (body.health) {
      napcatInstanceHealthResult.value = {
        ...napcatInstanceHealthResult.value,
        [target.id]: { ok: Boolean(body.health.ok), ...body.health }
      };
      if (applyNapcatHealthToInstance(target, body.health) && store.dirty) {
        await store.save();
        target = resolveConfiguredNapcatInstance(target);
      }
    }
    if (body.needsUserAction === true) scheduleNapcatLoginRecheck(target);
    const loginUi = napcatLoginUi(target);
    loginUi.visible = true;
    await loadNapcatLoginPanel(target);
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [target.id]: {
        ok: response.ok && body.ok !== false,
        message: body.message || (response.ok ? "NapCat 已启动，登录控制已加载。" : "NapCat 暂时无法启动，请再试一次。")
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: userFacingError(e) }
    };
  } finally {
    managingNapcatLogin.value = { ...managingNapcatLogin.value, [instance.id]: false };
  }
}

function napcatLoginState(instance: NapCatInstance): string {
  return String(napcatLoginPanels.value[instance.id]?.panel?.state || napcatHealthFor(instance).state || napcatHealthFor(instance).loginState || "");
}

function napcatAccountOwner(instance: NapCatInstance): Record<string, any> | null {
  const owner = napcatHealthFor(instance).accountOwner;
  return owner && typeof owner === "object" ? owner : null;
}

function napcatAccountOwnerLabel(instance: NapCatInstance): string {
  const owner = napcatAccountOwner(instance);
  if (!owner) return "";
  const account = owner.nickname
    ? `QQ ${owner.userId || napcatExpectedUserId(instance)} / ${owner.nickname}`
    : `QQ ${owner.userId || napcatExpectedUserId(instance)}`;
  return `${account} 正在 ${owner.instanceName || owner.workingDir || owner.httpUrl || "另一 NapCat 实例"} 在线`;
}

async function adoptNapcatAccountOwner(instance: NapCatInstance): Promise<void> {
  if (!gateway.value) return;
  const owner = napcatAccountOwner(instance);
  if (!owner?.httpUrl) return;
  const expected = napcatExpectedUserId(instance);
  const actual = String(owner.userId || "");
  if (expected && actual && expected !== actual) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: `在线实例属于 QQ ${actual}，与当前绑定 QQ ${expected} 不一致，未采用。` }
    };
    return;
  }
  adoptingNapcatOwner.value = { ...adoptingNapcatOwner.value, [instance.id]: true };
  try {
    const target = resolveConfiguredNapcatInstance(instance);
    target.httpUrl = String(owner.httpUrl);
    if (owner.webuiUrl) target.webuiUrl = String(owner.webuiUrl);
    if (owner.workingDir) target.workingDir = String(owner.workingDir);
    syncPrimaryNapcatFromInstances();
    store.touch();
    await store.save();
    const health = await runNapcatInstanceHealth(target);
    napcatInstanceHealthResult.value = {
      ...napcatInstanceHealthResult.value,
      [target.id]: health
    };
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [target.id]: {
        ok: Boolean(health.ok),
        message: health.ok
          ? "已采用现有在线 NapCat，会话未被中断。"
          : owner.routesToGateway
            ? "已采用在线实例，但健康检查尚未通过，请稍后再检查。"
            : "已采用在线实例；它尚未连接当前 RabiRoute，请在详情中修复 OneBot 路由。"
      }
    };
  } catch (e: unknown) {
    napcatLaunchResult.value = {
      ...napcatLaunchResult.value,
      [instance.id]: { ok: false, message: userFacingError(e) }
    };
  } finally {
    adoptingNapcatOwner.value = { ...adoptingNapcatOwner.value, [instance.id]: false };
  }
}

function napcatExpectedUserId(instance: NapCatInstance): string {
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || "");
}

function napcatWebuiSessionUserId(instance: NapCatInstance): string {
  const health = napcatHealthFor(instance);
  return String(health.webui?.loginInfo?.userId || (health.loginInfo?.source === "webui" ? health.loginInfo?.userId : "") || "");
}

function napcatWebuiSessionLabel(instance: NapCatInstance): string {
  const health = napcatHealthFor(instance);
  const userId = napcatWebuiSessionUserId(instance);
  const nickname = String(health.webui?.loginInfo?.nickname || (health.loginInfo?.source === "webui" ? health.loginInfo?.nickname : "") || "");
  if (userId && nickname) return `QQ ${userId} / ${nickname}`;
  if (userId) return `QQ ${userId}`;
  return "";
}

function napcatWebuiSessionMismatch(instance: NapCatInstance): boolean {
  const expected = napcatExpectedUserId(instance);
  const webuiUser = napcatWebuiSessionUserId(instance);
  return Boolean(expected && webuiUser && expected !== webuiUser);
}

function collectUsedWsPorts(excludeInstance?: NapCatInstance): Set<number> {
  const used = new Set<number>();
  const claim = (value: unknown): void => {
    const port = Number(value || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) used.add(port);
  };
  claim(store.meta.managerPort || 0);
  for (const item of store.gateways) {
    const activeAdapters = gatewayAdapterTypes(item);
    if (activeAdapters.includes("webhook")) claim(item.webhookPort ?? item.gatewayPort);
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
    const message = userFacingError(e);
    store.error = message;
    napcatPortFixResult.value = {
      ...napcatPortFixResult.value,
      [resultKey]: { ok: false, message }
    };
  } finally {
    fixingNapcatPorts.value = false;
  }
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
  const panelHealth = napcatLoginPanels.value[instance.id]?.panel?.health;
  if (panelHealth) return panelHealth;
  const byId = napcatInstanceHealthResult.value[instance.id];
  if (byId) return byId;
  const candidates = napcatScanHealthByWebui.value[String(instance.webuiUrl || "")] || [];
  if (candidates.length === 0) return {};
  const port = Number(instance.gatewayPort || 0);
  return candidates.find(item => item.gatewayName === gateway.value?.id && item.instanceName === instance.id && Number(item.gatewayPort || 0) === port)
    || {};
}

function napcatAccountUserId(instance: NapCatInstance): string {
  const panel = napcatLoginPanels.value[instance.id]?.panel;
  if (panel) return String(panel.currentAccount?.userId || panel.expectedUserId || "");
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botUserId || runtimeInfo.botUserId || runtimeInfo.userId || runtimeInfo.selfId || health.http?.userId || (health.loginInfo?.source !== "webui" ? health.loginInfo?.userId : "") || "");
}

function napcatAccountNickname(instance: NapCatInstance): string {
  const panel = napcatLoginPanels.value[instance.id]?.panel;
  if (panel) return String(panel.currentAccount?.nickname || (!panel.currentAccount ? instance.botNickname : "") || "");
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return String(instance.botNickname || runtimeInfo.botNickname || runtimeInfo.nickname || health.http?.nickname || (health.loginInfo?.source !== "webui" ? health.loginInfo?.nickname : "") || "");
}

function napcatMeaningfulNickname(instance: NapCatInstance): string {
  const nickname = napcatAccountNickname(instance).trim();
  if (!nickname || /^QQ小助手$/i.test(nickname)) return "";
  return nickname;
}

function napcatAccountTitle(instance: NapCatInstance): string {
  if (managingNapcatLogin.value[instance.id]) return "正在准备登录控制";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动 NapCat";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询 QQ 状态";
  return napcatDisplayInstanceName(instance);
}

function napcatAccountSubtitle(instance: NapCatInstance): string {
  if (managingNapcatLogin.value[instance.id]) return "正在启动 NapCat 并加载登录状态...";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动 NapCat 后台...";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "加载 NapCat 登录资料...";
  const userId = napcatAccountUserId(instance);
  const nickname = napcatMeaningfulNickname(instance);
  if (userId && nickname) return `QQ ${userId} / ${nickname}`;
  if (userId) return `QQ ${userId}`;
  return "等待 QQ 登录";
}

function napcatAccountLogTitle(instance: NapCatInstance): string {
  const userId = napcatAccountUserId(instance);
  const nickname = napcatMeaningfulNickname(instance);
  if (userId && nickname) return `${userId} / ${nickname}`;
  return userId || nickname || napcatDisplayInstanceName(instance);
}

function napcatAccountConnected(instance: NapCatInstance): boolean {
  const panel = napcatLoginPanels.value[instance.id]?.panel;
  if (panel) return panel.loggedIn === true && panel.state !== NapcatState.AccountMismatch;
  const checked = napcatInstanceHealthResult.value[instance.id];
  if (checked) return checked.ok === true;
  if (napcatAccountOffline(instance)) return false;
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  if (typeof instance.connected === "boolean") return instance.connected;
  if (typeof runtimeInfo.connected === "boolean") return runtimeInfo.connected;
  if (health.http?.ok) return true;
  if (health.loginInfo?.source !== "webui" && health.loginInfo?.online === true) return true;
  return false;
}

function napcatAccountOffline(instance: NapCatInstance): boolean {
  const panel = napcatLoginPanels.value[instance.id]?.panel;
  if (panel) return panel.offline === true || panel.currentAccount?.online === false;
  const checked = napcatInstanceHealthResult.value[instance.id];
  if (checked) return checked.state === "offline";
  const runtimeInfo = napcatRuntimeFor(instance);
  const health = napcatHealthFor(instance);
  return runtimeInfo.online === false
    || runtimeInfo.good === false
    || health.http?.online === false
    || health.http?.good === false
    || (health.loginInfo?.source !== "webui" && health.loginInfo?.online === false)
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
  const health = napcatHealthFor(instance);
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "正在查询";
  if (napcatLoginState(instance) === NapcatState.AccountOnlineElsewhere) return "QQ 在其他实例在线";
  if (napcatLoginState(instance) === NapcatState.QuickLoginInvalid) return "快速登录已过期，需扫码";
  if (napcatLoginState(instance) === NapcatState.QrLoginRequired) return "无快速登录身份，需扫码";
  if (napcatLoginState(instance) === NapcatState.LoginConflict) return "QQ 登录冲突";
  if (napcatLoginState(instance) === NapcatState.AccountMismatch) return "账号不匹配";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  const panel = napcatLoginPanels.value[instance.id]?.panel;
  if (panel) return panel.health?.ok === true ? "已登录" : panel.loggedIn ? "QQ 已登录，OneBot 待连接" : "等待 QQ 登录";
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return String(runtimeInfo.loginInfoError || instance.loginInfoError);
  if (napcatAccountConnected(instance) || health.http?.ok) return "已登录";
  if (userId) return "已绑定 QQ";
  if (napcatHealthFor(instance).webui?.loginInfo?.userId) return "WebUI 有其他账号会话";
  return "等待 QQ 登录";
}

function napcatAccountLoginClass(instance: NapCatInstance): string {
  if (napcatLoginState(instance) === NapcatState.AccountOnlineElsewhere) return "text-warning";
  if ([NapcatState.QuickLoginInvalid, NapcatState.QrLoginRequired, NapcatState.LoginConflict, NapcatState.AccountMismatch].some(state => state === napcatLoginState(instance))) return "text-error";
  if (napcatAccountOffline(instance)) return "text-error";
  if (napcatAccountConnected(instance) || napcatHealthFor(instance).http?.ok) return "text-success";
  if (napcatAccountUserId(instance) || napcatWebuiSessionUserId(instance)) return "text-info";
  return "text-warning";
}

function isValidPort(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function napcatInstancePortError(instance: NapCatInstance): string {
  return isValidPort(instance.gatewayPort) ? "" : "端口必须是 1-65535 的整数";
}

function napcatInstanceStatusLabel(instance: NapCatInstance): string {
  if (isDiscoveredNapcatAccount(instance)) return "已发现";
  if (managingNapcatLogin.value[instance.id]) return "正在准备";
  if (launchingNapcatInstance.value[instance.id]) return "正在启动";
  if (restartingNapcatInstance.value[instance.id]) return "正在重启";
  if (instance.enabled === false) return "已停用";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "查询中";
  if (napcatLoginState(instance) === NapcatState.AccountOnlineElsewhere) return "账号在别处在线";
  if (napcatLoginState(instance) === NapcatState.QuickLoginInvalid) return "需要扫码";
  if (napcatLoginState(instance) === NapcatState.QrLoginRequired) return "需要扫码";
  if (napcatLoginState(instance) === NapcatState.LoginConflict) return "登录冲突";
  if (napcatLoginState(instance) === NapcatState.AccountMismatch) return "账号不匹配";
  if (napcatAccountOffline(instance)) return "QQ 已离线";
  if (napcatAccountConnected(instance)) return "QQ 已登录";
  if (napcatHealthFor(instance).http?.ok) return "OneBot 已登录";
  if (napcatAccountUserId(instance)) return "已绑定";
  if (napcatHealthFor(instance).webui?.loginInfo?.userId) return "WebUI 有会话";
  if (napcatAccountLoginLabel(instance) !== "等待 QQ 登录") return "登录异常";
  return "待检查";
}

function napcatInstanceStatusColor(instance: NapCatInstance): string {
  if (isDiscoveredNapcatAccount(instance)) return "info";
  if (managingNapcatLogin.value[instance.id] || launchingNapcatInstance.value[instance.id] || restartingNapcatInstance.value[instance.id]) return "info";
  if (instance.enabled === false) return "secondary";
  if (store.loading || testingNapcatInstance.value[instance.id] || autoCheckingNapcat.value) return "info";
  if (napcatLoginState(instance) === NapcatState.AccountOnlineElsewhere) return "warning";
  if ([NapcatState.QuickLoginInvalid, NapcatState.QrLoginRequired, NapcatState.LoginConflict, NapcatState.AccountMismatch].some(state => state === napcatLoginState(instance))) return "error";
  if (napcatAccountOffline(instance)) return "error";
  if (napcatAccountConnected(instance)) return "success";
  if (napcatAccountUserId(instance)) return "secondary";
  const runtimeInfo = napcatRuntimeFor(instance);
  if (runtimeInfo.loginInfoError || instance.loginInfoError) return "error";
  return "warning";
}

function napcatConnectedCount(): number {
  return napcatAccountInstances().filter(instance => instance.enabled !== false && napcatAccountConnected(instance)).length;
}

function napcatSetupHint(): string {
  const instances = ensureNapcatInstances();
  if (instances.length === 0) return "请配置当前 Route 的 NapCat 连接。";
  const invalid = instances.find(instance => instance.enabled !== false && !isValidPort(instance.gatewayPort));
  if (invalid) return `${invalid.name || invalid.id} 的 WS 端口无效，保存前需要改成 1-65535。`;
  const enabled = instances.filter(instance => instance.enabled !== false);
  if (enabled.length === 0) return "当前 NapCat 连接未启用。";
  if (!enabled.some(instance => napcatAccountConnected(instance))) return "下一步：在当前卡片启动 NapCat、完成 QQ 登录，并修复 OneBot 连接。";
  return "NapCat 已连接；收到消息后会投递到当前 Route。";
}

function napcatEntryMatchesInstance(entry: Record<string, any>, instance: NapCatInstance, allowUnscoped: boolean): boolean {
  const instanceIds = [entry.instanceId, entry.napcatInstanceId, entry.adapterInstanceId, entry.raw?.instanceId].filter(Boolean).map(String);
  const userIds = [entry.botUserId, entry.selfId, entry.RobotQQId, entry.raw?.botUserId, entry.raw?.self_id, entry.event === "login_info" ? entry.data?.userId : undefined].filter(Boolean).map(String);
  const ports = [entry.gatewayPort, entry.port, entry.wsPort, entry.raw?.gatewayPort].filter(Boolean).map(Number);
  const hasScope = instanceIds.length > 0 || userIds.length > 0 || ports.length > 0;
  if (!hasScope) return allowUnscoped;
  const targetUserId = napcatAccountUserId(instance);
  if (userIds.length && targetUserId && userIds.some(id => id !== targetUserId)) return false;
  if (instanceIds.length && !instanceIds.includes(String(instance.id))) return false;
  if (ports.length && !ports.includes(Number(instance.gatewayPort || 0))) return false;
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

function napcatHealthPayload(instance?: NapCatInstance): Record<string, unknown> {
  if (instance) {
    return {
      gatewayId: gateway.value?.id,
      instanceId: instance.id,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl || defaultNapcatWebuiUrl(),
      accessToken: instance.accessToken,
      webuiToken: instance.webuiToken,
      gatewayPort: instance.gatewayPort,
      botUserId: instance.botUserId,
      botNickname: instance.botNickname
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

async function refreshVisibleNapcatHealth(): Promise<void> {
  if (!gateway.value || !gatewayAdapterTypes(gateway.value).includes("napcat")) return;
  if (store.dirty) return;
  if (repairingNapcatAll.value) return;
  const instances = ensureNapcatInstances().filter(instance => instance.enabled !== false && !napcatHealthPausedAfterFix.value[instance.id]);
  if (instances.length === 0) return;
  autoCheckingNapcat.value = true;
  try {
    await Promise.all(instances.map(async (instance) => {
      napcatLoginUi(instance).visible = true;
      await loadNapcatLoginPanel(instance);
    }));
  } finally {
    autoCheckingNapcat.value = false;
  }
}

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
onBeforeUnmount(() => { for (const timer of napcatNewDevicePollTimers.values()) window.clearTimeout(timer); napcatNewDevicePollTimers.clear(); });

watch(() => gateway.value?.id, () => { window.clearTimeout(napcatPanelPollTimer); napcatLoginPanels.value = {}; napcatInstanceHealthResult.value = {}; }, { immediate: true });

onMounted(() => { void runMessageAdapterScan(); });

const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="messageScanFor('napcat')" :loading="messageAdapterScan.loading" :error="messageAdapterScan.error" @refresh="runMessageAdapterScan" hide-endpoints />
<div class="dependency-panel mb-3">
                    <div class="section-title small-title">长消息确认</div>
                    <div class="section-note">超过字数时提醒 Agent 先精简；一条说不清就按意思分条说。需要保留单条长消息时，再次调用确认后发送。</div>
                    <v-text-field
                      type="number"
                      :min="0"
                      :max="200000"
                      :model-value="napcatTextConfirmationThreshold()"
                      label="确认阈值（字）"
                      hint="0 表示关闭。字数含数字、英文、标点和正文中的空格；引用与 @ 标记不计入。"
                      persistent-hint
                      class="mt-2"
                      @update:model-value="setNapcatTextConfirmationThreshold"
                    />
                  </div>
<div class="catalog-param-grid napcat-manager-panel">
                    <div class="full-span napcat-setup-strip">
                      <div class="napcat-setup-main">
                        <v-icon size="22">mdi-connection</v-icon>
                        <div>
                          <strong>NapCat 连接</strong>
                          <span>{{ napcatSetupHint() }}</span>
                        </div>
                      </div>
                      <div class="napcat-setup-stats">
                        <div><b>1</b><span>每个 Route</span></div>
                        <div><b>{{ napcatConnectedCount() }}</b><span>已连接</span></div>
                      </div>
                    </div>
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      当前 Route 只绑定一个 NapCat。需要连接另一个 QQ 时，请新建 Route，让账号的策略、日志和运行状态彼此隔离。
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
                          <div class="section-title small-title">当前绑定</div>
                          <div class="section-note">Rabi 直接管理这个 NapCat 的启动、登录、OneBot 配置和连接状态。</div>
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
                              <v-chip size="x-small" :color="napcatInstanceStatusColor(instance)" variant="tonal">
                                {{ napcatInstanceStatusLabel(instance) }}
                              </v-chip>
                            </div>
                          </div>
                          <div class="napcat-card-summary">
                            <div><span>WS</span><b :class="napcatInstancePortError(instance) ? 'text-error' : ''">{{ napcatInstanceWsUrl(instance) }}</b></div>
                            <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                            <div><span>管理接口</span><b :class="napcatWebuiStatusClass(instance)">{{ instance.webuiUrl || "-" }} · {{ napcatWebuiStatusLabel(instance) }}</b></div>
                            <div><span>OneBot</span><b :class="napcatAccountLoginClass(instance)">{{ napcatAccountLoginLabel(instance) }}</b></div>
                            <div v-if="napcatWebuiSessionLabel(instance)"><span>NapCat 会话</span><b :class="napcatWebuiSessionMismatch(instance) ? 'text-warning' : 'text-info'">{{ napcatWebuiSessionLabel(instance) }}</b></div>
                          </div>
                          <v-alert
                            v-if="napcatLoginState(instance) === NapcatState.AccountOnlineElsewhere && napcatAccountOwner(instance)"
                            type="warning"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            <div>{{ napcatAccountOwnerLabel(instance) }}。Rabi 已保留这份会话，没有启动重复实例。</div>
                            <div class="section-note mt-1">
                              {{ napcatAccountOwner(instance)?.routesToGateway ? "该实例已经指向当前 RabiRoute，可以直接采用。" : "采用后还需要在详情中修复 OneBot 路由。" }}
                            </div>
                            <div class="d-flex ga-2 flex-wrap mt-2">
                              <v-btn
                                size="small"
                                color="warning"
                                variant="tonal"
                                prepend-icon="mdi-connection"
                                :loading="adoptingNapcatOwner[instance.id]"
                                :disabled="adoptingNapcatOwner[instance.id]"
                                @click="adoptNapcatAccountOwner(instance)"
                              >
                                采用在线实例
                              </v-btn>
                            </div>
                          </v-alert>
                          <v-alert
                            v-if="[NapcatState.QuickLoginInvalid, NapcatState.QrLoginRequired].some(state => state === napcatLoginState(instance))"
                            type="error"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            {{ napcatLoginState(instance) === NapcatState.QrLoginRequired ? "这个 QQ 没有可用的快速登录身份，或当前二维码已经过期。" : "NapCat 保存的快速登录身份已经过期。" }}
                            请在下方登录控制中刷新二维码后扫码；扫码完成前 Rabi 不会误用其他 QQ，也不会反复重试旧身份。
                          </v-alert>
                          <div class="agent-action-bar mt-2">
                            <div class="agent-action-status">
                              <span class="section-note">一键启动并在当前卡片管理登录；只有 QQ 安全验证需要你确认</span>
                            </div>
                            <div class="d-flex ga-2 flex-wrap">
                              <v-btn
                                size="small"
                                variant="tonal"
                                color="primary"
                                prepend-icon="mdi-play-circle-outline"
                                :loading="managingNapcatLogin[instance.id]"
                                :disabled="managingNapcatLogin[instance.id]"
                                @click="startNapcatAndManage(instance)"
                              >
                                {{ managingNapcatLogin[instance.id] ? "正在准备..." : "启动并管理登录" }}
                              </v-btn>
                              <v-btn
                                v-if="isConfiguredNapcatInstance(instance) || isDiscoveredNapcatAccount(instance)"
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
                          <v-card
                            v-if="napcatLoginUi(instance).visible"
                            class="napcat-login-control mt-3"
                            variant="flat"
                          >
                            <div class="napcat-login-control-head">
                              <div>
                                <div class="section-title small-title">QQ 登录控制</div>
                                <div class="section-note">登录请求由 Rabi 转交本机 NapCat；WebUI 密钥和密码不会显示在这里的结果中。</div>
                              </div>
                              <v-btn
                                size="small"
                                variant="text"
                                prepend-icon="mdi-refresh"
                                :loading="napcatLoginUi(instance).loading"
                                @click="loadNapcatLoginPanel(instance)"
                              >
                                刷新状态
                              </v-btn>
                            </div>
                            <v-alert
                              v-if="napcatLoginUi(instance).panel?.loggedIn"
                              :type="napcatLoginUi(instance).panel?.state === NapcatState.AccountMismatch ? 'warning' : 'success'"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).panel?.message }}
                            </v-alert>
                            <v-alert
                              v-if="napcatLoginUi(instance).error"
                              type="error"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).error }}
                            </v-alert>
                            <v-alert
                              v-if="napcatLoginUi(instance).message && !napcatLoginUi(instance).panel?.loggedIn"
                              type="info"
                              variant="tonal"
                              density="compact"
                              class="mb-3"
                            >
                              {{ napcatLoginUi(instance).message }}
                            </v-alert>
                            <div v-if="napcatLoginUi(instance).panel?.currentAccount" class="mb-3">
                              当前账号：QQ {{ napcatLoginUi(instance).panel?.currentAccount?.userId }}
                              {{ napcatLoginUi(instance).panel?.currentAccount?.nickname || "" }}
                              <div v-if="napcatLoginUi(instance).panel?.state === NapcatState.AccountMismatch" class="text-warning">
                                此 Route 绑定：QQ {{ instance.botUserId }} {{ instance.botNickname || "" }}
                              </div>
                            </div>
                            <v-alert v-if="napcatLoginUi(instance).panel?.managementAvailable === false" type="warning" variant="tonal" density="compact" class="mb-3">
                              NapCat 管理服务未响应，登录操作暂不可用。请点击“启动并管理登录”查看启动结果。
                            </v-alert>
                            <v-tabs v-if="!napcatLoginUi(instance).panel?.loggedIn && napcatLoginUi(instance).panel?.managementAvailable" v-model="napcatLoginUi(instance).mode" density="compact" color="primary" grow>
                              <v-tab value="quick">快速登录</v-tab>
                              <v-tab value="password">密码登录</v-tab>
                              <v-tab value="qrcode">扫码登录</v-tab>
                            </v-tabs>
                            <v-window v-if="!napcatLoginUi(instance).panel?.loggedIn && napcatLoginUi(instance).panel?.managementAvailable" v-model="napcatLoginUi(instance).mode" class="napcat-login-window">
                              <v-window-item value="quick">
                                <div class="napcat-login-pane">
                                  <v-select
                                    v-if="napcatQuickLoginOptions(instance).length"
                                    v-model="napcatLoginUi(instance).quickUserId"
                                    :items="napcatQuickLoginOptions(instance)"
                                    label="已保存的 QQ 登录身份"
                                    hide-details="auto"
                                  />
                                  <v-alert v-else type="info" variant="tonal" density="compact">
                                    这个 NapCat 还没有可用的快速登录身份，请先扫码或使用密码登录一次。
                                  </v-alert>
                                  <v-btn
                                    color="primary"
                                    variant="tonal"
                                    prepend-icon="mdi-lightning-bolt-outline"
                                    :loading="napcatLoginUi(instance).busy"
                                    :disabled="!napcatLoginUi(instance).quickUserId"
                                    @click="submitNapcatQuickLogin(instance)"
                                  >
                                    快速登录
                                  </v-btn>
                                </div>
                              </v-window-item>
                              <v-window-item value="password">
                                <div class="napcat-login-pane">
                                  <template v-if="napcatLoginUi(instance).newDevice">
                                    <v-alert type="warning" variant="tonal" density="compact">
                                      检测到新设备登录。请使用手机 QQ 扫码，并在手机上确认。
                                    </v-alert>
                                    <img
                                      v-if="napcatLoginUi(instance).newDevice?.qrCodeDataUrl"
                                      class="napcat-login-qr"
                                      :src="napcatLoginUi(instance).newDevice?.qrCodeDataUrl"
                                      alt="QQ 新设备验证二维码"
                                    />
                                    <v-progress-circular v-else indeterminate color="primary" />
                                    <div class="section-note">
                                      {{ napcatLoginUi(instance).newDevice?.status === 'scanned' ? '已扫码，请在手机 QQ 上确认。' : napcatLoginUi(instance).newDevice?.status === 'confirmed' ? '验证完成，正在登录。' : napcatLoginUi(instance).newDevice?.status === 'error' ? '验证状态读取失败，请重新获取二维码。' : '等待扫码确认。' }}
                                    </div>
                                    <div class="d-flex ga-2 flex-wrap">
                                      <v-btn size="small" variant="tonal" @click="prepareNapcatNewDeviceQr(instance)">重新获取二维码</v-btn>
                                      <v-btn size="small" variant="text" color="error" @click="cancelNapcatNewDevice(instance)">取消验证</v-btn>
                                    </div>
                                  </template>
                                  <template v-if="napcatLoginUi(instance).captcha">
                                    <v-alert type="warning" variant="tonal" density="compact">
                                      QQ 要求完成安全验证码。验证码由腾讯页面处理，结果只用于本次登录。
                                    </v-alert>
                                    <v-btn
                                      color="warning"
                                      variant="tonal"
                                      prepend-icon="mdi-shield-check-outline"
                                      :loading="napcatLoginUi(instance).busy"
                                      @click="startNapcatCaptcha(instance)"
                                    >
                                      打开安全验证
                                    </v-btn>
                                    <v-btn size="small" variant="text" color="error" @click="napcatLoginUi(instance).captcha = null">取消验证</v-btn>
                                  </template>
                                  <template v-else>
                                    <v-text-field
                                      v-model="napcatLoginUi(instance).userId"
                                      label="QQ 号"
                                      inputmode="numeric"
                                      autocomplete="off"
                                      hide-details="auto"
                                    />
                                    <v-text-field
                                      v-model="napcatLoginUi(instance).password"
                                      label="QQ 密码"
                                      type="password"
                                      autocomplete="new-password"
                                      hint="仅用于本次本机登录请求，不保存到 Route 配置。"
                                      persistent-hint
                                    />
                                    <v-btn
                                      color="primary"
                                      variant="tonal"
                                      prepend-icon="mdi-login-variant"
                                      :loading="napcatLoginUi(instance).busy"
                                      @click="submitNapcatPasswordLogin(instance)"
                                    >
                                      密码登录
                                    </v-btn>
                                  </template>
                                </div>
                              </v-window-item>
                              <v-window-item value="qrcode">
                                <div class="napcat-login-pane napcat-login-qr-pane">
                                  <img
                                    v-if="napcatLoginUi(instance).panel?.qrCodeDataUrl"
                                    class="napcat-login-qr"
                                    :src="napcatLoginUi(instance).panel?.qrCodeDataUrl"
                                    alt="QQ 登录二维码"
                                  />
                                  <v-alert v-else type="info" variant="tonal" density="compact">
                                    暂时没有可用二维码，请刷新；如果 NapCat 尚未启动，先点上方“启动并管理登录”。
                                  </v-alert>
                                  <div class="section-note">请使用手机 QQ 或 TIM 扫描二维码。</div>
                                  <v-btn
                                    color="primary"
                                    variant="tonal"
                                    prepend-icon="mdi-qrcode-scan"
                                    :loading="napcatLoginUi(instance).busy || napcatLoginUi(instance).loading"
                                    @click="refreshNapcatLoginQr(instance)"
                                  >
                                    刷新二维码
                                  </v-btn>
                                </div>
                              </v-window-item>
                            </v-window>
                          </v-card>
                          <v-expansion-panels class="napcat-detail-panel mt-2" variant="accordion">
                            <v-expansion-panel>
                              <v-expansion-panel-title>更多详情</v-expansion-panel-title>
                              <v-expansion-panel-text>
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
                          <v-alert
                            v-if="napcatWebuiSessionMismatch(instance)"
                            type="warning"
                            variant="tonal"
                            density="compact"
                            class="mt-2"
                          >
                            当前 NapCat 会话是 {{ napcatWebuiSessionLabel(instance) }}，但这个 Route 绑定的是 QQ {{ napcatExpectedUserId(instance) }}。它不会覆盖 Route 身份；修复 OneBot 前请先在上方登录卡片切到正确 QQ。
                          </v-alert>
                          <v-expansion-panels class="napcat-detail-panel mt-2" variant="accordion">
                            <v-expansion-panel>
                              <v-expansion-panel-title>自动分配详情</v-expansion-panel-title>
                              <v-expansion-panel-text>
                                <v-alert type="info" variant="tonal" density="compact" class="mb-3">
                                  RabiRoute 会自动生成和维护这些值，用户通常只需要登录 QQ 并勾选是否作为消息渠道。
                                </v-alert>
                                <div class="napcat-auto-summary">
                                  <div><span>管理接口</span><b>{{ instance.webuiUrl || "-" }}</b></div>
                                  <div><span>HTTP</span><b>{{ instance.httpUrl || "-" }}</b></div>
                                  <div><span>WS</span><b>{{ napcatInstanceWsUrl(instance) }}</b></div>
                                  <div><span>工作目录</span><b>{{ instance.workingDir || "自动生成" }}</b></div>
                                </div>
                                <v-switch
                                  v-model="instance.autoLoginOnRabiStart"
                                  class="mt-2"
                                  label="启动 Rabi 时自动登录"
                                  hint="默认开启。Manager 启动完成后在后台启动该 NapCat，并使用已保存的快速登录身份。"
                                  persistent-hint
                                  color="primary"
                                  @update:model-value="touch"
                                />
                                <v-expansion-panels class="mt-3" variant="accordion">
                                  <v-expansion-panel>
                                    <v-expansion-panel-title>高级配置</v-expansion-panel-title>
                                    <v-expansion-panel-text>
                                      <div class="catalog-param-grid">
                                        <v-text-field v-model="instance.name" label="内部备注" placeholder="可选，仅用于排障" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model.number="instance.gatewayPort" type="number" label="RabiRoute WS 端口" :error-messages="napcatInstancePortError(instance)" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.httpUrl" label="NapCat HTTP 地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
                                        <v-text-field v-model="instance.webuiUrl" label="NapCat 管理接口地址" :disabled="!isConfiguredNapcatInstance(instance)" @update:model-value="touch" />
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
                            当前绑定还没有启动命令；RabiRoute 只能检查连接并给出 WS 地址，不能自动拉起 NapCat 后台。
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
                              当前 NapCat QQ：{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentUserId }}{{ napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname ? ` / ${napcatInstanceHealthResult[instance.id]?.onebot?.currentNickname}` : "" }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui">
                              管理接口：{{ napcatInstanceHealthResult[instance.id]?.webui?.reachable ? "可访问" : "未响应" }} · {{ napcatInstanceHealthResult[instance.id]?.webui?.url }}
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.found">
                              管理凭据：已从 NapCat webui.json 读取 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位；仅由 Rabi 后端代理使用。
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.source === 'provided'">
                              管理凭据：使用当前 Route 保存的 {{ napcatInstanceHealthResult[instance.id]?.webui?.tokenLength || "-" }} 位凭据。
                            </div>
                            <div v-if="napcatInstanceHealthResult[instance.id]?.webui?.message">
                              管理凭据：{{ napcatInstanceHealthResult[instance.id]?.webui?.message }}
                            </div>
                            <div>WS：请在对应 NapCat WebSocket Client 里连接 {{ napcatInstanceHealthResult[instance.id]?.wsUrl || napcatInstanceWsUrl(instance) }}</div>
                            <ul v-if="napcatInstanceHealthResult[instance.id]?.diagnostics?.length" class="health-diagnostics">
                              <li v-for="item in napcatInstanceHealthResult[instance.id]?.diagnostics" :key="item">{{ item }}</li>
                            </ul>
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
                              </v-expansion-panel-text>
                            </v-expansion-panel>
                          </v-expansion-panels>
                        </div>
                      </div>
                    </div>
                  </div>
<template v-if="runtime.running !== undefined">
                    <v-alert v-if="!gateway.napcatInstances?.some(instance => napcatLoginPanels[instance.id]?.panel) && adapterErrors('napcat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('napcat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>WS 连接</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : napcatPrimaryOffline() ? 'text-error' : napcatState.connected ? 'text-success' : 'text-error'">{{ messageAdapterInactive ? "未启用" : napcatPrimaryOffline() ? "QQ 已离线" : napcatState.connected ? "已连接" : "未连接" }}</b></div>
                    <div class="status-row"><span>远端地址</span><b>{{ napcatState.remoteAddress || "-" }}</b></div>
                    <div class="status-row"><span>最后连接</span><b>{{ napcatState.lastConnectedAt || "-" }}</b></div>
                    <div class="status-row"><span>最后断开</span><b>{{ napcatState.lastDisconnectedAt || "-" }}</b></div>
                    <div v-if="!gateway.napcatInstances?.some(instance => napcatLoginPanels[instance.id]?.panel)" class="status-row"><span>登录资料</span><b :class="napcatState.loginInfoError ? 'text-error' : ''">{{ napcatState.loginInfoError || napcatState.lastLoginInfoAt || "-" }}</b></div>
                  </template>
  </template>
</template>
