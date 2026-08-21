<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { isWebPageRouteActive } from "../pluginPages";

const route = useRoute();
const router = useRouter();
const refreshing = ref(false);
const requestedPath = computed(() => {
  const value = typeof route.query.from === "string" ? route.query.from : "";
  return value.startsWith("/") && !value.startsWith("/plugin-recovery") ? value : "/";
});

async function retry(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await pluginCatalogStore.refresh();
    const target = router.resolve(requestedPath.value);
    const routeId = typeof target.meta.pluginRouteId === "string" ? target.meta.pluginRouteId : "";
    if (routeId && isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) {
      await router.replace(target.fullPath);
    }
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="page-shell">
    <v-card class="app-card glass-card section-card plugin-recovery-card">
      <div class="eyebrow">PLUGIN CATALOG</div>
      <h1 class="page-title">插件页面暂不可用</h1>
      <p class="page-subtitle">WebGUI 没有读取到可用的插件目录，只保留此恢复入口。</p>
      <v-btn color="primary" prepend-icon="mdi-refresh" :loading="refreshing" @click="retry">
        重新读取插件目录
      </v-btn>
    </v-card>
  </div>
</template>

<style scoped>
.plugin-recovery-card {
  max-width: 720px;
  margin: 48px auto;
}
</style>
