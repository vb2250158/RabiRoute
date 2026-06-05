<script setup lang="ts">
import { computed, ref } from "vue";
import QuickSetupDialog from "../components/QuickSetupDialog.vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { adapterLabel, gatewayAdapterTypes } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const quickSetupOpen = ref(false);

const selectedRuntime = computed(() => store.selectedRuntime);
const adapterHealth = computed(() => {
  const gateway = store.selectedGateway;
  if (!gateway) return "未选择";
  const runtime = selectedRuntime.value;
  const adapters = gatewayAdapterTypes(gateway);
  const napcat = runtime.gatewayStatus?.napcat || {};
  if (adapters.includes("disabled")) return "已禁用";
  if (adapters.includes("napcat") && !napcat.connected) return "WS 未连接";
  if (adapters.includes("napcat") && napcat.loginInfoError) return "HTTP 异常";
  return "已启用";
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">消息分诊控制台</h1>
        <div class="page-subtitle">查看 RabiRoute 的入口、模板、运行态和 Agent 绑定情况。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap">
        <v-btn prepend-icon="mdi-lightning-bolt-outline" color="secondary" variant="tonal" @click="quickSetupOpen = true">快速配置</v-btn>
        <v-btn prepend-icon="mdi-play-circle-outline" variant="tonal" @click="store.startManager">启动 Manager</v-btn>
      </div>
    </div>

    <div class="overview-grid">
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">路由配置</div>
        <div class="stat-value">{{ store.gateways.length }}</div>
        <div class="stat-note">当前 manager 管理的 gateway 数量</div>
      </v-card>
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">运行中</div>
        <div class="stat-value">{{ store.runningCount }}/{{ store.gateways.length }}</div>
        <div class="stat-note">已启动的路由进程</div>
      </v-card>
      <v-card class="app-card glass-card stat-card">
        <div class="stat-label">消息端健康</div>
        <div class="stat-value">{{ adapterHealth }}</div>
        <div class="stat-note">{{ store.selectedGateway ? gatewayAdapterTypes(store.selectedGateway).map(adapterLabel).join(" + ") : "选择一个路由查看" }}</div>
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
          <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="store.addGateway">新增</v-btn>
        </div>
        <v-list bg-color="transparent">
          <v-list-item
            v-for="gateway in store.gateways"
            :key="gateway.id"
            rounded="lg"
            :active="gateway.id === store.selectedGatewayId"
            @click="store.selectGateway(gateway.id)"
          >
            <template #prepend>
              <v-avatar color="secondary" variant="tonal" size="36">
                <v-icon>mdi-routes</v-icon>
              </v-avatar>
            </template>
            <v-list-item-title class="font-weight-bold">{{ store.configNameFor(gateway) }}</v-list-item-title>
            <v-list-item-subtitle>
              人格 {{ gateway.agentRoleId || "未选择" }} · {{ gatewayAdapterTypes(gateway).map(adapterLabel).join(" + ") }}
            </v-list-item-subtitle>
            <template #append>
              <v-chip size="small" :color="store.runtimeFor(gateway.id).running ? 'success' : 'error'" variant="tonal">
                {{ store.runtimeFor(gateway.id).running ? "运行中" : "已停止" }}
              </v-chip>
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
        <div class="status-row"><span>配置目录</span><b>{{ store.configFiles.routeRoot || store.configFiles.manager || "data/route" }}</b></div>
      </v-card>
    </div>

    <QuickSetupDialog v-model="quickSetupOpen" />
  </div>
</template>
