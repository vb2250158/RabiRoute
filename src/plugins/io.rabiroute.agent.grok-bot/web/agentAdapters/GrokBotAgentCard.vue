<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { localAgentTargetKey } from "@shared/routeAgentTargets";
import { selectRouteAgent } from "../../../../../ribiwebgui/src/routeAgentTargetEditor";
import { grokBotPersonaPickerItems, selectGrokBotRoutePersona } from "../grokBotRouteConfig";
import type { AgentAdapterType, AgentScanResult } from "../../../../../ribiwebgui/src/types";
import type { AgentAdapterCardContext } from '../../../../../ribiwebgui/src/agentAdapters/agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const agentScan = computed(() => props.context.scanState);

const grokBotScan = { state: { get result() { return agentScan.value.agents.grokBot ?? null; }, get loading() { return props.context.scanState.loading; }, get error() { return props.context.scanError || ''; } } };

function touch(): void { props.context.touch(); }

async function runGrokBotAgentScan(): Promise<void> { await props.context.refreshScan(); }

const grokBotSelectionError = ref("");

function selectGrokBotPersona(value: unknown): void {
  if (!gateway.value || grokBotScan.state.loading) return;
  if (!selectGrokBotRoutePersona(gateway.value, grokBotScan.state.result, value)) {
    grokBotSelectionError.value = "未发现该 Bot 的默认主会话，请刷新后重新选择。";
    return;
  }
  if (value) selectRouteAgent(gateway.value, localAgentTargetKey("grokBot"));
  grokBotSelectionError.value = "";
  touch();
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined { return agentScan.value.agents[type]; }
</script>
<template>
  <div v-if="gateway">
<div class="section-note mb-3">先启动并登录 Grok Bot，登录状态会自动读取。</div><div class="status-row mb-3">
                    <span>登录资料目录</span>
                    <code class="text-break">{{ agentScanFor('grokBot')?.profilePath || '等待 Grok Bot 启动' }}</code>
                  </div><v-autocomplete
                    :model-value="gateway.grokBotAgentId || null"
                    :items="grokBotPersonaPickerItems(grokBotScan.state.result)"
                    item-title="title"
                    item-value="value"
                    :disabled="grokBotScan.state.loading || !agentScanFor('grokBot')?.auth?.loggedIn"
                    label="主角色 Bot"
                    hint="使用所选 Bot 的默认主会话。"
                    persistent-hint
                    clearable
                    @update:model-value="selectGrokBotPersona"
                  /><v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" class="mt-2"
                    :loading="grokBotScan.state.loading" @click="runGrokBotAgentScan">刷新 Grok Bot</v-btn><v-alert v-if="grokBotScan.state.error || grokBotSelectionError" type="error" variant="tonal" density="compact" class="mt-2">
                    {{ grokBotScan.state.error || grokBotSelectionError }}
                  </v-alert><v-alert v-else-if="grokBotScan.state.result?.auth?.loggedIn && !grokBotPersonaPickerItems(grokBotScan.state.result).length"
                    type="info" variant="tonal" density="compact" class="mt-2">当前账号没有可选 Bot，请先在 Grok Bot 中创建。</v-alert>
  </div>
</template>
