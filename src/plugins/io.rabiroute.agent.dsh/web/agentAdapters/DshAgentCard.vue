<script setup lang="ts">
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, ref } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import DshConnectionPanel from "../components/DshConnectionPanel.vue";
import { resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import type { AgentAdapterType, AgentScanResult, AgentScanSession } from "../../../../../ribiwebgui/src/types";
import { dshModelPickerItems, dshModelValue, parseDshModelValue, reasoningEffortPickerItems } from "../../../../../ribiwebgui/src/agentModelPicker";
import { initializeAgentSessionForRoute } from "@shared/codexSessionInitialization";
import type { AgentAdapterCardContext, AgentCardScanOptions } from '../../../../../ribiwebgui/src/agentAdapters/agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const agentScan = computed(() => props.context.scanState);

const dshScanLoading = computed(() => props.context.scanState.loading);

function touch(): void { props.context.touch(); }

async function runDshAgentScan(options: AgentCardScanOptions = {}): Promise<void> { await props.context.refreshScan(options); }

const codexBinding = ref({ loading: false, error: "", pending: false });

const managedAgentSessionAction = ref({ loading: false, message: "", error: "" });

const dshModelItems = computed(() => dshModelPickerItems(agentScan.value.agents.dsh?.models ?? []));

const configuredDshModelValue = computed(() => dshModelValue(
  gateway.value?.dshModelProvider,
  gateway.value?.dshModel
));

const dshReasoningEffortItems = computed(() => reasoningEffortPickerItems(
  agentScan.value.agents.dsh?.models ?? [],
  gateway.value?.dshModel,
  gateway.value?.dshModelProvider
));

function selectDshModel(value: unknown): void {
  if (!gateway.value) return;
  const parsed = parseDshModelValue(value, agentScan.value.agents.dsh?.models ?? []);
  gateway.value.dshModelProvider = parsed.provider;
  gateway.value.dshModel = parsed.model;
  const selected = agentScan.value.agents.dsh?.models?.find(model => (
    model.provider === parsed.provider && model.id === parsed.model
  ));
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!gateway.value.dshReasoningEffort || !efforts.includes(gateway.value.dshReasoningEffort))) {
    gateway.value.dshReasoningEffort = selected.defaultReasoningEffort || "";
  }
  touch();
}

function normalizeClientPath(value?: string): string {
  return (value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left?: string, right?: string): boolean {
  const a = normalizeClientPath(left);
  const b = normalizeClientPath(right);
  return Boolean(a && b && a === b);
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined { return agentScan.value.agents[type]; }

function fallbackCodexThreadName(): string {
  if (!gateway.value) return "RabiRoute";
  return gateway.value.routeName || gateway.value.name || store.configNameFor(gateway.value) || gateway.value.id || "RabiRoute";
}

function agentProjectItems(type: AgentAdapterType): string[] {
  const projects = agentScanFor(type)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(_type: AgentAdapterType): AgentScanSession[] {
  return agentScan.value.agents.dsh?.sessions ?? [];
}

function dshSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  return agentSessions("dsh")
    .filter((session) => session.id)
    .filter((session) => !gateway.value?.dshCwd || !session.projectPath || samePath(session.projectPath, gateway.value.dshCwd))
    .map((session) => ({
      title: session.name,
      value: session.id!,
      subtitle: [session.projectPath, session.updatedAt].filter(Boolean).join(" · ")
    }));
}

function selectDshSession(value: unknown): void {
  if (!gateway.value) return;
  const raw = String(value || "").trim();
  const selected = agentSessions("dsh").find((session) => session.id === raw);
  if (selected?.id) {
    gateway.value.dshSessionId = selected.id;
    gateway.value.dshSessionName = selected.name;
    if (selected.projectPath) gateway.value.dshCwd = selected.projectPath;
  } else {
    gateway.value.dshSessionId = "";
    gateway.value.dshSessionName = raw;
  }
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

function managedAgentSessionContext(type: AgentAdapterType) {
  if (!gateway.value || type !== "dsh") return null;
  return { agentAdapter: "dsh" as const, sessionId: String(gateway.value.dshSessionId || "").trim(),
    sessionName: String(gateway.value.dshSessionName || fallbackCodexThreadName()).trim(), workspace: String(gateway.value.dshCwd || "").trim(),
    dshBaseUrl: String(gateway.value.dshBaseUrl || "").trim() || undefined };
}

function hasManagedAgentSessionBinding(type: "codex" | "dsh"): boolean {
  const session = managedAgentSessionContext(type);
  return Boolean(session?.sessionId && session.workspace);
}

async function openManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (managedAgentSessionAction.value.loading) return;
  const session = managedAgentSessionContext(agentAdapter);
  if (!session?.sessionId || !session.workspace) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await postAgentThreadAction({
      action: "open",
      agentAdapter: session.agentAdapter,
      threadId: session.sessionId,
      cwd: session.workspace,
      ...(session.dshBaseUrl ? { dshBaseUrl: session.dshBaseUrl } : {})
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh" ? "已在 DSH 中定位主角色会话。" : "已在 Codex Desktop 中定位主角色任务。",
      error: ""
    };
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: userFacingError(error)
    };
  }
}

async function initializeManagedAgentSession(agentAdapter: "codex" | "dsh"): Promise<void> {
  if (!gateway.value || managedAgentSessionAction.value.loading) return;
  managedAgentSessionAction.value = { loading: true, message: "", error: "" };
  try {
    await initializeAgentSessionForRoute({
      agentAdapter,
      save: () => store.save(props.context.routeId),
      currentGatewayId: () => store.selectedGateway?.id || "",
      deliver: async ({ gatewayId, text }) => {
        const response = await fetch("/api/role-panel/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayId, text, attachments: [] })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.code !== 0) {
          throw new Error(body.message || "角色初始化消息投递失败。");
        }
      }
    });
    managedAgentSessionAction.value = {
      loading: false,
      message: agentAdapter === "dsh"
        ? "已保存名称 + 会话 ID，并通过 DSH owner 投递角色初始化消息。"
        : "已保存名称 + 线程 ID，并通过 Desktop owner 投递角色初始化消息。",
      error: ""
    };
    await store.load();
  } catch (error) {
    managedAgentSessionAction.value = {
      loading: false,
      message: "",
      error: userFacingError(error)
    };
  }
}

async function postAgentThreadAction(payload: Record<string, unknown>, target?: ReturnType<typeof resolvePrimaryAgentTarget>): Promise<Record<string, any>> {
  return postRouteAgentThreadAction(payload, target, { accessToken: managerAccessToken });
}
</script>
<template>
  <div v-if="gateway">
<v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    RabiRoute 通过 DSH apiproxy 发现、创建、重命名、绑定和续投会话。实际消息由同一个 DSH session owner 执行；失败时不会改投 Codex。
                  </v-alert><DshConnectionPanel :base-url="gateway.dshBaseUrl" @update:base-url="gateway.dshBaseUrl = $event; touch()" /><div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.dshAgentPreset"
                      :items="agentScanFor('dsh')?.agentPresets?.filter(preset => !preset.broken).map(preset => ({ title: preset.name || preset.id, value: preset.id })) ?? []"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="会话模式"
                      hint="保存时同步到 DSH。已有对话的会话不能切换模式，请选择新会话；留空沿用当前模式。"
                      persistent-hint
                      clearable
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.dshBaseUrl"
                      :items="agentScanFor('dsh')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="DSH 地址"
                      hint="留空时按本机 DSH 启动日志自动发现；写死的默认端口不是安装状态。修改地址后请重新验证连接，再扫描会话。"
                      persistent-hint
                      data-no-i18n
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="按当前地址扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="configuredDshModelValue"
                      :items="dshModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主角色模型"
                      placeholder="provider/model"
                      hint="DSH 可用时读取模型目录；读取失败时可手动输入 provider/model。配置会在主角色下一次投递前应用到绑定会话。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectDshModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      v-model="gateway.dshReasoningEffort"
                      :items="dshReasoningEffortItems"
                      label="主角色推理强度"
                      hint="优先显示所选 DSH 模型支持的值；目录不可用时可以手动输入。留空则沿用模型或 DSH 当前默认值。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox
                      v-model="gateway.dshCwd"
                      :items="agentProjectItems('dsh')"
                      label="工作目录"
                      placeholder="C:/Path/To/Project"
                      hint="用于同名会话消歧和新建；选择已有会话时自动采用会话目录"
                      persistent-hint
                      @update:model-value="touch"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('dsh').length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>
                    <v-combobox
                      :model-value="gateway.dshSessionId || gateway.dshSessionName"
                      :items="dshSessionItems()"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="DSH 会话"
                      placeholder="选择已有会话，或输入新会话名"
                      hint="选择后保存完整 ID、名称和工作目录；输入新名称会清空旧 ID，保存时查找或只创建一次"
                      persistent-hint
                      @update:model-value="selectDshSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="dshScanLoading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="dshSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" title="扫描" @click.stop="runDshAgentScan" />
                      </template>
                    </v-combobox>

                  </div><div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('dsh')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('dsh')"
                    >
                      定位会话
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-account-sync-outline"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="initializeManagedAgentSession('dsh')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 DSH 会话；未绑定时可初始化会话。</span>
                  </div><v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert><v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert><div class="mt-2">
                    <div class="status-row">
                      <span>会话发现</span>
                      <b :class="dshSessionItems().length ? 'text-success' : 'text-warning'">{{ dshSessionItems().length ? `可选 ${dshSessionItems().length} 个` : '未读取到会话' }}</b>
                    </div>
                    <div class="status-row">
                      <span>项目发现</span>
                      <b :class="agentProjectItems('dsh').length ? 'text-success' : 'text-warning'">{{ agentProjectItems('dsh').length ? `可选 ${agentProjectItems('dsh').length} 个` : '未读取到项目目录' }}</b>
                    </div>
                    <div class="status-row">
                      <span>投递协议</span>
                      <b>session.prompt · mode=queue</b>
                    </div>
                  </div>
  </div>
</template>
