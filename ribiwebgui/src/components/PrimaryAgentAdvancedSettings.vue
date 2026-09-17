<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import type { AgentAdapterType, GatewayDefinition } from "../types";
const MessageProcessingBoard = defineAsyncComponent(() => import("./MessageProcessingBoard.vue"));
const boardOpen = ref(false);
import { agentAdapterSupportsManagedTaskFeature, DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL, DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT, MAX_MESSAGE_PROCESSING_AGENTS } from "@shared/gatewayConfigModel";
import { DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL } from "@shared/codexMemoryConsolidationAgent";
import { DEFAULT_CODEX_PLAN_ASSISTANT_MODEL } from "@shared/codexPlanAssistantSessions";
const props = defineProps<{ gateway: GatewayDefinition; provider: AgentAdapterType; targetTitle: string; busy?: boolean; error?: string; notice?: string }>();
const emit = defineEmits<{ change: [] }>();
function policy() { return props.gateway.messageProcessingAgents?.[props.provider]; }
function updatePolicy(patch: Record<string, unknown>) {
  props.gateway.messageProcessingAgents = { ...props.gateway.messageProcessingAgents, [props.provider]: { ...policy(), ...patch } };
  emit("change");
}
</script>
<template>
  <div class="dependency-panel mt-3">
    <div class="section-title small-title">主控 Agent 高级设置</div>
    <p class="section-note">以下设置用于当前路线的主控：{{ targetTitle }}。更换主控后沿用路线设置；远端不可用时不会改投本机。</p>
    <template v-if="agentAdapterSupportsManagedTaskFeature(provider, 'messageProcessingAgent')">
      <v-switch :model-value="policy()?.enabled === true" label="使用独立消息处理 Agent" @update:model-value="value => updatePolicy({ enabled: value === true })" />
      <div v-if="policy()?.enabled" class="catalog-param-grid">
        <v-text-field :model-value="policy()?.model || (provider === 'codex' ? DEFAULT_MESSAGE_PROCESSING_AGENT_MODEL : '')" label="消息处理模型" @update:model-value="value => updatePolicy({ model: String(value || '') })" />
        <v-select :model-value="policy()?.reasoningEffort || DEFAULT_MESSAGE_PROCESSING_AGENT_REASONING_EFFORT" :items="['low', 'medium', 'high', 'xhigh']" label="消息处理推理强度" @update:model-value="value => updatePolicy({ reasoningEffort: value })" />
        <v-text-field :model-value="policy()?.maxAgents" type="number" :min="1" :max="MAX_MESSAGE_PROCESSING_AGENTS" label="消息处理 Agent 数量上限" @update:model-value="value => updatePolicy({ maxAgents: Number(value) || undefined })" />
      </div>
      <v-btn v-if="policy()?.enabled" variant="tonal" @click="boardOpen = true">打开消息处理看板</v-btn>
      <v-dialog v-model="boardOpen" max-width="1200" scrollable>
        <v-card><v-card-title class="d-flex justify-space-between"><span>消息处理看板</span><v-btn icon="mdi-close" variant="text" title="关闭" @click="boardOpen = false" /></v-card-title><v-card-text><MessageProcessingBoard v-if="boardOpen" :gateway-id="gateway.id" :enabled="policy()?.enabled === true" /></v-card-text></v-card>
      </v-dialog>
    </template>
    <template v-if="agentAdapterSupportsManagedTaskFeature(provider, 'memoryConsolidationAgent')">
      <v-switch v-model="gateway.codexMemoryConsolidationAgentEnabled" label="使用独立记忆整理 Agent" @update:model-value="emit('change')" />
      <v-text-field v-if="gateway.codexMemoryConsolidationAgentEnabled && provider === 'codex'" :model-value="gateway.codexMemoryConsolidationAgentModel || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL" label="记忆整理模型" @update:model-value="value => { gateway.codexMemoryConsolidationAgentModel = String(value || DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL); emit('change'); }" />
    </template>
    <template v-if="agentAdapterSupportsManagedTaskFeature(provider, 'planAssistantSessions')">
      <v-switch v-model="gateway.codexPlanAssistantEnabled" label="使用计划秘书" @update:model-value="emit('change')" />
      <v-text-field v-if="gateway.codexPlanAssistantEnabled && provider === 'codex'" :model-value="gateway.codexPlanAssistantModel || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL" label="计划秘书模型" @update:model-value="value => { gateway.codexPlanAssistantModel = String(value || DEFAULT_CODEX_PLAN_ASSISTANT_MODEL); emit('change'); }" />
      <slot name="plan-actions" />
    </template>
    <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
    <v-alert v-else-if="notice" type="success" variant="tonal">{{ notice }}</v-alert>
  </div>
</template>
