<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "../i18n";
import { retryRouteLoad } from "../routeLoadRetry";

const route = useRoute();
const { t } = useI18n();
const retrying = ref(false);
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));

function retry(): void {
  if (retrying.value) return;
  retrying.value = true;
  retryRouteLoad();
}
</script>

<template>
  <div class="page-shell">
    <v-card class="app-card glass-card section-card route-load-error-card" variant="flat">
      <div class="section-note mb-2">{{ pageTitle }}</div>
      <h1 class="page-title">{{ t("页面加载失败") }}</h1>
      <p class="page-subtitle">{{ t("页面内容未能及时加载。请重试当前页面。") }}</p>
      <v-btn color="primary" prepend-icon="mdi-refresh" :loading="retrying" @click="retry">
        {{ t("重试当前页面") }}
      </v-btn>
    </v-card>
  </div>
</template>

<style scoped>
.route-load-error-card {
  max-width: 720px;
  margin: 48px auto;
}
</style>
