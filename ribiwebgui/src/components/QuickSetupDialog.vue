<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { AgentAdapterType, AgentMaturity, AgentScanResult, AgentScanSession, MessageAdapterType } from "../types";
import { adapterDefaultWebhookPath, adapterLabel, adapterSourceAliases, defaultHeartbeatMessage, gatewayAdapterTypes, isMessageInputsDisabled, isWebhookLikeAdapter } from "../utils/gatewayHelpers";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const store = useGatewayStore();
const router = useRouter();
const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const activeStep = ref(1);
const form = reactive({
  adapters: ["napcat"] as MessageAdapterType[],
  messageInputsDisabled: false,
  agentAdapters: ["codexDesktop"] as AgentAdapterType[],
  agentRoleId: "Rabi",
  agentModel: "",
  codexThreadName: "QQ 消息监听",
  codexCwd: "",
  copilotCliBin: "",
  copilotCwd: "",
  marvisAppId: "",
  astrbotUrl: "http://127.0.0.1:6185",
  astrbotUsername: "",
  astrbotPassword: "",
  astrbotProjectId: "",
  astrbotSessionId: "",
  gatewayPort: 8790,
  napcatHttpUrl: "http://127.0.0.1:3000",
  napcatWebuiUrl: "http://127.0.0.1:6099/webui",
  heartbeatIntervalSeconds: 900,
  heartbeatMessage: defaultHeartbeatMessage(),
  webhookPort: 8790,
  webhookPath: "/webhook",
  fenneNoteWebhookPort: 8790,
  fenneNoteWebhookPath: "/fennenote",
  xiaoaiWebhookPort: 8790,
  xiaoaiWebhookPath: "/xiaoai"
});

const adapterChoices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> = [
  { type: "napcat", title: "NapCat / OneBot", note: "QQ 群聊、私聊实时入口", icon: "mdi-message-badge-outline" },
  { type: "heartbeat", title: "定时触发", note: "按固定间隔投递内部提醒", icon: "mdi-timer-outline" },
  { type: "fennenote", title: "FenneNote / 芬妮笔记", note: "桌面语音笔记转写入口", icon: "mdi-note-edit-outline" },
  { type: "xiaoai", title: "小米音箱 / 小爱", note: "小爱音箱语音转写入口", icon: "mdi-speaker-wireless" },
  { type: "webhook", title: "通用 Webhook", note: "没有专用消息端时的通用 POST 兜底入口", icon: "mdi-webhook" }
];

const quickAgentChoices: Array<{ type: AgentAdapterType; title: string; note: string; icon: string }> = [
  { type: "codexDesktop", title: "Codex Desktop", note: "已验证，适合默认首配", icon: "mdi-monitor-dashboard" },
  { type: "codexApp", title: "Codex App", note: "复用 Codex 会话和项目目录", icon: "mdi-application-outline" },
  { type: "copilotCli", title: "Copilot CLI", note: "实验支持，需要本机登录状态", icon: "mdi-robot-outline" },
  { type: "marvis", title: "Marvis", note: "占位支持，人工接力模式", icon: "mdi-message-processing-outline" },
  { type: "astrbot", title: "AstrBot", note: "实验支持，可绑定 ChatUI 会话", icon: "mdi-robot-happy-outline" }
];

const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  agents: {} as Partial<Record<AgentAdapterType, AgentScanResult>>,
  loading: false
});
const testingAstrbotLogin = ref(false);
const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);
const testingNapcatHealth = ref(false);
const copyingNapcatToken = ref(false);
const napcatHealthResult = ref<{
  ok?: boolean;
  http?: { ok?: boolean; message?: string; userId?: string | number; nickname?: string };
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
const copyResult = ref("");
const openingMarvis = ref(false);
const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);

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
  } catch {
    // Quick setup remains usable with manual values.
  } finally {
    agentScan.value.loading = false;
  }
}

const selectedAgent = computed<AgentAdapterType>(() => form.agentAdapters[0] ?? "codexDesktop");
const agentNeedsCodexProject = computed(() => selectedAgent.value === "codexDesktop" || selectedAgent.value === "codexApp");
const agentNeedsCopilotProject = computed(() => selectedAgent.value === "copilotCli");
const agentNeedsAstrbotEndpoint = computed(() => selectedAgent.value === "astrbot");
const agentNeedsMarvisApp = computed(() => selectedAgent.value === "marvis");

function selectAgent(type: AgentAdapterType): void {
  form.agentAdapters = [type];
  if (type === "copilotCli" && !form.copilotCwd && form.codexCwd) {
    form.copilotCwd = form.codexCwd;
  }
}

function selectAgentValue(value: unknown): void {
  const text = String(value || "");
  if (text === "codexDesktop" || text === "codexApp" || text === "copilotCli" || text === "marvis" || text === "astrbot") {
    selectAgent(text);
  }
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
  if (type !== "astrbot") return scan;

  const localUrl = form.astrbotUrl?.trim();
  const localPassword = form.astrbotPassword?.trim();
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
  if (!value) return agentScan.value.loading ? "扫描中" : "未扫描";
  if (value === "verified") return "已验证";
  if (value === "stub") return "占位";
  return "实验";
}

function maturityColor(value?: AgentMaturity): string {
  if (!value) return "secondary";
  if (value === "verified") return "success";
  if (value === "stub") return "grey";
  return "warning";
}

function currentProject(): string {
  if (agentNeedsAstrbotEndpoint.value) return astrbotProjectItems().find(project => project.value === form.astrbotProjectId)?.title || form.astrbotUrl;
  if (agentNeedsMarvisApp.value) return form.marvisAppId || "Tencent.Marvis";
  return agentNeedsCopilotProject.value ? form.copilotCwd : form.codexCwd;
}

function agentPrimaryLabel(): string {
  if (agentNeedsAstrbotEndpoint.value) return "AstrBot 地址/项目";
  if (agentNeedsMarvisApp.value) return "应用 ID";
  return agentNeedsCopilotProject.value ? "项目目录 (-C)" : "项目目录";
}

function agentSessionLabel(): string {
  if (agentNeedsAstrbotEndpoint.value) return "AstrBot 会话";
  if (agentNeedsMarvisApp.value) return "接力模式";
  return "线程";
}

function agentSessionSummary(): string {
  if (agentNeedsAstrbotEndpoint.value) {
    return astrbotSessionItems().find(session => session.value === form.astrbotSessionId)?.title || "未选择，使用插件默认管线";
  }
  if (agentNeedsMarvisApp.value) return "不绑定会话";
  return form.codexThreadName || "未填写";
}

function projectItems(): string[] {
  const projects = agentScanFor(selectedAgent.value)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(): AgentScanSession[] {
  const scanSessions = agentScanFor(selectedAgent.value)?.sessions;
  if (scanSessions) return scanSessions;
  if (selectedAgent.value === "copilotCli") {
    return agentScan.value.copilotSessions.map(session => ({
      name: session.name,
      projectPath: session.cwd,
      userNamed: session.userNamed
    }));
  }
  return agentScan.value.threadNames.map(name => ({ name }));
}

function astrbotProjectItems(): Array<{ title: string; value: string; path?: string }> {
  return (agentScanFor("astrbot")?.projects ?? []).map(project => ({
    title: project.label || project.path || project.id || "未命名项目",
    value: project.id || project.path,
    path: project.path
  }));
}

function astrbotSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return (agentScanFor("astrbot")?.sessions ?? [])
    .filter(session => !form.astrbotProjectId || session.projectId === form.astrbotProjectId)
    .map(session => ({
      title: session.name,
      value: session.id || session.name,
      subtitle: session.projectPath || session.updatedAt
    }));
}

function selectAstrbotProject(value: unknown): void {
  form.astrbotProjectId = String(value || "");
  const sessions = astrbotSessionItems();
  if (form.astrbotSessionId && !sessions.some(session => session.value === form.astrbotSessionId)) {
    form.astrbotSessionId = "";
  }
}

function selectAstrbotSession(value: unknown): void {
  form.astrbotSessionId = String(value || "");
  const selected = (agentScanFor("astrbot")?.sessions ?? []).find(session => (session.id || session.name) === form.astrbotSessionId);
  if (selected?.projectId && !form.astrbotProjectId) {
    form.astrbotProjectId = selected.projectId;
  }
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function defaultNapcatWebuiUrl(): string {
  return form.napcatWebuiUrl.trim() || "http://127.0.0.1:6099/webui";
}

function napcatWsUrl(): string {
  return `ws://127.0.0.1:${form.gatewayPort || 8790}`;
}

function selectedWebhookAdapter(): MessageAdapterType {
  return form.adapters.find(isWebhookLikeAdapter) ?? "webhook";
}

function selectedWebhookAdapters(): MessageAdapterType[] {
  return form.adapters.filter(isWebhookLikeAdapter);
}

function webhookPortFor(type: MessageAdapterType): number {
  if (type === "fennenote") return Number(form.fenneNoteWebhookPort || form.webhookPort || form.gatewayPort || 8790);
  if (type === "xiaoai") return Number(form.xiaoaiWebhookPort || form.webhookPort || form.gatewayPort || 8790);
  return Number(form.webhookPort || form.gatewayPort || 8790);
}

function webhookPathFor(type: MessageAdapterType): string {
  if (type === "fennenote") return form.fenneNoteWebhookPath || adapterDefaultWebhookPath(type);
  if (type === "xiaoai") return form.xiaoaiWebhookPath || adapterDefaultWebhookPath(type);
  return form.webhookPath || adapterDefaultWebhookPath(type);
}

function setWebhookPort(type: MessageAdapterType, value: unknown): void {
  const port = Number(value || 0);
  if (type === "fennenote") form.fenneNoteWebhookPort = port;
  else if (type === "xiaoai") form.xiaoaiWebhookPort = port;
  else form.webhookPort = port;
}

function setWebhookPath(type: MessageAdapterType, value: unknown): void {
  const path = String(value || "");
  if (type === "fennenote") form.fenneNoteWebhookPath = path;
  else if (type === "xiaoai") form.xiaoaiWebhookPath = path;
  else form.webhookPath = path;
}

function webhookUrl(type: MessageAdapterType = selectedWebhookAdapter()): string {
  return `http://127.0.0.1:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookCurl(type: MessageAdapterType = selectedWebhookAdapter()): string {
  const source = adapterSourceAliases(type)[0] || type;
  return `curl -X POST "${webhookUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"test\",\"message\":\"hello from RabiRoute\"}"`;
}

function webhookSetupHint(type: MessageAdapterType): string {
  if (type === "fennenote") {
    return "需要先安装并运行 FenneNote/芬妮笔记，再把语音转写 webhook 指到这个地址；需要播报回复时再接 OumuQ/TTS worker。";
  }
  if (type === "xiaoai") {
    return "需要小爱桥接层：PC 侧 xiaoai-rabiroute 服务 + 音箱侧 open-xiaoai/xiaogpt/自定义桥，把语音文本转发到这个地址。";
  }
  return "通用 Webhook 只适合未命名外部系统；如果来源是具体工具，建议添加对应的专用消息端。";
}

function webhookSetupDocUrl(type: MessageAdapterType): string {
  if (type === "xiaoai") return "https://github.com/vb2250158/RabiRoute/blob/main/docs/xiaoai-integration/xiaoai-rabiroute-intercept-route.md";
  if (type === "fennenote") return "https://github.com/vb2250158/RabiRoute/blob/main/docs/voice-interaction-workstation.md";
  return "https://github.com/vb2250158/RabiRoute/blob/main/docs/configuration.md";
}

function openExternalUrl(url: string | undefined): void {
  const target = url?.trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
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
  open.value = false;
  void router.push("/runtime");
}

async function testNapcatHealth(): Promise<void> {
  testingNapcatHealth.value = true;
  napcatHealthResult.value = null;
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: form.napcatHttpUrl,
        webuiUrl: defaultNapcatWebuiUrl(),
        gatewayPort: form.gatewayPort
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

async function openNapcatWebuiWithToken(): Promise<void> {
  const fallbackUrl = defaultNapcatWebuiUrl();
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: form.napcatHttpUrl,
        webuiUrl: fallbackUrl,
        gatewayPort: form.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
    const target = body?.webui?.loginUrl
      || (body?.webui?.token ? napcatWebuiUrlWithToken(body?.webui?.url || fallbackUrl, body.webui.token) : "")
      || (body?.webui?.reachable ? body?.webui?.url : "");
    if (target) {
      openExternalUrl(target);
      return;
    }
    napcatHealthResult.value = {
      ok: false,
      ...body,
      message: body?.webui?.message || body?.message || `NapCat WebUI 未响应：${fallbackUrl}`
    };
  } catch (e: unknown) {
    napcatHealthResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function copyNapcatWebuiToken(): Promise<void> {
  if (copyingNapcatToken.value) return;
  copyingNapcatToken.value = true;
  try {
    const resp = await fetch("/api/message/napcat-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        httpUrl: form.napcatHttpUrl,
        webuiUrl: defaultNapcatWebuiUrl(),
        gatewayPort: form.gatewayPort
      })
    });
    const body = await resp.json().catch(() => ({}));
    napcatHealthResult.value = { ok: Boolean(body.ok), ...body };
    const token = body?.webui?.token;
    if (token) {
      await copyText(token, "已复制 NapCat WebUI 登录密钥");
    } else {
      showCopyResult(body?.webui?.message || "未读取到 NapCat WebUI 登录密钥，请检查 NapCat config/webui.json 或启动日志。");
    }
  } catch (e: unknown) {
    showCopyResult(e instanceof Error ? e.message : String(e));
  } finally {
    copyingNapcatToken.value = false;
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
      body: JSON.stringify({ appId: form.marvisAppId })
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

function sessionNames(): string[] {
  const project = currentProject();
  return [...new Set(agentSessions()
    .filter(session => !project || !session.projectPath || samePath(session.projectPath, project))
    .map(session => session.name))];
}

function selectSession(value: unknown): void {
  form.codexThreadName = String(value || "");
  const selected = agentSessions().find(session => session.name === form.codexThreadName);
  if (selected?.projectPath) {
    if (selectedAgent.value === "copilotCli" && !form.copilotCwd) form.copilotCwd = selected.projectPath;
    if (selectedAgent.value !== "copilotCli" && !form.codexCwd) form.codexCwd = selected.projectPath;
  }
}

async function testAstrbotLogin(): Promise<void> {
  testingAstrbotLogin.value = true;
  astrbotLoginResult.value = null;
  try {
    const resp = await fetch("/api/agent/astrbot-login-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: form.astrbotUrl,
        username: form.astrbotUsername,
        password: form.astrbotPassword
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

const messageInputsDisabled = computed(() => form.messageInputsDisabled);
const messageReady = computed(() => {
  if (form.messageInputsDisabled) return true;
  if (form.adapters.includes("napcat") && (!form.gatewayPort || !form.napcatHttpUrl.trim())) return false;
  if (form.adapters.includes("heartbeat") && !form.heartbeatIntervalSeconds) return false;
  if (form.adapters.some(isWebhookLikeAdapter) && selectedWebhookAdapters().some(type => !webhookPortFor(type) || !webhookPathFor(type).trim())) return false;
  return form.adapters.length > 0;
});

const agentReady = computed(() => {
  if (!form.agentAdapters.length) return false;
  if (agentNeedsAstrbotEndpoint.value) return Boolean(form.astrbotUrl.trim());
  if (agentNeedsMarvisApp.value) return true;
  if (agentNeedsCopilotProject.value) return Boolean(form.codexThreadName.trim() && form.copilotCwd.trim());
  if (agentNeedsCodexProject.value) return Boolean(form.codexThreadName.trim() && form.codexCwd.trim());
  return true;
});
const personaReady = computed(() => Boolean(form.agentRoleId.trim()));
const canSave = computed(() => messageReady.value && agentReady.value && personaReady.value);
const completedSteps = computed(() => [messageReady.value, agentReady.value, personaReady.value].filter(Boolean).length);

const steps = computed(() => [
  {
    value: 1,
    title: "消息入口",
    note: form.messageInputsDisabled ? `已禁用 · 保留 ${form.adapters.map(adapterLabel).join(" + ")}` : form.adapters.map(adapterLabel).join(" + "),
    done: messageReady.value,
    icon: "mdi-numeric-1"
  },
  {
    value: 2,
    title: "Agent 绑定",
    note: currentProject() || form.codexThreadName || "选择项目目录和会话线程",
    done: agentReady.value,
    icon: "mdi-numeric-2"
  },
  {
    value: 3,
    title: "人格与保存",
    note: form.agentRoleId || "确认默认人格",
    done: personaReady.value,
    icon: "mdi-numeric-3"
  }
]);

function syncFromGateway() {
  const gateway = store.selectedGateway;
  form.adapters = gateway ? gatewayAdapterTypes(gateway) : ["napcat"];
  form.messageInputsDisabled = gateway ? isMessageInputsDisabled(gateway) : false;
  form.agentAdapters = Array.isArray(gateway?.agentAdapters) && gateway.agentAdapters.length
    ? [...gateway.agentAdapters]
    : ["codexDesktop"];
  form.agentRoleId = gateway?.agentRoleId || "Rabi";
  form.agentModel = gateway?.agentModel || "";
  form.codexThreadName = gateway?.codexThreadName || "QQ 消息监听";
  form.codexCwd = gateway?.codexCwd || "";
  form.copilotCliBin = gateway?.copilotCliBin || "";
  form.copilotCwd = gateway?.copilotCwd || gateway?.codexCwd || "";
  form.marvisAppId = gateway?.marvisAppId || "";
  form.astrbotUrl = gateway?.astrbotUrl || "http://127.0.0.1:6185";
  form.astrbotUsername = gateway?.astrbotUsername || "";
  form.astrbotPassword = gateway?.astrbotPassword || "";
  form.astrbotProjectId = gateway?.astrbotProjectId || "";
  form.astrbotSessionId = gateway?.astrbotSessionId || "";
  form.gatewayPort = Number(gateway?.gatewayPort || 8790);
  form.napcatHttpUrl = gateway?.napcatHttpUrl || "http://127.0.0.1:3000";
  form.napcatWebuiUrl = gateway?.napcatWebuiUrl || "http://127.0.0.1:6099/webui";
  form.heartbeatIntervalSeconds = Number(gateway?.heartbeatIntervalSeconds || 900);
  form.heartbeatMessage = gateway?.heartbeatMessage || defaultHeartbeatMessage();
  form.webhookPort = Number(gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.webhookPath = gateway?.webhookPath || "/webhook";
  form.fenneNoteWebhookPort = Number(gateway?.fenneNoteWebhookPort || gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.fenneNoteWebhookPath = gateway?.fenneNoteWebhookPath || "/fennenote";
  form.xiaoaiWebhookPort = Number(gateway?.xiaoaiWebhookPort || gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.xiaoaiWebhookPath = gateway?.xiaoaiWebhookPath || "/xiaoai";
  napcatHealthResult.value = null;
  astrbotLoginResult.value = null;
  marvisOpenResult.value = null;
  copyResult.value = "";
}

watch(
  () => [open.value, store.selectedGateway?.id] as const,
  ([visible]) => {
    if (visible) {
      syncFromGateway();
      void runAgentScan();
      activeStep.value = messageReady.value ? (agentReady.value ? 3 : 2) : 1;
    }
  },
  { immediate: true }
);

function toggleAdapter(type: MessageAdapterType) {
  const next = new Set<MessageAdapterType>(form.adapters.filter(adapter => adapter !== "disabled"));
  if (next.has(type)) next.delete(type);
  else next.add(type);
  form.adapters = next.size ? [...next] : ["napcat"];
}

function setMessageInputsDisabled(disabled: boolean) {
  form.messageInputsDisabled = disabled;
}

function goNext() {
  if (activeStep.value < 3) activeStep.value += 1;
}

async function apply() {
  store.applyQuickSetup({ ...form });
  await store.save();
  open.value = false;
}
</script>

<template>
  <v-dialog v-model="open" max-width="1040" persistent>
    <v-card class="app-card quick-setup-card">
      <v-card-title class="quick-setup-title">
        <v-avatar rounded="lg" size="44">
          <v-img src="/assets/rabiroute-icon.png" alt="RabiRoute" />
        </v-avatar>
        <div class="min-w-0">
          <div class="section-title">快速配置 RabiRoute</div>
          <div class="section-note">按消息入口、Agent 绑定、人格确认三步完成首次配置。</div>
        </div>
        <v-spacer />
        <v-chip color="secondary" variant="tonal" size="small">
          {{ completedSteps }}/3 已完成
        </v-chip>
      </v-card-title>

      <v-card-text>
        <div class="quick-setup-layout">
          <aside class="quick-setup-rail">
            <v-timeline align="start" side="end" density="compact" truncate-line="both" class="quick-setup-timeline">
              <v-timeline-item
                v-for="step in steps"
                :key="step.value"
                :dot-color="step.done ? 'success' : activeStep === step.value ? 'secondary' : 'grey-lighten-1'"
                :icon="step.done ? 'mdi-check' : step.icon"
                fill-dot
                size="small"
              >
                <button class="quick-step-button" :class="{ active: activeStep === step.value }" @click="activeStep = step.value">
                  <span>{{ step.title }}</span>
                  <small>{{ step.note }}</small>
                </button>
              </v-timeline-item>
            </v-timeline>

            <div class="quick-setup-summary">
              <div class="status-row"><span>当前路由</span><b>{{ store.selectedGateway ? store.configNameFor(store.selectedGateway) : "新建配置" }}</b></div>
              <div class="status-row"><span>版本</span><b>v{{ store.meta.version }}</b></div>
            </div>
          </aside>

          <section class="quick-setup-main">
            <v-window v-model="activeStep">
              <v-window-item :value="1">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">选择消息入口</div>
                    <div class="section-note">可以组合多个入口；禁用入口时仍可先保存 Agent 和人格配置。</div>
                  </div>
                  <v-switch
                    :model-value="messageInputsDisabled"
                    label="禁用消息端"
                    color="warning"
                    inset
                    hide-details
                    @update:model-value="value => setMessageInputsDisabled(Boolean(value))"
                  />
                </div>

                <div class="catalog-param-panel quick-agent-panel">
                  <div class="catalog-param-grid">
                    <v-select
                      v-model="form.adapters"
                      :items="adapterChoices"
                      item-title="title"
                      item-value="type"
                      label="消息入口"
                      hint="可多选；下面只显示已选入口的参数"
                      persistent-hint
                      multiple
                      chips
                      closable-chips
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :prepend-icon="item.raw.icon" :subtitle="item.raw.note" />
                      </template>
                    </v-select>
                  </div>

                <div class="catalog-param-grid" v-if="!form.messageInputsDisabled">
                  <template v-if="form.adapters.includes('napcat')">
                    <v-text-field v-model.number="form.gatewayPort" type="number" label="RabiRoute WS 端口" />
                    <v-text-field v-model="form.napcatHttpUrl" label="NapCat HTTP 地址" />
                    <v-text-field v-model="form.napcatWebuiUrl" class="full-span" label="NapCat WebUI 地址" />
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">打开 NapCat 配置页，或直接检查 HTTP / WebUI / 本机进程状态。</span>
                        </div>
                        <div class="d-flex ga-2 flex-wrap">
                          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-open-in-new" @click="openNapcatWebuiWithToken">
                            打开 NapCat
                          </v-btn>
                          <v-btn
                            size="small"
                            variant="text"
                            prepend-icon="mdi-key-variant"
                            :loading="copyingNapcatToken"
                            :disabled="copyingNapcatToken"
                            @click="copyNapcatWebuiToken"
                          >
                            复制 WebUI 登录密钥
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
                            检查并补齐
                          </v-btn>
                          <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyText(napcatWsUrl(), '已复制 NapCat WS 地址')">
                            复制 WS
                          </v-btn>
                        </div>
                      </div>
                      <v-alert v-if="napcatHealthResult" :type="napcatHealthResult.ok ? 'success' : 'error'" variant="tonal" density="compact" class="mt-2">
                        <div v-if="napcatHealthResult.message">{{ napcatHealthResult.message }}</div>
                        <div v-if="napcatHealthResult.http">
                          HTTP：{{ napcatHealthResult.http.ok ? `可用，${napcatHealthResult.http.nickname || napcatHealthResult.http.userId || '已登录'}` : (napcatHealthResult.http.message || '不可用') }}
                        </div>
                        <div v-if="napcatHealthResult.webui">
                          WebUI：{{ napcatHealthResult.webui.reachable ? "可访问" : "未响应" }} · {{ napcatHealthResult.webui.url }}
                        </div>
                        <div v-if="napcatHealthResult.webui?.found">
                          WebUI 登录密钥：已从 NapCat webui.json 读取 {{ napcatHealthResult.webui.tokenLength || "-" }} 位；只用于打开管理页。
                        </div>
                        <div v-else-if="napcatHealthResult.webui?.source === 'provided'">
                          WebUI 登录密钥：使用当前配置保存的 {{ napcatHealthResult.webui.tokenLength || "-" }} 位登录密钥。
                        </div>
                        <div v-else-if="napcatHealthResult.webui?.message">
                          WebUI 登录密钥：{{ napcatHealthResult.webui.message }}
                        </div>
                        <div>WS：请在 NapCat WebSocket Client 里连接 {{ napcatHealthResult.wsUrl || napcatWsUrl() }}</div>
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
                            打开 WebUI
                          </v-btn>
                          <v-btn
                            v-if="napcatHealthResult.webui?.token"
                            size="small"
                            variant="text"
                            prepend-icon="mdi-key-variant"
                            @click="copyText(napcatHealthResult.webui.token, '已复制 NapCat WebUI 登录密钥')"
                          >
                            复制 WebUI 登录密钥
                          </v-btn>
                        </div>
                      </v-alert>
                    </div>
                  </template>
                  <template v-if="form.adapters.includes('heartbeat')">
                    <v-text-field v-model.number="form.heartbeatIntervalSeconds" type="number" label="定时触发间隔（秒）" />
                    <v-text-field v-model="form.heartbeatMessage" label="定时触发消息" />
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">保存后可在运行日志里手动触发一次，用来验证 Agent 端是否能收到心跳。</span>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                  </template>
                  <template v-for="webhookAdapter in selectedWebhookAdapters()" :key="webhookAdapter">
                    <v-text-field :model-value="webhookPortFor(webhookAdapter)" type="number" :label="`${adapterLabel(webhookAdapter)} 端口`" @update:model-value="value => setWebhookPort(webhookAdapter, value)" />
                    <v-text-field :model-value="webhookPathFor(webhookAdapter)" :label="`${adapterLabel(webhookAdapter)} 路径`" :placeholder="adapterDefaultWebhookPath(webhookAdapter)" @update:model-value="value => setWebhookPath(webhookAdapter, value)" />
                    <div class="quick-agent-status full-span">
                      <div class="status-row"><span>{{ adapterLabel(webhookAdapter) }} 地址</span><b>{{ webhookUrl(webhookAdapter) }}</b></div>
                      <v-alert type="info" variant="tonal" density="compact" class="mt-2">
                        {{ webhookSetupHint(webhookAdapter) }}
                      </v-alert>
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">这里只复制 {{ adapterLabel(webhookAdapter) }} 测试入口，不会自动发送。</span>
                        </div>
                        <div class="d-flex ga-2 flex-wrap">
                          <v-btn size="small" variant="tonal" color="secondary" prepend-icon="mdi-book-open-variant" @click="openExternalUrl(webhookSetupDocUrl(webhookAdapter))">
                            配置说明
                          </v-btn>
                          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(webhookUrl(webhookAdapter), `已复制 ${adapterLabel(webhookAdapter)} 地址`)">
                            复制地址
                          </v-btn>
                          <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl(webhookAdapter), '已复制 curl 示例')">
                            复制 curl
                          </v-btn>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
                <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                  {{ copyResult }}
                </v-alert>
                <v-alert v-if="form.messageInputsDisabled" type="info" variant="tonal">已暂时禁用消息端；入口选择和参数会保留，关闭禁用后继续使用。</v-alert>
                </div>
              </v-window-item>

              <v-window-item :value="2">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">绑定 Agent 处理端</div>
                    <div class="section-note">快速配置只绑定一个 Agent；先确定处理端和项目目录，再选择会话。</div>
                  </div>
                </div>

                <div class="catalog-param-panel quick-agent-panel">
                  <div class="catalog-param-grid">
                    <v-select
                      :model-value="selectedAgent"
                      :items="quickAgentChoices"
                      item-title="title"
                      item-value="type"
                      label="Agent 处理端"
                      hint="所有已支持的 Agent 都在这里选择；高级字段会随处理端变化"
                      persistent-hint
                      @update:model-value="selectAgentValue"
                    >
                      <template #selection="{ item }">
                        <div class="quick-agent-select">
                          <v-icon size="18" color="secondary">{{ item.raw.icon }}</v-icon>
                          <span>{{ item.raw.title }}</span>
                          <v-chip size="x-small" :color="maturityColor(agentScanFor(item.raw.type)?.maturity)" variant="tonal">
                            {{ maturityLabel(agentScanFor(item.raw.type)?.maturity) }}
                          </v-chip>
                        </div>
                      </template>
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :prepend-icon="item.raw.icon" :subtitle="item.raw.note">
                          <template #append>
                            <v-chip size="x-small" :color="maturityColor(agentScanFor(item.raw.type)?.maturity)" variant="tonal">
                              {{ maturityLabel(agentScanFor(item.raw.type)?.maturity) }}
                            </v-chip>
                          </template>
                        </v-list-item>
                      </template>
                    </v-select>
                  </div>

                  <v-alert v-if="selectedAgent === 'copilotCli'" type="warning" variant="tonal" density="compact" class="mb-3">
                    Copilot CLI 仍是实验适配；同一会话重复注入还需要单独烟测确认。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'astrbot'" type="info" variant="tonal" density="compact" class="mb-3">
                    AstrBot 会优先绑定 ChatUI 项目和会话；未选择会话时才回退到 rabiroute_agent 插件默认管线。
                  </v-alert>
                  <v-alert v-if="selectedAgent === 'marvis'" type="info" variant="tonal" density="compact" class="mb-3">
                    Marvis 当前是人工接力模式：RabiRoute 会打开应用并复制 prompt，不会绑定会话线程。
                  </v-alert>

                  <div class="catalog-param-grid">
                  <template v-if="selectedAgent === 'marvis'">
                    <v-combobox
                      v-model="form.marvisAppId"
                      :items="agentScan.marvisAppIds"
                      class="full-span"
                      label="Marvis 应用 ID"
                      placeholder="Tencent.Marvis"
                      hint="留空使用默认 Tencent.Marvis"
                      persistent-hint
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <div class="quick-agent-status full-span">
                      <div class="agent-action-bar">
                        <div class="agent-action-status">
                          <span class="section-note">先打开 Marvis 确认应用可用；路由触发时会把 prompt 放到剪贴板。</span>
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
                    </div>
                  </template>

                  <template v-if="selectedAgent === 'astrbot'">
                    <v-combobox
                      v-model="form.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      class="full-span"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot Dashboard / API 地址"
                      persistent-hint
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="form.astrbotUsername"
                      label="AstrBot 用户名"
                      placeholder="留空使用环境变量 ASTRBOT_USERNAME"
                    />
                    <v-text-field
                      v-model="form.astrbotPassword"
                      type="password"
                      label="AstrBot 密码"
                      placeholder="留空使用环境变量 ASTRBOT_PASSWORD"
                    />
                    <v-select
                      v-model="form.astrbotProjectId"
                      :items="astrbotProjectItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 项目"
                      placeholder="可选：先选项目再筛选会话"
                      clearable
                      @update:model-value="selectAstrbotProject"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                    <v-select
                      v-model="form.astrbotSessionId"
                      :items="astrbotSessionItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 会话"
                      placeholder="选择一个 ChatUI 会话"
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
                    <div class="quick-agent-status full-span">
                      <div
                        v-for="endpoint in agentScanFor('astrbot')?.endpoints ?? []"
                        :key="endpoint.url"
                        class="status-row"
                      >
                        <span>{{ endpoint.label }}</span>
                        <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                      </div>
                      <div
                        v-for="plugin in agentScanFor('astrbot')?.plugins ?? []"
                        :key="plugin.id"
                        class="status-row"
                      >
                        <span>{{ plugin.name }}</span>
                        <b :class="plugin.installed ? 'text-success' : 'text-warning'">{{ plugin.installed ? "已安装" : "未安装" }}</b>
                      </div>
                      <div class="status-row">
                        <span>鉴权</span>
                        <b :class="agentScanFor('astrbot')?.auth?.loggedIn ? 'text-success' : 'text-warning'">
                          {{ agentScanFor('astrbot')?.auth?.message || "-" }}
                        </b>
                      </div>
                      <div class="status-row">
                        <span>会话</span>
                        <b :class="astrbotSessionItems().length ? 'text-success' : 'text-warning'">
                          {{ astrbotSessionItems().length ? `可选 ${astrbotSessionItems().length} 个` : "未读取到会话" }}
                        </b>
                      </div>
                      <div class="status-row">
                        <span>验证</span>
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
                    </div>
                    <v-alert
                      v-if="astrbotLoginResult"
                      :type="astrbotLoginResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="full-span"
                    >
                      {{ astrbotLoginResult.message }}
                    </v-alert>
                  </template>

                  <v-combobox
                    v-if="selectedAgent === 'copilotCli'"
                    v-model="form.copilotCliBin"
                    :items="agentScan.copilotBins"
                    label="CLI 可执行路径"
                    placeholder="copilot"
                    hint="留空使用 PATH 中的 copilot"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-if="selectedAgent === 'copilotCli'"
                    v-model="form.copilotCwd"
                    :items="projectItems()"
                    class="full-span"
                    label="项目目录 (-C)"
                    placeholder="C:/Path/To/Project"
                    hint="会话列表会按这个目录过滤"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-else-if="selectedAgent !== 'astrbot' && selectedAgent !== 'marvis'"
                    v-model="form.codexCwd"
                    :items="projectItems()"
                    class="full-span"
                    label="项目目录"
                    placeholder="C:/Path/To/Project"
                    hint="先选项目，再选该项目下的会话"
                    persistent-hint
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>

                  <v-combobox
                    v-if="selectedAgent !== 'astrbot' && selectedAgent !== 'marvis'"
                    v-model="form.codexThreadName"
                    :items="sessionNames()"
                    label="会话线程名"
                    placeholder="Rabi"
                    hint="没有扫到时也可以手动填写"
                    persistent-hint
                    @update:model-value="selectSession"
                  >
                    <template #append-inner>
                      <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                      <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                    </template>
                  </v-combobox>
                  <v-text-field
                    v-if="selectedAgent === 'codexDesktop' || selectedAgent === 'codexApp'"
                    v-model="form.agentModel"
                    class="full-span"
                    label="模型覆盖"
                    placeholder="留空，沿用原会话模型"
                    hint="只在需要强制指定 Agent 模型时填写"
                    persistent-hint
                  />
                  </div>
                </div>
              </v-window-item>

              <v-window-item :value="3">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">确认人格与配置</div>
                    <div class="section-note">保存后会写入与旧 WebGUI 相同的 gateway 数据结构。</div>
                  </div>
                </div>
                <v-text-field v-model="form.agentRoleId" label="默认人格 ID" class="mb-4" />
                <div class="quick-review">
                  <div class="status-row"><span>消息入口</span><b>{{ form.adapters.map(adapterLabel).join(" + ") }}</b></div>
                  <div class="status-row"><span>Agent</span><b>{{ quickAgentChoices.find(agent => agent.type === selectedAgent)?.title || selectedAgent }}</b></div>
                  <div class="status-row"><span>{{ agentPrimaryLabel() }}</span><b>{{ currentProject() || "未填写" }}</b></div>
                  <div class="status-row"><span>{{ agentSessionLabel() }}</span><b>{{ agentSessionSummary() }}</b></div>
                  <div class="status-row"><span>人格</span><b>{{ form.agentRoleId || "未填写" }}</b></div>
                </div>
                <v-alert v-if="!canSave" class="mt-4" type="warning" variant="tonal">
                  还有必要字段没有填写，请回到对应步骤补全。
                </v-alert>
              </v-window-item>
            </v-window>
          </section>
        </div>
      </v-card-text>

      <v-card-actions class="px-6 pb-5">
        <v-btn variant="text" :disabled="activeStep === 1" @click="activeStep -= 1">上一步</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="open = false">稍后再配</v-btn>
        <v-btn v-if="activeStep < 3" color="primary" variant="tonal" @click="goNext">下一步</v-btn>
        <v-btn v-else color="primary" :disabled="!canSave" :loading="store.saving" @click="apply">保存配置</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
