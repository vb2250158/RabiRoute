<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { pluginCatalogStore } from "../../../../../ribiwebgui/src/pluginCatalogStore";
import { webRenderersAt } from "../../../../../ribiwebgui/src/pluginRenderers";
import TrustedWebRendererHost from "../../../../../ribiwebgui/src/components/TrustedWebRendererHost.vue";
import AgentCallHistoryTab from "../components/AgentCallHistoryTab.vue";

const store = useGatewayStore();
const activeTab = ref("runtime");
const performanceRenderers = computed(() => webRenderersAt(pluginCatalogStore.statusRenderers.value, "diagnostics.performance"));
const performanceContext = { embedded: true };
const gateway = computed(() => store.selectedGateway);
const logSource = computed(() => gateway.value ? store.configNameFor(gateway.value) : "");
const logs = computed(() => (store.selectedRuntime.log || []).slice(-30).join("\n"));
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <h1 class="page-title">日志诊断</h1>
    </div>
    <v-tabs v-model="activeTab" class="mb-4" color="primary">
      <v-tab value="runtime">运行日志</v-tab>
      <v-tab value="calls">调用记录</v-tab>
      <v-tab v-if="performanceRenderers.length" value="performance">性能监控</v-tab>
    </v-tabs>
    <v-card v-if="activeTab === 'runtime'" class="app-card section-card">
      <div class="section-title-row">
        <div>
          <div class="section-title">最近日志</div>
          <div v-if="logSource" class="section-note" data-no-i18n>{{ logSource }}</div>
        </div>
        <v-btn prepend-icon="mdi-refresh" variant="tonal" :loading="store.diagnosticsLoading" @click="store.ensureDiagnostics(true)">刷新</v-btn>
      </div>
      <pre v-if="logs" class="mono-box" data-no-i18n>{{ logs }}</pre>
      <div v-else class="empty-state">暂无日志</div>
    </v-card>
    <AgentCallHistoryTab v-else-if="activeTab === 'calls'" />
    <KeepAlive>
      <TrustedWebRendererHost v-if="activeTab === 'performance'" :renderers="performanceRenderers" :context="performanceContext" />
    </KeepAlive>
  </div>
</template>
