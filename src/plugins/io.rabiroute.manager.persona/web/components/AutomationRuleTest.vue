<script setup lang="ts">
import AutomationParameterHelp from "./AutomationParameterHelp.vue";
import { computed, ref, watch } from "vue";
import { notificationRuleMismatch, routeTextFromRawMessage } from "@shared/messageRuleMatch";
import { notificationRulesFromPersonaAutomations, type GatewayDefinition, type PersonaAutomationRuleDefinition } from "@shared/gatewayConfigModel";
import { resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { AGENT_HOOK_DESTINATIONS } from "@shared/agentHookAutomation";
import { agentSessionSendTiming, agentSessionSupportsSendTiming, normalizeAgentRecipients } from "@shared/agentDeliveryTarget";
import { pluginCatalogStore } from "../../../../../ribiwebgui/src/pluginCatalogStore";
import { configNameFor, routeKindDefinitionsForGateway, routeKindLabels } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";

const props = defineProps<{ routes: GatewayDefinition[]; rules: PersonaAutomationRuleDefinition[]; routeId?: string; endpoint: string }>();
const open = defineModel<boolean>({ default: false });
const routeId = ref("");
const kind = ref("");
const text = ref("");
const userId = ref("");
const groupId = ref("");
const speakerName = ref("");
const repliedText = ref("");
const selfId = ref("");
const replyId = ref("");
const result = ref<Array<{ id: string; name: string; mismatch?: string; agent?: string; destinations?: string[] }> | null>(null);

const route = computed(() => props.routes.find(item => item.id === routeId.value));
const scenes = computed(() => routeKindDefinitionsForGateway(route.value)
  .filter(item => item.adapter === props.endpoint)
  .flatMap(item => item.groups.flatMap(group => group.routeKinds.map(value => ({ value, title: routeKindLabels[value] || value })))));

watch(open, visible => {
  if (!visible) return;
  routeId.value = props.routeId || props.routes[0]?.id || "";
  kind.value = scenes.value[0]?.value || "";
  result.value = null;
}, { immediate: true });
watch([routeId, kind, text, userId, groupId, speakerName, repliedText, selfId, replyId, () => props.rules], () => { result.value = null; });

function testRules(): void {
  const source = route.value;
  if (!source || !kind.value || !text.value.trim()) return;
  const primary = resolvePrimaryAgentTarget(source);
  const adapterName = (id: string) => pluginCatalogStore.agentAdapters.value.find(item => item.type === id)?.title || id;
  const sample = {
    sourceRouteId: source.id,
    routeKind: kind.value,
    text: [text.value, repliedText.value].filter(Boolean).map(value => routeTextFromRawMessage(value)).join("\n"),
    groupId: groupId.value.trim() || undefined,
    userId: userId.value.trim() || undefined,
    speakerName: speakerName.value.trim() || undefined,
    variables: { ...source.routeVariables, SenderQQId: userId.value.trim(), GroupId: groupId.value.trim(),
      ReplyMessageId: replyId.value.trim(), ...(selfId.value.trim() ? { RobotQQId: selfId.value.trim() } : {}) }
  };
  result.value = notificationRulesFromPersonaAutomations(props.rules).map(rule => {
    const mismatch = notificationRuleMismatch(rule, sample);
    if (mismatch) return { id: rule.id, name: rule.name || rule.id, mismatch };
    const target = rule.agentTarget;
    const bound = target?.kind === "session" || target?.kind === "ds_bot" ? target : undefined;
    const recipient = target?.kind === "recipient" ? normalizeAgentRecipients(source.agentRecipients).find(item => item.id === target.recipientId) : undefined;
    const usesPrimary = !target || recipient?.executor === "primary";
    const provider = bound?.agentAdapter ?? (usesPrimary ? primary?.provider : undefined);
    const session = bound?.kind === "session" ? bound.sessionName || bound.sessionId
      : bound?.kind === "ds_bot" ? bound.botName : usesPrimary ? primary?.sessionName || primary?.sessionId : undefined;
    const agent = provider
      ? [adapterName(provider), session, bound?.agentTargetId || primary?.id,
        bound?.kind === "session" && agentSessionSupportsSendTiming(bound.agentAdapter) ? (agentSessionSendTiming(bound) === "queue" ? "排队发送" : "直接发送") : undefined].filter(Boolean).join(" · ")
      : recipient?.name || (target?.kind === "recipient" ? target.recipientId : "路线还未配置主控 Agent");
    const settings = provider && source.codexHooks?.byAgent?.[provider] || source.codexHooks;
    const destinations = provider ? (settings?.completionDeliveries ?? []).filter(item => item.enabled).map(rule => {
      const { channel, gatewayId, params } = rule.destination;
      const name = AGENT_HOOK_DESTINATIONS.find(item => item.value === channel)?.title ?? channel;
      const destinationRoute = props.routes.find(item => item.id === gatewayId);
      return [name, destinationRoute ? configNameFor(destinationRoute) : gatewayId,
        params.targetId || params.sessionId || params.chatId || params.sourceMessageId].filter(Boolean).join(" · ");
    }) : [];
    return { id: rule.id, name: rule.name || rule.id, agent, destinations };
  });
}
</script>

<template>
  <v-dialog v-model="open" max-width="670" scrollable>
    <v-card>
      <v-card-title>试算消息规则</v-card-title>
      <v-card-text>
        <v-select v-model="routeId" :items="routes" :item-title="configNameFor" item-value="id" label="来源路线" density="compact" >
          <template #append-inner><AutomationParameterHelp text="模拟此路线收到一条消息。限定了来源路线的规则会核对此选项。" /></template>
        </v-select>
        <v-select v-model="kind" :items="scenes" label="触发场景" density="compact" >
          <template #append-inner><AutomationParameterHelp text="选择消息在平台上发生的场景，如私聊、群聊或被提及。" /></template>
        </v-select>
        <v-textarea v-model="text" label="示例消息" rows="2" auto-grow >
          <template #append-inner><AutomationParameterHelp text="使用输入内容计算规则结果。试算不发送消息。" /></template>
        </v-textarea>
        <details>
          <summary>会话信息</summary>
          <div class="mt-3">
            <v-text-field v-model="groupId" label="群聊或频道 ID" density="compact" >
              <template #append-inner><AutomationParameterHelp text="用于匹配限定群聊或频道的规则。" /></template>
            </v-text-field>
            <v-text-field v-model="userId" label="发送者 ID" density="compact" >
              <template #append-inner><AutomationParameterHelp text="填写平台记录的发送者 ID，用于匹配私聊对象。" /></template>
            </v-text-field>
            <v-text-field v-if="kind === 'voice_transcript'" v-model="speakerName" label="说话人" density="compact" >
              <template #append-inner><AutomationParameterHelp text="填写语音消息识别到的说话人名称。" /></template>
            </v-text-field>
            <v-text-field v-model="selfId" label="机器人账号 ID" density="compact" >
              <template #append-inner><AutomationParameterHelp text="用于匹配规则中引用的 RobotQQId。" /></template>
            </v-text-field>
            <v-text-field v-model="replyId" label="引用消息 ID" density="compact" >
              <template #append-inner><AutomationParameterHelp text="用于匹配规则中引用的 ReplyMessageId。" /></template>
            </v-text-field>
            <v-textarea v-model="repliedText" label="引用消息内容" rows="2" >
              <template #append-inner><AutomationParameterHelp text="正式匹配可以同时读取正文和它引用的那条消息。" /></template>
            </v-textarea>
          </div>
        </details>
        <section v-if="result" class="mt-4" aria-live="polite">
          <p class="mb-2">命中 {{ result.filter(item => !item.mismatch).length }} 条</p>
          <v-list density="compact">
            <v-list-item v-for="item in result" :key="item.id" :title="item.name"
              :subtitle="item.mismatch || item.agent" :prepend-icon="item.mismatch ? 'mdi-minus-circle-outline' : 'mdi-check-circle-outline'">
              <div v-if="!item.mismatch && item.destinations?.length" class="text-caption mt-1">
                <div v-for="(destination, index) in item.destinations" :key="index">完成通知候选 · {{ destination }}</div>
              </div>
            </v-list-item>
          </v-list>
        </section>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">关闭</v-btn>
        <v-btn color="primary" variant="tonal" :disabled="!routeId || !kind || !text.trim()" @click="testRules">试算</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
