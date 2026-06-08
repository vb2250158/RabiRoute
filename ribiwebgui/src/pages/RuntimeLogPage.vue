<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import {
  adapterConnectionReasons,
  adapterDefaultWebhookPath,
  adapterLabel,
  agentConnectionReasons,
  gatewayAdapterTypes,
  isWebhookLikeAdapter,
  isMessageInputsDisabled,
  routeKindLabels
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
const triggeringRuleId = ref("");
const triggerableRules = computed(() => {
  return (gateway.value?.notificationRules || [])
    .filter(rule => Array.isArray(rule.routeKinds) && rule.routeKinds.some(kind => kind === "manual_trigger" || kind === "heartbeat"))
    .map(rule => {
      const routeKind: "manual_trigger" | "heartbeat" = rule.routeKinds?.includes("manual_trigger") ? "manual_trigger" : "heartbeat";
      return {
        ...rule,
        routeKind,
        displayName: rule.name || rule.id,
        routeKindLabel: routeKindLabels[routeKind] || routeKind
      };
    });
});
const diagnosisItems = computed(() => [
  ...adapterReasons.value.map(reason => ({ type: "消息端", reason })),
  ...agentReasons.value.map(reason => ({ type: "Agent", reason }))
]);

const adapterText = computed(() => {
  if (gateway.value?.enabled === false || runtime.value.enabled === false) return "已关闭";
  if (gateway.value && isMessageInputsDisabled(gateway.value)) return "已禁用";
  if (!runtime.value.running) return "已停止";
  if (adapters.value.includes("napcat") && !napcatState.value.connected && napcatState.value.loginInfoError) return "NapCat 异常";
  if (adapters.value.includes("napcat") && !napcatState.value.connected) return "WS 未连接";
  if (adapters.value.includes("napcat") && napcatState.value.loginInfoError) return "HTTP 异常";
  return "已启用";
});

const adapterChipColor = computed(() => {
  if (gateway.value?.enabled === false || runtime.value.enabled === false || (gateway.value && isMessageInputsDisabled(gateway.value))) return "grey";
  return adapterReasons.value.length ? "error" : "success";
});

function webhookAddress(type: string): string {
  const port = type === "fennenote"
    ? gateway.value?.fenneNoteWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort
    : type === "xiaoai"
      ? gateway.value?.xiaoaiWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort
      : gateway.value?.webhookPort || gateway.value?.gatewayPort;
  const path = type === "fennenote"
    ? gateway.value?.fenneNoteWebhookPath || adapterDefaultWebhookPath(type)
    : type === "xiaoai"
      ? gateway.value?.xiaoaiWebhookPath || adapterDefaultWebhookPath(type)
      : gateway.value?.webhookPath || adapterDefaultWebhookPath(type);
  return `http://127.0.0.1:${port || 8790}${path}`;
}

const webhookLikeAdapters = computed(() => adapters.value.filter(isWebhookLikeAdapter));

async function triggerRule(rule: { id: string; displayName: string; routeKind: "manual_trigger" | "heartbeat" }): Promise<void> {
  if (!gateway.value) return;
  triggeringRuleId.value = rule.id;
  try {
    await store.manualTriggerGateway(gateway.value.id, {
      triggerId: rule.id,
      ruleId: rule.id,
      triggerName: rule.displayName,
      routeKind: rule.routeKind,
      message: `Manual trigger: ${rule.displayName} (${rule.id})`
    });
  } finally {
    triggeringRuleId.value = "";
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">日志诊断</h1>
        <div class="page-subtitle">先看连接诊断，再看运行细节和最近日志。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-btn prepend-icon="mdi-play" variant="tonal" @click="store.actionGateway(gateway.id, 'start')">启动</v-btn>
        <v-btn prepend-icon="mdi-stop" variant="tonal" @click="store.actionGateway(gateway.id, 'stop')">停止</v-btn>
        <v-btn prepend-icon="mdi-restart" color="primary" @click="store.actionGateway(gateway.id, 'restart')">重启</v-btn>
        <v-btn prepend-icon="mdi-delete" color="error" variant="text" @click="store.removeGateway(gateway.id)">删除</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">诊断摘要</div>
            <div class="section-note">先把需要处理的断点摆在前面。</div>
          </div>
          <v-chip :color="diagnosisItems.length ? 'warning' : 'success'" variant="tonal">
            {{ diagnosisItems.length ? `${diagnosisItems.length} 个待检查项` : "链路正常" }}
          </v-chip>
        </div>
        <div v-if="diagnosisItems.length" class="rule-list">
          <div v-for="item in diagnosisItems" :key="`${item.type}-${item.reason}`" class="rule-card">
            <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
              <div>
                <div class="font-weight-bold text-primary">{{ item.type }}</div>
                <div class="section-note mt-1">{{ item.reason }}</div>
              </div>
              <v-chip size="small" color="warning" variant="tonal">需要检查</v-chip>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <div>
            <strong>暂未发现明显断点</strong>
            <span>如果消息仍没有投递，请继续查看下方连接详情和最近日志。</span>
          </div>
        </div>
      </v-card>

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
            <v-chip :color="adapterChipColor" variant="tonal">{{ adapterText }}</v-chip>
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
          <template v-if="webhookLikeAdapters.length">
            <div v-for="type in webhookLikeAdapters" :key="type" class="status-row">
              <span>{{ adapterLabel(type) }}</span>
              <b>{{ webhookAddress(type) }}</b>
            </div>
          </template>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">Agent 连接</div>
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
            <div class="section-title">Manual Triggers</div>
            <div class="section-note">Run manual_trigger or heartbeat rules with their selected message template.</div>
          </div>
          <v-chip variant="tonal">{{ triggerableRules.length }}</v-chip>
        </div>
        <div v-if="triggerableRules.length" class="rule-list">
          <div v-for="rule in triggerableRules" :key="rule.id" class="rule-card">
            <div class="d-flex justify-space-between ga-3 align-center flex-wrap">
              <div>
                <div class="font-weight-bold text-primary">{{ rule.displayName }}</div>
                <div class="section-note mt-1">{{ rule.routeKindLabel }} / {{ rule.id }}</div>
              </div>
              <v-btn
                size="small"
                color="primary"
                prepend-icon="mdi-play-circle-outline"
                :loading="triggeringRuleId === rule.id"
                :disabled="rule.enabled === false || Boolean(triggeringRuleId)"
                @click="triggerRule(rule)"
              >Run</v-btn>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <div>
            <strong>No manual trigger rules</strong>
            <span>Add a manual_trigger or heartbeat rule in persona templates first.</span>
          </div>
        </div>
      </v-card>

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
