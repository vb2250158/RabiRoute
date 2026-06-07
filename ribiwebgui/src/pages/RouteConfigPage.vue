<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType, AgentAdapterType } from "../types";
import { adapterLabel, adapterErrorsFor, applyAdapterDefaults, configNameFor, gatewayAdapterTypes, isAdapterDisabled, isMessageInputsDisabled, routeConfigPathFor, setGatewayAdapters, toggleAdapterDisabled } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const runtime = computed(() => store.selectedRuntime);
const adapterQuery = ref("");
const agentScan = ref({
  threadNames: [] as string[],
  cwdOptions: [] as string[],
  copilotSessions: [] as { name: string; cwd?: string; userNamed?: boolean }[],
  copilotBins: [] as string[],
  marvisAppIds: [] as string[],
  loading: false,
});

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
  } catch { /* ignore */ }
  finally { agentScan.value.loading = false; }
}

// Copilot CLI 安装/登录
const copilotStatus = ref<{ installed?: boolean; binPath?: string; loggedIn?: boolean; copilotHome?: string } | null>(null);
const copilotInstalling = ref(false);
const copilotLoginState = ref<{ loading: boolean; code: string | null; url: string | null; done: boolean; error: string | null }>({
  loading: false, code: null, url: null, done: false, error: null
});

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
    title: "外部接口",
    note: "HTTP/Webhook、语音转写和后续自动化入口。",
    choices: [
      { type: "webhook", title: "Webhook", note: "接收外部系统 POST 事件", icon: "mdi-webhook" }
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
  return type === "napcat" || type === "heartbeat" || type === "webhook";
}

function toggleAdapterParams(type: MessageAdapterType): void {
  adapterParamOpen.value[type] = !adapterParamOpen.value[type];
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
  const allTypes: MessageAdapterType[] = ["napcat", "heartbeat", "webhook"];
  return allTypes.filter(t => !addedAdapters.value.includes(t));
});

function addAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  const next = [...addedAdapters.value, type];
  setGatewayAdapters(gateway.value, next as MessageAdapterType[]);
  applyAdapterDefaults(gateway.value);
  adapterParamOpen.value[type] = true;
  store.touch();
}

function touch(): void {
  if (gateway.value) applyAdapterDefaults(gateway.value);
  store.touch();
}

const agentDefs: Array<{ type: AgentAdapterType; title: string; note: string; icon: string; hasCwd: boolean; hasThread: boolean }> = [
  { type: "codexDesktop", title: "Codex Desktop", note: "通过 Codex Desktop 桌面端投递消息", icon: "mdi-monitor-dashboard", hasCwd: true, hasThread: true },
  { type: "codexApp",     title: "Codex App",     note: "通过 Codex App 投递消息",          icon: "mdi-application-outline", hasCwd: true, hasThread: true },
  { type: "copilotCli",  title: "Copilot CLI",   note: "通过 GitHub Copilot CLI 投递消息",  icon: "mdi-robot-outline", hasCwd: false, hasThread: true },
  { type: "marvis",      title: "Marvis",         note: "通过腾讯 Marvis 桌面端投递消息",    icon: "mdi-message-processing-outline", hasCwd: false, hasThread: false },
  { type: "astrbot",     title: "AstrBot",         note: "通过 AstrBot 机器人框架投递消息",    icon: "mdi-robot-happy-outline", hasCwd: false, hasThread: false },
];

const agentParamOpen = ref<Record<string, boolean>>({});
const addAgentMenu = ref(false);

const agentTypes = computed(() => gateway.value?.agentAdapters ?? []);
const visibleAgentItems = computed(() => agentDefs.filter(a => agentTypes.value.includes(a.type)));
const availableAgentsToAdd = computed(() => agentDefs.filter(a => !agentTypes.value.includes(a.type)));

function addAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = [...agentTypes.value, type];
  agentParamOpen.value[type] = true;
  store.touch();
}

function removeAgent(type: AgentAdapterType): void {
  if (!gateway.value) return;
  gateway.value.agentAdapters = agentTypes.value.filter(t => t !== type);
  agentParamOpen.value[type] = false;
  store.touch();
}

function toggleAgentParams(type: AgentAdapterType): void {
  agentParamOpen.value[type] = !agentParamOpen.value[type];
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
        <v-text-field v-model="gateway.configName" density="compact" hide-details variant="outlined" style="max-width:220px" @update:model-value="touch" />
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
                  <div v-if="choice.type === 'napcat'" class="catalog-param-grid">
                    <v-text-field v-model.number="gateway.gatewayPort" type="number" label="WebSocket 端口" @update:model-value="touch" />
                    <v-text-field v-model="gateway.napcatHttpUrl" label="HTTP 地址" @update:model-value="touch" />
                    <v-text-field v-model="gateway.napcatAccessToken" class="full-span" label="Access Token" placeholder="可选" @update:model-value="touch" />
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
                  </template>
                  <div v-else-if="choice.type === 'webhook'" class="catalog-param-grid">
                    <v-text-field v-model.number="gateway.webhookPort" type="number" label="监听端口" @update:model-value="touch" />
                    <v-text-field v-model="gateway.webhookPath" label="路径" placeholder="/webhook" @update:model-value="touch" />
                  </div>
                  <template v-if="choice.type === 'webhook' && runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>http://127.0.0.1:{{ gateway.webhookPort || gateway.gatewayPort }}{{ gateway.webhookPath || "/webhook" }}</b></div>
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
                <!-- Codex Desktop -->
                <template v-if="agent.type === 'codexDesktop'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexThreadName" :items="agentScan.threadNames" label="会话线程名" placeholder="Rabi" hint="Codex Desktop 里对话窗口的名称" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.threadNames.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexCwd" :items="agentScan.cwdOptions" label="工作目录" placeholder="C:/Path/To/Project" hint="Agent 打开的项目目录" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.cwdOptions.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="runtime.codexState?.lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ runtime.codexState.lastNotificationError }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="runtime.codexState?.monitorThreadId ? 'text-success' : 'text-warning'">{{ runtime.codexState?.monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ runtime.codexState?.monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ runtime.codexState?.lastNotificationAt || "-" }}</b></div>
                  </template>
                </template>
                <!-- Codex App -->
                <template v-else-if="agent.type === 'codexApp'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexThreadName" :items="agentScan.threadNames" label="会话线程名" placeholder="Rabi" hint="Codex App 里的对话线程名" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.threadNames.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.codexCwd" :items="agentScan.cwdOptions" label="工作目录" placeholder="C:/Path/To/Project" hint="Agent 打开的项目目录" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.cwdOptions.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                  <template v-if="runtime.running !== undefined">
                    <v-alert v-if="runtime.codexState?.lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ runtime.codexState.lastNotificationError }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="runtime.codexState?.monitorThreadId ? 'text-success' : 'text-warning'">{{ runtime.codexState?.monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ runtime.codexState?.monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ runtime.codexState?.lastNotificationAt || "-" }}</b></div>
                  </template>
                </template>
                <!-- Copilot CLI -->
                <template v-else-if="agent.type === 'copilotCli'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.codexThreadName" :items="agentScan.copilotSessions.map(s => s.name)" label="会话线程名" placeholder="Rabi" hint="Copilot CLI session 名称（--name 参数）" persistent-hint @update:model-value="(v) => { touch(); const s = agentScan.copilotSessions.find(x => x.name === v); if (s?.cwd && !gateway.copilotCwd) { gateway.copilotCwd = s.cwd; } }">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.threadNames.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotCwd" :items="agentScan.cwdOptions" label="工作目录 (-C)" placeholder="留空则使用 RabiRoute 根目录" hint="copilot -C &lt;目录&gt;，影响会话分组" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.cwdOptions.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotCliBin" :items="agentScan.copilotBins" label="CLI 可执行路径" placeholder="copilot" hint="留空则使用 PATH 中的 copilot" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.copilotBins.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
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
                      <template v-if="runtime.codexState?.lastNotificationError">
                        <v-alert type="warning" variant="tonal" density="compact" class="mb-1">
                          {{ runtime.codexState.lastNotificationError }}
                        </v-alert>
                      </template>
                      <div class="status-row"><span>最后成功</span><b>{{ runtime.codexState?.lastNotificationAt || "-" }}</b></div>
                      <div class="status-row"><span>来源</span><b>{{ runtime.codexState?.monitorThreadSource || "-" }}</b></div>
                      <div class="status-row"><span>状态文件</span><b>{{ runtime.codexState?.statePath || "-" }}</b></div>
                    </div>
                  </template>
                </template>
                <!-- Marvis -->
                <template v-else-if="agent.type === 'marvis'">
                  <div class="catalog-param-grid">
                    <v-combobox v-model="gateway.marvisAppId" :items="agentScan.marvisAppIds" label="应用 ID" placeholder="Tencent.Marvis" hint="留空使用默认 Tencent.Marvis" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.marvisAppIds.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div>
                </template>
                <template v-else-if="agent.type === 'astrbot'">
                  <div class="catalog-param-grid">
                    <v-text-field v-model="gateway.astrbotUrl" label="AstrBot 地址" placeholder="http://127.0.0.1:6185" hint="AstrBot 仪表盘地址，需安装 rabiroute_agent 插件" persistent-hint @update:model-value="touch" />
                  </div>
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
