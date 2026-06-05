<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import {
  adapterConnectionReasons,
  adapterLabel,
  agentConnectionReasons,
  gatewayAdapterTypes
} from "../utils/gatewayHelpers";

const store = useGatewayStore();
const gateway = computed(() => store.selectedGateway);
const runtime = computed(() => store.selectedRuntime);
const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);
const adapterReasons = computed(() => gateway.value ? adapterConnectionReasons(gateway.value, runtime.value, adapters.value) : []);
const agentReasons = computed(() => gateway.value ? agentConnectionReasons(gateway.value, runtime.value) : []);
const napcatState = computed(() => runtime.value.gatewayStatus?.napcat || {});
const heartbeatState = computed(() => runtime.value.gatewayStatus?.heartbeat || {});
const agentState = computed(() => runtime.value.codexState || {});
const logs = computed(() => (runtime.value.log || []).slice(-30).join("\n") || "暂无日志");

const adapterText = computed(() => {
  if (adapters.value.includes("disabled")) return "已禁用";
  if (adapters.value.includes("napcat") && !napcatState.value.connected && napcatState.value.loginInfoError) return "NapCat 异常";
  if (adapters.value.includes("napcat") && !napcatState.value.connected) return "WS 未连接";
  if (adapters.value.includes("napcat") && napcatState.value.loginInfoError) return "HTTP 异常";
  return "已启用";
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">运行日志</h1>
        <div class="page-subtitle">查看 Gateway 进程、消息端连接和 Agent 投递状态。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap" v-if="gateway">
        <v-btn prepend-icon="mdi-play" variant="tonal" @click="store.actionGateway(gateway.id, 'start')">启动</v-btn>
        <v-btn prepend-icon="mdi-stop" variant="tonal" @click="store.actionGateway(gateway.id, 'stop')">停止</v-btn>
        <v-btn prepend-icon="mdi-restart" color="primary" @click="store.actionGateway(gateway.id, 'restart')">重启</v-btn>
        <v-btn prepend-icon="mdi-delete" color="error" variant="text" @click="store.removeGateway(gateway.id)">删除</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="overview-grid">
        <v-card class="app-card glass-card stat-card">
          <div class="stat-label">运行状态</div>
          <div class="stat-value">{{ runtime.running ? "运行中" : "已停止" }}</div>
          <div class="stat-note">PID {{ runtime.pid || "-" }}</div>
        </v-card>
        <v-card class="app-card glass-card stat-card">
          <div class="stat-label">消息端</div>
          <div class="stat-value">{{ adapterText }}</div>
          <div class="stat-note">{{ adapters.map(adapterLabel).join(" + ") }}</div>
        </v-card>
        <v-card class="app-card glass-card stat-card">
          <div class="stat-label">Agent</div>
          <div class="stat-value">{{ agentState.monitorThreadId ? "已连接" : "未绑定" }}</div>
          <div class="stat-note">{{ agentState.monitorThreadName || gateway.codexThreadName || "-" }}</div>
        </v-card>
        <v-card class="app-card glass-card stat-card">
          <div class="stat-label">通知数</div>
          <div class="stat-value">{{ agentState.notificationCount || 0 }}</div>
          <div class="stat-note">最后成功 {{ agentState.lastNotificationAt || "-" }}</div>
        </v-card>
      </div>

      <div class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">消息端连接</div>
              <div class="section-note">当前类型：{{ adapters.map(adapterLabel).join(" + ") }}</div>
            </div>
            <v-chip :color="adapterReasons.length ? 'error' : 'success'" variant="tonal">{{ adapterText }}</v-chip>
          </div>
          <v-alert v-if="adapterReasons.length" type="error" variant="tonal" class="mb-3">
            <div v-for="reason in adapterReasons" :key="reason">原因：{{ reason }}</div>
          </v-alert>
          <template v-if="adapters.includes('napcat')">
            <div class="status-row"><span>HTTP</span><b>{{ gateway.napcatHttpUrl || runtime.napcatHttpUrl || "-" }}</b></div>
            <div class="status-row"><span>WS</span><b>ws://127.0.0.1:{{ gateway.gatewayPort || runtime.gatewayPort || "-" }}</b></div>
            <div class="status-row"><span>远端</span><b>{{ napcatState.remoteAddress || "-" }}</b></div>
            <div class="status-row"><span>最后连接</span><b>{{ napcatState.lastConnectedAt || "-" }}</b></div>
            <div class="status-row"><span>最后断开</span><b>{{ napcatState.lastDisconnectedAt || "-" }}</b></div>
            <div class="status-row"><span>登录资料</span><b>{{ napcatState.loginInfoError || napcatState.lastLoginInfoAt || "未验证" }}</b></div>
          </template>
          <template v-if="adapters.includes('heartbeat')">
            <div class="status-row"><span>间隔</span><b>{{ gateway.heartbeatIntervalSeconds || runtime.heartbeatIntervalSeconds || 900 }} 秒</b></div>
            <div class="status-row"><span>状态</span><b>{{ heartbeatState.enabled === false ? "未启用" : "已启用" }}</b></div>
          </template>
          <template v-if="adapters.includes('webhook')">
            <div class="status-row"><span>地址</span><b>http://127.0.0.1:{{ gateway.webhookPort || gateway.gatewayPort }}{{ gateway.webhookPath || "/webhook" }}</b></div>
          </template>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">Agent 连接</div>
              <div class="section-note">按线程名绑定 Codex / Agent 会话。</div>
            </div>
            <v-chip :color="agentReasons.length ? 'warning' : 'success'" variant="tonal">{{ agentState.monitorThreadId ? "已连接" : "未绑定" }}</v-chip>
          </div>
          <v-alert v-if="agentReasons.length" type="warning" variant="tonal" class="mb-3">
            <div v-for="reason in agentReasons" :key="reason">原因：{{ reason }}</div>
          </v-alert>
          <div class="status-row"><span>会话 ID</span><b>{{ agentState.monitorThreadId || "-" }}</b></div>
          <div class="status-row"><span>线程名</span><b>{{ agentState.monitorThreadName || gateway.codexThreadName || "-" }}</b></div>
          <div class="status-row"><span>自动发现</span><b>{{ agentState.lastAutoDiscoveryAt || "-" }}</b></div>
          <div class="status-row"><span>最后成功</span><b>{{ agentState.lastNotificationAt || "-" }}</b></div>
          <div class="status-row"><span>来源</span><b>{{ agentState.monitorThreadSource || "-" }}</b></div>
          <div class="status-row"><span>状态文件</span><b>{{ agentState.statePath || "-" }}</b></div>
          <div v-if="agentState.lastNotificationError" class="status-row"><span>最后错误</span><b>{{ agentState.lastNotificationError }}</b></div>
        </v-card>
      </div>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">最近日志</div>
            <div class="section-note">最近 30 行 gateway 输出。</div>
          </div>
          <v-btn prepend-icon="mdi-refresh" variant="tonal" @click="store.load">刷新</v-btn>
        </div>
        <pre class="mono-box">{{ logs }}</pre>
      </v-card>
    </template>
  </div>
</template>
