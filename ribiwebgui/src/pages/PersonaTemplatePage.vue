<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import SpeechParameterSlider from "../components/SpeechParameterSlider.vue";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import PersonaSyncCard from "../components/PersonaSyncCard.vue";
import { personaAvatarClient } from "../persona/personaAvatarClient";
import {
  personaVoiceIdentityClient,
  type PersonaVoiceIdentity,
  type PersonaVoiceTranscriptSummary
} from "../persona/personaVoiceIdentityClient";
import {
  beginPersonaVoiceConfirmation,
  idlePersonaVoiceConfirmation,
  isPersonaVoiceConfirmationCandidate,
  observePersonaVoiceConfirmation,
  orderPersonaVoiceConfirmationCandidates,
  personaVoiceprintEvidenceKey
} from "../persona/personaVoiceConfirmation";
import { useGatewayStore } from "../stores/gatewayStore";
import { useSpeechStore } from "../stores/speechStore";
import type { NotificationRule, NotificationScheduleDefinition } from "../types";
import {
  DEFAULT_RECENT_MESSAGE_LIMIT,
  MAX_RECENT_MESSAGE_LIMIT,
  RECENT_MESSAGE_ENDPOINTS,
  normalizeRecentMessageLimit,
  normalizeSpeechTriggerKeywords,
  type RecentMessageEndpoint
} from "@shared/gatewayConfigModel";
import { isSpeechRouteVariableKey } from "@shared/speechControlContract";
import { PERSONA_AVATAR_ACCEPT } from "@shared/personaAvatarContract";
import {
  adapterLabel,
  configNameFor,
  defaultHeartbeatSchedule,
  isBuiltinRolePanelRule,
  notificationRulesForGateway,
  routeKindDefinitionsForGateway,
  routeKindLabels,
  routeKindSummary,
  ruleHasGroupRoute,
  ruleTemplateSnippet,
  templateVars
} from "../utils/gatewayHelpers";

const store = useGatewayStore();
const speech = useSpeechStore();
const route = useRoute();
const router = useRouter();
const ruleDialog = ref(false);
const activeRuleIndex = ref(0);
const ruleMatchParamsOpen = ref(true);
const ruleRouteKindsOpen = ref(true);
const ruleSchedulesOpen = ref(true);
const ruleTemplateOpen = ref(true);
const voiceProfileRefreshing = ref(false);
const voiceProfileError = ref("");
const voiceProfileCopyResult = ref("");
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarSaving = ref(false);
const avatarError = ref("");
const voiceIdentityLoading = ref(false);
const voiceIdentityError = ref("");
const voiceIdentityNotice = ref("");
const voiceIdentitySummary = ref<PersonaVoiceTranscriptSummary | null>(null);
const voiceIdentities = ref<PersonaVoiceIdentity[]>([]);
const voiceIdentityBusyKey = ref("");
const voiceConfirmation = ref(idlePersonaVoiceConfirmation());
const personaSyncManifestVersion = ref(0);
const personaSyncPeerVersion = ref(0);
let releaseSpeech: (() => void) | null = null;
let managerEvents: EventSource | null = null;
let managerEventsReady = false;
let voiceIdentityRefreshRunning = false;
let voiceIdentityRefreshQueued = false;
let voiceIdentityRefreshObserveQueued = false;

const recentMessageEndpoints: RecentMessageEndpoint[] = [...RECENT_MESSAGE_ENDPOINTS];

const gateway = computed(() => store.selectedGateway);
const runtime = computed(() => store.selectedRuntime);
const roleOptions = computed(() => [
  { title: "不注入人格", value: "", avatarUrl: "" },
  ...((runtime.value.roleInfo?.options || []).map(role => ({ title: role.label || role.value, value: role.value, avatarUrl: role.avatarUrl || "" })))
]);
const selectedRole = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  return (runtime.value.roleInfo?.options || []).find(role => role.value === roleId);
});
const voiceProfile = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  return speech.personas.find(persona => persona.id === roleId);
});
const hasPersona = computed(() => Boolean(gateway.value?.agentRoleId));
const unresolvedVoiceprints = computed(() => voiceIdentitySummary.value?.unresolvedVoiceprints || []);
const orderedUnresolvedVoiceprints = computed(() => orderPersonaVoiceConfirmationCandidates(
  voiceConfirmation.value,
  unresolvedVoiceprints.value
));
const voiceConfirmationCandidateCount = computed(() => voiceConfirmation.value.candidateKeys.length);
const sortedVoiceIdentities = computed(() => [...voiceIdentities.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const rules = computed(() => gateway.value ? notificationRulesForGateway(gateway.value) : []);
const activeRule = computed(() => rules.value[activeRuleIndex.value] || null);
const variableEntries = computed(() => Object.entries(gateway.value?.routeVariables || {})
  .filter(([key]) => !isSpeechRouteVariableKey(key)));
const roleDirLabel = computed(() => runtime.value.roleInfo?.rolesDir || "./data/roles");
const voiceProfilePath = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  const personaPath = selectedRole.value?.rolePath || runtime.value.roleInfo?.selectedRolePath || "";
  if (!personaPath) return `${roleDirLabel.value}/${roleId}/voice/voice-profile.json`;
  const separator = personaPath.includes("\\") ? "\\" : "/";
  const lastSeparator = Math.max(personaPath.lastIndexOf("/"), personaPath.lastIndexOf("\\"));
  const roleDir = lastSeparator >= 0 ? personaPath.slice(0, lastSeparator) : personaPath;
  return `${roleDir}${separator}voice${separator}voice-profile.json`;
});
const routeKindQuery = ref("");
const routeKindDefinitions = computed(() => routeKindDefinitionsForGateway(gateway.value || undefined));
const selectedRouteKindCount = computed(() => activeRule.value?.routeKinds?.length || 0);
const activeRuleDiagnostics = computed(() => activeRule.value ? ruleDiagnostics(activeRule.value) : []);
const activeRuleNotes = computed(() => activeRule.value ? ruleNotes(activeRule.value) : []);
const ruleDiagnosticsCount = computed(() => rules.value.reduce((count, rule) => count + ruleDiagnostics(rule).length, 0));
const scheduleTypeOptions = [
  { title: "每隔一段时间", value: "interval" },
  { title: "每天指定时间", value: "daily_time" },
  { title: "某一天指定时间", value: "once_at" }
];
const activeRuleHasHeartbeat = computed(() => activeRule.value?.routeKinds?.includes("heartbeat") === true);
const visibleRouteKindDefinitions = computed(() => {
  const query = routeKindQuery.value.trim().toLowerCase();
  if (!query) return routeKindDefinitions.value;
  return routeKindDefinitions.value
    .map(definition => ({
      ...definition,
      groups: definition.groups
        .map(group => ({
          ...group,
          routeKinds: group.routeKinds.filter(kind => {
            return [
              definition.title,
              definition.note,
              group.title,
              kind,
              routeKindLabels[kind] || ""
            ].join(" ").toLowerCase().includes(query);
          })
        }))
        .filter(group => group.routeKinds.length > 0)
    }))
    .filter(definition => definition.groups.length > 0);
});

function openRule(index: number): void {
  activeRuleIndex.value = index;
  ruleMatchParamsOpen.value = true;
  ruleRouteKindsOpen.value = true;
  ruleSchedulesOpen.value = true;
  ruleTemplateOpen.value = true;
  ruleDialog.value = true;
}

function patchRule(patch: Partial<NotificationRule>): void {
  store.updateRule(activeRuleIndex.value, patch);
}

function ruleDiagnostics(rule: NotificationRule): string[] {
  const issues: string[] = [];
  if (!Array.isArray(rule.routeKinds) || rule.routeKinds.length === 0) {
    issues.push("未选择路由类型时会匹配全部入口；建议明确选择要接收的消息来源。");
  }
  if (rule.regex && !/\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    try {
      new RegExp(rule.regex);
    } catch {
      issues.push("消息匹配正则无法解析，保存后可能导致匹配失败。");
    }
  }
  if (rule.routeKinds?.includes("heartbeat") && (!Array.isArray(rule.schedules) || rule.schedules.length === 0)) {
    issues.push("包含 heartbeat 但没有定时计划，只能通过手动触发验证。");
  }
  return issues;
}

function ruleNotes(rule: NotificationRule): string[] {
  const notes: string[] = [];
  if (!String(rule.template || "").trim()) {
    notes.push("模板为空时仍会发送基础 AgentPacket，只是不追加自定义模板正文。");
  }
  if (rule.regex && /\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    notes.push("正则包含路由变量，保存后会按运行时变量展开再匹配。");
  }
  return notes;
}

function toggleRouteKind(kind: string, checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  if (checked) next.add(kind);
  else next.delete(kind);
  patchRule({ routeKinds: [...next] });
}

function setRouteKinds(kinds: string[], checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  kinds.forEach(kind => {
    if (checked) next.add(kind);
    else next.delete(kind);
  });
  patchRule({ routeKinds: [...next] });
}

function addSchedule(): void {
  if (!activeRule.value || !gateway.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const schedule = defaultHeartbeatSchedule(gateway.value, `计划 ${schedules.length + 1}`);
  patchRule({ schedules: [...schedules, schedule] });
}

function updateSchedule(index: number, patch: Partial<NotificationScheduleDefinition>): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const current = schedules[index];
  if (!current) return;
  schedules[index] = { ...current, ...patch };
  patchRule({ schedules });
}

function setScheduleType(index: number, type: string): void {
  if (type !== "interval" && type !== "daily_time" && type !== "once_at") return;
  updateSchedule(index, { type });
}

function removeSchedule(index: number): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  schedules.splice(index, 1);
  patchRule({ schedules });
}

function setRole(value: string): void {
  if (!gateway.value) return;
  gateway.value.agentRoleId = value;
  if (!value) gateway.value.notificationRules = [];
  store.touch();
}

function chooseAvatar(): void {
  avatarInput.value?.click();
}

async function uploadAvatar(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !gateway.value?.agentRoleId) return;
  avatarSaving.value = true;
  avatarError.value = "";
  try {
    await personaAvatarClient.upload(gateway.value.agentRoleId, file);
    await Promise.all([store.load({ replaceDirtyConfig: !store.dirty }), speech.refreshPersonas()]);
  } catch (error) {
    avatarError.value = error instanceof Error ? error.message : String(error);
  } finally {
    avatarSaving.value = false;
  }
}

async function removeAvatar(): Promise<void> {
  if (!gateway.value?.agentRoleId) return;
  avatarSaving.value = true;
  avatarError.value = "";
  try {
    await personaAvatarClient.remove(gateway.value.agentRoleId);
    await Promise.all([store.load({ replaceDirtyConfig: !store.dirty }), speech.refreshPersonas()]);
  } catch (error) {
    avatarError.value = error instanceof Error ? error.message : String(error);
  } finally {
    avatarSaving.value = false;
  }
}

function setSpeechTriggerKeywords(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.speechTriggerKeywords = normalizeSpeechTriggerKeywords(value);
  store.touch();
}

function recentMessageLimitFor(endpoint: RecentMessageEndpoint): number {
  return normalizeRecentMessageLimit(gateway.value?.recentMessageLimits?.[endpoint]);
}

function setRecentMessageLimit(endpoint: RecentMessageEndpoint, value: unknown): void {
  if (!gateway.value) return;
  gateway.value.recentMessageLimits = {
    ...(gateway.value.recentMessageLimits || {}),
    [endpoint]: normalizeRecentMessageLimit(value)
  };
  store.touch();
}

async function refreshVoiceProfile(): Promise<void> {
  voiceProfileRefreshing.value = true;
  voiceProfileError.value = "";
  try {
    await speech.refreshPersonas();
  } catch (error) {
    voiceProfileError.value = error instanceof Error ? error.message : String(error);
  } finally {
    voiceProfileRefreshing.value = false;
  }
}

async function copyVoiceProfilePath(): Promise<void> {
  voiceProfileCopyResult.value = "";
  try {
    if (!navigator.clipboard) throw new Error("当前浏览器不支持剪贴板写入");
    await navigator.clipboard.writeText(voiceProfilePath.value);
    voiceProfileCopyResult.value = "voice-profile.json 路径已复制";
  } catch (error) {
    voiceProfileCopyResult.value = error instanceof Error ? error.message : String(error);
  }
}

function clearVoiceIdentityReview(): void {
  voiceIdentitySummary.value = null;
  voiceIdentities.value = [];
  voiceIdentityError.value = "";
  voiceIdentityNotice.value = "";
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
}

async function refreshVoiceIdentityReview(observeConfirmation = false): Promise<void> {
  if (observeConfirmation) voiceIdentityRefreshObserveQueued = true;
  if (voiceIdentityRefreshRunning) {
    voiceIdentityRefreshQueued = true;
    return;
  }
  voiceIdentityRefreshRunning = true;
  voiceIdentityLoading.value = true;
  voiceIdentityError.value = "";
  try {
    do {
      voiceIdentityRefreshQueued = false;
      const shouldObserveConfirmation = voiceIdentityRefreshObserveQueued;
      voiceIdentityRefreshObserveQueued = false;
      const roleId = gateway.value?.agentRoleId || "";
      if (!roleId) {
        clearVoiceIdentityReview();
        break;
      }
      const now = Date.now();
      const from = new Date(now - 24 * 60 * 60 * 1_000).toISOString();
      const to = new Date(now).toISOString();
      const [summary, identities] = await Promise.all([
        personaVoiceIdentityClient.summary(roleId, from, to),
        personaVoiceIdentityClient.identities(roleId)
      ]);
      if (gateway.value?.agentRoleId !== roleId) {
        voiceIdentityRefreshQueued = true;
        continue;
      }
      voiceIdentitySummary.value = summary.summary;
      voiceIdentities.value = identities.identities;
      if (shouldObserveConfirmation) {
        voiceConfirmation.value = observePersonaVoiceConfirmation(
          voiceConfirmation.value,
          summary.summary.unresolvedVoiceprints
        );
      }
    } while (voiceIdentityRefreshQueued);
  } catch (error) {
    voiceIdentityError.value = error instanceof Error ? error.message : String(error);
  } finally {
    voiceIdentityLoading.value = false;
    voiceIdentityRefreshRunning = false;
  }
}

function voiceIdentityKey(sourceHostId: string | undefined, voiceprintId: string): string {
  return personaVoiceprintEvidenceKey(sourceHostId, voiceprintId);
}

function startVoiceConfirmation(): void {
  voiceIdentityNotice.value = "";
  voiceIdentityError.value = "";
  voiceConfirmation.value = beginPersonaVoiceConfirmation(unresolvedVoiceprints.value);
}

function cancelVoiceConfirmation(): void {
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
}

function shortVoiceprint(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function shortHost(value: string | undefined): string {
  if (!value) return "缺少主机标识";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function compactDuration(value: number): string {
  const seconds = Math.max(0, Number(value) || 0);
  return `${seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10} s`;
}

function voiceIdentityLabel(identity: PersonaVoiceIdentity): string {
  if (identity.conflicted) return "有冲突";
  if (identity.isUser === true) return "这是我";
  if (identity.isUser === false) return "其他人";
  return "未判断";
}

function voiceIdentityColor(identity: PersonaVoiceIdentity): string | undefined {
  if (identity.conflicted) return "warning";
  if (identity.isUser === true) return "success";
  if (identity.isUser === false) return "secondary";
  return undefined;
}

async function setVoiceIdentity(
  sourceHostId: string | undefined,
  sourceHostName: string | undefined,
  voiceprintId: string,
  isUser: boolean | null
): Promise<void> {
  const roleId = gateway.value?.agentRoleId || "";
  if (!roleId || !sourceHostId) return;
  const key = voiceIdentityKey(sourceHostId, voiceprintId);
  voiceIdentityBusyKey.value = key;
  voiceIdentityError.value = "";
  voiceIdentityNotice.value = "";
  try {
    const result = await personaVoiceIdentityClient.update(roleId, {
      sourceHostId,
      sourceHostName,
      voiceprintId,
      isUser
    });
    voiceIdentityNotice.value = result.appended ? "人格声纹关系已更新。" : "当前人格已经是这个判断。";
    if (voiceConfirmation.value.candidateKeys.includes(key)) cancelVoiceConfirmation();
    await refreshVoiceIdentityReview();
  } catch (error) {
    voiceIdentityError.value = error instanceof Error ? error.message : String(error);
  } finally {
    voiceIdentityBusyKey.value = "";
  }
}

function personaSyncEventData(raw: Event): { roleId?: string; path?: string } | null {
  try {
    return JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; path?: string };
  } catch {
    return null;
  }
}

function relevantPersonaSyncEvent(raw: Event): boolean {
  const data = personaSyncEventData(raw);
  if (!data) return false;
  try {
    const roleId = gateway.value?.agentRoleId || "";
    if (!roleId || data.roleId !== roleId) return false;
    const relativePath = String(data.path || "").replace(/\\/g, "/");
    return !relativePath
      || relativePath === "voice/voice-identities.jsonl"
      || relativePath === "voice-transcripts.jsonl"
      || relativePath.startsWith("conversation/");
  } catch {
    return false;
  }
}

function startPersonaEvents(): void {
  if (managerEvents) return;
  managerEvents = new EventSource("/api/events");
  managerEvents.addEventListener("ready", () => {
    if (managerEventsReady) {
      personaSyncManifestVersion.value += 1;
      personaSyncPeerVersion.value += 1;
      void refreshVoiceIdentityReview();
    }
    else managerEventsReady = true;
  });
  managerEvents.addEventListener("persona_voice_identity_changed", (raw) => {
    if (relevantPersonaSyncEvent(raw)) void refreshVoiceIdentityReview();
  });
  managerEvents.addEventListener("persona_sync_manifest_changed", (raw) => {
    const data = personaSyncEventData(raw);
    const roleId = gateway.value?.agentRoleId || "";
    if (roleId && (!data?.roleId || data.roleId === roleId)) personaSyncManifestVersion.value += 1;
    if (relevantPersonaSyncEvent(raw)) void refreshVoiceIdentityReview();
  });
  managerEvents.addEventListener("rabilink_status", () => {
    personaSyncPeerVersion.value += 1;
  });
  managerEvents.addEventListener("persona_sync_lan_status", () => {
    personaSyncPeerVersion.value += 1;
  });
  managerEvents.addEventListener("persona_sync_auto_status", () => {
    personaSyncManifestVersion.value += 1;
    personaSyncPeerVersion.value += 1;
  });
}

function updateVariableKey(oldKey: string, value: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  store.updateRouteVariable(oldKey, target?.value || oldKey, value);
}

watch(() => gateway.value?.agentRoleId, (roleId) => {
  voiceProfileCopyResult.value = "";
  voiceIdentityNotice.value = "";
  voiceConfirmation.value = idlePersonaVoiceConfirmation();
  if (roleId) {
    void refreshVoiceProfile();
    void refreshVoiceIdentityReview();
  } else {
    voiceProfileError.value = "";
    clearVoiceIdentityReview();
  }
}, { immediate: true });

watch(() => speech.recordsVersion, () => {
  if (hasPersona.value) void refreshVoiceIdentityReview(true);
});

onMounted(async () => {
  releaseSpeech = await speech.acquire();
  startPersonaEvents();
});

onBeforeUnmount(() => {
  releaseSpeech?.();
  releaseSpeech = null;
  managerEvents?.close();
  managerEvents = null;
  managerEventsReady = false;
});

// URL ↔ gateway 双向同步（放最后避免 TDZ）
watch([() => route.params.id as string, () => store.gateways], ([id]) => {
  if (!id || !store.gateways.length) return;
  const found = store.gateways.find(g => configNameFor(g) === id || g.id === id);
  if (found && found.id !== store.selectedGatewayId) store.selectGateway(found.id);
}, { immediate: true });

watch(() => store.selectedGatewayId, (id) => {
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  if (name && route.params.id !== name) router.replace(`/persona/${name}`);
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">人格配置</h1>
        <div class="page-subtitle">人格可以留空；留空时只使用消息入口默认包装和回传 API。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-btn v-if="hasPersona" prepend-icon="mdi-account-edit-outline" variant="tonal" @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')">打开人格配置</v-btn>
        <v-btn v-if="hasPersona" prepend-icon="mdi-file-code-outline" variant="tonal" @click="store.openConfigFile('role-message-config', gateway.id, gateway.agentRoleId || '')">打开消息模板配置</v-btn>
        <v-btn v-if="hasPersona" prepend-icon="mdi-plus" color="secondary" variant="tonal" @click="store.addRule">新增消息模板规则</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="summary-grid">
        <div class="summary-tile persona-summary-tile">
          <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="selectedRole?.avatarUrl" :size="42" />
          <div>
            <span>当前人格</span>
            <b data-no-i18n>{{ gateway.agentRoleId || "不注入人格" }}</b>
          </div>
        </div>
        <div class="summary-tile">
          <span>消息模板</span>
          <b>{{ hasPersona ? `${rules.length} 条规则` : "入口默认" }}</b>
        </div>
        <div class="summary-tile">
          <span>{{ hasPersona ? "角色目录" : "运行模式" }}</span>
          <b :data-no-i18n="hasPersona ? '' : undefined">{{ hasPersona ? roleDirLabel : "无人格直通" }}</b>
        </div>
      </div>

      <div class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格配置</div>
              <div class="section-note">当前路由指向 {{ gateway.agentRoleId || "无人格直通模式" }}。</div>
            </div>
          </div>
          <div class="form-grid">
            <v-select
              :model-value="gateway.agentRoleId || ''"
              :items="roleOptions"
              label="指向人格"
              @update:model-value="value => setRole(String(value || ''))"
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps">
                  <template #prepend><PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="32" /></template>
                </v-list-item>
              </template>
              <template #selection="{ item }">
                <div class="d-flex align-center ga-2">
                  <PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="26" />
                  <span>{{ item.raw.title }}</span>
                </div>
              </template>
            </v-select>
            <v-text-field v-if="hasPersona" v-model="gateway.agentRoleFile" label="人格文件名" placeholder="persona.md" @update:model-value="store.touch" />
          </div>
          <template v-if="hasPersona">
            <div class="persona-identity-row mt-3">
              <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="selectedRole?.avatarUrl" :size="76" rounded="xl" />
              <div class="persona-identity-copy">
                <strong data-no-i18n>{{ gateway.agentRoleId }}</strong>
                <span>头像会用于人格选择、总览、语音和本地角色面板；未设置时显示人格首字。</span>
                <div class="d-flex ga-2 flex-wrap mt-2">
                  <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-image-edit-outline" :loading="avatarSaving" @click="chooseAvatar">
                    {{ selectedRole?.avatarConfigured ? "更换头像" : "设置头像" }}
                  </v-btn>
                  <v-btn v-if="selectedRole?.avatarConfigured" size="small" color="error" variant="text" prepend-icon="mdi-image-remove-outline" :disabled="avatarSaving" @click="removeAvatar">移除</v-btn>
                </div>
                <input ref="avatarInput" class="d-none" type="file" :accept="PERSONA_AVATAR_ACCEPT" @change="uploadAvatar" />
              </div>
            </div>
            <v-alert v-if="avatarError" class="mt-3" type="error" variant="tonal" density="compact">{{ avatarError }}</v-alert>
            <div class="status-row mt-3"><span>角色目录</span><b data-no-i18n>{{ roleDirLabel }}</b></div>
            <div class="status-row"><span>人格路径</span><b data-no-i18n>{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "-" }}</b></div>
          </template>
          <v-alert v-else class="mt-3" type="info" variant="tonal">
            这条路由不会注入人格、计划或记忆；RabiRoute 只把消息来源、原文和回复 API 包装后投递给 Agent。
          </v-alert>
        </v-card>

        <v-card v-if="hasPersona" class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">persona.md 预览</div>
              <div class="section-note" :data-no-i18n="selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath ? '' : undefined">{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "未读取到人格文件" }}</div>
            </div>
          </div>
          <v-alert v-if="selectedRole?.roleError || runtime.roleInfo?.selectedRoleError" type="error" variant="tonal">
            {{ selectedRole?.roleError || runtime.roleInfo?.selectedRoleError }}
          </v-alert>
          <pre v-else class="mono-box">{{ selectedRole?.roleContent || runtime.roleInfo?.selectedRoleContent || "角色文件为空或尚未刷新。" }}</pre>
        </v-card>
        <v-card v-else class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">默认消息包装</div>
              <div class="section-note">消息命中后会直接进入 Agent，不读取角色文件。</div>
            </div>
          </div>
          <div class="empty-state compact-empty">
            <div>
              <strong>回复必须走 RabiRoute 回传 API</strong>
              <span>Agent 会看到来源、发送者、消息目标和 `/api/agent/replies`，需要发回消息端的文本都应通过该 API 投递。</span>
            </div>
          </div>
        </v-card>
      </div>

      <div v-if="hasPersona" class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格语音</div>
              <div class="section-note">
                TTS 模型、声线、语言、语速和发声说明统一由当前人格的 <code>voice/voice-profile.json</code> 管理。
              </div>
            </div>
            <div class="d-flex ga-2 flex-wrap">
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-refresh"
                :loading="voiceProfileRefreshing"
                @click="refreshVoiceProfile"
              >
                刷新摘要
              </v-btn>
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-account-edit-outline"
                @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')"
              >
                打开 persona.md
              </v-btn>
              <v-btn
                size="small"
                color="secondary"
                variant="tonal"
                prepend-icon="mdi-content-copy"
                @click="copyVoiceProfilePath"
              >
                复制 voice-profile 路径
              </v-btn>
              <v-btn size="small" variant="text" prepend-icon="mdi-account-voice" to="/speech">
                测试人格 TTS
              </v-btn>
            </div>
          </div>
          <v-alert v-if="voiceProfileError" type="warning" variant="tonal" density="compact" class="mb-3">
            {{ voiceProfileError }}
          </v-alert>
          <v-alert v-if="voiceProfileCopyResult" type="info" variant="tonal" density="compact" class="mb-3">
            {{ voiceProfileCopyResult }}
          </v-alert>
          <div class="persona-speech-summary">
            <div>
              <span>声线状态</span>
              <b>{{ voiceProfile ? (voiceProfile.voiceReady ? "已配置人格声线" : "使用模型默认声线") : "尚未读取" }}</b>
            </div>
            <div>
              <span>TTS 模型</span>
              <b data-no-i18n>{{ voiceProfile?.defaultModel || "未配置" }}</b>
            </div>
            <div>
              <span>语言</span>
              <b data-no-i18n>{{ voiceProfile?.language || "未配置" }}</b>
            </div>
            <div>
              <span>语速</span>
              <b>{{ voiceProfile?.speed != null ? `${voiceProfile.speed}×` : "未配置" }}</b>
            </div>
          </div>
          <v-textarea
            class="mt-3"
            :model-value="voiceProfile?.instructions || voiceProfile?.voiceStyleSummary || '未配置'"
            label="发声说明 / 表达方式"
            rows="3"
            auto-grow
            readonly
            hide-details
          />
          <v-text-field
            class="mt-3"
            :model-value="voiceProfilePath"
            label="voice-profile.json 路径"
            readonly
            hide-details
            data-no-i18n
          />
          <v-alert class="mt-3" type="info" variant="tonal" density="compact">
            <code>voice-profile.json</code> 是人格 TTS 的唯一配置入口。WebGUI 只读取安全摘要，不显示真实 voice ID 或 API key；复制路径后可直接编辑模型、声线绑定、语言、语速和发声说明。
          </v-alert>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">语音唤醒</div>
              <div class="section-note">关键词归人格所有，所有绑定该人格的语音 Route 共用。</div>
            </div>
            <v-chip
              :color="gateway.speechPushMode === 'keyword' ? 'success' : 'secondary'"
              variant="tonal"
            >
              {{ gateway.speechPushMode === "keyword" ? "当前 Route：关键词唤醒" : "当前 Route：热投递" }}
            </v-chip>
          </div>
          <v-combobox
            :model-value="gateway.speechTriggerKeywords || []"
            label="语音唤醒关键词"
            multiple
            chips
            closable-chips
            clearable
            hint="输入关键词后按 Enter。空白、重复项和大小写匹配由配置层统一归一化。"
            persistent-hint
            @update:model-value="setSpeechTriggerKeywords"
          />
          <v-alert class="mt-3" type="info" variant="tonal" density="compact">
            关闭 Route 的“热投递”后，只有 ASR 文本命中这里的关键词才提醒 Agent；所有 ASR 仍会持续记录。
          </v-alert>
          <v-alert
            v-if="gateway.speechPushMode === 'keyword' && !(gateway.speechTriggerKeywords || []).length"
            class="mt-3"
            type="warning"
            variant="tonal"
            density="compact"
          >
            当前关键词为空：转写会继续记录，但不会唤醒 Agent。建议至少加入人格名和常用称呼。
          </v-alert>
        </v-card>
      </div>

      <PersonaSyncCard
        v-if="hasPersona"
        :role-id="gateway.agentRoleId || ''"
        :manifest-version="personaSyncManifestVersion"
        :peer-version="personaSyncPeerVersion"
      />

      <v-card v-if="hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">人格声纹归类</div>
            <div class="section-note">统计最近 24 小时。主机只提供不透明声纹证据，由当前人格明确判断“这是我”或“其他人”。</div>
          </div>
          <v-btn
            size="small"
            variant="text"
            prepend-icon="mdi-refresh"
            :loading="voiceIdentityLoading"
            @click="refreshVoiceIdentityReview(true)"
          >
            刷新归类
          </v-btn>
        </div>

        <v-alert type="info" variant="tonal" density="compact" class="mb-3">
          页面只读取统计、声纹缩写和人格关系，不读取或展示转写正文。新录音、声纹修正和多电脑人格同步会通过事件触发一次刷新。
        </v-alert>
        <v-alert v-if="voiceIdentityError" type="error" variant="tonal" density="compact" class="mb-3">
          {{ voiceIdentityError }}
        </v-alert>
        <v-alert v-if="voiceIdentityNotice" type="success" variant="tonal" density="compact" class="mb-3">
          {{ voiceIdentityNotice }}
        </v-alert>
        <v-progress-linear v-if="voiceIdentityLoading" indeterminate color="secondary" class="mb-3" />

        <div class="persona-speech-summary">
          <div>
            <span>归类覆盖率</span>
            <b>{{ Math.round((voiceIdentitySummary?.coverageRate || 0) * 100) }}%</b>
          </div>
          <div>
            <span>我的发言</span>
            <b>{{ voiceIdentitySummary?.byClassification.user.segments || 0 }} 个分段</b>
            <small data-no-i18n>{{ compactDuration(voiceIdentitySummary?.byClassification.user.speakerDurationSeconds || 0) }}</small>
          </div>
          <div>
            <span>其他人</span>
            <b>{{ voiceIdentitySummary?.byClassification.other.segments || 0 }} 个分段</b>
            <small data-no-i18n>{{ compactDuration(voiceIdentitySummary?.byClassification.other.speakerDurationSeconds || 0) }}</small>
          </div>
          <div>
            <span>未判断 / 冲突</span>
            <b>{{ (voiceIdentitySummary?.byClassification.unknown.segments || 0) + (voiceIdentitySummary?.byClassification.conflict.segments || 0) }} 个分段</b>
            <small data-no-i18n>{{ compactDuration((voiceIdentitySummary?.byClassification.unknown.speakerDurationSeconds || 0) + (voiceIdentitySummary?.byClassification.conflict.speakerDurationSeconds || 0)) }}</small>
          </div>
        </div>

        <v-alert
          class="mt-4"
          :type="voiceConfirmation.status === 'found' ? 'success' : 'info'"
          variant="tonal"
          density="compact"
        >
          <div class="d-flex justify-space-between ga-3 align-center flex-wrap">
            <div v-if="voiceConfirmation.status === 'idle'">
              <strong>不知道哪个声纹是自己？</strong>
              <div>开始后，用准备归类的电脑、手机或眼镜只让本人连续说一句；下一次录音事件会把本次新出现的未归类声纹标出来。</div>
            </div>
            <div v-else-if="voiceConfirmation.status === 'waiting'">
              <strong>正在等待下一段未归类声纹</strong>
              <div>请尽量保持环境安静，只让本人说话。系统只标记本次候选，不会自动判断身份。</div>
            </div>
            <div v-else>
              <strong>已找到 {{ voiceConfirmationCandidateCount }} 个本次候选</strong>
              <div>如果同时出现多个声纹，只确认你能确定由本人说出的项；系统不会因候选唯一就自动设为用户。</div>
            </div>
            <div class="d-flex ga-2 flex-wrap">
              <v-btn
                v-if="voiceConfirmation.status !== 'waiting'"
                size="small"
                color="secondary"
                variant="tonal"
                prepend-icon="mdi-account-voice"
                @click="startVoiceConfirmation"
              >
                {{ voiceConfirmation.status === "found" ? "重新捕获" : "标记下一段" }}
              </v-btn>
              <v-btn
                v-if="voiceConfirmation.status !== 'idle'"
                size="small"
                variant="text"
                @click="cancelVoiceConfirmation"
              >取消</v-btn>
            </div>
          </div>
        </v-alert>

        <div class="section-title-row mt-5">
          <div>
            <div class="section-title">未解决声纹</div>
            <div class="section-note">优先确认出现次数多、持续时间长或存在多电脑冲突的声纹。</div>
          </div>
          <v-chip color="warning" variant="tonal">{{ unresolvedVoiceprints.length }}</v-chip>
        </div>
        <div v-if="unresolvedVoiceprints.length === 0" class="empty-state compact-empty">
          <div>
            <strong>{{ voiceConfirmation.status === "waiting" ? "正在等待下一段未归类声纹" : "最近 24 小时没有待处理声纹" }}</strong>
            <span>{{ voiceConfirmation.status === "waiting" ? "收到下一段录音事件后会自动刷新；也可以手动点击刷新归类补查一次。" : "没有录音时这里也会保持为空；归类关系仍保存在当前人格目录。" }}</span>
          </div>
        </div>
        <div v-else class="rule-list">
          <div
            v-for="item in orderedUnresolvedVoiceprints"
            :key="voiceIdentityKey(item.sourceHostId, item.voiceprintId)"
            class="rule-card"
          >
            <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong data-no-i18n>{{ shortVoiceprint(item.voiceprintId) }}</strong>
                  <v-chip size="small" :color="item.classification === 'conflict' ? 'warning' : undefined" variant="tonal">
                    {{ item.classification === "conflict" ? "有冲突" : "未判断" }}
                  </v-chip>
                  <v-chip
                    v-if="isPersonaVoiceConfirmationCandidate(voiceConfirmation, item)"
                    size="small"
                    color="success"
                    variant="tonal"
                  >本次出现</v-chip>
                </div>
                <div class="section-note mt-1">
                  {{ item.segments }} 个分段 · <span data-no-i18n>{{ compactDuration(item.speakerDurationSeconds) }}</span> · 最后出现
                  <span data-no-i18n>{{ compactTime(item.lastSeenAt) }}</span>
                </div>
                <div class="section-note" data-no-i18n>{{ item.sourceHostName || shortHost(item.sourceHostId) }}</div>
                <div v-if="!item.sourceHostId" class="text-warning text-caption mt-1">旧记录缺少处理主机标识，不能建立跨电脑稳定关系。</div>
              </div>
              <div class="rule-card-actions">
                <v-btn
                  size="small"
                  color="success"
                  variant="tonal"
                  :disabled="!item.sourceHostId"
                  :loading="voiceIdentityBusyKey === voiceIdentityKey(item.sourceHostId, item.voiceprintId)"
                  @click="setVoiceIdentity(item.sourceHostId, item.sourceHostName, item.voiceprintId, true)"
                >这是我</v-btn>
                <v-btn
                  size="small"
                  color="secondary"
                  variant="tonal"
                  :disabled="!item.sourceHostId"
                  :loading="voiceIdentityBusyKey === voiceIdentityKey(item.sourceHostId, item.voiceprintId)"
                  @click="setVoiceIdentity(item.sourceHostId, item.sourceHostName, item.voiceprintId, false)"
                >其他人</v-btn>
              </div>
            </div>
          </div>
        </div>

        <div class="section-title-row mt-5">
          <div>
            <div class="section-title">已归类关系</div>
            <div class="section-note">关系事件属于当前人格，并随人格文件夹在多台电脑之间合并。</div>
          </div>
          <v-chip color="secondary" variant="tonal">{{ sortedVoiceIdentities.length }}</v-chip>
        </div>
        <div v-if="sortedVoiceIdentities.length === 0" class="empty-state compact-empty">
          <div>
            <strong>当前人格还没有声纹关系</strong>
            <span>确认第一条声纹后会写入 <code>voice/voice-identities.jsonl</code>。</span>
          </div>
        </div>
        <div v-else class="rule-list">
          <div v-for="identity in sortedVoiceIdentities" :key="identity.identityKey" class="rule-card">
            <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong data-no-i18n>{{ shortVoiceprint(identity.voiceprintId) }}</strong>
                  <v-chip size="small" :color="voiceIdentityColor(identity)" variant="tonal">{{ voiceIdentityLabel(identity) }}</v-chip>
                </div>
                <div class="section-note mt-1">
                  <span v-if="identity.displayName" data-no-i18n>{{ identity.displayName }}</span>
                  <span v-else>未设置称呼</span>
                  <template v-if="identity.relationship"> · <span data-no-i18n>{{ identity.relationship }}</span></template>
                </div>
                <div class="section-note">
                  <span data-no-i18n>{{ identity.sourceHostName || shortHost(identity.sourceHostId) }}</span> · 更新于
                  <span data-no-i18n>{{ compactTime(identity.updatedAt) }}</span>
                </div>
              </div>
              <div class="rule-card-actions">
                <v-btn
                  size="small"
                  color="success"
                  variant="text"
                  :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)"
                  @click="setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, true)"
                >这是我</v-btn>
                <v-btn
                  size="small"
                  color="secondary"
                  variant="text"
                  :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)"
                  @click="setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, false)"
                >其他人</v-btn>
                <v-btn
                  size="small"
                  variant="text"
                  :disabled="identity.isUser == null && !identity.conflicted"
                  :loading="voiceIdentityBusyKey === voiceIdentityKey(identity.sourceHostId, identity.voiceprintId)"
                  @click="setVoiceIdentity(identity.sourceHostId, identity.sourceHostName, identity.voiceprintId, null)"
                >清除判断</v-btn>
              </div>
            </div>
          </div>
        </div>
      </v-card>

      <v-card v-if="hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">最近消息上下文</div>
            <div class="section-note">分别控制每个消息端自动注入给当前人格的最近消息数量。</div>
          </div>
          <v-chip color="secondary" variant="tonal">
            默认 {{ DEFAULT_RECENT_MESSAGE_LIMIT }} · 上限 {{ MAX_RECENT_MESSAGE_LIMIT }}
          </v-chip>
        </div>
        <v-alert type="info" variant="tonal" density="compact" class="mb-3">
          设为 0 只停止把该消息端历史自动注入 Agent，不会删除已有消息记录或审计数据。
        </v-alert>
        <div class="rule-list">
          <SpeechParameterSlider
            v-for="endpoint in recentMessageEndpoints"
            :key="endpoint"
            :label="adapterLabel(endpoint)"
            :min="0"
            :max="MAX_RECENT_MESSAGE_LIMIT"
            :step="1"
            suffix="条"
            :hint="`0 表示不注入 ${adapterLabel(endpoint)} 历史；未单独设置时使用 ${DEFAULT_RECENT_MESSAGE_LIMIT} 条。`"
            :model-value="recentMessageLimitFor(endpoint)"
            @update:model-value="value => setRecentMessageLimit(endpoint, value)"
          />
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">路由变量</div>
            <div class="section-note">变量会在规则匹配前按字面量替换，用于昵称、关键词或项目别名。</div>
          </div>
          <v-btn color="secondary" variant="tonal" prepend-icon="mdi-plus" @click="store.addRouteVariable">新增变量</v-btn>
        </div>
        <div v-if="variableEntries.length === 0" class="empty-state">
          <div>
            <strong>暂无自定义路由变量</strong>
            <span>需要给群名、项目名或关键词做别名时，再新增变量。</span>
          </div>
        </div>
        <div v-else class="form-grid">
          <template v-for="[key, value] in variableEntries" :key="key">
            <v-text-field :model-value="key" label="变量名" @change="updateVariableKey(key, value, $event)" />
            <div class="d-flex ga-2 variable-value-row">
              <v-text-field class="flex-grow-1" :model-value="value" label="变量值" @update:model-value="next => store.updateRouteVariable(key, key, String(next || ''))" />
              <v-btn icon="mdi-delete" color="error" variant="text" @click="store.removeRouteVariable(key)" />
            </div>
          </template>
        </div>
      </v-card>

      <v-card v-if="!hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">默认消息规则</div>
            <div class="section-note">无人格模式按已启用消息入口生成默认命中规则。</div>
          </div>
          <v-chip color="secondary" variant="tonal">入口默认</v-chip>
        </div>
        <div class="rule-list">
          <div v-for="rule in rules" :key="rule.id" class="rule-card">
            <div class="font-weight-bold text-primary" data-no-i18n>{{ rule.name }}</div>
            <div class="section-note">{{ routeKindSummary(rule) }}</div>
          </div>
        </div>
      </v-card>

      <v-card v-if="hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息模板规则</div>
            <div class="section-note">命中消息后，按这些模板包装再发送给 Agent。</div>
          </div>
          <div class="d-flex ga-2 flex-wrap">
            <v-chip v-if="ruleDiagnosticsCount" color="warning" variant="tonal">{{ ruleDiagnosticsCount }} 个待检查项</v-chip>
            <v-chip color="secondary" variant="tonal">{{ rules.length }} 条模板</v-chip>
          </div>
        </div>
        <v-alert v-if="ruleDiagnosticsCount" type="warning" variant="tonal" density="compact" class="mb-3">
          有规则可能无法按预期命中。展开对应规则后可查看具体提示，修正后再保存。
        </v-alert>
        <div v-if="rules.length === 0" class="empty-state">
          <div>
            <strong>暂无消息模板规则</strong>
            <span>新增消息模板规则后，RabiRoute 才知道命中的消息要怎样包装给 Agent。</span>
          </div>
        </div>
        <div v-else class="rule-list">
          <div v-for="(rule, index) in rules" :key="rule.id" class="rule-card">
            <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
              <div class="min-w-0">
                <div class="font-weight-bold text-primary" data-no-i18n>{{ rule.name }}</div>
                <div class="section-note">{{ routeKindSummary(rule) }} · {{ rule.regex ? `匹配：${rule.regex}` : "不限关键词" }}</div>
                <div class="section-note mt-1" :data-no-i18n="rule.template ? '' : undefined">{{ ruleTemplateSnippet(rule) }}</div>
                <div v-if="ruleDiagnostics(rule).length" class="mt-2 d-flex ga-2 flex-wrap">
                  <v-chip
                    v-for="issue in ruleDiagnostics(rule)"
                    :key="issue"
                    size="small"
                    color="warning"
                    variant="tonal"
                  >
                    {{ issue }}
                  </v-chip>
                </div>
                <div v-if="ruleNotes(rule).length" class="mt-2 d-flex ga-2 flex-wrap">
                  <v-chip
                    v-for="note in ruleNotes(rule)"
                    :key="note"
                    size="small"
                    color="secondary"
                    variant="tonal"
                  >
                    {{ note }}
                  </v-chip>
                </div>
              </div>
              <div class="rule-card-actions">
                <v-switch
                  v-if="!isBuiltinRolePanelRule(rule)"
                  :model-value="rule.enabled !== false"
                  :label="rule.enabled !== false ? '启用规则' : '停用规则'"
                  color="success"
                  density="compact"
                  inset
                  hide-details
                  @click.stop
                  @update:model-value="value => store.updateRule(index, { enabled: Boolean(value) })"
                />
                <v-btn size="small" variant="tonal" @click="openRule(index)">编辑</v-btn>
              </div>
            </div>
          </div>
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">可用模板变量</div>
            <div class="section-note">模板中用 `{变量名}` 引用。</div>
          </div>
        </div>
        <div class="template-vars">
          <div v-for="item in templateVars" :key="item.name" class="template-var">
            <code>{ {{ item.name }} }</code>
            <span>{{ item.description }}</span>
          </div>
        </div>
      </v-card>
    </template>

    <v-dialog v-model="ruleDialog" max-width="1080" class="editor-dialog">
      <v-card v-if="activeRule && gateway" class="app-card editor-dialog-card">
        <v-card-title class="d-flex justify-space-between align-center ga-3">
          <div>
            <div class="section-title">规则设置</div>
            <div class="section-note">{{ gateway.agentRoleId || "未指向人格" }} · {{ activeRule.id }}</div>
          </div>
          <div class="rule-dialog-actions">
            <v-switch
              v-if="!isBuiltinRolePanelRule(activeRule)"
              :model-value="activeRule.enabled !== false"
              label="启用规则"
              color="success"
              inset
              hide-details
              @update:model-value="value => patchRule({ enabled: Boolean(value) })"
            />
            <v-btn icon="mdi-close" variant="text" @click="ruleDialog = false" />
          </div>
        </v-card-title>
        <v-card-text>
          <v-alert v-if="activeRuleDiagnostics.length" type="warning" variant="tonal" density="compact" class="mb-3">
            <div v-for="issue in activeRuleDiagnostics" :key="issue">{{ issue }}</div>
          </v-alert>
          <v-alert v-if="activeRuleNotes.length" type="info" variant="tonal" density="compact" class="mb-3">
            <div v-for="note in activeRuleNotes" :key="note">{{ note }}</div>
          </v-alert>
          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleMatchParamsOpen = !ruleMatchParamsOpen">
              <span>
                <strong>规则参数</strong>
                <small>名称、匹配正则和目标群号</small>
              </span>
              <v-icon>{{ ruleMatchParamsOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleMatchParamsOpen" class="fold-section-body">
                <div class="form-grid">
                  <v-text-field :model-value="activeRule.name" label="规则名称" @update:model-value="value => patchRule({ name: String(value || '') })" />
                  <v-text-field :model-value="activeRule.regex" label="消息匹配正则" placeholder="例如：需求|报错|构建失败" @update:model-value="value => patchRule({ regex: String(value || '') })" />
                  <v-text-field
                    v-if="ruleHasGroupRoute(activeRule)"
                    class="full-span"
                    :model-value="activeRule.targetGroupId"
                    label="目标群号"
                    placeholder="留空=不限群"
                    @update:model-value="value => patchRule({ targetGroupId: String(value || '') })"
                  />
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleRouteKindsOpen = !ruleRouteKindsOpen">
              <span>
                <strong>路由类型</strong>
                <small>一条规则可以同时作用于多个管道</small>
              </span>
              <v-icon>{{ ruleRouteKindsOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleRouteKindsOpen" class="fold-section-body">
                <div class="config-toolbar">
                  <v-text-field
                    v-model="routeKindQuery"
                    density="compact"
                    prepend-inner-icon="mdi-magnify"
                    label="搜索路由类型"
                    hide-details
                    clearable
                  />
                  <div class="selected-pill-row">
                    <v-chip size="small" color="secondary" variant="tonal">已选 {{ selectedRouteKindCount }}</v-chip>
                    <v-btn size="small" variant="text" @click="setRouteKinds(activeRule.routeKinds || [], false)">清空</v-btn>
                  </div>
                </div>
                <div class="route-kind-catalog">
                  <section v-for="definition in visibleRouteKindDefinitions" :key="definition.adapter" class="catalog-section">
                    <div class="catalog-section-head">
                      <div>
                        <div class="catalog-section-title">{{ definition.title }}</div>
                        <div class="section-note">{{ definition.note }}</div>
                      </div>
                    </div>
                    <div v-for="group in definition.groups" :key="group.title" class="route-kind-group">
                      <div class="route-kind-group-head">
                        <span>{{ group.title }}</span>
                        <div class="d-flex ga-1">
                          <v-btn size="x-small" variant="text" @click="setRouteKinds(group.routeKinds, true)">全选</v-btn>
                          <v-btn size="x-small" variant="text" @click="setRouteKinds(group.routeKinds, false)">清空</v-btn>
                        </div>
                      </div>
                      <div class="route-kind-chip-grid">
                        <button
                          v-for="kind in group.routeKinds"
                          :key="kind"
                          class="route-kind-chip"
                          :class="{ active: activeRule.routeKinds?.includes(kind) }"
                          type="button"
                          @click="toggleRouteKind(kind, !activeRule.routeKinds?.includes(kind))"
                        >
                          <v-icon size="18">{{ activeRule.routeKinds?.includes(kind) ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                          <span>{{ routeKindLabels[kind] || kind }}</span>
                          <code>{{ kind }}</code>
                        </button>
                      </div>
                    </div>
                  </section>
                  <div v-if="visibleRouteKindDefinitions.length === 0" class="empty-state compact-empty">
                    <div>
                      <strong>没有匹配的路由类型</strong>
                      <span>清空搜索后可以看到全部类型。</span>
                    </div>
                  </div>
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section v-if="activeRuleHasHeartbeat" class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleSchedulesOpen = !ruleSchedulesOpen">
              <span>
                <strong>定时计划</strong>
                <small>一条 heartbeat 模板规则可以有多个触发计划</small>
              </span>
              <v-icon>{{ ruleSchedulesOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleSchedulesOpen" class="fold-section-body">
                <div class="section-title-row compact-row">
                  <div>
                    <div class="section-title small-title">触发计划</div>
                    <div class="section-note">消息端只负责启用内部定时来源；这里决定什么时候触发这条模板。</div>
                  </div>
                  <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-plus" @click="addSchedule">新增计划</v-btn>
                </div>
                <div v-if="!activeRule.schedules?.length" class="empty-state compact-empty">
                  <div>
                    <strong>暂无定时计划</strong>
                    <span>新增后，这条 heartbeat 模板才会被定时触发。</span>
                  </div>
                </div>
                <div v-else class="rule-list">
                  <div v-for="(schedule, scheduleIndex) in activeRule.schedules" :key="schedule.id" class="rule-card">
                    <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
                      <div class="min-w-0 flex-grow-1">
                        <div class="form-grid">
                          <v-text-field
                            :model-value="schedule.name"
                            label="计划名称"
                            @update:model-value="value => updateSchedule(scheduleIndex, { name: String(value || '') })"
                          />
                          <v-select
                            :model-value="schedule.type"
                            :items="scheduleTypeOptions"
                            label="定时类型"
                            @update:model-value="value => setScheduleType(scheduleIndex, String(value || 'interval'))"
                          />
                          <template v-if="schedule.type === 'interval'">
                            <v-text-field
                              :model-value="schedule.intervalSeconds"
                              type="number"
                              min="1"
                              step="1"
                              label="间隔秒数"
                              @update:model-value="value => updateSchedule(scheduleIndex, { intervalSeconds: Number(value || 900) })"
                            />
                            <v-text-field
                              :model-value="schedule.windowStartTime"
                              label="时间段开始"
                              placeholder="09:30"
                              @update:model-value="value => updateSchedule(scheduleIndex, { windowStartTime: String(value || '') })"
                            />
                            <v-text-field
                              :model-value="schedule.windowEndTime"
                              label="时间段结束"
                              placeholder="19:00"
                              @update:model-value="value => updateSchedule(scheduleIndex, { windowEndTime: String(value || '') })"
                            />
                          </template>
                          <v-text-field
                            v-else-if="schedule.type === 'daily_time'"
                            :model-value="schedule.timeOfDay"
                            label="每天时间"
                            placeholder="09:30"
                            @update:model-value="value => updateSchedule(scheduleIndex, { timeOfDay: String(value || '') })"
                          />
                          <v-text-field
                            v-else
                            :model-value="schedule.onceAt"
                            type="datetime-local"
                            label="指定日期时间"
                            @update:model-value="value => updateSchedule(scheduleIndex, { onceAt: String(value || '') })"
                          />
                        </div>
                      </div>
                      <div class="rule-card-actions">
                        <v-switch
                          :model-value="schedule.enabled !== false"
                          :label="schedule.enabled !== false ? '启用计划' : '停用计划'"
                          color="success"
                          density="compact"
                          inset
                          hide-details
                          @update:model-value="value => updateSchedule(scheduleIndex, { enabled: Boolean(value) })"
                        />
                        <v-btn size="small" color="error" variant="text" @click="removeSchedule(scheduleIndex)">删除</v-btn>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleTemplateOpen = !ruleTemplateOpen">
              <span>
                <strong>Agent 消息包装模板</strong>
                <small>命中后发送给 Agent 的正文</small>
              </span>
              <v-icon>{{ ruleTemplateOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleTemplateOpen" class="fold-section-body">
                <v-textarea
                  :model-value="activeRule.template"
                  label="Agent 消息包装模板"
                  rows="14"
                  auto-grow
                  spellcheck="false"
                  @update:model-value="value => patchRule({ template: String(value || '') })"
                />
              </div>
            </v-expand-transition>
          </section>
        </v-card-text>
        <v-card-actions class="px-6 pb-5">
          <v-btn v-if="!isBuiltinRolePanelRule(activeRule)" color="error" variant="text" @click="store.removeRule(activeRuleIndex); ruleDialog = false">删除规则</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="ruleDialog = false">完成</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
