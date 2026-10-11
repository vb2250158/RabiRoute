<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { agentHookSettingsFor, type CodexHookSettings, type GatewayDefinition } from "@shared/gatewayConfigModel";
import { personaHookAgentOptions } from "@shared/personaAgentHooks";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import { routeScopedAdaptersPath } from "../routeScopedNavigation";
import PlanFollowupSettings from "./PlanFollowupSettings.vue";
import AgentCompletionDeliveryRules from "./AgentCompletionDeliveryRules.vue";

const props = defineProps<{ modelValue?: CodexHookSettings; gateways: GatewayDefinition[]; gateway: GatewayDefinition }>();
const emit = defineEmits<{ "update:modelValue": [value: CodexHookSettings] }>();
const selected = ref<AgentAdapterType>();
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
function update(patch: Partial<Omit<CodexHookSettings, "byAgent">>) {
  if (!selected.value) return;
  const { byAgent: _scopes, ...draft }: CodexHookSettings = settings.value;
  emit("update:modelValue", { ...props.modelValue, ...agentHookSettingsFor({ ...props.modelValue, byAgent: undefined }),
    byAgent: { ...props.modelValue?.byAgent, [selected.value]: { ...draft, ...patch } } });
}
</script>

<template>
  <section class="persona-hooks">
    <div class="hook-end-selector">
      <v-select v-model="selected" :items="options" label="配置的 Agent 端" hide-details density="compact" variant="outlined"
        :disabled="!options.length" />
      <span class="section-note">修改后点击保存生效。</span>
    </div>
    <v-alert v-if="!options.length" type="info" variant="tonal" density="compact">
      当前人格尚未添加支持钩子的 Agent 端。
      <router-link :to="routeScopedAdaptersPath(gateway.configName || gateway.id)">前往 Agent 端设置</router-link>
    </v-alert>
    <template v-else>
      <section class="hook-settings-card">
        <div class="hook-settings-header">
          <h3>触发与上下文</h3>
          <span class="section-note">首次使用需在 Agent 端安装钩子。</span>
        </div>
        <div v-for="field in fields" :key="field.key" class="hook-setting-row">
          <div>
            <label :for="`hook-${field.key}`" class="hook-setting-title">{{ field.title }}</label>
            <p class="section-note">{{ field.note }}</p>
            <details class="hook-event-details"><summary>触发事件</summary><code>{{ field.events }}</code></details>
          </div>
          <v-switch :id="`hook-${field.key}`" :model-value="settings[field.key]" :aria-label="field.title"
            color="primary" density="compact" hide-details inset @update:model-value="value => update({ [field.key]: value === true })" />
        </div>
      </section>
      <PlanFollowupSettings :model-value="settings.planFollowup" :role-id="gateway.agentRoleId || ''"
        @update:model-value="planFollowup => update({ planFollowup })" />
      <AgentCompletionDeliveryRules :key="`delivery-${selected}`" :model-value="settings.completionDeliveries ?? []"
        :agent-type="selected!" :gateways="gateways" :gateway-id="gateway.id"
        @update:model-value="completionDeliveries => update({ completionDeliveries })" />
    </template>
  </section>
</template>

<style scoped>
.persona-hooks { display: grid; gap: 20px; padding-top: 16px; }
.hook-end-selector { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.hook-end-selector :deep(.v-input) { max-width: 420px; min-width: 230px; }
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
@media (max-width: 600px) { .hook-settings-header, .hook-setting-row { padding: 14px; } .hook-setting-row { gap: 10px; } }
</style>
