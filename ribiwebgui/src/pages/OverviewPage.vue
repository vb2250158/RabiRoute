<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { adapterLabel, adaptersNeedGatewayRuntime, gatewayAdapterTypes, isMessageInputsDisabled } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const router = useRouter();

const routeDir = ref("");
const rolesDir = ref("");
const dirSaving = ref(false);
const dirSaved = ref(false);
const dirError = ref("");
const rabiName = ref("");
const rabiSaving = ref(false);
const rabiSaved = ref(false);
const rabiError = ref("");
const rabiLinkRelayUrl = ref("");
const rabiLinkRelayAppToken = ref("");
const rabiLinkRelayDeviceId = ref("");
const rabiLinkRelayClaimWaitMs = ref(60000);
const rabiLinkRelayReplyIdleTimeoutMs = ref(60000);
const gatewayActionId = ref("");
const gatewayActionError = ref("");
const deletingGatewayId = ref("");

async function loadDirConfig() {
  try {
    const res = await fetch("/manager-config");
    const data = await res.json();
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
  } catch { /* ignore */ }
  rabiName.value = store.meta.rabiName || store.meta.computerName || "";
  loadRabiLinkRelayForm();
}

function loadRabiLinkRelayForm(): void {
  const relay = store.meta.rabiLinkRelay || {};
  rabiLinkRelayUrl.value = relay.url || "";
  rabiLinkRelayAppToken.value = relay.token || "";
  rabiLinkRelayDeviceId.value = relay.deviceId || store.meta.computerName || "";
  rabiLinkRelayClaimWaitMs.value = Number(relay.claimWaitMs || 60000);
  rabiLinkRelayReplyIdleTimeoutMs.value = Number(relay.replyIdleTimeoutMs || 60000);
}

async function saveDirConfig() {
  dirSaving.value = true;
  dirSaved.value = false;
  dirError.value = "";
  try {
    const res = await fetch("/manager-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeDir: routeDir.value || undefined, rolesDir: rolesDir.value || undefined })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "保存失败");
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
    dirSaved.value = true;
  } catch (e) {
    dirError.value = String(e);
  } finally {
    dirSaving.value = false;
  }
}

async function saveRabiIdentity() {
  rabiSaving.value = true;
  rabiSaved.value = false;
  rabiError.value = "";
  try {
    const res = await fetch("/api/rabi/identity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rabiName: rabiName.value,
        rabiLinkRelay: {
          url: rabiLinkRelayUrl.value,
          token: rabiLinkRelayAppToken.value,
          deviceId: rabiLinkRelayDeviceId.value,
          claimWaitMs: Number(rabiLinkRelayClaimWaitMs.value || 60000),
          replyIdleTimeoutMs: Number(rabiLinkRelayReplyIdleTimeoutMs.value || 60000)
        }
      })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "保存失败");
    await store.load({ replaceDirtyConfig: true });
    rabiName.value = store.meta.rabiName || "";
    loadRabiLinkRelayForm();
    rabiSaved.value = true;
  } catch (e) {
    rabiError.value = e instanceof Error ? e.message : String(e);
  } finally {
    rabiSaving.value = false;
  }
}

onMounted(loadDirConfig);

function goToRoute(id: string): void {
  store.selectGateway(id);
  router.push("/routes");
}

function toggleGatewayEnabled(gateway: any): void {
  gateway.enabled = !gateway.enabled;
  store.touch();
}

async function runGatewayAction(id: string, action: "start" | "stop" | "restart"): Promise<void> {
  if (!id || gatewayActionId.value) return;
  gatewayActionId.value = `${id}:${action}`;
  gatewayActionError.value = "";
  try {
    await store.actionGateway(id, action);
  } catch (error) {
    gatewayActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    window.setTimeout(() => {
      gatewayActionId.value = "";
    }, action === "restart" ? 1000 : 700);
  }
}

async function deleteGatewayFromConsole(gateway: any): Promise<void> {
  if (!gateway?.id || deletingGatewayId.value) return;
  const name = store.configNameFor(gateway);
  const confirmed = window.confirm(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`);
  if (!confirmed) return;
  deletingGatewayId.value = gateway.id;
  gatewayActionError.value = "";
  try {
    await store.deleteGateway(gateway.id);
  } catch (error) {
    gatewayActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingGatewayId.value = "";
  }
}

function napcatRuntimeRows(raw: any): Record<string, any>[] {
  const instances = raw?.gatewayStatus?.napcatInstances;
  if (Array.isArray(instances)) return instances;
  if (instances && typeof instances === "object") return Object.values(instances) as Record<string, any>[];
  const napcat = raw?.gatewayStatus?.napcat;
  return napcat ? [napcat] : [];
}

function napcatIsOffline(row: Record<string, any>): boolean {
  return row.online === false || row.good === false || /online:false|已离线/.test(String(row.loginInfoError || ""));
}

function gatewayNeedsRuntime(gateway: any): boolean {
  return adaptersNeedGatewayRuntime(gatewayAdapterTypes(gateway));
}

function gatewayRuntimeLabel(gateway: any): string {
  const runtime = store.runtimeFor(gateway.id);
  if (gateway.enabled === false || runtime.enabled === false) return "禁用中";
  if (!gatewayNeedsRuntime(gateway)) return "启用中";
  return runtime.running ? "运行中" : "已停止";
}

function gatewayRuntimeColor(gateway: any): string {
  const runtime = store.runtimeFor(gateway.id);
  if (gateway.enabled === false || runtime.enabled === false) return "grey";
  if (!gatewayNeedsRuntime(gateway)) return "success";
  return runtime.running ? "success" : "error";
}

const selectedRuntime = computed(() => store.selectedRuntime);
const adapterHealth = computed(() => {
  const gateway = store.selectedGateway;
  if (!gateway) return "未选择";
  const runtime = selectedRuntime.value;
  const adapters = gatewayAdapterTypes(gateway);
  const napcatRows = napcatRuntimeRows(runtime);
  const napcat = runtime.gatewayStatus?.napcat || {};
  if (gateway.enabled === false || runtime.enabled === false) return "禁用中";
  if (isMessageInputsDisabled(gateway)) return "禁用中";
  if (!adaptersNeedGatewayRuntime(adapters)) return "启用中";
  if (!runtime.running) return "已停止";
  if (adapters.includes("napcat") && napcatRows.some(napcatIsOffline)) return "QQ 已离线";
  if (adapters.includes("napcat") && napcatRows.length && napcatRows.every(row => !row.connected)) return "WS 未连接";
  if (adapters.includes("napcat") && !napcatRows.length && !napcat.connected) return "WS 未连接";
  if (adapters.includes("napcat") && napcat.loginInfoError) return "HTTP 异常";
  return "已启用";
});
const selectedGatewayName = computed(() => store.selectedGateway ? store.configNameFor(store.selectedGateway) : "等待创建路由");
const selectedAdapters = computed(() => {
  if (!store.selectedGateway) return "尚未选择消息入口";
  const text = gatewayAdapterTypes(store.selectedGateway).map(adapterLabel).join(" + ");
  return isMessageInputsDisabled(store.selectedGateway) ? `已禁用 · ${text}` : text;
});
const selectedRuntimeLabel = computed(() => {
  if (!store.selectedGateway) return "未配置";
  if (store.selectedGateway.enabled === false || selectedRuntime.value.enabled === false) return "禁用中";
  if (!gatewayNeedsRuntime(store.selectedGateway)) return "启用中";
  return selectedRuntime.value.running ? "运行中" : "已停止";
});
</script>

<template>
  <div class="page-shell">
    <div class="overview-hero app-card">
      <div>
        <div class="eyebrow">RabiRoute Control Deck</div>
        <h1 class="overview-hero-title">消息包裹正在排队分诊</h1>
        <div class="overview-hero-copy">
          RabiRoute 负责把来自 QQ、定时器和 Webhook 的消息补齐上下文，再投递给合适的 Agent。
        </div>
      </div>
      <div class="overview-hero-panel">
        <div class="status-row"><span>当前路由</span><b>{{ selectedGatewayName }}</b></div>
        <div class="status-row"><span>运行状态</span><b>{{ selectedRuntimeLabel }}</b></div>
        <div class="status-row"><span>消息入口</span><b>{{ selectedAdapters }}</b></div>
        <div class="status-row"><span>Rabi 实例</span><b>{{ store.meta.rabiName || store.meta.computerName || "-" }}</b></div>
        <div class="hero-actions">
          <v-btn prepend-icon="mdi-lightning-bolt-outline" color="secondary" variant="tonal" @click="store.openQuickSetup">快速配置</v-btn>
          <v-btn prepend-icon="mdi-play-circle-outline" variant="tonal" @click="store.startManager">启动 Manager</v-btn>
          <v-btn
            prepend-icon="mdi-restart"
            variant="tonal"
            color="primary"
            :loading="gatewayActionId === `${store.selectedGatewayId}:restart`"
            :disabled="!store.selectedGatewayId || Boolean(gatewayActionId)"
            @click="runGatewayAction(store.selectedGatewayId, 'restart')"
          >
            重启当前路由
          </v-btn>
        </div>
        <v-alert v-if="gatewayActionError" type="error" variant="tonal" density="compact" class="mt-3">{{ gatewayActionError }}</v-alert>
      </div>
    </div>

    <div class="overview-grid">
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">路由配置</div>
        <div class="stat-value">{{ store.gateways.length }}</div>
        <div class="stat-note">当前 manager 管理的 gateway 数量</div>
      </v-card>
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">可用入口</div>
        <div class="stat-value">{{ store.runningCount }}/{{ store.gateways.length }}</div>
        <div class="stat-note">子进程运行或入口已启用</div>
      </v-card>
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">消息端健康</div>
        <div class="stat-value">{{ adapterHealth }}</div>
        <div class="stat-note">{{ selectedAdapters }}</div>
      </v-card>
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">Agent</div>
        <div class="stat-value">{{ selectedRuntime.codexState?.monitorThreadId ? "已绑定" : "未绑定" }}</div>
        <div class="stat-note">{{ selectedRuntime.codexState?.monitorThreadName || store.selectedGateway?.codexThreadName || "等待会话线程" }}</div>
      </v-card>
    </div>

    <div class="two-column">
      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">路由列表</div>
            <div class="section-note">选择一条路由后，其余页面会编辑同一条配置。</div>
          </div>
          <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="store.addGatewayAndOpenQuickSetup">新增</v-btn>
        </div>
        <v-list bg-color="transparent">
          <v-list-item
            v-for="gw in store.gateways"
            :key="gw.id"
            rounded="lg"
            :active="gw.id === store.selectedGatewayId"
            @click="store.selectGateway(gw.id)"
          >
            <template #prepend>
              <v-avatar color="secondary" variant="tonal" size="36">
                <v-icon>mdi-routes</v-icon>
              </v-avatar>
            </template>
            <v-list-item-title class="font-weight-bold">{{ store.configNameFor(gw) }}</v-list-item-title>
            <v-list-item-subtitle>
              人格 {{ gw.agentRoleId || "未选择" }} · {{ gatewayAdapterTypes(gw).map(adapterLabel).join(" + ") }}
            </v-list-item-subtitle>
            <template #append>
              <div class="route-list-actions">
                <v-chip size="small" :color="gatewayRuntimeColor(gw)" variant="tonal">
                  {{ gatewayRuntimeLabel(gw) }}
                </v-chip>
                <v-switch
                  :model-value="gw.enabled !== false"
                  color="success"
                  density="compact"
                  inset
                  hide-details
                  title="启用 / 禁用此路由"
                  @click.stop
                  @update:model-value="() => toggleGatewayEnabled(gw)"
                />
                <v-btn
                  icon="mdi-restart"
                  size="small"
                  variant="text"
                  title="重启此路由"
                  :loading="gatewayActionId === `${gw.id}:restart`"
                  :disabled="Boolean(gatewayActionId)"
                  @click.stop="runGatewayAction(gw.id, 'restart')"
                />
                <v-btn
                  icon="mdi-arrow-right"
                  size="small"
                  variant="text"
                  title="跳转到消息适配器配置"
                  @click.stop="goToRoute(gw.id)"
                />
                <v-btn
                  icon="mdi-delete"
                  size="small"
                  variant="text"
                  color="error"
                  title="删除路由配置"
                  :loading="deletingGatewayId === gw.id"
                  :disabled="Boolean(deletingGatewayId)"
                  @click.stop="deleteGatewayFromConsole(gw)"
                />
              </div>
            </template>
          </v-list-item>
        </v-list>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">当前链路</div>
            <div class="section-note">RabiRoute 只负责入口、分诊、模板和投递边界。</div>
          </div>
        </div>
        <div class="status-row"><span>Manager</span><b>{{ store.managerError || "已连接" }}</b></div>
        <div class="status-row"><span>路由</span><b>{{ store.selectedGateway ? store.configNameFor(store.selectedGateway) : "-" }}</b></div>
        <div class="status-row"><span>人格</span><b>{{ store.selectedGateway?.agentRoleId || "-" }}</b></div>
        <div class="status-row"><span>Agent 线程</span><b>{{ store.selectedGateway?.codexThreadName || "-" }}</b></div>
        <div class="status-row"><span>配置目录</span><b>{{ store.configFiles.routeDir || "data/route" }}</b></div>
      </v-card>
    </div>

    <div class="two-column">
      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">Rabi 实例</div>
            <div class="section-note">保存到 data/Config.json，作为这台 Rabi PC 的全局身份。</div>
          </div>
          <v-btn color="primary" size="small" :loading="rabiSaving" @click="saveRabiIdentity">保存</v-btn>
        </div>
        <v-alert v-if="rabiError" type="error" variant="tonal" density="compact" class="mb-3">{{ rabiError }}</v-alert>
        <v-alert v-if="rabiSaved" type="success" variant="tonal" density="compact" class="mb-3">已保存 Rabi 实例配置。</v-alert>
        <div class="form-grid">
          <v-text-field v-model="rabiName" label="RabiRoute 实例名" :placeholder="store.meta.computerName || 'RabiRoute'" density="compact" hide-details />
          <v-text-field :model-value="store.meta.rabiGuid || '-'" label="RabiRoute GUID" density="compact" readonly hide-details />
        </div>
        <v-divider class="my-4" />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">RabiLink Relay</div>
            <div class="section-note">全局上游服务器配置。启用状态由服务器应用管理。</div>
          </div>
        </div>
        <div class="form-grid">
          <v-text-field v-model="rabiLinkRelayDeviceId" label="本机 Rabi PC 标识" :placeholder="store.meta.computerName || 'rabilink-pc'" density="compact" hide-details />
          <v-text-field v-model="rabiLinkRelayUrl" label="Relay 服务器地址" placeholder="https://rabiroute.example.com" density="compact" hide-details />
          <v-text-field v-model="rabiLinkRelayAppToken" label="Relay 应用 token" placeholder="X-RabiLink-Token" type="password" density="compact" hide-details />
          <v-text-field v-model.number="rabiLinkRelayClaimWaitMs" label="领取任务等待毫秒" type="number" min="0" max="60000" step="1000" density="compact" hide-details />
          <v-text-field v-model.number="rabiLinkRelayReplyIdleTimeoutMs" label="回复空闲超时毫秒" type="number" min="1000" max="120000" step="1000" density="compact" hide-details />
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">目录配置</div>
            <div class="section-note">全局目录设置，影响所有路由。修改后重启 Manager 生效。</div>
          </div>
          <v-btn color="primary" size="small" :loading="dirSaving" @click="saveDirConfig">保存</v-btn>
        </div>
        <v-alert v-if="dirError" type="error" variant="tonal" density="compact" class="mb-3">{{ dirError }}</v-alert>
        <v-alert v-if="dirSaved" type="success" variant="tonal" density="compact" class="mb-3">已保存，重启生效。</v-alert>
        <div class="form-grid">
          <v-text-field v-model="routeDir" label="路由数据目录" placeholder="data/route" density="compact" hide-details />
          <v-text-field v-model="rolesDir" label="角色目录" placeholder="data/roles" density="compact" hide-details />
        </div>
      </v-card>
    </div>
  </div>
</template>
