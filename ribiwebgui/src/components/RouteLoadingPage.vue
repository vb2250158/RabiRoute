<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "../i18n/index";

const route = useRoute();
const { t } = useI18n();
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));
</script>

<template>
  <div class="page-shell route-skeleton" aria-busy="true" :aria-label="`${pageTitle} · ${t('页面已切换，正在加载内容')}`">
    <div class="route-skeleton-block" style="height: 44px; max-width: 420px" />
    <div class="route-skeleton-row">
      <div class="route-skeleton-block" style="height: 220px" />
      <div class="route-skeleton-block" style="height: 220px" />
    </div>
    <div class="route-skeleton-block" style="height: 140px" />
  </div>
</template>