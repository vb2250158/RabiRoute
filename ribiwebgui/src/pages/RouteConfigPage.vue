<script setup lang="ts">
import { translateText } from "../i18n";
import { readConnectedAgentInstances } from "../connectedAgentInstances";
import RoleBindingEditor from "../components/RoleBindingEditor.vue";
import { userFacingError } from "../userFacingError";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import InstanceAgentSettings from "../components/InstanceAgentSettings.vue";
import PeerRouteAgentSettings from "../components/PeerRouteAgentSettings.vue";
import DshConnectionPanel from "../components/DshConnectionPanel.vue";
import PrimaryAgentAdvancedSettings from "../components/PrimaryAgentAdvancedSettings.vue";
import { localAgentTargetKey, remoteAgentTargetKey, resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { addRouteAgent, removeRouteAgent, selectRouteAgent, selectPeerRouteSession } from "../routeAgentTargetEditor";
import { postRouteAgentThreadAction } from "../routeAgentThreadClient";
import { routeAgentOperationGuard } from "../routeAgentOperationGuard";
import { createGrokBotRouteScan, grokBotScanParameters, grokBotPersonaPickerItems, selectGrokBotRoutePersona, type GrokBotRouteConnection } from "../grokBotRouteConfig";
import { agentInstanceDisplayName, type AgentInstance } from "@shared/agentInstance";
import { managerEventSource, managerAccessToken } from "../managerApi";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { webRenderersAt } from "../pluginRenderers";
import type { MessageAdapterType, MessageEndpointType, AgentAdapterType, AgentDeliveryTestResult, AgentMaturity, AgentScanResult, AgentScanSession, MessageAdapterScanResult } from "../types";
import { codexModelPickerItems, dshModelPickerItems, dshModelValue, parseDshModelValue, reasoningEffortPickerItems } from "../agentModelPicker";
import { isNonMessageEndpoint, adapterLabel, applyAdapterDefaults, gatewayAdapterTypes, isAdapterDisabled, isMessageInputsDisabled, messageAdapterPolicyFor, setGatewayAdapters, setMessageAdapterPolicy, toggleAdapterDisabled } from "../utils/gatewayHelpers";
import { initializeAgentSessionForRoute } from "@shared/codexSessionInitialization";
import { codexThreadItems, selectCodexThread, type CodexThreadSummary } from "@shared/codexThreadSelection";
import { DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL } from "@shared/codexMemoryConsolidationAgent";
import { agentAdapterManifest, agentAdapterSupportsManagedTaskFeature, DEFAULT_CODEX_HOOK_SETTINGS, DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL, DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT, MAX_MESSAGE_PROCESSING_AGENTS, messageAdapterUsesAutomaticGrouping } from "@shared/gatewayConfigModel";
import { DEFAULT_CODEX_PLAN_ASSISTANT_MODEL, codexPlanAssistantInitializationPrompt, codexPlanAssistantSessionTitles, normalizeCodexPlanAssistantCount, filterCodexPlanAssistantSessionsForTarget, planAssistantSessionAgentAdapter } from "@shared/codexPlanAssistantSessions";
import { copyTextToClipboard } from "../clipboard";
import { routeScopedAdaptersPath } from "../routeScopedNavigation";
import { deviceAgentInstanceFromCatalog } from "../deviceAgentCatalog";
import MessageEndpointCardHost from "../messageEndpoints/MessageEndpointCardHost.vue";
import { messageEndpointCatalog, messageEndpointGroups } from "../messageEndpoints/messageEndpointCatalog";

const MessageProcessingBoard = defineAsyncComponent(() => import("../components/MessageProcessingBoard.vue"));

const props = defineProps<{ embedded?: boolean }>();

const messageEndpointSettingsRenderers = computed(() => webRenderersAt(
  pluginCatalogStore.settingsRenderers.value,
  "route.adapters.message-endpoint-settings"
));

function settingsRenderersForMessageEndpoint(type: MessageAdapterType) {
  return messageEndpointSettingsRenderers.value.filter(renderer => renderer.slot === type && renderer.endpointType === type);
}

const store = useGatewayStore();

const route = useRoute();

const router = useRouter();

const messageProcessingBoardOpen = ref(false);

const channelCheckDialogOpen = ref(false);

const agentDeliveryTest = ref<{ loading: string | null; result: AgentDeliveryTestResult | null; error: string }>({
  loading: null,
  result: null,
  error: ""
});

const runtime = computed(() => store.selectedRuntime);

const adapterQuery = ref("");

const configNameError = ref("");

const codexBinding = ref({ loading: false, error: "", pending: false });

const managedAgentSessionAction = ref({ loading: false, message: "", error: "" });

const codexPlanAssistants = ref({ count: 1, loading: false, message: "", error: "" });

const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  agents: {} as Partial<Record<AgentAdapterType, AgentScanResult>>,
  loading: false,
});

const dshScanLoading = ref(false);

const dshScanRevision = ref(0);

const grokBotSelectionError = ref("");

const grokBotScan = createGrokBotRouteScan(grokBotConnection);

watch(() => grokBotScan.state.result, result => {
  if (result) agentScan.value.agents = { ...agentScan.value.agents, grokBot: result };
}, { flush: "sync" });

function grokBotConnection(): GrokBotRouteConnection {
  return { id: gateway.value?.id || "" };
}

const codexModelItems = computed(() => codexModelPickerItems(agentScan.value.agents.codex?.models ?? []));

const codexReasoningEffortItems = computed(() => {
  const discovered = reasoningEffortPickerItems(
    agentScan.value.agents.codex?.models ?? [],
    store.selectedGateway?.agentModel
  );
  return discovered.length > 0 ? discovered : ["low", "medium", "high", "xhigh", "max"];
});

const dshModelItems = computed(() => dshModelPickerItems(agentScan.value.agents.dsh?.models ?? []));

const configuredDshModelValue = computed(() => dshModelValue(
  store.selectedGateway?.dshModelProvider,
  store.selectedGateway?.dshModel
));

const dshReasoningEffortItems = computed(() => reasoningEffortPickerItems(
  agentScan.value.agents.dsh?.models ?? [],
  store.selectedGateway?.dshModel,
  store.selectedGateway?.dshModelProvider
));

function selectCodexModel(value: unknown): void {
  if (!store.selectedGateway) return;
  store.selectedGateway.agentModel = String(value || "").trim();
  const selected = agentScan.value.agents.codex?.models?.find(model => model.id === store.selectedGateway?.agentModel);
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!store.selectedGateway.agentReasoningEffort || !efforts.includes(store.selectedGateway.agentReasoningEffort))) {
    store.selectedGateway.agentReasoningEffort = selected.defaultReasoningEffort as typeof store.selectedGateway.agentReasoningEffort;
  }
  touch();
}

function selectDshModel(value: unknown): void {
  if (!store.selectedGateway) return;
  const parsed = parseDshModelValue(value, agentScan.value.agents.dsh?.models ?? []);
  store.selectedGateway.dshModelProvider = parsed.provider;
  store.selectedGateway.dshModel = parsed.model;
  const selected = agentScan.value.agents.dsh?.models?.find(model => (
    model.provider === parsed.provider && model.id === parsed.model
  ));
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!store.selectedGateway.dshReasoningEffort || !efforts.includes(store.selectedGateway.dshReasoningEffort))) {
    store.selectedGateway.dshReasoningEffort = selected.defaultReasoningEffort || "";
  }
  touch();
}

const messageAdapterScan = ref({
  adapters: {} as Partial<Record<MessageAdapterType, MessageAdapterScanResult>>,
  loading: false,
  error: "",
  overall: null as null | { state: "healthy" | "degraded" | "unknown"; message: string },
  partial: false,
  durationMs: 0,
  checkedAt: ""
});

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

async function runAgentScan(): Promise<void> {
  void refreshLanAgentNodes();
  if (agentScan.value.loading) return;
  agentScan.value.loading = true;
  const dshRevisionAtStart = dshScanRevision.value;
  const grokBotRevisionAtStart = grokBotScan.revision;
  const grokBotConnectionAtStart = grokBotConnection();
  try {
    const params = new URLSearchParams();
    const dshBaseUrl = gateway.value?.dshBaseUrl?.trim();
    if (dshBaseUrl) params.set("dshBaseUrl", dshBaseUrl);
    for (const [key, value] of grokBotScanParameters(grokBotConnectionAtStart)) params.set(key, value);
    const res = await fetch(`/api/scan/agents${params.size ? `?${params}` : ""}`);
    const data = await res.json();
    agentScan.value.threadNames = data.threadNames ?? [];
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
    agentScan.value.copilotSessions = data.copilotSessions ?? [];
    agentScan.value.copilotBins = data.copilotBins ?? [];
    agentScan.value.marvisAppIds = data.marvisAppIds ?? [];
    const currentDsh = agentScan.value.agents.dsh;
    await grokBotScan.initialize(data.agents?.grokBot, grokBotConnectionAtStart, grokBotRevisionAtStart);
    const currentGrokBot = grokBotScan.state.result ?? agentScan.value.agents.grokBot;
    agentScan.value.agents = {
      ...(data.agents ?? {}),
      ...(dshScanRevision.value !== dshRevisionAtStart && currentDsh ? { dsh: currentDsh } : {}),
      grokBot: currentGrokBot
    };
  } catch { /* ignore */ }
  finally { agentScan.value.loading = false; }
}

const agentInstances = ref<AgentInstance[]>([]);

const lanAgentLoading = ref(false);

const lanAgentError = ref("");

async function refreshLanAgentNodes(): Promise<void> {
  if (lanAgentLoading.value) return;
  lanAgentLoading.value = true;
  lanAgentError.value = "";
  try {
    const access = await fetch("/api/webgui-access").then(response => response.json());
    const token = access.data?.token || managerAccessToken();
    const headers = { "x-rabiroute-webgui-token": token };
    const catalogs = await Promise.allSettled([
      fetch("/api/lan-agent/instances", { cache: "no-store", headers }).then(async response => {
        const body = await response.json();
        if (!response.ok || body.code !== 0) throw new Error(body.message || "读取电脑 Agent 实例失败");
        return (body.instances || []) as AgentInstance[];
      }),
      fetch("/api/device-agents", { cache: "no-store", headers }).then(async response => {
        const body = await response.json();
        if (!response.ok || body.code !== 0) throw new Error(body.message || "设备 Agent 未配置：请在设备设置中绑定角色和所属电脑后刷新。");
        const instance = deviceAgentInstanceFromCatalog(body.data);
        return instance ? [instance] : [];
      })
    ]);
    const peers = await readConnectedAgentInstances(fetch, headers).catch(error => ({ instances: [], errors: [userFacingError(error)] }));
    agentInstances.value = [...catalogs.flatMap(result => result.status === "fulfilled" ? result.value : []), ...peers.instances];
    lanAgentError.value = [...catalogs.flatMap(result => result.status === "rejected" ? [userFacingError(result.reason)] : []), ...peers.errors].join("；");
  } catch (error) {
    agentInstances.value = [];
    lanAgentError.value = userFacingError(error);
  } finally { lanAgentLoading.value = false; }
}

function refreshAgentScan(type: AgentAdapterType): void {
  if (type === "grokBot") { void runGrokBotAgentScan(); return; }
  const scan = type === "dsh" ? runDshAgentScan : runAgentScan;
  void scan();
}

async function runGrokBotAgentScan(): Promise<void> {
  grokBotSelectionError.value = "";
  await grokBotScan.refresh();
}

function selectGrokBotPersona(value: unknown): void {
  if (!gateway.value || grokBotScan.state.loading) return;
  if (!selectGrokBotRoutePersona(gateway.value, grokBotScan.state.result, value)) {
    grokBotSelectionError.value = "未发现该 Bot 的默认主会话，请刷新后重新选择。";
    return;
  }
  if (value) selectRouteAgent(gateway.value, localAgentTargetKey("grokBot"));
  grokBotSelectionError.value = "";
  touch();
}

async function runDshAgentScan(options: { append?: boolean; offset?: number; limit?: number } = {}): Promise<void> {
  if (dshScanLoading.value) return;
  dshScanLoading.value = true;
  try {
    const params = new URLSearchParams();
    if (options.offset != null) params.set("dshOffset", String(options.offset));
    if (options.limit != null) params.set("dshLimit", String(options.limit));
    const dshBaseUrl = gateway.value?.dshBaseUrl?.trim();
    if (dshBaseUrl) params.set("dshBaseUrl", dshBaseUrl);
    const res = await fetch(`/api/scan/agents/dsh${params.size ? `?${params}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `DSH 扫描失败（HTTP ${res.status}）`);
    const currentDsh = agentScan.value.agents.dsh;
    const nextDsh = data.agents?.dsh as AgentScanResult | undefined;
    const sessions = options.append
      ? [...(currentDsh?.sessions ?? []), ...(nextDsh?.sessions ?? [])]
      : [...(nextDsh?.sessions ?? [])];
    const uniqueSessions = [...new Map(sessions.map(session => [
      session.id || `${session.name}:${session.projectPath || ""}:${session.updatedAt || ""}`,
      session
    ])).values()];
    agentScan.value.agents = {
      ...agentScan.value.agents,
      dsh: nextDsh ? { ...nextDsh, sessions: uniqueSessions } : currentDsh
    };
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
    dshScanRevision.value += 1;
  } catch {
    // Keep the last successful DSH scan visible.
  } finally {
    dshScanLoading.value = false;
  }
}

async function loadMoreCodexSessions(): Promise<void> {
  const page = agentScan.value.agents.codex?.sessionPage;
  if (agentScan.value.loading || !page?.hasMore || page.nextOffset == null) return;
  agentScan.value.loading = true;
  try {
    const params = new URLSearchParams({
      codexOffset: String(page.nextOffset),
      codexLimit: String(page.limit)
    });
    const res = await fetch(`/api/scan/agents?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Agent 扫描失败（HTTP ${res.status}）`);
    const currentCodex = agentScan.value.agents.codex;
    const nextCodex = data.agents?.codex as AgentScanResult | undefined;
    const sessions = [...(currentCodex?.sessions ?? []), ...(nextCodex?.sessions ?? [])];
    const uniqueSessions = [...new Map(sessions.map(session => [
      session.id || `${session.name}:${session.projectPath || ""}:${session.updatedAt || ""}`,
      session
    ])).values()];
    agentScan.value.agents = {
      ...agentScan.value.agents,
      ...(data.agents ?? {}),
      codex: nextCodex ? { ...nextCodex, sessions: uniqueSessions } : currentCodex
    };
    agentScan.value.threadNames = [...new Set([...agentScan.value.threadNames, ...(data.threadNames ?? [])])];
    agentScan.value.cwdOptions = [...new Set([...agentScan.value.cwdOptions, ...(data.cwdOptions ?? [])])];
  } catch {
    // Keep the already loaded task page available.
  } finally {
    agentScan.value.loading = false;
  }
}

async function loadMoreDshSessions(): Promise<void> {
  const page = agentScan.value.agents.dsh?.sessionPage;
  if (!page?.hasMore || page.nextOffset == null) return;
  await runDshAgentScan({ append: true, offset: page.nextOffset, limit: page.limit });
}

// 会话/项目扫描只在进入设置页时自动执行一次；后续刷新必须由用户点击扫描按钮触发。
onMounted(() => { void runAgentScan(); });

onBeforeUnmount(() => { grokBotScan.dispose(); });

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
      const events = managerEventSource("/api/events");
      events.addEventListener("copilot_login_status", async (raw) => {
        const event = JSON.parse((raw as MessageEvent).data || "{}");
        events.close();
        if (event.done) {
          await fetchCopilotStatus();
          copilotLoginState.value.done = true;
          copilotLoginState.value.code = null;
        } else {
          copilotLoginState.value.error = event.error || "登录失败";
        }
      });
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

const adapterParamOpen = ref<Record<string, boolean>>({});

const adapterLifecycleRevision = ref<Record<string, number>>({});
const adapterActionBusy = ref<Record<string, boolean>>({});

const addAdapterMenu = ref(false);

const endpointCatalog = computed(() => messageEndpointCatalog(pluginCatalogStore.settingsRenderers.value));

const adapterGroups = computed(() => messageEndpointGroups(endpointCatalog.value, addedAdapters.value.filter(type => !isNonMessageEndpoint(type))));

const gateway = computed(() => store.selectedGateway);

function uniqueAdapters(types: MessageAdapterType[]): MessageAdapterType[] {
  return [...new Set(types.filter((type) => type !== "disabled" && type !== "rolePanel"))];
}

function configuredAdapterCatalog(gw: NonNullable<typeof gateway.value>): MessageAdapterType[] {
  if (Array.isArray(gw.messageAdapters)) {
    return uniqueAdapters(gw.messageAdapters);
  }
  return gw.messageAdapterType ? uniqueAdapters([gw.messageAdapterType]) : [];
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

const visibleActiveAdapters = computed<MessageAdapterType[]>(() => uniqueAdapters(adapters.value)
  .filter(type => !isNonMessageEndpoint(type) && endpointCatalog.value.some(item => item.type === type)));

const activeAdapterCount = computed(() => visibleActiveAdapters.value.length);

const copyResult = ref("");

const deletingGateway = ref(false);

const deleteError = ref("");

const openingMarvis = ref(false);

const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);

const visibleAdapterGroups = computed(() => {
  const query = adapterQuery.value.trim().toLowerCase();
  return adapterGroups.value
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

async function setAdapterEnabled(type: MessageAdapterType, value: unknown): Promise<void> {
  if (!gateway.value || (value === true) === !isAdapterDisabled(gateway.value, type)) return;
  toggleAdapterDisabled(gateway.value, type);
  store.touch();
}

function hasAdapterParams(type: MessageAdapterType): boolean {
  return type !== "disabled";
}

function messageGroupingPolicy(type: MessageAdapterType) {
  if (!gateway.value || type === "disabled") return undefined;
  return messageAdapterPolicyFor(gateway.value, type).messageGrouping;
}

function conversationReviewPolicy(type: MessageAdapterType) {
  if (!gateway.value || type === "disabled") return undefined;
  return messageAdapterPolicyFor(gateway.value, type).conversationReview;
}

function setConversationReviewEnabled(type: MessageAdapterType, enabled: boolean | null): void {
  if (!gateway.value) return;
  setMessageAdapterPolicy(gateway.value, type, { conversationReview: { ...conversationReviewPolicy(type), enabled: enabled === true } });
}

function setConversationReviewPolicy(type: MessageAdapterType, field: "initialMessageCount" | "maxIncrementalMessages", raw: unknown): void {
  const value = Number(raw);
  if (!gateway.value || type === "disabled" || !Number.isInteger(value) || value < (field === "initialMessageCount" ? 1 : 2) || value > 500) return;
  setMessageAdapterPolicy(gateway.value, type, { conversationReview: { ...conversationReviewPolicy(type), [field]: value } });
  store.touch();
}

function usesAutomaticMessageGrouping(type: MessageAdapterType): boolean {
  return type !== "disabled" && messageAdapterUsesAutomaticGrouping(type);
}

function setMessageGroupingPolicy(type: MessageAdapterType, patch: Record<string, unknown>): void {
  if (!gateway.value || type === "disabled") return;
  const current = messageAdapterPolicyFor(gateway.value, type);
  setMessageAdapterPolicy(gateway.value, type, {
    messageGrouping: { ...current.messageGrouping, ...patch }
  });
  store.touch();
}

function toggleAdapterParams(type: MessageAdapterType): void {
  adapterParamOpen.value[type] = !adapterParamOpen.value[type];
  if (adapterParamOpen.value[type]) void runMessageAdapterScan();
}

function removeAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = addedAdapters.value.filter(t => t !== type);
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = false;
  store.touch();
}

const availableToAdd = computed(() => endpointCatalog.value.filter(item => !addedAdapters.value.includes(item.type)).map(item => item.type));

function addAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  setGatewayAdapters(gateway.value, [...addedAdapters.value, type]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = true;
  adapterLifecycleRevision.value[type] = (adapterLifecycleRevision.value[type] || 0) + 1;
  void runMessageAdapterScan();
  store.touch();
}

function touch(): void {
  if (gateway.value) applyAdapterDefaults(gateway.value);
  store.touch();
}

function openExternalUrl(url: string | undefined): void {
  const target = url?.trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function messageScanFor(type: MessageAdapterType): MessageAdapterScanResult | undefined { return messageAdapterScan.value.adapters[type]; }

const channelCheckItems = computed(() => {
  const catalog = new Map(adapterGroups.value.flatMap(group => group.choices).map(choice => [choice.type, choice]));
  return addedAdapters.value
    .filter((type): type is MessageEndpointType => type !== "disabled" && !isNonMessageEndpoint(type))
    .map(type => catalog.get(type) ?? {
      type,
      title: adapterLabel(type),
      note: "当前 Route 已添加的消息端。",
      icon: "mdi-connection"
    });
});

async function runChannelCheck(): Promise<void> {
  const scanAgents = runAgentScan;
  await Promise.all([runMessageAdapterScan(), scanAgents(), refreshLanAgentNodes()]);
}

function openChannelCheckDialog(): void {
  channelCheckDialogOpen.value = true;
  void runChannelCheck();
}

function openChannelCheckDetails(type: MessageAdapterType): void {
  channelCheckDialogOpen.value = false;
  adapterQuery.value = "";
  adapterParamOpen.value[type] = true;
}

function openChannelCheckAgentDetails(type: AgentAdapterType): void {
  channelCheckDialogOpen.value = false;
  agentParamOpen.value[type] = true;
}

function agentDeliveryTestCompletedAt(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

async function runAgentDeliveryTest(type: AgentAdapterType, targetId = localAgentTargetKey(type)): Promise<void> {
  if (!gateway.value) return;
  agentDeliveryTest.value = { loading: targetId, result: null, error: "" };
  try {
    if (store.dirty) {
      throw new Error("请先保存当前配置，再执行投递测试。");
    }
    const result = await store.testAgentDelivery(gateway.value.id, type, targetId);
    agentDeliveryTest.value = { loading: null, result, error: "" };
  } catch (error) {
    agentDeliveryTest.value = {
      loading: null,
      result: null,
      error: userFacingError(error)
    };
  }
}

function enabledChannelCheckScans(): Array<MessageAdapterScanResult | undefined> {
  if (!gateway.value) return [];
  return channelCheckItems.value
    .filter(item => !isAdapterDisabled(gateway.value!, item.type))
    .map(item => messageScanFor(item.type));
}

function channelCheckOverallLabel(): string {
  if (messageAdapterScan.value.loading || agentScan.value.loading) return "正在检查通道";
  if (messageAdapterScan.value.error) return "通道检查失败";
  if (!messageAdapterScan.value.checkedAt) return "尚未检查";
  if (gateway.value?.enabled === false || runtime.value.enabled === false) return "当前 Route 已停用";
  if (runtime.value.running === false) return "Manager 未运行";
  const scans = enabledChannelCheckScans();
  if (!scans.length) return "没有启用的通道";
  if (!primaryAgent.value) return "尚未选择主控 Agent";
  if (scans.some(scan => !scan)) return "检查完成，状态待确认";
  if (scans.some(scan => scan?.scan?.state === "timeout" || scan?.scan?.state === "error")) {
    return "检查完成，部分结果超时";
  }
  const agentsReady = primaryAgent.value.binding
    ? false // Instance connectivity alone does not prove delivery to its task owner.
    : ["可投递", "已绑定", "已发现"].includes(channelAgentConnectionLabel(primaryAgent.value.provider));
  if (agentsReady && scans.every(scan => ["可用", "已发现"].includes(scanConnectionLabel(scan)))) return "通道状态正常";
  return "发现需要处理的通道";
}

function channelCheckOverallColor(): string {
  const label = channelCheckOverallLabel();
  if (label === "通道检查失败") return "error";
  if (["正在检查通道", "尚未检查", "没有启用的通道", "当前 Route 已停用"].includes(label)) return "secondary";
  if (label !== "通道状态正常") return "warning";
  return "success";
}

function channelCheckDetail(scan?: MessageAdapterScanResult): string {
  if (!scan) return messageAdapterScan.value.loading ? "正在读取连接和依赖状态。" : "本轮没有返回检查结果。";
  if (scan.health?.message) return scan.health.message;
  if (scan.scan?.message) return scan.scan.message;
  const missing = scan.requirements?.filter(item => item.required && item.ok === false) ?? [];
  if (missing.length) return `缺少：${missing.map(item => item.label).join("、")}`;
  return scan.installed ? "已发现消息端，连接状态需要进一步确认。" : "尚未发现所需配置或服务。";
}

function scanConnectionLabel(scan?: MessageAdapterScanResult): string {
  if (!scan) return messageAdapterScan.value.loading ? "扫描中" : "未扫描";
  const labels: Record<NonNullable<MessageAdapterScanResult["health"]>["state"], string> = {
    healthy: "可用",
    degraded: "部分可用",
    offline: "未连接",
    needs_login: "未登录",
    unconfigured: "未配置",
    unknown: "待确认",
    timeout: "检查超时",
    error: "检查失败"
  };
  if (scan.health) return labels[scan.health.state];
  const required = scan.requirements?.filter(item => item.required) ?? [];
  if (required.some(item => item.ok === false)) return "缺配置";
  if (scan.endpoints?.length && scan.endpoints.every(endpoint => endpoint.healthy === false)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function scanConnectionColor(scan?: MessageAdapterScanResult): string {
  const label = scanConnectionLabel(scan);
  if (label === "可用" || label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描") return "secondary";
  if (label === "检查失败") return "error";
  return "warning";
}

function openScanCandidate(candidate: { url?: string; path?: string }): void {
  if (candidate.url) {
    openExternalUrl(candidate.url);
    return;
  }
  if (candidate.path) void copyText(candidate.path, "已复制本地路径");
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  let result = message;
  try {
    await copyTextToClipboard(text);
  } catch (error) {
    result = `复制失败：${userFacingError(error)}`;
  }
  copyResult.value = result;
  window.setTimeout(() => {
    if (copyResult.value === result) copyResult.value = "";
  }, 1800);
}

async function deleteCurrentGateway(): Promise<void> {
  if (!gateway.value || deletingGateway.value) return;
  const name = store.configNameFor(gateway.value);
  const confirmed = window.confirm(translateText(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`));
  if (!confirmed) return;
  deletingGateway.value = true;
  deleteError.value = "";
  try {
    await store.deleteGateway(gateway.value.id);
  } catch (error) {
    deleteError.value = userFacingError(error);
  } finally {
    deletingGateway.value = false;
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
    marvisOpenResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    openingMarvis.value = false;
  }
}

function renameCurrentConfig(value: unknown): void {
  if (!gateway.value) return;
  const result = store.renameGatewayConfig(gateway.value.id, value);
  configNameError.value = result.message || "";
}

const agentDefs: Array<{ type: AgentAdapterType; title: string; note: string; icon: string; hasCwd: boolean; hasThread: boolean }> = [
  { type: "grokBot", title: "Grok Bot", note: "由已有 Grok cloud 服务执行，复用当前账号的真实会话", icon: "mdi-cloud-outline", hasCwd: false, hasThread: true },
  { type: "codex",       title: "Codex Agent",    note: "消息由桌面任务执行并实时显示", icon: "mdi-monitor-dashboard", hasCwd: true, hasThread: true },
  { type: "copilotCli",  title: "Copilot CLI",   note: "通过 GitHub Copilot CLI 投递消息",  icon: "mdi-robot-outline", hasCwd: true, hasThread: true },
  { type: "marvis",      title: "Marvis",         note: "打开 Marvis 并复制 prompt（人工接力）", icon: "mdi-message-processing-outline", hasCwd: false, hasThread: false },
  { type: "astrbot",     title: "AstrBot",         note: "通过 AstrBot ChatUI / 机器人框架投递消息",    icon: "mdi-robot-happy-outline", hasCwd: false, hasThread: false },
  { type: "dsh",         title: "DSH（DeepSeek Harness 会话）", note: "通过 session.prompt API 投递到本机 DSH 会话", icon: "mdi-brain", hasCwd: true, hasThread: true },
  { type: "workbuddy",   title: "WorkBuddy（腾讯 AI 办公工作台）", note: "通过会话网关投递到本机 WorkBuddy 已有任务", icon: "mdi-briefcase-outline", hasCwd: true, hasThread: true },
  { type: "deviceAgent", title: "设备 Agent（实验）", note: "由已绑定设备执行；电脑仅负责消息投递和回执", icon: "mdi-glasses", hasCwd: false, hasThread: false },
  { type: "antigravity", title: "Antigravity（Google 的 Agent 开发环境）", note: "通过官方 agy agentapi 投递到本机 Antigravity 会话", icon: "mdi-rocket-launch-outline", hasCwd: true, hasThread: true },
];

/** Short display names for panels that name the bound session owner. Falls back to the manifest label so a newly registered adapter is never mislabelled as Codex. */
const agentShortLabels: Partial<Record<AgentAdapterType, string>> = {
  codex: "Codex Desktop",
  dsh: "DSH",
  workbuddy: "WorkBuddy",
  antigravity: "Antigravity",
  deviceAgent: "设备 Agent",
  grokBot: "Grok Bot 云端会话"
};

const addAgentMenu = ref(false);

const testingAstrbotLogin = ref(false);

const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);

const agentTypes = computed(() => gateway.value?.agentAdapters ?? []);

const visibleAgentItems = computed(() => agentDefs.filter(agent => agentTypes.value.includes(agent.type)).map(agent => ({ ...agent, title: `${agent.type === "grokBot" ? "云端" : "本机"} · ${agent.title}` })));

const remoteAgentItems = computed(() => (gateway.value?.remoteAgentTargets || []).map(target => {
  const instance = agentInstances.value.find(item => item.instanceId === target.instanceId && item.ownerDeviceId === target.ownerDeviceId);
  const agent = instance?.agents.find(item => item.agentId === target.agentId);
  const definition = agentDefs.find(item => item.type === target.provider);
  const agentLabel = agent?.name || (definition ? `${definition.title} · ${target.agentId}` : target.agentId);
  return { ...target, instance, agent, title: `远端 · ${instance ? `${agentInstanceDisplayName(instance)} / ` : ''}${agentLabel}（${instance?.address || target.instanceId}）` };
}));

const availableAgentsToAdd = computed(() => [
  ...agentDefs.filter(agent => agent.type !== "deviceAgent" && !agentTypes.value.includes(agent.type)).map(agent => ({ ...agent, key: localAgentTargetKey(agent.type), title: `${agent.type === "grokBot" ? "云端" : "本机"} · ${agent.title}`, nodeId: undefined as string | undefined, agentId: undefined as string | undefined, ownerDeviceId: undefined as string | undefined })),
  ...agentInstances.value.flatMap(instance => instance.agents.flatMap(remote => {
    if (instance.local && !instance.ownerDeviceId && remote.provider !== "deviceAgent") return [];
    const def = agentDefs.find(agent => agent.type === (remote.provider === "codex-desktop" ? "codex" : remote.provider));
    if (!def) return [];
    const key = remoteAgentTargetKey({ instanceId: instance.instanceId, agentId: remote.agentId, ownerDeviceId: instance.ownerDeviceId });
    if (remoteAgentItems.value.some(item => item.id === key)) return [];
    return [{ ...def, key, title: `远端 · ${agentInstanceDisplayName(instance)} / ${remote.name}（${instance.address || instance.instanceId}）`, nodeId: instance.instanceId, agentId: remote.agentId, ownerDeviceId: instance.ownerDeviceId }];
  }))
]);

const primaryAgent = computed(() => gateway.value ? resolvePrimaryAgentTarget(gateway.value) : undefined);

const primaryAgentType = computed(() => primaryAgent.value?.provider);

const primaryLocalAgentType = computed(() => primaryAgent.value?.binding ? undefined : primaryAgent.value?.provider);

const remoteAgentParamOpen = ref<Record<string, boolean>>({});

const primaryAgentItems = computed(() => [
  ...visibleAgentItems.value.map(agent => ({ title: agent.title, value: localAgentTargetKey(agent.type) })),
  ...remoteAgentItems.value.map(agent => ({ title: agent.title, value: agent.id }))
]);

const channelCheckAgentItems = computed(() => visibleAgentItems.value.map(agent => ({
  ...agent,
  primary: primaryLocalAgentType.value === agent.type
})));

function channelManagerConnectionLabel(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false ? "已禁用" : "已启用";
}

function channelManagerConnectionColor(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false ? "secondary" : "success";
}

function channelManagerDetail(): string {
  return gateway.value?.enabled === false || runtime.value.enabled === false
    ? "当前 Route 已禁用。"
    : "当前 Route 已启用。";
}

function channelAgentConnectionLabel(type: AgentAdapterType): string {
  const state = agentStateFor(type);
  if (state.deliveryHealthy === true) return "可投递";
  if (state.lastNotificationError) return "投递失败";
  if (state.bound === true) return "已绑定";
  return agentConnectionLabel(type);
}

function channelAgentConnectionColor(type: AgentAdapterType): string {
  const label = channelAgentConnectionLabel(type);
  if (["可投递", "已绑定", "已发现"].includes(label)) return "success";
  if (["扫描中", "未扫描"].includes(label)) return "secondary";
  if (["投递失败", "未安装"].includes(label)) return "error";
  return "warning";
}

function channelAgentDetail(type: AgentAdapterType): string {
  const state = agentStateFor(type);
  if (typeof state.message === "string" && state.message.trim()) return state.message;
  const scan = agentScanFor(type);
  if (scan?.auth?.message) return scan.auth.message;
  return agentDefs.find(agent => agent.type === type)?.note || "当前 Route 已添加的 Agent 端。";
}

function messageProcessingAgentPolicy(type: AgentAdapterType) {
  const policy = gateway.value?.messageProcessingAgents?.[type];
  return {
    enabled: policy?.enabled === true,
    model: policy?.model || (type === "codex" ? DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL : ""),
    reasoningEffort: policy?.reasoningEffort || DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT,
    maxAgents: policy?.maxAgents
  };
}

function supportsManagedTaskFeature(type: AgentAdapterType, feature: "messageProcessingAgent" | "memoryConsolidationAgent" | "planAssistantSessions" | "hooks"): boolean {
  return agentAdapterSupportsManagedTaskFeature(type, feature);
}

function setMessageProcessingAgentPolicy(type: AgentAdapterType, patch: Record<string, unknown>): void {
  if (!gateway.value) return;
  gateway.value.messageProcessingAgents = gateway.value.messageProcessingAgents ?? {};
  gateway.value.messageProcessingAgents[type] = {
    ...messageProcessingAgentPolicy(type),
    ...patch
  };
  store.touch();
}

function agentStateFor(type: AgentAdapterType): Record<string, any> {
  // Provider-only runtime state belongs to the selected owner, not every same-provider card.
  if (primaryAgent.value?.binding || primaryLocalAgentType.value !== type) return {};
  return runtime.value.agentStates?.[type] ?? {};
}

function codexDeliveryChannelLabel(state: Record<string, any>): string {
  if (state.lastDeliveryChannel === "desktop-ipc") return "Codex Desktop IPC";
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

function agentAuthLabel(type: AgentAdapterType): string {
  const loggedIn = agentScanFor(type)?.auth?.loggedIn;
  if (type === "grokBot" && loggedIn === undefined) return "尚未扫描";
  return loggedIn ? "已登录" : "未登录";
}

function agentConnectionLabel(type: AgentAdapterType): string {
  const scan = agentScanFor(type);
  if (!scan) return agentScan.value.loading ? "扫描中" : "未扫描";
  if (type === "grokBot" && scan.auth?.loggedIn === undefined) return "尚未扫描";
  if (scan.auth?.required && scan.auth.loggedIn === false) return "未登录";
  if (scan.plugins?.some(plugin => !plugin.installed)) return "插件缺失";
  if (scan.endpoints?.length && !scan.endpoints.some(endpoint => endpoint.healthy)) return "未连接";
  return scan.installed ? "已发现" : "未安装";
}

function agentConnectionColor(type: AgentAdapterType): string {
  const label = agentConnectionLabel(type);
  if (label === "已发现") return "success";
  if (label === "扫描中" || label === "未扫描" || label === "尚未扫描") return "secondary";
  if (label === "未登录" || label === "插件缺失" || label === "未连接") return "warning";
  return "error";
}

function currentAgentProject(type: AgentAdapterType): string {
  if (!gateway.value) return "";
  if (type === "copilotCli") return gateway.value.copilotCwd || "";
  if (type === "codex") return gateway.value.codexCwd || "";
  if (type === "dsh") return gateway.value.dshCwd || "";
  if (type === "workbuddy") return gateway.value.workbuddyCwd || "";
  if (type === "antigravity") return gateway.value.antigravityCwd || "";
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

function codexSessionItems(): Array<{ title: string; value: string }> {
  return codexThreadItems(codexThreadSummaries());
}

function codexThreadSummaries(): CodexThreadSummary[] {
  return agentSessions("codex")
    .filter(session => session.id)
    .map(session => ({
      id: session.id!,
      title: session.name,
      updatedAt: session.updatedAt,
      cwd: session.projectPath
    }));
}

function dshSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return agentSessions("dsh")
    .filter((session) => session.id)
    .filter((session) => !gateway.value?.dshCwd || !session.projectPath || samePath(session.projectPath, gateway.value.dshCwd))
    .map((session) => ({
      title: session.name,
      value: session.id!,
      subtitle: [session.projectPath, session.updatedAt].filter(Boolean).join(" · ")
    }));
}

function selectDshSession(value: unknown): void {
  if (!gateway.value) return;
  const raw = String(value || "").trim();
  const selected = agentSessions("dsh").find((session) => session.id === raw);
  if (selected?.id) {
    gateway.value.dshSessionId = selected.id;
    gateway.value.dshSessionName = selected.name;
    if (selected.projectPath) gateway.value.dshCwd = selected.projectPath;
  } else {
    gateway.value.dshSessionId = "";
    gateway.value.dshSessionName = raw;
  }
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

function workbuddySessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return agentSessions("workbuddy")
    .filter((session) => session.id)
    .filter((session) => !gateway.value?.workbuddyCwd || !session.projectPath || samePath(session.projectPath, gateway.value.workbuddyCwd))
    .map((session) => ({
      title: session.name,
      value: session.id!,
      subtitle: [
        session.projectPath,
        session.live === true ? "在线" : session.live === false ? "已离线" : undefined,
        session.updatedAt
      ].filter(Boolean).join(" · ")
    }));
}

function selectWorkbuddySession(value: unknown): void {
  if (!gateway.value) return;
  const raw = String(value || "").trim();
  const selected = agentSessions("workbuddy").find((session) => session.id === raw);
  if (selected?.id) {
    gateway.value.workbuddySessionId = selected.id;
    gateway.value.workbuddySessionName = selected.name;
    if (selected.projectPath) gateway.value.workbuddyCwd = selected.projectPath;
  } else {
    gateway.value.workbuddySessionId = "";
    gateway.value.workbuddySessionName = raw;
  }
  touch();
}

function antigravitySessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return agentSessions("antigravity")
    .filter((session) => session.id)
    .filter((session) => !gateway.value?.antigravityCwd || !session.projectPath || samePath(session.projectPath, gateway.value.antigravityCwd))
    .map((session) => ({
      title: session.name,
      value: session.id!,
      subtitle: [
        session.projectPath,
        session.live === true ? "宿主在线" : session.live === false ? "宿主未运行" : undefined,
        session.updatedAt
      ].filter(Boolean).join(" · ")
    }));
}

function selectAntigravitySession(value: unknown): void {
  if (!gateway.value) return;
  const raw = String(value || "").trim();
  const selected = agentSessions("antigravity").find((session) => session.id === raw);
  if (selected?.id) {
    gateway.value.antigravityConversationId = selected.id;
    gateway.value.antigravityConversationName = selected.name;
    if (selected.projectPath) gateway.value.antigravityCwd = selected.projectPath;
  } else {
    gateway.value.antigravityConversationId = "";
    gateway.value.antigravityConversationName = raw;
  }
  touch();
}

function managedAgentSessionContext(type: AgentAdapterType): {
  agentAdapter: "codex" | "dsh" | "workbuddy" | "antigravity";
  sessionId: string;
  sessionName: string;
  workspace: string;
  dshBaseUrl?: string;
} | null {
  if (!gateway.value || (type !== "codex" && type !== "dsh" && type !== "workbuddy" && type !== "antigravity")) return null;
  if (type === "dsh") {
    return {
      agentAdapter: "dsh",
      sessionId: String(gateway.value.dshSessionId || "").trim(),
      sessionName: String(gateway.value.dshSessionName || fallbackCodexThreadName()).trim(),
      workspace: String(gateway.value.dshCwd || "").trim(),
      dshBaseUrl: String(gateway.value.dshBaseUrl || "").trim() || undefined
    };
  }
  if (type === "workbuddy") {
    return {
      agentAdapter: "workbuddy",
      sessionId: String(gateway.value.workbuddySessionId || "").trim(),
      sessionName: String(gateway.value.workbuddySessionName || fallbackCodexThreadName()).trim(),
      workspace: String(gateway.value.workbuddyCwd || "").trim()
    };
  }
  if (type === "antigravity") {
    return {
      agentAdapter: "antigravity",
      sessionId: String(gateway.value.antigravityConversationId || "").trim(),
      sessionName: String(gateway.value.antigravityConversationName || fallbackCodexThreadName()).trim(),
      workspace: String(gateway.value.antigravityCwd || "").trim()
    };
  }
  return {
    agentAdapter: "codex",
    sessionId: String(gateway.value.codexThreadId || "").trim(),
    sessionName: String(gateway.value.codexThreadName || fallbackCodexThreadName()).trim(),
    workspace: String(gateway.value.codexCwd || "").trim()
  };
}

function managedAgentLabel(type: AgentAdapterType): string {
  return agentShortLabels[type] || agentAdapterManifest(type).label;
}

function hasManagedAgentSessionBinding(type: "codex" | "dsh"): boolean {
  const session = managedAgentSessionContext(type);
  return Boolean(session?.sessionId && session.workspace);
}

async function openManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (managedAgentSessionAction.value.loading) return;
  const session = managedAgentSessionContext(agentAdapter);
  if (!session?.sessionId || !session.workspace) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await postAgentThreadAction({
      action: "open",
      agentAdapter: session.agentAdapter,
      threadId: session.sessionId,
      cwd: session.workspace,
      ...(session.dshBaseUrl ? { dshBaseUrl: session.dshBaseUrl } : {})
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh" ? "已在 DSH 中定位主角色会话。" : "已在 Codex Desktop 中定位主角色任务。",
      error: ""
    };
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: userFacingError(error)
    };
  }
}

function selectCodexSession(value: unknown): void {
  if (!gateway.value) return;
  const selection = selectCodexThread(value, codexThreadSummaries());
  gateway.value.codexThreadId = selection.threadId;
  gateway.value.codexThreadName = selection.threadName;
  if (selection.selected?.cwd) gateway.value.codexCwd = selection.selected.cwd;
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

const hookUpdate = ref({ loading: false, message: "", error: "" });

async function updateHooksToAgent(type: AgentAdapterType): Promise<void> {
  if (hookUpdate.value.loading) return;
  hookUpdate.value = { loading: true, message: "", error: "" };
  try {
    const response = await fetch(`/api/agent-adapters/hooks/update?adapter=${encodeURIComponent(type)}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.message || "Hook 更新失败");
    hookUpdate.value.message = result.message;
  } catch (error) {
    hookUpdate.value.error = userFacingError(error);
  } finally {
    hookUpdate.value.loading = false;
  }
}

async function lookupCodexThreadBinding(): Promise<void> {
  if (!gateway.value || codexBinding.value.loading) return;
  const title = gateway.value.codexThreadName?.trim() || fallbackCodexThreadName();
  codexBinding.value = { loading: true, error: "", pending: false };
  try {
    const response = await fetch("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        threadId: gateway.value.codexThreadId || undefined,
        title,
        cwd: gateway.value.codexCwd || undefined,
        createIfMissing: false
      })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && body.resolution === "missing") {
      gateway.value.codexThreadId = "";
      codexBinding.value.pending = true;
      touch();
      return;
    }
    if (!response.ok || !body.thread?.id) {
      throw new Error(body.message || "无法查找 Codex Desktop 会话。");
    }
    gateway.value.codexThreadId = body.thread.id;
    gateway.value.codexThreadName = body.thread.title || title;
    if (body.thread.cwd) gateway.value.codexCwd = body.thread.cwd;
    touch();
  } catch (error) {
    codexBinding.value.error = userFacingError(error);
  } finally {
    codexBinding.value.loading = false;
  }
}

async function initializeManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (!gateway.value || managedAgentSessionAction.value.loading) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await initializeAgentSessionForRoute({
      agentAdapter,
      save: () => store.save(),
      currentGatewayId: () => gateway.value?.id || "",
      deliver: async ({ gatewayId, text }) => {
        const response = await fetch("/api/role-panel/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayId, text, attachments: [] })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.code !== 0) {
          throw new Error(body.message || "角色初始化消息投递失败。");
        }
      }
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh"
        ? "已保存名称 + 会话 ID，并通过 DSH owner 投递角色初始化消息。"
        : "已保存名称 + 线程 ID，并通过 Desktop owner 投递角色初始化消息。",
      error: ""
    };
    await store.load();
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: userFacingError(error)
    };
  }
}

function selectCopilotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.copilotThreadName = String(value || "");
  touch();
  const selected = agentSessions("copilotCli").find(session => session.name === gateway.value?.copilotThreadName);
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
  if (type === "copilotCli" && gateway.value?.copilotCwd && gateway.value.copilotThreadName) {
    const selected = agentSessions(type).find(session => session.name === gateway.value?.copilotThreadName);
    if (selected?.projectPath && !samePath(selected.projectPath, gateway.value.copilotCwd)) {
      warnings.push(`当前会话属于 ${selected.projectPath}，和工作目录不一致。`);
    }
  }
  return [...new Set(warnings)];
}

function addAgent(type: AgentAdapterType, nodeId?: string, agentId?: string, ownerDeviceId?: string): void {
  if (!gateway.value) return;
  if (type === "deviceAgent" && (!nodeId || !agentId)) return;
  addRouteAgent(gateway.value, type, nodeId, agentId, ownerDeviceId);
  if (nodeId && agentId) {
    const targetId = remoteAgentTargetKey({ instanceId: nodeId, agentId, ownerDeviceId });
    if (ownerDeviceId) {
      const agent = agentInstances.value.find(item => item.instanceId === nodeId && item.ownerDeviceId === ownerDeviceId)?.agents.find(item => item.agentId === agentId);
      if (agent?.sessionId) selectPeerRouteSession(gateway.value, targetId, { sessionId: agent.sessionId, sessionName: agent.name, workspace: agent.workspace });
    }
    remoteAgentParamOpen.value[targetId] = true;
    store.touch();
    return;
  }
  agentParamOpen.value[type] = true;
  if (supportsManagedTaskFeature(type, "hooks") && !gateway.value.codexHooks) {
    gateway.value.codexHooks = { ...DEFAULT_CODEX_HOOK_SETTINGS };
  }
  if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  store.touch();
}

async function postAgentThreadAction(payload: Record<string, unknown>, target?: ReturnType<typeof resolvePrimaryAgentTarget>): Promise<Record<string, any>> {
  return postRouteAgentThreadAction(payload, target, { accessToken: managerAccessToken });
}

async function initializePlanAssistants(): Promise<void> {
  if (!gateway.value || codexPlanAssistants.value.loading) return;
  const gatewayId = gateway.value.id;
  const target = primaryAgent.value;
  const assertSelection = routeAgentOperationGuard(gatewayId, target?.id || "", () => ({ gatewayId: gateway.value?.id, targetId: primaryAgent.value?.id }));
  const originalGateway = () => {
    const original = store.gateways.find(item => item.id === gatewayId);
    if (!original) throw new Error("原路线已被移除，已停止秘书初始化。");
    return original;
  };
  codexPlanAssistants.value = {
    count: normalizeCodexPlanAssistantCount(codexPlanAssistants.value.count),
    loading: true,
    message: "",
    error: ""
  };
  try {
    if (!String(gateway.value.agentRoleId || "").trim()) {
      throw new Error("请先为当前 Route 绑定角色，再初始化计划协助会话。");
    }
    if (!target) throw new Error("请先选择主控 Agent。");
    assertSelection();
    await store.save(gatewayId);
    assertSelection();
    const current = originalGateway();
    const remote = target.binding ? remoteAgentItems.value.find(item => item.id === target.id) : undefined;
    if (target.binding && (!remote?.instance?.connected || !remote.agent)) throw new Error("当前远端主控不可用，未创建秘书任务。");
    const rawSource = remote?.agent
      ? { agentAdapter: target.provider, sessionId: remote.agent.sessionId || "", sessionName: remote.agent.name, workspace: remote.agent.workspace || "", dshBaseUrl: remote.agent.dshBaseUrl }
      : managedAgentSessionContext(target.provider);
    if (rawSource && rawSource.agentAdapter !== "codex" && rawSource.agentAdapter !== "dsh") {
      throw new Error(`计划协助会话当前仅支持 Codex 与 DSH 主角色，${managedAgentLabel(rawSource.agentAdapter)} 尚未适配。`);
    }
    const source = rawSource
      ? { ...rawSource, agentAdapter: rawSource.agentAdapter === "dsh" ? "dsh" as const : "codex" as const }
      : null;
    if (!source?.sessionId || !source.workspace) {
      throw new Error(`主 ${managedAgentLabel(primaryAgentType.value || "codex")} 会话尚未完成名称 + ID + workspace 绑定。`);
    }
    const count = normalizeCodexPlanAssistantCount(codexPlanAssistants.value.count);
    const sourceRead = await postAgentThreadAction({
      action: "read",
      agentAdapter: source.agentAdapter,
      threadId: source.sessionId,
      ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
    }, target);
    assertSelection();
    const sourceThreadName = String(source.agentAdapter === "codex"
      ? sourceRead.thread?.name
      : sourceRead.thread?.name || sourceRead.thread?.title || source.sessionName || fallbackCodexThreadName()).trim();
    if (!sourceThreadName) {
      throw new Error("无法读取 Codex 侧栏显示的 Name，未创建计划秘书 Agent。");
    }
    const titles = codexPlanAssistantSessionTitles(sourceThreadName, count);
    const existing = filterCodexPlanAssistantSessionsForTarget(current.codexPlanAssistantSessions, target.id)
      .filter((session) => planAssistantSessionAgentAdapter(session) === source.agentAdapter);
    const resolved = [] as NonNullable<typeof current.codexPlanAssistantSessions>;

    for (let index = 0; index < titles.length; index += 1) {
      assertSelection();
      const desiredTitle = titles[index];
      const previous = existing[index];
      const result = await postAgentThreadAction({
        action: "resolve",
        agentAdapter: source.agentAdapter,
        threadId: previous?.threadId,
        title: desiredTitle,
        cwd: previous?.workspace || source.workspace,
        createIfMissing: true,
        lookupMode: "state_db",
        ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
      }, target);
      const thread = result.thread;
      if (!thread?.id) throw new Error(`计划协助会话 ${index + 1} 没有返回完整任务 ID。`);
      resolved.push({
        agentTargetId: target.id,
        ...(source.agentAdapter === "dsh" ? { agentAdapter: "dsh" as const } : {}),
        threadId: thread.id,
        threadName: thread.title || desiredTitle,
        workspace: thread.cwd || previous?.workspace || source.workspace,
        index: index + 1,
        initializedAt: previous?.threadId === thread.id ? previous.initializedAt : undefined
      });
      // Retain a completed creation in the captured route draft even if the user switched while awaiting it.
      const original = originalGateway();
      original.codexPlanAssistantSessions = [...(original.codexPlanAssistantSessions || []).filter(session => session.agentTargetId !== target.id), ...resolved, ...existing.slice(index + 1)];
      assertSelection();
    }

    assertSelection();
    originalGateway().codexPlanAssistantSessions = [...(originalGateway().codexPlanAssistantSessions || []).filter(session => session.agentTargetId !== target.id), ...resolved];
    touch();
    await store.save(gatewayId);
    assertSelection();

    for (const session of resolved) {
      assertSelection();
      if (session.initializedAt) continue;
      await postAgentThreadAction({
        action: "send",
        agentAdapter: source.agentAdapter,
        threadId: session.threadId,
        cwd: session.workspace,
        sandbox: "workspace-write",
        model: current.codexPlanAssistantModel || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL,
        prompt: codexPlanAssistantInitializationPrompt({
          roleId: current.agentRoleId || "",
          sourceAgentAdapter: source.agentAdapter,
          assistantAgentAdapter: source.agentAdapter,
          sourceThreadId: source.sessionId,
          sourceThreadName,
          assistantThreadId: session.threadId,
          assistantThreadName: session.threadName,
          workspace: session.workspace,
          managerBaseUrl: window.location.origin,
          count,
          index: session.index
        }),
        messageSource: {
          type: "agent",
          agentAdapter: source.agentAdapter,
          agentType: "primary_persona",
          sessionId: source.sessionId,
          sessionName: sourceThreadName,
          workspace: source.workspace
        },
        sourceThreadId: source.sessionId,
        sourceAgentType: "primary_persona",
        responsePolicy: "none",
        ...(source.dshBaseUrl ? { dshBaseUrl: source.dshBaseUrl } : {})
      }, target);
      session.initializedAt = new Date().toISOString();
      const bound = originalGateway().codexPlanAssistantSessions?.find(item => item.agentTargetId === target.id && item.threadId === session.threadId);
      if (bound) bound.initializedAt = session.initializedAt;
      assertSelection();
      touch();
      await store.save(gatewayId);
      assertSelection();
    }
    const detached = Math.max(0, existing.length - resolved.length);
    codexPlanAssistants.value = {
      count,
      loading: false,
      message: `已绑定 ${resolved.length} 个持久计划协助会话${detached ? `；另有 ${detached} 个旧会话已从 Route 解绑但未删除` : ""}。`,
      error: ""
    };
    await store.load();
  } catch (error) {
    codexPlanAssistants.value = {
      ...codexPlanAssistants.value,
      loading: false,
      message: "",
      error: userFacingError(error)
    };
  }
}

function removeAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  removeRouteAgent(gateway.value, localAgentTargetKey(type));
  agentParamOpen.value[type] = false;
  store.touch();
}

function removeRemoteAgent(targetId: string): void {
  if (!gateway.value) return;
  removeRouteAgent(gateway.value, targetId);
  delete remoteAgentParamOpen.value[targetId];
  store.touch();
}

function selectPrimaryAgent(value: unknown): void {
  if (!gateway.value || typeof value !== "string") return;
  selectRouteAgent(gateway.value, value);
  store.touch();
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
  } catch (e: unknown) {
    astrbotLoginResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    testingAstrbotLogin.value = false;
  }
}

function toggleAgentParams(type: AgentAdapterType): void {
  const nextOpen = !agentParamOpen.value[type];
  agentParamOpen.value[type] = nextOpen;
  if (nextOpen) {
    if (type === "copilotCli" && copilotStatus.value === null) void fetchCopilotStatus();
  }
}

// Only an explicit edit of the current config name changes its URL here.
// Ordinary navigation and browser history are synchronized by App.
watch(() => gateway.value?.configName, (name, previousName) => {
  configNameError.value = "";
  if (!props.embedded && previousName && route.params.id === previousName && name && name !== previousName) {
    void router.replace({ path: routeScopedAdaptersPath(name), query: route.query, hash: route.hash });
  }
});

watch(() => gateway.value?.id, () => {
  adapterLifecycleRevision.value = {};
  adapterActionBusy.value = {};
  grokBotScan.state.queryDraft = "";
  grokBotSelectionError.value = "";
  codexPlanAssistants.value = {
    count: Math.max(1, gateway.value?.codexPlanAssistantSessions?.length || 1),
    loading: false,
    message: "",
    error: ""
  };
}, { immediate: true });
</script>
<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h2 v-if="embedded" class="section-title">消息路由</h2>
        <h1 v-else class="page-title">消息</h1>
        <div class="page-subtitle">配置消息端和 Agent 端。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-switch v-model="gateway.enabled" label="是否启用" color="success" inset hide-details @update:model-value="touch" />
        <v-btn prepend-icon="mdi-connection" color="secondary" variant="tonal" :loading="messageAdapterScan.loading && channelCheckDialogOpen" @click="openChannelCheckDialog">
          通道检查
        </v-btn>
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
      <RoleBindingEditor v-if="!embedded" />
      <div class="status-row mb-4" style="gap:8px">
        <span class="route-config-muted-label">配置名</span>
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
                      :loading="adapterActionBusy[choice.type]"
                      :disabled="!choice.available || adapterActionBusy[choice.type]"

                      @update:model-value="value => void setAdapterEnabled(choice.type, value)"
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
                <div v-show="adapterParamOpen[choice.type]" class="catalog-param-panel">

                  <MessageEndpointCardHost
                    :renderers="settingsRenderersForMessageEndpoint(choice.type)"
                    :context="{ messageEndpointType: choice.type, routeId: gateway?.id ?? '', scan: messageScanFor(choice.type), scanError: messageAdapterScan.error, scanLoading: messageAdapterScan.loading, refreshScan: runMessageAdapterScan }"
                    :active="adapterParamOpen[choice.type]"
                    :enabled="!isAdapterDisabled(gateway, choice.type)"
                    :lifecycle-revision="adapterLifecycleRevision[choice.type] || 0"
                    @busy="value => adapterActionBusy[choice.type] = value"
                  />
                  <div v-if="choice.available && usesAutomaticMessageGrouping(choice.type)" class="dependency-panel mb-3">
                    <div class="section-title small-title">消息组等待</div>
                    <div class="section-note">聊天消息默认使用消息组，不需要单独开启。这里仅调整等待一句话说完的时间。</div>
                    <v-alert type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                      主控选择 Codex 且开启消息处理模式后，聊天消息会先立即记录，再按这些参数合并。ASR、心跳和结构化事件不在这里等待。
                    </v-alert>
                    <div class="catalog-param-grid mt-2">
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.settleSeconds"
                        label="普通停顿（秒）"
                        hint="连续片段在这段时间内到达时先合并。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { settleSeconds: Number(value) })"
                      />
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.incompleteSettleSeconds"
                        label="未说完等待（秒）"
                        hint="“还有、然后、这个”等明显未说完的片段使用更长等待。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { incompleteSettleSeconds: Number(value) })"
                      />
                      <v-text-field
                        type="number"
                        :min="1"
                        :max="300"
                        :model-value="messageGroupingPolicy(choice.type)?.maxWaitSeconds"
                        label="最长等待（秒）"
                        hint="达到上限后先形成消息组；半小时后的相关消息仍可依靠回复关系和历史摘要续接。"
                        persistent-hint
                        @update:model-value="value => setMessageGroupingPolicy(choice.type, { maxWaitSeconds: Number(value) })"
                      />
                    </div>
                  </div>
                  <div v-if="choice.available && !isNonMessageEndpoint(choice.type)" class="dependency-panel mb-3">
                    <div class="section-title small-title">发送前聊天核对</div>
                    <v-switch :model-value="conversationReviewPolicy(choice.type)?.enabled === true"
                      label="发送前要求核对聊天记录" hide-details
                      @update:model-value="value => setConversationReviewEnabled(choice.type, value)" />
                    <div class="section-note">默认关闭，发送不等待聊天记录。开启后，已读索引落后或缺失时返回聊天记录供 Agent 确认；可随时关闭。</div>
                    <div v-if="conversationReviewPolicy(choice.type)?.enabled" class="catalog-param-grid mt-2">
                      <v-text-field type="number" :min="1" :max="500"
                        :model-value="conversationReviewPolicy(choice.type)?.initialMessageCount"
                        label="首次核对消息数" hint="没有已读索引时返回最近消息，默认 50 条。" persistent-hint
                        @update:model-value="value => setConversationReviewPolicy(choice.type, 'initialMessageCount', value)" />
                      <v-text-field type="number" :min="2" :max="500"
                        :model-value="conversationReviewPolicy(choice.type)?.maxIncrementalMessages"
                        label="增量返回上限" hint="默认 100 条；超过时返回最早和最新各半，并提示省略数量和搜索范围。" persistent-hint
                        @update:model-value="value => setConversationReviewPolicy(choice.type, 'maxIncrementalMessages', value)" />
                    </div>
                  </div>

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
                :title="endpointCatalog.find(item => item.type === type)?.title || type"
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

        <div v-if="primaryAgentItems.length" class="catalog-param-grid mb-4">
          <v-select
            class="full-span"
            :model-value="gateway.primaryAgentTarget || null"
            :items="primaryAgentItems"
            item-title="title"
            item-value="value"
            label="主控 Agent"
            placeholder="请选择负责接收消息的 Agent"
            hint="命中规则的消息只投递给主控 Agent；其他 Agent 保留配置，不会收到默认消息。"
            persistent-hint
            @update:model-value="selectPrimaryAgent"
          />
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
                      <div class="section-note">{{ agent.type === 'grokBot' ? "确认当前 Grok Bot 账号与云端会话；服务负责实际执行。" : "先确认处理端是否安装、登录、插件可用，以及能否读取项目和会话。" }}</div>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-chip size="small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                        {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                      </v-chip>
                      <v-chip size="small" :color="agentConnectionColor(agent.type)" variant="tonal">
                        {{ agentConnectionLabel(agent.type) }}
                      </v-chip>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agent.type === 'grokBot' ? grokBotScan.state.loading : agent.type === 'dsh' ? dshScanLoading : agentScan.loading" @click="refreshAgentScan(agent.type)">
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
                      <v-chip size="x-small" :color="agentAuthLabel(agent.type) === '尚未扫描' ? 'secondary' : agentScanFor(agent.type)?.auth?.loggedIn ? 'success' : 'warning'" variant="tonal">
                        {{ agentAuthLabel(agent.type) }}
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
                      <v-chip size="x-small" :color="plugin.installed && plugin.healthy !== false ? 'success' : 'warning'" variant="tonal">
                        {{ !plugin.installed ? "缺插件" : plugin.healthy === false ? "未就绪" : "已加载" }}
                      </v-chip>
                      <div>
                        <strong>{{ plugin.name }}</strong>
                        <span>{{ plugin.version ? `版本：${plugin.version}` : "未读取到插件版本。" }}</span>
                        <span v-for="detail in plugin.details ?? []" :key="`${plugin.id}-${detail}`">{{ detail }}</span>
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
                  <div v-if="supportsManagedTaskFeature(agent.type, 'hooks')" class="mt-3">
                    <v-btn variant="tonal" prepend-icon="mdi-update" :loading="hookUpdate.loading" @click="updateHooksToAgent(agent.type)">更新 Hook 到 Agent</v-btn>
                    <div class="section-note mt-2">首次配置或更新时安装事件埋点。日常开关在“角色 → 自动化 → Agent Hook”管理。</div>
                    <v-alert v-if="hookUpdate.error" type="error" variant="tonal" density="compact">{{ hookUpdate.error }}</v-alert>
                    <v-alert v-else-if="hookUpdate.message" type="success" variant="tonal" density="compact">{{ hookUpdate.message }}</v-alert>
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
                <div v-if="supportsManagedTaskFeature(agent.type, 'messageProcessingAgent') && primaryLocalAgentType === agent.type" class="dependency-panel mb-3">
                  <div class="section-title-row compact-row">
                    <div>
                      <div class="section-title small-title">消息处理 Agent 模式</div>
                      <div class="section-note">这里配置消息处理 Agent 的模型和运行参数。消息投给谁由角色自动化规则决定。</div>
                    </div>

                  </div>
                  <v-alert type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                    自动化选择“消息处理 Agent”后，使用这里配置的消息池。选择其他目标的规则不受影响。
                  </v-alert>
                  <div class="catalog-param-grid mt-2">
                    <v-text-field
                      :model-value="messageProcessingAgentPolicy(agent.type).model"
                      label="消息处理模型"
                      hint="默认使用 GPT-5.6 Luna；只影响消息处理 Agent 的新轮次。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { model: String(value || DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL) })"
                    />
                    <v-select
                      :model-value="messageProcessingAgentPolicy(agent.type).reasoningEffort"
                      :items="['low', 'medium', 'high', 'xhigh', 'max']"
                      label="推理强度"
                      hint="默认 medium；同一消息组的后续补充沿用已开始的轮次。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { reasoningEffort: value })"
                    />
                    <v-text-field
                      :model-value="messageProcessingAgentPolicy(agent.type).maxAgents"
                      type="number"
                      min="1"
                      :max="MAX_MESSAGE_PROCESSING_AGENTS"
                      label="消息处理 Agent 上限"
                      hint="Agent 列表统一按消息引用、消息组、会话、说话人和最近使用时间加权排序；上限保留排序后的前 N 个。设置为 1 时，所有新消息和未完成后续都集中到“协助处理消息1”。"
                      persistent-hint
                      @update:model-value="value => setMessageProcessingAgentPolicy(agent.type, { maxAgents: value === '' || value == null ? undefined : Number(value) })"
                    />
                  </div>
                  <v-btn

                    class="mt-3"
                    variant="tonal"
                    prepend-icon="mdi-view-dashboard-outline"
                    @click="messageProcessingBoardOpen = true"
                  >
                    打开消息处理看板
                  </v-btn>
                  <v-dialog v-model="messageProcessingBoardOpen" max-width="1200" scrollable>
                    <v-card>
                      <v-card-title class="d-flex align-center justify-space-between">
                        <span>消息处理看板</span>
                        <v-btn icon="mdi-close" variant="text" size="small" title="关闭" @click="messageProcessingBoardOpen = false" />
                      </v-card-title>
                      <v-card-text>
                        <MessageProcessingBoard
                          v-if="messageProcessingBoardOpen"
                          :gateway-id="gateway.id"
                          :enabled="true"
                        />
                      </v-card-text>
                    </v-card>
                  </v-dialog>
                </div>
                <!-- Codex -->
                <template v-if="agent.type === 'codex'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    实际消息只交给 Codex/ChatGPT Desktop 当前任务执行，因此桌面端会立即显示消息并沿用该任务的工具、模型与权限。Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      :model-value="gateway.agentModel"
                      :items="codexModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主角色模型"
                      hint="Desktop 可用时读取当前账号的模型目录；读取失败时仍可手动输入。留空则沿用目标任务自己的模型。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectCodexModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-select
                      v-model="gateway.agentReasoningEffort"
                      :items="codexReasoningEffortItems"
                      label="主角色推理强度"
                      hint="与主角色模型一起应用到 Desktop 新轮次；留空时沿用 Desktop 当前设置。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codex')" label="工作目录" placeholder="留空，使用 RabiRoute 根目录" hint="用于同名任务的自动查找和新建；选择已有任务时会自动采用任务自己的目录" persistent-hint @update:model-value="touch">
                    </v-combobox>
                    <v-combobox :model-value="gateway.codexThreadId || gateway.codexThreadName" :items="codexSessionItems()" item-title="title" item-value="value" :return-object="false" label="会话名 + 最后会话时间" placeholder="选择已有会话，或输入新会话名" hint="每次读取 200 个 Desktop 任务且不显示 ID；可继续加载，输入名称后只查找，唯一匹配就绑定，没有匹配则在点击保存时创建" persistent-hint @update:model-value="selectCodexSession" @blur="lookupCodexThreadBinding">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading || codexBinding.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="codexSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-btn
                      v-if="agentScanFor('codex')?.sessionPage?.hasMore"
                      size="small"
                      variant="text"
                      prepend-icon="mdi-chevron-down"
                      :loading="agentScan.loading"
                      @click="loadMoreCodexSessions"
                    >
                      加载更多 Desktop 任务
                    </v-btn>
                  </div>
                  <div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('codex')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('codex')"
                    >
                      定位会话
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-account-sync-outline"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="initializeManagedAgentSession('codex')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 Desktop 任务；未绑定时可初始化会话。</span>
                  </div>
                  <v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert>
                  <v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert>
                  <v-alert v-if="codexBinding.error" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ codexBinding.error }}
                  </v-alert>
                  <v-alert v-else-if="codexBinding.pending" type="info" variant="tonal" density="compact" class="mt-2 mb-1">
                    尚无同名 Desktop 会话；点击保存时会创建任务、写入完整 ID 并切换绑定。
                  </v-alert>
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
                    <div class="status-row"><span>投递协议</span><b>{{ codexDeliveryChannelLabel(agentStateFor('codex')) }}</b></div>
                    <div class="status-row"><span>桌面宿主</span><b>Codex/ChatGPT Desktop（必需）</b></div>
                  </template>
                </template>
                <!-- Grok Bot -->
                <template v-else-if="agent.type === 'grokBot'">
                  <div class="section-note mb-3">先启动并登录 Grok Bot，登录状态会自动读取。</div>
                  <div class="status-row mb-3">
                    <span>登录资料目录</span>
                    <code class="text-break">{{ agentScanFor('grokBot')?.profilePath || '等待 Grok Bot 启动' }}</code>
                  </div>
                  <v-autocomplete
                    :model-value="gateway.grokBotAgentId || null"
                    :items="grokBotPersonaPickerItems(grokBotScan.state.result)"
                    item-title="title"
                    item-value="value"
                    :disabled="grokBotScan.state.loading || !agentScanFor('grokBot')?.auth?.loggedIn"
                    label="主角色 Bot"
                    hint="使用所选 Bot 的默认主会话。"
                    persistent-hint
                    clearable
                    @update:model-value="selectGrokBotPersona"
                  />
                  <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" class="mt-2"
                    :loading="grokBotScan.state.loading" @click="runGrokBotAgentScan">刷新 Grok Bot</v-btn>
                  <v-alert v-if="grokBotScan.state.error || grokBotSelectionError" type="error" variant="tonal" density="compact" class="mt-2">
                    {{ grokBotScan.state.error || grokBotSelectionError }}
                  </v-alert>
                  <v-alert v-else-if="grokBotScan.state.result?.auth?.loggedIn && !grokBotPersonaPickerItems(grokBotScan.state.result).length"
                    type="info" variant="tonal" density="compact" class="mt-2">当前账号没有可选 Bot，请先在 Grok Bot 中创建。</v-alert>
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
                    <v-combobox v-model="gateway.copilotThreadName" :items="sessionNamesFor('copilotCli')" label="会话线程名" placeholder="Rabi" hint="Copilot CLI session 名称（--name 参数）" persistent-hint @update:model-value="selectCopilotSession">
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
                <template v-else-if="agent.type === 'dsh'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过 DSH apiproxy 发现、创建、重命名、绑定和续投会话。实际消息由同一个 DSH session owner 执行；失败时不会改投 Codex。
                  </v-alert>
                  <DshConnectionPanel :base-url="gateway.dshBaseUrl" @update:base-url="gateway.dshBaseUrl = $event; touch()" />
                  <div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.dshAgentPreset"
                      :items="agentScanFor('dsh')?.agentPresets?.filter(preset => !preset.broken).map(preset => ({ title: preset.name || preset.id, value: preset.id })) ?? []"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="会话模式"
                      hint="保存时同步到 DSH。已有对话的会话不能切换模式，请选择新会话；留空沿用当前模式。"
                      persistent-hint
                      clearable
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.dshBaseUrl"
                      :items="agentScanFor('dsh')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="DSH 地址"
                      hint="留空时按本机 DSH 启动日志自动发现；写死的默认端口不是安装状态。修改地址后请重新验证连接，再扫描会话。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="按当前地址扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="configuredDshModelValue"
                      :items="dshModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主角色模型"
                      placeholder="provider/model"
                      hint="DSH 可用时读取模型目录；读取失败时可手动输入 provider/model。配置会在主角色下一次投递前应用到绑定会话。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectDshModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      v-model="gateway.dshReasoningEffort"
                      :items="dshReasoningEffortItems"
                      label="主角色推理强度"
                      hint="优先显示所选 DSH 模型支持的值；目录不可用时可以手动输入。留空则沿用模型或 DSH 当前默认值。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.dshCwd"
                      :items="agentProjectItems('dsh')"
                      label="工作目录"
                      placeholder="C:/Path/To/Project"
                      hint="用于同名会话消歧和新建；选择已有会话时自动采用会话目录"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('dsh').length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="gateway.dshSessionId || gateway.dshSessionName"
                      :items="dshSessionItems()"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="DSH 会话"
                      placeholder="选择已有会话，或输入新会话名"
                      hint="选择后保存完整 ID、名称和工作目录；输入新名称会清空旧 ID，保存时查找或只创建一次"
                      persistent-hint
                      @update:model-value="selectDshSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="dshSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-btn
                      v-if="agentScanFor('dsh')?.sessionPage?.hasMore"
                      size="small"
                      variant="text"
                      prepend-icon="mdi-chevron-down"
                      :loading="dshScanLoading"
                      @click="loadMoreDshSessions"
                    >
                      加载更多 DSH 会话
                    </v-btn>
                  </div>
                  <div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('dsh')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('dsh')"
                    >
                      定位会话
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-account-sync-outline"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="initializeManagedAgentSession('dsh')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 DSH 会话；未绑定时可初始化会话。</span>
                  </div>
                  <v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert>
                  <v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert>
                  <div class="mt-2">
                    <div class="status-row">
                      <span>会话发现</span>
                      <b :class="dshSessionItems().length ? 'text-success' : 'text-warning'">{{ dshSessionItems().length ? `可选 ${dshSessionItems().length} 个` : '未读取到会话' }}</b>
                    </div>
                    <div class="status-row">
                      <span>项目发现</span>
                      <b :class="agentProjectItems('dsh').length ? 'text-success' : 'text-warning'">{{ agentProjectItems('dsh').length ? `可选 ${agentProjectItems('dsh').length} 个` : '未读取到项目目录' }}</b>
                    </div>
                    <div class="status-row">
                      <span>投递协议</span>
                      <b>session.prompt · mode=queue</b>
                    </div>
                  </div>
                </template>
                <template v-else-if="agent.type === 'workbuddy'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过会话网关投递到本机 WorkBuddy 的<b>已有任务</b>：任务 ID 就是路由键，同一任务续投不会新建任务，消息由该任务的 WorkBuddy owner 执行。
                  </v-alert>
                  <v-alert type="warning" variant="tonal" density="compact" class="mb-2">
                    需要一次性录入本机网关凭据（<code>data/workbuddy-auth.json</code>）。凭据缺失、任务所属进程已退出或任务 ID 已归档时会明确失败，不会改投其它 Agent。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      :model-value="gateway.workbuddySessionId || gateway.workbuddySessionName"
                      :items="workbuddySessionItems()"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="WorkBuddy 任务"
                      placeholder="选择已有任务，或输入任务名称"
                      hint="选择后保存完整任务 ID、名称和工作目录；同一任务续投不会新建任务"
                      persistent-hint
                      @update:model-value="selectWorkbuddySession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描任务" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.workbuddySessionName"
                      label="任务名称"
                      hint="用于界面显示；任务 ID 为空时按名称查找"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.workbuddyCwd"
                      :items="agentProjectItems('workbuddy')"
                      label="工作目录"
                      placeholder="C:/Path/To/Project"
                      hint="用于消歧同名任务；选择已有任务时自动采用任务目录"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('workbuddy').length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.workbuddyEndpoint"
                      label="上次网关地址"
                      placeholder="http://127.0.0.1:0000"
                      hint="留空则从存活会话实时发现；端口每次启动都会变，不建议长期固定"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="touch"
                    />
                  </div>
                  <div class="mt-2">
                    <div class="status-row">
                      <span>WorkBuddy 连接</span>
                      <b :class="`text-${agentConnectionColor('workbuddy')}`">{{ agentConnectionLabel('workbuddy') }}</b>
                    </div>
                    <div class="status-row">
                      <span>任务发现</span>
                      <b :class="workbuddySessionItems().length ? 'text-success' : 'text-warning'">{{ workbuddySessionItems().length ? `可选 ${workbuddySessionItems().length} 个` : '未读取到任务' }}</b>
                    </div>
                    <div class="status-row">
                      <span>投递协议</span>
                      <b>会话网关 · 同 ID 续投</b>
                    </div>
                  </div>
                </template>
                <template v-else-if="agent.type === 'antigravity'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过 Antigravity 官方 <code>agy agentapi</code> 投递到本机<b>已有会话</b>：会话 ID 就是路由键，同一会话续投不会新建会话。
                  </v-alert>
                  <v-alert type="warning" variant="tonal" density="compact" class="mb-2">
                    需要 Antigravity 桌面正在运行：language server 端口按进程动态发现，CSRF 令牌从桌面启动日志读取，均无需手工填写。会话 ID 留空时每次投递都会新开会话。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      :model-value="gateway.antigravityConversationId || gateway.antigravityConversationName"
                      :items="antigravitySessionItems()"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="Antigravity 会话"
                      placeholder="选择已有会话，或输入会话名称"
                      hint="选择后保存完整会话 ID 和名称；同一会话续投不会新建会话"
                      persistent-hint
                      @update:model-value="selectAntigravitySession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描会话" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.antigravityConversationName"
                      label="会话名称"
                      hint="用于界面显示；会话 ID 为空时按名称查找"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.antigravityCwd"
                      :items="agentProjectItems('antigravity')"
                      label="工作目录"
                      placeholder="C:/Path/To/Project"
                      hint="用于消歧同名会话；选择已有会话时自动采用会话目录"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('antigravity').length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                  </div>
                  <div class="mt-2">
                    <div class="status-row">
                      <span>Antigravity 连接</span>
                      <b :class="`text-${agentConnectionColor('antigravity')}`">{{ agentConnectionLabel('antigravity') }}</b>
                    </div>
                    <div class="status-row">
                      <span>会话发现</span>
                      <b :class="antigravitySessionItems().length ? 'text-success' : 'text-warning'">{{ antigravitySessionItems().length ? `可选 ${antigravitySessionItems().length} 个` : '未读取到 Antigravity 会话' }}</b>
                    </div>
                    <div class="status-row">
                      <span>投递协议</span>
                      <b>agy agentapi · 同 ID 续投</b>
                    </div>
                  </div>
                </template>
                <template v-else-if="agent.type === 'astrbot'">
                  <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    AstrBot 必须绑定 ChatUI 项目和会话；消息只通过 /api/chat/send 投递。
                  </v-alert>
                  <div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot ChatUI 地址；消息只通过 /api/chat/send 投递"
                      persistent-hint
                      @update:model-value="touch"
                    >
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
                      hint="选择后消息通过 /api/chat/send 投递；未选择时不可用"
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
                </template>
                  <div v-if="primaryLocalAgentType === agent.type && supportsManagedTaskFeature(agent.type, 'memoryConsolidationAgent')" class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">独立记忆整理 Agent</div>
                        <div class="section-note">这里配置记忆整理 Agent 的模型；消息去向在角色自动化中选择。</div>
                      </div>

                    </div>
                    <v-alert type="info" variant="tonal" density="compact" class="mt-2 mb-2">自动化选择“记忆整理 Agent”后，创建或复用已配置的整理会话。投递失败会保留具体错误。</v-alert>
                    <div class="catalog-param-grid mt-2">
                      <v-text-field
                        v-if="agent.type === 'codex'"
                        :model-value="gateway.codexMemoryConsolidationAgentModel || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL"
                        label="记忆整理模型"
                        hint="默认使用 GPT-5.6 Terra；只影响独立记忆整理 Agent 的新轮次。"
                        persistent-hint
                        @update:model-value="value => { gateway.codexMemoryConsolidationAgentModel = String(value || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL); touch(); }"
                      />
                    </div>
                  </div>
                  <div v-if="primaryLocalAgentType === agent.type && supportsManagedTaskFeature(agent.type, 'planAssistantSessions')" class="dependency-panel mt-3">
                    <div class="section-title-row compact-row">
                      <div>
                        <div class="section-title small-title">计划协助会话</div>
                        <div class="section-note">持久秘书任务负责计划推进和结果汇总；全部秘书统一使用 Manager 配置的模型，并且不会随临时子 Agent 结束而失去 owner。</div>
                      </div>
                      <v-switch
                        color="primary"
                        density="compact"
                        hide-details
                        inset
                        :model-value="gateway.codexPlanAssistantEnabled === true"
                        @update:model-value="value => { gateway.codexPlanAssistantEnabled = value === true; touch(); }"
                      />
                    </div>
                    <v-alert v-if="gateway.codexPlanAssistantEnabled" :type="agent.type === 'dsh' ? 'success' : 'warning'" variant="tonal" density="compact" class="mt-2 mb-2">
                      <template v-if="agent.type === 'dsh'">
                        DSH 计划协助会话由当前选择的实例创建和复用。请刷新会话并核对任务名称、工作目录与实际回复。
                      </template>
                      <template v-else>
                        实验能力：代码和契约测试已覆盖精确 ID、命名与复用；仍需在真实 {{ managedAgentLabel(agent.type) }} 中确认多会话可见、同 ID 续投和工具 owner。
                      </template>
                    </v-alert>
                    <v-alert v-else type="info" variant="tonal" density="compact" class="mt-2 mb-0">
                      关闭后不再把计划交给秘书处理；已经绑定的秘书任务会保留，重新开启后继续复用。
                    </v-alert>
                    <div v-if="gateway.codexPlanAssistantEnabled" class="catalog-param-grid mt-2">
                      <v-text-field
                        v-if="agent.type === 'codex'"
                        :model-value="gateway.codexPlanAssistantModel || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL"
                        label="计划秘书模型"
                        hint="Manager 统一应用到当前 Route 的全部计划秘书；默认使用 GPT-5.6 Terra。"
                        persistent-hint
                        @update:model-value="value => { gateway.codexPlanAssistantModel = String(value || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL); touch(); }"
                      />
                      <v-text-field
                        v-model.number="codexPlanAssistants.count"
                        type="number"
                        :min="1"
                        :max="8"
                        :step="1"
                        label="协助会话数量"
                        hint="1 个时命名为“主会话名 协助处理计划”；多个时依次命名为“…计划1、…计划2”"
                        persistent-hint
                      />
                      <div class="d-flex align-center ga-2 flex-wrap">
                        <v-btn
                          color="secondary"
                          variant="tonal"
                          prepend-icon="mdi-account-multiple-plus-outline"
                          :loading="codexPlanAssistants.loading"
                          :disabled="codexPlanAssistants.loading"
                          @click="initializePlanAssistants"
                        >
                          创建 / 同步协助会话
                        </v-btn>
                      </div>
                    </div>
                    <div v-if="gateway.codexPlanAssistantEnabled && gateway.codexPlanAssistantSessions?.length" class="d-flex ga-2 flex-wrap mt-2">
                      <v-chip
                        v-for="session in filterCodexPlanAssistantSessionsForTarget(gateway.codexPlanAssistantSessions, localAgentTargetKey(agent.type))"
                        :key="session.threadId"
                        size="small"
                        variant="tonal"
                        color="secondary"
                        data-no-i18n
                      >
                        {{ session.threadName }}
                      </v-chip>
                    </div>
                    <v-alert v-if="codexPlanAssistants.error" type="error" variant="tonal" density="compact" class="mt-2 mb-0">
                      {{ codexPlanAssistants.error }}
                    </v-alert>
                    <v-alert v-else-if="codexPlanAssistants.message" type="success" variant="tonal" density="compact" class="mt-2 mb-0">
                      {{ codexPlanAssistants.message }}
                    </v-alert>
                  </div>

              </div>
            </v-expand-transition>
          </div>

          <div v-for="target in remoteAgentItems" :key="target.id" class="catalog-item">
            <div class="catalog-row active" @click="remoteAgentParamOpen[target.id] = !remoteAgentParamOpen[target.id]">
              <v-icon class="catalog-row-icon" color="secondary">mdi-monitor-dashboard</v-icon>
              <span class="catalog-row-main">
                <strong>{{ target.title }}</strong>
                <small>{{ target.provider === 'deviceAgent' ? '实验：由设备执行，所属电脑负责消息投递和回执' : '由这台远端电脑上的 Agent 处理消息' }}</small>
              </span>
              <div class="catalog-row-actions">
                <v-chip size="x-small" :color="target.provider !== 'deviceAgent' && target.instance?.connected && target.agent ? 'success' : 'warning'" variant="tonal">{{ target.provider === 'deviceAgent' ? '实验设备' : target.instance?.connected && target.agent ? '实例在线' : '暂不可用' }}</v-chip>
                <v-btn :icon="remoteAgentParamOpen[target.id] ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="small" variant="text" :title="remoteAgentParamOpen[target.id] ? '收起参数' : '展开参数'" @click.stop="remoteAgentParamOpen[target.id] = !remoteAgentParamOpen[target.id]" />
                <v-btn icon="mdi-close" size="small" variant="text" color="error" title="从此路线移除远端 Agent" @click.stop="removeRemoteAgent(target.id)" />
              </div>
            </div>
            <v-expand-transition>
              <div v-if="remoteAgentParamOpen[target.id]" class="catalog-param-panel">
                <v-alert v-if="target.provider === 'deviceAgent'" type="warning" variant="tonal">实验设备 Agent：角色在设备设置中绑定，模型和语音由设备宿主提供。设备未完成加载时消息保留原投递身份等待，不会改投电脑模型。真机唤醒与执行需另行验收。</v-alert>
                <PeerRouteAgentSettings v-else-if="target.ownerDeviceId" :key="`${gateway.id}:${target.id}`" :target="target" :agent="target.agent" :connected="!!target.instance?.connected" @selected="session => { selectPeerRouteSession(gateway, target.id, session); touch(); }" />
                <InstanceAgentSettings v-else-if="target.instance && target.agent" :key="target.id" :instance="target.instance" :agent="target.agent" @saved="refreshLanAgentNodes" />
                <v-alert v-else type="warning" variant="tonal">此远端 Agent 暂不可用，配置仍然保留，不会改投本机。请刷新实例列表。</v-alert>
                <v-btn class="mt-2" size="small" variant="text" prepend-icon="mdi-refresh" :loading="lanAgentLoading" @click="refreshLanAgentNodes">刷新实例列表</v-btn>
                <PrimaryAgentAdvancedSettings v-if="gateway.primaryAgentTarget === target.id && target.provider !== 'deviceAgent'" :gateway="gateway" :provider="target.provider" :target-title="target.title" :error="codexPlanAssistants.error" :notice="codexPlanAssistants.message" @change="touch">
                  <template #plan-actions>
                    <div v-if="gateway.codexPlanAssistantEnabled" class="catalog-param-grid">
                      <v-text-field v-model.number="codexPlanAssistants.count" type="number" :min="1" :max="8" label="协助会话数量" />
                      <v-btn :loading="codexPlanAssistants.loading" :disabled="codexPlanAssistants.loading || !target.instance?.connected || !target.agent" @click="initializePlanAssistants">创建 / 同步协助会话</v-btn>
                      <v-chip v-for="session in filterCodexPlanAssistantSessionsForTarget(gateway.codexPlanAssistantSessions, target.id)" :key="session.threadId">{{ session.threadName }}</v-chip>
                    </div>
                  </template>
                </PrimaryAgentAdvancedSettings>
              </div>
            </v-expand-transition>
          </div>
          <v-alert v-if="primaryAgentItems.length && !primaryAgent" type="warning" variant="tonal">尚未选择主控 Agent。请选择并保存后再投递消息。</v-alert>
          <v-alert v-if="lanAgentError" type="warning" variant="tonal">{{ lanAgentError }}</v-alert>
          <div v-if="visibleAgentItems.length === 0 && remoteAgentItems.length === 0" class="empty-state compact-empty">
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
                :key="agent.key"
                :title="agent.title"
                @click="addAgent(agent.type, agent.nodeId, agent.agentId, agent.ownerDeviceId)"
              />
            </v-list>
          </v-menu>
        </div>
      </v-card>
    </template>

    <v-dialog v-model="channelCheckDialogOpen" max-width="1180" scrollable>
      <v-card class="app-card channel-check-dialog">
        <v-card-title class="d-flex align-center ga-3">
          <v-icon color="secondary">mdi-connection</v-icon>
          <div>
            <div>通道检查</div>
            <div class="section-note">检查当前 Route 从消息端经过 Manager 到 Agent 端的完整链路。</div>
          </div>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" title="关闭" @click="channelCheckDialogOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            状态检查不会修改配置或触发登录。点击 Agent 节点的“投递测试”会发送一条带测试编号的真实消息，用于确认对应 Agent 是否收到。
          </v-alert>

          <div class="d-flex align-center ga-2 flex-wrap mb-4">
            <v-chip :color="channelCheckOverallColor()" variant="tonal">{{ channelCheckOverallLabel() }}</v-chip>
            <span v-if="messageAdapterScan.checkedAt" class="section-note">
              用时 {{ messageAdapterScan.durationMs }} ms
            </span>
          </div>

          <v-progress-linear v-if="messageAdapterScan.loading || agentScan.loading" indeterminate color="secondary" class="mb-4" />
          <v-alert v-if="messageAdapterScan.error" type="error" variant="tonal" density="compact" class="mb-4">
            {{ messageAdapterScan.error }}
          </v-alert>

          <div class="channel-topology" aria-label="消息端到 Agent 端的通道拓扑">
            <section class="channel-topology-column channel-topology-messages">
              <div class="channel-topology-heading">
                <v-icon size="18">mdi-message-processing-outline</v-icon>
                <span>消息端</span>
                <small>消息进入</small>
              </div>
              <button
                v-for="item in channelCheckItems"
                :key="item.type"
                type="button"
                class="channel-topology-node channel-topology-message-node"
                :data-tone="gateway && isAdapterDisabled(gateway, item.type) ? 'secondary' : scanConnectionColor(messageScanFor(item.type))"
                @click="openChannelCheckDetails(item.type)"
              >
                <v-icon class="channel-topology-node-icon">{{ item.icon }}</v-icon>
                <span class="channel-topology-node-main">
                  <strong>{{ item.title }}</strong>
                  <small>{{ channelCheckDetail(messageScanFor(item.type)) }}</small>
                </span>
                <span class="channel-topology-node-status">
                  <v-chip size="x-small" :color="gateway && !isAdapterDisabled(gateway, item.type) ? 'success' : 'secondary'" variant="tonal">
                    {{ gateway && !isAdapterDisabled(gateway, item.type) ? "已启用" : "已停用" }}
                  </v-chip>
                  <v-chip size="x-small" :color="scanConnectionColor(messageScanFor(item.type))" variant="tonal">
                    {{ scanConnectionLabel(messageScanFor(item.type)) }}
                  </v-chip>
                </span>
                <span class="channel-topology-node-action">查看配置</span>
              </button>
              <div v-if="channelCheckItems.length === 0" class="channel-topology-empty">
                <strong>尚未添加消息端</strong>
                <span>先在消息配置页添加一个消息端。</span>
              </div>
            </section>

            <div class="channel-topology-bridge" aria-hidden="true" />

            <section class="channel-topology-manager">
              <div class="channel-topology-heading channel-topology-heading-center">
                <v-icon size="18">mdi-routes</v-icon>
                <span>分诊与路由</span>
              </div>
              <div class="channel-topology-node channel-topology-manager-node" :data-tone="channelManagerConnectionColor()">
                <v-icon class="channel-topology-manager-icon">mdi-router-network</v-icon>
                <strong>Rabi Manager</strong>
                <v-chip size="small" :color="channelManagerConnectionColor()" variant="tonal">
                  {{ channelManagerConnectionLabel() }}
                </v-chip>
                <small>{{ channelManagerDetail() }}</small>
              </div>
            </section>

            <div class="channel-topology-bridge" aria-hidden="true" />

            <section class="channel-topology-column channel-topology-agents">
              <div class="channel-topology-heading">
                <v-icon size="18">mdi-robot-outline</v-icon>
                <span>Agent 端</span>
                <small>处理与回复</small>
              </div>
              <div
                v-for="agent in channelCheckAgentItems"
                :key="agent.type"
                class="channel-topology-node channel-topology-agent-node"
                :data-tone="channelAgentConnectionColor(agent.type)"
              >
                <v-icon class="channel-topology-node-icon">{{ agent.icon }}</v-icon>
                <span class="channel-topology-node-main">
                  <strong>{{ agent.title }}</strong>
                  <small>{{ channelAgentDetail(agent.type) }}</small>
                </span>
                <span class="channel-topology-node-status">
                  <v-chip v-if="agent.primary" size="x-small" color="primary" variant="tonal">主控</v-chip>
                  <v-chip v-else size="x-small" color="secondary" variant="tonal">备用</v-chip>
                  <v-chip size="x-small" :color="channelAgentConnectionColor(agent.type)" variant="tonal">
                    {{ channelAgentConnectionLabel(agent.type) }}
                  </v-chip>
                </span>
                <span class="channel-topology-node-actions">
                  <v-btn
                    size="x-small"
                    color="secondary"
                    variant="tonal"
                    prepend-icon="mdi-send-check-outline"
                    :loading="agentDeliveryTest.loading === localAgentTargetKey(agent.type)"
                    :disabled="Boolean(agentDeliveryTest.loading) || store.dirty || agent.type === 'marvis'"
                    @click="runAgentDeliveryTest(agent.type)"
                  >
                    {{ agent.type === "marvis" ? "仅人工接力" : "投递测试" }}
                  </v-btn>
                  <button type="button" class="channel-topology-config-action" @click="openChannelCheckAgentDetails(agent.type)">
                    查看配置
                  </button>
                </span>
              </div>
              <div v-for="target in remoteAgentItems" :key="target.id" class="channel-topology-node channel-topology-agent-node" :data-tone="target.instance?.connected ? 'success' : 'warning'">
                <v-icon class="channel-topology-node-icon">mdi-monitor-dashboard</v-icon>
                <span class="channel-topology-node-main"><strong>{{ target.title }}</strong><small>{{ target.instance?.connected && target.agent ? '实例在线，投递状态需测试确认' : '远端 Agent 暂不可用，未切换到本机' }}</small></span>
                <span class="channel-topology-node-status"><v-chip size="x-small" :color="gateway?.primaryAgentTarget === target.id ? 'primary' : 'secondary'" variant="tonal">{{ gateway?.primaryAgentTarget === target.id ? '主控' : '备用' }}</v-chip></span>
                <span class="channel-topology-node-actions">
                  <v-btn size="x-small" color="secondary" variant="tonal" prepend-icon="mdi-send-check-outline" :loading="agentDeliveryTest.loading === target.id" :disabled="Boolean(agentDeliveryTest.loading) || store.dirty || !target.instance?.connected || !target.agent" @click="runAgentDeliveryTest(target.provider, target.id)">投递测试</v-btn>
                  <button type="button" class="channel-topology-config-action" @click="channelCheckDialogOpen = false; remoteAgentParamOpen[target.id] = true">查看配置</button>
                </span>
              </div>
              <div v-if="channelCheckAgentItems.length === 0 && remoteAgentItems.length === 0" class="channel-topology-empty">
                <strong>尚未添加 Agent 端</strong>
                <span>先在消息配置页添加处理端。</span>
              </div>
            </section>
          </div>

          <v-alert
            v-if="agentDeliveryTest.loading"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-4"
          >
            正在向 {{ primaryAgentItems.find(item => item.value === agentDeliveryTest.loading)?.title || agentDeliveryTest.loading }} 投递真实测试消息…
          </v-alert>
          <v-alert
            v-else-if="agentDeliveryTest.result"
            type="success"
            variant="tonal"
            density="compact"
            class="mt-4"
            title="目标 Agent 已收到测试消息"
          >
            <div class="channel-delivery-test-details">
              <span>目标：{{ primaryAgentItems.find(item => item.value === agentDeliveryTest.result?.agentTargetId)?.title || agentDeliveryTest.result.agentTargetId || agentDeliveryTest.result.agentAdapterType }}</span>
              <span>测试编号：<code>{{ agentDeliveryTest.result.deliveryId }}</code></span>
              <span>完成时间：{{ agentDeliveryTestCompletedAt(agentDeliveryTest.result.completedAt) }}</span>
            </div>
          </v-alert>
          <v-alert
            v-else-if="agentDeliveryTest.error"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-4"
            title="投递测试失败"
          >
            {{ agentDeliveryTest.error }}
          </v-alert>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="channelCheckDialogOpen = false">关闭</v-btn>
          <v-btn color="secondary" variant="tonal" prepend-icon="mdi-refresh" :loading="messageAdapterScan.loading || agentScan.loading" @click="runChannelCheck">
            重新检查
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
