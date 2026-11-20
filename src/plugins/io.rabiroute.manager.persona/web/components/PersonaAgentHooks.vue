<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { agentHookSettingsFor, type CodexHookSettings, type GatewayDefinition, type PersonaAutomationRuleDefinition } from "@shared/gatewayConfigModel";
import { AGENT_HOOK_EVENTS, agentHookRuleErrors, agentHookRuleEvents, type AgentHookSession } from "@shared/agentHookAutomation";
import { normalizePlanFollowup, type PlanFollowupSettings as FollowupSettings } from "@shared/planFollowup";
import type { AgentAdapterType } from "@shared/agentAdapterCapabilities";
import { editPersonaAgentRule, personaAgentHookDraft, personaHookAgentOptions, type PersonaAgentRule as Rule } from "@shared/personaAgentHooks";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { routeScopedAdaptersPath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import { createAgentCompletionRule, createTtsCompletionRule } from "../persona/agentCompletionRules";
import { completionTargetChoices, completionTargetLabel } from "../persona/agentCompletionTargets";
import type { AutomationQqDirectory } from "../persona/automationRuleConversation";
import AutomationEndpointNav from "./AutomationEndpointNav.vue";
import PlanFollowupSettings from "./PlanFollowupSettings.vue";
import AgentCompletionDeliveryRules from "./AgentCompletionDeliveryRules.vue";

const props = defineProps<{ modelValue?: CodexHookSettings; gateways: GatewayDefinition[]; gateway: GatewayDefinition;
  messageRules: readonly PersonaAutomationRuleDefinition[]; qqDirectories: readonly AutomationQqDirectory[] }>();
const defaultRoute = computed(() => props.gateways[0] ?? props.gateway);
const adaptersPath = computed(() => routeScopedAdaptersPath(defaultRoute.value.configName || defaultRoute.value.id));
const targets = computed(() => completionTargetChoices(props.gateway, props.gateways, props.messageRules, props.qqDirectories, props.modelValue));
const emit = defineEmits<{ "update:modelValue": [value: CodexHookSettings] }>();
const { t } = useI18n();
const selected = ref("");
const contextDialog = ref(false);
const editorDialog = ref(false);
const creating = ref(false);
const draft = ref<Rule>();
const enableFollowup = ref(false);
const previewAgent = ref("");
const sourceAgent = ref<AgentAdapterType>();
const moving = computed(() => Boolean(sourceAgent.value && sourceAgent.value !== previewAgent.value));
const sessionSelections = new Map<AgentAdapterType, Map<string, AgentHookSession[] | undefined>>();
const previewDrafts = new Map<AgentAdapterType, { rule: Rule; enableFollowup: boolean }>();
const supportedOptions = computed(() => personaHookAgentOptions(props.gateways, props.gateway.agentRoleId || "")
  .map(option => ({ ...option, icon: "mdi-robot-outline" })));
const options = computed(() => supportedOptions.value.filter(item => item.configured));
const selectedAgent = computed(() => options.value.find(item => item.value === selected.value));
const editorAgent = computed(() => supportedOptions.value.find(item => item.value === previewAgent.value));
const previewStatuses = computed(() => Object.fromEntries(supportedOptions.value.map(option =>
  [option.value, t(option.configured ? "已配置" : "未配置")])));
watch([() => props.gateway.agentRoleId, options], ([role, available], previous) => {
  if (role !== previous?.[0] || !available.some(item => item.value === selected.value)) {
    selected.value = available.find(item => item.value === defaultRoute.value.primaryAgentAdapter)?.value ?? available[0]?.value ?? "";
  }
}, { immediate: true });
watch([() => props.gateway.agentRoleId, () => props.gateway.id, selected], () => {
  contextDialog.value = editorDialog.value = false;
});
function settingsFor(agent: AgentAdapterType) {
  return personaAgentHookDraft(props.modelValue, agent);
}
const settings = computed(() => selectedAgent.value ? settingsFor(selectedAgent.value.value) : agentHookSettingsFor(undefined));
const followup = computed(() => settings.value.planFollowup ?? normalizePlanFollowup(undefined));
const previewFollowupEnabled = computed(() => editorAgent.value?.configured
  && settingsFor(editorAgent.value.value).planFollowup?.enabled === true);
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

function update(patch: Partial<Omit<CodexHookSettings, "byAgent">>, agent = selectedAgent.value?.value) {
  if (!agent) return;
  const current = settingsFor(agent);
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
  if (rule.value.name?.trim()) return rule.value.name.trim();
  if (rule.kind === "followup") return rule.value.prompt.trim().split(/\r?\n/, 1)[0] || ruleLabel(rule);
  return rule.value.destination.gatewayId
    ? completionTargetLabel(rule.value.destination, props.gateways, props.qqDirectories)
    : ruleLabel(rule);
}
function ruleSummary(rule: Rule) {
  if (rule.kind === "followup") return "计划任务结束";
  const events = agentHookRuleEvents(rule.value).map(value => t(AGENT_HOOK_EVENTS.find(event => event.value === value)?.title ?? value));
  const destination = rule.value.destination.gatewayId ? completionTargetLabel(rule.value.destination, props.gateways, props.qqDirectories) : "";
  return [...events, destination].filter(Boolean).join(" · ");
}
function ruleErrors(rule: Rule, agentType?: AgentAdapterType): string[] {
  if (rule.kind === "delivery") return agentHookRuleErrors(rule.value, agentType);
  return rule.value.statusKeys.length && rule.value.prompt.trim() ? [] : ["选择状态并填写内容后，这条规则才会生效。"];
}
const draftErrors = computed(() => draft.value ? ruleErrors(draft.value, editorAgent.value?.value) : []);
const needsSessions = computed(() => moving.value && draft.value?.kind === "delivery"
  && draft.value.value.conditions.some(item => (item.type === "include_sessions" || item.type === "exclude_sessions") && !item.sessions?.length));
const saveDisabled = computed(() => !editorAgent.value?.configured
  || ((moving.value || (creating.value && draft.value?.kind === "delivery")) && draftErrors.value.length > 0));
const cards = computed(() => rules.value.map(rule => {
  const errors = ruleErrors(rule, selectedAgent.value?.value);
  return { rule, errors, enabled: rule.value.enabled && !errors.length && (rule.kind !== "followup" || followup.value.enabled) };
}));

const ruleTypes = [
  { value: "delivery", title: "事件投递" },
  { value: "speech", title: "TTS 播报" },
  { value: "followup", title: "自动追问" }
] as const;
type RuleType = typeof ruleTypes[number]["value"];
const draftType = computed<RuleType>(() => draft.value?.kind === "followup" ? "followup"
  : draft.value?.value.destination.channel === "speech" ? "speech" : "delivery");

function newRule(type: RuleType, name?: string): Rule {
  if (type === "followup") {
    return { kind: "followup", value: { id: browserUuid(), name, enabled: false, statusKeys: [], prompt: "" } };
  }
  const value = type === "speech" ? createTtsCompletionRule("") : createAgentCompletionRule();
  return { kind: "delivery", value: { ...value, name } };
}
function openEditor(rule?: Rule) {
  previewDrafts.clear();
  sessionSelections.clear();
  sourceAgent.value = rule ? selectedAgent.value?.value : undefined;
  creating.value = !rule;
  previewAgent.value = selectedAgent.value?.value ?? supportedOptions.value[0]?.value ?? "";
  enableFollowup.value = false;
  draft.value = rule ? { ...rule } : newRule("delivery");
  editorDialog.value = true;
}
function switchPreview(agent: AgentAdapterType) {
  if (agent === previewAgent.value) return;
  const current = draft.value;
  if (creating.value) {
    if (current) previewDrafts.set(previewAgent.value, { rule: current, enableFollowup: enableFollowup.value });
    const previous = previewDrafts.get(agent);
    draft.value = previous?.rule ?? newRule(draftType.value);
    enableFollowup.value = previous?.enableFollowup ?? false;
  } else {
    if (current?.kind === "delivery") {
      const conditions = current.value.conditions;
      const sessionConditions = conditions.filter(item => item.type === "include_sessions" || item.type === "exclude_sessions");
      sessionSelections.set(previewAgent.value, new Map(sessionConditions.map(item => [item.type, item.sessions])));
      const targetSelections = sessionSelections.get(agent);
      current.value = { ...current.value, conditions: conditions.map(item => sessionConditions.includes(item)
        ? { ...item, sessions: targetSelections?.get(item.type) ?? [] } : item) };
    }
    enableFollowup.value = false;
  }
  previewAgent.value = agent;
}
function changeRuleType(type: RuleType | null) {
  if (!type || type === draftType.value) return;
  const current = draft.value;
  const next = newRule(type, current?.value.name);
  if (current?.kind === "delivery" && next.kind === "delivery") {
    const { content, includeAgentType, includeTaskName } = current.value.destination.params;
    next.value = { ...current.value, destination: { ...next.value.destination, params: {
      ...next.value.destination.params,
      ...(content ? { content } : {}),
      ...(includeAgentType ? { includeAgentType } : {}),
      ...(includeTaskName ? { includeTaskName } : {}),
    } } };
  }
  draft.value = next;
  enableFollowup.value = false;
}
function setDraftName(name: string) {
  const rule = draft.value;
  if (rule) rule.value = { ...rule.value, name };
}
function setDraftEnabled(enabled: boolean) {
  const rule = draft.value;
  if (rule) rule.value = { ...rule.value, enabled };
  if (!enabled) enableFollowup.value = false;
}
function saveRule(remove = false) {
  const rule = draft.value;
  const agent = editorAgent.value;
  if (!rule || !agent?.configured || (!remove && saveDisabled.value) || (remove && moving.value)) return;
  if (!remove) {
    const name = rule.value.name?.trim() || (creating.value ? t(ruleLabel(rule)) : undefined);
    rule.value = { ...rule.value, name };
  }
  emit("update:modelValue", editPersonaAgentRule(props.modelValue, {
    rule, targetAgent: agent.value, sourceAgent: sourceAgent.value, remove, createId: browserUuid,
    enableFollowup: !remove && rule.value.enabled && enableFollowup.value && !draftErrors.value.length
  }));
  editorDialog.value = false;
  selected.value = agent.value;
}
</script>

<template>
  <div v-if="!selectedAgent">
    <div class="automation-toolbar justify-end">
      <v-btn v-if="supportedOptions.length" color="secondary" variant="tonal" class="text-none" prepend-icon="mdi-plus"
        @click="openEditor()">新增 Agent 规则</v-btn>
    </div>
    <v-alert type="info" variant="tonal" density="compact">
      当前角色尚未添加支持钩子的 Agent 端。
      <router-link :to="adaptersPath">前往 Agent 端设置</router-link>
    </v-alert>
  </div>
  <div v-else class="automation-rule-layout">
    <AutomationEndpointNav v-model="selected" :options="options" :counts="counts" :label="t('Agent 端')" />
    <section class="automation-rule-content" :aria-label="selectedAgent.title">
      <div class="automation-toolbar flex-wrap">
        <strong>{{ selectedAgent.title }}</strong>
        <div class="d-flex align-center flex-wrap ga-2">
          <v-btn variant="text" prepend-icon="mdi-tune-variant" @click="contextDialog = true">触发与上下文</v-btn>
          <v-btn color="secondary" variant="tonal" class="text-none" prepend-icon="mdi-plus" @click="openEditor()">新增 Agent 规则</v-btn>
        </div>
      </div>
      <div v-if="!cards.length" class="empty-state"><span>还没有 Agent 规则</span></div>
      <div v-else class="automation-card-grid agent-rule-grid">
        <button v-for="{ rule, errors, enabled } in cards" :key="`${rule.kind}:${rule.value.id}`" type="button"
          class="automation-card" :class="{ disabled: !enabled, warning: errors.length > 0 }"
          :title="errors[0] || ruleTitle(rule)" @click="openEditor(rule)">
          <span class="automation-card-topline">
            <strong :data-no-i18n="rule.value.name ? '' : undefined">{{ ruleTitle(rule) }}</strong>
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

  <v-dialog v-model="editorDialog" max-width="1200" scrollable class="editor-dialog"
    :aria-label="t(creating ? '规则预览' : 'Agent 规则')">
    <v-card v-if="draft && editorAgent" class="app-card editor-dialog-card automation-editor">
      <v-card-title class="automation-editor-head flex-wrap">
        <div>
          <div class="section-title">{{ t(creating ? '规则预览' : 'Agent 规则') }}</div>
          <div v-if="!creating" class="section-note">{{ editorAgent.title }}</div>
        </div>
        <div class="rule-dialog-actions">
          <v-switch :model-value="draft.value.enabled && !draftErrors.length" :disabled="!editorAgent.configured || draftErrors.length > 0"
            label="启用" color="success" inset hide-details @update:model-value="value => setDraftEnabled(value === true)" />
          <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭')" @click="editorDialog = false" />
        </div>
      </v-card-title>
      <v-card-text>
        <div class="automation-rule-layout automation-editor-layout">
          <AutomationEndpointNav :model-value="previewAgent" :options="supportedOptions"
            :statuses="previewStatuses" :label="t('Agent 端')" @update:model-value="switchPreview" />
          <div class="automation-rule-content">
            <v-alert v-if="!editorAgent.configured" type="info" variant="tonal" density="compact" class="mb-4">
              此 Agent 端尚未为当前角色配置。
              <router-link :to="adaptersPath" @click="editorDialog = false">前往 Agent 端设置</router-link>
            </v-alert>
            <p v-if="moving && editorAgent.configured" class="section-note mb-3">保存角色配置后，规则将由所选 Agent 触发。</p>
            <v-text-field :model-value="draft.value.name || ''" :placeholder="t(ruleLabel(draft))" label="规则名称" class="mb-3"
              @update:model-value="setDraftName" />
            <v-select v-if="creating" :model-value="draftType" :items="ruleTypes" label="规则类型" class="mb-4"
              @update:model-value="changeRuleType" />
            <template v-if="draft.kind === 'delivery'">
              <v-alert v-if="!creating && editorAgent.configured && draftErrors.length" type="warning" variant="tonal" density="compact" class="mb-4">
                <div v-if="needsSessions">切换 Agent 后，请重新选择会话限定。</div>
                <div v-for="error in draftErrors" :key="error">{{ error }}</div>
              </v-alert>
              <AgentCompletionDeliveryRules :key="draft.value.id" :rule="draft.value" :targets="targets" :gateways="gateways"
                :qq-directories="qqDirectories"
                :agent-type="editorAgent.value" @update:rule="value => draft = { kind: 'delivery', value }" />
            </template>
            <template v-else>
              <PlanFollowupSettings :key="draft.value.id" :rule="draft.value" :role-id="gateway.agentRoleId || ''"
                @update:rule="value => draft = { kind: 'followup', value }" />
              <v-checkbox v-if="editorAgent.configured && !previewFollowupEnabled" v-model="enableFollowup"
                :disabled="!draft.value.enabled || draftErrors.length > 0"
                label="同时启用此 Agent 的自动追问" density="compact" hide-details />
            </template>
          </div>
        </div>
      </v-card-text>
      <v-card-actions class="pa-4 flex-wrap">
        <v-btn v-if="!creating && !moving" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="saveRule(true)">删除规则</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="editorDialog = false">取消</v-btn>
        <v-btn color="primary" variant="tonal" :disabled="saveDisabled" @click="saveRule()">{{ creating ? '新建' : '确定' }}</v-btn>
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
