<script setup lang="ts">
import { onErrorCaptured, ref, watch } from "vue";
import type { WebRendererContribution } from "../pluginRenderers";
import type { AgentAdapterCardContext } from "./agentAdapterCardContext";
import { userFacingError } from "../userFacingError";

const props = defineProps<{ renderer?: WebRendererContribution; context: AgentAdapterCardContext }>();
const error = ref("");
watch([() => props.renderer?.component, () => props.context.routeId, () => props.context.targetId], () => { error.value = ""; });
onErrorCaptured(cause => { error.value = userFacingError(cause); return false; });
</script>
<template>
  <v-alert v-if="!renderer" type="warning" variant="tonal" density="compact">
    此 Agent 插件暂不可用，原配置和主控选择已保留。请在插件页检查启用状态与加载结果。
  </v-alert>
  <v-alert v-else-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
  <component v-else :is="renderer.component" :key="`${renderer.key}:${context.routeId}:${context.targetId}`" :context="context" />
  <v-btn v-if="renderer && !error && context.scanState.agents[context.agentType]?.sessionPage?.hasMore"
    size="small" variant="text" prepend-icon="mdi-chevron-down" :loading="context.scanState.loading"
    @click="context.loadMoreSessions()">加载更多会话</v-btn>
</template>
