<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import type { AgentAdapterType, AgentScanResult, AgentScanSession } from "../../../../../ribiwebgui/src/types";
import type { AgentAdapterCardContext } from '../../../../../ribiwebgui/src/agentAdapters/agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const agentScan = computed(() => props.context.scanState);

function touch(): void { props.context.touch(); }

async function runAgentScan(): Promise<void> { await props.context.refreshScan(); }

function normalizeClientPath(value?: string): string {
  return (value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left?: string, right?: string): boolean {
  const a = normalizeClientPath(left);
  const b = normalizeClientPath(right);
  return Boolean(a && b && a === b);
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined { return agentScan.value.agents[type]; }

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

function agentProjectItems(type: AgentAdapterType): string[] {
  const projects = agentScanFor(type)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(_type: AgentAdapterType): AgentScanSession[] {
  return agentScan.value.agents.workbuddy?.sessions ?? [];
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
</script>
<template>
  <div v-if="gateway">
<v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过会话网关投递到本机 WorkBuddy 的<b>已有任务</b>：任务 ID 就是路由键，同一任务续投不会新建任务，消息由该任务的 WorkBuddy owner 执行。
                  </v-alert><v-alert type="warning" variant="tonal" density="compact" class="mb-2">
                    需要一次性录入本机网关凭据（<code>data/workbuddy-auth.json</code>）。凭据缺失、任务所属进程已退出或任务 ID 已归档时会明确失败，不会改投其它 Agent。
                  </v-alert><div class="catalog-param-grid">
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
                  </div><div class="mt-2">
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
  </div>
</template>
