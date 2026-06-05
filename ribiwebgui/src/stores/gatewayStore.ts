import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { GatewayDefinition, GatewayPayload, MessageAdapterType, MetaPayload, NetworkOptions, NotificationRule, RuntimeStatus } from "../types";
import {
  applyAdapterDefaults,
  configNameFor,
  createDefaultGateway,
  defaultGroupAtTemplate,
  ensureActiveRoleRules,
  gatewayAdapterTypes,
  isQuickSetupNeeded,
  notificationRulesForGateway,
  normalizeRule,
  saveActiveRoleRules,
  setGatewayAdapters
} from "../utils/gatewayHelpers";

const pluginApiBase = "/plugin/napcat-plugin-rabiroute/api";
const isPluginShell = window.location.pathname.startsWith("/plugin/");
const apiBase = isPluginShell ? pluginApiBase : "";

function asManagerRows(value: unknown): RuntimeStatus[] {
  return Array.isArray(value) ? value as RuntimeStatus[] : [];
}

function managerErrorOf(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error?: unknown }).error || "");
  }
  return "";
}

export const useGatewayStore = defineStore("gateway", () => {
  const gateways = ref<GatewayDefinition[]>([]);
  const managerRows = ref<RuntimeStatus[]>([]);
  const managerError = ref("");
  const networkOptions = ref<NetworkOptions>({ adapters: {}, httpServers: [], websocketClients: [] });
  const configFiles = ref<Record<string, string>>({});
  const selectedGatewayId = ref("");
  const loading = ref(false);
  const saving = ref(false);
  const dirty = ref(false);
  const error = ref("");
  const meta = ref<MetaPayload>({
    version: "0.1.0",
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort: 8790
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

  const runningCount = computed(() => gateways.value.filter(gateway => runtimeFor(gateway.id).running).length);
  const quickSetupNeeded = computed(() => isQuickSetupNeeded(gateways.value));

  function runtimeFor(id: string): RuntimeStatus {
    return managerRows.value.find(row => row.id === id) || {} as RuntimeStatus;
  }

  function touch(): void {
    dirty.value = true;
  }

  function normalizeGateways(): void {
    gateways.value.forEach(gateway => {
      gateway.agentAdapters = [...new Set((Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : ["codexDesktop"]).filter(item => item === "codexDesktop" || item === "codexApp"))];
      if (Array.isArray(gateway.notificationRules)) {
        gateway.notificationRules = gateway.notificationRules.map((rule, index) => normalizeRule(rule, index));
      }
      if (gateway.roleNotificationRules && typeof gateway.roleNotificationRules === "object" && !Array.isArray(gateway.roleNotificationRules)) {
        Object.keys(gateway.roleNotificationRules).forEach(roleId => {
          const rules = gateway.roleNotificationRules?.[roleId];
          if (Array.isArray(rules)) {
            gateway.roleNotificationRules![roleId] = rules.map((rule, index) => normalizeRule(rule, index));
          }
        });
      }
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
          httpServers: body.data.httpServers || [],
          websocketClients: body.data.websocketClients || []
        };
      }
    } catch {
      networkOptions.value = { adapters: {}, httpServers: [], websocketClients: [] };
    }
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      await Promise.all([loadMeta(), loadNetworkOptions()]);
      const response = await fetch(`${apiBase}/gateways`);
      const body = await response.json() as GatewayPayload;
      if (!response.ok || body.code !== 0 || !body.data?.config) {
        throw new Error(body.message || "插件 API 没有返回 gateway 配置");
      }
      gateways.value = body.data.config.gateways || [];
      configFiles.value = body.data.configFiles || {};
      managerRows.value = asManagerRows(body.data.manager);
      managerError.value = managerErrorOf(body.data.manager);
      normalizeGateways();
      if (!selectedGatewayId.value && gateways.value[0]) selectedGatewayId.value = gateways.value[0].id;
      if (selectedGatewayId.value && !gateways.value.some(gateway => gateway.id === selectedGatewayId.value)) {
        selectedGatewayId.value = gateways.value[0]?.id || "";
      }
      dirty.value = false;
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
      managerRows.value = [];
      managerError.value = error.value;
    } finally {
      loading.value = false;
    }
  }

  async function save(): Promise<void> {
    normalizeGateways();
    saving.value = true;
    error.value = "";
    try {
      const response = await fetch(`${apiBase}/gateways`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateways: gateways.value })
      });
      const body = await response.json();
      if (!response.ok || body.code !== 0) {
        throw new Error(body.message || body.error || "保存配置失败");
      }
      await load();
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
    await fetch(`${apiBase}/gateways/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    window.setTimeout(() => void load(), action === "restart" ? 1000 : 700);
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

  function removeGateway(id: string): void {
    gateways.value = gateways.value.filter(gateway => gateway.id !== id);
    if (selectedGatewayId.value === id) selectedGatewayId.value = gateways.value[0]?.id || "";
    touch();
  }

  function updateGatewayField<K extends keyof GatewayDefinition>(field: K, value: GatewayDefinition[K]): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    gateway[field] = value;
    if (field === "id") selectedGatewayId.value = String(value || "");
    if (field === "agentRoleId") ensureActiveRoleRules(gateway);
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
    const rules = notificationRulesForGateway(gateway);
    const next = rules.length + 1;
    rules.push({
      id: `rule-${Date.now().toString(36)}-${next}`,
      name: `规则 ${next}`,
      enabled: true,
      routeKinds: [],
      targetGroupId: "",
      regex: "",
      template: defaultGroupAtTemplate()
    });
    saveActiveRoleRules(gateway);
    touch();
  }

  function removeRule(ruleIndex: number): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const rules = notificationRulesForGateway(gateway);
    rules.splice(ruleIndex, 1);
    saveActiveRoleRules(gateway);
    touch();
  }

  function updateRule(ruleIndex: number, patch: Partial<NotificationRule>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const rules = notificationRulesForGateway(gateway);
    rules[ruleIndex] = normalizeRule({ ...rules[ruleIndex], ...patch }, ruleIndex);
    saveActiveRoleRules(gateway);
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
    codexThreadName: string;
    codexCwd: string;
    gatewayPort: number;
    napcatHttpUrl: string;
    adapters?: MessageAdapterType[];
    agentAdapters?: Array<"codexDesktop" | "codexApp">;
    heartbeatIntervalSeconds?: number;
    heartbeatMessage?: string;
    webhookPort?: number;
    webhookPath?: string;
  }): void {
    if (gateways.value.length === 0) addGateway();
    const gateway = selectedGateway.value;
    if (!gateway) return;
    if (values.adapters?.length) {
      setGatewayAdapters(gateway, values.adapters);
    }
    gateway.agentRoleId = values.agentRoleId;
    gateway.codexThreadName = values.codexThreadName;
    gateway.codexCwd = values.codexCwd;
    gateway.agentAdapters = values.agentAdapters?.length ? values.agentAdapters : gateway.agentAdapters;
    gateway.gatewayPort = values.gatewayPort;
    gateway.napcatHttpUrl = values.napcatHttpUrl;
    gateway.heartbeatIntervalSeconds = values.heartbeatIntervalSeconds || gateway.heartbeatIntervalSeconds;
    gateway.heartbeatMessage = values.heartbeatMessage || gateway.heartbeatMessage;
    gateway.webhookPort = values.webhookPort || gateway.webhookPort;
    gateway.webhookPath = values.webhookPath || gateway.webhookPath;
    gateway.rolesDir = gateway.rolesDir || "./data/roles";
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
    saving,
    dirty,
    error,
    meta,
    runningCount,
    quickSetupNeeded,
    runtimeFor,
    touch,
    load,
    save,
    startManager,
    actionGateway,
    openConfigFile,
    selectGateway,
    addGateway,
    removeGateway,
    updateGatewayField,
    updateAdapters,
    addRule,
    removeRule,
    updateRule,
    addRouteVariable,
    updateRouteVariable,
    removeRouteVariable,
    applyQuickSetup,
    gatewayAdapterTypes,
    configNameFor
  };
});
