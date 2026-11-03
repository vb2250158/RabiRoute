<script setup lang="ts">
import type { MessageAdapterScanResult } from "../types";
import { copyTextToClipboard } from "../clipboard";
defineProps<{ scan?: MessageAdapterScanResult; error?: string; loading?: boolean; hideEndpoints?: boolean }>();
defineEmits<{ refresh: [] }>();
function openCandidate(candidate: { url?: string; path?: string }) {
  if (candidate.url) window.open(candidate.url, "_blank", "noopener,noreferrer");
  else if (candidate.path) void copyTextToClipboard(candidate.path);
}
const label = (value?: boolean) => value === true ? "已满足" : value === false ? "缺少" : "需人工确认";
const color = (value?: boolean) => value === true ? "success" : value === false ? "error" : "warning";
</script>
<template>
  <div class="dependency-panel mb-3">
    <div class="section-title-row compact-row">
      <div><div class="section-title small-title">环境和依赖</div><div class="section-note">检查外部工具、服务和回调入口。</div></div>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="$emit('refresh')">重新扫描</v-btn>
    </div>
    <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <template v-if="scan">
      <v-alert v-if="scan.health?.message" :type="scan.health.state === 'healthy' ? 'success' : 'warning'" variant="tonal" density="compact" class="mb-3">{{ scan.health.message }}</v-alert>
      <div v-if="scan.requirements?.length" class="dependency-list">
        <div v-for="requirement in scan.requirements" :key="requirement.id" class="dependency-row">
          <v-chip size="x-small" :color="color(requirement.ok)" variant="tonal">{{ label(requirement.ok) }}</v-chip>
          <div><strong>{{ requirement.label }}</strong><span>{{ requirement.detail || (requirement.required ? '这是必需项。' : '这是可选项。') }}</span></div>
          <v-btn v-if="requirement.url || requirement.path" size="small" variant="text" @click="openCandidate(requirement)">{{ requirement.actionLabel || (requirement.url ? '打开' : '复制路径') }}</v-btn>
        </div>
      </div>
      <div v-if="!hideEndpoints && scan.endpoints?.length" class="dependency-endpoints mt-2">
        <div v-for="endpoint in scan.endpoints" :key="`${endpoint.label}-${endpoint.url}`" class="status-row compact-status-row"><span>{{ endpoint.label }}</span><b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? '可用' : '未响应' }}</b></div>
      </div>
      <div v-if="scan.installCandidates?.length" class="dependency-actions mt-2"><v-btn v-for="candidate in scan.installCandidates" :key="candidate.label" size="small" variant="tonal" @click="openCandidate(candidate)">{{ candidate.label }}</v-btn></div>
      <v-alert v-for="warning in scan.warnings || []" :key="warning" type="warning" variant="tonal" density="compact" class="mt-2">{{ warning }}</v-alert>
    </template>
    <div v-else class="section-note">尚未扫描，可手动刷新检查。</div>
  </div>
</template>
