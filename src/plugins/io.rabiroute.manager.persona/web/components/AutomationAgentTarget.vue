<script setup lang="ts">
import { createDshConnectionClient, type DshConnection } from "../../../../../ribiwebgui/src/dshConnectionClient";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { GatewayDefinition } from "@shared/gatewayConfigModel";
import { normalizeAgentRecipients, normalizeAgentDeliveryTarget, primaryDeliveryTarget, type AgentDeliveryTarget } from "@shared/agentDeliveryTarget";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";
import { usePersonaService } from "../persona/personaServiceClient";
const personaService = usePersonaService();
import { resolvePrimaryAgentTarget, type RouteAgentTarget } from "@shared/routeAgentTargets";
import { agentAdapterSupportsManagedTaskFeature, isAgentThreadCapableAdapter } from "@shared/agentAdapterCapabilities";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { availableAutomationDsh, automationDsBotDirectory, dsBotDirectoryTargets, chooseDsBot, readDsBotCatalog, type DsBotCatalog, changeDeliveryType, changeSendMode, chooseDeliverySession, chooseSenderIdentity, deliverySessions, isGroupSession, senderIdentities, type DeliverySession, type SessionTarget } from "./automationAgentTargetModel";

const props = defineProps<{ gateway: GatewayDefinition; modelValue?: AgentDeliveryTarget }>();
const emit = defineEmits<{ "update:modelValue": [value: AgentDeliveryTarget] }>();
const { t } = useI18n();
const target = computed(() => props.modelValue ?? primaryDeliveryTarget());
const recipients = computed(() => normalizeAgentRecipients(props.gateway.agentRecipients));
const choices = computed(() => [...recipients.value.map(item => {
  const primary = resolvePrimaryAgentTarget(props.gateway);
  const feature = item.executor === "message_pool" ? "messageProcessingAgent" : item.executor === "memory_consolidation" ? "memoryConsolidationAgent" : item.executor === "plan_secretary" ? "planAssistantSessions" : undefined;
  const reason = !primary ? t("未配置主角色 Agent")
    : feature && !agentAdapterSupportsManagedTaskFeature(primary.provider, feature) ? t("当前 Agent 不支持此接收者")
    : item.executor === "plan_secretary" && !props.gateway.codexPlanAssistantSessions?.length ? t("未配置计划秘书会话") : "";
  return { title: t(item.name), value: item.id, description: reason, props: { disabled: Boolean(reason) } };
}), { title: t("自定义"), value: "$session", description: t("选择 Agent 和已有会话"), props: { disabled: false } }]);
const agentName = (provider: string) => provider === "codex" ? "Codex" : provider === "dsh" ? "DSH" : provider === "grokBot" ? "Grok Bot" : provider;
const localDshAvailable = ref(false);
const directoryAgents = ref<RouteAgentTarget[]>([]);
const connections = ref<DshConnection[]>([]);
const selectedDshOrigin = ref("");
const providerError = ref("");
let disposed = false;
async function loadProviders() {
  providerError.value = "";
  const results = await Promise.allSettled([
    availableAutomationDsh(personaService.fetch),
    automationDsBotDirectory(personaService.fetch),
    createDshConnectionClient(personaService.fetch).list()
  ]);
  if (disposed) return;
  const [published, directory, saved] = results;
  if (published.status === "fulfilled") localDshAvailable.value = published.value;
  else providerError.value = String(published.reason);
  if (directory.status === "fulfilled") directoryAgents.value = dsBotDirectoryTargets(directory.value.instances);
  else providerError.value ||= String(directory.reason);
  if (saved.status === "fulfilled") connections.value = saved.value;
}
void loadProviders();
const savedDsBotAgent = computed<RouteAgentTarget[]>(() => {
  if (target.value.kind !== "ds_bot") return [];
  try {
    const saved = normalizeAgentDeliveryTarget(target.value);
    return saved.kind === "ds_bot" ? [{ id: saved.agentTargetId, provider: "dsh", ...(saved.instanceBinding ? { binding: saved.instanceBinding } : {}) }] : [];
  } catch { return []; }
});
const agents = computed<Array<RouteAgentTarget & { title: string }>>(() => [...new Map([
  ...savedDsBotAgent.value.map(agent => ({ ...agent, title: `${agentName(agent.provider)} · ${agent.id}` })),
  ...[...new Set([...(props.gateway.agentAdapters ?? []), ...(localDshAvailable.value ? ["dsh" as const] : [])])].filter(isAgentThreadCapableAdapter).map(provider => ({ id: `local:${provider}`, provider, title: `${agentName(provider)} · ${t("本机")}` })),
  ...directoryAgents.value.map(item => ({ ...item, title: `${agentName(item.provider)} · ${item.binding?.ownerDeviceId ? item.binding.ownerDeviceId + ' / ' : ''}${item.binding?.instanceId} · ${item.binding?.agentId}` })),
  ...(props.gateway.remoteAgentTargets ?? []).filter(item => isAgentThreadCapableAdapter(item.provider)).map(item => ({ ...item, binding: { instanceId: item.instanceId, agentId: item.agentId, ...(item.ownerDeviceId ? { ownerDeviceId: item.ownerDeviceId } : {}) }, title: `${agentName(item.provider)} · ${item.ownerDeviceId ? item.ownerDeviceId + ' / ' : ''}${item.instanceId} · ${item.agentId}` }))
].map(item => [item.id, item])).values()]);
const agentItems = computed(() => {
  const items = agents.value.map(agent => ({ ...agent, props: { disabled: false } }));
  const saved = target.value;
  if ((saved.kind === "session" || saved.kind === "ds_bot") && saved.agentTargetId && !items.some(item => item.id === saved.agentTargetId)) items.unshift({ id: saved.agentTargetId, provider: saved.agentAdapter, title: `${saved.agentTargetId} · ${t("已保存的目标，待核对")}`, props: { disabled: true } });
  return items;
});
const selectedAgentId = ref("");
const destinationMode = ref<"session" | "ds_bot">("session");
const botCatalog = ref<DsBotCatalog>();
const selectedBot = computed(() => target.value.kind === "ds_bot" ? target.value : undefined);
const isDsh = computed(() => agents.value.find(agent => agent.id === selectedAgentId.value)?.provider === "dsh");
const botItems = computed(() => {
  const saved = selectedBot.value;
  const catalog = botCatalog.value;
  const items = (catalog?.bots ?? []).filter(bot => !query.value || `${bot.botName} ${bot.botId}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).map(bot => ({ title: bot.botName, value: bot.botId, botId: bot.botId, props: { disabled: false } }));
  if (saved?.botId && (!catalog || catalog.botScopeId !== saved.botScopeId || !catalog.bots.some(bot => bot.botId === saved.botId))) items.unshift({ title: `${saved.botName} · ${t("已保存的目标，待核对")}`, value: "$saved", botId: saved.botId, props: { disabled: true } });
  return items;
});
const localDshSelected = computed(() => isDsh.value && !agents.value.find(agent => agent.id === selectedAgentId.value)?.binding);
const connectionItems = computed(() => [...new Set([...connections.value.map(connection => connection.baseUrl), ...(selectedDshOrigin.value ? [selectedDshOrigin.value] : [])])]);
function selectDshConnection(value: string) {
  if (!localDshSelected.value || !connectionItems.value.includes(value)) return;
  selectedDshOrigin.value = value; generation++; loading.value = false; searched.value = false; botCatalog.value = undefined; query.value = "";
  emit("update:modelValue", { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", dshBaseUrl: value, botScopeId: "", botId: "", botName: "" });
  void scan();
}
const botSelectionValue = computed(() => {
  const saved = selectedBot.value;
  if (!saved?.botId) return null;
  return botCatalog.value?.botScopeId === saved.botScopeId && botCatalog.value.bots.some(bot => bot.botId === saved.botId) ? saved.botId : "$saved";
});
const missingBot = computed(() => searched.value && selectedBot.value?.botId && botCatalog.value && (botCatalog.value.botScopeId !== selectedBot.value.botScopeId || !botCatalog.value.bots.some(bot => bot.botId === selectedBot.value?.botId)));
const query = ref("");
const loading = ref(false);
const error = ref("");
const searched = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
type Session = DeliverySession;
const sessions = ref<Session[]>([]);
const identitySessions = ref<Session[]>([]);
const identityOffset = ref<number | undefined>();
const identityLoading = ref(false);
const identityError = ref("");
const roomSnapshot = ref<Session>();
let identityGeneration = 0;
const offset = ref<number | undefined>();
let generation = 0;
onBeforeUnmount(() => { disposed = true; generation++; identityGeneration++; clearTimeout(searchTimer); });
watch(() => props.modelValue, value => {
  if (value?.kind === "session" || value?.kind === "ds_bot") {
    if (selectedAgentId.value !== value.agentTargetId || destinationMode.value !== value.kind) {
      clearTimeout(searchTimer); query.value = ""; generation++; loading.value = false;
      sessions.value = []; offset.value = undefined; searched.value = false; error.value = "";
      resetIdentities(); botCatalog.value = undefined;
    }
    destinationMode.value = value.kind;
    if (value.kind === "ds_bot") selectedDshOrigin.value = value.dshBaseUrl ?? "";
    selectedAgentId.value = value.agentTargetId;
    if (value.kind === "session" && value.agentAdapter !== "grokBot" && value.sessionId && !sessions.value.some(item => item.id === value.sessionId)) sessions.value.unshift({ id: value.sessionId, name: value.sessionName, projectPath: value.workspace });
  }
}, { immediate: true });
function selectRecipient(value: string) {
  destinationMode.value = "session"; botCatalog.value = undefined;
  resetIdentities();
  clearTimeout(searchTimer); query.value = ""; selectedAgentId.value = ""; searched.value = false;
  generation++; loading.value = false; error.value = ""; sessions.value = []; offset.value = undefined;
  if (value !== "$session") emit("update:modelValue", { kind: "recipient", recipientId: value });
  else emit("update:modelValue", { kind: "session", agentTargetId: "", agentAdapter: "codex", sessionId: "", sessionName: "", workspace: "" });
}
function selectAgent(value: string) {
  selectedDshOrigin.value = "";
  botCatalog.value = undefined;
  resetIdentities();
  clearTimeout(searchTimer); query.value = ""; searched.value = false;
  generation++; loading.value = false; sessions.value = []; offset.value = undefined; error.value = "";
  selectedAgentId.value = value;
  const agent = agents.value.find(item => item.id === value);
  if (agent) {
    if (agent.provider === "dsh" && destinationMode.value === "ds_bot") {
      emit("update:modelValue", { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: agent.id, botScopeId: "", botId: "", botName: "" });
      void scan(); return;
    }
    destinationMode.value = "session";
    const next: SessionTarget = { kind: "session", agentTargetId: agent.id, agentAdapter: agent.provider, sessionId: "", sessionName: "", workspace: "", ...(agent.provider === "grokBot" ? { deliveryType: "private" as const, sendMode: "direct" as const } : {}) };
    emit("update:modelValue", next);
    void scan();
  }
}
function selectDestinationMode(value: "session" | "ds_bot") {
  if (!isDsh.value) return;
  destinationMode.value = value;
  clearTimeout(searchTimer); query.value = ""; generation++; loading.value = false; searched.value = false;
  sessions.value = []; botCatalog.value = undefined; offset.value = undefined; error.value = ""; resetIdentities();
  if (value === "ds_bot") emit("update:modelValue", { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: selectedAgentId.value, botScopeId: "", botId: "", botName: "" });
  else emit("update:modelValue", { kind: "session", agentAdapter: "dsh", agentTargetId: selectedAgentId.value, sessionId: "", sessionName: "", workspace: "" });
  void scan();
}
function selectBot(value: string) {
  if (!botCatalog.value || destinationMode.value !== "ds_bot") return;
  const agent = agents.value.find(item => item.id === selectedAgentId.value);
  if (!agent) return;
  try { const next = chooseDsBot(agent, botCatalog.value, value); if (next) emit("update:modelValue", next); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
function selectSession(value: string) {
  const session = sessions.value.find(item => item.id === value);
  if (!session || target.value.kind !== "session") return;
  const next = chooseDeliverySession(target.value, session);
  if (next) { roomSnapshot.value = isGroupSession(session) ? session : undefined; emit("update:modelValue", next); }
}
function resetIdentities() {
  identityGeneration++; identityLoading.value = false; identityError.value = "";
  identitySessions.value = []; identityOffset.value = undefined;
  roomSnapshot.value = undefined;
}
function selectDeliveryType(value: "private" | "group") {
  if (!selectedSession.value) return;
  clearTimeout(searchTimer); query.value = "";
  generation++; loading.value = false; searched.value = false; sessions.value = []; offset.value = undefined;
  resetIdentities();
  emit("update:modelValue", changeDeliveryType(selectedSession.value, value));
  void scan();
}
function selectSendMode(value: "direct" | "identity") {
  if (!selectedSession.value) return;
  emit("update:modelValue", changeSendMode(selectedSession.value, value));
  if (value === "identity") void loadIdentities();
}
function selectIdentity(value: string) {
  if (!selectedSession.value) return;
  const next = chooseSenderIdentity(selectedSession.value, identitySessions.value, selectedRoom.value, value);
  if (next) emit("update:modelValue", next);
}
async function loadIdentities(more = false) {
  const agent = agents.value.find(item => item.id === selectedAgentId.value);
  if (!agent || identityLoading.value) return;
  const requestGeneration = ++identityGeneration;
  identityLoading.value = true; identityError.value = "";
  try {
    const result = await postRouteAgentThreadAction({ action: "list", limit: 50, offset: more ? identityOffset.value ?? 0 : 0, query: "",
      ...(agent.provider === "grokBot" && selectedSession.value?.sessionId ? { threadId: selectedSession.value.sessionId } : {}) }, agent, { fetch: personaService.fetch, accessToken: () => "" });
    if (identityGeneration !== requestGeneration) return;
    identitySessions.value = [...new Map([...(more ? identitySessions.value : []), ...(result.threads ?? [])].map((item: Session) => [item.id, item])).values()] as Session[];
    identityOffset.value = result.nextOffset ?? undefined;
  } catch (cause) { if (identityGeneration === requestGeneration) identityError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (identityGeneration === requestGeneration) identityLoading.value = false; }
}
async function scan(more = false) {
  const agent = agents.value.find(item => item.id === selectedAgentId.value);
  if (!agent) { error.value = t("所选 Agent 已不在当前配置中，请检查连接或重新选择。"); return; }
  if (loading.value) return;
  const requestGeneration = ++generation;
  loading.value = true; error.value = "";
  try {
    if (destinationMode.value === "ds_bot") {
      const result = await postRouteAgentThreadAction({ action: "ds_bot_catalog", ...(!agent.binding && selectedDshOrigin.value ? { dshBaseUrl: selectedDshOrigin.value } : {}) }, agent, { fetch: personaService.fetch, accessToken: () => "" });
      if (generation !== requestGeneration) return;
      botCatalog.value = readDsBotCatalog(result.dsBot);
      if (!agent.binding) selectedDshOrigin.value = botCatalog.value.dshBaseUrl ?? "";
      searched.value = true; offset.value = undefined;
      return;
    }
    const result = await postRouteAgentThreadAction({ action: "list", limit: 50, offset: more ? offset.value ?? 0 : 0, query: query.value,
      ...(agent.provider === "grokBot" && selectedSession.value?.sessionId ? { threadId: selectedSession.value.sessionId } : {}) }, agent, { fetch: personaService.fetch, accessToken: () => "" });
    const found: Session[] = result.threads ?? [];
    const next: number | undefined = result.nextOffset ?? undefined;
    if (generation !== requestGeneration) return;
    searched.value = true;
    const room = found.find(item => item.id === selectedSession.value?.sessionId && isGroupSession(item));
    if (room) roomSnapshot.value = room;
    sessions.value = [...new Map([...(more ? sessions.value : []), ...found.filter(item => item.id)].map(item => [item.id, item])).values()];
    offset.value = next;
  } catch (cause) { if (generation === requestGeneration) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (generation === requestGeneration) loading.value = false; }
}
const selectedSession = computed<SessionTarget | undefined>(() => target.value.kind === "session" ? target.value : undefined);
const isGrok = computed(() => selectedSession.value?.agentAdapter === "grokBot");
const selectedRoom = computed(() => sessions.value.find(item => item.id === selectedSession.value?.sessionId && isGroupSession(item))
  ?? (roomSnapshot.value?.id === selectedSession.value?.sessionId ? roomSnapshot.value : undefined));
const identityItems = computed(() => senderIdentities(identitySessions.value, selectedRoom.value, selectedSession.value?.deliveryType === "group").map(item => ({ title: `${item.nativeAgentName || item.name || item.title || item.nativeAgentId} · ${item.nativeAgentId}`, value: item.nativeAgentId })));
const sessionItems = computed(() => {
  const selected = selectedSession.value;
  const items = selected ? deliverySessions(sessions.value, selected) : [];
  const missing = selected?.sessionId && !items.some(item => item.id === selected.sessionId);
  if (missing) items.unshift({ id: selected.sessionId, name: selected.sessionName, projectPath: selected.workspace });
  return items.map(item => ({ ...item, title: item.name || item.title || item.id, props: { disabled: Boolean(isGrok.value && missing && item.id === selected?.sessionId) } }));
});
const recipientHint = computed(() => {
  const selected = target.value;
  if (selected.kind !== "recipient") return "";
  const recipient = recipients.value.find(item => item.id === selected.recipientId);
  if (!recipient) return t("此接收者已删除，请重新选择。");
  const reason = choices.value.find(item => item.value === selected.recipientId)?.description;
  if (reason) return reason;
  return t(recipient.executor === "plan_secretary" ? "发送给这条消息关联计划的秘书。"
    : recipient.executor === "message_pool" ? "由消息处理池分配会话。"
    : recipient.executor === "memory_consolidation" ? "发送给已配置的记忆整理 Agent。"
    : "使用 Agent 设置中的主角色会话。修改绑定后，这条规则会自动跟随。");
});
function searchSessions(value: string) {
  query.value = value || "";
  clearTimeout(searchTimer);
  if (destinationMode.value === "ds_bot") return;
  if (!selectedAgentId.value || value === selectedSession.value?.sessionName) return;
  generation++; loading.value = false;
  searchTimer = setTimeout(() => { void scan(); }, 300);
}
function openSessions(open: boolean) {
  if (open && !searched.value && !loading.value) void scan();
}
</script>

<template>
  <section class="delivery-target" :aria-label="t('投递目标')">
    <v-select :model-value="target.kind === 'recipient' ? target.recipientId : '$session'" :items="choices"
      :label="t('投递目标')" density="compact" variant="outlined" hide-details @update:model-value="selectRecipient">
      <template #item="{ props: itemProps, item }">
        <v-list-item v-bind="itemProps" :subtitle="item.raw.description" />
      </template>
    </v-select>
    <p v-if="target.kind === 'recipient'" class="delivery-hint">{{ recipientHint }}</p>
    <div v-else class="delivery-custom">
      <p class="delivery-hint">{{ t('选择 Agent，再选择接收对象') }}</p>
      <div class="delivery-fields">
        <v-select :model-value="selectedAgentId" :items="agentItems" item-title="title" item-value="id"
          :label="t('Agent 端')" :placeholder="t('选择 Agent')" density="compact" variant="outlined" hide-details
          :no-data-text="t('暂无可用 Agent，请先在 Agent 设置中配置。')" @update:model-value="selectAgent" />
        <v-select v-if="isDsh" :model-value="destinationMode" :items="[{ title: t('DSH 会话'), value: 'session' }, { title: 'DSBot', value: 'ds_bot' }]"
          :label="t('接收对象')" density="compact" variant="outlined" hide-details @update:model-value="selectDestinationMode" />
        <v-select v-if="destinationMode === 'ds_bot' && localDshSelected && connectionItems.length" :model-value="selectedDshOrigin" :items="connectionItems"
          :label="t('DSH 连接')" density="compact" variant="outlined" hide-details @update:model-value="selectDshConnection" />
        <v-autocomplete v-if="destinationMode === 'ds_bot'" :disabled="!selectedAgentId" :model-value="botSelectionValue"
          :items="botItems" :label="t('指定 DSBot')" :loading="loading" :placeholder="t('输入名称或 ID 搜索')" density="compact" variant="outlined" hide-details no-filter
          @update:model-value="selectBot" @update:search="value => { query = value || ''; }" @update:menu="openSessions">
          <template #item="{ props: itemProps, item }"><v-list-item v-bind="itemProps"><template #subtitle><span class="delivery-session-id">{{ item.raw.botId }}</span></template></v-list-item></template>
          <template #no-data><div class="delivery-empty" role="status">{{ t(loading ? '正在加载 DSBot…' : error ? 'DSBot 暂时无法加载，请重试。' : '未找到 DSBot，请在所选 DSH 中检查 DSBot 插件。') }}</div></template>
        </v-autocomplete>
        <template v-if="selectedSession">
        <v-select v-if="isGrok" :model-value="selectedSession.deliveryType || 'private'"
          :items="[{ title: t('私聊'), value: 'private' }, { title: t('群'), value: 'group' }]"
          :label="t('会话类型')" density="compact" variant="outlined" hide-details @update:model-value="selectDeliveryType" />
        <v-autocomplete :disabled="!selectedAgentId" :model-value="selectedSession.sessionId || null"
          :items="sessionItems" item-title="title" item-value="id" :label="t(isGrok && selectedSession?.deliveryType === 'group' ? '目标群' : '指定会话')" :loading="loading"
          :placeholder="t('输入名称或 ID 搜索')" density="compact" variant="outlined" hide-details no-filter
          @update:model-value="selectSession" @update:search="searchSessions" @update:menu="openSessions">
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps" class="delivery-session-option">
              <template #subtitle><span class="delivery-session-id">{{ item.raw.id }}</span><span v-if="item.raw.projectPath || item.raw.cwd" class="delivery-session-path">{{ item.raw.projectPath || item.raw.cwd }}</span></template>
            </v-list-item>
          </template>
          <template #no-data>
            <div class="delivery-empty" role="status">{{ t(loading ? '正在加载会话…' : error ? '会话暂时无法加载，请重试。' : query ? '未找到匹配的会话，试试其他名称或 ID。' : '暂无会话，请先在该 Agent 中创建会话。') }}</div>
          </template>
          <template #append-item>
            <v-btn v-if="offset !== undefined" block variant="text" size="small" :loading="loading" @click.stop="scan(true)">{{ t('加载更多') }}</v-btn>
          </template>
        </v-autocomplete>
        <v-btn class="delivery-refresh" variant="text" size="small" icon="mdi-refresh" :aria-label="t('刷新会话')"
          :title="t('刷新会话')" :loading="loading" :disabled="!selectedAgentId" @click="scan()" />
        <v-select v-if="isGrok" :model-value="selectedSession.sendMode || 'direct'"
          :items="[{ title: t('直接发送'), value: 'direct' }, { title: t('指定身份'), value: 'identity' }]"
          :label="t('发送方式')" density="compact" variant="outlined" hide-details @update:model-value="selectSendMode" />
        <v-select v-if="isGrok && selectedSession?.sendMode === 'identity'"
          :model-value="selectedSession.senderAgentId || null" :items="identityItems" :disabled="selectedSession.deliveryType === 'group' && !selectedRoom" :loading="identityLoading"
          :label="t('发送身份')" :no-data-text="t('未找到群成员身份，请刷新或加载更多。')" density="compact" variant="outlined" hide-details
          @update:model-value="selectIdentity" @update:menu="open => { if (open && !identitySessions.length) void loadIdentities(); }">
          <template #append-item><v-btn v-if="identityOffset !== undefined" block variant="text" :loading="identityLoading" @click.stop="loadIdentities(true)">{{ t('加载更多') }}</v-btn></template>
        </v-select>
        </template>
        <v-btn v-if="destinationMode === 'ds_bot'" class="delivery-refresh" variant="text" size="small" icon="mdi-refresh" :aria-label="t('刷新 DSBot')" :title="t('刷新 DSBot')" :loading="loading" @click="scan()" />
      </div>
      <p v-if="missingBot" class="delivery-error" role="alert">{{ t('原 DSBot 在当前目录中不可用，原目标已保留，请检查连接或重新选择。') }}</p>
      <div v-if="providerError" class="delivery-error" role="alert"><span>{{ t('Agent 目录暂时无法加载。') }}</span><v-btn variant="text" @click="loadProviders()">{{ t('重试') }}</v-btn></div>
      <p v-if="isGrok && selectedSession?.deliveryType === 'group' && selectedSession.sendMode === 'identity' && !selectedSession.senderAgentId" class="delivery-error" role="alert">{{ t('群消息指定身份发送必须选择群成员身份。') }}</p>
      <div v-if="identityError" class="delivery-error" role="alert"><span>{{ t('身份暂时无法加载，请重试。') }}</span><v-btn variant="text" @click="loadIdentities()">{{ t('重试') }}</v-btn></div>
      <div v-if="error" class="delivery-error" role="alert">
        <span>{{ t(destinationMode === 'ds_bot' ? 'DSBot 暂时无法加载，请检查所选 DSH 的连接与插件。' : '会话暂时无法加载，请检查 Agent 连接后重试。') }}</span>
        <v-btn variant="text" size="small" :loading="loading" @click="scan()">{{ t('重试') }}</v-btn>
        <details><summary>{{ t('错误详情') }}</summary><div>{{ error }}</div></details>
      </div>
      <p v-else-if="!selectedAgentId" class="delivery-hint">{{ t('先选择 Agent，再选择接收消息的会话。') }}</p>
      <details v-if="selectedSession?.sessionId" class="delivery-details">
        <summary>{{ t('查看会话详情') }}</summary>
        <dl><dt>{{ t('会话 ID') }}</dt><dd>{{ selectedSession.sessionId }}</dd><dt v-if="selectedSession.workspace">{{ t('工作目录') }}</dt><dd v-if="selectedSession.workspace">{{ selectedSession.workspace }}</dd></dl>
      </details>
    </div>
  </section>
</template>

<style scoped>
.delivery-target { margin-top: 16px; }
.delivery-hint { margin: 8px 0 0; color: rgb(var(--v-theme-on-surface)); opacity: .7; font-size: 12px; line-height: 1.6; }
.delivery-custom { margin-top: 12px; padding: 12px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 8px; }
.delivery-custom > .delivery-hint:first-child { margin: 0 0 12px; }
.delivery-fields { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }
.delivery-fields > * { min-width: 0; }
.delivery-refresh { margin-top: 4px; }
.delivery-session-id, .delivery-session-path { display: block; overflow-wrap: anywhere; font-size: 12px; }
.delivery-session-id { font-family: monospace; }
.delivery-session-option :deep(.v-list-item-subtitle) { white-space: normal; -webkit-line-clamp: unset; }
.delivery-empty { padding: 12px 16px; font-size: 13px; line-height: 1.6; }
.delivery-details { margin-top: 10px; font-size: 12px; }
summary { cursor: pointer; color: rgb(var(--v-theme-secondary)); padding: 4px 0; }
summary:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 3px; }
.delivery-details dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 8px 0 0; }
.delivery-details dt { opacity: .7; }
.delivery-details dd { margin: 0; overflow-wrap: anywhere; }
.delivery-error { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; color: rgb(var(--v-theme-error)); font-size: 13px; }
.delivery-error details { flex-basis: 100%; overflow-wrap: anywhere; }
</style>
