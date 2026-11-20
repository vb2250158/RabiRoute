<script setup lang="ts">
import AutomationParameterHelp from "./AutomationParameterHelp.vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, ref, watch } from "vue";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import type { GatewayDefinition } from "@shared/gatewayConfigModel";
import { AGENT_HOOK_EVENTS, AGENT_HOOK_CONDITIONS, agentHookEventsFor, agentHookRuleErrors, agentHookRuleEvents,
  type AgentCompletionDeliveryRule, type AgentHookCondition, type AgentHookSession } from "@shared/agentHookAutomation";
import AgentHookConditionDialog from "./AgentHookConditionDialog.vue";
import { usePersonaService } from "../persona/personaServiceClient";
import { completionTargetKey, completionTargetLabel, type completionTargetChoices } from "../persona/agentCompletionTargets";
import type { AutomationQqDirectory } from "../persona/automationRuleConversation";
const fetch = usePersonaService().fetch;

const props = defineProps<{ rule: AgentCompletionDeliveryRule; gateways: GatewayDefinition[]; agentType: AgentAdapterType;
  targets: ReturnType<typeof completionTargetChoices>; qqDirectories: readonly AutomationQqDirectory[] }>();
const emit = defineEmits<{ "update:rule": [value: AgentCompletionDeliveryRule] }>();
const projects = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
const sessions = ref<AgentHookSession[]>([]);
const sessionLoading = ref(false);
const nextSessionOffset = ref<number | null>(null);
const conditionDialog = ref(false);
const conditionIndex = ref(-1);
const editedCondition = computed(() => props.rule.conditions[conditionIndex.value]);
const usedConditionTypes = computed(() => props.rule.conditions.filter((_, index) => index !== conditionIndex.value).map(item => item.type));
function openCondition(index = -1) {
  error.value = "";
  conditionIndex.value = index;
  conditionDialog.value = true;
}
function saveCondition(value: AgentHookCondition) {
  if (usedConditionTypes.value.includes(value.type)) return;
  const conditions = [...props.rule.conditions];
  if (conditionIndex.value < 0) conditions.push(value); else conditions[conditionIndex.value] = value;
  update({ conditions });
  conditionDialog.value = false;
}
function conditionSummary(item: AgentHookCondition) {
  if (item.type === "project") return item.path || "尚未配置项目目录";
  if (item.type === "include_sessions" || item.type === "exclude_sessions") return item.sessions?.map(session => session.name || session.id).join("、") || "尚未选择聊天会话";
  if (item.type === "bound_plan") return "仅投递绑定当前角色计划的任务。";
  if (item.type === "exclude_heartbeat") return "跳过本轮完整心跳结果（含 NOTIFY）。";
  return AGENT_HOOK_CONDITIONS.find(option => option.value === item.type)?.description || item.type;
}
watch(() => props.agentType, () => { conditionDialog.value = false; projects.value = []; sessions.value = []; nextSessionOffset.value = null; });
async function scanSessions(more = false) {
  if (sessionLoading.value) return;
  sessionLoading.value = true; error.value = "";
  try {
    const type = props.agentType ?? "codex";
    const query = new URLSearchParams({ [`${type}Offset`]: String(more ? nextSessionOffset.value ?? 0 : 0), [`${type}Limit`]: "100" });
    const response = await fetch(`/api/scan/agents${type === "dsh" ? "/dsh" : ""}?${query}`); const data = await response.json();
    if (type !== (props.agentType ?? "codex")) return;
    if (!response.ok) throw new Error(data.message || "读取聊天会话失败");
    const agent = data.agents?.[type];
    if (!agent) throw new Error("所选 Agent 端未返回会话，请检查 Agent 端连接。");
    const found: AgentHookSession[] = (agent.sessions ?? []).filter((session: AgentHookSession) => session.id)
      .map((session: AgentHookSession) => ({ id: session.id, name: session.name || "未命名任务" }));
    sessions.value = [...new Map([...(more ? sessions.value : []), ...found].map(session => [session.id, session])).values()];
    nextSessionOffset.value = agent.sessionPage?.hasMore ? agent.sessionPage.nextOffset ?? null : null;
  } catch (cause) { error.value = userFacingError(cause); }
  finally { sessionLoading.value = false; }
}
const events = computed(() => agentHookRuleEvents(props.rule));
const supportedEvents = computed(() => agentHookEventsFor(props.agentType));
const eventChoices = computed(() => AGENT_HOOK_EVENTS.filter(event => supportedEvents.value.includes(event) || events.value.includes(event.value)));
function toggleEvent(event: string, selected: boolean) {
  const next = selected ? [...events.value, event] : events.value.filter(value => value !== event);
  update({ events: next, event: next[0] ?? "" });
}
const targetKey = computed(() => props.rule.destination.gatewayId || props.rule.destination.channel === "original_chat"
  ? completionTargetKey(props.rule.destination) : null);
const targetOptions = computed(() => {
  if (!targetKey.value || props.targets.some(item => item.value === targetKey.value)) return props.targets;
  const title = completionTargetLabel(props.rule.destination, props.gateways, props.qqDirectories);
  return [{ value: targetKey.value, title, destination: props.rule.destination }, ...props.targets];
});
const contentTypes = [{ title: "完整正文", value: "full" }, { title: "正文摘录（最多 500 字）", value: "excerpt" }];
const formatKeys = ["content", "includeAgentType", "includeTaskName", "includeFiles", "renderTables", "renderDiagrams",
  "markdownFilesAsImages", "imageFilesAsImages", "htmlFilesAsLinks"];
function chooseTarget(key: string) {
  const target = targetOptions.value.find(item => item.value === key)?.destination;
  if (!target || key === targetKey.value) return;
  const format = Object.fromEntries(Object.entries(props.rule.destination.params).filter(([name]) => formatKeys.includes(name)));
  update({ destination: { ...target, params: { ...target.params, ...format } } });
}
function update(patch: Partial<AgentCompletionDeliveryRule>) {
  const next = { ...props.rule, ...patch };
  if (agentHookRuleErrors(next).length) next.enabled = false;
  emit("update:rule", next);
}
function params(patch: Record<string, string>) {
  update({ destination: { ...props.rule.destination, params: { ...props.rule.destination.params, ...patch } } });
}
async function scanProjects() {
  loading.value = true; error.value = "";
  try {
    const type = props.agentType ?? "codex";
    const response = await fetch(type === "dsh" ? "/api/scan/agents/dsh" : "/api/scan/agents"); const data = await response.json();
    if (type !== (props.agentType ?? "codex")) return;
    if (!response.ok) throw new Error(data.message || "读取项目目录失败");
    const agent = data.agents?.[type];
    if (!agent) throw new Error("所选 Agent 端未返回项目，请检查 Agent 端连接。");
    const scanned: string[] = (agent.projects ?? []).map((item: { path?: string }) => String(item.path || "")).filter(Boolean);
    projects.value = [...new Set(scanned)];
  } catch (cause) { error.value = userFacingError(cause); }
  finally { loading.value = false; }
}
</script>

<template>
  <section class="hook-delivery-rules">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <div class="hook-rule-section">
      <div class="hook-rule-label">触发事件</div>
      <v-checkbox v-for="event in eventChoices" :key="event.value" :label="event.title"
        :model-value="events.includes(event.value)" density="compact" hide-details
        @update:model-value="value => toggleEvent(event.value, value === true)" />
      <p v-if="supportedEvents.length === 1" class="section-note">此 Agent 端目前提供任务完成事件。</p>
      <p v-else-if="events.includes('task_progress') && rule.conditions.some(item => item.type === 'exclude_heartbeat')" class="section-note">
        已排除心跳任务。过程文本会等到本轮结束并确认不是心跳后投递。
      </p>
    </div>
    <div class="hook-rule-section">
      <div class="d-flex align-center justify-space-between mb-2">
        <div class="hook-rule-label mb-0">条件</div>
        <v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="openCondition()">添加条件</v-btn>
      </div>
      <p v-if="!rule.conditions.length" class="section-note">匹配所选 Agent 端的全部托管任务；添加多个条件时需全部满足。</p>
      <div v-for="(item, conditionIndex) in rule.conditions" :key="item.type" class="hook-condition">
        <div class="d-flex align-center justify-space-between">
          <span>{{ AGENT_HOOK_CONDITIONS.find(option => option.value === item.type)?.title || item.type }}</span>
          <div class="d-flex align-center ga-1">
            <v-btn variant="text" size="small" @click="openCondition(conditionIndex)">编辑条件</v-btn>
            <v-btn icon="mdi-close" variant="text" size="x-small" aria-label="删除条件"
              @click="update({ conditions: rule.conditions.filter((_, position) => position !== conditionIndex) })" />
          </div>
        </div>
        <p class="section-note mt-2 condition-summary">{{ conditionSummary(item) }}</p>
      </div>
    </div>
    <div class="hook-rule-section">
      <div class="hook-rule-label">
        投递至消息端
        <v-tooltip text="回原聊天仅用于任务完成。由消息规则送进本轮的聊天消息会收到回复，手动发起的轮次会跳过。">
          <template #activator="{ props: hint }">
            <v-icon v-bind="hint" tabindex="0" aria-label="投递目标说明" icon="mdi-help-circle-outline" size="small" />
          </template>
        </v-tooltip>
      </div>
      <v-autocomplete :model-value="targetKey" :items="targetOptions" label="投递目标"
        variant="outlined" hide-details @update:model-value="chooseTarget" />
    </div>
    <div class="hook-rule-section">
      <div class="hook-rule-label">消息格式</div>
      <v-select :model-value="rule.destination.params.content || 'full'" :items="contentTypes" label="回复内容" hide-details
        @update:model-value="value => params({ content: value || 'full' })" />
      <div class="d-flex flex-wrap ga-4 mt-2">
        <v-checkbox :model-value="rule.destination.params.includeAgentType !== 'false'" label="包含 Agent 类型" density="compact" hide-details
          @update:model-value="value => params({ includeAgentType: value ? 'true' : 'false' })" />
        <v-checkbox :model-value="rule.destination.params.includeTaskName !== 'false'" label="包含任务名称" density="compact" hide-details
          @update:model-value="value => params({ includeTaskName: value ? 'true' : 'false' })" />
      </div>
      <details v-if="rule.destination.channel === 'napcat'" class="mt-3">
        <summary>表格、图表与附件</summary>
        <v-checkbox v-if="rule.destination.channel === 'napcat'"
          :model-value="rule.destination.params.renderTables !== 'false'" label="自动渲染表格" hide-details
          @update:model-value="value => params({ renderTables: value ? 'true' : 'false' })" >
          <template #append><AutomationParameterHelp text="把 Markdown 表格渲染为图片，并按原文顺序发送。" /></template>
        </v-checkbox>
        <v-checkbox v-if="rule.destination.channel === 'napcat'"
          :model-value="rule.destination.params.renderDiagrams !== 'false'" label="自动识别流程图/架构图" hide-details
          @update:model-value="value => params({ renderDiagrams: value ? 'true' : 'false' })" >
          <template #append><AutomationParameterHelp text="把支持的 Mermaid 图表渲染为图片。渲染失败时发送原文。" /></template>
        </v-checkbox>
        <p v-if="rule.destination.channel === 'napcat'" class="section-note">将 Mermaid 图表转换为图片，按原文顺序图文混排；转换失败时保留源码。</p>
        <v-checkbox v-if="rule.destination.channel === 'napcat'"
          :model-value="rule.destination.params.includeFiles !== 'false'" label="自动投递包括文件" hide-details
          @update:model-value="value => params({ includeFiles: value ? 'true' : 'false' })" >
          <template #append><AutomationParameterHelp text="发送回复中链接的本地文件。相同文件在同一轮只处理一次。" /></template>
        </v-checkbox>
        <div v-if="rule.destination.channel === 'napcat' && rule.destination.params.includeFiles !== 'false'" class="ms-6">
          <v-checkbox :model-value="rule.destination.params.markdownFilesAsImages !== 'false'" label="MD附件自动转换为图片" hide-details
            @update:model-value="value => params({ markdownFilesAsImages: value ? 'true' : 'false' })" >
            <template #append><AutomationParameterHelp text="将 Markdown 附件渲染为图片，否则发送原文件。" /></template>
          </v-checkbox>
          <v-checkbox :model-value="rule.destination.params.imageFilesAsImages !== 'false'" label="图片附件转换为图片" hide-details
            @update:model-value="value => params({ imageFilesAsImages: value ? 'true' : 'false' })" >
            <template #append><AutomationParameterHelp text="让图片附件直接显示为图片。" /></template>
          </v-checkbox>
          <v-checkbox :model-value="rule.destination.params.htmlFilesAsLinks !== 'false'" label="HTML转换为链接" hide-details
            @update:model-value="value => params({ htmlFilesAsLinks: value ? 'true' : 'false' })" >
            <template #append><AutomationParameterHelp text="生成 RabiLink 可访问的链接。查看时需能连接保存文件的电脑。" /></template>
          </v-checkbox>
          <p class="section-note">HTML 保存在此电脑。浏览器通过 RabiLink 获取连接信息，再依次尝试局域网、P2P 和 Relay。服务器不缓存 HTML；持有完整链接的人可查看，电脑需保持在线。关闭对应选项时发送原文件。</p>
        </div>
      </details>
      <p v-if="rule.destination.channel === 'speech'" class="section-note mt-3">任务完成后，使用所选消息路线的角色声线、语音合成与自动播放设置播报结果。启用规则并保存后生效。</p>
    </div>
    <AgentHookConditionDialog v-model="conditionDialog" :condition="editedCondition" :used-types="usedConditionTypes"
      :projects="projects" :sessions="sessions" :loading="loading" :session-loading="sessionLoading"
      :has-more-sessions="nextSessionOffset !== null" :error="error" @save="saveCondition"
      @scan-projects="scanProjects" @scan-sessions="scanSessions" />
  </section>
</template>

<style scoped>
.hook-delivery-rules .section-note { font-weight: 400; }
.hook-rule-section { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); padding-top: 16px; margin-top: 16px; }
.hook-rule-section:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.hook-rule-label { font-weight: 600; margin-bottom: 12px; }
.hook-condition { padding: 12px; margin-bottom: 8px; background: rgba(var(--v-theme-on-surface), 0.035); border-radius: 8px; }
.condition-summary { overflow-wrap: anywhere; }
</style>
