<script setup lang="ts">
import { translateText } from "../../../../../ribiwebgui/src/i18n/index";
import { agentDirectoryDiagnosticsForTarget, agentDirectoryFailure, readAgentInstanceDirectory, unassignedAgentDirectoryDiagnostics, type AgentDirectoryDiagnostic } from "../../../../../ribiwebgui/src/connectedAgentInstances";
import RoleBindingEditor from "../components/RoleBindingEditor.vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import InstanceAgentSettings from "../../../../../ribiwebgui/src/components/InstanceAgentSettings.vue";
import PeerRouteAgentSettings from "../components/PeerRouteAgentSettings.vue";
import PrimaryAgentAdvancedSettings from "../components/PrimaryAgentAdvancedSettings.vue";
import { localAgentTargetKey, remoteAgentTargetKey, resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { addRouteAgent, removeRouteAgent, selectRouteAgent, selectPeerRouteSession } from "../../../../../ribiwebgui/src/routeAgentTargetEditor";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";
import { routeAgentOperationGuard } from "../../../../../ribiwebgui/src/routeAgentOperationGuard";
import { agentInstanceDisplayName, type AgentInstance } from "@shared/agentInstance";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import { pluginCatalogStore } from "../../../../../ribiwebgui/src/pluginCatalogStore";
import { webRenderersAt } from "../../../../../ribiwebgui/src/pluginRenderers";
import type { MessageAdapterType, MessageEndpointType, AgentAdapterType, AgentDeliveryTestResult, AgentMaturity, AgentScanResult, MessageAdapterScanResult } from "../../../../../ribiwebgui/src/types";
import { isNonMessageEndpoint, adapterLabel, applyAdapterDefaults, gatewayAdapterTypes, isAdapterDisabled, isMessageInputsDisabled, messageAdapterPolicyFor, setGatewayAdapters, setMessageAdapterPolicy, toggleAdapterDisabled } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL } from "@shared/codexMemoryConsolidationAgent";
import { DEFAULT_CODEX_HOOK_SETTINGS, DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL, DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT, MAX_MESSAGE_PROCESSING_AGENTS, messageAdapterUsesAutomaticGrouping } from "@shared/gatewayConfigModel";
import { DEFAULT_CODEX_PLAN_ASSISTANT_MODEL, codexPlanAssistantInitializationPrompt, codexPlanAssistantSessionTitles, normalizeCodexPlanAssistantCount, filterCodexPlanAssistantSessionsForTarget, planAssistantSessionAgentAdapter } from "@shared/codexPlanAssistantSessions";
import { copyTextToClipboard } from "../../../../../ribiwebgui/src/clipboard";
import { routeScopedAdaptersPath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import { createRouteAgentScanController } from "../../../../../ribiwebgui/src/agentAdapters/routeAgentScanController";
import AgentAdapterCardHost from "../../../../../ribiwebgui/src/agentAdapters/AgentAdapterCardHost.vue";
import { configuredAgentRows, agentLocationLabel } from "../../../../../ribiwebgui/src/agentAdapters/agentAdapterCatalog";
import type { AgentAdapterCardContext } from "../../../../../ribiwebgui/src/agentAdapters/agentAdapterCardContext";
import MessageEndpointCardHost from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointCardHost.vue";
import { messageEndpointCatalog, messageEndpointGroups } from "../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCatalog";

function agentCardContext(type: AgentAdapterType, targetId = localAgentTargetKey(type)): AgentAdapterCardContext {
  const routeId = gateway.value!.id;
  return { routeId, targetId, agentType: type, runtime: runtime.value,
    scanState: { ...agentScan.value, loading: !!agentScanLoading.value[type] }, scanError: agentScanErrors.value[type] || "",
    touch: () => { if (gateway.value?.id === routeId) touch(); },
    refreshScan: async (options = {}) => { if (gateway.value?.id === routeId) await runAgentTypeScan(type, options); },
    loadMoreSessions: async () => {
      const page = agentScan.value.agents[type]?.sessionPage;
      if (gateway.value?.id === routeId && page?.hasMore && page.nextOffset != null)
        await runAgentTypeScan(type, { append: true, offset: page.nextOffset, limit: page.limit });
    }
  };
}

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

const codexPlanAssistants = ref({ count: 1, loading: false, message: "", error: "" });

const agentScanner = createRouteAgentScanController({ route: () => gateway.value, catalog: () => agentDefs.value });

const agentScan = agentScanner.state;

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

const agentScanLoading = agentScanner.loading;

const agentScanErrors = agentScanner.errors;

const runAgentTypeScan = agentScanner.scan;

async function runAgentScan(): Promise<void> { await agentScanner.scanAll(); }

const agentInstances = ref<AgentInstance[]>([]);

const lanAgentLoading = ref(false);

const agentDirectoryDiagnostics = ref<AgentDirectoryDiagnostic[]>([]);
let agentDirectoryRequest: AbortController | undefined;

function directoryDiagnosticTitle(diagnostic: AgentDirectoryDiagnostic): string {
  const titles: Record<AgentDirectoryDiagnostic["source"], string> = {
    access: "Agent 目录访问", "local-instances": "电脑 Agent 目录", "device-agents": "设备 Agent 目录",
    "peer-directory": "已连接电脑目录", "peer-instances": "远端 Agent 实例", "peer-adapters": "远端 Agent 能力目录"
  };
  return `${translateText(titles[diagnostic.source])}${diagnostic.ownerDeviceId ? ` (${diagnostic.ownerDeviceId})` : ""}`;
}

async function refreshLanAgentNodes(): Promise<void> {
  if (lanAgentLoading.value) return;
  const request = new AbortController();
  agentDirectoryRequest = request;
  lanAgentLoading.value = true;
  try {
    const access = await fetch("/api/webgui-access", { signal: request.signal }).then(response => response.json());
    const token = access.data?.token || managerAccessToken();
    const headers = { "x-rabiroute-webgui-token": token };
    const directory = await readAgentInstanceDirectory(fetch, headers, request.signal);
    if (request.signal.aborted || agentDirectoryRequest !== request) return;
    agentInstances.value = directory.instances;
    agentDirectoryDiagnostics.value = directory.diagnostics;
  } catch (error) {
    if (request.signal.aborted || agentDirectoryRequest !== request) return;
    agentInstances.value = [];
    agentDirectoryDiagnostics.value = [agentDirectoryFailure("access", error)];
  } finally {
    if (agentDirectoryRequest === request) { agentDirectoryRequest = undefined; lanAgentLoading.value = false; }
  }
}

function refreshAgentScan(type: AgentAdapterType): void { void runAgentTypeScan(type); }

function scanAgentsOnEntry(): void { agentScanner.enter(); }

onMounted(() => { scanAgentsOnEntry(); void refreshLanAgentNodes(); });

onBeforeUnmount(() => { agentScanner.dispose(); agentDirectoryRequest?.abort(); agentDirectoryRequest = undefined; });

const agentParamOpen = ref<Record<string, boolean>>({});

const agentCardOpened = ref<Record<string, boolean>>({});

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

const addedAdapters = computed<MessageAdapterType[]>(() => {
  const gw = gateway.value;
  if (!gw) return [];
  return configuredAdapterCatalog(gw);
});

const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);

const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);

const visibleActiveAdapters = computed<MessageAdapterType[]>(() => uniqueAdapters(adapters.value)
  .filter(type => !isNonMessageEndpoint(type) && endpointCatalog.value.some(item => item.type === type)));

const activeAdapterCount = computed(() => visibleActiveAdapters.value.length);

const copyResult = ref("");

const deletingGateway = ref(false);

const deleteError = ref("");

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

function renameCurrentConfig(value: unknown): void {
  if (!gateway.value) return;
  const result = store.renameGatewayConfig(gateway.value.id, value);
  configNameError.value = result.message || "";
}

const agentDefs = computed(() => pluginCatalogStore.agentAdapters.value);

const addAgentMenu = ref(false);

const agentTypes = computed(() => gateway.value?.agentAdapters ?? []);

const visibleAgentItems = computed(() => configuredAgentRows(agentDefs.value, agentTypes.value).map(agent => ({ ...agent, title: `${agentLocationLabel(agent.location)} · ${agent.title}` })));

const remoteAgentItems = computed(() => (gateway.value?.remoteAgentTargets || []).map(target => {
  const instance = agentInstances.value.find(item => item.instanceId === target.instanceId && item.ownerDeviceId === target.ownerDeviceId);
  const agent = instance?.agents.find(item => item.agentId === target.agentId);
  const definition = agentDefs.value.find(item => item.type === target.provider);
  const agentLabel = agent?.name || (definition ? `${definition.title} · ${target.agentId}` : target.agentId);
  return { ...target, instance, agent, diagnostics: agentDirectoryDiagnosticsForTarget(agentDirectoryDiagnostics.value, target), title: `远端 · ${instance ? `${agentInstanceDisplayName(instance)} / ` : ''}${agentLabel}（${instance?.address || target.instanceId}）` };
}));

const agentDiscoveryDiagnostics = computed(() => unassignedAgentDirectoryDiagnostics(agentDirectoryDiagnostics.value, gateway.value?.remoteAgentTargets || []));

const availableAgentsToAdd = computed(() => [
  ...agentDefs.value.filter(agent => agent.location !== "device" && !agentTypes.value.includes(agent.type)).map(agent => ({ ...agent, key: localAgentTargetKey(agent.type), title: `${agentLocationLabel(agent.location)} · ${agent.title}`, nodeId: undefined as string | undefined, agentId: undefined as string | undefined, ownerDeviceId: undefined as string | undefined })),
  ...agentInstances.value.flatMap(instance => instance.agents.flatMap(remote => {
    if (instance.local && !instance.ownerDeviceId && remote.provider !== "deviceAgent") return [];
    const def = agentDefs.value.find(agent => agent.type === (remote.provider === "codex-desktop" ? "codex" : remote.provider));
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

const remoteAgentCardOpened = ref<Record<string, boolean>>({});

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
  return agentDefs.value.find(agent => agent.type === type)?.note || "当前 Route 已添加的 Agent 端。";
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
  return agentDefs.value.find(item => item.type === type)?.manifest.capabilities.managedTasks?.[feature] === true;
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
  if (!agentDefs.value.some(agent => agent.type === type)) return {};
  // Provider-only runtime state belongs to the selected owner, not every same-provider card.
  if (primaryAgent.value?.binding || primaryLocalAgentType.value !== type) return {};
  return runtime.value.agentStates?.[type] ?? {};
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined { return agentScan.value.agents[type]; }

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
  if (!agentDefs.value.some(agent => agent.type === type)) return "插件不可用";
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

function fallbackCodexThreadName(): string {
  if (!gateway.value) return "RabiRoute";
  return gateway.value.routeName || gateway.value.name || store.configNameFor(gateway.value) || gateway.value.id || "RabiRoute";
}

function managedAgentSessionContext(type: AgentAdapterType) {
  if (!gateway.value) return null;
  const session = agentDefs.value.find(agent => agent.type === type)?.renderer.agentRoute?.session?.(gateway.value);
  return session ? { ...session, agentAdapter: type, sessionName: session.sessionName || fallbackCodexThreadName() } : null;
}

function managedAgentLabel(type: AgentAdapterType): string { return agentDefs.value.find(item => item.type === type)?.title || type; }

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

function agentWarnings(type: AgentAdapterType): readonly string[] {
  const scan = agentScanFor(type);
  const project = agentDefs.value.find(agent => agent.type === type)?.renderer.agentRoute?.warnings;
  return project && gateway.value ? project(gateway.value, scan) : (scan?.warnings ?? []);
}

function addAgent(type: AgentAdapterType, nodeId?: string, agentId?: string, ownerDeviceId?: string): void {
  if (!gateway.value) return;
  if (type === "deviceAgent" && (!nodeId || !agentId)) return;
  addAgentMenu.value = false;
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

function toggleAgentParams(type: AgentAdapterType): void {
  agentCardOpened.value[type] = true;
  agentParamOpen.value[type] = !agentParamOpen.value[type];
}

function toggleRemoteAgentParams(targetId: string): void {
  remoteAgentCardOpened.value[targetId] = true;
  remoteAgentParamOpen.value[targetId] = !remoteAgentParamOpen.value[targetId];
}

watch(() => [gateway.value?.id, agentDefs.value.map(provider => provider.renderer.key).join("\n")], scanAgentsOnEntry);

watch(() => gateway.value?.configName, (name, previousName) => {
  configNameError.value = "";
  if (!props.embedded && previousName && route.params.id === previousName && name && name !== previousName) {
    void router.replace({ path: routeScopedAdaptersPath(name), query: route.query, hash: route.hash });
  }
});

watch(() => gateway.value?.id, () => {
  adapterLifecycleRevision.value = {};
  adapterActionBusy.value = {};

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
              <div v-if="agentCardOpened[agent.type] || agentParamOpen[agent.type]" v-show="agentParamOpen[agent.type]" class="catalog-param-panel">
                <div class="dependency-panel mb-3">
                  <div class="section-title-row compact-row">
                    <div>
                      <div class="section-title small-title">环境和依赖</div>
                      <div class="section-note">{{ agent.note }}</div>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-chip size="small" :color="maturityColor(agentScanFor(agent.type)?.maturity)" variant="tonal">
                        {{ maturityLabel(agentScanFor(agent.type)?.maturity) }}
                      </v-chip>
                      <v-chip size="small" :color="agentConnectionColor(agent.type)" variant="tonal">
                        {{ agentConnectionLabel(agent.type) }}
                      </v-chip>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agentScanLoading[agent.type]" @click="refreshAgentScan(agent.type)">
                        重新扫描
                      </v-btn>
                    </div>
                  </div>
                  <v-alert v-if="agentScanErrors[agent.type]" type="warning" variant="tonal" density="compact">{{ agentScanErrors[agent.type] }}</v-alert>
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
                <AgentAdapterCardHost :renderer="agent.renderer" :context="agentCardContext(agent.type)" />
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
            <div class="catalog-row active" @click="toggleRemoteAgentParams(target.id)">
              <v-icon class="catalog-row-icon" color="secondary">mdi-monitor-dashboard</v-icon>
              <span class="catalog-row-main">
                <strong>{{ target.title }}</strong>
                <small>{{ target.provider === 'deviceAgent' ? '实验：由设备执行，所属电脑负责消息投递和回执' : '由这台远端电脑上的 Agent 处理消息' }}</small>
              </span>
              <div class="catalog-row-actions">
                <v-chip size="x-small" :color="target.provider !== 'deviceAgent' && target.instance?.connected && target.agent ? 'success' : 'warning'" variant="tonal">{{ target.provider === 'deviceAgent' ? '实验设备' : target.instance?.connected && target.agent ? '实例在线' : '暂不可用' }}</v-chip>
                <v-btn :icon="remoteAgentParamOpen[target.id] ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="small" variant="text" :title="remoteAgentParamOpen[target.id] ? '收起参数' : '展开参数'" @click.stop="toggleRemoteAgentParams(target.id)" />
                <v-btn icon="mdi-close" size="small" variant="text" color="error" title="从此路线移除远端 Agent" @click.stop="removeRemoteAgent(target.id)" />
              </div>
            </div>
            <v-expand-transition>
              <div v-if="remoteAgentCardOpened[target.id] || remoteAgentParamOpen[target.id]" v-show="remoteAgentParamOpen[target.id]" class="catalog-param-panel">
                <v-alert v-for="(diagnostic, index) in target.diagnostics" :key="`${diagnostic.source}:${index}`" type="warning" variant="tonal" density="compact" class="mb-2">
                  <strong>{{ directoryDiagnosticTitle(diagnostic) }}</strong>：{{ userFacingError({ message: diagnostic.message }) }}
                </v-alert>
                <AgentAdapterCardHost v-if="target.provider === 'deviceAgent'" :renderer="agentDefs.find(item => item.type === target.provider)?.renderer" :context="agentCardContext(target.provider, target.id)" />
                <PeerRouteAgentSettings v-else-if="target.ownerDeviceId" :key="`${gateway.id}:${target.id}`" :target="target" :agent="target.agent" :connected="!!target.instance?.connected" @selected="session => { selectPeerRouteSession(gateway, target.id, session); touch(); }" />
                <InstanceAgentSettings v-else-if="target.instance && target.agent" :key="target.id" :instance="target.instance" :agent="target.agent" @saved="refreshLanAgentNodes" />
                <v-alert v-else type="warning" variant="tonal">此远端 Agent 暂不可用，配置仍然保留，不会改投本机。请刷新实例列表。</v-alert>
                <v-btn class="mt-2" size="small" variant="text" prepend-icon="mdi-refresh" :loading="lanAgentLoading" @click="refreshLanAgentNodes">刷新实例列表</v-btn>
                <PrimaryAgentAdvancedSettings v-if="gateway.primaryAgentTarget === target.id && target.provider !== 'deviceAgent'" :gateway="gateway" :provider="target.provider" :target-title="target.title" :capabilities="agentDefs.find(item => item.type === target.provider)?.manifest.capabilities || {}" :error="codexPlanAssistants.error" :notice="codexPlanAssistants.message" @change="touch">
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
          <div v-if="visibleAgentItems.length === 0 && remoteAgentItems.length === 0" class="empty-state compact-empty">
            <div>
              <strong>尚未添加任何 Agent 端</strong>
              <span>点击下方按钮添加。</span>
            </div>
          </div>
        </div>

        <div class="adapter-add-row">
          <v-menu v-model="addAgentMenu" location="bottom start" :close-on-content-click="false">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                prepend-icon="mdi-plus"
                variant="tonal"
                size="small"
                :aria-label="translateText('添加 Agent')"
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
              <v-list-item v-if="availableAgentsToAdd.length === 0" :title="translateText('暂无可添加的 Agent')" disabled />
              <v-divider />
              <div class="pa-3">
                <details v-if="agentDiscoveryDiagnostics.length" class="mb-2">
                  <summary>{{ translateText('发现诊断') }} ({{ agentDiscoveryDiagnostics.length }})</summary>
                  <v-alert v-for="(diagnostic, index) in agentDiscoveryDiagnostics" :key="`${diagnostic.source}:${diagnostic.ownerDeviceId || ''}:${index}`" type="warning" variant="tonal" density="compact" class="mt-2">
                    <strong>{{ directoryDiagnosticTitle(diagnostic) }}</strong>：{{ userFacingError({ message: diagnostic.message }) }}
                  </v-alert>
                </details>
                <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="lanAgentLoading" @click="refreshLanAgentNodes">刷新实例列表</v-btn>
              </div>
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
