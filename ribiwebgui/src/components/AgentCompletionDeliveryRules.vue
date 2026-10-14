<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref, useId, watch } from "vue";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import type { GatewayDefinition } from "@shared/gatewayConfigModel";
import { AGENT_HOOK_EVENTS, AGENT_HOOK_CONDITIONS, AGENT_HOOK_DESTINATIONS, agentHookRuleErrors,
  type AgentCompletionDeliveryRule, type AgentHookCondition, type AgentHookDestination, type AgentHookSession } from "@shared/agentHookAutomation";
import { createAgentCompletionRule, createTtsCompletionRule } from "../persona/agentCompletionRules";

const props = defineProps<{ modelValue: AgentCompletionDeliveryRule[]; gateways: GatewayDefinition[]; gatewayId: string; agentType?: AgentAdapterType }>();
const emit = defineEmits<{ "update:modelValue": [value: AgentCompletionDeliveryRule[]] }>();
const panelId = useId();
const expanded = ref(new Set<string>());
watch(() => props.modelValue.map(rule => rule.id), (ids, previous) => {
  const existing = new Set(previous ?? ids);
  expanded.value = new Set([...expanded.value].filter(id => ids.includes(id)));
  for (const id of ids) if (!existing.has(id)) expanded.value.add(id);
});
function toggleRule(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next;
}
const projects = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
const sessions = ref<AgentHookSession[]>([]);
const sessionLoading = ref(false);
const nextSessionOffset = ref<number | null>(null);
function sessionOptions(item: AgentHookCondition) {
  return [...new Map([...(item.sessions ?? []), ...sessions.value].map(session => [session.id, session])).values()]
    .map(session => ({ title: session.name || "未命名任务", value: session.id }));
}
function selectSessions(rule: AgentCompletionDeliveryRule, index: number, ids: string[]) {
  const options = sessionOptions(rule.conditions[index]);
  condition(rule, index, { sessions: ids.map(id => ({ id, name: options.find(option => option.value === id)?.title || "未命名任务" })) });
}
async function scanSessions(more = false) {
  if (sessionLoading.value) return;
  sessionLoading.value = true; error.value = "";
  try {
    const type = props.agentType ?? "codex";
    const query = new URLSearchParams({ [`${type}Offset`]: String(more ? nextSessionOffset.value ?? 0 : 0), [`${type}Limit`]: "100" });
    const response = await fetch(`/api/scan/agents${type === "dsh" ? "/dsh" : ""}?${query}`); const data = await response.json();
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
function update(rule: AgentCompletionDeliveryRule, patch: Partial<AgentCompletionDeliveryRule>) {
  const next = { ...rule, ...patch };
  if (agentHookRuleErrors(next).length) next.enabled = false;
  emit("update:modelValue", props.modelValue.map(item => item.id === rule.id ? next : item));
}
function destination(rule: AgentCompletionDeliveryRule, patch: Partial<AgentHookDestination>) {
  update(rule, { destination: { ...rule.destination, ...patch } });
}
function params(rule: AgentCompletionDeliveryRule, patch: Record<string, string>) {
  destination(rule, { params: { ...rule.destination.params, ...patch } });
}
function condition(rule: AgentCompletionDeliveryRule, index: number, patch: Partial<AgentHookCondition>) {
  update(rule, { conditions: rule.conditions.map((item, position) => position === index ? { ...item, ...patch } : item) });
}
function addCondition(rule: AgentCompletionDeliveryRule, type: string) {
  update(rule, { conditions: [...rule.conditions, type === "project" ? { type, path: "" } : { type }] });
}
async function scanProjects() {
  loading.value = true; error.value = "";
  try {
    const response = await fetch(props.agentType === "dsh" ? "/api/scan/agents/dsh" : "/api/scan/agents"); const data = await response.json();
    if (!response.ok) throw new Error(data.message || "读取项目目录失败");
    const agent = data.agents?.[props.agentType ?? "codex"];
    if (!agent) throw new Error("所选 Agent 端未返回项目，请检查 Agent 端连接。");
    const scanned: string[] = (agent.projects ?? []).map((item: { path?: string }) => String(item.path || "")).filter(Boolean);
    projects.value = [...new Set(scanned)];
  } catch (cause) { error.value = userFacingError(cause); }
  finally { loading.value = false; }
}
</script>

<template>
  <section class="hook-delivery-rules">
    <div class="section-title">事件投递</div>
    <p class="section-note">选择触发事件和接收消息的消息端。</p>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-card v-for="(rule, index) in modelValue" :key="rule.id" variant="outlined" class="pa-4 mb-4">
      <div class="hook-rule-heading">
        <button type="button" class="hook-rule-toggle" :aria-expanded="expanded.has(rule.id)"
          :aria-controls="`${panelId}-${rule.id}`" @click="toggleRule(rule.id)">
          <v-icon :icon="expanded.has(rule.id) ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="20" />
          <span><strong>投递规则 {{ index + 1 }}</strong><span class="section-note hook-rule-summary">{{ AGENT_HOOK_EVENTS.find(item => item.value === rule.event)?.title || rule.event }} · {{ AGENT_HOOK_DESTINATIONS.find(item => item.value === rule.destination.channel)?.title || rule.destination.channel }}</span></span>
        </button>
        <div class="hook-rule-actions">
          <v-switch :model-value="rule.enabled" :disabled="agentHookRuleErrors(rule).length > 0" label="启用规则" hide-details density="compact" color="primary"
            @update:model-value="value => update(rule, { enabled: value === true })" />
          <v-btn icon="mdi-delete-outline" variant="text" size="small" aria-label="删除投递规则"
            @click="emit('update:modelValue', modelValue.filter(item => item.id !== rule.id))" />
        </div>
      </div>
      <div :id="`${panelId}-${rule.id}`" v-show="expanded.has(rule.id)">
      <div class="hook-rule-section">
        <div class="hook-rule-label">事件</div>
        <v-select :model-value="rule.event" :items="AGENT_HOOK_EVENTS" label="选择事件" hide-details
          @update:model-value="value => update(rule, { event: value || '' })" />
      </div>
      <div class="hook-rule-section">
        <div class="d-flex align-center justify-space-between mb-2">
          <div class="hook-rule-label mb-0">条件</div>
          <v-menu>
            <template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" variant="text" size="small" prepend-icon="mdi-plus">添加条件</v-btn></template>
            <v-list density="compact">
              <v-list-item v-for="item in AGENT_HOOK_CONDITIONS" :key="item.value" :title="item.title"
                :disabled="rule.conditions.some(condition => condition.type === item.value)" @click="addCondition(rule, item.value)" />
            </v-list>
          </v-menu>
        </div>
        <p v-if="!rule.conditions.length" class="section-note">匹配所选 Agent 端的全部托管任务；添加多个条件时需全部满足。</p>
        <div v-for="(item, conditionIndex) in rule.conditions" :key="item.type" class="hook-condition">
          <div class="d-flex align-center justify-space-between">
            <span>{{ AGENT_HOOK_CONDITIONS.find(option => option.value === item.type)?.title || item.type }}</span>
            <v-btn icon="mdi-close" variant="text" size="x-small" aria-label="删除条件"
              @click="update(rule, { conditions: rule.conditions.filter((_, position) => position !== conditionIndex) })" />
          </div>
          <template v-if="item.type === 'project'">
            <v-combobox :model-value="item.path" :items="projects" label="项目目录" hide-details class="mt-2"
              @update:model-value="value => condition(rule, conditionIndex, { path: String(value || '') })" />
            <v-btn variant="text" size="small" :loading="loading" @click="scanProjects">读取项目目录</v-btn>
          </template>
          <p v-else-if="item.type === 'bound_plan'" class="section-note">仅投递绑定当前人格计划的任务，消息中包含计划名。</p>
          <template v-else-if="item.type === 'include_sessions' || item.type === 'exclude_sessions'">
            <v-autocomplete :model-value="(item.sessions ?? []).map(session => session.id)" :items="sessionOptions(item)"
              :label="item.type === 'include_sessions' ? '限定的聊天会话' : '排除的聊天会话'" multiple chips closable-chips hide-details class="mt-2"
              @update:model-value="value => selectSessions(rule, conditionIndex, value)" />
            <v-btn variant="text" size="small" :loading="sessionLoading" @click="scanSessions()">读取聊天会话</v-btn>
            <v-btn v-if="nextSessionOffset !== null" variant="text" size="small" :loading="sessionLoading" @click="scanSessions(true)">加载更多会话</v-btn>
            <p class="section-note">按会话名称多选；限定列表内任意一个即可匹配，排除列表内的会话不会投递。会话改名不影响匹配。</p>
          </template>
        </div>
      </div>
      <div class="hook-rule-section">
        <div class="hook-rule-label">投递至消息端</div>
        <div class="hook-destination-grid">
          <v-select :model-value="rule.destination.channel" :items="AGENT_HOOK_DESTINATIONS" label="消息端类型" hide-details
            @update:model-value="value => destination(rule, { channel: value || '', params: value === 'napcat' ? { target: 'group', targetId: '', instanceId: '' } : {} })" />
          <v-select :model-value="rule.destination.gatewayId" :items="routes" label="消息路线" hide-details
            @update:model-value="value => destination(rule, { gatewayId: value || '', params: { ...rule.destination.params, instanceId: '' } })" />
          <template v-if="rule.destination.channel === 'napcat'">
            <v-select :model-value="rule.destination.params.instanceId" :items="instances(rule)" label="QQ 账号" hide-details
              @update:model-value="value => params(rule, { instanceId: value || '' })" />
            <v-select :model-value="rule.destination.params.target" :items="qqTypes" label="类型" hide-details
              @update:model-value="value => params(rule, { target: value || '', targetId: '' })" />
            <v-text-field :model-value="rule.destination.params.targetId" :label="rule.destination.params.target === 'private' ? 'QQ 号' : '群号'" inputmode="numeric" hide-details
              @update:model-value="value => params(rule, { targetId: value.trim() })" />
          </template>
        </div>
        <p v-if="rule.destination.channel === 'speech'" class="section-note mt-3">任务完成后，使用所选消息路线的人格声线、语音合成与自动播放设置播报结果。启用规则并保存后生效。</p>
      </div>
      </div>
      <p v-for="message in agentHookRuleErrors(rule)" :key="message" class="section-note text-warning">{{ message }}</p>
    </v-card>
    <div class="hook-delivery-actions">
      <v-btn variant="tonal" prepend-icon="mdi-plus" @click="emit('update:modelValue', [...modelValue, createAgentCompletionRule()])">添加投递规则</v-btn>
      <v-btn variant="tonal" prepend-icon="mdi-account-voice" @click="emit('update:modelValue', [...modelValue, createTtsCompletionRule(gatewayId)])">添加 TTS 播报</v-btn>
    </div>
    <p class="section-note mt-2">规则随人格配置保存，发送结果可在消息路线的发送日志中查看。</p>
  </section>
</template>

<style scoped>
.hook-delivery-rules .section-note { font-weight: 400; }
.hook-rule-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
.hook-rule-toggle { display: flex; align-items: center; gap: 8px; text-align: left; min-height: 44px; min-width: 0; color: inherit; }
.hook-rule-toggle:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; border-radius: 4px; }
.hook-rule-summary { display: block; margin-top: 4px; overflow-wrap: anywhere; }
.hook-rule-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.hook-delivery-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.hook-rule-section { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); padding-top: 16px; margin-top: 16px; }
.hook-rule-label { font-weight: 600; margin-bottom: 12px; }
.hook-condition { padding: 12px; margin-bottom: 8px; background: rgba(var(--v-theme-on-surface), 0.035); border-radius: 8px; }
.hook-destination-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 600px) { .hook-destination-grid { grid-template-columns: 1fr; } }
</style>
