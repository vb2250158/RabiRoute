<script setup lang="ts">
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, ref, watch } from "vue";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import type { GatewayDefinition } from "@shared/gatewayConfigModel";
import { AGENT_HOOK_EVENTS, AGENT_HOOK_CONDITIONS, AGENT_HOOK_DESTINATIONS, agentHookRuleErrors,
  type AgentCompletionDeliveryRule, type AgentHookCondition, type AgentHookDestination, type AgentHookSession } from "@shared/agentHookAutomation";
import AgentHookConditionDialog from "./AgentHookConditionDialog.vue";
import { usePersonaService } from "../persona/personaServiceClient";
const fetch = usePersonaService().fetch;

const props = defineProps<{ rule: AgentCompletionDeliveryRule; gateways: GatewayDefinition[]; agentType: AgentAdapterType }>();
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
const routes = computed(() => props.gateways.map(item => ({ title: item.name || item.id, value: item.id })));
const qqTypes = [{ title: "群", value: "group" }, { title: "个人 QQ", value: "private" }];
function instances(rule: AgentCompletionDeliveryRule) {
  return (props.gateways.find(item => item.id === rule.destination.gatewayId)?.napcatInstances ?? [])
    .filter(item => item.enabled !== false).map(item => ({ title: item.name || item.id, value: item.id }));
}
function update(patch: Partial<AgentCompletionDeliveryRule>) {
  const next = { ...props.rule, ...patch };
  if (agentHookRuleErrors(next).length) next.enabled = false;
  emit("update:rule", next);
}
function destination(patch: Partial<AgentHookDestination>) {
  update({ destination: { ...props.rule.destination, ...patch } });
}
function params(patch: Record<string, string>) {
  destination({ params: { ...props.rule.destination.params, ...patch } });
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
      <div class="hook-rule-label">事件</div>
      <v-select :model-value="rule.event" :items="AGENT_HOOK_EVENTS" label="选择事件" hide-details
        @update:model-value="value => update({ event: value || '' })" />
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
      <div class="hook-rule-label">投递至消息端</div>
      <div class="hook-destination-grid">
        <v-select :model-value="rule.destination.channel" :items="AGENT_HOOK_DESTINATIONS" label="消息端类型" hide-details
          @update:model-value="value => destination({ channel: value || '', params: value === 'napcat' ? { target: 'group', targetId: '', instanceId: '', includeFiles: 'true', markdownFilesAsImages: 'true', imageFilesAsImages: 'true', htmlFilesAsLinks: 'true', renderDiagrams: 'true', renderTables: 'true' } : {} })" />
        <v-select :model-value="rule.destination.gatewayId" :items="routes" label="消息路线" hide-details
          @update:model-value="value => destination({ gatewayId: value || '', params: { ...rule.destination.params, instanceId: '' } })" />
        <template v-if="rule.destination.channel === 'napcat'">
          <v-select :model-value="rule.destination.params.instanceId" :items="instances(rule)" label="QQ 账号" hide-details
            @update:model-value="value => params({ instanceId: value || '' })" />
          <v-select :model-value="rule.destination.params.target" :items="qqTypes" label="类型" hide-details
            @update:model-value="value => params({ target: value || '', targetId: '' })" />
          <v-text-field :model-value="rule.destination.params.targetId" :label="rule.destination.params.target === 'private' ? 'QQ 号' : '群号'" inputmode="numeric" hide-details
            @update:model-value="value => params({ targetId: value.trim() })" />
        </template>
      </div>
      <v-checkbox v-if="rule.destination.channel === 'napcat'"
        :model-value="rule.destination.params.renderTables !== 'false'" label="自动渲染表格" hide-details
        @update:model-value="value => params({ renderTables: value ? 'true' : 'false' })" />
      <p v-if="rule.destination.channel === 'napcat'" class="section-note">将 Markdown 表格转换为图片，按原文顺序与正文混排发送。</p>
      <v-checkbox v-if="rule.destination.channel === 'napcat'"
        :model-value="rule.destination.params.renderDiagrams !== 'false'" label="自动识别流程图/架构图" hide-details
        @update:model-value="value => params({ renderDiagrams: value ? 'true' : 'false' })" />
      <p v-if="rule.destination.channel === 'napcat'" class="section-note">将 Mermaid 图表转换为图片，按原文顺序图文混排；转换失败时保留源码。</p>
      <v-checkbox v-if="rule.destination.channel === 'napcat'"
        :model-value="rule.destination.params.includeFiles !== 'false'" label="自动投递包括文件" hide-details
        @update:model-value="value => params({ includeFiles: value ? 'true' : 'false' })" />
      <p v-if="rule.destination.channel === 'napcat'" class="section-note">投递回复中链接的本地文件；按下方选项处理，同一文件只投递一次。</p>
      <div v-if="rule.destination.channel === 'napcat' && rule.destination.params.includeFiles !== 'false'" class="ms-6">
        <v-checkbox :model-value="rule.destination.params.markdownFilesAsImages !== 'false'" label="MD附件自动转换为图片" hide-details
          @update:model-value="value => params({ markdownFilesAsImages: value ? 'true' : 'false' })" />
        <v-checkbox :model-value="rule.destination.params.imageFilesAsImages !== 'false'" label="图片附件转换为图片" hide-details
          @update:model-value="value => params({ imageFilesAsImages: value ? 'true' : 'false' })" />
        <v-checkbox :model-value="rule.destination.params.htmlFilesAsLinks !== 'false'" label="HTML转换为链接" hide-details
          @update:model-value="value => params({ htmlFilesAsLinks: value ? 'true' : 'false' })" />
        <p class="section-note">HTML 保存在此电脑。浏览器通过 RabiLink 获取连接信息，再依次尝试局域网、P2P 和 Relay。服务器不缓存 HTML；持有完整链接的人可查看，电脑需保持在线。关闭对应选项时发送原文件。</p>
      </div>
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
.hook-destination-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 600px) { .hook-destination-grid { grid-template-columns: 1fr; } }
</style>
