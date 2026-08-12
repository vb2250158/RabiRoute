import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AgentAdapterType, GatewayDefinition, GatewayPayload, MessageAdapterType, MetaPayload, NetworkOptions, NotificationRule, PersonaAutomationRuleDefinition, RuntimeStatus } from "../types";
import {
  applyAdapterDefaults,
  automationRulesForGateway,
  adaptersNeedGatewayRuntime,
  configNameFor,
  createDefaultGateway,
  ensureActiveRoleRules,
  gatewayAdapterTypes,
  isBuiltinRolePanelRule,
  isQuickSetupNeeded,
  notificationRulesForGateway,
  normalizeRule,
  sanitizeConfigName,
  saveActiveRoleRules,
  syncAutomationRuleProjection,
  setGatewayAdapters
} from "../utils/gatewayHelpers";
import { routeKeyFromWebguiHash } from "../routeScopedNavigation";
import {
  autoAssignGatewayPorts as sharedAutoAssignGatewayPorts,
  resolvePrimaryAgentAdapter,
  validateGatewayPortConflicts
} from "@shared/gatewayConfigModel";
import { bindCodexSessionForSave } from "@shared/codexSessionBinding";
import { DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL } from "@shared/codexMemoryConsolidationAgent";

const pluginApiBase = "/plugin/napcat-plugin-rabiroute/api";
const isPluginShell = window.location.pathname.startsWith("/plugin/");
const apiBase = isPluginShell ? pluginApiBase : "";

type LoadOptions = {
  replaceDirtyConfig?: boolean;
};

function asManagerRows(value: unknown): RuntimeStatus[] {
  return Array.isArray(value) ? value as RuntimeStatus[] : [];
}

function managerErrorOf(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error?: unknown }).error || "");
  }
  return "";
}

function assertValidPort(value: unknown, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 必须是 1-65535 的整数，当前是 ${value || "空"}`);
  }
  return port;
}

function portFromUrl(value: string | undefined, label: string): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0));
    return port ? assertValidPort(port, `${label} 端口`) : null;
  } catch {
    throw new Error(`${label} 不是有效 URL：${value}`);
  }
}

function validateGatewayPorts(items: GatewayDefinition[], managerPort: number): void {
  const claims = new Map<number, string>();
  const claim = (port: number | null | undefined, label: string): void => {
    if (port == null) return;
    const validPort = assertValidPort(port, label);
    const existing = claims.get(validPort);
    if (existing) {
      throw new Error(`${label} 使用端口 ${validPort}，但已经被 ${existing} 占用`);
    }
    claims.set(validPort, label);
  };

  if (managerPort) {
    claim(managerPort, "RibiWebGUI manager");
  }

  for (const gateway of items) {
    const adapters = gatewayAdapterTypes(gateway);
    const activeNapcatInstances = adapters.includes("napcat")
      ? (gateway.napcatInstances ?? []).filter(instance => instance.enabled !== false)
      : [];
    if (adapters.includes("napcat") && activeNapcatInstances.length === 0) {
      claim(gateway.gatewayPort, `${configNameFor(gateway)} RabiRoute WS`);
    }
    if (adapters.includes("webhook")) {
      claim(gateway.webhookPort ?? gateway.gatewayPort, `${configNameFor(gateway)} Webhook`);
    }
    if (adapters.includes("fennenote")) {
      claim(gateway.fenneNoteWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${configNameFor(gateway)} FenneNote Webhook`);
    }
    if (adapters.includes("xiaoai")) {
      claim(gateway.xiaoaiWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${configNameFor(gateway)} XiaoAI Webhook`);
    }
    if (adapters.includes("rabilink")) {
      claim(gateway.rabiLinkWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${configNameFor(gateway)} RabiLink Webhook`);
    }
    for (const instance of activeNapcatInstances) {
      const name = `${configNameFor(gateway)} / ${instance.name || instance.id}`;
      claim(instance.gatewayPort, `${name} RabiRoute WS`);
      portFromUrl(instance.httpUrl, `${name} HTTP 地址`);
    }
  }
}

function nextAvailablePort(used: Set<number>, preferred: number): number {
  let port = Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535 ? preferred : 8790;
  while (port <= 65535 && used.has(port)) port += 1;
  if (port > 65535) {
    throw new Error("没有可用端口了，请手动释放一个 1-65535 范围内的端口。");
  }
  used.add(port);
  return port;
}

function autoAssignGatewayPorts(items: GatewayDefinition[], managerPort: number): void {
  const usedIngress = new Set<number>();
  if (managerPort) usedIngress.add(assertValidPort(managerPort, "RibiWebGUI manager"));

  const assignIngress = (value: unknown, fallback: number): number => {
    const current = Number(value || 0);
    if (Number.isInteger(current) && current >= 1 && current <= 65535 && !usedIngress.has(current)) {
      usedIngress.add(current);
      return current;
    }
    return nextAvailablePort(usedIngress, Math.max(1, Math.min(65535, Number(fallback) || 8790)));
  };

  for (const gateway of items) {
    const adapters = gatewayAdapterTypes(gateway);
    const activeNapcatInstances = adapters.includes("napcat")
      ? (gateway.napcatInstances ?? []).filter(instance => instance.enabled !== false)
      : [];

    if (adapters.includes("napcat") && activeNapcatInstances.length > 0) {
      for (const instance of activeNapcatInstances) {
        instance.gatewayPort = assignIngress(instance.gatewayPort, Number(gateway.gatewayPort || 8790) + 1);
        instance.httpUrl = instance.httpUrl || gateway.napcatHttpUrl || "http://127.0.0.1:3000";
        portFromUrl(instance.httpUrl, `${configNameFor(gateway)} / ${instance.name || instance.id} HTTP 地址`);
      }
      const primary = activeNapcatInstances[0];
      gateway.gatewayPort = Number(primary.gatewayPort);
      gateway.napcatHttpUrl = primary.httpUrl || gateway.napcatHttpUrl;
      gateway.napcatWebuiUrl = primary.webuiUrl || gateway.napcatWebuiUrl;
      gateway.napcatAccessToken = primary.accessToken || gateway.napcatAccessToken;
      gateway.napcatWebuiToken = primary.webuiToken || gateway.napcatWebuiToken;
    } else if (adapters.includes("napcat")) {
      gateway.gatewayPort = assignIngress(gateway.gatewayPort, 8790);
    }

    if (adapters.includes("webhook")) {
      gateway.webhookPort = assignIngress(gateway.webhookPort, Number(gateway.gatewayPort || 8790) + 1);
    }
    if (adapters.includes("fennenote")) {
      gateway.fenneNoteWebhookPort = assignIngress(gateway.fenneNoteWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (adapters.includes("xiaoai")) {
      gateway.xiaoaiWebhookPort = assignIngress(gateway.xiaoaiWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (adapters.includes("rabilink")) {
      gateway.rabiLinkWebhookPort = assignIngress(gateway.rabiLinkWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
  }
}

function isAgentAdapterType(value: unknown): value is AgentAdapterType {
  return value === "codex" || value === "copilotCli" || value === "marvis" || value === "astrbot";
}

function normalizeAgentAdapterType(value: unknown): AgentAdapterType | null {
  return isAgentAdapterType(value) ? value : null;
}

function selectedGatewayIdFromLocation(items: GatewayDefinition[]): string {
  const raw = routeKeyFromWebguiHash(window.location.hash);
  if (!raw) return "";
  return items.find(gateway =>
    gateway.id === raw
    || configNameFor(gateway) === raw
  )?.id || "";
}

export const useGatewayStore = defineStore("gateway", () => {
  const gateways = ref<GatewayDefinition[]>([]);
  const managerRows = ref<RuntimeStatus[]>([]);
  const managerError = ref("");
  const networkOptions = ref<NetworkOptions>({ adapters: {}, localAddresses: [], httpServers: [], websocketClients: [] });
  const configFiles = ref<Record<string, string>>({});
  const selectedGatewayId = ref("");
  const loading = ref(false);
  const diagnosticsLoading = ref(false);
  const diagnosticsLoaded = ref(false);
  const saving = ref(false);
  const dirty = ref(false);
  const editVersion = ref(0);
  const error = ref("");
  const quickSetupDialogOpen = ref(false);
  const pendingSelectedConfigName = ref("");
  const meta = ref<MetaPayload>({
    version: "0.1.0",
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort: 8790,
    rabiGuid: "",
    rabiName: "",
    webguiLan: {
      enabled: false,
      tokenConfigured: false,
      listeningOnLan: false,
      restartRequired: false
    },
    rabiLinkRelay: {
      enabled: false,
      url: "",
      token: "",
      tokenConfigured: false,
      deviceId: "",
      claimWaitMs: 60000,
      replyIdleTimeoutMs: 60000,
      speechProxyEnabled: false,
      speechServiceUrl: "http://127.0.0.1:8781"
    },
    rabiLinkRelayRuntime: {
      state: "disabled",
      message: "RabiLink Relay 全局连接已关闭。"
    },
    computerName: ""
  });

  const selectedIndex = computed(() => {
    const index = gateways.value.findIndex(gateway => gateway.id === selectedGatewayId.value);
    return index >= 0 ? index : 0;
  });

  const selectedGateway = computed(() => gateways.value[selectedIndex.value] || null);

  const selectedRuntime = computed(() => {
    const gateway = selectedGateway.value;
    if (!gateway) return {} as RuntimeStatus;
    return managerRows.value.find(row => row.id === gateway.id) || {} as RuntimeStatus;
  });

  const runningCount = computed(() => gateways.value.filter(gateway => {
    const runtime = runtimeFor(gateway.id);
    if (gateway.enabled === false || runtime.enabled === false) return false;
    if (!adaptersNeedGatewayRuntime(gatewayAdapterTypes(gateway))) return true;
    return runtime.running;
  }).length);
  const quickSetupNeeded = computed(() => isQuickSetupNeeded(gateways.value));

  function runtimeFor(id: string): RuntimeStatus {
    return managerRows.value.find(row => row.id === id) || {} as RuntimeStatus;
  }

  function touch(): void {
    dirty.value = true;
    editVersion.value += 1;
  }

  function openQuickSetup(): void {
    quickSetupDialogOpen.value = true;
  }

  function closeQuickSetup(): void {
    quickSetupDialogOpen.value = false;
  }

  function normalizeGateways(): void {
    gateways.value.forEach(gateway => {
      const agentAdapters = (Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : [])
        .map(normalizeAgentAdapterType)
        .filter((item): item is AgentAdapterType => Boolean(item));
      gateway.agentAdapters = [...new Set(agentAdapters)];
      gateway.primaryAgentAdapter = resolvePrimaryAgentAdapter(
        gateway.agentAdapters,
        gateway.primaryAgentAdapter
      );
      if (Array.isArray(gateway.notificationRules)) {
        gateway.notificationRules = gateway.notificationRules.map((rule, index) => normalizeRule(rule, index));
      }
      automationRulesForGateway(gateway);
      if (gateway.roleNotificationRules && typeof gateway.roleNotificationRules === "object" && !Array.isArray(gateway.roleNotificationRules)) {
        Object.keys(gateway.roleNotificationRules).forEach(roleId => {
          const rules = gateway.roleNotificationRules?.[roleId];
          if (Array.isArray(rules)) {
            gateway.roleNotificationRules![roleId] = rules.map((rule, index) => normalizeRule(rule, index));
          }
        });
      }
      applyAdapterDefaults(gateway);
      ensureActiveRoleRules(gateway);
    });
  }

  async function loadMeta(): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/meta`);
      if (!response.ok) return;
      meta.value = await response.json() as MetaPayload;
    } catch {
      // Keep defaults when the old manager has not been restarted yet.
    }
  }

  async function loadNetworkOptions(): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/network-options`);
      const body = await response.json();
      if (response.ok && body.code === 0 && body.data) {
        networkOptions.value = {
          adapters: body.data.adapters || {},
          localAddresses: body.data.localAddresses || [],
          httpServers: body.data.httpServers || [],
          websocketClients: body.data.websocketClients || []
        };
      }
    } catch {
      networkOptions.value = { adapters: {}, localAddresses: [], httpServers: [], websocketClients: [] };
    }
  }

  async function load(options: LoadOptions = {}): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      await Promise.all([loadMeta(), loadNetworkOptions()]);
      const response = await fetch(`${apiBase}/gateways?summary=1&includeConfig=1`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data?.config) {
        throw new Error(body.message || "插件 API 没有返回 gateway 配置");
      }
      managerRows.value = asManagerRows(body.data.manager);
      managerError.value = managerErrorOf(body.data.manager);
      diagnosticsLoaded.value = false;
      if (!dirty.value || options.replaceDirtyConfig) {
        gateways.value = body.data.config.gateways || [];
        configFiles.value = body.data.configFiles || {};
        normalizeGateways();
        const routeSelectedGatewayId = selectedGatewayIdFromLocation(gateways.value);
        if (pendingSelectedConfigName.value) {
          const renamed = gateways.value.find(gateway => configNameFor(gateway) === pendingSelectedConfigName.value);
          if (renamed) selectedGatewayId.value = renamed.id;
          pendingSelectedConfigName.value = "";
        } else if (routeSelectedGatewayId) {
          selectedGatewayId.value = routeSelectedGatewayId;
        }
        if (!selectedGatewayId.value && gateways.value[0]) selectedGatewayId.value = gateways.value[0].id;
        if (selectedGatewayId.value && !gateways.value.some(gateway => gateway.id === selectedGatewayId.value)) {
          selectedGatewayId.value = gateways.value[0]?.id || "";
        }
        dirty.value = false;
      }
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
      managerRows.value = [];
      managerError.value = error.value;
    } finally {
      loading.value = false;
    }
  }

  async function ensureDiagnostics(force = false): Promise<void> {
    if (diagnosticsLoading.value || (diagnosticsLoaded.value && !force)) return;
    diagnosticsLoading.value = true;
    try {
      const response = await fetch(`${apiBase}/gateways`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data) {
        throw new Error(body.message || "Manager 没有返回运行诊断");
      }
      managerRows.value = asManagerRows(body.data.manager);
      managerError.value = managerErrorOf(body.data.manager);
      diagnosticsLoaded.value = true;
    } catch (diagnosticsError) {
      managerError.value = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
    } finally {
      diagnosticsLoading.value = false;
    }
  }

  async function save(): Promise<void> {
    normalizeGateways();
    saving.value = true;
    error.value = "";
    try {
      if (selectedGateway.value) {
        await bindCodexSessionForSave(selectedGateway.value, async (request) => {
          const response = await fetch("/api/agent/threads", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request)
          });
          return {
            statusCode: response.status,
            data: await response.json().catch(() => ({})) as Record<string, unknown>
          };
        });
      }
      sharedAutoAssignGatewayPorts(gateways.value, Number(meta.value.managerPort || 0));
      validateGatewayPortConflicts(gateways.value);
      const expectedEnabledMessageAgents = gateways.value
        .filter(gateway => gateway.messageProcessingAgents?.codex?.enabled === true)
        .map(gateway => ({
          id: gateway.id,
          configName: gateway.configName,
          policy: gateway.messageProcessingAgents?.codex
        }));
      const expectedPlanAssistantSettings = gateways.value
        .filter(gateway => gateway.agentAdapters?.includes("codex"))
        .map(gateway => ({
          id: gateway.id,
          configName: gateway.configName,
          enabled: gateway.codexPlanAssistantEnabled === true,
          model: gateway.codexPlanAssistantModel
        }));
      const expectedMemoryConsolidationAgentSettings = gateways.value
        .filter(gateway => gateway.agentAdapters?.includes("codex"))
        .map(gateway => ({
          id: gateway.id,
          configName: gateway.configName,
          enabled: gateway.codexMemoryConsolidationAgentEnabled === true,
          model: gateway.codexMemoryConsolidationAgentModel || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL
        }));
      const expectedPrimaryAgentSettings = gateways.value
        .filter(gateway => gateway.agentAdapters?.includes("codex"))
        .map(gateway => ({
          id: gateway.id,
          configName: gateway.configName,
          model: gateway.agentModel?.trim() || "",
          reasoningEffort: gateway.agentReasoningEffort
        }));
      const savedEditVersion = editVersion.value;
      const response = await fetch(`${apiBase}/gateways`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateways: gateways.value })
      });
      const body = await response.json();
      if (!response.ok || body.code !== 0) {
        throw new Error(body.message || body.error || "保存配置失败");
      }
      const savedGateways = body?.data?.config?.gateways;
      if (Array.isArray(savedGateways)) {
        const messageAgentSettingWasDropped = expectedEnabledMessageAgents.some(expected => {
          const saved = savedGateways.find((gateway: GatewayDefinition) => (
            gateway.id === expected.id || gateway.configName === expected.configName
          ));
          const policy = saved?.messageProcessingAgents?.codex;
          return policy?.enabled !== true
            || policy.model !== expected.policy?.model
            || policy.reasoningEffort !== expected.policy?.reasoningEffort
            || policy.maxAgents !== expected.policy?.maxAgents;
        });
        if (messageAgentSettingWasDropped) {
          throw new Error("Manager 版本过旧，未保存消息处理 Agent 设置。请重启 Manager 后再次保存。");
        }
        const planAssistantSettingWasDropped = expectedPlanAssistantSettings.some(expected => {
          const saved = savedGateways.find((gateway: GatewayDefinition) => (
            gateway.id === expected.id || gateway.configName === expected.configName
          ));
          return saved?.codexPlanAssistantEnabled !== expected.enabled
            || saved?.codexPlanAssistantModel !== expected.model;
        });
        if (planAssistantSettingWasDropped) {
          throw new Error("Manager 版本过旧，未保存计划秘书设置。请重启 Manager 后再次保存。");
        }
        const memoryConsolidationAgentSettingWasDropped = expectedMemoryConsolidationAgentSettings.some(expected => {
          const saved = savedGateways.find((gateway: GatewayDefinition) => (
            gateway.id === expected.id || gateway.configName === expected.configName
          ));
          return saved?.codexMemoryConsolidationAgentEnabled !== expected.enabled
            || saved?.codexMemoryConsolidationAgentModel !== expected.model;
        });
        if (memoryConsolidationAgentSettingWasDropped) {
          throw new Error("Manager 版本过旧，未保存独立记忆整理 Agent 设置。请重启 Manager 后再次保存。");
        }
        const primaryAgentSettingWasDropped = expectedPrimaryAgentSettings.some(expected => {
          const saved = savedGateways.find((gateway: GatewayDefinition) => (
            gateway.id === expected.id || gateway.configName === expected.configName
          ));
          return (saved?.agentModel?.trim() || "") !== expected.model
            || saved?.agentReasoningEffort !== expected.reasoningEffort;
        });
        if (primaryAgentSettingWasDropped) {
          throw new Error("Manager 版本过旧，未保存主人格模型或推理强度。请重启 Manager 后再次保存。");
        }
      }
      if (editVersion.value === savedEditVersion) {
        dirty.value = false;
        await load({ replaceDirtyConfig: true });
      } else {
        await load();
      }
    } catch (saveError) {
      error.value = saveError instanceof Error ? saveError.message : String(saveError);
      throw saveError;
    } finally {
      saving.value = false;
    }
  }

  async function startManager(): Promise<void> {
    await fetch(`${apiBase}/manager/start`, { method: "POST" });
    await load();
  }

  async function actionGateway(id: string, action: "start" | "stop" | "restart"): Promise<void> {
    const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) {
      throw new Error(body.message || body.error || `${action} gateway failed`);
    }
    window.setTimeout(() => void load(), action === "restart" ? 1000 : 700);
  }

  async function manualTriggerGateway(id: string, payload: {
    triggerId: string;
    triggerName?: string;
    message?: string;
    routeKind?: "manual_trigger" | "heartbeat";
    ruleId?: string;
  }): Promise<{ accepted: true; alreadyRunning: boolean }> {
    const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/manual-trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) {
      throw new Error(body.message || body.error || "manual trigger failed");
    }
    return {
      accepted: true,
      alreadyRunning: body.data?.alreadyRunning === true
    };
  }

  async function openConfigFile(type: string, gatewayId = "", roleId = ""): Promise<void> {
    const params = new URLSearchParams({ type });
    if (gatewayId) params.set("gatewayId", gatewayId);
    if (roleId) params.set("roleId", roleId);
    const response = await fetch(`${apiBase}/open-config-file?${params.toString()}`, { method: "POST" });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`打开配置文件接口没有返回 JSON。响应：${text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (!response.ok || body.code !== 0) throw new Error(body.message || body.error || "打开配置文件失败");
  }

  function selectGateway(id: string): void {
    selectedGatewayId.value = id;
  }

  function addGateway(): void {
    const gateway = createDefaultGateway(gateways.value.length + 1);
    gateways.value.push(gateway);
    selectedGatewayId.value = gateway.id;
    touch();
  }

  function addGatewayAndOpenQuickSetup(): void {
    addGateway();
    openQuickSetup();
  }

  function renameGatewayConfig(id: string, rawName: unknown): { ok: boolean; name: string; message?: string } {
    const gateway = gateways.value.find(item => item.id === id);
    if (!gateway) return { ok: false, name: "", message: "未找到当前路由" };
    const currentName = configNameFor(gateway);
    const nextName = sanitizeConfigName(rawName);
    if (!nextName) {
      return { ok: false, name: currentName, message: "配置名只能包含中文、字母、数字、下划线或短横线" };
    }
    const duplicated = gateways.value.some(item => item.id !== id && configNameFor(item) === nextName);
    if (duplicated) {
      return { ok: false, name: currentName, message: `配置名 ${nextName} 已存在` };
    }
    gateway.configName = nextName;
    pendingSelectedConfigName.value = nextName;
    touch();
    return { ok: true, name: nextName };
  }

  function removeGateway(id: string): void {
    gateways.value = gateways.value.filter(gateway => gateway.id !== id);
    if (selectedGatewayId.value === id) selectedGatewayId.value = gateways.value[0]?.id || "";
    touch();
  }

  async function deleteGateway(id: string): Promise<void> {
    const nextSelectedGatewayId = selectedGatewayId.value === id
      ? gateways.value.find(gateway => gateway.id !== id)?.id || ""
      : selectedGatewayId.value;
    saving.value = true;
    error.value = "";
    try {
      const response = await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/delete`, { method: "POST" });
      const text = await response.text();
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (!response.ok || body.code !== 0) {
        const fallbackMessage = response.status === 404 || /<!doctype html|<html/i.test(text)
          ? "当前 Manager 还没有加载删除接口，请重启 Manager 后再删除。"
          : `删除路由失败（HTTP ${response.status}）：${text.replace(/\s+/g, " ").slice(0, 160) || "没有返回错误详情"}`;
        throw new Error(body.message || body.error || fallbackMessage);
      }
      selectedGatewayId.value = nextSelectedGatewayId;
      dirty.value = false;
      await load();
      if (gateways.value.some(gateway => gateway.id === id)) {
        throw new Error("删除请求已返回成功，但 Manager 刷新后仍返回该路由；请重启 Manager 后再试。");
      }
    } catch (deleteError) {
      error.value = deleteError instanceof Error ? deleteError.message : String(deleteError);
      throw deleteError;
    } finally {
      saving.value = false;
    }
  }

  function updateGatewayField<K extends keyof GatewayDefinition>(field: K, value: GatewayDefinition[K]): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    gateway[field] = value;
    if (field === "id") selectedGatewayId.value = String(value || "");
    if (field === "agentRoleId") {
      if (!String(value || "").trim()) {
        gateway.automationRules = [];
        gateway.notificationRules = [];
      }
      ensureActiveRoleRules(gateway);
    }
    touch();
  }

  function updateAdapters(adapters: MessageAdapterType[]): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    setGatewayAdapters(gateway, adapters);
    applyAdapterDefaults(gateway);
    touch();
  }

  function addRule(): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const messageRules = automations.filter(rule => rule.trigger.type === "message" && rule.action.type === "deliver_agent");
    const next = messageRules.length + 1;
    automations.push({
      id: `rule-${Date.now().toString(36)}-${next}`,
      name: `规则 ${next}`,
      enabled: true,
      trigger: { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
      action: { type: "deliver_agent", template: "" }
    });
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function removeRule(ruleIndex: number): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const entry = automations
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.type === "message" && rule.action.type === "deliver_agent")[ruleIndex];
    if (!entry || isBuiltinRolePanelRule(notificationRulesForGateway(gateway)[ruleIndex])) return;
    automations.splice(entry.index, 1);
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function updateRule(ruleIndex: number, patch: Partial<NotificationRule>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const entry = automations
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.type === "message" && rule.action.type === "deliver_agent")[ruleIndex];
    if (!entry || entry.rule.trigger.type !== "message" || entry.rule.action.type !== "deliver_agent") return;
    entry.rule = {
      ...entry.rule,
      name: patch.name ?? entry.rule.name,
      enabled: patch.enabled ?? entry.rule.enabled,
      trigger: {
        ...entry.rule.trigger,
        routeKinds: patch.routeKinds ?? entry.rule.trigger.routeKinds,
        targetGroupId: patch.targetGroupId ?? entry.rule.trigger.targetGroupId,
        allowedSpeakerNames: patch.allowedSpeakerNames ?? entry.rule.trigger.allowedSpeakerNames,
        regex: patch.regex ?? entry.rule.trigger.regex
      },
      action: {
        ...entry.rule.action,
        template: patch.template ?? entry.rule.action.template
      }
    };
    automations[entry.index] = entry.rule;
    syncAutomationRuleProjection(gateway);
    saveActiveRoleRules(gateway);
    touch();
  }

  function addAutomation(triggerType: "message" | "schedule", actionType: "deliver_agent" | "run_script"): string | undefined {
    const gateway = selectedGateway.value;
    if (!gateway) return undefined;
    const automations = automationRulesForGateway(gateway);
    const id = `automation-${Date.now().toString(36)}-${automations.length + 1}`;
    const next: PersonaAutomationRuleDefinition = {
      id,
      name: triggerType === "schedule" ? "新定时任务" : "新消息动作",
      enabled: true,
      trigger: triggerType === "schedule"
        ? {
          type: "schedule",
          schedule: {
            id: `schedule-${Date.now().toString(36)}`,
            name: "触发时间",
            enabled: true,
            type: "interval",
            intervalSeconds: Number(gateway.heartbeatIntervalSeconds || 900)
          }
        }
        : { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
      action: actionType === "run_script"
        ? { type: "run_script", scriptPath: "", arguments: [], timeoutSeconds: 300 }
        : { type: "deliver_agent", message: "", template: "" }
    };
    automations.push(next);
    syncAutomationRuleProjection(gateway);
    touch();
    return id;
  }

  function updateAutomation(ruleId: string, patch: Partial<PersonaAutomationRuleDefinition>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    const current = automations[index];
    automations[index] = {
      ...current,
      ...patch,
      trigger: patch.trigger ?? current.trigger,
      action: patch.action ?? current.action
    };
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function removeAutomation(ruleId: string): void {
    const gateway = selectedGateway.value;
    if (!gateway || ruleId === "role-panel-message") return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    automations.splice(index, 1);
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function addRouteVariable(): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (!gateway.routeVariables) gateway.routeVariables = {};
    let next = 1;
    while (gateway.routeVariables[`Variable${next}`] != null) next += 1;
    gateway.routeVariables[`Variable${next}`] = "";
    touch();
  }

  function updateRouteVariable(oldKey: string, key: string, value: string): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (!gateway.routeVariables) gateway.routeVariables = {};
    if (key !== oldKey && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      gateway.routeVariables[key] = value;
      delete gateway.routeVariables[oldKey];
    } else {
      gateway.routeVariables[oldKey] = value;
    }
    touch();
  }

  function removeRouteVariable(key: string): void {
    const gateway = selectedGateway.value;
    if (!gateway?.routeVariables) return;
    delete gateway.routeVariables[key];
    touch();
  }

  function applyQuickSetup(values: {
    agentRoleId: string;
    agentModel?: string;
    codexThreadId?: string;
    codexThreadName: string;
    copilotThreadName: string;
    codexCwd: string;
    copilotCliBin?: string;
    copilotCwd?: string;
    marvisAppId?: string;
    astrbotUrl?: string;
    astrbotUsername?: string;
    astrbotPassword?: string;
    astrbotProjectId?: string;
    astrbotSessionId?: string;
    gatewayPort: number;
    napcatHttpUrl: string;
    napcatWebuiUrl?: string;
    adapters?: MessageAdapterType[];
    messageInputsDisabled?: boolean;
    agentAdapters?: AgentAdapterType[];
    primaryAgentAdapter?: AgentAdapterType;
    heartbeatIntervalSeconds?: number;
    heartbeatMessage?: string;
    heartbeatSkipWhenAgentBusy?: boolean;
    webhookPort?: number;
    webhookPath?: string;
    fenneNoteWebhookPort?: number;
    fenneNoteWebhookPath?: string;
    xiaoaiWebhookPort?: number;
    xiaoaiWebhookPath?: string;
    rabiLinkWebhookPort?: number;
    rabiLinkWebhookPath?: string;
    rabiLinkWebhookHost?: string;
    wecomBotId?: string;
    wecomBotSecret?: string;
    wecomWsUrl?: string;
  }): void {
    if (gateways.value.length === 0) addGateway();
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (values.adapters?.length) {
      setGatewayAdapters(gateway, values.adapters);
    }
    gateway.messageInputsDisabled = values.messageInputsDisabled === true;
    gateway.agentRoleId = values.agentRoleId;
    if (!gateway.agentRoleId) {
      gateway.automationRules = [];
      gateway.notificationRules = [];
    }
    gateway.agentModel = values.agentModel?.trim() || "";
    gateway.codexCwd = values.codexCwd;
    gateway.agentAdapters = values.agentAdapters?.length ? values.agentAdapters : gateway.agentAdapters;
    gateway.primaryAgentAdapter = resolvePrimaryAgentAdapter(
      gateway.agentAdapters,
      values.primaryAgentAdapter ?? gateway.primaryAgentAdapter
    );
    if (gateway.agentAdapters?.includes("codex")) {
      gateway.codexThreadId = values.codexThreadId;
      gateway.codexThreadName = values.codexThreadName;
    }
    if (gateway.agentAdapters?.includes("copilotCli")) {
      gateway.copilotThreadName = values.copilotThreadName;
      gateway.copilotCliBin = values.copilotCliBin || gateway.copilotCliBin;
      gateway.copilotCwd = values.copilotCwd || values.codexCwd;
    }
    if (gateway.agentAdapters?.includes("marvis")) {
      gateway.marvisAppId = values.marvisAppId || gateway.marvisAppId;
    }
    if (gateway.agentAdapters?.includes("astrbot")) {
      gateway.astrbotUrl = values.astrbotUrl || gateway.astrbotUrl;
      gateway.astrbotUsername = values.astrbotUsername || gateway.astrbotUsername;
      gateway.astrbotPassword = values.astrbotPassword || gateway.astrbotPassword;
      gateway.astrbotProjectId = values.astrbotProjectId || gateway.astrbotProjectId;
      gateway.astrbotSessionId = values.astrbotSessionId || gateway.astrbotSessionId;
    }
    gateway.gatewayPort = values.gatewayPort;
    gateway.napcatHttpUrl = values.napcatHttpUrl;
    gateway.napcatWebuiUrl = values.napcatWebuiUrl || gateway.napcatWebuiUrl;
    if (gateway.messageAdapters?.includes("napcat") || gateway.messageAdapterType === "napcat") {
      if (!Array.isArray(gateway.napcatInstances) || gateway.napcatInstances.length === 0) {
        gateway.napcatInstances = [{
          id: "default",
          name: "默认 NapCat",
          enabled: true,
          gatewayPort: values.gatewayPort,
          httpUrl: values.napcatHttpUrl,
          webuiUrl: values.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
          accessToken: gateway.napcatAccessToken || "",
          webuiToken: gateway.napcatWebuiToken || ""
        }];
      } else {
        gateway.napcatInstances[0] = {
          ...gateway.napcatInstances[0],
          gatewayPort: values.gatewayPort,
          httpUrl: values.napcatHttpUrl,
          webuiUrl: values.napcatWebuiUrl || gateway.napcatInstances[0].webuiUrl
        };
      }
    }
    gateway.heartbeatIntervalSeconds = values.heartbeatIntervalSeconds || gateway.heartbeatIntervalSeconds;
    gateway.heartbeatMessage = values.heartbeatMessage || gateway.heartbeatMessage;
    gateway.heartbeatSkipWhenAgentBusy = values.heartbeatSkipWhenAgentBusy === true;
    gateway.webhookPort = values.webhookPort || gateway.webhookPort;
    gateway.webhookPath = values.webhookPath || gateway.webhookPath;
    gateway.fenneNoteWebhookPort = values.fenneNoteWebhookPort || gateway.fenneNoteWebhookPort;
    gateway.fenneNoteWebhookPath = values.fenneNoteWebhookPath || gateway.fenneNoteWebhookPath;
    gateway.xiaoaiWebhookPort = values.xiaoaiWebhookPort || gateway.xiaoaiWebhookPort;
    gateway.xiaoaiWebhookPath = values.xiaoaiWebhookPath || gateway.xiaoaiWebhookPath;
    gateway.rabiLinkWebhookPort = values.rabiLinkWebhookPort || gateway.rabiLinkWebhookPort;
    gateway.rabiLinkWebhookPath = values.rabiLinkWebhookPath || gateway.rabiLinkWebhookPath;
    gateway.rabiLinkWebhookHost = values.rabiLinkWebhookHost || gateway.rabiLinkWebhookHost;
    gateway.wecomBotId = values.wecomBotId || gateway.wecomBotId;
    gateway.wecomBotSecret = values.wecomBotSecret || gateway.wecomBotSecret;
    gateway.wecomWsUrl = values.wecomWsUrl || gateway.wecomWsUrl;
    gateway.agentRoleFile = gateway.agentRoleFile || "persona.md";
    applyAdapterDefaults(gateway);
    touch();
  }

  return {
    gateways,
    managerRows,
    managerError,
    networkOptions,
    configFiles,
    selectedGatewayId,
    selectedIndex,
    selectedGateway,
    selectedRuntime,
    loading,
    diagnosticsLoading,
    diagnosticsLoaded,
    saving,
    dirty,
    error,
    quickSetupDialogOpen,
    meta,
    runningCount,
    quickSetupNeeded,
    runtimeFor,
    touch,
    openQuickSetup,
    closeQuickSetup,
    load,
    ensureDiagnostics,
    save,
    startManager,
    actionGateway,
    manualTriggerGateway,
    openConfigFile,
    selectGateway,
    addGateway,
    addGatewayAndOpenQuickSetup,
    renameGatewayConfig,
    removeGateway,
    deleteGateway,
    updateGatewayField,
    updateAdapters,
    addRule,
    removeRule,
    updateRule,
    addAutomation,
    updateAutomation,
    removeAutomation,
    addRouteVariable,
    updateRouteVariable,
    removeRouteVariable,
    applyQuickSetup,
    gatewayAdapterTypes,
    configNameFor
  };
});
