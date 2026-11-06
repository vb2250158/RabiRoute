<script setup lang="ts">
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, ref } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import type { AgentAdapterType, AgentScanResult, AgentScanSession } from "../../../../../ribiwebgui/src/types";
import { codexModelPickerItems, reasoningEffortPickerItems } from "../../../../../ribiwebgui/src/agentModelPicker";
import { initializeAgentSessionForRoute } from "@shared/codexSessionInitialization";
import { codexThreadItems, selectCodexThread, type CodexThreadSummary } from "@shared/codexThreadSelection";
import type { AgentAdapterCardContext } from '../../../../../ribiwebgui/src/agentAdapters/agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const runtime = computed(() => props.context.runtime);

const agentScan = computed(() => props.context.scanState);

const agent = { type: "codex" as AgentAdapterType };

function touch(): void { props.context.touch(); }

async function runAgentScan(): Promise<void> { await props.context.refreshScan(); }

const codexBinding = ref({ loading: false, error: "", pending: false });

const managedAgentSessionAction = ref({ loading: false, message: "", error: "" });

const codexModelItems = computed(() => codexModelPickerItems(agentScan.value.agents.codex?.models ?? []));

const codexReasoningEffortItems = computed(() => {
  const discovered = reasoningEffortPickerItems(
    agentScan.value.agents.codex?.models ?? [],
    gateway.value?.agentModel
  );
  return discovered.length > 0 ? discovered : ["low", "medium", "high", "xhigh", "max"];
});

function selectCodexModel(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.agentModel = String(value || "").trim();
  const selected = agentScan.value.agents.codex?.models?.find(model => model.id === gateway.value?.agentModel);
  const efforts = selected?.reasoningEfforts?.map(effort => effort.id) ?? [];
  if (selected && (!gateway.value.agentReasoningEffort || !efforts.includes(gateway.value.agentReasoningEffort))) {
    gateway.value.agentReasoningEffort = selected.defaultReasoningEffort as typeof gateway.value.agentReasoningEffort;
  }
  touch();
}

const primaryAgent = computed(() => gateway.value ? resolvePrimaryAgentTarget(gateway.value) : undefined);

const primaryLocalAgentType = computed(() => primaryAgent.value?.binding ? undefined : primaryAgent.value?.provider);

function agentStateFor(type: AgentAdapterType): Record<string, any> {
  // Provider-only runtime state belongs to the selected owner, not every same-provider card.
  if (primaryAgent.value?.binding || primaryLocalAgentType.value !== type) return {};
  return runtime.value.agentStates?.[type] ?? {};
}

function codexDeliveryChannelLabel(state: Record<string, any>): string {
  if (state.lastDeliveryChannel === "desktop-ipc") return "Codex Desktop IPC";
  return "-";
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
  return agentScan.value.agents.codex?.sessions ?? agentScan.value.threadNames.map(name => ({ name }));
}

function codexSessionItems(): Array<{ title: string; value: string }> {
  return codexThreadItems(codexThreadSummaries());
}

function codexThreadSummaries(): CodexThreadSummary[] {
  return agentSessions("codex")
    .filter(session => session.id)
    .map(session => ({
      id: session.id!,
      title: session.name,
      updatedAt: session.updatedAt,
      cwd: session.projectPath
    }));
}

function managedAgentSessionContext(type: AgentAdapterType) {
  if (!gateway.value || type !== "codex") return null;
  return { agentAdapter: "codex" as const, sessionId: String(gateway.value.codexThreadId || "").trim(),
    sessionName: String(gateway.value.codexThreadName || fallbackCodexThreadName()).trim(), workspace: String(gateway.value.codexCwd || "").trim(),
    dshBaseUrl: undefined as string | undefined };
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

function selectCodexSession(value: unknown): void {
  if (!gateway.value) return;
  const selection = selectCodexThread(value, codexThreadSummaries());
  gateway.value.codexThreadId = selection.threadId;
  gateway.value.codexThreadName = selection.threadName;
  if (selection.selected?.cwd) gateway.value.codexCwd = selection.selected.cwd;
  codexBinding.value.error = "";
  codexBinding.value.pending = false;
  touch();
}

async function lookupCodexThreadBinding(): Promise<void> {
  if (!gateway.value || codexBinding.value.loading) return;
  const title = gateway.value.codexThreadName?.trim() || fallbackCodexThreadName();
  codexBinding.value = { loading: true, error: "", pending: false };
  try {
    const response = await fetch("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        threadId: gateway.value.codexThreadId || undefined,
        title,
        cwd: gateway.value.codexCwd || undefined,
        createIfMissing: false
      })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && body.resolution === "missing") {
      gateway.value.codexThreadId = "";
      codexBinding.value.pending = true;
      touch();
      return;
    }
    if (!response.ok || !body.thread?.id) {
      throw new Error(body.message || "无法查找 Codex Desktop 会话。");
    }
    gateway.value.codexThreadId = body.thread.id;
    gateway.value.codexThreadName = body.thread.title || title;
    if (body.thread.cwd) gateway.value.codexCwd = body.thread.cwd;
    touch();
  } catch (error) {
    codexBinding.value.error = userFacingError(error);
  } finally {
    codexBinding.value.loading = false;
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
                    实际消息只交给 Codex/ChatGPT Desktop 当前任务执行，因此桌面端会立即显示消息并沿用该任务的工具、模型与权限。Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime。
                  </v-alert><div class="catalog-param-grid">
                    <v-combobox
                      :model-value="gateway.agentModel"
                      :items="codexModelItems"
                      item-title="title"
                      item-value="value"
                      :return-object="false"
                      label="主角色模型"
                      hint="Desktop 可用时读取当前账号的模型目录；读取失败时仍可手动输入。留空则沿用目标任务自己的模型。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="selectCodexModel"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新读取模型" @click.stop="runAgentScan" />
                      </template>
                    </v-combobox>
                    <v-select
                      v-model="gateway.agentReasoningEffort"
                      :items="codexReasoningEffortItems"
                      label="主角色推理强度"
                      hint="与主角色模型一起应用到 Desktop 新轮次；留空时沿用 Desktop 当前设置。"
                      persistent-hint
                      clearable
                      data-no-i18n
                      @update:model-value="touch"
                    />
                    <v-combobox v-model="gateway.codexCwd" :items="agentProjectItems('codex')" label="工作目录" placeholder="留空，使用 RabiRoute 根目录" hint="用于同名任务的自动查找和新建；选择已有任务时会自动采用任务自己的目录" persistent-hint @update:model-value="touch">
                    </v-combobox>
                    <v-combobox :model-value="gateway.codexThreadId || gateway.codexThreadName" :items="codexSessionItems()" item-title="title" item-value="value" :return-object="false" label="会话名 + 最后会话时间" placeholder="选择已有会话，或输入新会话名" hint="每次读取 200 个 Desktop 任务且不显示 ID；可继续加载，输入名称后只查找，唯一匹配就绑定，没有匹配则在点击保存时创建" persistent-hint @update:model-value="selectCodexSession" @blur="lookupCodexThreadBinding">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading || codexBinding.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="codexSessionItems().length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>

                  </div><div class="d-flex align-center ga-2 flex-wrap mt-2">
                    <v-btn
                      v-if="hasManagedAgentSessionBinding('codex')"
                      color="primary"
                      variant="tonal"
                      prepend-icon="mdi-crosshairs-gps"
                      :loading="managedAgentSessionAction.loading"
                      :disabled="managedAgentSessionAction.loading"
                      @click="openManagedAgentSession('codex')"
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
                      @click="initializeManagedAgentSession('codex')"
                    >
                      自动初始化会话
                    </v-btn>
                    <span class="section-note">已有完整 ID 和工作目录时可定位原 Desktop 任务；未绑定时可初始化会话。</span>
                  </div><v-alert v-if="managedAgentSessionAction.error" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.error }}
                  </v-alert><v-alert v-else-if="managedAgentSessionAction.message" type="success" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ managedAgentSessionAction.message }}
                  </v-alert><v-alert v-if="codexBinding.error" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                    {{ codexBinding.error }}
                  </v-alert><v-alert v-else-if="codexBinding.pending" type="info" variant="tonal" density="compact" class="mt-2 mb-1">
                    尚无同名 Desktop 会话；点击保存时会创建任务、写入完整 ID 并切换绑定。
                  </v-alert><template v-if="runtime.running !== undefined">
                    <v-alert v-if="agentStateFor('codex').lastNotificationError" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').lastNotificationError }}
                    </v-alert>
                    <v-alert v-else-if="agentStateFor('codex').message" type="warning" variant="tonal" density="compact" class="mt-2 mb-1">
                      {{ agentStateFor('codex').message }}
                    </v-alert>
                    <div class="status-row mt-1"><span>连接状态</span><b :class="agentStateFor('codex').monitorThreadId ? 'text-success' : 'text-warning'">{{ agentStateFor('codex').monitorThreadId ? '已绑定' : '未绑定' }}</b></div>
                    <div class="status-row"><span>线程名</span><b>{{ agentStateFor('codex').monitorThreadName || "-" }}</b></div>
                    <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('codex').lastNotificationAt || "-" }}</b></div>
                    <div class="status-row"><span>投递协议</span><b>{{ codexDeliveryChannelLabel(agentStateFor('codex')) }}</b></div>
                    <div class="status-row"><span>桌面宿主</span><b>Codex/ChatGPT Desktop（必需）</b></div>
                  </template>
  </div>
</template>
