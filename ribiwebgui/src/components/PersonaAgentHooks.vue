<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useDisplay } from "vuetify";
import { agentHookSettingsFor, type CodexHookSettings, type GatewayDefinition } from "@shared/gatewayConfigModel";
import { personaHookAgentOptions } from "@shared/personaAgentHooks";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import { routeScopedAdaptersPath } from "../routeScopedNavigation";
import PlanFollowupSettings from "./PlanFollowupSettings.vue";
import AgentCompletionDeliveryRules from "./AgentCompletionDeliveryRules.vue";

const props = defineProps<{ modelValue?: CodexHookSettings; gateways: GatewayDefinition[]; gateway: GatewayDefinition }>();
const emit = defineEmits<{ "update:modelValue": [value: CodexHookSettings] }>();
const selected = ref<AgentAdapterType>();
const panelId = useId();
const { smAndDown } = useDisplay();
const options = computed(() => personaHookAgentOptions(props.gateways, props.gateway.agentRoleId || ""));
watch([() => props.gateway.agentRoleId, options], ([role, available], previous) => {
  if (role !== previous?.[0] || !available.some(item => item.value === selected.value)) {
    selected.value = available.find(item => item.value === props.gateway.primaryAgentAdapter)?.value ?? available[0]?.value;
  }
}, { immediate: true });
const settings = computed(() => (selected.value && props.modelValue?.byAgent?.[selected.value])
  || props.modelValue || agentHookSettingsFor(undefined));
const fields = [
  { key: "sessionContextEnabled", title: "会话上下文", note: "开始会话或提交消息时附带当前人格、计划和记忆。", events: "SessionStart / UserPromptSubmit" },
  { key: "reasoningContextEnabled", title: "工具调用时刷新上下文", note: "工具调用前后补充本轮新命中的计划、记忆与技能。", events: "PreToolUse / PostToolUse" },
  { key: "planTaskCompletionEnabled", title: "计划任务完成通知", note: "绑定计划的任务结束后，通知该人格的消息路线。", events: "Stop" },
  { key: "agentCommunicationEnforcementEnabled", title: "通过 Rabi 投递 Agent 消息", note: "要求托管任务通过 Rabi 联系其他 Agent；需要回复时跟踪正式回传。", events: "PreToolUse / Stop" }
] as const;
const selectedTitle = computed(() => options.value.find(item => item.value === selected.value)?.title || "");
function enabledCount(agent: AgentAdapterType) {
  const value = agentHookSettingsFor(props.modelValue, agent);
  return fields.filter(field => value[field.key]).length
    + Number(value.planFollowup?.enabled === true)
    + (value.completionDeliveries ?? []).filter(rule => rule.enabled).length;
}
function navigateAgents(event: KeyboardEvent, index: number) {
  const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1
    : ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 0;
  if (!direction && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.value.length - 1
    : (index + direction + options.value.length) % options.value.length;
  selected.value = options.value[next].value;
  const list = (event.currentTarget as HTMLElement).parentElement;
  (list?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next])?.focus();
}
function update(patch: Partial<Omit<CodexHookSettings, "byAgent">>) {
  if (!selected.value) return;
  const { byAgent: _scopes, ...draft }: CodexHookSettings = settings.value;
  emit("update:modelValue", { ...props.modelValue, ...agentHookSettingsFor({ ...props.modelValue, byAgent: undefined }),
    byAgent: { ...props.modelValue?.byAgent, [selected.value]: { ...draft, ...patch } } });
}
</script>

<template>
  <section class="persona-hooks">
    <v-alert v-if="!options.length" type="info" variant="tonal" density="compact">
      当前人格尚未添加支持钩子的 Agent 端。
      <router-link :to="routeScopedAdaptersPath(gateway.configName || gateway.id)">前往 Agent 端设置</router-link>
    </v-alert>
    <template v-else>
      <div class="hook-overview">
        <div>
          <h3>按 Agent 端配置</h3>
          <p class="section-note">各 Agent 独立配置，可同时生效。切换标签只查看设置。</p>
        </div>
        <span class="hook-save-note"><v-icon icon="mdi-content-save-outline" size="16" />修改后点击保存生效。</span>
      </div>
      <div class="hook-workspace">
        <div class="hook-agent-tabs" role="tablist" aria-label="配置的 Agent 端"
          :aria-orientation="smAndDown ? 'horizontal' : 'vertical'">
          <button v-for="(option, index) in options" :id="`${panelId}-${option.value}`" :key="option.value"
            type="button" role="tab" class="hook-agent-tab" :class="{ 'is-selected': selected === option.value }"
            :aria-selected="selected === option.value" :aria-controls="`${panelId}-settings`"
            :tabindex="selected === option.value ? 0 : -1" @click="selected = option.value" @keydown="navigateAgents($event, index)">
            <span class="hook-agent-name">{{ option.title }}</span>
            <span class="hook-agent-meta"><span>{{ enabledCount(option.value) }}</span> 项已开启</span>
            <span class="hook-agent-current"><template v-if="selected === option.value">正在查看<v-icon icon="mdi-chevron-right" size="16" /></template></span>
          </button>
        </div>
        <div :id="`${panelId}-settings`" :key="selected" class="hook-agent-settings" role="tabpanel"
          :aria-labelledby="`${panelId}-${selected}`" tabindex="0">
          <div class="hook-agent-heading">
            <h3>{{ selectedTitle }}</h3>
            <span class="section-note">首次使用需在对应 Agent 端安装 Hook。</span>
          </div>
          <section class="hook-settings-card">
            <div class="hook-settings-header">
              <h3>触发与上下文</h3>
            </div>
            <div v-for="field in fields" :key="field.key" class="hook-setting-row">
              <div>
                <label :for="`${panelId}-${selected}-${field.key}`" class="hook-setting-title">{{ field.title }}</label>
                <p class="section-note">{{ field.note }}</p>
                <details class="hook-event-details"><summary>触发事件</summary><code>{{ field.events }}</code></details>
              </div>
              <v-switch :id="`${panelId}-${selected}-${field.key}`" :model-value="settings[field.key]" :aria-label="field.title"
                color="primary" density="compact" hide-details inset @update:model-value="value => update({ [field.key]: value === true })" />
            </div>
          </section>
          <details class="hook-config-group">
            <summary>
              <span class="hook-group-description"><strong>自动追问</strong><span class="section-note">任务结束后，按计划状态继续追问。</span></span>
              <span class="hook-group-state">{{ settings.planFollowup?.enabled ? '已开启' : '未开启' }}</span>
              <v-icon class="hook-group-chevron" icon="mdi-chevron-down" size="20" />
            </summary>
            <div class="hook-group-content">
              <PlanFollowupSettings :model-value="settings.planFollowup" :role-id="gateway.agentRoleId || ''"
                @update:model-value="planFollowup => update({ planFollowup })" />
            </div>
          </details>
          <details class="hook-config-group">
            <summary>
              <span class="hook-group-description"><strong>事件投递</strong><span class="section-note">任务完成后发送消息或语音播报。</span></span>
              <span class="hook-group-state"><span>{{ (settings.completionDeliveries ?? []).filter(rule => rule.enabled).length }}</span> 条已开启</span>
              <v-icon class="hook-group-chevron" icon="mdi-chevron-down" size="20" />
            </summary>
            <div class="hook-group-content">
              <AgentCompletionDeliveryRules :model-value="settings.completionDeliveries ?? []"
                :agent-type="selected!" :gateways="gateways" :gateway-id="gateway.id"
                @update:model-value="completionDeliveries => update({ completionDeliveries })" />
            </div>
          </details>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.persona-hooks { display: grid; gap: 20px; padding-top: 16px; }
.hook-overview { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.hook-overview p { margin: 6px 0 0; }
.hook-save-note { display: flex; align-items: center; gap: 6px; color: rgba(var(--v-theme-on-surface), .7); font-size: .8rem; }
.hook-workspace { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 24px; align-items: start; }
.hook-agent-tabs { display: grid; gap: 10px; }
.hook-agent-tab { text-align: left; display: grid; gap: 8px; padding: 16px; border: 1px solid rgba(var(--v-theme-on-surface), .14); border-radius: 12px; background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-on-surface)); cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
.hook-agent-tab:hover { background: rgba(var(--v-theme-primary), .05); }
.hook-agent-tab.is-selected { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .08); }
.hook-agent-tab:focus-visible, .hook-config-group > summary:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
.hook-agent-name { font-weight: 600; font-size: .9rem; }
.hook-agent-meta { font-size: .75rem; color: rgba(var(--v-theme-on-surface), .7); }
.hook-agent-current { display: flex; align-items: center; justify-content: space-between; color: rgb(var(--v-theme-primary)); font-size: .75rem; min-height: 18px; }
.hook-agent-settings { min-width: 0; display: grid; gap: 16px; }
.hook-agent-heading { display: grid; gap: 6px; }
.hook-settings-card { border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; overflow: hidden; }
.hook-settings-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 18px 20px; }
h3 { font-size: 1rem; margin: 0; }
.hook-setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 16px 20px; border-top: 1px solid rgba(var(--v-theme-on-surface), .08); }
.hook-setting-title { font-weight: 600; cursor: pointer; }
.hook-setting-row p { margin: 5px 0; font-weight: 400; }
.hook-event-details { font-size: .75rem; color: rgba(var(--v-theme-on-surface), .6); }
.hook-event-details summary { cursor: pointer; width: fit-content; }
.hook-event-details code { display: block; padding-top: 6px; overflow-wrap: anywhere; }
.hook-setting-row :deep(.v-switch) { flex: 0 0 auto; }
.hook-config-group { border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; min-width: 0; }
.hook-config-group > summary { display: flex; gap: 12px; align-items: center; padding: 18px 20px; cursor: pointer; list-style: none; }
.hook-config-group > summary::-webkit-details-marker { display: none; }
.hook-group-description { display: grid; gap: 5px; flex: 1; min-width: 0; }
.hook-group-state { font-size: .75rem; color: rgba(var(--v-theme-on-surface), .7); white-space: nowrap; }
.hook-config-group[open] > summary { border-bottom: 1px solid rgba(var(--v-theme-on-surface), .08); }
.hook-config-group[open] .hook-group-chevron { transform: rotate(180deg); }
.hook-group-content { padding: 20px; }
.hook-group-content :deep(.dependency-panel) { padding: 0; border: 0; background: none; }
@media (max-width: 959px) {
  .hook-workspace { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .hook-agent-tabs { display: flex; min-width: 0; overflow-x: auto; padding: 3px; }
  .hook-agent-tab { flex: 1 0 160px; }
}
@media (max-width: 600px) {
  .hook-settings-header, .hook-setting-row, .hook-config-group > summary, .hook-group-content { padding: 14px; }
  .hook-setting-row { gap: 10px; }
}
</style>
