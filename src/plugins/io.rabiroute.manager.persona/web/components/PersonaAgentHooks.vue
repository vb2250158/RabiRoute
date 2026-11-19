<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { agentHookSettingsFor, type CodexHookSettings, type GatewayDefinition } from "@shared/gatewayConfigModel";
import { AGENT_HOOK_DESTINATIONS, AGENT_HOOK_EVENTS, agentHookRuleErrors, type AgentCompletionDeliveryRule } from "@shared/agentHookAutomation";
import { normalizePlanFollowup, type PlanFollowupRule, type PlanFollowupSettings as FollowupSettings } from "@shared/planFollowup";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import { personaHookAgentOptions } from "@shared/personaAgentHooks";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { routeScopedAdaptersPath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import { createAgentCompletionRule, createTtsCompletionRule } from "../persona/agentCompletionRules";
import AutomationEndpointNav from "./AutomationEndpointNav.vue";
import PlanFollowupSettings from "./PlanFollowupSettings.vue";
import AgentCompletionDeliveryRules from "./AgentCompletionDeliveryRules.vue";

const props = defineProps<{ modelValue?: CodexHookSettings; gateways: GatewayDefinition[]; gateway: GatewayDefinition }>();
const emit = defineEmits<{ "update:modelValue": [value: CodexHookSettings] }>();
type Rule = { kind: "followup"; value: PlanFollowupRule } | { kind: "delivery"; value: AgentCompletionDeliveryRule };
const { t } = useI18n();
const selected = ref("");
const contextDialog = ref(false);
const creationDialog = ref(false);
const editorDialog = ref(false);
const creating = ref(false);
const draft = ref<Rule>();
const enableFollowup = ref(false);
const options = computed(() => personaHookAgentOptions(props.gateways, props.gateway.agentRoleId || "")
  .map(option => ({ ...option, icon: "mdi-robot-outline" })));
const selectedAgent = computed(() => options.value.find(item => item.value === selected.value));
watch([() => props.gateway.agentRoleId, options], ([role, available], previous) => {
  if (role !== previous?.[0] || !available.some(item => item.value === selected.value)) {
    selected.value = available.find(item => item.value === props.gateway.primaryAgentAdapter)?.value ?? available[0]?.value ?? "";
  }
}, { immediate: true });
watch([() => props.gateway.agentRoleId, () => props.gateway.id, selected], () => {
  contextDialog.value = creationDialog.value = editorDialog.value = false;
});
function settingsFor(agent: AgentAdapterType) {
  return props.modelValue?.byAgent?.[agent] ?? props.modelValue ?? agentHookSettingsFor(undefined);
}
const settings = computed(() => selectedAgent.value ? settingsFor(selectedAgent.value.value) : agentHookSettingsFor(undefined));
const followup = computed(() => settings.value.planFollowup ?? normalizePlanFollowup(undefined));
const rules = computed<Rule[]>(() => [
  ...(settings.value.completionDeliveries ?? []).map(value => ({ kind: "delivery" as const, value })),
  ...followup.value.rules.map(value => ({ kind: "followup" as const, value }))
]);
const counts = computed(() => Object.fromEntries(options.value.map(({ value }) => {
  const agentSettings = settingsFor(value);
  return [value, (agentSettings.completionDeliveries?.length ?? 0) + (agentSettings.planFollowup?.rules.length ?? 0)];
})));
const fields = [
  { key: "sessionContextEnabled", title: "会话上下文", note: "开始会话或提交消息时附带当前角色、计划和记忆。", events: "SessionStart / UserPromptSubmit" },
  { key: "reasoningContextEnabled", title: "工具调用时刷新上下文", note: "工具调用前后补充本轮新命中的计划、记忆与技能。", events: "PreToolUse / PostToolUse" },
  { key: "planTaskCompletionEnabled", title: "计划任务完成通知", note: "绑定计划的任务结束后，通知该角色的消息路线。", events: "Stop" },
] as const;

function update(patch: Partial<Omit<CodexHookSettings, "byAgent">>) {
  const agent = selectedAgent.value?.value;
  if (!agent) return;
  const { byAgent: _scopes, ...current }: CodexHookSettings = settings.value;
  emit("update:modelValue", { ...props.modelValue, ...agentHookSettingsFor({ ...props.modelValue, byAgent: undefined }),
    byAgent: { ...props.modelValue?.byAgent, [agent]: { ...current, ...patch } } });
}
function updateFollowup(patch: Partial<FollowupSettings>) {
  update({ planFollowup: { ...followup.value, ...patch } });
}
function ruleLabel(rule: Rule) {
  if (rule.kind === "followup") return "自动追问";
  return rule.value.destination.channel === "speech" ? "TTS 播报" : "事件投递";
}
function ruleTitle(rule: Rule) {
  if (rule.kind === "followup") return rule.value.prompt.trim().split(/\r?\n/, 1)[0] || ruleLabel(rule);
  const destination = rule.value.destination;
  const route = props.gateways.find(item => item.id === destination.gatewayId);
  return destination.params.targetId || route?.name || ruleLabel(rule);
}
function ruleSummary(rule: Rule) {
  if (rule.kind === "followup") return "计划任务结束";
  const event = AGENT_HOOK_EVENTS.find(item => item.value === rule.value.event)?.title ?? rule.value.event;
  const destination = AGENT_HOOK_DESTINATIONS.find(item => item.value === rule.value.destination.channel)?.title;
  return destination ? `${t(event)} · ${t(destination)}` : event;
}
function ruleErrors(rule: Rule): string[] {
  if (rule.kind === "delivery") return agentHookRuleErrors(rule.value);
  return rule.value.statusKeys.length && rule.value.prompt.trim() ? [] : ["选择状态并填写内容后，这条规则才会生效。"];
}
const draftErrors = computed(() => draft.value ? ruleErrors(draft.value) : []);
const cards = computed(() => rules.value.map(rule => {
  const errors = ruleErrors(rule);
  return { rule, errors, enabled: rule.value.enabled && !errors.length && (rule.kind !== "followup" || followup.value.enabled) };
}));

function openEditor(rule: Rule, isNew = false) {
  creationDialog.value = false;
  creating.value = isNew;
  enableFollowup.value = false;
  draft.value = { ...rule };
  editorDialog.value = true;
}
function createRule(type: "delivery" | "speech" | "followup") {
  if (type === "followup") {
    openEditor({ kind: "followup", value: { id: browserUuid(), enabled: false, statusKeys: [], prompt: "" } }, true);
  } else {
    openEditor({ kind: "delivery", value: type === "speech" ? createTtsCompletionRule(props.gateway.id) : createAgentCompletionRule() }, true);
  }
}
function setDraftEnabled(enabled: boolean) {
  const rule = draft.value;
  if (rule) rule.value = { ...rule.value, enabled };
  if (!enabled) enableFollowup.value = false;
}
function saveRule(remove = false) {
  const rule = draft.value;
  if (!rule) return;
  const apply = <T extends { id: string }>(items: T[], value: T) => remove
    ? items.filter(item => item.id !== value.id)
    : creating.value ? [...items, value] : items.map(item => item.id === value.id ? value : item);
  if (rule.kind === "delivery") {
    update({ completionDeliveries: apply(settings.value.completionDeliveries ?? [], rule.value) });
  } else {
    updateFollowup({
      enabled: followup.value.enabled || (!remove && rule.value.enabled && enableFollowup.value && !draftErrors.value.length),
      rules: apply(followup.value.rules, rule.value)
    });
  }
  editorDialog.value = false;
}
</script>

<template>
  <v-alert v-if="!selectedAgent" type="info" variant="tonal" density="compact">
    当前角色尚未添加支持钩子的 Agent 端。
    <router-link :to="routeScopedAdaptersPath(gateway.configName || gateway.id)">前往 Agent 端设置</router-link>
  </v-alert>
  <div v-else class="automation-rule-layout">
    <AutomationEndpointNav v-model="selected" :options="options" :counts="counts" :label="t('Agent 端')" />
    <section class="automation-rule-content" :aria-label="selectedAgent.title">
      <div class="automation-toolbar flex-wrap">
        <strong>{{ selectedAgent.title }}</strong>
        <div class="d-flex align-center flex-wrap ga-2">
          <v-btn variant="text" prepend-icon="mdi-tune-variant" @click="contextDialog = true">触发与上下文</v-btn>
          <v-btn color="secondary" variant="tonal" class="text-none" prepend-icon="mdi-plus" @click="creationDialog = true">新增 Agent 规则</v-btn>
        </div>
      </div>
      <div v-if="!cards.length" class="empty-state"><span>还没有 Agent 规则</span></div>
      <div v-else class="automation-card-grid agent-rule-grid">
        <button v-for="{ rule, errors, enabled } in cards" :key="`${rule.kind}:${rule.value.id}`" type="button"
          class="automation-card" :class="{ disabled: !enabled, warning: errors.length > 0 }"
          :title="errors[0] || ruleTitle(rule)" @click="openEditor(rule)">
          <span class="automation-card-topline">
            <strong>{{ ruleTitle(rule) }}</strong>
            <v-chip size="x-small" :color="rule.kind === 'followup' ? 'primary' : 'secondary'" variant="tonal">{{ ruleLabel(rule) }}</v-chip>
          </span>
          <span class="automation-card-bottomline">
            <span class="automation-card-source">
              <v-icon size="15" icon="mdi-lightning-bolt-outline" />
              <span class="text-truncate">{{ t(ruleSummary(rule)) }}</span>
            </span>
            <v-icon v-if="errors.length" size="14" color="warning" class="automation-card-warning-icon"
              :title="errors[0]" icon="mdi-alert-circle-outline" />
          </span>
        </button>
      </div>
    </section>
  </div>

  <v-dialog v-model="creationDialog" max-width="480" :aria-label="t('新增 Agent 规则')">
    <v-card class="app-card">
      <v-card-title>新增 Agent 规则</v-card-title>
      <v-card-text class="d-grid ga-2">
        <v-btn block variant="tonal" color="secondary" prepend-icon="mdi-send-outline" @click="createRule('delivery')">事件投递</v-btn>
        <v-btn block variant="outlined" prepend-icon="mdi-account-voice" @click="createRule('speech')">TTS 播报</v-btn>
        <v-btn block variant="outlined" prepend-icon="mdi-message-question-outline" @click="createRule('followup')">自动追问</v-btn>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="creationDialog = false">取消</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="editorDialog" max-width="760" scrollable class="editor-dialog" :aria-label="t('Agent 规则')">
    <v-card v-if="draft && selectedAgent" class="app-card editor-dialog-card">
      <v-card-title class="automation-editor-head flex-wrap">
        <div>
          <div class="section-title">{{ ruleLabel(draft) }}</div>
          <div class="section-note">{{ selectedAgent.title }}</div>
        </div>
        <v-switch :model-value="draft.value.enabled && !draftErrors.length" :disabled="draftErrors.length > 0"
          label="启用" color="success" inset hide-details @update:model-value="value => setDraftEnabled(value === true)" />
      </v-card-title>
      <v-card-text>
        <template v-if="draft.kind === 'delivery'">
          <v-alert v-if="draftErrors.length" type="warning" variant="tonal" density="compact" class="mb-4">
            <div v-for="error in draftErrors" :key="error">{{ error }}</div>
          </v-alert>
          <AgentCompletionDeliveryRules :key="draft.value.id" :rule="draft.value" :gateways="gateways"
            :agent-type="selectedAgent.value" @update:rule="value => draft = { kind: 'delivery', value }" />
        </template>
        <template v-else>
          <PlanFollowupSettings :key="draft.value.id" :rule="draft.value" :role-id="gateway.agentRoleId || ''"
            @update:rule="value => draft = { kind: 'followup', value }" />
          <v-checkbox v-if="!followup.enabled" v-model="enableFollowup" :disabled="!draft.value.enabled || draftErrors.length > 0"
            label="同时启用此 Agent 的自动追问" density="compact" hide-details />
        </template>
      </v-card-text>
      <v-card-actions class="pa-4 flex-wrap">
        <v-btn v-if="!creating" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="saveRule(true)">删除规则</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="editorDialog = false">取消</v-btn>
        <v-btn color="primary" variant="tonal" @click="saveRule()">{{ creating ? '添加规则' : '确定' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="contextDialog" max-width="760" scrollable :aria-label="t('触发与上下文')">
    <v-card v-if="selectedAgent" class="app-card">
      <v-card-title>触发与上下文</v-card-title>
      <v-card-subtitle>{{ selectedAgent.title }}</v-card-subtitle>
      <v-card-text>
        <p class="section-note mb-3">首次使用需在对应 Agent 端安装 Hook。</p>
        <div v-for="field in fields" :key="field.key" class="agent-setting-row">
          <div>
            <strong>{{ field.title }}</strong>
            <p class="section-note">{{ field.note }}</p>
            <details class="agent-event-details"><summary>触发事件</summary><code>{{ field.events }}</code></details>
          </div>
          <v-switch :model-value="settings[field.key]" :aria-label="field.title" color="primary" density="compact"
            hide-details inset @update:model-value="value => update({ [field.key]: value === true })" />
        </div>
        <div class="agent-setting-row">
          <div>
            <strong>自动追问</strong>
            <p class="section-note">计划任务结束后，按标记状态匹配第一条规则。</p>
          </div>
          <v-switch :model-value="followup.enabled" aria-label="启用自动追问" color="primary" density="compact"
            hide-details inset @update:model-value="value => updateFollowup({ enabled: value === true })" />
        </div>
        <v-text-field :model-value="followup.cooldownSeconds" class="mt-3" label="追问间隔（秒）"
          type="number" min="0" max="86400" density="compact" hide-details
          @update:model-value="value => updateFollowup({ cooldownSeconds: Number(value) })" />
        <p class="section-note mt-2">同一轮最多追问一次；计划步骤、下一动作和规则均无变化时不重复追问。冷却时间不会自动唤醒任务。</p>
      </v-card-text>
      <v-card-actions class="pa-4 flex-wrap">
        <span class="section-note">修改后点击保存生效。</span>
        <v-spacer />
        <v-btn variant="tonal" @click="contextDialog = false">关闭</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.agent-rule-grid { grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); }
.agent-setting-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--rr-border-faint); }
.agent-setting-row p { margin: 4px 0; font-weight: 400; }
.agent-event-details { font-size: .75rem; color: var(--rr-muted); }
.agent-event-details summary { cursor: pointer; }
</style>
