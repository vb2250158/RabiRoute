<script setup lang="ts">
import { computed, onMounted } from "vue";
import { loadWorkbenchAgentCatalog, workbenchAgentCatalog, workbenchAgentLoading, workbenchCliProviders } from "./workbenchAgentCatalog";

const emit = defineEmits<{ close: [] }>();
const cliProviders = computed(() => workbenchCliProviders.value);
const cliLoading = workbenchAgentLoading;
const cliError = computed(() => workbenchAgentCatalog.value.error);
onMounted(() => { void loadWorkbenchAgentCatalog(); });
</script>

<template>
  <v-card>
    <v-card-title>Agent 设置</v-card-title>
    <v-card-text>
      <div v-if="cliLoading && !cliProviders.length" role="status">正在检测本机 Agent…</div>
      <v-alert v-if="cliError" type="error" variant="tonal">{{ cliError }}</v-alert>
      <div v-for="cli in cliProviders" :key="cli.id" class="cli-row">
        <div>
          <strong>{{ cli.label }}</strong>
          <small v-if="cli.ready">已安装<span v-if="cli.models.length"> · {{ cli.models.length }} 个可选模型</span></small>
          <small v-else>{{ cli.installed ? '已安装 · 启动检查失败' : '本机未检测到' }}</small>
        </div>
        <v-btn v-if="!cli.installed" :href="cli.installUrl" variant="tonal" target="_blank" rel="noopener noreferrer">官方安装</v-btn>
      </div>
    </v-card-text>
    <v-card-actions>
      <v-btn :loading="cliLoading" prepend-icon="mdi-refresh" @click="loadWorkbenchAgentCatalog(true)">重新检测</v-btn>
      <v-spacer/>
      <v-btn @click="emit('close')">关闭</v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.cli-row { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:14px 0; }
.cli-row + .cli-row { border-top:1px solid rgba(var(--v-border-color),var(--v-border-opacity)); }
.cli-row small { display:block; opacity:.72; margin-top:4px; }
</style>
