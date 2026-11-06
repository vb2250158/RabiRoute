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
  return agentScan.value.agents.antigravity?.sessions ?? [];
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
</script>
<template>
  <div v-if="gateway">
<v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过 Antigravity 官方 <code>agy agentapi</code> 投递到本机<b>已有会话</b>：会话 ID 就是路由键，同一会话续投不会新建会话。
                  </v-alert><v-alert type="warning" variant="tonal" density="compact" class="mb-2">
                    需要 Antigravity 桌面正在运行：language server 端口按进程动态发现，CSRF 令牌从桌面启动日志读取，均无需手工填写。会话 ID 留空时每次投递都会新开会话。
                  </v-alert><div class="catalog-param-grid">
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
                  </div><div class="mt-2">
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
  </div>
</template>
